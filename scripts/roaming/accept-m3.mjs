// M3 acceptance (.plans/21-roaming-workspace.md): continuous WIP snapshots.
// Exit criteria: a dirty tree on instance A appears on instance B via
// materialize with A's process KILLED (origin-refs path); push failures are
// surfaced; the bundle fallback is covered end to end. Three projects, one
// per criterion:
//   P1 — healthy origin: snapshot rides refs/t3/wip/* on the origin.
//   P2 — origin denies pushes (pre-receive hook): snapshot ships as a
//        kind=wip bundle blob over the peer mirror.
//   P3 — origin vanishes after setup: the push failure surfaces in the
//        shell snapshot's roamingWipStatus.
// Plus the 2026-07-07 field-bug regression: re-materializing after deleting
// the files must actually re-materialize, not return a stale success.
//
// Run the harness FRESH first:
//   scripts/roaming/harness.sh stop; rm -rf /tmp/t3-roaming-harness
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m3.mjs

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
const git = makeGit("m3");
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
pass("fresh harness, roaming off on both");

// ── 1. three projects on A ─────────────────────────────────────────────
const makeProject = (slug) => {
  const dir = join(HARNESS_DIR, `m3-${slug}`);
  const origin = join(HARNESS_DIR, `m3-${slug}-origin.git`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
  git(["init", "--bare", "-b", "main", origin]);
  git(["init", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), `${slug} base\n`);
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(["-C", dir, "add", "."]);
  git(["-C", dir, "commit", "-m", "init"]);
  git(["-C", dir, "remote", "add", "origin", origin]);
  git(["-C", dir, "push", "origin", "main"]);
  return { dir, origin };
};
const p1 = makeProject("p1");
const p2 = makeProject("p2");
const p3 = makeProject("p3");
const P1_ENV = "SECRET=vault-only\n";
writeFileSync(join(p1.dir, ".env"), P1_ENV);
// P2's origin refuses pushes from the start — its WIP must take the bundle path.
writeFileSync(
  join(p2.origin, "hooks", "pre-receive"),
  "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n",
);
chmodSync(join(p2.origin, "hooks", "pre-receive"), 0o755);

const materializeRoot = join(HARNESS_DIR, "m3-b-workspace");
rmSync(materializeRoot, { recursive: true, force: true });
mkdirSync(materializeRoot, { recursive: true });

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
for (const [title, project] of [
  ["M3 P1", p1],
  ["M3 P2", p2],
  ["M3 P3", p3],
]) {
  const created = await api(A.url, "/api/orchestration/dispatch", {
    method: "POST",
    token: adminA,
    body: {
      type: "project.create",
      commandId: randomUUID(),
      projectId: `m3-${randomUUID()}`,
      title,
      workspaceRoot: project.dir,
      createdAt: new Date().toISOString(),
    },
  });
  if (!created.ok) fail("project.create", `${title}: ${created.status} ${await created.text()}`);
}
pass("P1 (healthy origin), P2 (push-denied origin), P3 (doomed origin) on A");

// ── 2. pair once, WIP consent riding the one dialog decision ──────────
const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "Another machine of yours", scopes: ADMIN_SCOPES },
});
if (!codeResponse.ok) fail("pairing-token", `${codeResponse.status}`);
const pairingCode = (await codeResponse.json()).credential;
const pairResponse = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: pairingCode,
    syncOptions: { secretsSync: true, wipSync: true },
  },
});
if (!pairResponse.ok) fail("pair", `${pairResponse.status} ${await pairResponse.text()}`);
const paired = await pairResponse.json();
if (paired.peer === null) fail("pair", "mirror not established");
const environmentIdA = readFileSync(join(A.base, "userdata", "environment-id"), "utf8").trim();

