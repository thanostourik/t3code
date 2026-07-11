import {
  EnvironmentId,
  type OrchestrationCommand,
  RoamingRegistryPayload,
  RoamingWipPayload,
  SourceControlRepositoryError,
  VcsProcessExitError,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import * as GitVcsDriverModule from "../vcs/GitVcsDriver.ts";
import { Materializer, layer as MaterializerLayer } from "./Materializer.ts";
import { captureWipSnapshot, type CaptureWipResult } from "./WipSnapshots.ts";
import { PeerMirror } from "./PeerMirror.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { RoamingBlobStore, layer as RoamingBlobStoreLayer } from "./RoamingBlobStore.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-materializer");
const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-materializer");
const REMOTE_URL = "https://example.test/owner/materializer.git";

const encodeRegistryPayload = Schema.encodeEffect(Schema.fromJsonString(RoamingRegistryPayload));
const encodeWipPayload = Schema.encodeEffect(Schema.fromJsonString(RoamingWipPayload));

const peerMirrorStub = Layer.succeed(PeerMirror, {
  start: () => Effect.void,
  syncNow: () => Effect.void,
  syncNowAndWait: () => Effect.void,
} satisfies PeerMirror["Service"]);

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in Materializer tests"),
});

const writeRegistry = (input: {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly perMachineRoots?: RoamingRegistryPayload["perMachineRoots"];
}) =>
  Effect.gen(function* () {
    const store = yield* RoamingBlobStore;
    const payload = yield* encodeRegistryPayload({
      workspaceProjectId: input.workspaceProjectId,
      title: "Materializer Project",
      repository: {
        canonicalKey: "git:https://example.test/owner/materializer.git",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: REMOTE_URL,
        },
        name: "materializer",
      },
      vaultOverrides: { include: [], exclude: [] },
      perMachineRoots: input.perMachineRoots ?? {},
    });
    yield* store.writeLocal({
      kind: "registry",
      key: input.workspaceProjectId,
      workspaceProjectId: input.workspaceProjectId,
      payload,
    });
  });

const makeProjectRepositoryLayer = (rows: Ref.Ref<ReadonlyArray<ProjectionProject>>) =>
  Layer.succeed(ProjectionProjectRepository, {
    upsert: (row) =>
      Ref.update(rows, (current) => [
        ...current.filter((candidate) => candidate.projectId !== row.projectId),
        row,
      ]),
    getById: ({ projectId }) =>
      Ref.get(rows).pipe(
        Effect.map((current) => {
          const row = current.find((candidate) => candidate.projectId === projectId);
          return row === undefined ? Option.none() : Option.some(row);
        }),
      ),
    listAll: () => Ref.get(rows),
    deleteById: ({ projectId }) =>
      Ref.update(rows, (current) =>
        current.filter((candidate) => candidate.projectId !== projectId),
      ),
  } satisfies ProjectionProjectRepository["Service"]);

const makeEngineLayer = (
  dispatches: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  rows: Ref.Ref<ReadonlyArray<ProjectionProject>>,
) =>
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* Ref.update(dispatches, (calls) => [...calls, command]);
        if (command.type === "project.create") {
          yield* Ref.update(rows, (current) => [
            ...current,
            {
              projectId: command.projectId,
              title: command.title,
              workspaceRoot: command.workspaceRoot,
              workspaceProjectId: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              deletedAt: null,
            },
          ]);
        }
        if (command.type === "project.roaming.enroll") {
          yield* Ref.update(rows, (current) =>
            current.map((row) =>
              row.projectId === command.projectId
                ? {
                    ...row,
                    workspaceProjectId: command.workspaceProjectId,
                    updatedAt: command.createdAt,
                  }
                : row,
            ),
          );
        }
        return { sequence: 1 };
      }),
  } satisfies OrchestrationEngineService["Service"]);

