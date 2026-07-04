/**
 * RoamingBlobStore - Local storage and reconciliation for roaming blobs.
 *
 * One record shape for every roaming kind (decision D3); rows live in the
 * server's SQLite and reconcile with peers through the mirror. The store owns
 * the reconciliation rule; transport lives elsewhere (PeerMirror).
 *
 * Reconciliation per (kind, key): higher version wins; equal versions with
 * different content hashes are concurrent writes and are recorded as a
 * conflict, never merged. Payload strings are byte-authoritative — they are
 * stored and hashed verbatim, never re-serialized.
 */
import { createHash } from "node:crypto";

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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
    /** Every accepted write (local or remote) in arrival order. */
    readonly changes: Stream.Stream<RoamingBlobRecord>;
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
const RemoteRecordFromJson = Schema.fromJsonString(RoamingBlobRecord);
const decodeConflictRemote = Schema.decodeUnknownEffect(RemoteRecordFromJson);
const encodeRemoteRecordJson = Schema.encodeEffect(RemoteRecordFromJson);

const contentHashOf = (payload: string): string =>
  createHash("sha256").update(payload, "utf8").digest("hex");

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const changesPubSub = yield* PubSub.unbounded<RoamingBlobRecord>();

  const selectRow = (ref: RoamingBlobRef) =>
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
    `.pipe(Effect.mapError(sqlError("roaming.blob.get")));

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

  const get: RoamingBlobStore["Service"]["get"] = Effect.fn("RoamingBlobStore.get")(function* (
    ref,
  ) {
    const rows = yield* selectRow(ref);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return yield* decodeRecord(row).pipe(Effect.mapError(decodeError("roaming.blob.get")));
  });

  const writeLocal: RoamingBlobStore["Service"]["writeLocal"] = Effect.fn(
    "RoamingBlobStore.writeLocal",
  )(function* (input) {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const existing = yield* selectRow({ kind: input.kind, key: input.key });
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
    yield* PubSub.publish(changesPubSub, record);
    return record;
  });

  const recordConflict = (local: typeof BlobRowSchema.Type, remote: RoamingBlobRecord) =>
    Effect.gen(function* () {
      const remoteJson = yield* encodeRemoteRecordJson(remote).pipe(
        Effect.mapError(decodeError("roaming.blob.record-conflict")),
      );
      const detectedAt = yield* nowIso;
      yield* sql`
        INSERT INTO roaming_blob_conflicts (
          kind, key, workspace_project_id, version,
          local_content_hash, remote_record, detected_at
        ) VALUES (
          ${local.kind}, ${local.key}, ${local.workspaceProjectId}, ${local.version},
          ${local.contentHash}, ${remoteJson}, ${detectedAt}
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
  )(function* (record) {
    const existing = (yield* selectRow({ kind: record.kind, key: record.key }))[0];
    if (existing !== undefined && record.version < existing.version) {
      return "stale" as const;
    }
    if (existing !== undefined && record.version === existing.version) {
      if (record.contentHash === existing.contentHash) {
        return "applied" as const;
      }
      yield* recordConflict(existing, record);
      return "conflict" as const;
    }
    yield* upsertRow(record, "roaming.blob.apply-remote");
    yield* PubSub.publish(changesPubSub, record);
    return "applied" as const;
  });

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
        yield* Schema.decodeUnknownEffect(RoamingBlobConflict)({
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
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies RoamingBlobStore["Service"];
});

export const layer = Layer.effect(RoamingBlobStore, make);
