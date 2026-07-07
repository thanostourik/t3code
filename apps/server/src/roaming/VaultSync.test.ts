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
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
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
      vaultOverrides: {
        include: [...(input.include ?? [])],
        exclude: [...(input.exclude ?? [])],
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
      // Field bug 2026-07-07: an unanchored project pattern must NOT reach
      // into dependency trees — the global file's `!node_modules/**`
      // exclusion is subtracted after the include pass, so it wins.
      yield* fs.makeDirectory(pathService.join(workspaceRoot, "node_modules", "pkg", ".idea"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        pathService.join(workspaceRoot, "node_modules", "pkg", ".idea", "junk.xml"),
        "junk\n",
      );
      // gitignore syntax, per project, in the repo root — like .gitignore.
      // Unanchored ".idea" (the obvious thing to write) matches any depth.
      yield* fs.writeFileString(pathService.join(workspaceRoot, ".t3sync"), ".idea\n");
      yield* writeRegistry({ workspaceProjectId, workspaceRoot });

      const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
      assert.equal(result.status, "written");

      const bundle = yield* readVaultBundle(workspaceProjectId);
      const paths = bundle.files.map((file) => file.path);
      assert.include(paths, ".idea/workspace.xml");
      // Gitignored content NOT listed in .t3sync stays local.
      assert.notInclude(paths, ".cache/junk.bin");
      // The denylist beats the user's unanchored pattern in node_modules.
      assert.notInclude(paths, "node_modules/pkg/.idea/junk.xml");
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
          kind: remote.kind,
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