const makeLayer = (input: {
  readonly cloneFailures?: number;
  readonly dispatches: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly cloneAttempts: Ref.Ref<number>;
  readonly projectRows: Ref.Ref<ReadonlyArray<ProjectionProject>>;
}) =>
  Layer.empty
    .pipe(
      Layer.provideMerge(MaterializerLayer),
      Layer.provideMerge(RoamingBlobStoreLayer),
      Layer.provideMerge(makeProjectRepositoryLayer(input.projectRows)),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          roaming: true,
          addProjectBaseDirectory: "/tmp",
        }),
      ),
      Layer.provideMerge(serverEnvironmentStub),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mat-test-" })),
      Layer.provideMerge(
        Layer.mock(VcsDriver)({
          capabilities: {
            kind: "git",
            supportsWorktrees: true,
            supportsBookmarks: false,
            supportsAtomicSnapshot: false,
            supportsPushDefaultRemote: true,
            ignoreClassifier: "native",
          },
          // restore-wip probes the clone (status/fetch/for-each-ref); empty
          // successful output means "clean tree, no WIP refs" for flow tests.
          execute: () =>
            Effect.succeed({
              exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          detectRepository: () => Effect.die("unused"),
          isInsideWorkTree: () => Effect.die("unused"),
          listWorkspaceFiles: () => Effect.die("unused"),
          // A path holding a (mock) clone reports the registry remote, so the
          // existing-clone check behaves like the real driver would.
          listRemotes: (cwd) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const isClone = yield* fs
                .exists(path.join(cwd, ".git"))
                .pipe(Effect.orElseSucceed(() => false));
              if (!isClone) {
                return yield* new VcsProcessExitError({
                  operation: "Materializer.test.listRemotes",
                  command: "git remote -v",
                  cwd,
                  exitCode: 1,
                  detail: "not a git repo",
                });
              }
              const observedAt = yield* DateTime.now;
              return {
                remotes: [
                  {
                    name: "origin",
                    url: REMOTE_URL,
                    pushUrl: Option.none<string>(),
                    isPrimary: true,
                  },
                ],
                freshness: {
                  source: "live-local" as const,
                  observedAt,
                  expiresAt: Option.none<DateTime.Utc>(),
                },
              };
            }).pipe(Effect.provide(NodeServices.layer)),
          filterIgnoredPaths: () => Effect.die("unused"),
          initRepository: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(
        Layer.effect(
          SourceControlRepositoryService,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            return SourceControlRepositoryService.of({
              lookupRepository: () => Effect.die("unused"),
              publishRepository: () => Effect.die("unused"),
              cloneRepository: ({ destinationPath, remoteUrl }) =>
                Effect.gen(function* () {
                  const attempt = yield* Ref.updateAndGet(
                    input.cloneAttempts,
                    (count) => count + 1,
                  );
                  if (attempt <= (input.cloneFailures ?? 0)) {
                    return yield* new SourceControlRepositoryError({
                      operation: "cloneRepository",
                      provider: "unknown",
                      detail: "clone failed once",
                    });
                  }
                  yield* fs
                    .makeDirectory(path.join(destinationPath, ".git"), { recursive: true })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new SourceControlRepositoryError({
                            operation: "cloneRepository",
                            provider: "unknown",
                            detail: "failed to create mock clone",
                            cause,
                          }),
                      ),
                    );
                  return { cwd: destinationPath, remoteUrl: remoteUrl ?? "", repository: null };
                }),
            } satisfies SourceControlRepositoryService["Service"]);
          }),
        ),
      ),
      Layer.provideMerge(makeEngineLayer(input.dispatches, input.projectRows)),
      Layer.provideMerge(peerMirrorStub),
      Layer.provideMerge(VcsProcess.layer),
    )
    .pipe(Layer.provideMerge(NodeServices.layer));

it.effect("Materializer resumes a failed clone without resolving a new target path", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cloneAttempts = yield* Ref.make(0);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstTarget = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-a-" }),
          "repo",
        );
        const secondTarget = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-b-" }),
          "repo",
        );
        const materializer = yield* Materializer;
        yield* writeRegistry({ workspaceProjectId: WORKSPACE_PROJECT_ID });

        const failed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: firstTarget,
        });
        assert.equal(failed.status, "failed");
        assert.equal(failed.targetPath, firstTarget);
        assert.equal(failed.steps.find((step) => step.step === "clone")?.status, "failed");

        const completed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: secondTarget,
        });
        assert.equal(completed.status, "completed");
        assert.equal(completed.targetPath, firstTarget);
        assert.equal(yield* Ref.get(cloneAttempts), 2);
      }),
    );

    yield* program.pipe(
      Effect.provide(makeLayer({ cloneFailures: 1, dispatches, cloneAttempts, projectRows })),
    );
  }),
);

