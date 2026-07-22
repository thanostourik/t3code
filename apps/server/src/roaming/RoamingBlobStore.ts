/**
 * RoamingBlobStore - Local storage and reconciliation for roaming blobs.
 *
 * One record shape for every roaming kind (decision D3); rows live in the
 * server's SQLite and reconcile with peers through the mirror. The store owns
 * the reconciliation rule; transport lives elsewhere (PeerMirror).
 *
 * Reconciliation per (kind, key): higher version wins; equal versions with
 * different content hashes are concurrent writes — auto-resolved
 * newest-updatedAt-wins (D1, 2026-07-22), the loser preserved in the
 * conflict record and surfaced as a notice. Payload strings are
 * byte-authoritative — stored and hashed verbatim, never re-serialized.
 */
import * as NodeCrypto from "node:crypto";

import {
  RoamingBlobConflict,
  RoamingBlobKind,
  RoamingBlobManifestEntry,
  RoamingBlobRecord,
  type RoamingBlobRef,
  type RoamingPushBlobOutcome,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export type RoamingBlobStoreError = PersistenceSqlError | PersistenceDecodeError;

export class RoamingBlobStore extends Context.Service<
  RoamingBlobStore,
  {
    /**
     * Author a new version of a blob on this machine: bumps the version,
     * hashes the payload, stamps this environment id, and publishes the
     * record to `changes`.
     */
    readonly writeLocal: (input: {
      readonly kind: RoamingBlobKind;
      readonly key: string;
      readonly workspaceProjectId: WorkspaceProjectId;
      readonly payload: string;
    }) => Effect.Effect<RoamingBlobRecord, RoamingBlobStoreError>;
    /**
     * Apply a record received from a peer under the reconciliation rule.
     * Returns the outcome the mirror reports back; `applied` with an actual
     * write publishes to `changes`.
     */
    readonly applyRemote: (
      record: RoamingBlobRecord,
    ) => Effect.Effect<RoamingPushBlobOutcome, RoamingBlobStoreError>;
    readonly get: (
      ref: RoamingBlobRef,
    ) => Effect.Effect<RoamingBlobRecord | null, RoamingBlobStoreError>;
    readonly getMany: (
      refs: ReadonlyArray<RoamingBlobRef>,
    ) => Effect.Effect<ReadonlyArray<RoamingBlobRecord>, RoamingBlobStoreError>;
    readonly manifest: () => Effect.Effect<
      ReadonlyArray<RoamingBlobManifestEntry>,
      RoamingBlobStoreError
    >;
    readonly listConflicts: () => Effect.Effect<
      ReadonlyArray<RoamingBlobConflict>,
      RoamingBlobStoreError
    >;
    /**
     * Subscribe to accepted writes (local or remote). The subscription is
     * established when this effect returns, so no write after that point is
     * missed. Writes made while nobody is subscribed are dropped — that is
     * fine for the mirror, which also syncs on startup and on interval; the
     * trigger is an optimization, not the delivery guarantee.
     */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<RoamingBlobRecord>,
      never,
      Scope.Scope
    >;
    /**
     * Monotonic per-boot counter, bumped on every published change. Only
     * ever compared for inequality (the mirror wait route, M3.7) — resets
     * on restart, which at worst wakes a waiting peer into one no-op pass.
     */
    readonly changeRevision: Effect.Effect<number>;
  }
>()("t3/roaming/RoamingBlobStore") {}

const BlobRowSchema = Schema.Struct({
  kind: RoamingBlobKind,
  key: Schema.String,
  workspaceProjectId: Schema.String,
  version: Schema.Int,
  contentHash: Schema.String,
  authorEnvironmentId: Schema.String,
  updatedAt: Schema.String,
  schemaVersion: Schema.Int,
  payload: Schema.String,
});

const decodeRecord = Schema.decodeUnknownEffect(RoamingBlobRecord);
const decodeManifestEntries = Schema.decodeUnknownEffect(Schema.Array(RoamingBlobManifestEntry));
const decodeConflict = Schema.decodeUnknownEffect(RoamingBlobConflict);
const RemoteRecordFromJson = Schema.fromJsonString(RoamingBlobRecord);
const decodeConflictRemote = Schema.decodeUnknownEffect(RemoteRecordFromJson);
const encodeRemoteRecordJson = Schema.encodeEffect(RemoteRecordFromJson);

const contentHashOf = (payload: string): string =>
  NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex");

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const changesPubSub = yield* PubSub.unbounded<RoamingBlobRecord>();
  const revisionRef = yield* Ref.make(0);
  const publishChange = (record: RoamingBlobRecord) =>
    Ref.update(revisionRef, (revision) => revision + 1).pipe(
      Effect.andThen(PubSub.publish(changesPubSub, record)),
    );
  // Serializes every read-modify-write. Statements on the shared SQLite
  // connection are async Effects, so without this two fibers can both read a
  // row before either writes — losing updates and defeating equal-version
  // conflict detection.
  const writeSemaphore = yield* Semaphore.make(1);

  const selectRow = (ref: RoamingBlobRef, operation = "roaming.blob.get") =>
    sql<typeof BlobRowSchema.Type>`
      SELECT
        kind,
        key,
        workspace_project_id AS "workspaceProjectId",
        version,
        content_hash AS "contentHash",
        author_environment_id AS "authorEnvironmentId",
        updated_at AS "updatedAt",
        schema_version AS "schemaVersion",
        payload
      FROM roaming_blobs
      WHERE kind = ${ref.kind} AND key = ${ref.key}
    `.pipe(Effect.mapError(sqlError(operation)));

  // An accepted write supersedes any recorded conflict for the key — the
  // local state has moved past the version the conflict was about.
  const clearConflict = (ref: RoamingBlobRef, operation: string) =>
    sql`
      DELETE FROM roaming_blob_conflicts
      WHERE kind = ${ref.kind} AND key = ${ref.key}
    `.pipe(Effect.mapError(sqlError(operation)));

  const upsertRow = (record: RoamingBlobRecord, operation: string) =>
    sql`
      INSERT INTO roaming_blobs (
        kind, key, workspace_project_id, version, content_hash,
        author_environment_id, updated_at, schema_version, payload
      ) VALUES (
        ${record.kind}, ${record.key}, ${record.workspaceProjectId},
        ${record.version}, ${record.contentHash}, ${record.authorEnvironmentId},
        ${record.updatedAt}, ${record.schemaVersion}, ${record.payload}
      )
      ON CONFLICT (kind, key) DO UPDATE SET
        workspace_project_id = excluded.workspace_project_id,
        version = excluded.version,
        content_hash = excluded.content_hash,
        author_environment_id = excluded.author_environment_id,
        updated_at = excluded.updated_at,
        schema_version = excluded.schema_version,
        payload = excluded.payload
    `.pipe(Effect.mapError(sqlError(operation)));

  const get: RoamingBlobStore["Service"]["get"] = Effect.fn("RoamingBlobStore.get")(
    function* (ref) {
      const rows = yield* selectRow(ref);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return yield* decodeRecord(row).pipe(Effect.mapError(decodeError("roaming.blob.get")));
    },
  );

  const writeLocal: RoamingBlobStore["Service"]["writeLocal"] = Effect.fn(
    "RoamingBlobStore.writeLocal",
  )((input) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        const existing = yield* selectRow(
          { kind: input.kind, key: input.key },
          "roaming.blob.write-local",
        );
        const record = yield* decodeRecord({
          schemaVersion: 1,
          kind: input.kind,
          key: input.key,
          workspaceProjectId: input.workspaceProjectId,
          version: (existing[0]?.version ?? 0) + 1,
          contentHash: contentHashOf(input.payload),
          authorEnvironmentId: environmentId,
          updatedAt: yield* nowIso,
          payload: input.payload,
        }).pipe(Effect.mapError(decodeError("roaming.blob.write-local")));
        yield* upsertRow(record, "roaming.blob.write-local");
        yield* clearConflict(record, "roaming.blob.write-local");
        yield* publishChange(record);
        return record;
      }),
    ),
  );

  // After auto-resolution (D1) the store always holds the winner, so the
  // record reads: local_content_hash = winner's hash, remote_record = the
  // full losing concurrent write (preserved for inspection). Idempotent: an
  // identical re-detection (same version, same loser) does not churn
  // detected_at — mirror passes repeat until the peer converges.
  const recordConflict = (
    winner: {
      readonly kind: string;
      readonly key: string;
      readonly workspaceProjectId: string;
      readonly version: number;
      readonly contentHash: string;
    },
    loser: RoamingBlobRecord,
  ) =>
    Effect.gen(function* () {
      const loserJson = yield* encodeRemoteRecordJson(loser).pipe(
        Effect.mapError(decodeError("roaming.blob.record-conflict")),
      );
      const already = yield* sql<{ readonly version: number; readonly remoteRecord: string }>`
        SELECT version, remote_record AS "remoteRecord"
        FROM roaming_blob_conflicts
        WHERE kind = ${winner.kind} AND key = ${winner.key}
      `.pipe(Effect.mapError(sqlError("roaming.blob.record-conflict")));
      if (already[0]?.version === winner.version && already[0].remoteRecord === loserJson) {
        return;
      }
      const detectedAt = yield* nowIso;
      yield* sql`
        INSERT INTO roaming_blob_conflicts (
          kind, key, workspace_project_id, version,
          local_content_hash, remote_record, detected_at
        ) VALUES (
          ${winner.kind}, ${winner.key}, ${winner.workspaceProjectId}, ${winner.version},
          ${winner.contentHash}, ${loserJson}, ${detectedAt}
        )
        ON CONFLICT (kind, key) DO UPDATE SET
          workspace_project_id = excluded.workspace_project_id,
          version = excluded.version,
          local_content_hash = excluded.local_content_hash,
          remote_record = excluded.remote_record,
          detected_at = excluded.detected_at
      `.pipe(Effect.mapError(sqlError("roaming.blob.record-conflict")));
    });

  const applyRemote: RoamingBlobStore["Service"]["applyRemote"] = Effect.fn(
    "RoamingBlobStore.applyRemote",
  )((record) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // Integrity gate: a record whose hash disagrees with its payload
        // would poison reconciliation against every other peer.
        if (contentHashOf(record.payload) !== record.contentHash) {
          return yield* new PersistenceSqlError({
            operation: "roaming.blob.apply-remote",
            detail: `contentHash mismatch for (${record.kind}, ${record.key}) from ${record.authorEnvironmentId}`,
          });
        }
        const existing = (yield* selectRow(
          { kind: record.kind, key: record.key },
          "roaming.blob.apply-remote",
        ))[0];
        if (existing !== undefined && record.version < existing.version) {
          return "stale" as const;
        }
        if (existing !== undefined && record.version === existing.version) {
          if (record.contentHash === existing.contentHash) {
            return "applied" as const;
          }
          // Concurrent writes (equal version, different hash): auto-resolve
          // newest-updatedAt-wins (D1, 2026-07-22), ties broken on author id
          // so both machines pick the same winner. The loser is preserved in
          // the conflict record and surfaced as a notice on the project row.
          const remoteWins =
            record.updatedAt > existing.updatedAt ||
            (record.updatedAt === existing.updatedAt &&
              record.authorEnvironmentId > existing.authorEnvironmentId);
          if (remoteWins) {
            const localRecord = yield* decodeRecord(existing).pipe(
              Effect.mapError(decodeError("roaming.blob.apply-remote")),
            );
            yield* recordConflict(record, localRecord);
            yield* upsertRow(record, "roaming.blob.apply-remote");
            yield* publishChange(record);
            return "conflict" as const;
          }
          // Local wins: no write and — critically — NO publish. Republishing
          // the unchanged local record here re-triggered the mirror on every
          // pass (the equal-version hot loop, G2). The peer adopts our copy
          // by the same rule and the manifests converge on their own.
          yield* recordConflict(existing, record);
          return "conflict" as const;
        }
        yield* upsertRow(record, "roaming.blob.apply-remote");
        yield* clearConflict(record, "roaming.blob.apply-remote");
        yield* publishChange(record);
        return "applied" as const;
      }),
    ),
  );

  const getMany: RoamingBlobStore["Service"]["getMany"] = Effect.fn("RoamingBlobStore.getMany")(
    function* (refs) {
      const records: RoamingBlobRecord[] = [];
      for (const ref of refs) {
        const record = yield* get(ref);
        if (record !== null) {
          records.push(record);
        }
      }
      return records;
    },
  );

  const manifest: RoamingBlobStore["Service"]["manifest"] = Effect.fn("RoamingBlobStore.manifest")(
    function* () {
      const rows = yield* sql`
        SELECT
          kind,
          key,
          version,
          content_hash AS "contentHash"
        FROM roaming_blobs
        ORDER BY kind, key
      `.pipe(Effect.mapError(sqlError("roaming.blob.manifest")));
      return yield* decodeManifestEntries(rows).pipe(
        Effect.mapError(decodeError("roaming.blob.manifest")),
      );
    },
  );

  const listConflicts: RoamingBlobStore["Service"]["listConflicts"] = Effect.fn(
    "RoamingBlobStore.listConflicts",
  )(function* () {
    const rows = yield* sql<{
      readonly kind: string;
      readonly key: string;
      readonly workspaceProjectId: string;
      readonly version: number;
      readonly localContentHash: string;
      readonly remoteRecord: string;
      readonly detectedAt: string;
    }>`
      SELECT
        kind,
        key,
        workspace_project_id AS "workspaceProjectId",
        version,
        local_content_hash AS "localContentHash",
        remote_record AS "remoteRecord",
        detected_at AS "detectedAt"
      FROM roaming_blob_conflicts
      ORDER BY detected_at
    `.pipe(Effect.mapError(sqlError("roaming.blob.list-conflicts")));

    const conflicts: RoamingBlobConflict[] = [];
    for (const row of rows) {
      const remote = yield* decodeConflictRemote(row.remoteRecord).pipe(
        Effect.mapError(decodeError("roaming.blob.list-conflicts")),
      );
      conflicts.push(
        yield* decodeConflict({
          kind: row.kind,
          key: row.key,
          workspaceProjectId: row.workspaceProjectId,
          version: row.version,
          localContentHash: row.localContentHash,
          remote,
          detectedAt: row.detectedAt,
        }).pipe(Effect.mapError(decodeError("roaming.blob.list-conflicts"))),
      );
    }
    return conflicts;
  });

  return {
    writeLocal,
    applyRemote,
    get,
    getMany,
    manifest,
    listConflicts,
    subscribeChanges: PubSub.subscribe(changesPubSub),
    changeRevision: Ref.get(revisionRef),
  } satisfies RoamingBlobStore["Service"];
});

export const layer = Layer.effect(RoamingBlobStore, make);
