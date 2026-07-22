// M3.7 acceptance, part 2 (.plans/21-roaming-workspace.md): watcher budget.
// Exit criterion: with a many-project stress fixture, an external
// settings.json edit reaches getSettings within 5s AND every project keeps
// syncing (live watch or surfaced fallback).
//
// Phase 1 (healthy budget): 12 enrolled projects on A; an edit in each
// syncs to its origin; an external settings edit is honored within 5s.
// Phase 2 (over budget): a 13th project whose tree exceeds
// MAX_WATCHED_DIRS_PER_PROJECT is denied a watch — its status entry must
// surface the fallback notice, its edits must still ship (10s sweep), the
// other projects must keep their live watches, and the settings edit must
// still be honored within 5s.
//
// (Total inotify-INSTANCE exhaustion is deliberately not simulated: with a
// zero budget at boot, upstream watchers — git driver, atomic-write temp
// paths — crash the server before roaming code is reached. M3.7 removes
// the biggest watch consumer, which is what makes that state unlikely.)
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m37-stress.mjs

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// D3: roaming has no stored flag — the gate derives from peer records in
// state.sqlite, so freshness/on-ness checks read the peers table.
const hasRoamingPeers = (base) => {
  try {
    const db = new DatabaseSync(join(base, "userdata", "state.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM roaming_peers").get().n > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
};

const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
const PROJECT_COUNT = 12;
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
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

const waitFor = async (step, timeoutMs, probe, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  fail(step, `condition not met within ${timeoutMs / 1000}s`);
};

const readSettings = (inst) => {
  const path = join(inst.base, "userdata", "settings.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
};
const writeSettings = (inst, settings) =>
  writeFileSync(join(inst.base, "userdata", "settings.json"), JSON.stringify(settings));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "m37",
  GIT_AUTHOR_EMAIL: "m37@test",
  GIT_COMMITTER_NAME: "m37",
  GIT_COMMITTER_EMAIL: "m37@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" });

const wipStatuses = async (token) => {
  // Tolerate connection errors: phase 2 SIGKILLs instance A, and undici's
  // keep-alive pool serves one dead socket before reconnecting.
  try {
    const response = await api(A.url, "/api/orchestration/shell", { token });
    if (!response.ok) return null;
    return (await response.json()).roamingWipStatus ?? [];
  } catch {
    return null;
  }
};

const originHasFile = (origin, file) => {
  const refs = git(["-C", origin, "for-each-ref", "--format=%(refname)", "refs/t3/wip/"])
    .split("\n")
    .filter((line) => line.length > 0);
  for (const ref of refs) {
    const tree = git(["-C", origin, "ls-tree", "-r", "--name-only", `${ref}^{tree}`]);
    if (tree.split("\n").includes(file)) return true;
  }
  return false;
};

// ── 0. preflight ───────────────────────────────────────────────────────
for (const inst of [A, B]) {
  const up = await api(inst.url, "/.well-known/t3/environment").then(
    (r) => r.ok,
    () => false,
  );
  if (!up) fail("preflight", `${inst.name} is not running — start the harness fresh`);
  if (hasRoamingPeers(inst.base))
    fail("preflight", `${inst.name} already has roaming peers — restart the harness fresh`);
}
pass("fresh harness, roaming off on both");

// ── 1. many projects on A ──────────────────────────────────────────────
const projects = [];
for (let i = 1; i <= PROJECT_COUNT; i++) {
  const dir = join(HARNESS_DIR, `m37s-p${i}`);
  const origin = join(HARNESS_DIR, `m37s-p${i}-origin.git`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
  git(["init", "--bare", "-b", "main", origin]);
  git(["init", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), `stress project ${i}\n`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.js"), "// stress\n");
  git(["-C", dir, "add", "."]);
  git(["-C", dir, "commit", "-m", "init"]);
  git(["-C", dir, "remote", "add", "origin", origin]);
  git(["-C", dir, "push", "origin", "main"]);
  projects.push({ i, dir, origin });
}

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
for (const project of projects) {
  const created = await api(A.url, "/api/orchestration/dispatch", {
    method: "POST",
    token: adminA,
    body: {
      type: "project.create",
      commandId: randomUUID(),
      projectId: `m37s-${randomUUID()}`,
      title: `M37S P${project.i}`,
      workspaceRoot: project.dir,
      createdAt: new Date().toISOString(),
    },
  });
  if (!created.ok) fail(`project.create ${project.i}`, `${created.status}`);
}
pass(`${PROJECT_COUNT} projects on A`);

// ── 2. pair once (wip on) ──────────────────────────────────────────────
const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "Another machine of yours", scopes: ADMIN_SCOPES },
});
if (!codeResponse.ok) fail("pairing-token", `${codeResponse.status}`);
const pairResponse = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: (await codeResponse.json()).credential,
    syncOptions: { secretsSync: true, wipSync: true },
  },
});
if (!pairResponse.ok) fail("pair", `${pairResponse.status} ${await pairResponse.text()}`);
if ((await pairResponse.json()).peer === null) fail("pair", "mirror not established");
pass("paired once, wip consent on");

await waitFor(
  "all projects enrolled with wip status",
  120_000,
  async () => ((await wipStatuses(adminA))?.length ?? 0) >= PROJECT_COUNT,
);
pass("all projects enrolled and tracked");

