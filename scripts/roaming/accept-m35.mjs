// M3.5 acceptance (.plans/21-roaming-workspace.md): sync completion.
// Exit criteria: a file created on machine A appears on machine B's clean
// checkout within seconds with no user action; locally-edited FILES on B
// are never overwritten (step 5 revised by M3.7's per-file merge — a local
// edit no longer blocks the whole tree, a same-file conflict keeps ours);
// .idea/ listed in .t3sync round-trips A→B while staying off the origin;
// an oversized untracked file is skipped with a surfaced warning and never
// pushed.
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m35.mjs

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  A,
  B,
  HARNESS_DIR,
  REPO_ROOT,
  api,
  cli,
  fail,
  pass,
  sleep,
  waitFor,
  makeGit,
  readSettings,
  hasRoamingPeers,
} from "./harness-lib.mjs";
const git = makeGit("m35");
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
pass("fresh harness, no roaming peers on either");

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

// ── 5. locally-edited FILES on B are never overwritten ────────────────
// REVISED by M3.7's per-file merge (like accept-m36 step 6): a local edit
// no longer blocks the whole tree — peer changes to OTHER files cross —
// but a file changed on both sides is kept ours and surfaced. Both sides
// edit the same file inside one debounce window so neither has applied
// the other's version first: a genuine two-sided conflict.
writeFileSync(join(bTarget, "local-work.txt"), "B's own edit\n");
writeFileSync(join(bTarget, "hot-file.txt"), "B's local take\n");
writeFileSync(join(p1Dir, "hot-file.txt"), "changed on A again\n");
// give the pipeline ample time to (incorrectly) clobber either side
await sleep(60_000);
if (!existsSync(join(bTarget, "local-work.txt")))
  fail("no-clobber", "B's local file was deleted by auto-apply");
if (readFileSync(join(bTarget, "hot-file.txt"), "utf8") !== "B's local take\n")
  fail("no-clobber", "A's change was applied over B's locally-edited file");
if (readFileSync(join(p1Dir, "hot-file.txt"), "utf8") !== "changed on A again\n")
  fail("no-clobber", "B's change was applied over A's locally-edited file");
pass("two-sided edit of one file: both sides kept their own copy (per-file merge)");

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
// Restart B with its peer records removed (D3: no stored flag — deleting
// the last peer IS turning roaming off): this step tests the ROUTE's gating, and
// runtime file-watch delivery proved flaky under harness inotify pressure
// (flagged in the plan as a follow-up — the recursive project watchers are
// the suspected budget hog).
const bPid = Number(readFileSync(join(HARNESS_DIR, "instance-b/server.pid"), "utf8").trim());
process.kill(bPid, "SIGKILL");
// Wait until the process is fully REAPED: harness.sh start probes the pid
// with `kill -0`, and a not-yet-reaped zombie reads as "already running",
// which skips the relaunch and leaves the port dead (race hit 2026-07-10).
await waitFor(
  "instance-b fully dead",
  15_000,
  async () => {
    try {
      process.kill(bPid, 0);
      return null;
    } catch {
      return true;
    }
  },
  200,
);
{
  const dbB = new DatabaseSync(join(B.base, "userdata", "state.sqlite"));
  dbB.exec("DELETE FROM roaming_peers");
  dbB.close();
}
execFileSync(join(REPO_ROOT, "scripts/roaming/harness.sh"), ["start"], { encoding: "utf8" });
const adminB2 = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
await waitFor("HTTP shell snapshot empties with roaming off", 60_000, async () => {
  const response = await api(B.url, "/api/orchestration/shell", { token: adminB2 });
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
