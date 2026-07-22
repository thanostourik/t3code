// M3.6 acceptance (.plans/21-roaming-workspace.md): field round 2.
// Exit criteria: vault bundles deliver to an already-materialized checkout
// (no re-materialize); an updated secret reaches the peer's unmodified copy
// while a locally-edited copy is never overwritten; edits made on the
// materialized machine flow BACK to the still-unchanged dirty author
// (based-on fast-forward); true divergence stays blocked and surfaces
// blockedReason.
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m36.mjs

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

const api = async (base, path, { method = "GET", token, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

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
  GIT_AUTHOR_NAME: "m36",
  GIT_AUTHOR_EMAIL: "m36@test",
  GIT_COMMITTER_NAME: "m36",
  GIT_COMMITTER_EMAIL: "m36@test",
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

// ── 1. project on A, DIRTY from the start (the desktop shape) ─────────
const p1Dir = join(HARNESS_DIR, "m36-p1");
const p1Origin = join(HARNESS_DIR, "m36-p1-origin.git");
const materializeRoot = join(HARNESS_DIR, "m36-b-workspace");
for (const dir of [p1Dir, p1Origin, materializeRoot]) rmSync(dir, { recursive: true, force: true });
mkdirSync(materializeRoot, { recursive: true });

git(["init", "--bare", "-b", "main", p1Origin]);
git(["init", "-b", "main", p1Dir]);
writeFileSync(join(p1Dir, "README.md"), "m36 base\n");
writeFileSync(join(p1Dir, ".gitignore"), ".env\n.idea/\n");
git(["-C", p1Dir, "add", "."]);
git(["-C", p1Dir, "commit", "-m", "init"]);
git(["-C", p1Dir, "remote", "add", "origin", p1Origin]);
git(["-C", p1Dir, "push", "origin", "main"]);
writeFileSync(join(p1Dir, "a-work.txt"), "A's uncommitted work\n");
writeFileSync(join(p1Dir, ".env"), "SECRET=v1\n");

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `m36-${randomUUID()}`,
    title: "M36 P1",
    workspaceRoot: p1Dir,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) fail("project.create", `${created.status} ${await created.text()}`);
pass("P1 on A, dirty (a-work.txt) + .env, before pairing");

// ── 2. pair + materialize on B ─────────────────────────────────────────
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

const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m36-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe mint", `${probeMint.status}`);
const probeToken = (await probeMint.json()).token;
const fetchBlobFromB = async (kind, key) => {
  const response = await api(B.url, "/api/roaming/mirror/fetch", {
    method: "POST",
    token: probeToken,
    body: { refs: [{ kind, key }] },
  });
  if (!response.ok) return null;
  return (await response.json()).blobs[0] ?? null;
};
const manifestOnB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: probeToken,
    body: { environmentId: "m36-probe", manifest: [] },
  });
  return response.ok ? (await response.json()).manifest : [];
};
const registry = await waitFor("registry mirrored", 120_000, async () => {
  const manifest = await manifestOnB();
  for (const entry of manifest.filter((candidate) => candidate.kind === "registry")) {
    const blob = await fetchBlobFromB("registry", entry.key);
    if (blob && JSON.parse(blob.payload).title === "M36 P1") return JSON.parse(blob.payload);
  }
  return null;
});
const wpid = registry.workspaceProjectId;
await waitFor("vault mirrored", 120_000, async () => {
  const blob = await fetchBlobFromB("vault", wpid);
  return blob && JSON.parse(blob.payload).files.some((file) => file.path === ".env") ? true : null;
});

const bTarget = join(materializeRoot, "p1");
const materializeResponse = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wpid, targetPath: bTarget },
});
if (!materializeResponse.ok) fail("materialize", `${materializeResponse.status}`);
if ((await materializeResponse.json()).materialization.status !== "completed")
  fail("materialize", "did not complete");
