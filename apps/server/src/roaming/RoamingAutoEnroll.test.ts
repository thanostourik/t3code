import { EnvironmentId, ProjectId, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ROAMING_WORKSPACE_MARKER } from "./Materializer.ts";
import { RoamingAutoEnroll, layer as RoamingAutoEnrollLayer } from "./RoamingAutoEnroll.ts";
import { layer as RoamingBlobStoreLayer } from "./RoamingBlobStore.ts";
import { RoamingPeers, layer as RoamingPeersLayer } from "./RoamingPeers.ts";
import { RoamingService } from "./RoamingService.ts";

const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-peer");
const PROJECT_ID = ProjectId.make("project-auto-enroll");
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("env-auto-enroll-local");

const serverEnvironmentStub = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT_ID),
  getDescriptor: Effect.die("descriptor unused in RoamingAutoEnroll tests"),
});

const makeLayer = (input: { readonly enrollCalls: Ref.Ref<ReadonlyArray<ProjectId>> }) =>
  Layer.empty.pipe(
    Layer.provideMerge(RoamingAutoEnrollLayer),
    Layer.provideMerge(RoamingBlobStoreLayer),
    Layer.provideMerge(RoamingPeersLayer),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverEnvironmentStub),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        readEvents: () => Stream.empty,
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
        dispatch: () => Effect.die("unused"),
      } satisfies OrchestrationEngineService["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(RoamingService, {
        enrollProject: (projectId) =>
          Ref.update(input.enrollCalls, (calls) => [...calls, projectId]).pipe(
            Effect.as(WorkspaceProjectId.make(`wp-${projectId}`)),
          ),
        syncRegistryTitle: () => Effect.void,
        addPeer: () => Effect.die("unused"),
        mintMachineCredential: () => Effect.die("unused"),
      } satisfies RoamingService["Service"]),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const seedProject = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* projects.upsert({
    projectId: PROJECT_ID,
    title: "Auto Enroll",
    workspaceRoot: "/tmp/auto-enroll",
    workspaceProjectId: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
});

// Seeding through the service (not raw SQL) keeps the derived gate's
// in-memory hasPeers cache honest — and with D3 the peer row IS the gate.
const seedProjectAndPeer = Effect.gen(function* () {
  yield* seedProject;
  const peers = yield* RoamingPeers;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* peers.upsert({
    environmentId: PEER_ENVIRONMENT_ID,
    baseUrls: ["http://peer.example.test"],
    lastContactAt: null,
    enrolledAt: now,
    syncEnabled: true,
  });
});

it.effect(
  "RoamingAutoEnroll enrolls unenrolled projects when roaming is on and a peer exists",
  () =>
    Effect.gen(function* () {
      const enrollCalls = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
      const program = Effect.scoped(
        Effect.gen(function* () {
          yield* seedProjectAndPeer;
          const autoEnroll = yield* RoamingAutoEnroll;
          yield* autoEnroll.start();
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.deepEqual(yield* Ref.get(enrollCalls), [PROJECT_ID]);
        }),
      );
      yield* program.pipe(Effect.provide(makeLayer({ enrollCalls })));
    }),
);

it.effect(
  "RoamingAutoEnroll never enrolls a project under a materialization target path (D1 fork guard)",
  () =>
    Effect.gen(function* () {
      const enrollCalls = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
      const program = Effect.scoped(
        Effect.gen(function* () {
          // The clone step writes the workspace marker into the checkout
          // before dispatching project.create (D2); a project observed at a
          // marked root is mid-link to an existing workspaceProjectId and
          // must not be enrolled.
          const fs = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const markedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auto-enroll-" });
          yield* fs.makeDirectory(pathService.join(markedRoot, ".git"), { recursive: true });
          yield* fs.writeFileString(
            pathService.join(markedRoot, ".git", ROAMING_WORKSPACE_MARKER),
            "wp-existing\n",
          );
          yield* seedProjectAndPeer;
          const projects = yield* ProjectionProjectRepository;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* projects.upsert({
            projectId: ProjectId.make("project-materialized"),
            title: "Materialized",
            workspaceRoot: markedRoot,
            workspaceProjectId: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
          const autoEnroll = yield* RoamingAutoEnroll;
          yield* autoEnroll.start();
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          // The unmarked seed project enrolls; the marked root never does.
          assert.deepEqual(yield* Ref.get(enrollCalls), [PROJECT_ID]);
        }),
      );
      yield* program.pipe(Effect.provide(makeLayer({ enrollCalls })));
    }),
);

it.effect("RoamingAutoEnroll skips projects while roaming is off (no peers)", () =>
  Effect.gen(function* () {
    const enrollCalls = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* seedProject;
        const autoEnroll = yield* RoamingAutoEnroll;
        yield* autoEnroll.start();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(enrollCalls), []);
      }),
    );
    yield* program.pipe(Effect.provide(makeLayer({ enrollCalls })));
  }),
);
