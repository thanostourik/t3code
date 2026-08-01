/**
 * Roaming's contribution to the orchestration shell stream, extracted
 * behind one seam so ws.ts stays a few call sites (fork-discipline: the
 * subscribe handler is hot upstream code; this file is roaming-owned).
 *
 * Three pieces, all created per shell subscription:
 * - `attachSources` — a scope-bound buffer fed by every roaming live
 *   source (blob changes → project/thread upserts, materialization + WIP
 *   status updates, attach-registration nudges) plus the M5.5
 *   supersession watcher over domain events. Sources subscribe BEFORE any
 *   snapshot or catch-up work, so a publish while those are in flight
 *   lands in the buffer instead of being dropped.
 * - `overlaySnapshot` — the gate-masking rule for snapshot-emitting
 *   paths: flag off strips every roaming field; flag on carries the live
 *   WIP statuses and in-memory materialization records (D2).
 * - `catchUpItems` — the sequence-0 roaming overlay seeded into warm
 *   resumes (cached clients otherwise keep stale/empty roaming state
 *   until the next live publish).
 */
import {
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  RoamingTranscriptPayload,
  type RoamingThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { Materializer } from "./Materializer.ts";
import type { RoamingAttachRegistrations } from "./RoamingAttachRegistrations.ts";
import type { RoamingBlobStore } from "./RoamingBlobStore.ts";
import type { RoamingThreadResumptions } from "./RoamingThreadResumptions.ts";
import type { WipSnapshotReactor } from "./WipSnapshotReactor.ts";

const decodeTranscriptPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingTranscriptPayload),
);

