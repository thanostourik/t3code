import * as NodeCrypto from "node:crypto";

import {
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

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore, layer as roamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { applyVaultBundle, captureVaultForProject } from "./VaultSync.ts";

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
  it.effect(
    "captures untracked default matches and include paths while excluding tracked and excluded files",
    () =>
      Effect.gen(function* () {
        const workspaceProjectId = WorkspaceProjectId.make("wp-vault-capture");
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-capture-" });
        yield* initGit(workspaceRoot);
        yield* fs.writeFileString(pathService.join(workspaceRoot, ".env"), "SECRET=one\n");
        yield* fs.writeFileString(
          pathService.join(workspaceRoot, ".env.production"),
          "SECRET=prod\n",
        );
        yield* fs.writeFileString(
          pathService.join(workspaceRoot, ".env.example"),
          "SECRET=example\n",
        );
        yield* fs.writeFileString(pathService.join(workspaceRoot, "app.local.json"), "{}\n");
        yield* fs.makeDirectory(pathService.join(workspaceRoot, "nested"), { recursive: true });
        yield* fs.writeFileString(
          pathService.join(workspaceRoot, "nested", "secret.txt"),
          "nested\n",
        );
        yield* git(workspaceRoot, ["add", ".env.example"]);
        yield* writeRegistry({
          workspaceProjectId,
          workspaceRoot,
          include: ["nested/secret.txt"],
          exclude: [".env.production"],
        });

        const result = yield* captureVaultForProject({ workspaceProjectId, workspaceRoot });
        assert.equal(result.status, "written");

        const bundle = yield* readVaultBundle(workspaceProjectId);
        assert.deepEqual(bundle.files.map((file) => file.path).sort(), [
          ".env",
          "app.local.json",
          "nested/secret.txt",
        ]);
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
      yield* fs.symlink(pathService.join(outside, "target"), pathService.join(workspaceRoot, ".env"));
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
