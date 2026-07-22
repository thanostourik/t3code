import { EnvironmentId, ProjectId, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
          yield* seedProjectAndPeer;
          // The materializer persists the target path before dispatching
          // project.create; a project observed at that root is mid-link to
          // an existing workspaceProjectId and must not be enrolled.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO roaming_materializations (
              workspace_project_id, status, steps_json, notices_json,
              target_path, local_project_id, error, started_at, updated_at
            ) VALUES (
              'wp-existing', 'running', '[]', '[]',
              '/tmp/auto-enroll', NULL, NULL,
              '2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z'
            )
          `;
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