export interface RoamingShellStreamDeps {
  readonly blobStore: RoamingBlobStore["Service"];
  readonly threadResumptions: RoamingThreadResumptions["Service"];
  readonly attachRegistrations: RoamingAttachRegistrations["Service"];
  readonly materializer: Materializer["Service"];
  readonly wipSnapshotReactor: WipSnapshotReactor["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
}

export const makeRoamingShellStream = (deps: RoamingShellStreamDeps) => {
  const {
    blobStore,
    threadResumptions,
    attachRegistrations,
    materializer,
    wipSnapshotReactor,
    projectionSnapshotQuery,
    orchestrationEngine,
  } = deps;

  /**
   * Roaming live sources are not domain events; they merge in as
   * sequence-0 items — applied by key, not by snapshot ordering — so they
   * bypass the domain-event coalescing buffer.
   */
  const attachSources: Effect.Effect<
    Queue.Queue<OrchestrationShellStreamItem>,
    never,
    Scope.Scope
  > = Effect.gen(function* () {
    const buffer = yield* Queue.unbounded<OrchestrationShellStreamItem>();
    const attachSource = <A>(
      subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>,
      toItem: (value: A) => Effect.Effect<OrchestrationShellStreamItem | undefined>,
    ) =>
      Effect.gen(function* () {
        const subscription = yield* subscribe;
        yield* Effect.forkScoped(
          Effect.forever(
            PubSub.take(subscription).pipe(
              Effect.flatMap(toItem),
              Effect.flatMap((item) =>
                item === undefined ? Effect.void : Queue.offer(buffer, item),
              ),
            ),
          ),
          { startImmediately: true },
        );
      });

    yield* attachSource(blobStore.subscribeChanges, (record) =>
      record.kind === "transcript" || record.kind === "brief"
        ? // Mirrored-thread rows (M5): tombstoned transcripts still
          // emit (deleted: true tells the reducer to drop the row).
          projectionSnapshotQuery.getRoamingThreadShellById(record.key as ThreadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
            Effect.map((shell) =>
              shell === undefined
                ? undefined
                : {
                    kind: "roaming-thread-upserted" as const,
                    sequence: 0,
                    roamingThread: shell,
                  },
            ),
          )
        : projectionSnapshotQuery.listRoamingProjectShells().pipe(
            Effect.map((shells) =>
              shells.find((shell) => shell.workspaceProjectId === record.workspaceProjectId),
            ),
            Effect.orElseSucceed(() => undefined),
            Effect.map((shell) =>
              shell === undefined
                ? undefined
                : {
                    kind: "roaming-project-upserted" as const,
                    sequence: 0,
                    roamingProject: shell,
                  },
            ),
          ),
    );
    yield* attachSource(materializer.subscribeUpdates, (materialization) =>
      Effect.succeed({
        kind: "roaming-materialization-updated" as const,
        sequence: 0,
        materialization,
      }),
    );
    yield* attachSource(wipSnapshotReactor.subscribeUpdates, (wipStatus) =>
      Effect.succeed({
        kind: "roaming-wip-status-updated" as const,
        sequence: 0,
        wipStatus,
      }),
    );
    // M5.6: payload-free nudge — clients refetch registrations over the
    // authenticated no-store HTTP route.
    yield* attachSource(attachRegistrations.subscribeChanges, () =>
      Effect.succeed({
        kind: "roaming-attach-registrations-changed" as const,
        sequence: 0,
      }),
    );

    // M5.5 supersession transitions are NOT blob changes: a source
    // thread's fallback row disappears when its resumed local thread is
    // created and returns when that thread is deleted — both driven by
    // the projection row, so the blob source above never fires and live
    // clients kept the stale row (field bug). Poll briefly for the
    // projection write to land, then emit the row's new state; a removal
    // is synthesized from the raw blob because the list query rightly
    // refuses to return it.
    yield* Effect.forkScoped(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type !== "thread.created" && event.type !== "thread.deleted") {
            return Effect.void;
          }
          const resumedThreadId = (event.payload as { threadId?: unknown }).threadId;
          if (typeof resumedThreadId !== "string") {
            return Effect.void;
          }
          const expectVisible = event.type === "thread.deleted";
          return Effect.gen(function* () {
            const sources = yield* threadResumptions
              .findSourcesByResumedThreadId(resumedThreadId as ThreadId)
              .pipe(Effect.orElseSucceed(() => []));
            for (const sourceThreadId of sources) {
              let shell = undefined;
              for (let attempt = 0; attempt < 20; attempt++) {
                shell = yield* projectionSnapshotQuery
                  .getRoamingThreadShellById(sourceThreadId)
                  .pipe(
                    Effect.map(Option.getOrUndefined),
                    Effect.orElseSucceed(() => undefined),
                  );
                if ((shell !== undefined) === expectVisible) break;
                yield* Effect.sleep(Duration.millis(250));
              }
              if (shell !== undefined) {
                yield* Queue.offer(buffer, {
                  kind: "roaming-thread-upserted" as const,
                  sequence: 0,
                  roamingThread: shell,
                });
                continue;
              }
              const record = yield* blobStore
                .get({ kind: "transcript", key: sourceThreadId })
                .pipe(Effect.orElseSucceed(() => null));
              if (record === null) continue;
              const payload = yield* decodeTranscriptPayload(record.payload).pipe(
                Effect.orElseSucceed(() => null),
              );
              if (payload === null) continue;
              yield* Queue.offer(buffer, {
                kind: "roaming-thread-upserted" as const,
                sequence: 0,
                roamingThread: {
                  threadId: sourceThreadId,
                  workspaceProjectId: payload.workspaceProjectId,
                  title: payload.title,
                  authorEnvironmentId:
                    record.authorEnvironmentId as RoamingThreadShell["authorEnvironmentId"],
                  capturedAt: payload.capturedAt,
                  updatedAt: payload.updatedAt,
                  messageCount: payload.messages.length,
                  hasBrief: false,
                  deleted: true,
                },
              });
            }
          });
        }),
      ),
      { startImmediately: true },
    );

    return buffer;
  });

  /**
   * Roaming state is hidden while the flag is off; when on, the snapshot
   * carries the live WIP statuses and in-memory materialization records
   * (D2). Every snapshot-emitting shell path goes through this helper.
   */
  const overlaySnapshot = (snapshot: OrchestrationShellSnapshot, roamingEnabled: boolean) =>
    roamingEnabled
      ? Effect.map(
          Effect.all([wipSnapshotReactor.listStatuses(), materializer.listRecords]),
          ([wipStatus, materializations]): OrchestrationShellSnapshot => ({
            ...snapshot,
            roamingWipStatus: wipStatus,
            roamingMaterializations: materializations,
          }),
        )
      : Effect.succeed<OrchestrationShellSnapshot>({
          ...snapshot,
          roamingProjects: [],
          roamingMaterializations: [],
          roamingWipStatus: [],
          roamingThreads: [],
        });

  /**
   * The sequence-0 roaming overlay for warm resumes: the same fields the
   * cold-subscribe snapshot and the HTTP /shell route carry. Without it a
   * client resuming from a warm shell cache keeps stale/empty roaming
   * state until the next live publish.
   */
  const catchUpItems = (roamingEnabled: boolean) =>
    roamingEnabled
      ? Effect.gen(function* () {
          const [shell, wipStatuses, materializations] = yield* Effect.all([
            projectionSnapshotQuery.getShellSnapshot(),
            wipSnapshotReactor.listStatuses(),
            materializer.listRecords,
          ]);
          const items: OrchestrationShellStreamItem[] = [];
          for (const roamingProject of shell.roamingProjects) {
            items.push({ kind: "roaming-project-upserted", sequence: 0, roamingProject });
          }
          for (const roamingThread of shell.roamingThreads) {
            items.push({ kind: "roaming-thread-upserted", sequence: 0, roamingThread });
          }
          for (const materialization of materializations) {
            items.push({ kind: "roaming-materialization-updated", sequence: 0, materialization });
          }
          items.push({ kind: "roaming-wip-status-replaced", sequence: 0, wipStatuses });
          return items;
        })
      : Effect.succeed([
          { kind: "roaming-wip-status-replaced" as const, sequence: 0, wipStatuses: [] },
        ]);

  return { attachSources, overlaySnapshot, catchUpItems };
};