it.effect("Materializer completed records are idempotent and keep no-vault notice", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cloneAttempts = yield* Ref.make(0);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstTarget = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-done-a-" }),
          "repo",
        );
        const secondTarget = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-done-b-" }),
          "repo",
        );
        const materializer = yield* Materializer;
        yield* writeRegistry({ workspaceProjectId: WORKSPACE_PROJECT_ID });

        const completed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: firstTarget,
        });
        const rerun = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: secondTarget,
        });

        assert.equal(completed.status, "completed");
        assert.equal(rerun.targetPath, firstTarget);
        assert.deepEqual(rerun, completed);
        assert.equal(yield* Ref.get(cloneAttempts), 1);
        assert.include(rerun.notices, "no secret files synced");
      }),
    );

    yield* program.pipe(Effect.provide(makeLayer({ dispatches, cloneAttempts, projectRows })));
  }),
);

it.effect("Materializer registers the new project with the existing workspaceProjectId", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cloneAttempts = yield* Ref.make(0);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-register-" }),
          "repo",
        );
        const materializer = yield* Materializer;
        const projects = yield* ProjectionProjectRepository;
        yield* writeRegistry({ workspaceProjectId: WORKSPACE_PROJECT_ID });

        const completed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: target,
        });
        const rows = yield* projects.listAll();
        const commands = yield* Ref.get(dispatches);
        const enrollCommand = commands.find((command) => command.type === "project.roaming.enroll");

        assert.equal(completed.status, "completed");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.workspaceProjectId, WORKSPACE_PROJECT_ID);
        assert.equal(enrollCommand?.type, "project.roaming.enroll");
        if (enrollCommand?.type === "project.roaming.enroll") {
          assert.equal(enrollCommand.workspaceProjectId, WORKSPACE_PROJECT_ID);
        }
      }),
    );

    yield* program.pipe(Effect.provide(makeLayer({ dispatches, cloneAttempts, projectRows })));
  }),
);

it.effect("Materializer re-runs a completed record whose files were deleted", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cloneAttempts = yield* Ref.make(0);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-refresh-" }),
          "repo",
        );
        const materializer = yield* Materializer;
        yield* writeRegistry({ workspaceProjectId: WORKSPACE_PROJECT_ID });

        const completed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: target,
        });
        assert.equal(completed.status, "completed");
        assert.equal(yield* Ref.get(cloneAttempts), 1);

        // The 2026-07-07 field bug: delete the checkout from disk — the
        // completed record must not short-circuit into a success no-op.
        yield* fs.remove(target, { recursive: true, force: true });
        const rerun = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: target,
        });
        assert.equal(rerun.status, "completed");
        assert.equal(yield* Ref.get(cloneAttempts), 2);
        assert.isTrue(yield* fs.exists(path.join(target, ".git")));
      }),
    );

    yield* program.pipe(Effect.provide(makeLayer({ dispatches, cloneAttempts, projectRows })));
  }),
);

it.effect("Materializer re-registers when the project was deleted from the app", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cloneAttempts = yield* Ref.make(0);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-reregister-" }),
          "repo",
        );
        const materializer = yield* Materializer;
        yield* writeRegistry({ workspaceProjectId: WORKSPACE_PROJECT_ID });

        const completed = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: target,
        });
        assert.equal(completed.status, "completed");

        // Files intact, but the project is gone from the app: the record is
        // stale and materialize must run again and re-register.
        yield* Ref.set(projectRows, []);
        const rerun = yield* materializer.materialize({
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          targetPath: target,
        });
        assert.equal(rerun.status, "completed");
        const projects = yield* ProjectionProjectRepository;
        const rows = yield* projects.listAll();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.workspaceProjectId, WORKSPACE_PROJECT_ID);
      }),
    );

    yield* program.pipe(Effect.provide(makeLayer({ dispatches, cloneAttempts, projectRows })));
  }),
);

// ── restore-wip against real git ─────────────────────────────────────

