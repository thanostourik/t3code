import { EnvironmentId, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { decodeLeasePayloadJson, renewLease } from "./WipLease.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-lease");
const LEASE_KEY = `${WORKSPACE_PROJECT_ID}/${ENVIRONMENT_ID}`;

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in WipLease tests"),
});

const layer = it.layer(
  roamingBlobStoreLayer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverEnvironmentStub),
  ),
);

const readLease = Effect.gen(function* () {
  const store = yield* RoamingBlobStore;
  const blob = yield* store.get({ kind: "lease", key: LEASE_KEY });
  assert.isNotNull(blob);
  return { version: blob!.version, payload: yield* decodeLeasePayloadJson(blob!.payload) };
});

layer("WipLease", (it) => {
  it.effect("snapshot renewal always writes and records lastSnapshotAt", () =>
    Effect.gen(function* () {
      yield* renewLease({
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        lastSnapshotAt: "2026-07-17T10:00:00.000Z",
      });
      const first = yield* readLease;
      assert.equal(first.payload.environmentId, ENVIRONMENT_ID);
      assert.equal(first.payload.lastSnapshotAt, "2026-07-17T10:00:00.000Z");

      // A second snapshot renewal moments later still writes (never throttled).
      yield* renewLease({
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        lastSnapshotAt: "2026-07-17T10:00:05.000Z",
      });
      const second = yield* readLease;
      assert.equal(second.version, first.version + 1);
      assert.equal(second.payload.lastSnapshotAt, "2026-07-17T10:00:05.000Z");
    }),
  );

  it.effect(
    "activity-only renewal is throttled fresh, writes when stale, carries lastSnapshotAt",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-17T10:00:00.000Z"));
        yield* renewLease({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          lastSnapshotAt: "2026-07-17T09:59:00.000Z",
        });
        const first = yield* readLease;

        // Renewed 10s ago: an activity-only renewal is a no-op.
        yield* TestClock.setTime(Date.parse("2026-07-17T10:00:10.000Z"));
        yield* renewLease({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
        });
        const throttled = yield* readLease;
        assert.equal(throttled.version, first.version);

        // Past the throttle window: writes, preserving the snapshot time.
        yield* TestClock.setTime(Date.parse("2026-07-17T10:05:00.000Z"));
        yield* renewLease({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
        });
        const renewed = yield* readLease;
        assert.equal(renewed.version, first.version + 1);
        assert.equal(renewed.payload.renewedAt, "2026-07-17T10:05:00.000Z");
        assert.equal(renewed.payload.lastSnapshotAt, "2026-07-17T09:59:00.000Z");
      }).pipe(Effect.provide(TestClock.layer())),
  );
});
