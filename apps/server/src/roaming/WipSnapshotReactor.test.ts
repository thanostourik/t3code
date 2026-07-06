import * as NodeCrypto from "node:crypto";

import { EnvironmentId, RoamingWipPayload, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { runWipPassForTarget, type WipTarget } from "./WipSnapshotReactor.ts";
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
  Layer.mergeAll(roamingBlobStoreLayer, GitVcsDriverLayer).pipe(Layer.provideMerge(supportLayer)),
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
  yield* git(originPath, ["init", "--bare"]);
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
});