// ── 3. phase 1 (healthy): every project syncs, settings edit ≤5s ──────
for (const project of projects) {
  writeFileSync(join(project.dir, `hot-healthy-${project.i}.txt`), `healthy ${project.i}\n`);
}
for (const project of projects) {
  await waitFor(`healthy delivery p${project.i} to origin`, 60_000, async () =>
    originHasFile(project.origin, `hot-healthy-${project.i}.txt`),
  );
}
pass("phase 1: every project shipped an edit (live watch)");

// External settings edit: flip roamingWipSync off → statuses must EMPTY
// via the settings-change reaction — the getSettings freshness probe.
const settingsA = readSettings(A);
writeSettings(A, { ...settingsA, roamingWipSync: false });
const editStarted = Date.now();
await waitFor(
  "phase 1: settings edit reaches getSettings (statuses clear)",
  10_000,
  async () => ((await wipStatuses(adminA))?.length ?? -1) === 0,
  250,
);
const phase1SettingsMs = Date.now() - editStarted;
if (phase1SettingsMs > 5_000) fail("phase 1 settings latency", `${phase1SettingsMs}ms > 5000ms`);
writeSettings(A, { ...settingsA, roamingWipSync: true });
await waitFor(
  "phase 1: settings edit back on (statuses return)",
  10_000,
  async () => ((await wipStatuses(adminA))?.length ?? 0) >= PROJECT_COUNT,
  250,
);
pass(`phase 1: external settings edits honored (off in ${phase1SettingsMs}ms, back on)`);

// ── 4. phase 2: a project over the watch budget cap falls back loudly ──
// A tree needing more directories than MAX_WATCHED_DIRS_PER_PROJECT (4096)
// is not granted watches: capture must degrade to the surfaced 10s sweep
// for THAT project while every other project keeps its live watch. (Total
// inotify-instance exhaustion is deliberately NOT simulated: with a zero
// budget at boot, upstream watchers — git driver, atomic-write temp paths —
// crash the server before roaming code runs; see the M3.7 notes.)
const deepDir = join(HARNESS_DIR, "m37s-deep");
const deepOrigin = join(HARNESS_DIR, "m37s-deep-origin.git");
rmSync(deepDir, { recursive: true, force: true });
rmSync(deepOrigin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", deepOrigin]);
git(["init", "-b", "main", deepDir]);
writeFileSync(join(deepDir, "README.md"), "deep tree\n");
for (let i = 0; i < 4200; i++) {
  mkdirSync(join(deepDir, "wide", `d${String(i).padStart(4, "0")}`), { recursive: true });
}
git(["-C", deepDir, "add", "."]);
git(["-C", deepDir, "commit", "-m", "init"]);
git(["-C", deepDir, "remote", "add", "origin", deepOrigin]);
git(["-C", deepDir, "push", "origin", "main"]);
const deepCreated = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `m37s-${randomUUID()}`,
    title: "M37S Deep",
    workspaceRoot: deepDir,
    createdAt: new Date().toISOString(),
  },
});
if (!deepCreated.ok) fail("deep project.create", `${deepCreated.status}`);

// The degraded state must be surfaced, not silent.
await waitFor("phase 2: over-budget watch surfaced as a notice", 120_000, async () => {
  const statuses = await wipStatuses(adminA);
  if (statuses === null) return null;
  return statuses.some((entry) => /watching is unavailable/i.test(entry.notice ?? ""))
    ? true
    : null;
});
pass("phase 2: over-budget project surfaced its watch fallback");

// The over-budget project must keep syncing via the 10s sweep.
writeFileSync(join(deepDir, "wide", "d0000", "deep-edit.txt"), "deep edit\n");
await waitFor("phase 2: over-budget project ships via fallback sweep", 45_000, async () =>
  originHasFile(deepOrigin, "wide/d0000/deep-edit.txt"),
);
pass("phase 2: over-budget project shipped an edit via the fallback sweep");

// The other projects must be unaffected (live watch, seconds not sweeps).
for (const project of projects.slice(0, 3)) {
  writeFileSync(join(project.dir, `hot-alongside-${project.i}.txt`), `alongside ${project.i}\n`);
}
for (const project of projects.slice(0, 3)) {
  await waitFor(`phase 2: p${project.i} still on live watch`, 30_000, async () =>
    originHasFile(project.origin, `hot-alongside-${project.i}.txt`),
  );
}
pass("phase 2: healthy projects unaffected while one is in fallback");

// Settings freshness while a project sits in fallback mode.
const settingsA2 = readSettings(A);
writeSettings(A, { ...settingsA2, roamingWipSync: false });
const phase2EditStarted = Date.now();
await waitFor(
  "phase 2: settings edit reaches getSettings (statuses clear)",
  10_000,
  async () => ((await wipStatuses(adminA))?.length ?? -1) === 0,
  250,
);
const phase2SettingsMs = Date.now() - phase2EditStarted;
if (phase2SettingsMs > 5_000) fail("phase 2 settings latency", `${phase2SettingsMs}ms > 5000ms`);
pass(`phase 2: external settings edit honored in ${phase2SettingsMs}ms`);

console.log("\nM3.7 STRESS ACCEPTANCE: ALL CRITERIA PASS");
