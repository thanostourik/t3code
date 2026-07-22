/**
 * RoamingPeers - Persisted registry of enrolled peer machines.
 *
 * A peer row records how to reach a machine (base URLs, tried in order —
 * the server has no LAN/Tailscale endpoint discovery of its own, see plan
 * doc M1 analysis) and when we last completed a mirror pass with it. The
 * bearer credential for a peer lives in ServerSecretStore under
 * `roaming-peer-<environmentId>`, not in this table.
 */
import { EnvironmentId, RoamingPeer } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

export type RoamingPeersError = PersistenceSqlError | PersistenceDecodeError;

export const roamingPeerSecretName = (environmentId: EnvironmentId): string =>
  `roaming-peer-${environmentId}`;

export class RoamingPeers extends Context.Service<
  RoamingPeers,
  {
    readonly upsert: (peer: RoamingPeer) => Effect.Effect<void, RoamingPeersError>;
    /** Record a peer's existence without touching an existing row. */
    readonly ensurePeer: (
      environmentId: EnvironmentId,
      enrolledAt: string,
    ) => Effect.Effect<void, RoamingPeersError>;
    /** Unpair: drop the row; returns whether one existed. */
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<boolean, RoamingPeersError>;
    /** Pause/resume sync without touching the credential; null if no row. */
    readonly setSyncEnabled: (
      environmentId: EnvironmentId,
      syncEnabled: boolean,
    ) => Effect.Effect<boolean, RoamingPeersError>;
    readonly list: () => Effect.Effect<ReadonlyArray<RoamingPeer>, RoamingPeersError>;
    readonly recordContact: (
      environmentId: EnvironmentId,
      contactAt: string,
    ) => Effect.Effect<void, RoamingPeersError>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    /**
     * The subsystem's master gate (D3): roaming is on iff at least one peer
     * exists — auto-on at first pairing, auto-off when the last peer goes.
     * In-memory (seeded from the table, refreshed on every peer mutation) so
     * hot paths pay no DB read. Consent sites AND their consent flag on top.
     */
    readonly roamingEnabled: Effect.Effect<boolean>;
  }
>()("t3/roaming/RoamingPeers") {}

const BaseUrlsFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodePeers = Schema.decodeUnknownEffect(Schema.Array(RoamingPeer));
const encodeBaseUrls = Schema.encodeEffect(BaseUrlsFromJson);
const decodeBaseUrls = Schema.decodeUnknownEffect(BaseUrlsFromJson);

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<void>();

  const countPeers = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM roaming_peers
  `.pipe(
    Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
    Effect.mapError(sqlError("roaming.peers.count")),
  );
  // Migrations run inside the SQLite layer, so the table exists here.
  const hasPeers = yield* Ref.make(yield* countPeers.pipe(Effect.orDie));
  const refreshHasPeers = countPeers.pipe(Effect.flatMap((value) => Ref.set(hasPeers, value)));

  const upsert: RoamingPeers["Service"]["upsert"] = Effect.fn("RoamingPeers.upsert")(
    function* (peer) {
      const baseUrlsJson = yield* encodeBaseUrls(peer.baseUrls).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("roaming.peers.upsert", cause),
        ),
      );
      yield* sql`
      INSERT INTO roaming_peers (environment_id, base_urls, last_contact_at, enrolled_at, sync_enabled)
      VALUES (${peer.environmentId}, ${baseUrlsJson}, ${peer.lastContactAt}, ${peer.enrolledAt}, ${peer.syncEnabled ? 1 : 0})
      ON CONFLICT (environment_id) DO UPDATE SET
        base_urls = excluded.base_urls,
        last_contact_at = COALESCE(excluded.last_contact_at, roaming_peers.last_contact_at),
        sync_enabled = excluded.sync_enabled
    `.pipe(Effect.mapError(sqlError("roaming.peers.upsert")));
      yield* refreshHasPeers;
      yield* PubSub.publish(changes, undefined);
    },
  );

  const ensurePeer: RoamingPeers["Service"]["ensurePeer"] = Effect.fn("RoamingPeers.ensurePeer")(
    function* (environmentId, enrolledAt) {
      // Insert-only: a caller identifying itself must never overwrite the
      // base URLs (or anything else) of a peer we already enrolled — that
      // would let it redirect our outbound mirror traffic.
      yield* sql`
        INSERT INTO roaming_peers (environment_id, base_urls, last_contact_at, enrolled_at)
        VALUES (${environmentId}, ${"[]"}, ${null}, ${enrolledAt})
        ON CONFLICT (environment_id) DO NOTHING
      `.pipe(Effect.mapError(sqlError("roaming.peers.ensure")));
      yield* refreshHasPeers;
      yield* PubSub.publish(changes, undefined);
    },
  );

  const remove: RoamingPeers["Service"]["remove"] = Effect.fn("RoamingPeers.remove")(
    function* (environmentId) {
      const rows = yield* sql<{ readonly environmentId: string }>`
        DELETE FROM roaming_peers
        WHERE environment_id = ${environmentId}
        RETURNING environment_id AS "environmentId"
      `.pipe(Effect.mapError(sqlError("roaming.peers.remove")));
      yield* refreshHasPeers;
      yield* PubSub.publish(changes, undefined);
      return rows.length > 0;
    },
  );

  const setSyncEnabled: RoamingPeers["Service"]["setSyncEnabled"] = Effect.fn(
    "RoamingPeers.setSyncEnabled",
  )(function* (environmentId, syncEnabled) {
    const rows = yield* sql<{ readonly environmentId: string }>`
      UPDATE roaming_peers
      SET sync_enabled = ${syncEnabled ? 1 : 0}
      WHERE environment_id = ${environmentId}
      RETURNING environment_id AS "environmentId"
    `.pipe(Effect.mapError(sqlError("roaming.peers.setSyncEnabled")));
    yield* PubSub.publish(changes, undefined);
    return rows.length > 0;
  });

  const list: RoamingPeers["Service"]["list"] = Effect.fn("RoamingPeers.list")(function* () {
    const rows = yield* sql<{
      readonly environmentId: string;
      readonly baseUrls: string;
      readonly lastContactAt: string | null;
      readonly enrolledAt: string;
      readonly syncEnabled: number;
    }>`
      SELECT
        environment_id AS "environmentId",
        base_urls AS "baseUrls",
        last_contact_at AS "lastContactAt",
        enrolled_at AS "enrolledAt",
        sync_enabled AS "syncEnabled"
      FROM roaming_peers
      ORDER BY enrolled_at, environment_id
    `.pipe(Effect.mapError(sqlError("roaming.peers.list")));

    const peers: Array<unknown> = [];
    for (const row of rows) {
      peers.push({
        environmentId: row.environmentId,
        syncEnabled: row.syncEnabled !== 0,
        baseUrls: yield* decodeBaseUrls(row.baseUrls).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError("roaming.peers.list", cause),
          ),
        ),
        lastContactAt: row.lastContactAt,
        enrolledAt: row.enrolledAt,
      });
    }
    return yield* decodePeers(peers).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("roaming.peers.list", cause),
      ),
    );
  });

  const recordContact: RoamingPeers["Service"]["recordContact"] = Effect.fn(
    "RoamingPeers.recordContact",
  )(function* (environmentId, contactAt) {
    yield* sql`
      UPDATE roaming_peers
      SET last_contact_at = ${contactAt}
      WHERE environment_id = ${environmentId}
    `.pipe(Effect.mapError(sqlError("roaming.peers.record-contact")));
  });

  return {
    upsert,
    ensurePeer,
    remove,
    setSyncEnabled,
    list,
    recordContact,
    subscribeChanges: PubSub.subscribe(changes),
    roamingEnabled: Ref.get(hasPeers),
  } satisfies RoamingPeers["Service"];
});

export const layer = Layer.effect(RoamingPeers, make);

/**
 * In-memory stub for tests that only need the derived gate (D3) and inert
 * peer plumbing — no persistence, mutations are no-ops.
 */
export const layerTest = (options?: { readonly hasPeers?: boolean }) =>
  Layer.effect(
    RoamingPeers,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      return {
        upsert: () => Effect.void,
        ensurePeer: () => Effect.void,
        remove: () => Effect.succeed(false),
        setSyncEnabled: () => Effect.succeed(false),
        list: () => Effect.succeed([]),
        recordContact: () => Effect.void,
        subscribeChanges: PubSub.subscribe(changes),
        roamingEnabled: Effect.succeed(options?.hasPeers ?? false),
      } satisfies RoamingPeers["Service"];
    }),
  );
