// M5.5 surfacing-corrective acceptance on the fresh M0 two-instance harness.
// Server-verifiable exit criteria:
//   - the transcript payload carries the source thread's modelSelection
//     (the resume draft's picker default on the other machine);
//   - resume needs ZERO preparation on the source machine: B generates a
//     brief from its local transcript copy (stateless — no blob written);
//   - the author machine NEVER lists its own thread as mirrored, including
//     the delete-race window before the tombstone lands (correction e);
//   - a source thread continued locally is superseded by the resumed thread
//     exactly while that thread exists (correction d).
// The one-row-per-thread and greyed-fallback criteria are client-side
// (reachability is a browser-connection property) and are verified by the
// M5.5 browser walk on the same harness; the canonical pairing walk remains
// accept-m2.5.mjs and is rerun separately.

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
  hasRoamingPeers,
  makeGitTrimmed,
  pass,
  readSettings,
  sleep,
  waitFor,
} from "./harness-lib.mjs";

const git = makeGitTrimmed("m55");
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

const createThreadOnA = async (adminA, projectId, threadId, title, text) => {
  await dispatch(A, adminA, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    title,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  await dispatch(A, adminA, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
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

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);

// ── Setup: repo + project on A, pair once with Conversations on ──────────
const work = join(HARNESS_DIR, "m55-primary-work");
const origin = join(HARNESS_DIR, "m55-primary-origin.git");
rmSync(work, { recursive: true, force: true });
rmSync(origin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", origin]);
git(["init", "-b", "main", work]);
writeFileSync(join(work, "README.md"), "M5.5 Primary\n");
git(["-C", work, "add", "."]);
git(["-C", work, "commit", "-m", "base"]);
git(["-C", work, "remote", "add", "origin", origin]);
git(["-C", work, "push", "origin", "main"]);
const projectId = `m55-primary-${randomUUID()}`;
await dispatch(A, adminA, {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: "M5.5 Primary",
  workspaceRoot: work,
  createdAt: new Date().toISOString(),
});

const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "M5.5 other machine", scopes: ADMIN_SCOPES },
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
await waitFor("transcript consent lands on both machines", 30_000, async () => {
  const a = readSettings(A).roamingTranscriptSync === true;
  const b = readSettings(B).roamingTranscriptSync === true;
  return a && b ? true : null;
});
pass("paired once with Conversations enabled on both machines");

// ── Two threads on A mirror to B; neither is mirrored on A ───────────────
const sourceThreadId = randomUUID();
const raceThreadId = randomUUID();
await createThreadOnA(
  adminA,
  projectId,
  sourceThreadId,
  "Fix the login flow",
  "Please fix the login flow — the token refresh loops forever.",
);
await createThreadOnA(
  adminA,
  projectId,
  raceThreadId,
  "Delete race probe",
  "This thread exists to be deleted while B watches.",
);
const rowOnB = await waitFor("both mirrored rows reach B's shell", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  const source = shell?.roamingThreads?.find((candidate) => candidate.threadId === sourceThreadId);
  const race = shell?.roamingThreads?.find((candidate) => candidate.threadId === raceThreadId);
  return source && race ? source : null;
});
const shellA = await shellOf(A, adminA);
for (const threadId of [sourceThreadId, raceThreadId]) {
  if (shellA?.roamingThreads?.some((candidate) => candidate.threadId === threadId))
    fail("author filter", "A lists its own thread as mirrored");
}
pass("threads from A are mirrored on B and never on A");

// ── The transcript payload carries the source modelSelection ─────────────
const mirrored = await transcriptOf(B, adminB, sourceThreadId);
if (!mirrored?.transcript) fail("transcript on B", "route returned no transcript");
const carried = mirrored.transcript.modelSelection;
if (carried?.instanceId !== MODEL.instanceId || carried?.model !== MODEL.model)
  fail("modelSelection", `payload carries ${JSON.stringify(carried)}`);
pass("transcript payload carries the source thread's modelSelection");

// ── Resume needs zero source-machine preparation: brief generated on B ───
// No park happened. B builds the brief from its local copy; with no provider
// configured in the harness this is the deterministic fallback + notice —
// exactly the honest path the product promises.
const generated = await api(B.url, "/api/roaming/briefs/generate", {
  method: "POST",
  token: adminB,
  body: { threadId: sourceThreadId },
});
if (!generated.ok) fail("brief generate", `${generated.status}`);
const generatedBody = await generated.json();
if (!generatedBody.markdown?.length) fail("brief generate", "no markdown");
if (!Array.isArray(generatedBody.notices)) fail("brief generate", "no notices array");
// Stateless: generation must not have written a brief blob.
const afterGenerate = await transcriptOf(B, adminB, sourceThreadId);
if (afterGenerate?.brief !== null) fail("brief generate", "wrote a brief blob");
pass(`B generated a resume brief locally, statelessly (${generatedBody.notices.length} notices)`);

// ── Supersession: continue-here hides the source row exactly while the ───
// resumed thread exists (correction d)
const bRoot = join(HARNESS_DIR, "m55-b-workspace");
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

// The web flow records the link at DRAFT creation, before the thread exists.
// The row must keep surfacing until the resumed thread is real.
const resumeThreadId = randomUUID();
const linkResponse = await api(B.url, "/api/roaming/threads/resumed", {
  method: "POST",
  token: adminB,
  body: { sourceThreadId, resumedThreadId: resumeThreadId },
});
if (!linkResponse.ok) fail("resumed link", `${linkResponse.status}`);
const shellBeforeThread = await shellOf(B, adminB);
if (!shellBeforeThread?.roamingThreads?.some((candidate) => candidate.threadId === sourceThreadId))
  fail("supersession", "source row vanished before the resumed thread exists");
pass("resumed link alone does not hide the source row (draft not sent yet)");

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
await waitFor("source row superseded once the resumed thread exists", 30_000, async () => {
  const shell = await shellOf(B, adminB);
  const present = shell?.roamingThreads?.some((candidate) => candidate.threadId === sourceThreadId);
  return present ? null : true;
});
const shellWithResume = await shellOf(B, adminB);
if (shellWithResume?.roamingThreads?.some((candidate) => candidate.threadId === resumeThreadId))
  fail("supersession", "resumed local thread leaked into B's mirrored list");
pass("source row superseded by the resumed local thread");

// Deleting the resumed thread brings the fallback row back.
await dispatch(B, adminB, {
  type: "thread.delete",
  commandId: randomUUID(),
  threadId: resumeThreadId,
});
await waitFor("deleting the resumed thread restores the fallback row", 30_000, async () => {
  const shell = await shellOf(B, adminB);
  return shell?.roamingThreads?.some((candidate) => candidate.threadId === sourceThreadId)
    ? true
    : null;
});
pass("fallback row returns when the resumed thread is deleted");

// ── Delete race (correction e): the author never sees its own corpse ─────
await dispatch(A, adminA, {
  type: "thread.delete",
  commandId: randomUUID(),
  threadId: raceThreadId,
});
// Tight-poll the exact window between the projection row disappearing and
// the tombstone landing — the window that produced the field bug.
const raceDeadline = Date.now() + 8_000;
while (Date.now() < raceDeadline) {
  const shell = await shellOf(A, adminA);
  if (shell?.roamingThreads?.some((candidate) => candidate.threadId === raceThreadId))
    fail("delete race", "A rendered its own deleted thread as mirrored");
  await sleep(200);
}
pass("A never lists its own deleted thread as mirrored (tombstone-race window)");

await waitFor("tombstone removes B's mirrored row", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  const present = shell?.roamingThreads?.some((candidate) => candidate.threadId === raceThreadId);
  return present ? null : true;
});
const tombstoned = await transcriptOf(B, adminB, raceThreadId);
if (tombstoned?.transcript?.deleted !== true)
  fail("tombstone", "B's transcript blob is not a tombstone");
pass("deleting the thread on A removes it everywhere (tombstone payload)");

console.log("\nM5.5 acceptance: ALL PASS");
