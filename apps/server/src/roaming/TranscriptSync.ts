/**
 * TranscriptSync — mirrors *projected transcripts* of conversation threads
 * as roaming blobs (M5), and owns the park/brief flow.
 *
 * A transcript is a reduced presentation payload built from the committed
 * SQLite projections at turn boundaries — never the raw event log, and never
 * the full OrchestrationThread (activity payloads carry raw tool output and
 * median ~0.7 MB per thread). Only this machine's threads are captured;
 * mirrored transcripts render read-only on the peer and are never imported
 * into its event log. Thread deletion/archival mirrors as a tombstone
 * payload (`deleted: true`) because the blob store has no delete.
 *
 * Park = force a final transcript capture (marked `parked`), request a final
 * WIP snapshot when WIP consent is on (skip-not-fail), and write an
 * agent-generated resumption brief — via the background text-generation
 * facility, never a thread turn, so parking cannot append to the thread.
 * The brief falls back to a deterministic digest when no provider is
 * available, with an honest notice.
 */
import {
  ModelSelection,
  ROAMING_BRIEF_MAX_CHARS,
  ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES,
  ROAMING_TRANSCRIPT_MAX_BYTES,
  RoamingBriefPayload,
  RoamingTranscriptPayload,
  type OrchestrationThread,
  type RoamingThreadParkResponse,
  type ThreadId,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers } from "./RoamingPeers.ts";
import { WipSnapshotReactor } from "./WipSnapshotReactor.ts";

/** Character budget for the transcript text handed to brief generation. */
const BRIEF_INPUT_MAX_CHARS = 50_000;

export class TranscriptParkError extends Schema.TaggedErrorClass<TranscriptParkError>()(
  "TranscriptParkError",
  {
    reason: Schema.Literals(["thread-not-found", "project-not-enrolled", "internal"]),
    detail: Schema.optional(Schema.String),
  },
) {}

export class TranscriptBriefError extends Schema.TaggedErrorClass<TranscriptBriefError>()(
  "TranscriptBriefError",
  {
    reason: Schema.Literals(["thread-unknown", "internal"]),
    detail: Schema.optional(Schema.String),
  },
) {}

export class TranscriptSync extends Context.Service<
  TranscriptSync,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Enqueue a capture for one thread (coalesced per thread). */
    readonly captureThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Reconcile every enrolled project's threads (startup, settings/peer wake). */
    readonly captureAll: () => Effect.Effect<void>;
    /**
     * Park a LOCAL thread: final `parked` transcript capture (runs even when
     * the Conversations flag is off — clicking Park IS the consent for this
     * thread, surfaced as a notice), best-effort final WIP snapshot, brief
     * generation + blob write. Returns the brief for immediate editing.
     */
    readonly park: (
      threadId: ThreadId,
    ) => Effect.Effect<RoamingThreadParkResponse, TranscriptParkError>;
    /** Save an edited brief as a new blob version (either machine, newest-wins). */
    readonly saveBrief: (
      threadId: ThreadId,
      markdown: string,
    ) => Effect.Effect<RoamingBriefPayload, TranscriptBriefError>;
    /**
     * Produce a brief ON THIS machine from its local transcript copy (M5.5 —
     * resume needs zero preparation on the source machine). Stateless: no
     * blob write; the markdown seeds the resume draft. Generation uses the
     * transcript's carried model selection; a missing/unavailable provider
     * falls back to the deterministic digest with a notice.
     */
    readonly generateBrief: (
      threadId: ThreadId,
    ) => Effect.Effect<{ markdown: string; notices: string[] }, TranscriptBriefError>;
  }
>()("t3/roaming/TranscriptSync") {}

const decodeTranscriptPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingTranscriptPayload),
);
const encodeTranscriptPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(RoamingTranscriptPayload),
);
const decodeBriefPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingBriefPayload),
);
const encodeBriefPayloadJson = Schema.encodeEffect(Schema.fromJsonString(RoamingBriefPayload));

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Reduce a full thread projection to the mirrored presentation payload.
 * Pure — exported for tests. Oversize payloads drop oldest activities first,
 * then oldest messages (the newest turns are what a user reads on the other
 * machine), and set `truncated`.
 */
