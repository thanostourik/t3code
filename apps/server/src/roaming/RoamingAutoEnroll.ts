/**
 * RoamingAutoEnroll - links existing local projects once roaming has peers,
 * and keeps project titles and registry titles reconciled in both directions
 * (a local rename flows out through the registry; an arrived registry title
 * flows into the linked local project).
 *
 * The reactor always starts and gates itself internally on the roaming
 * setting, matching the other roaming reactors.
 */
import { CommandId, ProjectId, RoamingRegistryPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers } from "./RoamingPeers.ts";
import { ROAMING_WORKSPACE_MARKER } from "./Materializer.ts";
import { RoamingService } from "./RoamingService.ts";

const decodeRegistryPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);
const decodeMetaUpdatedPayload = Schema.decodeUnknownEffect(
  Schema.Struct({ projectId: ProjectId, title: Schema.optional(Schema.String) }),
);

export class RoamingAutoEnroll extends Context.Service<
  RoamingAutoEnroll,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/roaming/RoamingAutoEnroll") {}

const make = Effect.gen(function* () {
  const peers = yield* RoamingPeers;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const projectRepository = yield* ProjectionProjectRepository;
  const roamingService = yield* RoamingService;
  const engine = yield* OrchestrationEngineService;
  const blobStore = yield* RoamingBlobStore;
  const crypto = yield* Crypto.Crypto;
  const trigger = yield* Queue.sliding<void>(1);

  const roamingEnabled = peers.roamingEnabled;

  // Local rename → registry: push the new title into the registry blob so it
  // mirrors to peers. Event-triggered only (never pass-based): a stale
  // periodic reconcile could overwrite an in-flight rename from the peer.
  const pushRenamedTitle = (payload: unknown) =>
    Effect.gen(function* () {
      const meta = yield* decodeMetaUpdatedPayload(payload).pipe(Effect.orElseSucceed(() => null));
      if (meta === null || meta.title === undefined || !(yield* roamingEnabled)) {
        return;
      }
      yield* roamingService.syncRegistryTitle(meta.projectId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming: registry title sync failed", {
            projectId: meta.projectId,
            cause,
          }),
        ),
      );
    });

  // Arrived registry → local project: an enrolled project follows its
  // registry title (renames roam; the registry is the shared source of
  // truth, last writer wins).
  const applyRegistryTitle = (workspaceProjectId: string) =>
    Effect.gen(function* () {
      if (!(yield* roamingEnabled)) {
        return;
      }
      const blob = yield* blobStore
        .get({ kind: "registry", key: workspaceProjectId })
        .pipe(Effect.orElseSucceed(() => null));
      if (blob === null) {
        return;
      }
      const registry = yield* decodeRegistryPayloadJson(blob.payload).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (registry === null || registry.title.length === 0) {
        return;
      }
      const projects = yield* projectRepository.listAll().pipe(Effect.orElseSucceed(() => []));
      const linked = projects.find(
        (project) =>
          project.workspaceProjectId === registry.workspaceProjectId && project.deletedAt === null,
      );
      if (linked === undefined || linked.title === registry.title) {
        return;
      }
      yield* engine
        .dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          projectId: linked.projectId,
          title: registry.title,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("roaming: applying registry title failed", {
              projectId: linked.projectId,
              cause,
            }),
          ),
        );
    });

  // A materialized project is linked to its EXISTING workspaceProjectId by
  // the register step; if this reactor observed it in the window between
  // project.create and that link, enrollProject would mint a second id for
  // the same repo — the D1 fork. The clone step writes the workspace marker
  // into the checkout BEFORE any project.create (crash-safe, D2 — the old
  // roaming_materializations row is gone), so a root carrying the marker is
  // never auto-enrolled.
  const isMaterializedRoot = (workspaceRoot: string) =>
    fs
      .exists(pathService.join(workspaceRoot, ".git", ROAMING_WORKSPACE_MARKER))
      .pipe(Effect.orElseSucceed(() => true)); // unreadable → fail closed

  const runPass = Effect.gen(function* () {
    if (!(yield* roamingEnabled)) {
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
      if (yield* isMaterializedRoot(project.workspaceRoot)) {
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

      // ONE domain-event subscription (S7): created → enroll pass; renamed →
      // registry title push.
      yield* Effect.forkScoped(
        engine.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "project.created"
              ? Queue.offer(trigger, undefined)
              : event.type === "project.meta-updated"
                ? pushRenamedTitle(event.payload)
                : Effect.void,
          ),
        ),
      );

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const blobChanges = yield* blobStore.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(blobChanges).pipe(
              Effect.flatMap((record) =>
                record.kind === "registry"
                  ? applyRegistryTitle(record.workspaceProjectId)
                  : Effect.void,
              ),
            ),
          );
        }),
      );

      // The master gate flips on peer changes (pairing writes no setting
      // since D3): wake a pass whenever the peer set changes while enabled.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const peerChanges = yield* peers.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(peerChanges).pipe(
              Effect.andThen(
                Effect.flatMap(roamingEnabled, (enabled) =>
                  enabled ? Queue.offer(trigger, undefined) : Effect.void,
                ),
              ),
            ),
          );
        }),
      );
    });

  return { start } satisfies RoamingAutoEnroll["Service"];
});

export const layer = Layer.effect(RoamingAutoEnroll, make);