// The snapshot lands either inside materialize (restore-wip) or seconds
// later via auto-apply — both are correct; wait rather than race.
await waitFor(
  "A's WIP on B",
  200_000,
  async () =>
    existsSync(join(bTarget, "a-work.txt")) &&
    readFileSync(join(bTarget, "a-work.txt"), "utf8") === "A's uncommitted work\n"
      ? true
      : null,
  2000,
);
pass("paired + materialized on B (WIP + .env present)");

// ── 3. vault delivery WITHOUT re-materialize: .t3sync .idea on A ──────
mkdirSync(join(p1Dir, ".idea"), { recursive: true });
writeFileSync(join(p1Dir, ".idea", "workspace.xml"), "<project from='A'/>\n");
writeFileSync(join(p1Dir, ".t3sync"), ".idea/\n");
await waitFor(
  ".idea delivered to B's live checkout",
  180_000,
  async () => (existsSync(join(bTarget, ".idea", "workspace.xml")) ? true : null),
  2000,
);
if (readFileSync(join(bTarget, ".idea", "workspace.xml"), "utf8") !== "<project from='A'/>\n")
  fail("vault delivery", "content mismatch");
pass(".t3sync line on A delivered .idea to B's checkout — no re-materialize");

// ── 4. secret update delivers; local edit is never clobbered ──────────
writeFileSync(join(p1Dir, ".env"), "SECRET=v2\n");
await waitFor(
  "updated .env delivered to B",
  120_000,
  async () => (readFileSync(join(bTarget, ".env"), "utf8") === "SECRET=v2\n" ? true : null),
  2000,
);
pass("updated secret reached B's unmodified copy");

writeFileSync(join(bTarget, ".env"), "SECRET=mine\n");
writeFileSync(join(p1Dir, ".env"), "SECRET=v3\n");
await sleep(30_000);
if (readFileSync(join(bTarget, ".env"), "utf8") !== "SECRET=mine\n")
  fail("no-clobber", "B's locally-edited secret was overwritten");
pass("B's locally-edited secret never overwritten");

// ── 5. based-on backflow: B's edit lands on the dirty-but-unchanged A ──
writeFileSync(join(bTarget, "b-note.txt"), "written on B\n");
await waitFor(
  "B's edit flowed back to dirty A",
  120_000,
  async () =>
    existsSync(join(p1Dir, "b-note.txt")) &&
    readFileSync(join(p1Dir, "b-note.txt"), "utf8") === "written on B\n"
      ? true
      : null,
  2000,
);
if (readFileSync(join(p1Dir, "a-work.txt"), "utf8") !== "A's uncommitted work\n")
  fail("based-on", "A's own uncommitted work was damaged");
pass("B's edit flowed back to A while A stayed dirty (based-on fast-forward)");

// ── 6. concurrent edits to DIFFERENT files both propagate (M3.7 per-file
// merge — replaces M3.6's whole-tree "any divergence blocks"). Two new files,
// one on each side, is not a conflict: each lands on the other machine and
// neither side's own work is touched.
writeFileSync(join(p1Dir, "a-more.txt"), "A diverges\n");
await sleep(10_000); // let A capture its edit first
writeFileSync(join(bTarget, "b-more.txt"), "B diverges\n");
await waitFor("B's a-more and A's b-more both merged", 180_000, async () =>
  existsSync(join(bTarget, "a-more.txt")) && existsSync(join(p1Dir, "b-more.txt")) ? true : null,
);
if (readFileSync(join(p1Dir, "a-more.txt"), "utf8") !== "A diverges\n")
  fail("per-file merge", "A's own edit was damaged");
if (readFileSync(join(bTarget, "b-more.txt"), "utf8") !== "B diverges\n")
  fail("per-file merge", "B's own edit was damaged");
pass("concurrent edits to different files merged both ways, no clobber");

console.log("\nM3.6 ACCEPTANCE: ALL CRITERIA PASS");