const settingsAfterPair = await waitFor("wip consent on both machines", 15_000, async () => {
  const a = readSettings(A);
  const b = readSettings(B);
  // D3: peer records carry the gate; settings carry only the consents.
  return hasRoamingPeers(A.base) &&
    a.roamingWipSync === true &&
    a.roamingSecretsSync === true &&
    hasRoamingPeers(B.base) &&
    b.roamingWipSync === true
    ? { a, b }
    : null;
});
if (!settingsAfterPair) fail("settings", "unreachable");
pass("one pairing call: wipSync consent applied on BOTH machines");

// ── 3. dirty all three trees on A ──────────────────────────────────────
writeFileSync(join(p1.dir, "README.md"), "p1 DIRTY uncommitted\n");
writeFileSync(join(p1.dir, "scratch.txt"), "untracked work\n");
writeFileSync(join(p2.dir, "README.md"), "p2 DIRTY via bundle\n");
writeFileSync(join(p3.dir, "README.md"), "p3 DIRTY doomed\n");
// P3's origin disappears — pushes must fail with a surfaced error.
renameSync(p3.origin, `${p3.origin}.gone`);

// ── 4. P1: snapshot lands on the origin as hidden refs, vault excluded ─
const p1Ref = await waitFor("P1 origin wip ref (interval scan ≤2min + push)", 200_000, () => {
  const refs = git(["-C", p1.origin, "for-each-ref", "--format=%(refname)", "refs/t3/wip/"]);
  const line = refs.split("\n").find((entry) => entry.endsWith(`/${environmentIdA}`));
  if (!line) return null;
  const tree = git(["-C", p1.origin, "ls-tree", "--name-only", `${line}^{tree}`]);
  return tree.includes("scratch.txt") ? { ref: line, tree } : null;
});
if (!p1Ref.tree.includes("README.md")) fail("p1 wip", "README missing from snapshot tree");
if (p1Ref.tree.includes(".env"))
  fail("p1 wip", "SECRET LEAK: .env reached the origin in the WIP snapshot tree");
const p1DirtyContent = git(["-C", p1.origin, "show", `${p1Ref.ref}:README.md`]);
if (p1DirtyContent !== "p1 DIRTY uncommitted\n")
  fail("p1 wip", `snapshot content mismatch: ${p1DirtyContent}`);
const p1Parent = git(["-C", p1.origin, "rev-parse", `${p1Ref.ref}^`]).trim();
const p1Main = git(["-C", p1.origin, "rev-parse", "refs/heads/main"]).trim();
if (p1Parent !== p1Main) fail("p1 wip", "snapshot commit does not carry parent=HEAD");
pass("P1 dirty tree on the origin as refs/t3/wip/*, parent=HEAD, .env excluded");

// ── 5. P3: push failure surfaced in the shell snapshot ────────────────
await waitFor("P3 push failure surfaced", 200_000, async () => {
  const response = await api(A.url, "/api/orchestration/shell", { token: adminA });
  if (!response.ok) return null;
  const snapshot = await response.json();
  return (snapshot.roamingWipStatus ?? []).find(
    (entry) => entry.lastError && /push failed/.test(entry.lastError),
  );
});
pass("P3 push failure surfaced via roamingWipStatus (HTTP shell snapshot)");

// ── 6. P2: bundle fallback blob mirrors to B ───────────────────────────
const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m3-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe mint", `${probeMint.status}`);
const probeToken = (await probeMint.json()).token;
const manifestOnB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: probeToken,
    body: { environmentId: "m3-probe", manifest: [] },
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

// registry blobs give us title → workspaceProjectId
const registryByTitle = await waitFor("registries mirrored to B", 120_000, async () => {
  const manifest = await manifestOnB();
  const map = new Map();
  for (const entry of manifest.filter((candidate) => candidate.kind === "registry")) {
    const blob = await fetchBlobFromB("registry", entry.key);
    if (blob) map.set(JSON.parse(blob.payload).title, JSON.parse(blob.payload));
  }
  return map.size >= 3 ? map : null;
});
const wpidP1 = registryByTitle.get("M3 P1").workspaceProjectId;
const wpidP2 = registryByTitle.get("M3 P2").workspaceProjectId;

