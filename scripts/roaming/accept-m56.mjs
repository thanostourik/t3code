// M5.6 bidirectional-pairing acceptance (standing-channel model,
// 2026-08-01) on the fresh M0 two-instance harness. B initiates the one
// handshake into A; ONE run walks the whole network-access toggle story:
//
//   1. Paired while B is loopback-only → A holds NO registration (a
//      loopback address names the READER's machine — the 2026-07-31 field
//      bug), and pairing still succeeds one-directionally.
//   2. B restarts bound 0.0.0.0 — NO re-pairing — and its startup mirror
//      pass pushes the registration over the standing mirror credential:
//      A now hands its clients {B's envId, label, routable URL, token};
//      the token reads B's shell (projects + threads — the live half) but
//      cannot call administrative routes; B's own list stays empty.
//   3. B restarts loopback-only again → its pass WITHDRAWS the
//      registration and revokes the session: A's copy disappears and the
//      old token dies (honest offline).
//   4. Teardown both ways: unpairing on B revokes the reverse session;
//      unpairing on A drops the registration.
//
// The row presentation (live rows while B is reachable, greyed fallbacks
// when not) is client-side and verified by the browser walk on the same
// harness; the canonical pairing walk remains accept-m2.5.mjs.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  A,
  B,
  HARNESS_DIR,
  REPO_ROOT,
  api,
  cli,
  fail,
  hasRoamingPeers,
  makeGitTrimmed,
  pass,
  waitFor,
} from "./harness-lib.mjs";

const git = makeGitTrimmed("m56");
const { execFileSync } = NodeChildProcess;
const { randomUUID } = NodeCrypto;
const { readFileSync, rmSync, writeFileSync } = NodeFS;
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

const dispatch = async (instance, token, command) => {
  const response = await api(instance.url, "/api/orchestration/dispatch", {
    method: "POST",
    token,
    body: command,
  });
  if (!response.ok) fail(`dispatch ${command.type}`, `${response.status}`);
};

const listRegistrations = (instance, token) =>
  api(instance.url, "/api/roaming/attach-registration/list", { method: "POST", token, body: {} });

const registrationsOn = async (instance, token) => {
  const response = await listRegistrations(instance, token);
  if (!response.ok) fail("registration list", `${response.status}`);
  return (await response.json()).registrations;
};

/** Restart instance B on the given bind host, same base dir (no re-pair). */
const restartB = (bindHost) => {
  const pidPath = join(HARNESS_DIR, "instance-b/server.pid");
  try {
    process.kill(Number(readFileSync(pidPath, "utf8").trim()));
  } catch {
    // already down
  }
  rmSync(pidPath, { force: true });
  execFileSync(join(REPO_ROOT, "scripts/roaming/harness.sh"), ["start"], {
    encoding: "utf8",
    env: { ...process.env, T3_ROAMING_HARNESS_BIND: bindHost },
  });
};

// ── Preflight: fresh harness (loopback-bound — the default) ──────────────
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
const envA = (await (await api(A.url, "/.well-known/t3/environment")).json()).environmentId;
const envB = (await (await api(B.url, "/.well-known/t3/environment")).json()).environmentId;

// ── Gate: the list route does not exist before pairing ───────────────────
if ((await listRegistrations(A, adminA)).status !== 404) {
  fail("pre-pairing gate", "attach-registration/list answered before any peer exists");
}
pass("attach-registration list 404s while roaming is off");

// ── Setup: repo + project + thread on B (the initiator) ──────────────────
const work = join(HARNESS_DIR, "m56-initiator-work");
const origin = join(HARNESS_DIR, "m56-initiator-origin.git");
rmSync(work, { recursive: true, force: true });
rmSync(origin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", origin]);
git(["init", "-b", "main", work]);
writeFileSync(join(work, "README.md"), "M5.6 Initiator\n");
git(["-C", work, "add", "."]);
git(["-C", work, "commit", "-m", "base"]);
git(["-C", work, "remote", "add", "origin", origin]);
git(["-C", work, "push", "origin", "main"]);
const projectId = `m56-initiator-${randomUUID()}`;
const threadId = randomUUID();
await dispatch(B, adminB, {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: "M5.6 Initiator",
  workspaceRoot: work,
  createdAt: new Date().toISOString(),
});
await dispatch(B, adminB, {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: "M5.6 thread on the initiator",
  modelSelection: { instanceId: "codex", model: "gpt-5.2" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
pass("project + thread created on B");

// ── The one handshake: B (loopback-only) pairs into A ────────────────────
const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "M5.6 initiator", scopes: ADMIN_SCOPES },
});
if (!codeResponse.ok) fail("pairing code", `${codeResponse.status}`);
const paired = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: (await codeResponse.json()).credential,
    syncOptions: { secretsSync: true, wipSync: false, transcriptSync: true },
  },
});
if (!paired.ok || (await paired.json()).peer === null) fail("pairing", `${paired.status}`);
pass("paired once (B initiated into A, while loopback-only)");

