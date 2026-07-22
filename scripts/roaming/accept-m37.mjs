// M3.7 acceptance, part 1 (.plans/21-roaming-workspace.md): delivery latency.
// Exit criterion: ten consecutive harness A→B deliveries all land within 10s
// (no bimodal outliers). After the loop, the per-stage "roaming timing" log
// lines from both instances are printed per iteration so a slow delivery is
// attributable to a stage, not guessed at.
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m37.mjs
//
// The watcher stress fixture is accept-m37-stress.mjs (part 2).

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
const DELIVERIES = 10;
const MAX_DELIVERY_MS = 10_000;
const A = {
  name: "instance-a",
  url: "http://127.0.0.1:14801",
  base: join(HARNESS_DIR, "instance-a/basedir"),
  log: join(HARNESS_DIR, "instance-a/server.log"),
};
const B = {
  name: "instance-b",
  url: "http://127.0.0.1:14802",
  base: join(HARNESS_DIR, "instance-b/basedir"),
  log: join(HARNESS_DIR, "instance-b/server.log"),
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

const waitFor = async (step, timeoutMs, probe, intervalMs = 2000) => {
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

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "m37",
  GIT_AUTHOR_EMAIL: "m37@test",
  GIT_COMMITTER_NAME: "m37",
  GIT_COMMITTER_EMAIL: "m37@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" });

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

// ── 1. one project on A ────────────────────────────────────────────────
const p1Dir = join(HARNESS_DIR, "m37-p1");
const p1Origin = join(HARNESS_DIR, "m37-p1-origin.git");
const materializeRoot = join(HARNESS_DIR, "m37-b-workspace");
for (const dir of [p1Dir, p1Origin, materializeRoot]) rmSync(dir, { recursive: true, force: true });
mkdirSync(materializeRoot, { recursive: true });

git(["init", "--bare", "-b", "main", p1Origin]);
git(["init", "-b", "main", p1Dir]);
writeFileSync(join(p1Dir, "README.md"), "m37 base\n");
git(["-C", p1Dir, "add", "."]);
git(["-C", p1Dir, "commit", "-m", "init"]);
git(["-C", p1Dir, "remote", "add", "origin", p1Origin]);
git(["-C", p1Dir, "push", "origin", "main"]);

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `m37-${randomUUID()}`,
    title: "M37 P1",
    workspaceRoot: p1Dir,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) fail("project.create", `${created.status} ${await created.text()}`);
pass("P1 on A");

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
pass("paired once, wip consent on both machines");

// ── 3. materialize on B ────────────────────────────────────────────────
const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m37-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe mint", `${probeMint.status}`);
const probeToken = (await probeMint.json()).token;
const registry = await waitFor("registry mirrored", 120_000, async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: probeToken,
    body: { environmentId: "m37-probe", manifest: [] },
  });
  if (!response.ok) return null;
  const manifest = (await response.json()).manifest;
  for (const entry of manifest.filter((candidate) => candidate.kind === "registry")) {
    const fetchResponse = await api(B.url, "/api/roaming/mirror/fetch", {
      method: "POST",
      token: probeToken,
      body: { refs: [{ kind: "registry", key: entry.key }] },
    });
    if (!fetchResponse.ok) continue;
    const blob = (await fetchResponse.json()).blobs[0];
    if (blob && JSON.parse(blob.payload).title === "M37 P1") return JSON.parse(blob.payload);
  }
  return null;
});
const wpid = registry.workspaceProjectId;

const bTarget = join(materializeRoot, "p1");
const materializeResponse = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wpid, targetPath: bTarget },
});
if (!materializeResponse.ok) fail("materialize", `${materializeResponse.status}`);
const materialization = (await materializeResponse.json()).materialization;
if (materialization.status !== "completed") fail("materialize", JSON.stringify(materialization));
pass("materialized on B");

// ── 4. THE criterion: ten consecutive deliveries, each within 10s ─────
const latencies = [];
const windows = [];
for (let i = 1; i <= DELIVERIES; i++) {
  const fileName = `hot-${i}.txt`;
  const content = `delivery ${i} ${randomUUID()}\n`;
  const started = Date.now();
  writeFileSync(join(p1Dir, fileName), content);
  const deadline = started + 90_000;
  let deliveredAt = null;
  while (Date.now() < deadline) {
    if (
      existsSync(join(bTarget, fileName)) &&
      readFileSync(join(bTarget, fileName), "utf8") === content
    ) {
      deliveredAt = Date.now();
      break;
    }
    await sleep(100);
  }
  if (deliveredAt === null) fail(`delivery ${i}`, "file never arrived on B (90s)");
  const latencyMs = deliveredAt - started;
  latencies.push(latencyMs);
  windows.push({ i, started, deliveredAt });
  console.log(`  delivery ${i}: ${(latencyMs / 1000).toFixed(1)}s`);
  // Settle: let B's echo snapshot flow back so iterations stay independent.
  await sleep(8_000);
}

// ── 5. stage attribution from the instrumentation logs ────────────────
const parseLogTimes = (inst) => {
  const lines = readFileSync(inst.log, "utf8").split("\n");
  const entries = [];
  for (const line of lines) {
    const match = line.match(
      /^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d)\].*?(roaming timing: [^{]*|roaming wip: applied peer changes[^{]*)/,
    );
    if (!match) continue;
    const ms =
      Number(match[1]) * 3_600_000 +
      Number(match[2]) * 60_000 +
      Number(match[3]) * 1_000 +
      Number(match[4]);
    const bracket = line.indexOf("{");
    const detail = bracket === -1 ? "" : ` ${line.slice(bracket, bracket + 160)}`;
    entries.push({ ms, who: inst.name, what: `${match[5].trim()}${detail}` });
  }
  return entries;
};
const msSinceMidnight = (unixMs) => {
  const date = new Date(unixMs);
  return (
    date.getHours() * 3_600_000 +
    date.getMinutes() * 60_000 +
    date.getSeconds() * 1_000 +
    date.getMilliseconds()
  );
};
const allEntries = [...parseLogTimes(A), ...parseLogTimes(B)].sort((l, r) => l.ms - r.ms);
console.log("\n── per-stage timings ──");
for (const window of windows) {
  const from = msSinceMidnight(window.started);
  const to = msSinceMidnight(window.deliveredAt) + 1_500;
  console.log(`delivery ${window.i} (write at +0ms):`);
  for (const entry of allEntries.filter(
    (candidate) => candidate.ms >= from && candidate.ms <= to,
  )) {
    console.log(
      `  +${String(entry.ms - from).padStart(5)}ms ${entry.who === "instance-a" ? "A" : "B"} ${entry.what}`,
    );
  }
}

const max = Math.max(...latencies);
const over = latencies.filter((latency) => latency > MAX_DELIVERY_MS);
console.log(
  `\nlatencies (s): ${latencies.map((latency) => (latency / 1000).toFixed(1)).join(", ")} — max ${(max / 1000).toFixed(1)}s`,
);
if (over.length > 0)
  fail(
    "latency criterion",
    `${over.length}/${DELIVERIES} deliveries exceeded ${MAX_DELIVERY_MS / 1000}s`,
  );
pass(`ten consecutive A→B deliveries all within ${MAX_DELIVERY_MS / 1000}s`);

console.log("\nM3.7 LATENCY ACCEPTANCE: PASS");