export const buildTranscriptPayload = (input: {
  readonly thread: OrchestrationThread;
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly capturedAt: string;
  readonly parked?: boolean;
}): RoamingTranscriptPayload => {
  const { thread } = input;
  const messages = thread.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.attachments !== undefined && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        }
      : {}),
    turnId: message.turnId,
    createdAt: message.createdAt,
  }));
  const proposedPlans = thread.proposedPlans.map((plan) => ({
    id: plan.id,
    turnId: plan.turnId,
    planMarkdown: plan.planMarkdown,
    createdAt: plan.createdAt,
  }));
  const activities = thread.activities.map((activity) => {
    const payloadJson = JSON.stringify(activity.payload);
    const oversize =
      payloadJson === undefined ||
      utf8Length(payloadJson) > ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES;
    return {
      id: activity.id,
      tone: activity.tone,
      kind: activity.kind,
      summary: activity.summary,
      ...(oversize ? { payloadTruncated: true } : { payloadJson: payloadJson }),
      turnId: activity.turnId,
      createdAt: activity.createdAt,
    };
  });

  const assemble = (
    keptMessages: typeof messages,
    keptActivities: typeof activities,
    truncated: boolean,
  ): RoamingTranscriptPayload => ({
    schemaVersion: 1,
    threadId: thread.id,
    workspaceProjectId: input.workspaceProjectId,
    title: thread.title,
    branch: thread.branch,
    capturedAt: input.capturedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.latestTurn !== null ? { lastTurnState: thread.latestTurn.state } : {}),
    ...(input.parked === true ? { parked: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    // M5.5: the source model is the resume draft's default on the other
    // machine — carried reduced, never dispatched as-is.
    modelSelection: {
      instanceId: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      ...(thread.modelSelection.options !== undefined && thread.modelSelection.options.length > 0
        ? { options: thread.modelSelection.options }
        : {}),
    },
    messages: keptMessages,
    proposedPlans,
    activities: keptActivities,
  });

  let keptMessages = messages;
  let keptActivities = activities;
  let truncated = false;
  // The serialized size is dominated by messages + activity payloads; drop
  // oldest-first until the whole payload fits the cap.
  for (;;) {
    const size = utf8Length(JSON.stringify(assemble(keptMessages, keptActivities, truncated)));
    if (size <= ROAMING_TRANSCRIPT_MAX_BYTES) {
      break;
    }
    truncated = true;
    if (keptActivities.length > 0) {
      keptActivities = keptActivities.slice(Math.max(1, Math.floor(keptActivities.length / 4)));
      continue;
    }
    if (keptMessages.length > 1) {
      keptMessages = keptMessages.slice(Math.max(1, Math.floor(keptMessages.length / 4)));
      continue;
    }
    // A single gigantic message: hard-truncate its text.
    keptMessages = keptMessages.map((message) => ({
      ...message,
      text: message.text.slice(0, 1_000_000),
    }));
    break;
  }
  return assemble(keptMessages, keptActivities, truncated);
};

/** Role-labelled transcript text for brief generation, newest-biased. */
export const transcriptTextForBrief = (payload: RoamingTranscriptPayload): string => {
  const lines: string[] = [];
  for (const message of payload.messages) {
    lines.push(`[${message.role}] ${message.text}`);
  }
  let text = lines.join("\n\n");
  if (text.length > BRIEF_INPUT_MAX_CHARS) {
    text = `…(earlier conversation omitted)\n\n${text.slice(text.length - BRIEF_INPUT_MAX_CHARS)}`;
  }
  return text;
};

