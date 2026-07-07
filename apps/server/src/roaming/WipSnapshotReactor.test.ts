import * as NodeCrypto from "node:crypto";

import {
  EnvironmentId,
  RoamingRegistryPayload,
  RoamingWipPayload,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer, vcsLayer } from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { runWipApplyForTarget, runWipPassForTarget, type WipTarget } from "./WipSnapshotReactor.ts";
import {
  captureWipSnapshot,
  resolveOid,
  wipPushedMarkerRefName,
  wipRefName,
} from "./WipSnapshots.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-wip-local");

const decodeWipPayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingWipPayload));

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in WipSnapshotReactor tests"),
});

const supportLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-wip-reactor-test-" }),
  serverEnvironmentStub,
  SqlitePersistenceMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

const testLayer = it.layer(
  Layer.mergeAll(
    roamingBlobStoreLayer,
    GitVcsDriverLayer,
    vcsLayer.pipe(Layer.provide(VcsProcess.layer)),
  ).pipe(Layer.provideMerge(supportLayer)),
);

const git = (cwd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver;
    return yield* driver.execute({
      operation: "WipSnapshotReactor.test.git",
      cwd,
      args,
    });
  });

const gitStdout = (cwd: string, args: readonly string[]) =>
  Effect.map(git(cwd, args), (result) => result.stdout.trim());

const initRepoWithOrigin = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const originPath = pathService.join(root, "origin.git");
  const workPath = pathService.join(root, "work");
  yield* fs.makeDirectory(originPath, { recursive: true });
  yield* fs.makeDirectory(workPath, { recursive: true });
  yield* git(originPath, ["init", "--bare", "-b", "main"]);
  yield* git(workPath, ["init", "-b", "main"]);
  yield* git(workPath, ["config", "user.email", "wip@example.test"]);
  yield* git(workPath, ["config", "user.name", "Wip Test"]);
  yield* git(workPath, ["remote", "add", "origin", originPath]);
  yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "base\n");
  yield* git(workPath, ["add", "."]);
  yield* git(workPath, ["commit", "-m", "base"]);
  yield* git(workPath, ["push", "origin", "main"]);
  return { originPath, workPath };
});

const target = (workspaceProjectId: WorkspaceProjectId, workPath: string): WipTarget => ({
  workspaceProjectId,
  workspaceRoot: workPath,
  localProjectId: "project-wip",
});

const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-wip-peer");

const withCommitterDate = <A, E, R>(iso: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.GIT_COMMITTER_DATE;
      process.env.GIT_COMMITTER_DATE = iso;
      process.env.GIT_AUTHOR_DATE = iso;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.GIT_COMMITTER_DATE;
        } else {
          process.env.GIT_COMMITTER_DATE = previous;
        }
        delete process.env.GIT_AUTHOR_DATE;
        return undefined;
      }),
  );

// Real wall clock on purpose: git stamps commits with system time, so the
// staleness guards compare against real dates, not the frozen TestClock.
const minutesFromNow = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { minutes }));

/** Bare origin, a peer clone that authors snapshots, a local clone that applies. */
const initApplyFixture = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const { originPath, workPath: peerPath } = yield* initRepoWithOrigin(root);
  yield* fs.writeFileString(pathService.join(peerPath, ".gitignore"), ".env\n");
  yield* git(peerPath, ["add", "."]);
  yield* git(peerPath, ["commit", "-m", "ignore rules"]);
  yield* git(peerPath, ["push", "origin", "main"]);
  const localPath = pathService.join(root, "local");
  yield* git(root, ["clone", originPath, localPath]);
  yield* git(localPath, ["config", "user.email", "wip@example.test"]);
  yield* git(localPath, ["config", "user.name", "Wip Test"]);
  return { originPath, peerPath, localPath };
});

