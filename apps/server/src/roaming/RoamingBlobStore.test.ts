import * as NodeCrypto from "node:crypto";

import { EnvironmentId, RoamingBlobRecord, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { diffManifests } from "./PeerMirror.ts";
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
const decodeRoamingBlobRecord = Schema.decodeUnknownSync(RoamingBlobRecord);

const remoteRecord = (input: {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
  readonly updatedAt?: string;
}): RoamingBlobRecord =>
  decodeRoamingBlobRecord({
    schemaVersion: 1,
    kind: "registry",
    key: input.key,
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    version: input.version,
    contentHash: NodeCrypto.createHash("sha256").update(input.payload, "utf8").digest("hex"),
    authorEnvironmentId: REMOTE_ENVIRONMENT_ID,
    updatedAt: input.updatedAt ?? "2026-07-04T00:00:00.000Z",
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
        NodeCrypto.createHash("sha256").update('{"title":"one"}', "utf8").digest("hex"),
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

      // Equal version, different hash, equal updatedAt and author → the
      // deterministic tie-break keeps local; the loser is retained.
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

      // An accepted write for the key supersedes the recorded conflict.
      yield* store.applyRemote(remoteRecord({ key: "wp-rec", version: 4, payload: '{"v":4}' }));
      assert.deepEqual(yield* store.listConflicts(), []);
    }),
  );

  it.effect("subscribeChanges emits for accepted writes and recorded conflicts", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      // Subscription is established when subscribeChanges returns — no race.
      const changes = yield* store.subscribeChanges;

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
      // Stale and idempotent equal-version applies are silent, and so is a
      // conflict the local copy wins — republishing the unchanged local
      // record was the mirror hot loop (G2).
      const staleOutcome = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 2, payload: '{"c":2}' }),
      );
      assert.equal(staleOutcome, "stale");
      const conflictOutcome = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 5, payload: '{"c":"other"}' }),
      );
      assert.equal(conflictOutcome, "conflict");
      const idempotentOutcome = yield* store.applyRemote(
        remoteRecord({ key: "wp-changes", version: 5, payload: '{"c":5}' }),
      );
      assert.equal(idempotentOutcome, "applied");
      // The third emission must be this trailing local write.
      yield* store.writeLocal({
        kind: "registry",
        key: "wp-changes",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"c":6}',
      });

      const emissions = [
        yield* PubSub.take(changes),
        yield* PubSub.take(changes),
        yield* PubSub.take(changes),
      ];
      assert.equal(emissions[0]?.version, 1);
      assert.equal(emissions[0]?.authorEnvironmentId, LOCAL_ENVIRONMENT_ID);
      assert.equal(emissions[1]?.version, 5);
      assert.equal(emissions[1]?.authorEnvironmentId, REMOTE_ENVIRONMENT_ID);
      assert.equal(emissions[2]?.version, 6);
      assert.equal(emissions[2]?.authorEnvironmentId, LOCAL_ENVIRONMENT_ID);
      assert.deepEqual(Array.from(yield* PubSub.takeUpTo(changes, 10)), []);
    }),
  );

  it.effect("rejects remote records whose hash disagrees with the payload", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      const poisoned = {
        ...remoteRecord({ key: "wp-poison", version: 1, payload: '{"ok":true}' }),
        contentHash: "0".repeat(64),
      };
      const result = yield* store.applyRemote(poisoned).pipe(Effect.flip);
      assert.equal(result._tag, "PersistenceSqlError");
      assert.equal(yield* store.get({ kind: "registry", key: "wp-poison" }), null);
    }),
  );

  it.effect("serializes concurrent same-version writes into applied + conflict", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      yield* store.applyRemote(remoteRecord({ key: "wp-race", version: 2, payload: '{"r":2}' }));

      const outcomes = yield* Effect.all(
        [
          store.applyRemote(remoteRecord({ key: "wp-race", version: 3, payload: '{"r":"a"}' })),
          store.applyRemote(remoteRecord({ key: "wp-race", version: 3, payload: '{"r":"b"}' })),
        ],
        { concurrency: 2 },
      );
      assert.deepEqual([...outcomes].sort(), ["applied", "conflict"]);
      const conflicts = yield* store.listConflicts();
      assert.equal(conflicts.filter((conflict) => conflict.key === "wp-race").length, 1);
    }),
  );

  it.effect("newest remote wins an equal-version conflict; the loser is preserved", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      const changes = yield* store.subscribeChanges;
      const local = yield* store.writeLocal({
        kind: "registry",
        key: "wp-newest",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"n":"local"}',
      });
      const newer = remoteRecord({
        key: "wp-newest",
        version: 1,
        payload: '{"n":"remote"}',
        updatedAt: "2999-01-01T00:00:00.000Z",
      });

      const outcome = yield* store.applyRemote(newer);
      assert.equal(outcome, "conflict");
      // The store adopted the newer remote copy and published the change...
      assert.equal(
        (yield* store.get({ kind: "registry", key: "wp-newest" }))?.payload,
        '{"n":"remote"}',
      );
      const emissions = [yield* PubSub.take(changes), yield* PubSub.take(changes)];
      assert.equal(emissions[1]?.payload, '{"n":"remote"}');
      // ...and preserved the losing local write in the conflict record.
      const conflicts = yield* store.listConflicts();
      const recorded = conflicts.find((conflict) => conflict.key === "wp-newest");
      assert.equal(recorded?.localContentHash, newer.contentHash);
      assert.deepEqual(recorded?.remote, local);
    }),
  );

  it.effect("equal-version conflict converges without feeding the mirror loop (G2)", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      const changes = yield* store.subscribeChanges;
      const local = yield* store.writeLocal({
        kind: "registry",
        key: "wp-loop",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"l":"mine"}',
      });
      // Older concurrent write: local wins every pass. (Explicit timestamp —
      // the TestClock pins writeLocal's updatedAt to the 1970 epoch.)
      const older = remoteRecord({
        key: "wp-loop",
        version: 1,
        payload: '{"l":"theirs"}',
        updatedAt: "1969-01-01T00:00:00.000Z",
      });

      // Several mirror passes fetch the same conflicted record.
      for (let pass = 0; pass < 3; pass += 1) {
        assert.equal(yield* store.applyRemote(older), "conflict");
      }

      // Exactly one conflict record, stable across passes (no detected_at churn).
      const conflicts = (yield* store.listConflicts()).filter(
        (conflict) => conflict.key === "wp-loop",
      );
      assert.equal(conflicts.length, 1);
      const detectedAt = conflicts[0]?.detectedAt;
      assert.equal(yield* store.applyRemote(older), "conflict");
      assert.equal(
        (yield* store.listConflicts()).find((conflict) => conflict.key === "wp-loop")?.detectedAt,
        detectedAt,
      );

      // Exactly one publish (the original local write) — the losing-side
      // republish that re-triggered the mirror every pass is gone.
      assert.equal((yield* PubSub.take(changes))?.payload, '{"l":"mine"}');
      assert.deepEqual(Array.from(yield* PubSub.takeUpTo(changes, 10)), []);

      // Once the peer adopts our copy by the same newest-wins rule, the
      // manifests agree and nothing is re-queued for fetch.
      const manifest = (yield* store.manifest()).filter((entry) => entry.key === "wp-loop");
      const peerManifest = [
        { kind: "registry", key: "wp-loop", version: 1, contentHash: local.contentHash } as const,
      ];
      assert.deepEqual(diffManifests(manifest, peerManifest), { toFetch: [], toPush: [] });
    }),
  );

  it.effect("getMany returns found records, omitting misses, across kinds", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      // Same key under two kinds must coexist (PK is (kind, key)).
      yield* store.writeLocal({
        kind: "registry",
        key: "wp-shared",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"kind":"registry"}',
      });
      yield* store.writeLocal({
        kind: "lease",
        key: "wp-shared",
        workspaceProjectId: WORKSPACE_PROJECT_ID,
        payload: '{"kind":"lease"}',
      });

      const records = yield* store.getMany([
        { kind: "registry", key: "wp-shared" },
        { kind: "lease", key: "wp-shared" },
        { kind: "vault", key: "wp-missing" },
      ]);
      assert.deepEqual(
        records.map((record) => [record.kind, record.payload]),
        [
          ["registry", '{"kind":"registry"}'],
          ["lease", '{"kind":"lease"}'],
        ],
      );
    }),
  );

  it.effect("an unknown wire kind is rejected as stale and never fetched (C1)", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      // A newer build ships a kind this one doesn't know: rejected without
      // wedging the exchange, and nothing lands in the local table.
      const futureKind = {
        ...remoteRecord({ key: "wp-future", version: 1, payload: '{"f":1}' }),
        kind: "recipe",
      };
      assert.equal(yield* store.applyRemote(futureKind), "stale");
      assert.equal(yield* store.get({ kind: "recipe", key: "wp-future" }), null);

      // The mirror diff skips the peer's unknown kinds instead of fetching.
      const peerManifest = [
        { kind: "recipe", key: "wp-future", version: 1, contentHash: futureKind.contentHash },
      ];
      assert.deepEqual(diffManifests([], peerManifest), { toFetch: [], toPush: [] });
    }),
  );

  it.effect("a newer conflict for a key replaces the previously recorded one", () =>
    Effect.gen(function* () {
      const store = yield* RoamingBlobStore;
      yield* store.applyRemote(remoteRecord({ key: "wp-two", version: 1, payload: '{"t":1}' }));
      yield* store.applyRemote(remoteRecord({ key: "wp-two", version: 1, payload: '{"t":"x"}' }));
      const second = remoteRecord({ key: "wp-two", version: 1, payload: '{"t":"y"}' });
      yield* store.applyRemote(second);

      const conflicts = (yield* store.listConflicts()).filter(
        (conflict) => conflict.key === "wp-two",
      );
      assert.equal(conflicts.length, 1);
      assert.deepEqual(conflicts[0]?.remote, second);
    }),
  );
});
