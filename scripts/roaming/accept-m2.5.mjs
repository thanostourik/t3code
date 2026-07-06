// M2.5 acceptance (.plans/21-roaming-workspace.md): a single pairing action
// on the harness instances establishes BOTH the live remote attach AND the
// machine-to-machine mirror — one code, one call, starting from two fresh
// machines with the roaming setting off on both. Killing the peer leaves
// the mirrored copy serving materialize (canonical step 4). Attach-only
// degradation with a standard-scoped code is a first-class outcome. The
// canonical-workflow UI walk (one list, live rows, offline flip) is
// demonstrated on the real desktop build — this script proves the full
// transport chain headless; it must never quietly substitute for that walk.
//
// Run the harness FRESH first (fresh state dirs — roaming must start off):
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m2.5.mjs
//
// Direction matches the product flow: the code is generated on A (the
// "desktop", via the pairing-token route the "Another machine of yours"
// preset drives) and entered on B (the "laptop", whose own server runs the
// handshake via POST /api/roaming/peers).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
const A = {
  name: "instance-a",
  url: "http://127.0.0.1:14801",
  base: join(HARNESS_DIR, "instance-a/basedir"),
};
const B = {
  name: "instance-b",
  url: "http://127.0.0.1:14802",
  base: join(HARNESS_DIR, "instance-b/basedir"),
};
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const STANDARD_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];
const ADMIN_SCOPES = [...STANDARD_SCOPES, "access:read", "access:write", "relay:write"];

