// M3.7 acceptance, part 2 (.plans/21-roaming-workspace.md): watcher budget.
// Exit criterion: with a many-project stress fixture, an external
// settings.json edit reaches getSettings within 5s AND every project keeps
// syncing (live watch or surfaced fallback).
//
// Phase 1 (healthy budget): 12 enrolled projects on A; an edit in each
// syncs to its origin; an external settings edit is honored within 5s.
// Phase 2 (starved budget): the per-user inotify instance budget is
// deliberately exhausted (spawned `tail -f` holders) and instance A is
// restarted so every fs.watch in it fails at creation. The settings edit
// must STILL be honored within 5s (poll backbone), project edits must
// still ship (10s fallback sweep), and the degraded state must be
// surfaced on the wip status entries.
//
// NOTE: phase 2 exhausts the REAL per-user inotify instance budget for its
// duration (~1 min); other desktop apps cannot create new watchers during
// that window. Holders are released on exit (trap on all paths).
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m37-stress.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const holders = [];
const releaseHolders = () => {
  for (const holder of holders.splice(0)) {
    try {
      holder.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", releaseHolders);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

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
  const response = await api(A.url, "/api/orchestration/shell", { token });
  if (!response.ok) return null;
  return (await response.json()).roamingWipStatus ?? [];
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
  if (readSettings(inst).roaming === true)
    fail("preflight", `${inst.name} already has roaming on — restart the harness fresh`);
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

// ── 4. phase 2: exhaust the inotify instance budget, restart A ────────
const holderFile = join(HARNESS_DIR, "inotify-holder.txt");
writeFileSync(holderFile, "hold\n");
for (let i = 0; i < 200; i++) {
  const holder = spawn("tail", ["-f", holderFile], { stdio: "ignore" });
  holder.on("error", () => {});
  holders.push(holder);
}
await sleep(2_000); // let the holders register their instances
process.kill(
  Number(readFileSync(join(HARNESS_DIR, "instance-a/server.pid"), "utf8").trim()),
  "SIGKILL",
);
execFileSync(join(REPO_ROOT, "scripts/roaming/harness.sh"), ["start"], { encoding: "utf8" });
const adminA2 = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
pass("phase 2: inotify instances exhausted, instance A restarted");

await waitFor(
  "phase 2: statuses present after restart",
  120_000,
  async () => ((await wipStatuses(adminA2))?.length ?? 0) >= PROJECT_COUNT,
);

// Deliveries must continue — fallback sweep is 10s, allow 30s per project.
for (const project of projects.slice(0, 4)) {
  writeFileSync(join(project.dir, `hot-starved-${project.i}.txt`), `starved ${project.i}\n`);
}
for (const project of projects.slice(0, 4)) {
  await waitFor(`starved delivery p${project.i} to origin`, 45_000, async () =>
    originHasFile(project.origin, `hot-starved-${project.i}.txt`),
  );
}
pass("phase 2: projects keep syncing without watchers (fallback sweep)");

// The degraded state must be surfaced, not silent.
const noticed = await waitFor(
  "phase 2: degraded watch surfaced on status entries",
  60_000,
  async () => {
    const statuses = await wipStatuses(adminA2);
    if (statuses === null) return null;
    const withNotice = statuses.filter((entry) =>
      /watching is unavailable/i.test(entry.notice ?? ""),
    );
    return withNotice.length >= PROJECT_COUNT ? withNotice.length : null;
  },
);
pass(`phase 2: degraded watch surfaced on ${noticed} status entries`);

// Settings freshness with ZERO watch budget: the poll backbone.
const settingsA2 = readSettings(A);
writeSettings(A, { ...settingsA2, roamingWipSync: false });
const starvedEditStarted = Date.now();
await waitFor(
  "phase 2: settings edit reaches getSettings (statuses clear)",
  10_000,
  async () => ((await wipStatuses(adminA2))?.length ?? -1) === 0,
  250,
);
const phase2SettingsMs = Date.now() - starvedEditStarted;
if (phase2SettingsMs > 5_000) fail("phase 2 settings latency", `${phase2SettingsMs}ms > 5000ms`);
pass(`phase 2: external settings edit honored in ${phase2SettingsMs}ms with zero watch budget`);

releaseHolders();
console.log("\nM3.7 STRESS ACCEPTANCE: ALL CRITERIA PASS");