/** Deterministic brief when no provider can generate one. */
export const fallbackBriefMarkdown = (payload: RoamingTranscriptPayload): string => {
  const lastOf = (role: "user" | "assistant") =>
    [...payload.messages].reverse().find((message) => message.role === role)?.text ?? "";
  const clip = (text: string) => (text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text);
  return [
    `# Resuming: ${payload.title}`,
    "",
    payload.branch !== null ? `Branch: \`${payload.branch}\`` : null,
    `Messages: ${payload.messages.length}`,
    "",
    "## Last request",
    clip(lastOf("user")),
    "",
    "## Last assistant reply",
    clip(lastOf("assistant")),
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .slice(0, ROAMING_BRIEF_MAX_CHARS);
};

/** Compare payloads ignoring the capture timestamp (the no-op signal). */
const sameTranscript = (a: RoamingTranscriptPayload, b: RoamingTranscriptPayload): boolean =>
  JSON.stringify({ ...a, capturedAt: "" }) === JSON.stringify({ ...b, capturedAt: "" });

const CAPTURE_EVENT_TYPES = new Set([
  "thread.created",
  "thread.message-sent",
  "thread.turn-diff-completed",
  "thread.meta-updated",
  "thread.proposed-plan-upserted",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.reverted",
]);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

const make = Effect.gen(function* () {
  const peers = yield* RoamingPeers;
  const serverSettings = yield* ServerSettingsService;
  const blobStore = yield* RoamingBlobStore;
  const threadRepository = yield* ProjectionThreadRepository;
  const projectRepository = yield* ProjectionProjectRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const textGeneration = yield* TextGeneration;
  const wipReactor = yield* WipSnapshotReactor;

  const isEnabled = Effect.gen(function* () {
    if (!(yield* peers.roamingEnabled)) {
      return false;
    }
    const settings = yield* serverSettings.getSettings;
    return settings.roamingTranscriptSync;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("roaming transcripts: failed to read settings", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const enrolledWorkspaceProjectId = (projectId: string) =>
    projectRepository.listAll().pipe(
      Effect.map(
        (projects) =>
          projects.find((project) => project.projectId === projectId && project.deletedAt === null)
            ?.workspaceProjectId ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const readOwnTranscript = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* blobStore
        .get({ kind: "transcript", key: threadId })
        .pipe(Effect.orElseSucceed(() => null));
      if (record === null) {
        return null;
      }
      const payload = yield* decodeTranscriptPayloadJson(record.payload).pipe(
        Effect.orElseSucceed(() => null),
      );
      return payload === null ? null : { record, payload };
    });

  const writeTranscript = (payload: RoamingTranscriptPayload) =>
    Effect.gen(function* () {
      const json = yield* encodeTranscriptPayloadJson(payload);
      yield* blobStore.writeLocal({
        kind: "transcript",
        key: payload.threadId,
        workspaceProjectId: payload.workspaceProjectId,
        payload: json,
      });
    });

  /**
   * Capture one thread's transcript, or tombstone it when the thread is
   * gone/archived. `force` bypasses the Conversations flag (park) but never
   * the roaming gate.
   */
  const capture = (
    threadId: ThreadId,
    options: { parked?: boolean; force?: boolean; unpark?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      if (!(yield* peers.roamingEnabled)) {
        return;
      }
      if (options.force !== true && !(yield* isEnabled)) {
        return;
      }
      const existing = yield* readOwnTranscript(threadId);
      const threadRow = yield* threadRepository
        .getById({ threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      // Author-only writes: a transcript blob that arrived from the PEER has
      // no local thread row either — tombstoning it here would win
      // reconciliation and kill the peer's live mirrored thread on both
      // machines (M5 review, critical 1). Only ever tombstone what this
      // machine authored.
      const ownEnvironmentId = yield* serverEnvironment.getEnvironmentId.pipe(
        Effect.orElseSucceed(() => null),
      );

      const tombstone = (workspaceProjectId: WorkspaceProjectId, title: string) =>
        Effect.gen(function* () {
          if (existing === null || existing.payload.deleted === true) {
            return;
          }
          if (existing.record.authorEnvironmentId !== ownEnvironmentId) {
            return;
          }
          const capturedAt = yield* nowIso;
          yield* writeTranscript({
            schemaVersion: 1,
            threadId,
            workspaceProjectId,
            title,
            branch: null,
            capturedAt,
            createdAt: existing.payload.createdAt,
            updatedAt: capturedAt,
            deleted: true,
            messages: [],
            proposedPlans: [],
            activities: [],
          });
        });

      if (Option.isNone(threadRow) || threadRow.value.deletedAt !== null) {
        // Thread gone: tombstone whatever we previously mirrored.
        if (existing !== null) {
          yield* tombstone(existing.payload.workspaceProjectId, existing.payload.title);
        }
        return;
      }
      const workspaceProjectId = yield* enrolledWorkspaceProjectId(threadRow.value.projectId);
      if (workspaceProjectId === null) {
        return;
      }
      if (threadRow.value.archivedAt !== null) {
        yield* tombstone(workspaceProjectId, threadRow.value.title);
        return;
      }
      const detail = yield* snapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(detail)) {
        return;
      }
      const capturedAt = yield* nowIso;
      // `parked` sticks until the author actively continues the conversation
      // (a new user message → `unpark`); passive churn — a turn erroring or
      // completing right after the handoff — must not strip the marker.
      const keepParked =
        options.parked === true || (existing?.payload.parked === true && options.unpark !== true);
      const payload = buildTranscriptPayload({
        thread: detail.value,
        workspaceProjectId,
        capturedAt,
        ...(keepParked ? { parked: true } : {}),
      });
      if (existing !== null && sameTranscript(existing.payload, payload)) {
        return;
      }
      yield* writeTranscript(payload);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming transcripts: capture failed", { threadId, cause }),
      ),
    );

  const worker = yield* makeKeyedCoalescingWorker<
    ThreadId,
    { parked?: boolean; force?: boolean; unpark?: boolean },
    never,
    never
  >({
    merge: (current, next) => ({ ...current, ...next }),
    process: (threadId, options) => capture(threadId, options),
  });

  const captureThread: TranscriptSync["Service"]["captureThread"] = (threadId) =>
    worker.enqueue(threadId, {});

  const captureAll: TranscriptSync["Service"]["captureAll"] = () =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) {
        return;
      }
      const projects = yield* projectRepository.listAll().pipe(Effect.orElseSucceed(() => []));
      for (const project of projects) {
        if (project.deletedAt !== null || project.workspaceProjectId === null) {
          continue;
        }
        const threads = yield* threadRepository
          .listByProjectId({ projectId: project.projectId })
          .pipe(Effect.orElseSucceed(() => []));
        for (const thread of threads) {
          yield* worker.enqueue(thread.threadId, {});
        }
      }
      // Deletions that happened while the server was off: every transcript
      // blob key is a threadId — re-enqueue them all; capture tombstones the
      // ones whose thread row is gone.
      const manifest = yield* blobStore.manifest().pipe(Effect.orElseSucceed(() => []));
      for (const entry of manifest) {
        if (entry.kind === "transcript") {
          yield* worker.enqueue(entry.key as ThreadId, {});
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming transcripts: reconcile failed", { cause }),
      ),
    );

  const writeBrief = (payload: RoamingBriefPayload) =>
    Effect.gen(function* () {
      const json = yield* encodeBriefPayloadJson(payload);
      yield* blobStore.writeLocal({
        kind: "brief",
        key: payload.threadId,
        workspaceProjectId: payload.workspaceProjectId,
        payload: json,
      });
    });

  const park: TranscriptSync["Service"]["park"] = (threadId) =>
    Effect.gen(function* () {
      const threadRow = yield* threadRepository
        .getById({ threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(threadRow) || threadRow.value.deletedAt !== null) {
        return yield* new TranscriptParkError({ reason: "thread-not-found" });
      }
      const workspaceProjectId = yield* enrolledWorkspaceProjectId(threadRow.value.projectId);
      if (workspaceProjectId === null) {
        return yield* new TranscriptParkError({ reason: "project-not-enrolled" });
      }
      const notices: string[] = [];
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (settings !== null && !settings.roamingTranscriptSync) {
        notices.push(
          "Conversation sync is off — this conversation was mirrored for the handoff anyway.",
        );
      }

      // Final transcript capture, marked parked — through the worker, so it
      // can never interleave with an in-flight event capture (a direct call
      // raced one and the plain rebuild overwrote the parked payload); drain
      // so the response reflects a completed capture. The worker's merge
      // spreads options, so a coalesced plain enqueue keeps `parked`.
      yield* worker.enqueue(threadId, { parked: true, force: true });
      yield* worker.drainKey(threadId);

      // Final WIP snapshot: consent-gated, skip-not-fail.
      if (settings !== null && settings.roamingWipSync) {
        yield* wipReactor.snapshotProject(workspaceProjectId);
        notices.push("Final work-in-progress snapshot requested.");
      } else {
        notices.push("Work-in-progress snapshot skipped: Work in progress sync is off.");
      }

      // Brief: agent-generated via the background text-generation job;
      // deterministic fallback (with notice) when no provider answers.
      const transcript = yield* readOwnTranscript(threadId);
      if (transcript === null) {
        return yield* new TranscriptParkError({
          reason: "internal",
          detail: "transcript capture produced no payload",
        });
      }
      const project = yield* projectRepository.listAll().pipe(
        Effect.map((projects) =>
          projects.find((candidate) => candidate.projectId === threadRow.value.projectId),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      const generated = yield* textGeneration
        .generateResumptionBrief({
          cwd: project?.workspaceRoot ?? ".",
          title: transcript.payload.title,
          branch: transcript.payload.branch,
          transcriptText: transcriptTextForBrief(transcript.payload),
          modelSelection: threadRow.value.modelSelection,
        })
        .pipe(
          Effect.map((result) => result.markdown),
          Effect.catch((error) =>
            Effect.logWarning("roaming transcripts: brief generation fell back", {
              threadId,
              error,
            }).pipe(
              Effect.andThen(() => {
                notices.push(
                  "Brief was assembled without an agent (no provider could generate it) — edit it before resuming.",
                );
                return Effect.succeed(fallbackBriefMarkdown(transcript.payload));
              }),
            ),
          ),
        );
      const generatedAt = yield* nowIso;
      const brief: RoamingBriefPayload = {
        schemaVersion: 1,
        threadId,
        workspaceProjectId,
        markdown: generated.slice(0, ROAMING_BRIEF_MAX_CHARS),
        generatedAt,
      };
      yield* writeBrief(brief).pipe(
        Effect.mapError(
          (cause) => new TranscriptParkError({ reason: "internal", detail: String(cause) }),
        ),
      );
      return { brief, notices };
    });

  const generateBrief: TranscriptSync["Service"]["generateBrief"] = (threadId) =>
    Effect.gen(function* () {
      const transcript = yield* readOwnTranscript(threadId);
      if (transcript === null) {
        return yield* new TranscriptBriefError({ reason: "thread-unknown" });
      }
      const payload = transcript.payload;
      const notices: string[] = [];
      // Provider CLIs need a working directory; the materialized local
      // checkout when one exists, else the process cwd.
      const project = yield* projectRepository.listAll().pipe(
        Effect.map((projects) =>
          projects.find((candidate) => candidate.workspaceProjectId === payload.workspaceProjectId),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      const modelSelection =
        payload.modelSelection === undefined
          ? null
          : yield* decodeModelSelection(payload.modelSelection).pipe(
              Effect.orElseSucceed(() => null),
            );
      const fallback = (notice: string) => {
        notices.push(notice);
        return fallbackBriefMarkdown(payload);
      };
      const markdown =
        modelSelection === null
          ? fallback(
              "Brief was assembled without an agent (the conversation carries no usable model) — edit it before sending.",
            )
          : yield* textGeneration
              .generateResumptionBrief({
                cwd: project?.workspaceRoot ?? ".",
                title: payload.title,
                branch: payload.branch,
                transcriptText: transcriptTextForBrief(payload),
                modelSelection,
              })
              .pipe(
                Effect.map((result) => result.markdown),
                Effect.catch((error) =>
                  Effect.logWarning("roaming transcripts: resume brief fell back", {
                    threadId,
                    error,
                  }).pipe(
                    Effect.andThen(() =>
                      Effect.succeed(
                        fallback(
                          "Brief was assembled without an agent (no provider could generate it) — edit it before sending.",
                        ),
                      ),
                    ),
                  ),
                ),
              );
      return { markdown: markdown.slice(0, ROAMING_BRIEF_MAX_CHARS), notices };
    });

  const saveBrief: TranscriptSync["Service"]["saveBrief"] = (threadId, markdown) =>
    Effect.gen(function* () {
      // Anchor on an existing brief or transcript — a brief for a thread this
      // machine has never seen is a client error, not a write.
      const existingBrief = yield* blobStore
        .get({ kind: "brief", key: threadId })
        .pipe(Effect.orElseSucceed(() => null));
      const existingPayload =
        existingBrief === null
          ? null
          : yield* decodeBriefPayloadJson(existingBrief.payload).pipe(
              Effect.orElseSucceed(() => null),
            );
      let workspaceProjectId = existingPayload?.workspaceProjectId ?? null;
      let generatedAt = existingPayload?.generatedAt ?? null;
      if (workspaceProjectId === null) {
        const transcript = yield* blobStore
          .get({ kind: "transcript", key: threadId })
          .pipe(Effect.orElseSucceed(() => null));
        if (transcript !== null) {
          const payload = yield* decodeTranscriptPayloadJson(transcript.payload).pipe(
            Effect.orElseSucceed(() => null),
          );
          workspaceProjectId = payload?.workspaceProjectId ?? null;
        }
      }
      if (workspaceProjectId === null) {
        return yield* new TranscriptBriefError({ reason: "thread-unknown" });
      }
      const editedAt = yield* nowIso;
      const brief: RoamingBriefPayload = {
        schemaVersion: 1,
        threadId,
        workspaceProjectId,
        markdown: markdown.slice(0, ROAMING_BRIEF_MAX_CHARS),
        generatedAt: generatedAt ?? editedAt,
        editedAt,
      };
      yield* writeBrief(brief).pipe(
        Effect.mapError(
          (cause) => new TranscriptBriefError({ reason: "internal", detail: String(cause) }),
        ),
      );
      return brief;
    });

  const start: TranscriptSync["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* captureAll();

      // Thread lifecycle events → capture that thread (coalesced). Activity
      // events are deliberately excluded: transcripts ship at turn/message
      // boundaries, not per streaming delta.
      yield* Effect.forkScoped(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (
            !CAPTURE_EVENT_TYPES.has(event.type) ||
            typeof (event.payload as { threadId?: unknown }).threadId !== "string"
          ) {
            return Effect.void;
          }
          const payload = event.payload as { threadId: ThreadId; role?: unknown };
          // A new user message is the author continuing the conversation —
          // that (and only that) clears a parked marker.
          const unpark = event.type === "thread.message-sent" && payload.role === "user";
          return worker.enqueue(payload.threadId, unpark ? { unpark: true } : {});
        }).pipe(Effect.ignoreCause({ log: true })),
      );

      // Settings changes (Conversations toggled on) and peer changes (the
      // derived gate flips at pairing) both warrant a reconcile pass.
      yield* Effect.forkScoped(
        Stream.runForEach(serverSettings.streamChanges, () => captureAll()).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const peerChanges = yield* peers.subscribeChanges;
          return yield* Effect.forever(PubSub.take(peerChanges).pipe(Effect.andThen(captureAll())));
        }),
      );
    });

  return {
    start,
    captureThread,
    captureAll,
    park,
    saveBrief,
    generateBrief,
  } satisfies TranscriptSync["Service"];
});

export const layer = Layer.effect(TranscriptSync, make);