const fail = (step, detail) => {
  console.error(`FAIL at ${step}: ${detail}`);
  process.exit(1);
};
const pass = (step) => console.log(`PASS ${step}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cli = (args) =>
  execFileSync("node", [join(REPO_ROOT, "apps/server/src/bin.ts"), ...args], {
    encoding: "utf8",
  }).trim();

const api = async (base, path, { method = "GET", token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
};

const waitFor = async (step, timeoutMs, probe) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(1000);
  }
  fail(step, `condition not met within ${timeoutMs / 1000}s`);
};

const readSettings = (inst) => {
  const path = join(inst.base, "userdata", "settings.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "m25",
  GIT_AUTHOR_EMAIL: "m25@test",
  GIT_COMMITTER_NAME: "m25",
  GIT_COMMITTER_EMAIL: "m25@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv });

// ── 0. preconditions: both up, roaming OFF on both, gating asymmetry ──
for (const inst of [A, B]) {
  const up = await api(inst.url, "/.well-known/t3/environment").then(
    (r) => r.ok,
    () => false,
  );
  if (!up) fail("preflight", `${inst.name} is not running — start the harness first`);
  const settings = readSettings(inst);
  if (settings.roaming === true)
    fail("preflight", `${inst.name} already has roaming on — restart the harness fresh`);
}

// While roaming is off: mirror routes hide behind 404, but the two
// unified-pairing routes must answer (401 anonymous, not 404).
const gatedProbe = await api(B.url, "/api/roaming/mirror/manifest", { method: "POST", body: {} });
if (gatedProbe.status !== 404)
  fail("flag gating", `mirror route answered ${gatedProbe.status} while roaming is off`);
for (const [inst, path] of [
  [B, "/api/roaming/peers"],
  [A, "/api/roaming/machine-credential"],
]) {
  const probe = await api(inst.url, path, { method: "POST", body: {} });
  if (probe.status === 404)
    fail(
      "flag gating",
      `${path} 404s while roaming is off — pairing cannot start on a fresh machine`,
    );
}
pass("fresh machines: mirror routes gated, pairing routes answering");

// ── 1. a project with a secret on A, created before any pairing ───────
const p1Dir = join(HARNESS_DIR, "m25-p1");
const p1Origin = join(HARNESS_DIR, "m25-p1-origin.git");
const materializeRoot = join(HARNESS_DIR, "m25-b-workspace");
for (const dir of [p1Dir, p1Origin, materializeRoot]) rmSync(dir, { recursive: true, force: true });
mkdirSync(materializeRoot, { recursive: true });

git(["init", "--bare", p1Origin]);
git(["init", p1Dir]);
writeFileSync(join(p1Dir, "README.md"), "m25 p1\n");
writeFileSync(join(p1Dir, ".gitignore"), ".env\n");
git(["-C", p1Dir, "add", "."]);
git(["-C", p1Dir, "commit", "-m", "init"]);
git(["-C", p1Dir, "remote", "add", "origin", p1Origin]);
git(["-C", p1Dir, "push", "origin", "HEAD"]);
const P1_ENV = "SECRET=only-on-a\n";
writeFileSync(join(p1Dir, ".env"), P1_ENV);

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const projectId = `m25-${randomUUID()}`;
const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "M25 P1",
    workspaceRoot: p1Dir,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) fail("project.create", `${created.status} ${await created.text()}`);
pass("P1 (with untracked .env) exists on A before pairing");

// ── 2. generate the code on A exactly as the preset does ──────────────
const mintCode = async (scopes, label) => {
  const response = await api(A.url, "/api/auth/pairing-token", {
    method: "POST",
    token: adminA,
    body: { label, scopes },
  });
  if (!response.ok) fail("pairing-token", `${response.status} ${await response.text()}`);
  return (await response.json()).credential;
};
const adminCode = await mintCode(ADMIN_SCOPES, "Another machine of yours");
pass("admin-scoped pairing code minted on A (the preset's request)");

// ── 3. ONE pairing action on B: attach + mirror from a single code ────
const pairResponse = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: adminCode,
    syncOptions: { secretsSync: true },
  },
});
if (!pairResponse.ok) fail("pair", `${pairResponse.status} ${await pairResponse.text()}`);
if (!(pairResponse.headers.get("cache-control") ?? "").includes("no-store"))
  fail("pair", "bearer-bearing response is missing cache-control: no-store");
const paired = await pairResponse.json();
const environmentIdA = readFileSync(join(A.base, "userdata", "environment-id"), "utf8").trim();
if (paired.peer === null || paired.mirrorUnavailableReason !== null)
  fail("pair", `mirror not established: ${JSON.stringify(paired)}`);
if (paired.peer.environmentId !== environmentIdA)
  fail("pair", `peer environmentId mismatch: ${paired.peer.environmentId}`);
if (paired.attach.environmentId !== environmentIdA || paired.attach.baseUrl !== A.url)
  fail(
    "pair",
    `attach grant mismatch: ${JSON.stringify({ ...paired.attach, token: "<redacted>" })}`,
  );
pass("one pairing call returned mirror peer + attach grant, no-store headers set");

// machine credential stored on B for A
if (!existsSync(join(B.base, "userdata", "secrets", `roaming-peer-${environmentIdA}.bin`)))
  fail("pair", "machine credential for A not stored on B");

// settings: pairing IS how the flag turns on, on both machines
const settingsB = readSettings(B);
if (settingsB.roaming !== true || settingsB.roamingSecretsSync !== true)
  fail("settings", `B settings not applied: ${JSON.stringify(settingsB)}`);
const settingsA = await waitFor("A settings propagation", 10_000, async () => {
  const settings = readSettings(A);
  return settings.roaming === true && settings.roamingSecretsSync === true ? settings : null;
});
if (!settingsA) fail("settings", "unreachable");
pass("roaming + secrets consent flipped on BOTH machines by the one pairing action");

// ── 4. the attach half works as the client would use it ───────────────
const attachToken = paired.attach.token;
const session = await api(A.url, "/api/auth/session", { token: attachToken }).then((r) => r.json());
if (session.authenticated !== true) fail("attach", "attach bearer does not authenticate on A");
if (session.scopes.includes("access:write"))
  fail("attach", "attach bearer carries access:write — the privileged handshake bearer leaked");
if (!session.scopes.includes("orchestration:operate"))
  fail("attach", `attach bearer lacks orchestration:operate: ${JSON.stringify(session.scopes)}`);

const ticketResponse = await api(A.url, "/api/auth/websocket-ticket", {
  method: "POST",
  token: attachToken,
});
if (!ticketResponse.ok) fail("attach ws", `websocket-ticket: ${ticketResponse.status}`);
const wsTicket = (await ticketResponse.json()).ticket;
const wsOpen = await new Promise((resolve) => {
  const socket = new WebSocket(`${A.url.replace("http", "ws")}/ws?wsTicket=${wsTicket}`);
  const done = (value) => {
    try {
      socket.close();
    } catch {
      // already closed
    }
    resolve(value);
  };
  socket.addEventListener("open", () => setTimeout(() => done(true), 300));
  socket.addEventListener("error", () => done(false));
  socket.addEventListener("close", (event) => (event.code === 1000 ? null : done(false)));
  setTimeout(() => done(false), 5000);
});
if (!wsOpen) fail("attach ws", "WebSocket to A did not open with the attach ticket");

// a conversation on the peer, over the same command path the UI uses
const threadCreate = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: attachToken,
  body: {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: randomUUID(),
    projectId,
    title: "M25 remote conversation",
    modelSelection: { instanceId: "claude-code", model: "claude-sonnet-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  },
});
if (!threadCreate.ok) fail("remote thread", `${threadCreate.status} ${await threadCreate.text()}`);
pass("attach bearer: standard scopes, WS opens, thread created ON A over the attach");

// ── 5. registry + vault mirror to B silently behind the pairing ───────
// A probe machine-credential minted on B gives this script a roaming:mirror
// token to inspect B's blob store through the same RPCs peers use.
const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m25-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe mint", `${probeMint.status} ${await probeMint.text()}`);
const probeToken = (await probeMint.json()).token;

const manifestOnB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: probeToken,
    body: { environmentId: "m25-probe", manifest: [] },
  });
  if (!response.ok) return [];
  return (await response.json()).manifest;
};
const fetchBlobFromB = async (kind, key) => {
  const response = await api(B.url, "/api/roaming/mirror/fetch", {
    method: "POST",
    token: probeToken,
    body: { refs: [{ kind, key }] },
  });
  if (!response.ok) return null;
  return (await response.json()).blobs[0] ?? null;
};

const registryBlob = await waitFor("mirror registry", 90_000, async () => {
  const manifest = await manifestOnB();
  for (const entry of manifest.filter((candidate) => candidate.kind === "registry")) {
    const blob = await fetchBlobFromB("registry", entry.key);
    if (blob && JSON.parse(blob.payload).title === "M25 P1") return blob;
  }
  return null;
});
const wpidP1 = JSON.parse(registryBlob.payload).workspaceProjectId;
const vaultBlob = await waitFor("mirror vault", 90_000, () => fetchBlobFromB("vault", wpidP1));
const vaultFiles = JSON.parse(vaultBlob.payload).files.map((file) => file.path);
if (!vaultFiles.includes(".env")) fail("vault", `.env missing from mirrored vault: ${vaultFiles}`);
pass("registry + vault mirrored to B with no user-visible sync step");

// ── 6. re-pairing with a standard code reports the standing mirror ────
// (True attach-only degradation against an UNPAIRED machine is covered by
// the RoamingService unit tests and the fresh-machine browser walks; here
// the machines are already mirrored, so the honest answer is the peer.)
const standardCode = await mintCode(STANDARD_SCOPES, "Standard client");
const attachOnlyResponse = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: { baseUrls: [A.url], pairingCredential: standardCode },
});
if (!attachOnlyResponse.ok)
  fail("std-re-pair", `${attachOnlyResponse.status} ${await attachOnlyResponse.text()}`);
const attachOnly = await attachOnlyResponse.json();
if (attachOnly.peer === null || attachOnly.mirrorUnavailableReason !== null)
  fail(
    "std-re-pair",
    JSON.stringify({ peer: attachOnly.peer, reason: attachOnly.mirrorUnavailableReason }),
  );
const attachOnlySession = await api(A.url, "/api/auth/session", {
  token: attachOnly.attach.token,
}).then((r) => r.json());
if (attachOnlySession.authenticated !== true) fail("std-re-pair", "attach bearer rejected");
pass("standard-code re-pair reports the standing mirror; attach still works");

// ── 7. re-pairing applies the ONE secrets decision to BOTH machines ───
const secondAdminCode = await mintCode(ADMIN_SCOPES, "Another machine of yours");
const repair = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: secondAdminCode,
    syncOptions: { secretsSync: false },
  },
});
if (!repair.ok) fail("re-pair", `${repair.status} ${await repair.text()}`);
// The settings file stores only non-default values, so false shows as absence.
const settingsAAfter = readSettings(A);
if ((settingsAAfter.roamingSecretsSync ?? false) !== false)
  fail("re-pair", "the pairing's secrets decision was not applied on the peer");
const settingsBAfter = readSettings(B);
if ((settingsBAfter.roamingSecretsSync ?? false) !== false)
  fail("re-pair", "the pairing's secrets decision was not applied locally");
pass("one secrets decision per pairing, applied to both machines");
// restore both machines' consent for the later secrets-materialize steps
writeFileSync(
  join(A.base, "userdata", "settings.json"),
  JSON.stringify({ ...settingsAAfter, roamingSecretsSync: true }),
);
writeFileSync(
  join(B.base, "userdata", "settings.json"),
  JSON.stringify({ ...settingsBAfter, roamingSecretsSync: true }),
);

// ── 8. kill A: same rows serve offline — materialize from the mirror ──
const pidA = Number(readFileSync(join(HARNESS_DIR, "instance-a/server.pid"), "utf8").trim());
process.kill(pidA, "SIGKILL");
await sleep(1000);
const aDown = await api(A.url, "/.well-known/t3/environment").then(
  (r) => !r.ok,
  () => true,
);
if (!aDown) fail("kill-a", "A is still up");

const materializeResponse = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wpidP1, targetPath: join(materializeRoot, "p1") },
});
if (!materializeResponse.ok)
  fail("materialize", `${materializeResponse.status} ${await materializeResponse.text()}`);
const materialization = (await materializeResponse.json()).materialization;
if (materialization.status !== "completed") fail("materialize", JSON.stringify(materialization));
const appliedEnv = readFileSync(join(materializeRoot, "p1", ".env"), "utf8");
if (appliedEnv !== P1_ENV) fail("materialize", `vault .env mismatch: ${appliedEnv}`);
if (materialization.localProjectId === null) fail("materialize", "project not registered on B");
pass("A killed — B materialized the project with secrets from its mirrored copy");

console.log("\nM2.5 ACCEPTANCE: ALL CRITERIA PASS");
console.log(
  "Reminder: the canonical-workflow UI walk (one list, live rows, offline flip)" +
    " is demonstrated on the real desktop build — this script covers the transport chain only.",
);
