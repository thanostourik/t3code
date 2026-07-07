// M3.5 acceptance (.plans/21-roaming-workspace.md): sync completion.
// Exit criteria: a file created on machine A appears on machine B's clean
// checkout within seconds with no user action; a locally-edited checkout on
// B is never overwritten (surfaced as blocked, not clobbered); .idea/ listed
// in .t3sync round-trips A→B while staying off the origin; an oversized
// untracked file is skipped with a surfaced warning and never pushed.
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m35.mjs

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
  GIT_AUTHOR_NAME: "m35",
  GIT_AUTHOR_EMAIL: "m35@test",
  GIT_COMMITTER_NAME: "m35",
  GIT_COMMITTER_EMAIL: "m35@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" });

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

// ── 1. one project on A with .gitignore + .t3sync + .idea ─────────────
const p1Dir = join(HARNESS_DIR, "m35-p1");
const p1Origin = join(HARNESS_DIR, "m35-p1-origin.git");
const materializeRoot = join(HARNESS_DIR, "m35-b-workspace");
for (const dir of [p1Dir, p1Origin, materializeRoot]) rmSync(dir, { recursive: true, force: true });
mkdirSync(materializeRoot, { recursive: true });

git(["init", "--bare", "-b", "main", p1Origin]);
git(["init", "-b", "main", p1Dir]);
writeFileSync(join(p1Dir, "README.md"), "m35 base\n");
writeFileSync(join(p1Dir, ".gitignore"), ".env\n.idea/\n");
writeFileSync(join(p1Dir, ".t3sync"), ".idea/\n");
git(["-C", p1Dir, "add", "."]);
git(["-C", p1Dir, "commit", "-m", "init"]);
git(["-C", p1Dir, "remote", "add", "origin", p1Origin]);
git(["-C", p1Dir, "push", "origin", "main"]);
mkdirSync(join(p1Dir, ".idea"), { recursive: true });
writeFileSync(join(p1Dir, ".idea", "workspace.xml"), "<project from='A'/>\n");
writeFileSync(join(p1Dir, ".env"), "SECRET=a\n");

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `m35-${randomUUID()}`,
    title: "M35 P1",
    workspaceRoot: p1Dir,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) fail("project.create", `${created.status} ${await created.text()}`);
pass("P1 on A with .gitignore(.idea/), .t3sync(.idea/), untracked .idea + .env");

// ── 2. pair once (secrets + wip on) ────────────────────────────────────
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

// ── 3. materialize on B — .idea arrives via .t3sync channel ───────────
const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m35-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe mint", `${probeMint.status}`);
const probeToken = (await probeMint.json()).token;
const manifestOnB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: probeToken,
    body: { environmentId: "m35-probe", manifest: [] },
  });
  return response.ok ? (await response.json()).manifest : [];
};
const registry = await waitFor("registry mirrored", 120_000, async () => {
  const manifest = await manifestOnB();
  for (const entry of manifest.filter((candidate) => candidate.kind === "registry")) {
    const response = await api(B.url, "/api/roaming/mirror/fetch", {
      method: "POST",
      token: probeToken,
      body: { refs: [{ kind: "registry", key: entry.key }] },
    });
    if (!response.ok) continue;
    const blob = (await response.json()).blobs[0];
    if (blob && JSON.parse(blob.payload).title === "M35 P1") return JSON.parse(blob.payload);
  }
  return null;
});
const wpid = registry.workspaceProjectId;

// wait for the vault blob to include .idea (t3sync channel) before materialize
await waitFor("vault with .idea mirrored to B", 120_000, async () => {
  const response = await api(B.url, "/api/roaming/mirror/fetch", {
    method: "POST",
    token: probeToken,
    body: { refs: [{ kind: "vault", key: wpid }] },
  });
  if (!response.ok) return null;
  const blob = (await response.json()).blobs[0];
  if (!blob) return null;
  const files = JSON.parse(blob.payload).files.map((file) => file.path);
  return files.includes(".idea/workspace.xml") && files.includes(".env") ? true : null;
});

