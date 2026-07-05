/**
 * RoamingAutoEnroll - links existing local projects once roaming has peers.
 *
 * The reactor always starts and gates itself internally on the roaming
 * setting, matching the other roaming reactors.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RoamingPeers } from "./RoamingPeers.ts";
import { RoamingService } from "./RoamingService.ts";

export class RoamingAutoEnroll extends Context.Service<
  RoamingAutoEnroll,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/roaming/RoamingAutoEnroll") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const peers = yield* RoamingPeers;
  const projectRepository = yield* ProjectionProjectRepository;
  const roamingService = yield* RoamingService;
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const trigger = yield* Queue.sliding<void>(1);

  // Roots the materializer is (or was) working in. A materialized project is
  // linked to its EXISTING workspaceProjectId by the register step; if this
  // reactor observed it in the window between project.create and that link,
  // enrollProject would mint a second id for the same repo — the D1 fork.
  // The target path is persisted before the project exists, so it closes the
  // window; any status counts, since a failed materialization is resumable.
  const materializationRoots = sql<{ readonly targetPath: string | null }>`
    SELECT target_path AS "targetPath" FROM roaming_materializations
  `.pipe(
    Effect.map(
      (rows) => new Set(rows.flatMap((row) => (row.targetPath === null ? [] : [row.targetPath]))),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("roaming: auto-enroll materialization lookup failed", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

  const runPass = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("roaming: auto-enroll settings lookup failed", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    if (currentSettings?.roaming !== true) {
      return;
    }

    const enrolledPeers = yield* peers
      .list()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming: auto-enroll peer lookup failed", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    if (enrolledPeers.length === 0) {
      return;
    }

    // Fail closed: without the materialization roots we cannot rule out the
    // fork race, so skip the pass; the next trigger retries.
    const roots = yield* materializationRoots;
    if (roots === null) {
      return;
    }

    const projects = yield* projectRepository
      .listAll()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming: auto-enroll project lookup failed", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    for (const project of projects) {
      if (project.deletedAt !== null || project.workspaceProjectId !== null) {
        continue;
      }
      if (roots.has(project.workspaceRoot)) {
        continue;
      }
      yield* roamingService.enrollProject(project.projectId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming: auto-enroll project failed", {
            projectId: project.projectId,
            cause,
          }),
        ),
      );
    }
  });

  const start: RoamingAutoEnroll["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(trigger).pipe(
            Effect.andThen(
              runPass.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("roaming: auto-enroll pass failed", { cause }),
                ),
              ),
            ),
          ),
        ),
      );
      yield* Queue.offer(trigger, undefined);

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const peerChanges = yield* peers.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(peerChanges).pipe(Effect.andThen(Queue.offer(trigger, undefined))),
          );
        }),
      );

      yield* Effect.forkScoped(
        engine.streamDomainEvents.pipe(
          Stream.filter((event) => event.type === "project.created"),
          Stream.runForEach(() => Queue.offer(trigger, undefined)),
        ),
      );

      yield* Effect.forkScoped(
        settings.streamChanges.pipe(
          Stream.filter((nextSettings) => nextSettings.roaming),
          Stream.runForEach(() => Queue.offer(trigger, undefined)),
        ),
      );
    });

  return { start } satisfies RoamingAutoEnroll["Service"];
});

export const layer = Layer.effect(RoamingAutoEnroll, make);