const makeRealGitLayer = (input: {
  readonly dispatches: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly projectRows: Ref.Ref<ReadonlyArray<ProjectionProject>>;
}) =>
  Layer.empty
    .pipe(
      Layer.provideMerge(MaterializerLayer),
      Layer.provideMerge(RoamingBlobStoreLayer),
      Layer.provideMerge(makeProjectRepositoryLayer(input.projectRows)),
      Layer.provideMerge(
        ServerSettingsService.layerTest({ roaming: true, addProjectBaseDirectory: "/tmp" }),
      ),
      Layer.provideMerge(serverEnvironmentStub),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(GitVcsDriverModule.vcsLayer),
      Layer.provideMerge(GitVcsDriverModule.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mat-wip-test-" })),
      Layer.provideMerge(
        Layer.effect(
          SourceControlRepositoryService,
          Effect.gen(function* () {
            const vcsProcess = yield* VcsProcess.VcsProcess;
            return SourceControlRepositoryService.of({
              lookupRepository: () => Effect.die("unused"),
              publishRepository: () => Effect.die("unused"),
              cloneRepository: ({ destinationPath, remoteUrl }) =>
                vcsProcess
                  .run({
                    operation: "Materializer.test.clone",
                    command: "git",
                    args: ["clone", remoteUrl ?? "", destinationPath],
                    cwd: "/tmp",
                  })
                  .pipe(
                    Effect.map(() => ({
                      cwd: destinationPath,
                      remoteUrl: remoteUrl ?? "",
                      repository: null,
                    })),
                    Effect.mapError(
                      (cause) =>
                        new SourceControlRepositoryError({
                          operation: "cloneRepository",
                          provider: "unknown",
                          detail: "test clone failed",
                          cause,
                        }),
                    ),
                  ),
            } satisfies SourceControlRepositoryService["Service"]);
          }),
        ),
      ),
      Layer.provideMerge(makeEngineLayer(input.dispatches, input.projectRows)),
      Layer.provideMerge(peerMirrorStub),
      Layer.provideMerge(VcsProcess.layer),
    )
    .pipe(Layer.provideMerge(NodeServices.layer));

const rawGit = (cwd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    return yield* vcsProcess.run({
      operation: "Materializer.test.git",
      command: "git",
      args: [...args],
      cwd,
    });
  });

const setupAuthorAndOrigin = (input: { readonly workspaceProjectId: WorkspaceProjectId }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mat-wip-" });
    const originPath = path.join(root, "origin.git");
    const authorPath = path.join(root, "author");
    yield* fs.makeDirectory(originPath, { recursive: true });
    yield* fs.makeDirectory(authorPath, { recursive: true });
    yield* rawGit(originPath, ["init", "--bare", "-b", "main"]);
    yield* rawGit(authorPath, ["init", "-b", "main"]);
    yield* rawGit(authorPath, ["config", "user.email", "mat@example.test"]);
    yield* rawGit(authorPath, ["config", "user.name", "Mat Test"]);
    yield* rawGit(authorPath, ["remote", "add", "origin", originPath]);
    yield* fs.writeFileString(path.join(authorPath, "tracked.txt"), "base\n");
    yield* rawGit(authorPath, ["add", "."]);
    yield* rawGit(authorPath, ["commit", "-m", "base"]);
    yield* rawGit(authorPath, ["push", "origin", "main"]);
    const store = yield* RoamingBlobStore;
    const payload = yield* encodeRegistryPayload({
      workspaceProjectId: input.workspaceProjectId,
      title: "Wip Restore Project",
      repository: {
        canonicalKey: `git:${originPath}`,
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: originPath },
        name: "wip-restore",
      },
      vaultOverrides: { include: [], exclude: [] },
      perMachineRoots: {},
    });
    yield* store.writeLocal({
      kind: "registry",
      key: input.workspaceProjectId,
      workspaceProjectId: input.workspaceProjectId,
      payload,
    });
    return { root, originPath, authorPath };
  });

const AUTHOR_ENVIRONMENT_ID = EnvironmentId.make("env-author");

