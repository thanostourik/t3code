/**
 * RoamingAttachRegistrations - Server-owned client registrations (M5.6).
 *
 * The reverse half of the unified handshake: a paired initiator posts how
 * this machine's clients can attach back to it (label, candidate base
 * URLs, standard-scoped bearer). Metadata lives in the
 * `roaming_attach_registrations` table; the bearer token lives in
 * ServerSecretStore under `roaming-attach-<environmentId>` — same split as
 * RoamingPeers and its mirror credential. Clients reconcile these records
 * into their environment catalog beside the browser catalog and the
 * desktop platform source.
 */
import { EnvironmentId, RoamingAttachRegistration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

export type RoamingAttachRegistrationsError = PersistenceSqlError | PersistenceDecodeError;

export const roamingAttachSecretName = (environmentId: EnvironmentId): string =>
  `roaming-attach-${environmentId}`;

export class RoamingAttachRegistrations extends Context.Service<
  RoamingAttachRegistrations,
  {
    /** Record (or refresh) a registration; the token goes to the secret store. */
    readonly upsert: (
      registration: RoamingAttachRegistration,
    ) => Effect.Effect<void, RoamingAttachRegistrationsError>;
    /** Drop a registration and its stored token; returns whether one existed. */
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean, RoamingAttachRegistrationsError>;
    /**
     * All registrations with their tokens re-joined from the secret store.
     * A row whose secret is missing is skipped with a warning (fail-closed:
     * never hand out a registration that cannot authenticate).
     */
    readonly list: () => Effect.Effect<
      ReadonlyArray<RoamingAttachRegistration>,
      RoamingAttachRegistrationsError
    >;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/roaming/RoamingAttachRegistrations") {}

const BaseUrlsFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeBaseUrls = Schema.encodeEffect(BaseUrlsFromJson);
const decodeBaseUrls = Schema.decodeUnknownEffect(BaseUrlsFromJson);
const decodeRegistration = Schema.decodeUnknownEffect(RoamingAttachRegistration);

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore;
  const changes = yield* PubSub.unbounded<void>();

  const upsert: RoamingAttachRegistrations["Service"]["upsert"] = Effect.fn(
    "RoamingAttachRegistrations.upsert",
  )(function* (registration) {
    const baseUrlsJson = yield* encodeBaseUrls(registration.baseUrls).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("roaming.attach-registrations.upsert", cause),
      ),
    );
    // Token first: a crash between the two writes must leave a usable
    // secret for an existing row, never a row without its secret.
    yield* secretStore
      .set(
        roamingAttachSecretName(registration.environmentId),
        new TextEncoder().encode(registration.token),
      )
      .pipe(Effect.mapError(sqlError("roaming.attach-registrations.secret")));
    const registeredAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO roaming_attach_registrations (environment_id, label, base_urls, expires_at, registered_at)
      VALUES (${registration.environmentId}, ${registration.label}, ${baseUrlsJson}, ${registration.expiresAt}, ${registeredAt})
      ON CONFLICT (environment_id) DO UPDATE SET
        label = excluded.label,
        base_urls = excluded.base_urls,
        expires_at = excluded.expires_at,
        registered_at = excluded.registered_at
    `.pipe(Effect.mapError(sqlError("roaming.attach-registrations.upsert")));
    yield* PubSub.publish(changes, undefined);
  });

  const remove: RoamingAttachRegistrations["Service"]["remove"] = Effect.fn(
    "RoamingAttachRegistrations.remove",
  )(function* (environmentId) {
    const rows = yield* sql<{ readonly environmentId: string }>`
      DELETE FROM roaming_attach_registrations
      WHERE environment_id = ${environmentId}
      RETURNING environment_id AS "environmentId"
    `.pipe(Effect.mapError(sqlError("roaming.attach-registrations.remove")));
    yield* secretStore.remove(roamingAttachSecretName(environmentId)).pipe(Effect.ignore);
    if (rows.length > 0) {
      yield* PubSub.publish(changes, undefined);
    }
    return rows.length > 0;
  });

  const list: RoamingAttachRegistrations["Service"]["list"] = Effect.fn(
    "RoamingAttachRegistrations.list",
  )(function* () {
    const rows = yield* sql<{
      readonly environmentId: string;
      readonly label: string;
      readonly baseUrls: string;
      readonly expiresAt: string | null;
    }>`
      SELECT
        environment_id AS "environmentId",
        label,
        base_urls AS "baseUrls",
        expires_at AS "expiresAt"
      FROM roaming_attach_registrations
      ORDER BY registered_at, environment_id
    `.pipe(Effect.mapError(sqlError("roaming.attach-registrations.list")));

    const registrations: Array<RoamingAttachRegistration> = [];
    for (const row of rows) {
      const secret = yield* secretStore
        .get(roamingAttachSecretName(row.environmentId as EnvironmentId))
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isNone(secret)) {
        yield* Effect.logWarning("roaming: attach registration has no stored token; skipping", {
          environmentId: row.environmentId,
        });
        continue;
      }
      registrations.push(
        yield* decodeRegistration({
          environmentId: row.environmentId,
          label: row.label,
          baseUrls: yield* decodeBaseUrls(row.baseUrls).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError("roaming.attach-registrations.list", cause),
            ),
          ),
          token: new TextDecoder().decode(secret.value),
          expiresAt: row.expiresAt,
        }).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError("roaming.attach-registrations.list", cause),
          ),
        ),
      );
    }
    return registrations;
  });

  return {
    upsert,
    remove,
    list,
    subscribeChanges: PubSub.subscribe(changes),
  } satisfies RoamingAttachRegistrations["Service"];
});

export const layer = Layer.effect(RoamingAttachRegistrations, make);
