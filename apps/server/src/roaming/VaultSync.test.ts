import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_VAULT_PATTERNS,
  EnvironmentId,
  ROAMING_VAULT_BUNDLE_MAX_BYTES,
  RoamingBlobRecord,
  RoamingRegistryPayload,
  RoamingVaultBundle,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { applyVaultBundle, captureVaultForProject, deliverVaultBundle } from "./VaultSync.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("env-remote");
const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-vault");

const decodeVaultBundleJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingVaultBundle));
const encodeRegistryPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);
const decodeRoamingBlobRecord = Schema.decodeUnknownSync(RoamingBlobRecord);

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in VaultSync tests"),
});

const supportLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-vault-sync-test-" }),
  serverEnvironmentStub,
  SqlitePersistenceMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

const testLayer = it.layer(
  Layer.mergeAll(roamingBlobStoreLayer, GitVcsDriverLayer).pipe(Layer.provideMerge(supportLayer)),
);

const git = (cwd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver;
    yield* driver.execute({
      operation: "VaultSync.test.git",
      cwd,
      args,
    });
  });

const initGit = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "vault@example.test"]);
    yield* git(cwd, ["config", "user.name", "Vault Test"]);
  });

const writeRegistry = (input: {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const store = yield* RoamingBlobStore;
    const payload = yield* encodeRegistryPayloadJson({
      workspaceProjectId: input.workspaceProjectId,
      title: "Vault project",
      repository: {
        canonicalKey: "git:https://example.test/repo.git",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://example.test/repo.git",
        },
      },
      perMachineRoots: { [LOCAL_ENVIRONMENT_ID]: input.workspaceRoot },
    });
    yield* store.writeLocal({
      kind: "registry",
      key: input.workspaceProjectId,
      workspaceProjectId: input.workspaceProjectId,
      payload,
    });
  });

const readVaultBundle = (workspaceProjectId: WorkspaceProjectId) =>
  Effect.gen(function* () {
    const store = yield* RoamingBlobStore;
    const record = yield* store.get({ kind: "vault", key: workspaceProjectId });
    assert.ok(record);
    return yield* decodeVaultBundleJson(record.payload);
  });

const remoteRecord = (input: {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
}): RoamingBlobRecord => {
  return decodeRoamingBlobRecord({
    schemaVersion: 1,
    kind: "vault",
    key: input.key,
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    version: input.version,
    contentHash: NodeCrypto.createHash("sha256").update(input.payload, "utf8").digest("hex"),
    authorEnvironmentId: REMOTE_ENVIRONMENT_ID,
    updatedAt: "2026-07-05T00:00:00.000Z",
    payload: input.payload,
  });
};