const bTarget = join(materializeRoot, "p1");
const materializeResponse = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wpid, targetPath: bTarget },
});
if (!materializeResponse.ok) fail("materialize", `${materializeResponse.status}`);
const materialization = (await materializeResponse.json()).materialization;
if (materialization.status !== "completed") fail("materialize", JSON.stringify(materialization));
if (readFileSync(join(bTarget, ".idea", "workspace.xml"), "utf8") !== "<project from='A'/>\n")
  fail("t3sync", ".idea/workspace.xml did not arrive on B");
pass(".t3sync: gitignored .idea round-tripped A→B via the P2P channel");

// ── 4. THE criterion: file on A appears on B within seconds ───────────
writeFileSync(join(p1Dir, "hot-file.txt"), "created on A\n");
const started = Date.now();
await waitFor(
  "hot file appears on B without user action",
  90_000,
  async () => (existsSync(join(bTarget, "hot-file.txt")) ? true : null),
  1000,
);
const latencySeconds = Math.round((Date.now() - started) / 1000);
if (readFileSync(join(bTarget, "hot-file.txt"), "utf8") !== "created on A\n")
  fail("delivery", "content mismatch");
// .idea must never reach the origin (it rides P2P only)
const originWipRefs = git(["-C", p1Origin, "for-each-ref", "--format=%(refname)", "refs/t3/wip/"]);
for (const ref of originWipRefs.split("\n").filter((line) => line.length > 0)) {
  const tree = git(["-C", p1Origin, "ls-tree", "-r", "--name-only", `${ref}^{tree}`]);
  if (tree.includes(".idea/") || tree.includes(".env"))
    fail("origin hygiene", `.idea or .env leaked into ${ref}`);
}
pass(`file created on A appeared on B in ~${latencySeconds}s; origin holds no .idea/.env`);

// ── 5. locally-edited B checkout is never overwritten ─────────────────
writeFileSync(join(bTarget, "local-work.txt"), "B's own edit\n");
await sleep(8_000); // let B's watcher capture ITS edit first
writeFileSync(join(p1Dir, "hot-file.txt"), "changed on A again\n");
// give the pipeline ample time to (incorrectly) deliver
await sleep(45_000);
if (!existsSync(join(bTarget, "local-work.txt")))
  fail("no-clobber", "B's local file was deleted by auto-apply");
if (readFileSync(join(bTarget, "hot-file.txt"), "utf8") === "changed on A again\n")
  fail("no-clobber", "A's change was applied over B's locally-edited checkout");
pass("locally-edited checkout on B untouched (blocked, not clobbered)");

// ── 6. oversize untracked file: warned, never pushed ──────────────────
writeFileSync(join(p1Dir, "huge.bin"), Buffer.alloc(60 * 1024 * 1024, 7));
await waitFor("oversize warning surfaced on A", 180_000, async () => {
  const response = await api(A.url, "/api/orchestration/shell", { token: adminA });
  if (!response.ok) return null;
  const snapshot = await response.json();
  return (snapshot.roamingWipStatus ?? []).find(
    (entry) => entry.lastError && /large files not synced/.test(entry.lastError),
  );
});
for (const ref of git(["-C", p1Origin, "for-each-ref", "--format=%(refname)", "refs/t3/wip/"])
  .split("\n")
  .filter((line) => line.length > 0)) {
  const tree = git(["-C", p1Origin, "ls-tree", "-r", "--name-only", `${ref}^{tree}`]);
  if (tree.includes("huge.bin")) fail("size guard", "oversize file reached the origin");
}
pass("oversize untracked file warned and kept off the origin");

// ── 7. roaming off ⇒ the HTTP shell snapshot hides every roaming field ─
// (the ws path always stripped them; the HTTP-first load must too)
const settingsB = readSettings(B);
writeFileSync(
  join(B.base, "userdata", "settings.json"),
  JSON.stringify({ ...settingsB, roaming: false }),
);
await waitFor("HTTP shell snapshot empties with roaming off", 30_000, async () => {
  const response = await api(B.url, "/api/orchestration/shell", { token: adminB });
  if (!response.ok) return null;
  const snapshot = await response.json();
  return (snapshot.roamingProjects ?? []).length === 0 &&
    (snapshot.roamingMaterializations ?? []).length === 0 &&
    (snapshot.roamingWipStatus ?? []).length === 0
    ? true
    : null;
});
pass("roaming off: HTTP shell snapshot shows no roaming rows (invariant holds)");

console.log("\nM3.5 ACCEPTANCE: ALL CRITERIA PASS");
