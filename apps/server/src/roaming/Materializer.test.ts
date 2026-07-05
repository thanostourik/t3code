import {
  EnvironmentId,
  type OrchestrationCommand,
  RoamingRegistryPayload,
  SourceControlRepositoryError,
  VcsProcessExitError,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
import { Materializer, layer as MaterializerLayer } from "./Materializer.ts";
import { RoamingBlobStore, layer as RoamingBlobStoreLayer } from "./RoamingBlobStore.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-materializer");
const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-materializer");
const REMOTE_URL = "https://example.test/owner/materializer.git";

const encodeRegistryPayload = Schema.encodeEffect(Schema.fromJsonString(RoamingRegistryPayload));

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
          execute: () => Effect.die("unused"),
          detectRepository: () => Effect.die("unused"),
          isInsideWorkTree: () => Effect.die("unused"),
          listWorkspaceFiles: () => Effect.die("unused"),
          listRemotes: (cwd) =>
            Effect.fail(
              new VcsProcessExitError({
                operation: "Materializer.test.listRemotes",
                command: "git remote -v",
                cwd,
                exitCode: 1,
                detail: "not a git repo",
              }),
            ),
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
