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
  const trigger = yield* Queue.sliding<void>(1);

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
