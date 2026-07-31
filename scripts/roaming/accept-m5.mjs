// M5 briefs + transcripts acceptance on the fresh M0 two-instance harness.
// Exit criteria: threads from A readable on B (mirrored transcript, shell
// row, never in A's own mirrored list); briefs are user-editable and
// mirror (hand-off/park removed 2026-07-31); deletion mirrors as a
// tombstone; and B's restart/reconcile never tombstones A's live
// transcripts (author-only writes — the M5 review critical). Transcripts
// ride the P2P mirror only, so there are no transport variants. The
// canonical pairing walk remains accept-m2.5.mjs and is rerun separately.
//
// M5.5 note: the product resume flow is now a pre-filled DRAFT (see
// accept-m55.mjs); this script's resume leg survives as the server-visible
// half only — a new local thread created with the brief text — which still
// pins "resume threads are ordinary local threads, never mirrored back".

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  A,
  B,
  HARNESS_DIR,
  api,
  cli,
  fail,
  harness,
  hasRoamingPeers,
  makeGitTrimmed,
  pass,
  readSettings,
  sleep,
  waitFor,
} from "./harness-lib.mjs";

const git = makeGitTrimmed("m5");
const { randomUUID } = NodeCrypto;
const { mkdirSync, rmSync, writeFileSync } = NodeFS;
const { join } = NodePath;

const ADMIN_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
];

const MODEL = { instanceId: "codex", model: "gpt-5.2" };

const shellOf = async (instance, token) => {
  const response = await api(instance.url, "/api/orchestration/shell", { token });
  return response.ok ? response.json() : null;
};

const dispatch = async (instance, token, command) => {
  const response = await api(instance.url, "/api/orchestration/dispatch", {
    method: "POST",
    token,
    body: command,
  });
  if (!response.ok) fail(`dispatch ${command.type}`, `${response.status}`);
  return response;
};

const transcriptOf = async (instance, token, threadId) => {
  const response = await api(instance.url, "/api/roaming/threads/transcript", {
    method: "POST",
    token,
    body: { threadId },
  });
  return response.ok ? response.json() : null;
};

// ── Preflight: fresh harness ─────────────────────────────────────────────
for (const instance of [A, B]) {
  const up = await api(instance.url, "/.well-known/t3/environment").then(
    (response) => response.ok,
    () => false,
  );
  if (!up) fail("preflight", `${instance.url} is not running`);
  if (hasRoamingPeers(instance.base)) fail("preflight", "harness is not fresh");
}
pass("fresh M0 harness");

let adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
let adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const envA = (await (await api(A.url, "/.well-known/t3/environment")).json()).environmentId;

// ── Setup: repo + project on A, pair once with Conversations on ──────────
const work = join(HARNESS_DIR, "m5-primary-work");
const origin = join(HARNESS_DIR, "m5-primary-origin.git");
rmSync(work, { recursive: true, force: true });
rmSync(origin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", origin]);
git(["init", "-b", "main", work]);
writeFileSync(join(work, "README.md"), "M5 Primary\n");
git(["-C", work, "add", "."]);
git(["-C", work, "commit", "-m", "base"]);
git(["-C", work, "remote", "add", "origin", origin]);
git(["-C", work, "push", "origin", "main"]);
const projectId = `m5-primary-${randomUUID()}`;
await dispatch(A, adminA, {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: "M5 Primary",
  workspaceRoot: work,
  createdAt: new Date().toISOString(),
});

const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "M5 other machine", scopes: ADMIN_SCOPES },
});
if (!codeResponse.ok) fail("pairing code", `${codeResponse.status}`);
const paired = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: (await codeResponse.json()).credential,
    syncOptions: { secretsSync: true, wipSync: true, transcriptSync: true },
  },
});
if (!paired.ok || (await paired.json()).peer === null) fail("pairing", `${paired.status}`);

// ONE Conversations decision applied to both machines (first pairing).
await waitFor("transcript consent lands on both machines", 30_000, async () => {
  const a = readSettings(A).roamingTranscriptSync === true;
  const b = readSettings(B).roamingTranscriptSync === true;
  return a && b ? true : null;
});
pass("paired once with Conversations enabled on both machines");