testLayer("VaultSync", (it) => {
  it.effect("global t3sync holds the defaults; a project .t3sync extends and vetoes them", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-capture");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-capture-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".env"), "SECRET=one\n");
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, ".env.example"),
        "SECRET=example\n",
      );
      yield* fs.writeFileString(pathService.join(workspaceRoot, "app.local.json"), "{}\n");
      // gitignore semantics reach into subdirectories (M3.5).
      yield* fs.makeDirectory(pathService.join(workspaceRoot, "packages", "api"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, "packages", "api", ".env"),
        "SECRET=nested\n",
      );
      // ...but dependency trees full of throwaway certs stay out.
      yield* fs.makeDirectory(pathService.join(workspaceRoot, "node_modules", "pkg"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, "node_modules", "pkg", "test-cert.pem"),
        "FIXTURE\n",
      );
      yield* git(workspaceRoot, ["add", ".env.example"]);
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "written");

      // The defaults were written once into the GLOBAL file (the app's
      // state dir — repos are never touched), visible and editable.
      const globalPath = pathService.join(config.stateDir, "t3sync");
      const globalContent = yield* fs.readFileString(globalPath);
      for (const pattern of DEFAULT_VAULT_PATTERNS) {
        assert.include(globalContent, pattern);
      }
      assert.isFalse(yield* fs.exists(pathService.join(workspaceRoot, ".t3sync")));

      const bundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(bundle.files.map((file) => file.path).sort(), [
        ".env",
        "app.local.json",
        "packages/api/.env",
      ]);

      // A project .t3sync vetoes a global line with gitignore negation.
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".t3sync"), "!.env\n");
      const vetoed = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(vetoed.status, "written");
      const vetoedBundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(
        vetoedBundle.files.map((file) => file.path),
        ["app.local.json"],
      );

      // Deleting a line from the GLOBAL file stops syncing it everywhere:
      // drop *.local.* — app.local.json leaves the bundle, .env returns.
      yield* fs.remove(pathService.join(workspaceRoot, ".t3sync"), { force: true });
      yield* fs.writeFileString(globalPath, ".env\n");
      const trimmed = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(trimmed.status, "written");
      const trimmedBundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(trimmedBundle.files.map((file) => file.path).sort(), [
        ".env",
        "packages/api/.env",
      ]);

      // The suite shares one config dir: put the global defaults back for
      // the tests that follow.
      yield* fs.writeFileString(globalPath, globalContent);
    }),
  );

  it.effect(".t3sync carries gitignored trees like .idea/ over the vault channel", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-t3sync");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-t3sync-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".gitignore"), ".idea/\n.cache/\n");
      yield* git(workspaceRoot, ["add", ".gitignore"]);
      yield* git(workspaceRoot, ["commit", "-m", "ignore rules"]);

      yield* fs.makeDirectory(pathService.join(workspaceRoot, ".idea"), { recursive: true });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, ".idea", "workspace.xml"),
        "<project/>\n",
      );
      yield* fs.makeDirectory(pathService.join(workspaceRoot, ".cache"), { recursive: true });
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".cache", "junk.bin"), "junk\n");
      yield* fs.makeDirectory(pathService.join(workspaceRoot, "node_modules", "pkg", ".idea"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, "node_modules", "pkg", ".idea", "junk.xml"),
        "junk\n",
      );
      // Pure .gitignore: a project line is read AFTER the global file, so it
      // overrides the global `!node_modules/**`. `/.idea` scopes to the repo
      // root (the gitignore way to avoid the node_modules copy); a bare
      // `.idea` would match at any depth, exactly like .gitignore.
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".t3sync"), "/.idea\n");
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "written");

      const bundle = yield* readVaultBundle(workspaceProjectId);
      const paths = bundle.files.map((file) => file.path);
      assert.include(paths, ".idea/workspace.xml");
      // Gitignored content NOT listed in .t3sync stays local.
      assert.notInclude(paths, ".cache/junk.bin");
      // Root-anchored `/.idea` does not reach into node_modules.
      assert.notInclude(paths, "node_modules/pkg/.idea/junk.xml");
    }),
  );

  it.effect("pure gitignore: a project line overrides a global `!` exclusion", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-override");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-override-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".gitignore"), "node_modules/\n");
      yield* git(workspaceRoot, ["add", ".gitignore"]);
      yield* git(workspaceRoot, ["commit", "-m", "ignore node_modules"]);
      // A tool config the user genuinely wants synced, living under a tree
      // the global file excludes by default.
      yield* fs.makeDirectory(pathService.join(workspaceRoot, "node_modules", "tool"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, "node_modules", "tool", "config.json"),
        "{}\n",
      );
      // The project re-includes it — read after the global `!node_modules`,
      // so it wins. Per-project override works, no special-casing.
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, ".t3sync"),
        "node_modules/tool/config.json\n",
      );
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "written");
      const paths = (yield* readVaultBundle(workspaceProjectId)).files.map((file) => file.path);
      assert.include(paths, "node_modules/tool/config.json");
    }),
  );

  it.effect("delivery writes, updates untouched files, never overwrites local edits", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-deliver");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-deliver-" });

      const bundleOf = (files: ReadonlyArray<readonly [string, string]>) => ({
        schemaVersion: 1,
        capturedAt: "2026-07-07T00:00:00.000Z",
        tombstones: [],
        files: files.map(([path, content]) => ({
          path,
          sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
          contentBase64: Buffer.from(content).toString("base64"),
        })),
      });

      // Arrival on a checkout that never had the files: both are written.
      const first = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot,
        bundle: bundleOf([
          [".env", "SECRET=v1\n"],
          [".idea/workspace.xml", "<project v='1'/>\n"],
        ]),
      });
      assert.deepEqual(first.written.sort(), [".env", ".idea/workspace.xml"]);
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(workspaceRoot, ".env")),
        "SECRET=v1\n",
      );

      // The user edits .env locally; .idea stays as delivered.
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".env"), "SECRET=mine\n");

      const second = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot,
        bundle: bundleOf([
          [".env", "SECRET=v2\n"],
          [".idea/workspace.xml", "<project v='2'/>\n"],
        ]),
      });
      // Untouched-since-apply file updates; the local edit is never clobbered.
      assert.deepEqual(second.written, [".idea/workspace.xml"]);
      assert.deepEqual(second.skipped, [".env"]);
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(workspaceRoot, ".env")),
        "SECRET=mine\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(pathService.join(workspaceRoot, ".idea", "workspace.xml")),
        "<project v='2'/>\n",
      );
    }),
  );

  it.effect("never captures a matched symlink's target", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-symlink");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-symlink-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-outside-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFileString(pathService.join(outside, "target"), "OUTSIDE=1\n");
      yield* fs.symlink(
        pathService.join(outside, "target"),
        pathService.join(workspaceRoot, ".env"),
      );
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".env.local"), "SECRET=real\n");

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "written");
      const bundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(
        bundle.files.map((file) => file.path),
        [".env.local"],
      );
    }),
  );

  it.effect("refuses to apply through a symlinked directory or onto a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-apply-link-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-apply-out-" });
      yield* fs.symlink(outside, pathService.join(workspaceRoot, "link"));
      const entry = (path: string) => ({
        schemaVersion: 1 as const,
        capturedAt: "2026-07-05T00:00:00.000Z",
        tombstones: [],
        files: [
          {
            path,
            sha256: NodeCrypto.createHash("sha256").update("x\n").digest("hex"),
            contentBase64: Buffer.from("x\n").toString("base64"),
          },
        ],
      });

      const throughDir = yield* applyVaultBundle({
        workspaceRoot,
        overwrite: true,
        bundle: entry("link/escape"),
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(throughDir));

      const ontoLink = yield* applyVaultBundle({
        workspaceRoot,
        overwrite: true,
        bundle: entry("link"),
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(ontoLink));
      assert.equal(yield* fs.exists(pathService.join(outside, "escape")), false);
    }),
  );

  it.effect("skips oversize captures", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-oversize");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const store = yield* RoamingBlobStore;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-oversize-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFile(
        pathService.join(workspaceRoot, ".env"),
        Buffer.alloc(ROAMING_VAULT_BUNDLE_MAX_BYTES + 1),
      );

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "oversize");
      assert.equal(yield* store.get({ kind: "vault", key: workspaceProjectId }), null);
    }),
  );

  it.effect("capture tombstones a deleted file; delivery removes the untouched copy (G4)", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-tombstone");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-ts-a-" });
      const deliveryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-ts-b-" });
      yield* initGit(workspaceRoot);
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".env"), "SECRET=doomed\n");

      const first = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(first.status, "written");
      const firstBundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(
        firstBundle.files.map((file) => file.path),
        [".env"],
      );
      assert.deepEqual(firstBundle.tombstones, []);

      // Deliver v1 to the second machine's checkout, then delete at source.
      const delivered = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot: deliveryRoot,
        bundle: firstBundle,
      });
      assert.deepEqual(delivered.written, [".env"]);

      yield* fs.remove(pathService.join(workspaceRoot, ".env"));
      const second = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(second.status, "written");
      const secondBundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(secondBundle.files, []);
      assert.deepEqual(
        secondBundle.tombstones.map((tombstone) => tombstone.path),
        [".env"],
      );

      // The untouched delivered copy is removed — into the holding dir, not
      // unlinked — and the applied record forgets the path.
      const applied = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot: deliveryRoot,
        bundle: secondBundle,
      });
      assert.deepEqual(applied.deleted, [".env"]);
      assert.isFalse(yield* fs.exists(pathService.join(deliveryRoot, ".env")));
      assert.ok(applied.trashDir);
      const trashed = yield* fs.readFileString(pathService.join(applied.trashDir!, ".env"));
      assert.equal(trashed, "SECRET=doomed\n");
      assert.isTrue(applied.trashDir!.startsWith(pathService.join(config.stateDir, "vault-trash")));

      // Idempotent: re-delivering the same tombstone is a no-op.
      const again = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot: deliveryRoot,
        bundle: secondBundle,
      });
      assert.deepEqual(again.deleted, []);
      assert.deepEqual(again.skipped, []);
    }),
  );

  it.effect("a locally edited copy survives a tombstone (G4)", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-ts-edited");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const deliveryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-ts-edit-" });
      const content = "SECRET=v1\n";
      const bundle = {
        schemaVersion: 1,
        capturedAt: "2026-07-07T00:00:00.000Z",
        tombstones: [],
        files: [
          {
            path: ".env",
            sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
            contentBase64: Buffer.from(content).toString("base64"),
          },
        ],
      };
      yield* deliverVaultBundle({ workspaceProjectId, workspaceRoot: deliveryRoot, bundle });
      yield* fs.writeFileString(pathService.join(deliveryRoot, ".env"), "SECRET=edited\n");

      const result = yield* deliverVaultBundle({
        workspaceProjectId,
        workspaceRoot: deliveryRoot,
        bundle: {
          ...bundle,
          files: [],
          tombstones: [{ path: ".env", deletedAt: "2026-07-08T00:00:00.000Z" }],
        },
      });
      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.skipped, [".env"]);
      assert.equal(
        yield* fs.readFileString(pathService.join(deliveryRoot, ".env")),
        "SECRET=edited\n",
      );
    }),
  );

  it.effect("a tombstoned file stays dead until re-created, then lives again (G4)", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-ts-revive");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-ts-rev-" });
      yield* initGit(workspaceRoot);
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });
      const envPath = pathService.join(workspaceRoot, ".env");
      yield* fs.writeFileString(envPath, "SECRET=one\n");
      yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      yield* fs.remove(envPath);
      yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      const tombstoned = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(
        tombstoned.tombstones.map((tombstone) => tombstone.path),
        [".env"],
      );
      const deletedAtMs = Date.parse(tombstoned.tombstones[0]!.deletedAt);

      // A stale copy (mtime at/before deletedAt — e.g. this machine simply
      // has not applied the deletion yet) must NOT resurrect the file.
      yield* fs.writeFileString(envPath, "SECRET=stale\n");
      const staleStamp = DateTime.toDate(DateTime.makeUnsafe(deletedAtMs - 1000));
      yield* fs.utimes(envPath, staleStamp, staleStamp);
      const stale = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(stale.status, "unchanged");

      // A genuine re-creation (newer mtime) revives it and drops the tombstone.
      const revivedStamp = DateTime.toDate(DateTime.makeUnsafe(deletedAtMs + 60_000));
      yield* fs.utimes(envPath, revivedStamp, revivedStamp);
      const revived = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(revived.status, "written");
      const revivedBundle = yield* readVaultBundle(workspaceProjectId);
      assert.deepEqual(
        revivedBundle.files.map((file) => file.path),
        [".env"],
      );
      assert.deepEqual(revivedBundle.tombstones, []);
    }),
  );

  it.effect("does not churn the vault blob when only capturedAt would change", () =>
    Effect.gen(function* () {
      const workspaceProjectId = WorkspaceProjectId.make("wp-vault-no-churn");
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const store = yield* RoamingBlobStore;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-no-churn-" });
      yield* initGit(workspaceRoot);
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".env"), "SECRET=stable\n");

      const first = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      const second = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      const record = yield* store.get({ kind: "vault", key: workspaceProjectId });

      assert.equal(first.status, "written");
      assert.equal(second.status, "unchanged");
      assert.equal(record?.version, 1);
    }),
  );

  it.effect("applies vault bundles with skip-vs-overwrite behavior", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-apply-" });
      const targetPath = pathService.join(workspaceRoot, "nested", ".env");
      yield* fs.makeDirectory(pathService.dirname(targetPath), { recursive: true });
      yield* fs.writeFileString(targetPath, "old\n");
      const bundle: RoamingVaultBundle = {
        schemaVersion: 1,
        capturedAt: "2026-07-05T00:00:00.000Z",
        tombstones: [],
        files: [
          {
            path: "nested/.env",
            mode: 0o600,
            sha256: NodeCrypto.createHash("sha256").update("new\n").digest("hex"),
            contentBase64: Buffer.from("new\n").toString("base64"),
          },
        ],
      };

      const skipped = yield* applyVaultBundle({ workspaceRoot, bundle, overwrite: false });
      assert.deepEqual(skipped, { applied: [], skipped: ["nested/.env"] });
      assert.equal(yield* fs.readFileString(targetPath), "old\n");

      const applied = yield* applyVaultBundle({ workspaceRoot, bundle, overwrite: true });
      assert.deepEqual(applied, { applied: ["nested/.env"], skipped: [] });
      assert.equal(yield* fs.readFileString(targetPath), "new\n");
    }),
  );

  it.effect("rejects vault entries that escape the workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-escape-" });
      const result = yield* applyVaultBundle({
        workspaceRoot,
        overwrite: true,
        bundle: {
          schemaVersion: 1,
          capturedAt: "2026-07-05T00:00:00.000Z",
          tombstones: [],
          files: [
            {
              path: "../outside",
              sha256: "00",
              contentBase64: "",
            },
          ],
        },
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "VaultPathEscapeError");
      }
    }),
  );

  it.effect(
    "resolving a conflict through writeLocal supersedes both sides and clears the conflict",
    () =>
      Effect.gen(function* () {
        const store = yield* RoamingBlobStore;
        const local = yield* store.writeLocal({
          kind: "vault",
          key: "wp-conflict",
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          payload: '{"side":"local"}',
        });
        const remote = remoteRecord({
          key: "wp-conflict",
          version: local.version,
          payload: '{"side":"remote"}',
        });
        assert.equal(yield* store.applyRemote(remote), "conflict");

        const resolved = yield* store.writeLocal({
          kind: "vault",
          key: remote.key,
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          payload: remote.payload,
        });

        assert.equal(resolved.version, local.version + 1);
        assert.equal(resolved.payload, remote.payload);
        assert.deepEqual(yield* store.listConflicts(), []);
      }),
  );
});