const writeWipMetadata = Effect.fn("MaterializerTest.writeWipMetadata")(function* (
  workspaceProjectId: WorkspaceProjectId,
  captured: CaptureWipResult,
  bundleBase64 = "",
) {
  const store = yield* RoamingBlobStore;
  const payload = yield* encodeWipPayload({
    schemaVersion: 2,
    capturedAt: "2026-07-11T00:00:00.000Z",
    refName: captured.refName,
    commitOid: captured.commitOid,
    treeOid: captured.treeOid,
    branchRef: captured.branchRef,
    headOid: captured.headOid,
    bundleBase64,
  });
  yield* store.writeLocal({
    kind: "wip",
    key: `${workspaceProjectId}/${AUTHOR_ENVIRONMENT_ID}`,
    workspaceProjectId,
    payload,
  });
});

it.effect("Materializer restore-wip applies the newest origin snapshot", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);
    const wsid = WorkspaceProjectId.make("wp-mat-wip-origin");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, authorPath } = yield* setupAuthorAndOrigin({ workspaceProjectId: wsid });
        yield* fs.writeFileString(path.join(authorPath, "tracked.txt"), "dirty\n");
        yield* fs.writeFileString(path.join(authorPath, "scratch.txt"), "untracked\n");
        const captured = yield* captureWipSnapshot({
          cwd: authorPath,
          workspaceProjectId: wsid,
          environmentId: AUTHOR_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        assert.isNotNull(captured);
        yield* rawGit(authorPath, ["push", "origin", `${captured!.refName}:${captured!.refName}`]);
        yield* writeWipMetadata(wsid, captured!);

        const target = path.join(root, "materialized");
        const materializer = yield* Materializer;
        const record = yield* materializer.materialize({
          workspaceProjectId: wsid,
          targetPath: target,
        });
        assert.equal(record.status, "completed");
        const wipStep = record.steps.find((step) => step.step === "restore-wip");
        assert.equal(wipStep?.status, "completed");
        assert.match(wipStep?.detail ?? "", /applied work in progress from env-author/);
        assert.equal(yield* fs.readFileString(path.join(target, "tracked.txt")), "dirty\n");
        assert.equal(yield* fs.readFileString(path.join(target, "scratch.txt")), "untracked\n");
      }),
    );

    yield* program.pipe(Effect.provide(makeRealGitLayer({ dispatches, projectRows })));
  }),
);

it.effect("Materializer restore-wip checks out the snapshot branch", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);
    const wsid = WorkspaceProjectId.make("wp-mat-wip-branch");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, authorPath } = yield* setupAuthorAndOrigin({ workspaceProjectId: wsid });
        yield* rawGit(authorPath, ["switch", "-c", "feature/materialized"]);
        yield* fs.writeFileString(path.join(authorPath, "branch.txt"), "committed\n");
        yield* rawGit(authorPath, ["add", "branch.txt"]);
        yield* rawGit(authorPath, ["commit", "-m", "branch commit"]);
        yield* fs.writeFileString(path.join(authorPath, "wip.txt"), "dirty\n");
        const captured = yield* captureWipSnapshot({
          cwd: authorPath,
          workspaceProjectId: wsid,
          environmentId: AUTHOR_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        assert.isNotNull(captured);
        yield* rawGit(authorPath, ["push", "origin", `${captured!.refName}:${captured!.refName}`]);
        yield* writeWipMetadata(wsid, captured!);

        const target = path.join(root, "materialized");
        const materializer = yield* Materializer;
        const record = yield* materializer.materialize({
          workspaceProjectId: wsid,
          targetPath: target,
        });
        assert.equal(record.status, "completed");
        assert.equal(
          (yield* rawGit(target, ["branch", "--show-current"])).stdout.trim(),
          "feature/materialized",
        );
        assert.equal(
          (yield* rawGit(target, ["rev-parse", "HEAD"])).stdout.trim(),
          captured!.headOid,
        );
        assert.equal(yield* fs.readFileString(path.join(target, "wip.txt")), "dirty\n");
      }),
    );

    yield* program.pipe(Effect.provide(makeRealGitLayer({ dispatches, projectRows })));
  }),
);