// ── A thread from A is readable on B ─────────────────────────────────────
const threadId = randomUUID();
await dispatch(A, adminA, {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: "Fix the login flow",
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
const USER_TEXT = "Please fix the login flow — the token refresh loops forever.";
await dispatch(A, adminA, {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: { messageId: randomUUID(), role: "user", text: USER_TEXT, attachments: [] },
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});

const rowOnB = await waitFor("mirrored thread row reaches B's shell", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  return shell?.roamingThreads?.find((candidate) => candidate.threadId === threadId) ?? null;
});
if (rowOnB.authorEnvironmentId !== envA) fail("shell row", "author is not A");
if (rowOnB.title !== "Fix the login flow") fail("shell row", `title: ${rowOnB.title}`);
const mirrored = await transcriptOf(B, adminB, threadId);
if (!mirrored?.transcript) fail("transcript on B", "route returned no transcript");
if (!mirrored.transcript.messages.some((message) => message.text === USER_TEXT))
  fail("transcript on B", "user message did not mirror");
if (mirrored.authorEnvironmentId !== envA) fail("transcript on B", "author is not A");
pass("thread from A is readable on B (shell row + transcript content)");

// The author machine never lists its own threads as mirrored.
const shellA = await shellOf(A, adminA);
if (shellA?.roamingThreads?.some((candidate) => candidate.threadId === threadId))
  fail("author filter", "A lists its own thread as mirrored");
pass("A's own thread is not in A's mirrored list");

// ── Briefs are user-editable and mirror to B (hand-off/park removed
// 2026-07-31 — a brief is now written via save, generated on demand by
// the resuming machine) ────────────────────────────────────────────────
const EDITED_BRIEF = `# Resuming: Fix the login flow\n\nEDITED-ON-A ${randomUUID()}`;
const saved = await api(A.url, "/api/roaming/briefs/save", {
  method: "POST",
  token: adminA,
  body: { threadId, markdown: EDITED_BRIEF },
});
if (!saved.ok) fail("brief save", `${saved.status}`);
if (!(await saved.json()).brief.editedAt) fail("brief save", "editedAt missing");
pass("brief saved on A");

await waitFor("edited brief reaches B", 120_000, async () => {
  const remote = await transcriptOf(B, adminB, threadId);
  return remote?.brief?.markdown === EDITED_BRIEF ? remote : null;
});
await waitFor("B's shell row shows the brief", 60_000, async () => {
  const shell = await shellOf(B, adminB);
  const row = shell?.roamingThreads?.find((candidate) => candidate.threadId === threadId);
  return row?.hasBrief === true ? true : null;
});
pass("edited brief mirrored to B");

// ── Resume on B: materialize, then seed a new local thread from the brief ─
const bRoot = join(HARNESS_DIR, "m5-b-workspace");
const bWork = join(bRoot, "primary");
rmSync(bRoot, { recursive: true, force: true });
mkdirSync(bRoot, { recursive: true });
const materialized = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: rowOnB.workspaceProjectId, targetPath: bWork },
});
if (!materialized.ok) fail("materialize", `${materialized.status}`);
const materialization = (await materialized.json()).materialization;
if (materialization.status !== "completed") fail("materialize", "did not complete");
const localProjectIdOnB = materialization.localProjectId;
if (!localProjectIdOnB) fail("materialize", "no localProjectId");

// The web UI resumes through the client RPC's atomic bootstrap; the raw
// dispatch endpoint takes the server commands, so the script does the same
// two steps explicitly.
const resumeThreadId = randomUUID();
await dispatch(B, adminB, {
  type: "thread.create",
  commandId: randomUUID(),
  threadId: resumeThreadId,
  projectId: localProjectIdOnB,
  title: "Fix the login flow",
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
await dispatch(B, adminB, {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId: resumeThreadId,
  message: { messageId: randomUUID(), role: "user", text: EDITED_BRIEF, attachments: [] },
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});
const resumeDetail = await waitFor("resumed thread exists on B", 60_000, async () => {
  const response = await api(B.url, `/api/orchestration/threads/${resumeThreadId}`, {
    token: adminB,
  });
  if (!response.ok) return null;
  const detail = await response.json();
  return detail.thread?.messages?.[0]?.text === EDITED_BRIEF ? detail : null;
});
if (resumeDetail.thread.projectId !== localProjectIdOnB)
  fail("resume", "thread not in the materialized project");
pass("resume seeds a NEW local thread on B with the brief as its first message");

// The resumed thread is B-local: it must never surface as mirrored on B.
const shellB = await shellOf(B, adminB);
if (shellB?.roamingThreads?.some((candidate) => candidate.threadId === resumeThreadId))
  fail("resume", "resumed local thread leaked into B's mirrored list");
pass("resumed thread is local, not mirrored");

// ── Author-only tombstones: B restart must not kill A's transcripts ──────
harness("stop");
harness("start");
await waitFor("harness back up", 120_000, async () => {
  const upA = await api(A.url, "/.well-known/t3/environment").then(
    (response) => response.ok,
    () => false,
  );
  const upB = await api(B.url, "/.well-known/t3/environment").then(
    (response) => response.ok,
    () => false,
  );
  return upA && upB ? true : null;
});
adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
// B's startup reconcile re-enqueues every transcript key (including A's);
// give it time to (wrongly) tombstone and mirror back before asserting.
await sleep(20_000);
const survivedOnB = await transcriptOf(B, adminB, threadId);
if (survivedOnB?.transcript?.deleted === true)
  fail("author-only tombstones", "B tombstoned A's transcript after restart");
const survivedOnA = await transcriptOf(A, adminA, threadId);
if (survivedOnA?.transcript?.deleted === true)
  fail("author-only tombstones", "a foreign tombstone reached A");
if (!survivedOnB?.transcript || !survivedOnA?.transcript)
  fail("author-only tombstones", "transcript vanished across restart");
pass("restart reconcile leaves peer-authored transcripts alone (author-only writes)");

// ── Deletion mirrors as a tombstone ──────────────────────────────────────
await dispatch(A, adminA, { type: "thread.delete", commandId: randomUUID(), threadId });
await waitFor("tombstone removes B's mirrored row", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  const present = shell?.roamingThreads?.some((candidate) => candidate.threadId === threadId);
  return present ? null : true;
});
const tombstoned = await transcriptOf(B, adminB, threadId);
if (tombstoned?.transcript?.deleted !== true)
  fail("tombstone", "B's transcript blob is not a tombstone");
pass("deleting the thread on A removes it from B (tombstone payload)");

console.log("\nM5 acceptance: ALL PASS");