// ── 1. Loopback-only: nothing registered (field-bug regression) ──────────
// The pairing's syncNow already ran a pass; give one interval-free beat.
await new Promise((resolve) => setTimeout(resolve, 3000));
if ((await registrationsOn(A, adminA)).length !== 0) {
  fail("loopback advertisement", "a loopback-only initiator registered an address");
}
pass("loopback-only initiator registers nothing (field-bug regression)");

// ── 2. Enable network access: restart B routable, NO re-pairing ──────────
restartB("0.0.0.0");
const registration = await waitFor(
  "registration arrives via the standing channel",
  90_000,
  async () => {
    const registrations = await registrationsOn(A, adminA);
    return registrations.length === 1 ? registrations[0] : null;
  },
);
if (registration.environmentId !== envB) {
  fail("standing registration", `names ${registration.environmentId}, expected B (${envB})`);
}
if (registration.baseUrls.some((url) => /\/\/(127\.|localhost|\[::1\])/.test(url))) {
  fail("standing registration", `advertised a loopback URL: ${registration.baseUrls.join(", ")}`);
}
if (!registration.label) fail("standing registration", "registration has no label");
const listedHeaders = await listRegistrations(A, adminA);
if (listedHeaders.headers.get("cache-control") !== "no-store") {
  fail("standing registration", "token response is missing cache-control: no-store");
}
pass(`toggle ON → registration arrived, no re-pair (${registration.baseUrls.join(", ")})`);

if ((await registrationsOn(B, adminB)).length !== 0) {
  fail("initiator registration list", "the initiator must hold no reverse registration");
}
pass("initiator side holds no registration (one-directional product)");

const shellB = await api(B.url, "/api/orchestration/shell", { token: registration.token });
if (!shellB.ok) fail("attach token", `shell read on B failed (${shellB.status})`);
const shell = await shellB.json();
if (!shell.projects?.some((project) => project.id === projectId)) {
  fail("attach token", "B's project is not visible through the registered token");
}
if (!shell.threads?.some((thread) => thread.id === threadId)) {
  fail("attach token", "B's thread is not visible through the registered token");
}
pass("registered token reads B's shell — project and thread visible (the live half)");

const privileged = await api(B.url, "/api/roaming/peers/list", {
  method: "POST",
  token: registration.token,
  body: {},
});
if (privileged.ok) fail("attach token scope", "registered token can call administrative routes");
pass(`registered token is standard-scoped (peers/list → ${privileged.status})`);

// ── 3. Disable network access: restart B loopback, registration goes ─────
restartB("127.0.0.1");
await waitFor("registration withdrawn via the standing channel", 90_000, async () => {
  const registrations = await registrationsOn(A, adminA);
  return registrations.length === 0 ? true : null;
});
const withdrawnToken = await api(B.url, "/api/orchestration/shell", {
  token: registration.token,
});
if (withdrawnToken.ok) fail("withdrawal", "the withdrawn session still authenticates");
pass(`toggle OFF → registration withdrawn, session revoked (shell → ${withdrawnToken.status})`);

// ── 4. Teardown both directions (re-enable first) ────────────────────────
restartB("0.0.0.0");
const reissued = await waitFor("registration returns after re-enable", 90_000, async () => {
  const registrations = await registrationsOn(A, adminA);
  return registrations.length === 1 ? registrations[0] : null;
});
pass("toggle ON again → registration returns (fresh token)");

const removeOnB = await api(B.url, "/api/roaming/peers/remove", {
  method: "POST",
  token: adminB,
  body: { environmentId: envA },
});
if (!removeOnB.ok) fail("remove on B", `${removeOnB.status}`);
const revoked = await api(B.url, "/api/orchestration/shell", { token: reissued.token });
if (revoked.ok) fail("remove on B", "the reverse attach session survived unpairing");
pass(`unpairing on the initiator revokes the reverse session (shell → ${revoked.status})`);

const removeOnA = await api(A.url, "/api/roaming/peers/remove", {
  method: "POST",
  token: adminA,
  body: { environmentId: envB },
});
if (!removeOnA.ok) fail("remove on A", `${removeOnA.status}`);
const afterRemoval = await listRegistrations(A, adminA);
// Removing the last peer turns roaming off entirely, so 404 and an empty
// list are both honest here.
if (afterRemoval.ok && (await afterRemoval.json()).registrations.length !== 0) {
  fail("remove on A", "the attach registration survived unpairing");
}
pass("unpairing on the callee drops the registration");

console.log("\nM5.6 standing-channel acceptance: ALL PASS");
