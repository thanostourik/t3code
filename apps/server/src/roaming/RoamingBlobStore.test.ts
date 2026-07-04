import { createHash } from "node:crypto";

import { EnvironmentId, RoamingBlobRecord, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("env-remote");
const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-1");

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in RoamingBlobStore tests"),
});

const layer = it.layer(
  roamingBlobStoreLayer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverEnvironmentStub),
  ),
);

const remoteRecord = (input: {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
}): RoamingBlobRecord =>
  Schema.decodeUnknownSync(RoamingBlobRecord)({
    schemaVersion: 1,
    kind: "registry",
    key: input.key,
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    version: input.version,
    contentHash: createHash("sha256").update(input.payload, "utf8").digest("hex"),
    authorEnvironmentId: REMOTE_ENVIRONMENT_ID,
    updatedAt: "2026-07-04T00:00:00.000Z",
    payload: input.payload,
  });

layer("RoamingBlobStore", (it) => {
  it.effect("writeLocal mints version 1 with sha256 hash, then bumps versions", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;

      const first = yield* store.writeLocal({
        kind: "registry",
        key: "wp-write",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"title":"one"}',
      });
      assert.equal(first.version, 1);
      assert.equal(
        first.contentHash,
        createHash("sha256").update('{"title":"one"}', "utf8").digest("hex"),
      );
      assert.equal(first.authorEnvironmentId, LOCAL_ENVIRONMENT_ID);

      const second = yield* store.writeLocal({
        kind: "registry",
        key: "wp-write",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"title":"two"}',
      });
      assert.equal(second.version, 2);

      const stored = yield* store.get({ kind: "registry", key: "wp-write" });
      assert.equal(stored?.version, 2);
      assert.equal(stored?.payload, '{"title":"two"}');
    }),
  );

  it.effect("manifest lists entries with version and contentHash", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      const written = yield* store.writeLocal({
        kind: "registry",
        key: "wp-manifest",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"title":"m"}',
      });

      const manifest = yield* store.manifest();
      const entry = manifest.find((candidate) => candidate.key === "wp-manifest");
      assert.deepEqual(entry, {
        kind: "registry",
        key: "wp-manifest",
        version: 1,
        contentHash: written.contentHash,
      });
    }),
  );

  it.effect("applyRemote follows the reconciliation rule", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;

      // Absent locally → insert, applied.
      const inserted = yield* store.applyRemote(
        remoteRecord({ key: "wp-rec", version: 1, payload: '{"v":1}' }),
      );
      assert.equal(inserted, "applied");
      assert.equal((yield* store.get({ kind: "registry", key: "wp-rec" }))?.version, 1);

      // Higher version → replace, applied.
      const replaced = yield* store.applyRemote(
        remoteRecord({ key: "wp-rec", version: 3, payload: '{"v":3}' }),
      );
      assert.equal(replaced, "applied");
      assert.equal((yield* store.get({ kind: "registry", key: "wp-rec" }))?.version, 3);

      // Lower version → stale, local unchanged.
      const stale = yield* store.applyRemote(
        remoteRecord({ key: "wp-rec", version: 2, payload: '{"v":2}' }),
      );
      assert.equal(stale, "stale");
      assert.equal((yield* store.get({ kind: "registry", key: "wp-rec" }))?.payload, '{"v":3}');

      // Equal version, same hash → applied, no change.
      const idempotent = yield* store.applyRemote(
        remoteRecord({ key: "wp-rec", version: 3, payload: '{"v":3}' }),
      );
      assert.equal(idempotent, "applied");

      // Equal version, different hash → conflict; local kept, remote retained.
      const conflicting = remoteRecord({ key: "wp-rec", version: 3, payload: '{"v":"other"}' });
      const conflict = yield* store.applyRemote(conflicting);
      assert.equal(conflict, "conflict");
      assert.equal((yield* store.get({ kind: "registry", key: "wp-rec" }))?.payload, '{"v":3}');

      const conflicts = yield* store.listConflicts();
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0]?.kind, "registry");
      assert.equal(conflicts[0]?.key, "wp-rec");
      assert.equal(conflicts[0]?.version, 3);
      assert.deepEqual(conflicts[0]?.remote, conflicting);
    }),
  );

  it.effect("changes emits for accepted writes only", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      const collector = yield* Stream.runCollect(Stream.take(store.changes, 3)).pipe(
        Effect.forkChild,
      );
      // Give the subscriber a beat to attach before publishing.
      yield* Effect.yieldNow;

      yield* store.writeLocal({
        kind: "registry",
        key: "wp-changes",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"c":1}',
      });
      const applied = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 5, payload: '{"c":5}' }),
      );
      assert.equal(applied, "applied");
      // Neither a stale write nor a conflict may emit…
      const staleOutcome = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 2, payload: '{"c":2}' }),
      );
      assert.equal(staleOutcome, "stale");
      const conflictOutcome = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 5, payload: '{"c":"other"}' }),
      );
      assert.equal(conflictOutcome, "conflict");
      // …so the third emission must be this trailing local write.
      yield* store.writeLocal({
        kind: "registry",
        key: "wp-changes",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"c":6}',
      });

      const emissions = Array.from(yield* Fiber.join(collector));
      assert.equal(emissions.length, 3);
      assert.equal(emissions[0]?.version, 1);
      assert.equal(emissions[0]?.authorEnvironmentId, LOCAL_ENVIRONMENT_ID);
      assert.equal(emissions[1]?.version, 5);
      assert.equal(emissions[1]?.authorEnvironmentId, REMOTE_ENVIRONMENT_ID);
      assert.equal(emissions[2]?.version, 6);
      assert.equal(emissions[2]?.authorEnvironmentId, LOCAL_ENVIRONMENT_ID);
    }),
  );
});