const p2WipBlob = await waitFor("P2 wip bundle blob on B", 200_000, async () => {
  const blob = await fetchBlobFromB("wip", `${wpidP2}/${environmentIdA}`);
  return blob ?? null;
});
const p2Payload = JSON.parse(p2WipBlob.payload);
if (p2Payload.refName !== `refs/t3/wip/${wpidP2}/${environmentIdA}`)
  fail("p2 bundle", `unexpected refName ${p2Payload.refName}`);
if (!p2Payload.bundleBase64 || !p2Payload.treeOid) fail("p2 bundle", "payload incomplete");
pass("P2 WIP travelled as a bundle blob over the mirror (origin refuses pushes)");

// ── 7. kill A, materialize both on B ───────────────────────────────────
const pidA = Number(readFileSync(join(HARNESS_DIR, "instance-a/server.pid"), "utf8").trim());
process.kill(pidA, "SIGKILL");
await sleep(1000);
const aDown = await api(A.url, "/.well-known/t3/environment").then(
  (r) => !r.ok,
  () => true,
);
if (!aDown) fail("kill-a", "A is still up");

const materializeOnB = async (wpid, target) => {
  const response = await api(B.url, "/api/roaming/materialize", {
    method: "POST",
    token: adminB,
    body: { workspaceProjectId: wpid, targetPath: target },
  });
  if (!response.ok) fail("materialize", `${response.status} ${await response.text()}`);
  return (await response.json()).materialization;
};

const p1Target = join(materializeRoot, "p1");
const m1 = await materializeOnB(wpidP1, p1Target);
if (m1.status !== "completed") fail("p1 materialize", JSON.stringify(m1));
const m1Wip = m1.steps.find((step) => step.step === "restore-wip");
if (m1Wip?.status !== "completed" || !/applied work in progress from/.test(m1Wip?.detail ?? ""))
  fail("p1 materialize", `restore-wip step: ${JSON.stringify(m1Wip)}`);
if (readFileSync(join(p1Target, "README.md"), "utf8") !== "p1 DIRTY uncommitted\n")
  fail("p1 materialize", "dirty README did not arrive");
if (readFileSync(join(p1Target, "scratch.txt"), "utf8") !== "untracked work\n")
  fail("p1 materialize", "untracked file did not arrive");
if (readFileSync(join(p1Target, ".env"), "utf8") !== P1_ENV)
  fail("p1 materialize", ".env did not arrive via the vault");
pass("A KILLED — P1 dirty tree materialized on B from the origin's hidden refs");

const p2Target = join(materializeRoot, "p2");
const m2 = await materializeOnB(wpidP2, p2Target);
if (m2.status !== "completed") fail("p2 materialize", JSON.stringify(m2));
const m2Wip = m2.steps.find((step) => step.step === "restore-wip");
if (m2Wip?.status !== "completed")
  fail("p2 materialize", `restore-wip step: ${JSON.stringify(m2Wip)}`);
if (readFileSync(join(p2Target, "README.md"), "utf8") !== "p2 DIRTY via bundle\n")
  fail("p2 materialize", "bundle-carried dirty README did not arrive");
pass("A still dead — P2 dirty tree materialized on B from the mirrored bundle blob");

// ── 8. field-bug regression: delete files, materialize again ──────────
rmSync(p1Target, { recursive: true, force: true });
const m1Again = await materializeOnB(wpidP1, p1Target);
if (m1Again.status !== "completed") fail("re-materialize", JSON.stringify(m1Again));
if (!existsSync(join(p1Target, "README.md")))
  fail("re-materialize", "stale completed record short-circuited — nothing was materialized");
if (readFileSync(join(p1Target, "README.md"), "utf8") !== "p1 DIRTY uncommitted\n")
  fail("re-materialize", "re-materialized content mismatch");
pass("deleted files re-materialize for real (2026-07-07 field-bug regression)");

console.log("\nM3 ACCEPTANCE: ALL CRITERIA PASS");
