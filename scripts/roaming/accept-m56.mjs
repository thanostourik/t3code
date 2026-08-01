// M5.6 bidirectional-pairing acceptance on the fresh M0 two-instance harness.
// B initiates the one handshake into A (A = callee). Server-verifiable exit
// criteria:
//   - the handshake leaves an attach registration on the CALLEE only:
//     A can hand its clients {B's envId, label, URL, token}; B's list stays
//     empty (nothing registered A-ward), and the route 404s before pairing
//     (roaming gate);
//   - the registered token really is a live standard-scoped session on B:
//     it reads B's shell (projects + threads visible — the "live on the
//     callee" half the client renders) but cannot call administrative
//     routes;
//   - teardown is honest in both directions: unpairing on B revokes the
//     reverse session (token dies), unpairing on A drops the registration.
// The row presentation (live rows while B is reachable, greyed fallbacks
// when it is not) is client-side and verified by the M5.6 browser walk on
// the same harness; the canonical pairing walk remains accept-m2.5.mjs.

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
} from "./harness-lib.mjs";

const git = makeGitTrimmed("m56");
const { randomUUID } = NodeCrypto;
const { rmSync, writeFileSync } = NodeFS;
const { join } = NodePath;

// Must match how the harness was started: a loopback-only server
// deliberately advertises nothing, so the two modes assert opposite
// outcomes. Run BOTH.
const BIND_HOST = process.env.T3_ROAMING_HARNESS_BIND ?? "127.0.0.1";

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

// ── The one handshake: B pairs into A ────────────────────────────────────
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
pass("paired once (B initiated into A)");

// ── Loopback-only mode: nothing is advertised, nothing is registered ─────
// The 2026-07-31 field bug: a loopback-only server advertised 127.0.0.1,
// so the callee's client attached to its OWN backend and sat forever on
// "connected environment X does not match Y". Advertising nothing is the
// honest answer; pairing degrades to one-directional.
if (BIND_HOST === "127.0.0.1") {
  const loopbackListed = await listRegistrations(A, adminA);
  if (!loopbackListed.ok) fail("loopback registration list", `${loopbackListed.status}`);
  const loopbackRegistrations = (await loopbackListed.json()).registrations;
  if (loopbackRegistrations.length !== 0) {
    fail(
      "loopback-only advertisement",
      `a loopback-only initiator registered ${JSON.stringify(
        loopbackRegistrations.map((entry) => entry.baseUrls),
      )} — the callee would attach to itself`,
    );
  }
  pass("loopback-only initiator registers nothing (field-bug regression)");
  console.log(
    "\nM5.6 loopback leg: PASS. Re-run with T3_ROAMING_HARNESS_BIND=0.0.0.0" +
      " for the registration leg.",
  );
  process.exit(0);
}

// ── The callee holds the reverse registration; the initiator holds none ──
const listedA = await listRegistrations(A, adminA);
if (!listedA.ok) fail("callee registration list", `${listedA.status}`);
if (listedA.headers.get("cache-control") !== "no-store") {
  fail("callee registration list", "token response is missing cache-control: no-store");
}
const registrations = (await listedA.json()).registrations;
if (registrations.length !== 1)
  fail("callee registration", `expected 1, got ${registrations.length}`);
const registration = registrations[0];
if (registration.environmentId !== envB) {
  fail("callee registration", `names ${registration.environmentId}, expected B (${envB})`);
}
if (registration.baseUrls.some((url) => /\/\/(127\.|localhost|\[::1\])/.test(url))) {
  fail(
    "callee registration",
    `advertised a loopback URL (${registration.baseUrls.join(", ")}) — it names the READER's machine`,
  );
}
if (!registration.label) fail("callee registration", "registration has no label");
pass(`callee registration names B at ${registration.baseUrls.join(", ")}`);

const listedB = await listRegistrations(B, adminB);
if (!listedB.ok) fail("initiator registration list", `${listedB.status}`);
if ((await listedB.json()).registrations.length !== 0) {
  fail("initiator registration list", "the initiator must hold no reverse registration");
}
pass("initiator side holds no registration (one-directional handshake product)");

// ── The registered token is a live standard-scoped session on B ──────────
const identity = await api(registration.baseUrls[0], "/.well-known/t3/environment");
if (!identity.ok || (await identity.json()).environmentId !== envB) {
  fail("registration identity", "advertised URL does not answer as B");
}
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

// ── Teardown direction 1: unpairing on B revokes the reverse session ─────
const removeOnB = await api(B.url, "/api/roaming/peers/remove", {
  method: "POST",
  token: adminB,
  body: {
    environmentId: (await (await api(A.url, "/.well-known/t3/environment")).json()).environmentId,
  },
});
if (!removeOnB.ok) fail("remove on B", `${removeOnB.status}`);
const revoked = await api(B.url, "/api/orchestration/shell", { token: registration.token });
if (revoked.ok) fail("remove on B", "the reverse attach session survived unpairing");
pass(`unpairing on the initiator revokes the reverse session (shell → ${revoked.status})`);

// ── Teardown direction 2: unpairing on A drops the registration ──────────
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

console.log("\nM5.6 server-verifiable acceptance: ALL PASS");
