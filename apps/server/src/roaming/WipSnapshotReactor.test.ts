import * as NodeCrypto from "node:crypto";

import {
  EnvironmentId,
  ProjectId,
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
import {
  restoreParkedWipForTarget,
  runWipApplyForTarget,
  runWipPassForTarget,
  type WipTarget,
} from "./WipSnapshotReactor.ts";
import {
  captureWipSnapshot,
  resolveOid,
  wipAppliedMarkerRefName,
  wipPushedMarkerRefName,
  wipRefName,
} from "./WipSnapshots.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-wip-local");

const decodeWipPayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingWipPayload));
const encodeWipPayloadJson = Schema.encodeEffect(Schema.fromJsonString(RoamingWipPayload));

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
  localProjectId: ProjectId.make("project-wip"),
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
      const blobStore = yield* RoamingBlobStore;
      const captured = yield* captureWipSnapshot({
        cwd: peerPath,
        workspaceProjectId: wsid,
        environmentId: PEER_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(captured);
      yield* git(peerPath, ["push", "origin", `+${captured!.refName}:${captured!.refName}`]);
      yield* blobStore.writeLocal({
        kind: "wip",
        key: `${wsid}/${PEER_ENVIRONMENT_ID}`,
        workspaceProjectId: wsid,
        payload: yield* encodeWipPayloadJson({
          schemaVersion: 2,
          capturedAt: dateIso,
          refName: captured!.refName,
          commitOid: captured!.commitOid,
          treeOid: captured!.treeOid,
          branchRef: captured!.branchRef,
          headOid: captured!.headOid,
          bundleBase64: "",
        }),
      });
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

  it.effect("skips commit when the full snapshot identity matches", () =>
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
        skipIfSnapshots: [first!],
      });
      assert.isNull(second);
    }),
  );

  it.effect("captures a branch move even when the tree is unchanged", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-branch-move");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-branch-move-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      const first = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(first);
      yield* git(workPath, ["switch", "-c", "feature/same-tree"]);
      const second = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
        skipIfSnapshots: [first!],
      });
      assert.isNotNull(second);
      assert.strictEqual(second!.branchRef, "refs/heads/feature/same-tree");
      assert.strictEqual(second!.treeOid, first!.treeOid);
    }),
  );

  it.effect("re-ships an unchanged tree once after the applied marker moves, then settles", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-wip-reship");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-reship-" });
      const { workPath } = yield* initRepoWithOrigin(root);
      yield* fs.writeFileString(pathService.join(workPath, "scratch.txt"), "untracked\n");

      const first = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(first._tag, "done");
      const second = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(second._tag, "skipped");

      // Consume a peer snapshot (applied marker moves to a state that is not
      // our tree). The tree is unchanged, but the peer must still receive ONE
      // fresh snapshot whose Based-On records what we saw — that is how a
      // deletion that returns our tree to an already-shipped state gets
      // heard. And exactly one: the next pass settles, no ACK ping-pong.
      yield* fs.writeFileString(pathService.join(workPath, "peer-x.txt"), "peer\n");
      const markerSnap = yield* captureWipSnapshot({
        cwd: workPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(markerSnap);
      yield* fs.remove(pathService.join(workPath, "peer-x.txt"), { force: true });
      const appliedMarker = yield* wipAppliedMarkerRefName(wsid);
      yield* git(workPath, ["update-ref", appliedMarker, markerSnap!.commitOid]);

      const third = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(third._tag, "done");
      const fourth = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
      assert.strictEqual(fourth._tag, "skipped");
    }),
  );

  it.effect(
    "ships a tree that RETURNS to an old applied state (deletion deadlock regression)",
    () =>
      Effect.gen(function* () {
        // Measured deadlock (2026-07-10 harness): the applied marker sits at an
        // OLD snapshot whose tree lacks a file; we then ship a tree WITH the
        // file; deleting it returns the worktree to the marker's tree. The old
        // unconditional applied-tree baseline skipped the capture forever while
        // the shipped ref still advertised the file — the peer never learned of
        // the deletion.
        const wsid = WorkspaceProjectId.make("wp-wip-del-deadlock");
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-del-deadlock-" });
        const { workPath } = yield* initRepoWithOrigin(root);

        // Applied marker records the CURRENT (file-less) tree, as if consumed
        // from the peer long ago.
        const markerSnap = yield* captureWipSnapshot({
          cwd: workPath,
          workspaceProjectId: wsid,
          environmentId: LOCAL_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        assert.isNotNull(markerSnap);
        const appliedMarker = yield* wipAppliedMarkerRefName(wsid);
        yield* git(workPath, ["update-ref", appliedMarker, markerSnap!.commitOid]);

        // Ship a tree WITH the file.
        yield* fs.writeFileString(pathService.join(workPath, "doomed.txt"), "here\n");
        const shipped = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
        assert.strictEqual(shipped._tag, "done");

        // Delete it: the worktree now equals the marker tree, but the shipped
        // ref still advertises doomed.txt — the deletion MUST ship.
        yield* fs.remove(pathService.join(workPath, "doomed.txt"), { force: true });
        const afterDelete = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
        assert.strictEqual(afterDelete._tag, "done");
        const refName = yield* wipRefName(wsid, LOCAL_ENVIRONMENT_ID);
        const treeListing = yield* gitStdout(workPath, [
          "ls-tree",
          "--name-only",
          `${refName}^{tree}`,
        ]);
        assert.notInclude(treeListing.split("\n"), "doomed.txt");

        // And it settles: nothing changed, next pass is a no-op.
        const settle = yield* runWipPassForTarget(target(wsid, workPath), "origin-refs");
        assert.strictEqual(settle._tag, "skipped");
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
      assert.strictEqual(payload.schemaVersion, 2);
      assert.strictEqual(payload.refName, `refs/t3/wip/${wsid}/${LOCAL_ENVIRONMENT_ID}`);
      assert.strictEqual(payload.branchRef, "refs/heads/main");
      assert.strictEqual(payload.headOid, yield* gitStdout(workPath, ["rev-parse", "HEAD"]));

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

  it.effect("applies a same-second peer snapshot (M3.7 tie deadlock regression)", () =>
    Effect.gen(function* () {
      // Committer stamps are 1-second; the sub-second fast path routinely
      // lands a fresh snapshot in the SAME second as the applied marker.
      // The old `<=` staleness skip deadlocked delivery until the author's
      // tree changed again.
      const wsid = WorkspaceProjectId.make("wp-apply-tie");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-tie-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      const when = minutesFromNow(60);
      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "tie v1\n");
      yield* peerSnapshot(peerPath, wsid, when);
      const first = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(first._tag, "applied");

      // Second snapshot with the SAME committer second, different content.
      yield* fs.writeFileString(pathService.join(peerPath, "peer-note.txt"), "tie v2\n");
      const second = yield* peerSnapshot(peerPath, wsid, when);
      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "peer-note.txt")),
        "tie v2\n",
      );
      const marker = yield* resolveOid(localPath, `refs/t3/wip-applied/${wsid}`);
      assert.strictEqual(marker, second.commitOid);

      // And the guard still holds: the identical commit never re-applies.
      const again = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(again._tag, "skipped");
    }),
  );

  it.effect("blocks a legacy snapshot without branch metadata", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-legacy");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-legacy-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      const captured = yield* captureWipSnapshot({
        cwd: peerPath,
        workspaceProjectId: wsid,
        environmentId: PEER_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(captured);
      yield* git(peerPath, ["push", "origin", `+${captured!.refName}:${captured!.refName}`]);

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "blocked");
      assert.match(outcome._tag === "blocked" ? outcome.reason : "", /other machine must update/);
    }),
  );

  it.effect("does not let a clean peer echo undo a newer local branch switch", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-echo");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-echo-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      const store = yield* RoamingBlobStore;
      const localSnapshot = yield* captureWipSnapshot({
        cwd: localPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(localSnapshot);
      const pushedMarker = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      yield* git(localPath, ["update-ref", pushedMarker, localSnapshot!.commitOid]);
      yield* store.writeLocal({
        kind: "wip",
        key: `${wsid}/${LOCAL_ENVIRONMENT_ID}`,
        workspaceProjectId: wsid,
        payload: yield* encodeWipPayloadJson({
          schemaVersion: 2,
          capturedAt: minutesFromNow(30),
          ...localSnapshot!,
          bundleBase64: "",
        }),
      });
      yield* git(localPath, [
        "push",
        "origin",
        `+${localSnapshot!.refName}:${localSnapshot!.refName}`,
      ]);
      yield* git(peerPath, [
        "fetch",
        "origin",
        `+${localSnapshot!.refName}:${localSnapshot!.refName}`,
      ]);
      const peerMarker = yield* wipAppliedMarkerRefName(wsid);
      yield* git(peerPath, ["update-ref", peerMarker, localSnapshot!.commitOid]);
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      yield* git(localPath, ["switch", "-c", "feature/new-local"]);
      const outcome = yield* runWipApplyForTarget(
        target(wsid, localPath),
        localSnapshot!.commitOid,
      );
      assert.strictEqual(outcome._tag, "skipped");
      assert.strictEqual(
        yield* gitStdout(localPath, ["branch", "--show-current"]),
        "feature/new-local",
      );

      const pathService = yield* Path.Path;
      yield* fs.writeFileString(pathService.join(peerPath, "peer-main.txt"), "peer\n");
      yield* git(peerPath, ["add", "peer-main.txt"]);
      yield* git(peerPath, ["commit", "-m", "peer main moved"]);
      yield* git(peerPath, ["push", "origin", "main"]);
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(90));
      const moved = yield* runWipApplyForTarget(target(wsid, localPath), localSnapshot!.commitOid);
      assert.strictEqual(moved._tag, "blocked");
      assert.strictEqual(
        yield* gitStdout(localPath, ["branch", "--show-current"]),
        "feature/new-local",
      );
    }),
  );

  it.effect("fast-forwards a clean checkout before applying peer WIP", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-ff");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-ff-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      yield* fs.writeFileString(pathService.join(peerPath, "committed.txt"), "commit\n");
      yield* git(peerPath, ["add", "committed.txt"]);
      yield* git(peerPath, ["commit", "-m", "peer commit"]);
      yield* git(peerPath, ["push", "origin", "main"]);
      yield* fs.writeFileString(pathService.join(peerPath, "wip.txt"), "dirty\n");
      const snapshot = yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(yield* gitStdout(localPath, ["rev-parse", "HEAD"]), snapshot.headOid);
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "wip.txt")),
        "dirty\n",
      );
    }),
  );

  it.effect("blocks a fast-forward when the checkout has local edits", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-ff-dirty");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-ff-dirty-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      yield* fs.writeFileString(pathService.join(peerPath, "committed.txt"), "commit\n");
      yield* git(peerPath, ["add", "committed.txt"]);
      yield* git(peerPath, ["commit", "-m", "peer commit"]);
      yield* git(peerPath, ["push", "origin", "main"]);
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      yield* fs.writeFileString(pathService.join(localPath, "local.txt"), "mine\n");
      const headBefore = yield* gitStdout(localPath, ["rev-parse", "HEAD"]);

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "blocked");
      assert.match(outcome._tag === "blocked" ? outcome.reason : "", /local edits/);
      assert.strictEqual(yield* gitStdout(localPath, ["rev-parse", "HEAD"]), headBefore);
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "local.txt")),
        "mine\n",
      );
    }),
  );

  it.effect("switches a clean checkout to the peer branch and parks the old branch", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-switch");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-switch-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      yield* git(peerPath, ["switch", "-c", "feature/peer"]);
      yield* fs.writeFileString(pathService.join(peerPath, "branch.txt"), "committed\n");
      yield* git(peerPath, ["add", "branch.txt"]);
      yield* git(peerPath, ["commit", "-m", "branch commit"]);
      yield* fs.writeFileString(pathService.join(peerPath, "wip.txt"), "dirty\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(yield* gitStdout(localPath, ["branch", "--show-current"]), "feature/peer");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "wip.txt")),
        "dirty\n",
      );
      assert.isNotNull(yield* resolveOid(localPath, `refs/t3/wip-parked/${wsid}/main`));
      const echo = yield* runWipPassForTarget(target(wsid, localPath), "origin-refs");
      assert.strictEqual(echo._tag, "skipped");
    }),
  );

  it.effect("takeover parks local work and reproduces the peer branch", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-takeover");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-takeover-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);
      yield* git(peerPath, ["switch", "-c", "feature/peer"]);
      yield* fs.writeFileString(pathService.join(peerPath, "peer.txt"), "peer dirty\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      yield* fs.writeFileString(pathService.join(localPath, "mine.txt"), "local dirty\n");

      const blocked = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(blocked._tag, "blocked");
      const outcome = yield* runWipApplyForTarget(target(wsid, localPath), undefined, {
        takeover: true,
      });
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(yield* gitStdout(localPath, ["branch", "--show-current"]), "feature/peer");
      assert.isFalse(yield* fs.exists(pathService.join(localPath, "mine.txt")));
      assert.strictEqual(
        yield* gitStdout(localPath, ["show", `refs/t3/wip-parked/${wsid}/main:mine.txt`]),
        "local dirty",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "peer.txt")),
        "peer dirty\n",
      );

      yield* git(localPath, ["reset", "--hard"]);
      yield* git(localPath, ["clean", "-fd"]);
      yield* git(localPath, ["switch", "main"]);
      assert.isTrue(yield* restoreParkedWipForTarget(target(wsid, localPath)));
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "mine.txt")),
        "local dirty\n",
      );
    }),
  );

  it.effect("per-file: peer changes to other files apply while local edits are kept", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-perfile");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-apply-b-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "v1\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      const first = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(first._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
        "v1\n",
      );

      // THE USER'S CASE: the local checkout now has its OWN uncommitted edit
      // to a different file; the peer changes tracked.txt. Per-file merge
      // applies the peer's tracked.txt AND leaves the local edit untouched.
      yield* fs.writeFileString(pathService.join(localPath, "local-own.txt"), "mine\n");
      yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "v2\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(120));
      const second = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(second._tag, "applied");
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

  it.effect("per-file: a same-file conflict keeps the local copy and is surfaced", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-conflict");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-conflict-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // Both machines edit the SAME file differently, from the shared base.
      yield* fs.writeFileString(pathService.join(localPath, "shared.txt"), "LOCAL\n");
      yield* fs.writeFileString(pathService.join(peerPath, "shared.txt"), "PEER\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied-with-conflicts");
      assert.deepEqual(outcome._tag === "applied-with-conflicts" ? [...outcome.conflicts] : [], [
        "shared.txt",
      ]);
      // The local copy is never overwritten by the peer's version.
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "shared.txt")),
        "LOCAL\n",
      );
    }),
  );

  it.effect("per-file: a peer deletion of an untouched file applies", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-del");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-del-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // A committed file both sides share; the peer deletes it.
      yield* fs.writeFileString(pathService.join(peerPath, "shared.txt"), "keep\n");
      yield* git(peerPath, ["add", "shared.txt"]);
      yield* git(peerPath, ["commit", "-m", "add shared"]);
      yield* git(peerPath, ["push", "origin", "main"]);
      yield* git(localPath, ["pull", "origin", "main"]);
      assert.isTrue(yield* fs.exists(pathService.join(localPath, "shared.txt")));

      yield* fs.remove(pathService.join(peerPath, "shared.txt"), { force: true });
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.isFalse(yield* fs.exists(pathService.join(localPath, "shared.txt")));
    }),
  );

  it.effect("per-file: a peer-added file never clobbers a local dir at that path", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-collide-dir");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-collide-dir-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // Peer adds a regular FILE `foo`. Locally, `foo` is an untracked DIRECTORY
      // full of unsaved work. hash-object of a dir returns null (looks "absent"),
      // so a naive apply would `git restore` the file straight over it.
      yield* fs.writeFileString(pathService.join(peerPath, "foo"), "peer file\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      yield* fs.makeDirectory(pathService.join(localPath, "foo"), { recursive: true });
      yield* fs.writeFileString(
        pathService.join(localPath, "foo", "work.txt"),
        "PRECIOUS UNSAVED WORK\n",
      );

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied-with-conflicts");
      assert.deepEqual(outcome._tag === "applied-with-conflicts" ? [...outcome.conflicts] : [], [
        "foo",
      ]);
      // The local directory and its unsaved work survive intact.
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "foo", "work.txt")),
        "PRECIOUS UNSAVED WORK\n",
      );
    }),
  );

  it.effect("per-file: a peer-added nested path never clobbers a local file at a parent", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-collide-file");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-collide-file-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // Peer adds nested path `x/a`. Locally `x` is an untracked FILE of unsaved
      // work. hash-object of `x/a` returns null (x isn't a dir), so a naive apply
      // would replace the local file `x` with a directory.
      yield* fs.makeDirectory(pathService.join(peerPath, "x"), { recursive: true });
      yield* fs.writeFileString(pathService.join(peerPath, "x", "a"), "peer nested\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
      yield* fs.writeFileString(pathService.join(localPath, "x"), "PRECIOUS LOCAL FILE\n");

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied-with-conflicts");
      assert.deepEqual(outcome._tag === "applied-with-conflicts" ? [...outcome.conflicts] : [], [
        "x/a",
      ]);
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "x")),
        "PRECIOUS LOCAL FILE\n",
      );
    }),
  );

  it.effect("per-file: deleting a locally-created file is not re-added by the peer's copy", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-del-origin");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-del-origin-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // Desktop (local) CREATES F and ships it: its pushed marker records F,
      // but its APPLIED marker never does (F is local-origin, never applied
      // from a peer). This asymmetry is what made the delete flap.
      yield* fs.writeFileString(pathService.join(localPath, "F.txt"), "hello\n");
      const localSnap = yield* captureWipSnapshot({
        cwd: localPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(localSnap);
      const pushedMarker = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      yield* git(localPath, ["update-ref", pushedMarker, localSnap!.commitOid]);

      // Laptop (peer) has F too and snapshots with it.
      yield* fs.writeFileString(pathService.join(peerPath, "F.txt"), "hello\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      // Desktop deletes F. The peer's snapshot still carries F, but WE deleted
      // it — it must NOT be resurrected.
      yield* fs.remove(pathService.join(localPath, "F.txt"), { force: true });
      yield* runWipApplyForTarget(target(wsid, localPath));
      assert.isFalse(yield* fs.exists(pathService.join(localPath, "F.txt")));
    }),
  );

  it.effect(
    "per-file: a conflict on one path does not unrecord files applied in the same pass",
    () =>
      Effect.gen(function* () {
        const wsid = WorkspaceProjectId.make("wp-apply-pin-marker");
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-pin-marker-" });
        const { peerPath, localPath } = yield* initApplyFixture(root);

        // One snapshot carries BOTH a genuine conflict (tracked.txt modified on
        // both sides) and a brand-new file F.
        yield* fs.writeFileString(pathService.join(peerPath, "tracked.txt"), "peer edit\n");
        yield* fs.writeFileString(pathService.join(peerPath, "F.txt"), "from peer\n");
        yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));
        yield* fs.writeFileString(pathService.join(localPath, "tracked.txt"), "local edit\n");

        const first = yield* runWipApplyForTarget(target(wsid, localPath));
        assert.strictEqual(first._tag, "applied-with-conflicts");
        assert.deepEqual(first._tag === "applied-with-conflicts" ? [...first.conflicts] : [], [
          "tracked.txt",
        ]);
        assert.strictEqual(
          yield* fs.readFileString(pathService.join(localPath, "F.txt")),
          "from peer\n",
        );

        // The user deletes the just-arrived F. The SAME peer snapshot still
        // carries F; before the pinned marker, the conflict had held the whole
        // applied marker back, so F's arrival was never recorded — this delete
        // read null==null "untouched" and F resurrected from the peer's copy
        // (field bug 2026-07-10).
        yield* fs.remove(pathService.join(localPath, "F.txt"), { force: true });
        const second = yield* runWipApplyForTarget(target(wsid, localPath));
        assert.isFalse(yield* fs.exists(pathService.join(localPath, "F.txt")));
        // The genuine conflict keeps surfacing (Waiting stays honest) and our
        // side of it is kept.
        assert.strictEqual(second._tag, "applied-with-conflicts");
        assert.strictEqual(
          yield* fs.readFileString(pathService.join(localPath, "tracked.txt")),
          "local edit\n",
        );
      }),
  );

  it.effect("per-file: a peer's deletion of a file THIS machine authored propagates", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-del-received");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-del-received-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // LOCAL authors F and ships it. Its applied marker stays empty (its own
      // echoes are tree-equal no-ops), so the peer's later deletion is only
      // visible against this shipped snapshot.
      yield* fs.writeFileString(pathService.join(localPath, "F.txt"), "hello\n");
      const localSnap = yield* captureWipSnapshot({
        cwd: localPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(localSnap);
      const pushedMarker = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      yield* git(localPath, ["update-ref", pushedMarker, localSnap!.commitOid]);
      yield* git(localPath, ["push", "origin", `+${localSnap!.refName}:${localSnap!.refName}`]);

      // PEER received F: file on disk, applied marker at local's snapshot —
      // so its next capture records T3-Based-On = a state that contains F.
      yield* git(peerPath, ["fetch", "origin", `+${localSnap!.refName}:${localSnap!.refName}`]);
      yield* fs.writeFileString(pathService.join(peerPath, "F.txt"), "hello\n");
      const appliedMarker = yield* wipAppliedMarkerRefName(wsid);
      yield* git(peerPath, ["update-ref", appliedMarker, localSnap!.commitOid]);

      // Peer deletes F (the user's field case: delete on the machine that
      // RECEIVED the file) and snapshots.
      yield* fs.remove(pathService.join(peerPath, "F.txt"), { force: true });
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.isFalse(yield* fs.exists(pathService.join(localPath, "F.txt")));
    }),
  );

  it.effect("per-file: a peer snapshot that merely predates a local file never deletes it", () =>
    Effect.gen(function* () {
      const wsid = WorkspaceProjectId.make("wp-apply-ignorant-peer");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wip-ignorant-" });
      const { peerPath, localPath } = yield* initApplyFixture(root);

      // Local authors and ships F. The peer has NEVER seen F (its snapshot
      // carries no Based-On state containing it) — its snapshot lacking F is
      // ignorance, not a deletion (the 92b641b4 destructive-delete flap).
      yield* fs.writeFileString(pathService.join(localPath, "F.txt"), "precious\n");
      const localSnap = yield* captureWipSnapshot({
        cwd: localPath,
        workspaceProjectId: wsid,
        environmentId: LOCAL_ENVIRONMENT_ID,
        vaultExcludePaths: [],
      });
      assert.isNotNull(localSnap);
      const pushedMarker = yield* wipPushedMarkerRefName(wsid, LOCAL_ENVIRONMENT_ID);
      yield* git(localPath, ["update-ref", pushedMarker, localSnap!.commitOid]);

      yield* fs.writeFileString(pathService.join(peerPath, "unrelated.txt"), "peer work\n");
      yield* peerSnapshot(peerPath, wsid, minutesFromNow(60));

      const outcome = yield* runWipApplyForTarget(target(wsid, localPath));
      assert.strictEqual(outcome._tag, "applied");
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "F.txt")),
        "precious\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(localPath, "unrelated.txt")),
        "peer work\n",
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
});
