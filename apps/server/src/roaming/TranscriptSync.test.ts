import {
  ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES,
  ROAMING_TRANSCRIPT_MAX_BYTES,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  WorkspaceProjectId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  buildTranscriptPayload,
  fallbackBriefMarkdown,
  transcriptTextForBrief,
} from "./TranscriptSync.ts";

const WORKSPACE_PROJECT_ID = WorkspaceProjectId.make("wp-1");

const makeThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: ThreadId.make("thread-1"),
    projectId: "project-1",
    title: "Fix the login flow",
    modelSelection: { instanceId: "codex", model: "gpt" },
    runtimeMode: "local",
    interactionMode: "default",
    branch: "feature/login",
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-2"),
      state: "completed",
      requestedAt: "2026-07-22T10:00:00.000Z",
      startedAt: "2026-07-22T10:00:01.000Z",
      completedAt: "2026-07-22T10:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T10:01:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("m-1"),
        role: "user",
        text: "Please fix the login flow",
        attachments: [
          { type: "image", id: "att-1", name: "bug.png", mimeType: "image/png", sizeBytes: 123 },
        ],
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-07-22T09:00:00.000Z",
        updatedAt: "2026-07-22T09:00:00.000Z",
      },
      {
        id: MessageId.make("m-2"),
        role: "assistant",
        text: "Done — the token refresh was broken.",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-07-22T09:01:00.000Z",
        updatedAt: "2026-07-22T09:01:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: EventId.make("e-1"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Edited auth.ts",
        payload: { path: "auth.ts" },
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-07-22T09:00:30.000Z",
      },
    ],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as OrchestrationThread;

describe("buildTranscriptPayload", () => {
  it("reduces the projection: messages, attachment metadata, activity payload JSON", () => {
    const payload = buildTranscriptPayload({
      thread: makeThread(),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
    });
    assert.equal(payload.threadId, "thread-1");
    assert.equal(payload.title, "Fix the login flow");
    assert.equal(payload.branch, "feature/login");
    assert.equal(payload.lastTurnState, "completed");
    assert.equal(payload.messages.length, 2);
    // Attachment bytes do not roam — only name/mime/size metadata.
    assert.deepEqual(payload.messages[0]?.attachments, [
      { name: "bug.png", mimeType: "image/png", sizeBytes: 123 },
    ]);
    assert.equal(payload.activities[0]?.payloadJson, '{"path":"auth.ts"}');
    assert.equal(payload.parked, undefined);
    assert.equal(payload.truncated, undefined);
  });

  it("marks parked captures", () => {
    const payload = buildTranscriptPayload({
      thread: makeThread(),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
      parked: true,
    });
    assert.equal(payload.parked, true);
  });

  it("ships oversize activity payloads summary-only", () => {
    const big = "x".repeat(ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES + 1);
    const thread = makeThread();
    const payload = buildTranscriptPayload({
      thread: makeThread({
        activities: [{ ...thread.activities[0]!, payload: { blob: big } }],
      }),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
    });
    assert.equal(payload.activities[0]?.payloadJson, undefined);
    assert.equal(payload.activities[0]?.payloadTruncated, true);
    assert.equal(payload.activities[0]?.summary, "Edited auth.ts");
  });

  it("drops oldest entries and flags truncation when the whole payload exceeds the cap", () => {
    const thread = makeThread();
    const chunk = "y".repeat(10_000);
    const messages = Array.from({ length: 600 }, (_, index) => ({
      ...thread.messages[0]!,
      id: MessageId.make(`m-${index}`),
      attachments: undefined,
      text: `${index}:${chunk}`,
    }));
    const payload = buildTranscriptPayload({
      thread: makeThread({ messages, activities: [] }),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
    });
    assert.equal(payload.truncated, true);
    assert.isBelow(
      Buffer.byteLength(JSON.stringify(payload), "utf8"),
      ROAMING_TRANSCRIPT_MAX_BYTES + 1,
    );
    // The NEWEST messages survive.
    assert.equal(payload.messages.at(-1)?.text.startsWith("599:"), true);
  });
});

describe("brief helpers", () => {
  it("transcriptTextForBrief keeps the newest conversation under the budget", () => {
    const payload = buildTranscriptPayload({
      thread: makeThread(),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
    });
    const text = transcriptTextForBrief(payload);
    assert.include(text, "[user] Please fix the login flow");
    assert.include(text, "[assistant] Done — the token refresh was broken.");
  });

  it("fallbackBriefMarkdown digests title, branch, and last exchanges", () => {
    const payload = buildTranscriptPayload({
      thread: makeThread(),
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      capturedAt: "2026-07-22T11:00:00.000Z",
    });
    const markdown = fallbackBriefMarkdown(payload);
    assert.include(markdown, "# Resuming: Fix the login flow");
    assert.include(markdown, "Branch: `feature/login`");
    assert.include(markdown, "Please fix the login flow");
    assert.include(markdown, "Done — the token refresh was broken.");
  });
});