it.effect("Materializer restore-wip skips when the snapshot matches the checkout", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);
    const wsid = WorkspaceProjectId.make("wp-mat-wip-clean");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { root, authorPath } = yield* setupAuthorAndOrigin({ workspaceProjectId: wsid });
        // Clean-tree snapshot: tree == HEAD tree.
        const captured = yield* captureWipSnapshot({
          cwd: authorPath,
          workspaceProjectId: wsid,
          environmentId: AUTHOR_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        assert.isNotNull(captured);
        yield* rawGit(authorPath, ["push", "origin", `${captured!.refName}:${captured!.refName}`]);
        yield* writeWipMetadata(wsid, captured!);

        const target = path.join(root, "materialized");
        const materializer = yield* Materializer;
        const record = yield* materializer.materialize({
          workspaceProjectId: wsid,
          targetPath: target,
        });
        assert.equal(record.status, "completed");
        const wipStep = record.steps.find((step) => step.step === "restore-wip");
        assert.equal(wipStep?.status, "skipped");
        assert.equal(wipStep?.detail, "work in progress already matches the checkout");
      }),
    );

    yield* program.pipe(Effect.provide(makeRealGitLayer({ dispatches, projectRows })));
  }),
);

it.effect("Materializer restore-wip restores from a mirrored bundle blob", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);
    const wsid = WorkspaceProjectId.make("wp-mat-wip-bundle");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, authorPath } = yield* setupAuthorAndOrigin({ workspaceProjectId: wsid });
        yield* fs.writeFileString(path.join(authorPath, "tracked.txt"), "bundle-dirty\n");
        const captured = yield* captureWipSnapshot({
          cwd: authorPath,
          workspaceProjectId: wsid,
          environmentId: AUTHOR_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        assert.isNotNull(captured);
        // No origin push — the snapshot travels as a bundle blob only.
        const bundlePath = path.join(root, "wip.bundle");
        yield* rawGit(authorPath, ["fetch", "origin"]);
        yield* rawGit(authorPath, [
          "bundle",
          "create",
          bundlePath,
          captured!.refName,
          "--not",
          "--remotes=origin",
        ]);
        const bundleBytes = yield* fs.readFile(bundlePath);
        yield* writeWipMetadata(wsid, captured!, Buffer.from(bundleBytes).toString("base64"));

        const target = path.join(root, "materialized");
        const materializer = yield* Materializer;
        const record = yield* materializer.materialize({
          workspaceProjectId: wsid,
          targetPath: target,
        });
        assert.equal(record.status, "completed");
        const wipStep = record.steps.find((step) => step.step === "restore-wip");
        assert.equal(wipStep?.status, "completed");
        assert.equal(yield* fs.readFileString(path.join(target, "tracked.txt")), "bundle-dirty\n");
      }),
    );

    yield* program.pipe(Effect.provide(makeRealGitLayer({ dispatches, projectRows })));
  }),
);

it.effect("Materializer restore-wip honors restoreWip=false", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const projectRows = yield* Ref.make<ReadonlyArray<ProjectionProject>>([]);
    const wsid = WorkspaceProjectId.make("wp-mat-wip-off");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, authorPath } = yield* setupAuthorAndOrigin({ workspaceProjectId: wsid });
        yield* fs.writeFileString(path.join(authorPath, "tracked.txt"), "dirty\n");
        const captured = yield* captureWipSnapshot({
          cwd: authorPath,
          workspaceProjectId: wsid,
          environmentId: AUTHOR_ENVIRONMENT_ID,
          vaultExcludePaths: [],
        });
        yield* rawGit(authorPath, ["push", "origin", `${captured!.refName}:${captured!.refName}`]);

        const target = path.join(root, "materialized");
        const materializer = yield* Materializer;
        const record = yield* materializer.materialize({
          workspaceProjectId: wsid,
          targetPath: target,
          restoreWip: false,
        });
        assert.equal(record.status, "completed");
        const wipStep = record.steps.find((step) => step.step === "restore-wip");
        assert.equal(wipStep?.status, "skipped");
        assert.equal(wipStep?.detail, "disabled by request");
        assert.equal(yield* fs.readFileString(path.join(target, "tracked.txt")), "base\n");
      }),
    );

    yield* program.pipe(Effect.provide(makeRealGitLayer({ dispatches, projectRows })));
  }),
);