const peerSnapshot = (peerPath: string, wsid: WorkspaceProjectId, dateIso: string) =>
  withCommitterDate(
    dateIso,
    Effect.gen(function* () {
      const captured = yield* captureWipSnapshot({
        cwd: peerPath,
        workspaceProjectId: wsid,
        environmentId: PEER_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(captured);
      yield* git(peerPath, ["push", "origin", `+${captured!.refName}:${captured!.refName}`]);
      return captured!;
    }),
  );

testLayer("WipSnapshotReactor", (it) => {
  it.effect("captures a dirty tree with parent=HEAD, excluding vault paths", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-capture");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-capture-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");
      yield* fs.writeFileString(pathService.join(workPath, "scratch.txt"), "untracked\n");
      yield* fs.writeFileString(pathService.join(workPath, ".env"), "SECRET=1\n");

      const captured = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [".env"],
      });
      assert.isNotNull(captured);
      const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
      const head = yield* gitStdout(workPath, ["rev-parse", "HEAD"]);
      const parent = yield* gitStdout(workPath, ["rev-parse", `${refName}^`]);
      assert.strictEqual(parent, head);

      const treeListing = yield* gitStdout(workPath, [
        "ls-tree",
        "--name-only",
        `${refName}^{tree}`,
      ]);
      const names = treeListing.split("\n");
      assert.include(names, "tracked.txt");
      assert.include(names, "scratch.txt");
      assert.notInclude(names, ".env");

      const dirtyContent = yield* gitStdout(workPath, ["show", `${refName}:tracked.txt`]);
      assert.strictEqual(dirtyContent, "dirty");
    }),
  );

  it.effect("skips commit when the tree matches skipIfTreeOid", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-noop");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-noop-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "scratch.txt"), "untracked\n");

      const first = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(first);
      const second = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
        skipIfTreeOid: first!.treeOid,
      });
      assert.isNull(second);
    }),
  );

  it.effect("pushes the wip ref to the origin and records the marker", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-push");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-push-" });
      const { workPath, originPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");

      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "done");
      assert.strictEqual(outcome._tag === "done" && outcome.entry.mode, "origin-refs");
      assert.isDefined(outcome._tag === "done" ? outcome.entry.lastPushedAt : undefined);

      const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
      const markerRef = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      const localOid = yield* resolveOid(workPath, refName);
      const markerOid = yield* resolveOid(workPath, markerRef);
      const originOid = yield* gitStdout(originPath, ["rev-parse", refName]);
      assert.isNotNull(localOid);
      assert.strictEqual(markerOid, localOid);
      assert.strictEqual(originOid, localOid);
    }),
  );

  it.effect("captures a clean tree so committed work is not shadowed, then no-ops", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-clean");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-clean-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");

      const dirty = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(dirty._tag, "done");

      // Commit the dirty work plus a new file: the tree is now clean but
      // differs from the pushed snapshot, so a pass must re-capture.
      yield* fs.writeFileString(pathService.join(workPath, "extra.txt"), "extra\n");
      yield* git(workPath, ["add", "."]);
      yield* git(workPath, ["commit", "-m", "landed"]);
      const clean = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(clean._tag, "done");

      const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
      const refTree = yield* resolveOid(workPath, `${refName}^{tree}`);
      const headTree = yield* resolveOid(workPath, "HEAD^{tree}");
      assert.strictEqual(refTree, headTree);

      // Fully clean and already pushed: the next pass is a fast-path skip.
      const noop = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(noop._tag, "skipped");
    }),
  );

  it.effect("recovers from a lost pushed-marker by adopting the remote value", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-lease");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-lease-" });
      const { workPath, originPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty-1\n");
      const first = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(first._tag, "done");

      const markerRef = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      yield* git(workPath, ["update-ref", "-d", markerRef]);

      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty-2\n");
      const second = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(second._tag, "done");
      assert.strictEqual(second._tag === "done" && second.entry.lastError, undefined);

      const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
      const originOid = yield* gitStdout(originPath, ["rev-parse", refName]);
      const localOid = yield* resolveOid(workPath, refName);
      assert.strictEqual(originOid, localOid);
    }),
  );

  it.effect("falls back to a bundle blob when the origin refuses pushes", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-bundle");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const blobStore = yield* RoamingBlobStore;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-bundle-" });
      const { workPath, originPath } = yield* initRepoWithOrigin(root);
      const hookPath = pathService.join(originPath, "hooks", "pre-receive");
      yield* fs.writeFileString(hookPath, "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n");
      yield* fs.chmod(hookPath, 0o755);

      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");
      yield* fs.writeFileString(pathService.join(workPath, ".env"), "SECRET=1\n");
      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "done");
      assert.strictEqual(outcome._tag === "done" && outcome.nextMode, "bundle");
      assert.strictEqual(outcome._tag === "done" && outcome.entry.mode, "bundle");

      const blob = yield* blobStore.get({
        kind: "wip",
        key: `${wsid}/${LOCAL_ENVIRONMENT_ID}`,
      });
      assert.isNotNull(blob);
      const payload = yield* decodeWipPayloadJson(blob!.payload);
      assert.strictEqual(payload.refName, `refs/t3/wip/${wsid}/${LOCAL_ENVIRONMENT_ID}`);

      // The bundle must apply against a fresh clone of the origin.
      const clonePath = pathService.join(root, "clone");
      yield* git(root, ["clone", originPath, clonePath]);
      const bundlePath = pathService.join(root, "wip.bundle");
      yield* fs.writeFile(bundlePath, Buffer.from(payload.bundleBase64, "base64"));
      yield* git(clonePath, ["bundle", "verify", bundlePath]);
      yield* git(clonePath, ["fetch", bundlePath, `${payload.refName}:${payload.refName}`]);
      const fetched = yield* resolveOid(clonePath, payload.refName);
      assert.strictEqual(fetched, payload.commitOid);
      const treeListing = yield* gitStdout(clonePath, [
        "ls-tree",
        "--name-only",
        `${payload.refName}^{tree}`,
      ]);
      assert.notInclude(treeListing.split("\n"), ".env");
    }),
  );

  it.effect("skips the bundle blob when the bundle exceeds the size cap", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-cap");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const blobStore = yield* RoamingBlobStore;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-cap-" });
      const { workPath, originPath } = yield* initRepoWithOrigin(root);
      const hookPath = pathService.join(originPath, "hooks", "pre-receive");
      yield* fs.writeFileString(hookPath, "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n");
      yield* fs.chmod(hookPath, 0o755);

      // Incompressible payload larger than the 8 MiB cap.
      yield* fs.writeFile(
        pathService.join(workPath, "huge.bin"),
        NodeCrypto.randomBytes(9 * 1024 * 1024),
      );
      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "done");
      assert.strictEqual(
        outcome._tag === "done" && outcome.entry.lastError,
        "wip bundle exceeds size cap",
      );
      const blob = yield* blobStore.get({
        kind: "wip",
        key: `${wsid}/${LOCAL_ENVIRONMENT_ID}`,
      });
      assert.isNull(blob);
    }),
  );

  it.effect("surfaces a non-permission push failure and stays in origin mode", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-pushfail");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-pushfail-" });
      const { workPath, originPath } = yield* initRepoWithOrigin(root);
      // An unreachable remote fails with neither permission- nor lease-shaped
      // stderr — the generic branch must surface it and keep origin mode.
      yield* fs.remove(originPath, { recursive: true, force: true });
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");

      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "done");
      assert.strictEqual(outcome._tag === "done" && outcome.nextMode, "origin-refs");
      assert.match((outcome._tag === "done" && outcome.entry.lastError) || "", /^push failed: /);
    }),
  );

  it.effect("reports a project with no git remote instead of failing", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-noremote");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-noremote-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      yield* git(workPath, ["remote", "remove", "origin"]);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");

      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "done");
      assert.strictEqual(
        outcome._tag === "done" && outcome.entry.lastError,
        "no git remote configured",
      );
    }),
  );

  it.effect("skips while a merge is in progress", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-merge");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-merge-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      const head = yield* gitStdout(workPath, ["rev-parse", "HEAD"]);
      yield* fs.writeFileString(pathService.join(workPath, ".git", "MERGE_HEAD"), `${head}\n`);
      yield* fs.writeFileString(pathService.join(workPath, "tracked.txt"), "dirty\n");

      const outcome = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(outcome._tag, "skipped");
      const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
      assert.isNull(yield* resolveOid(workPath, refName));
    }),
  );

  it.effect("auto-applies a newer peer snapshot onto a pristine clone", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-pristine");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-a-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "peer work\n");
      yield* fs.writeFileString(pathService.join(peerPath, "peer-note.txt"), "from peer\n");
      const snapshot = yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      yield* fs.writeFileString(pathService.join(localPath, ".env"), "SECRET=local\n");
      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(
        outcome._tag === "applied" && outcome.fromEnvironmentId,
        PEER_ENVIRONMENT_ID,
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "peer work\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "peer-note.txt")),
        "from peer\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, ".env")),
        "SECRET=local\n",
      );
      const marker = yield* resolveOid(localPath, `refs/t3/wip-applied/${wsid}`);
      assert.strictEqual(marker, snapshot.commitOid);

      // Echo safety: nothing newer -> the very next pass is a no-op.
      const again = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(again._tag, "skipped");
    }),
  );

  it.effect("fast-forwards a strictly-behind checkout, blocks on local edits", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-ff");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-b-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "v1\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      const first = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(first._tag, "applied");

      // No local edits since the apply: a newer snapshot fast-forwards.
      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "v2\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(120));
      const second = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(second._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "v2\n",
      );

      // Local edits: never touched again, surfaced as blocked.
      yield* fs.writeFileString(pathService.join(localPath, "local-own.txt"), "mine\n");
      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "v3\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(180));
      const third = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(third._tag, "blocked");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "v2\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "local-own.txt")),
        "mine\n",
      );
    }),
  );

  it.effect("never resurrects state older than the local HEAD", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-stale");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-c-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "old wip\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      const applied = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(applied._tag, "applied");

      // The user lands the work as a commit NEWER than the peer snapshot:
      // the checkout is clean again, but the old snapshot must not return.
      yield* fs.writeFileString(pathService.join(localPath, "tracked.txt"), "landed\n");
      yield* withCommitterDate(
        minutesFromNow(120),
        Effect.gen(function* () {
          yield* git(localPath, ["add", "."]);
          yield* git(localPath, ["commit", "-m", "landed"]);
        }),
      );
      const after = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(after._tag, "skipped");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "landed\n",
      );
    }),
  );

  it.effect("preserves locally-edited non-gitignored vault files across apply", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-vaultkeep");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const blobStore = yield* RoamingBlobStore;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-d-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // A COMMITTED project .t3sync naming a NON-gitignored untracked file:
      // that file is invisible to the edit-free guard, and clean -fd would
      // delete it. (An untracked .t3sync would itself count as a local edit
      // and block the apply — correct, but not this scenario.)
      yield* fs.writeFileString(pathService.join(peerPath, ".t3sync"), "service.key.txt\n");
      yield* git(peerPath, ["add", ".t3sync"]);
      yield* git(peerPath, ["commit", "-m", "sync manifest"]);
      yield* git(peerPath, ["push", "origin", "main"]);
      yield* git(localPath, ["pull", "origin", "main"]);
      yield* fs.writeFileString(pathService.join(localPath, "service.key.txt"), "USER-EDIT\n");

      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "peer work\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "peer work\n",
      );
      // The user's local edit — not any mirrored copy — survives the restore.
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "service.key.txt")),
        "USER-EDIT\n",
      );
    }),
  );

  it.effect("based-on: laptop edits flow back to the still-unchanged dirty desktop", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-basedon");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-basedon-" });
      // Roles: the fixture's WORK repo is the "desktop" (this machine, dirty
      // author); the clone is the "laptop" authoring under the peer env id.
      const { peerPath: desktopPath, localPath: laptopPath } = yield* initApplyFixture(root);

      yield* fs.writeFileString(pathService.join(desktopPath, "desktop-work.txt"), "desk\n");
      const s1 = yield* withCommitterDate(
        minutesFromNow(30),
        Effect.gen(function* () {
          const outcome = yield* runWipPassForTarget(target(wsid, desktopPath), "origin-refs");
          assert.strictEqual(outcome._tag, "done");
          const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
          return yield* resolveOid(desktopPath, refName);
        }),
      );
      assert.isNotNull(s1);

      // The laptop materializes the desktop's work: fetch, restore, marker.
      const glob = `refs/t3/wip/${wsid}/*`;
      yield* git(laptopPath, ["fetch", "origin", `+${glob}:${glob}`]);
      const desktopRef = `refs/t3/wip/${wsid}/${LOCAL_ENVIRONMENT_ID}`;
      yield* git(laptopPath, [
        "restore",
        "--source",
        desktopRef,
        "--worktree",
        "--staged",
        "--",
        ".",
      ]);
      yield* git(laptopPath, ["reset", "-q", "--", "."]);
      yield* git(laptopPath, ["update-ref", `refs/t3/wip-applied/${wsid}`, s1!]);

      // Laptop edits ON TOP and pushes: the snapshot carries T3-Based-On S1.
      yield* fs.writeFileString(pathService.join(laptopPath, "laptop-note.txt"), "note\n");
      yield* peerSnapshot(laptopPath, wsid, minutesFromNow(60));

      // Desktop: still dirty with the SAME work → pure fast-forward applies.
      const applied = yield* runWipApplyForTarget(target(wsid, desktopPath));
      assert.strictEqual(applied._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(desktopPath, "laptop-note.txt")),
        "note\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(desktopPath, "desktop-work.txt")),
        "desk\n",
      );

      // Desktop edits AFTER the laptop based itself on S1: true divergence,
      // the next laptop snapshot must be blocked.
      yield* fs.writeFileString(pathService.join(desktopPath, "desktop-more.txt"), "more\n");
      yield* fs.writeFileString(pathService.join(laptopPath, "laptop-note.txt"), "note v2\n");
      yield* peerSnapshot(laptopPath, wsid, minutesFromNow(90));
      const blocked = yield* runWipApplyForTarget(target(wsid, desktopPath));
      assert.strictEqual(blocked._tag, "blocked");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(desktopPath, "laptop-note.txt")),
        "note\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(desktopPath, "desktop-more.txt")),
        "more\n",
      );
    }),
  );
});
