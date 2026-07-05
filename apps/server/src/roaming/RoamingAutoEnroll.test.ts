import { EnvironmentId, ProjectId, WorkspaceProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RoamingAutoEnroll, layer as RoamingAutoEnrollLayer } from "./RoamingAutoEnroll.ts";
import { RoamingPeers, layer as RoamingPeersLayer } from "./RoamingPeers.ts";
import { RoamingService } from "./RoamingService.ts";

const PEER_ENVIRONMENT_ID = EnvironmentId.make("env-peer");
const PROJECT_ID = ProjectId.make("project-auto-enroll");

const makeLayer = (input: {
  readonly roaming: boolean;
  readonly enrollCalls: Ref.Ref<ReadonlyArray<ProjectId>>;
}) =>
  Layer.empty.pipe(
    Layer.provideMerge(RoamingAutoEnrollLayer),
    Layer.provideMerge(RoamingPeersLayer),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({ roaming: input.roaming })),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
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
        addPeer: () => Effect.die("unused"),
        mintMachineCredential: () => Effect.die("unused"),
      } satisfies RoamingService["Service"]),
    ),
  );

const seedProjectAndPeer = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const peers = yield* RoamingPeers;
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
  yield* peers.upsert({
    environmentId: PEER_ENVIRONMENT_ID,
    baseUrls: ["http://peer.example.test"],
    lastContactAt: null,
    enrolledAt: now,
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
      yield* program.pipe(Effect.provide(makeLayer({ roaming: true, enrollCalls })));
    }),
);

it.effect("RoamingAutoEnroll skips projects while roaming is off", () =>
  Effect.gen(function* () {
    const enrollCalls = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* seedProjectAndPeer;
        const autoEnroll = yield* RoamingAutoEnroll;
        yield* autoEnroll.start();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(enrollCalls), []);
      }),
    );
    yield* program.pipe(Effect.provide(makeLayer({ roaming: false, enrollCalls })));
  }),
);
