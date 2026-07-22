// M2 acceptance (.plans/21-roaming-workspace.md): one action takes instance
// B from empty to a registered checkout with vault files applied while A is
// offline (from B's mirrored copy); a concurrent vault edit surfaces as a
// conflict, never a merge; A's projects reach B's list with no user-visible
// enrollment step (auto-enroll on peer-added AND on project-created); and
// materializing a project without synced secrets completes with an honest
// "no secret files synced" notice.
//
// Run the harness first:
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m2.mjs
//
// Drives only production surfaces: settings hot-reload (settings.json), the
// auth CLI, orchestration dispatch, and the roaming HTTP routes (peers,
// mirror, materialize, conflicts). The fabricated equal-version vault push
// in step 6 is byte-for-byte what instance A's mirror would send after a
// concurrent edit while the machines were apart.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "m2",
  GIT_AUTHOR_EMAIL: "m2@test",
  GIT_COMMITTER_NAME: "m2",
  GIT_COMMITTER_EMAIL: "m2@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv });

// ── 0. preconditions + roaming settings via hot-reload ───────────────
for (const inst of [A, B]) {
  const up = await api(inst.url, "/.well-known/t3/environment").then(
    (r) => r.ok,
    () => false,
  );
  if (!up) fail("preflight", `${inst.name} is not running — start the harness first`);
}

// Capture consent lives on the authoring machine only (per-machine setting);
// D3: no stored roaming flag — the gate turns on at pairing (below). Only
// A's secrets-capture consent is a setting.
writeFileSync(
  join(A.base, "userdata", "settings.json"),
  JSON.stringify({ roamingSecretsSync: true }),
);
await sleep(1500); // settings watcher debounce + reactor reaction
pass("secrets-capture consent set on A (gate follows pairing, D3)");

// ── 1. two test repositories: P1 with secrets, P2 without ────────────
const p1Dir = join(HARNESS_DIR, "m2-p1");
const p1Origin = join(HARNESS_DIR, "m2-p1-origin.git");
const p2Dir = join(HARNESS_DIR, "m2-p2");
const p2Origin = join(HARNESS_DIR, "m2-p2-origin.git");
const materializeRoot = join(HARNESS_DIR, "m2-b-workspace");
for (const dir of [p1Dir, p1Origin, p2Dir, p2Origin, materializeRoot]) {
  rmSync(dir, { recursive: true, force: true });
}
mkdirSync(materializeRoot, { recursive: true });

git(["init", "--bare", p1Origin]);
git(["init", p1Dir]);
writeFileSync(join(p1Dir, "README.md"), "m2 p1\n");
writeFileSync(join(p1Dir, ".gitignore"), ".env\n");
writeFileSync(join(p1Dir, ".env.example"), "EXAMPLE=committed\n");
git(["-C", p1Dir, "add", "."]);
git(["-C", p1Dir, "commit", "-m", "init"]);
git(["-C", p1Dir, "remote", "add", "origin", p1Origin]);
git(["-C", p1Dir, "push", "origin", "HEAD"]);
const P1_ENV = "SECRET=only-on-a\n";
writeFileSync(join(p1Dir, ".env"), P1_ENV); // untracked + gitignored → vault

git(["init", "--bare", p2Origin]);
git(["init", p2Dir]);
writeFileSync(join(p2Dir, "README.md"), "m2 p2\n");
git(["-C", p2Dir, "add", "."]);
git(["-C", p2Dir, "commit", "-m", "init"]);
git(["-C", p2Dir, "remote", "add", "origin", p2Origin]);
git(["-C", p2Dir, "push", "origin", "HEAD"]);
pass("test repos prepared (P1 with .env + committed .env.example, P2 clean)");

// ── 2. P1 on A, then pair A→B: auto-enroll must cover existing projects ──
const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);

const createProject = async (title, workspaceRoot) => {
  const projectId = `m2-${randomUUID()}`;
  const response = await api(A.url, "/api/orchestration/dispatch", {
    method: "POST",
    token: adminA,
    body: {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title,
      workspaceRoot,
      createdAt: new Date().toISOString(),
    },
  });
  if (!response.ok) fail("project.create", `${response.status} ${await response.text()}`);
  return projectId;
};

await createProject("M2 P1", p1Dir);
pass("P1 created on A (before pairing — no enrollment step)");

const pairingJson = JSON.parse(
  cli(["auth", "pairing", "create", "--admin", "--base-dir", B.base, "--json"]),
);
const pairingCredential = pairingJson.credential ?? pairingJson.token;
const addPeerResponse = await api(A.url, "/api/roaming/peers", {
  method: "POST",
  token: adminA,
  body: { baseUrls: [B.url], pairingCredential },
});
if (!addPeerResponse.ok)
  fail("addPeer", `${addPeerResponse.status} ${await addPeerResponse.text()}`);
const { peer } = await addPeerResponse.json();
pass(`A paired with ${peer.environmentId}`);

await createProject("M2 P2", p2Dir);
pass("P2 created on A (after pairing — tests the project-created trigger)");

// ── 3. both registry entries + P1's vault reach B by mirror ──────────
const machineToken = readFileSync(
  join(A.base, "userdata", "secrets", `roaming-peer-${peer.environmentId}.bin`),
  "utf8",
);
const environmentIdA = readFileSync(join(A.base, "userdata", "environment-id"), "utf8").trim();

const manifestOnB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/manifest", {
    method: "POST",
    token: machineToken,
    body: { environmentId: environmentIdA, manifest: [] },
  });
  if (!response.ok) return [];
  const { manifest } = await response.json();
  return manifest;
};

const fetchBlobFromB = async (kind, key) => {
  const response = await api(B.url, "/api/roaming/mirror/fetch", {
    method: "POST",
    token: machineToken,
    body: { refs: [{ kind, key }] },
  });
  if (!response.ok) return null;
  const { blobs } = await response.json();
  return blobs[0] ?? null;
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

const registryBlobs = await waitFor("mirror registry", 45_000, async () => {
  const manifest = await manifestOnB();
  const registryKeys = manifest.filter((entry) => entry.kind === "registry").map((e) => e.key);
  if (registryKeys.length < 2) return null;
  const blobs = [];
  for (const key of registryKeys) {
    const blob = await fetchBlobFromB("registry", key);
    if (blob) blobs.push(blob);
  }
  const titles = blobs.map((blob) => JSON.parse(blob.payload).title);
  return titles.includes("M2 P1") && titles.includes("M2 P2") ? blobs : null;
});
const wpid = (title) =>
  registryBlobs.map((blob) => JSON.parse(blob.payload)).find((payload) => payload.title === title)
    .workspaceProjectId;
const wpidP1 = wpid("M2 P1");
const wpidP2 = wpid("M2 P2");
pass("both projects auto-enrolled and mirrored to B (peer-added + project-created triggers)");

const vaultBlob = await waitFor("mirror vault", 45_000, () => fetchBlobFromB("vault", wpidP1));
const vaultBundle = JSON.parse(vaultBlob.payload);
const vaultPaths = vaultBundle.files.map((file) => file.path);
if (!vaultPaths.includes(".env")) fail("vault content", `.env missing: ${vaultPaths.join(", ")}`);
if (vaultPaths.includes(".env.example"))
  fail("vault content", "committed .env.example was captured — tracked-file guard failed");
const envEntry = vaultBundle.files.find((file) => file.path === ".env");
if (Buffer.from(envEntry.contentBase64, "base64").toString() !== P1_ENV)
  fail("vault content", ".env content mismatch");
pass("P1's vault reached B: .env captured, committed .env.example excluded");

// ── 4. concurrent vault edit auto-resolves newest-wins (D1) ──────────
// The forged concurrent write carries an OLDER updatedAt, so B's copy wins
// deterministically and the loser is preserved in the conflict record.
const forgedPayload = JSON.stringify({
  ...vaultBundle,
  files: [
    {
      path: ".env",
      sha256: createHash("sha256").update("SECRET=edited-on-other-side\n").digest("hex"),
      contentBase64: Buffer.from("SECRET=edited-on-other-side\n").toString("base64"),
    },
  ],
});
const conflictPush = await api(B.url, "/api/roaming/mirror/push", {
  method: "POST",
  token: machineToken,
  body: {
    environmentId: environmentIdA,
    blobs: [
      {
        schemaVersion: 1,
        kind: "vault",
        key: wpidP1,
        workspaceProjectId: wpidP1,
        version: vaultBlob.version, // same version, different content = concurrent write
        contentHash: createHash("sha256").update(forgedPayload, "utf8").digest("hex"),
        authorEnvironmentId: environmentIdA,
        updatedAt: "2020-01-01T00:00:00.000Z", // older concurrent write → B wins
        payload: forgedPayload,
      },
    ],
  },
});
if (!conflictPush.ok) fail("conflict push", `${conflictPush.status} ${await conflictPush.text()}`);
const pushResults = (await conflictPush.json()).results;
if (pushResults[0]?.outcome !== "conflict")
  fail("conflict push", `expected outcome "conflict", got ${JSON.stringify(pushResults)}`);

const localAfterConflict = await fetchBlobFromB("vault", wpidP1);
if (localAfterConflict.contentHash !== vaultBlob.contentHash)
  fail("conflict", "B's local vault blob changed — concurrent write was merged/overwritten");

const readConflictLoser = () => {
  const db = new DatabaseSync(join(B.base, "userdata", "state.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT remote_record AS loser FROM roaming_blob_conflicts WHERE kind='vault' AND key=?",
      )
      .get(wpidP1);
    return row ? JSON.parse(row.loser) : null;
  } finally {
    db.close();
  }
};
const loser = readConflictLoser();
if (loser === null || loser.payload !== forgedPayload)
  fail("conflict record", "losing concurrent write not preserved in the conflict record");
pass("concurrent vault edit auto-resolved newest-wins: winner kept, loser preserved");

// ── 5. kill A ─────────────────────────────────────────────────────────
const pidA = Number(readFileSync(join(HARNESS_DIR, "instance-a/server.pid"), "utf8").trim());
process.kill(pidA, "SIGKILL");
await sleep(1000);
const aDown = await api(A.url, "/.well-known/t3/environment").then(
  (r) => !r.ok,
  () => true,
);
if (!aDown) fail("kill-a", "A is still up");
pass("A killed — everything below runs from B's mirrored copies");

// ── 6. materialize P2 on B: no synced secrets → honest notice ─────────
const materialize = async (workspaceProjectId, targetPath) => {
  const response = await api(B.url, "/api/roaming/materialize", {
    method: "POST",
    token: adminB,
    body: { workspaceProjectId, targetPath },
  });
  if (!response.ok) fail("materialize", `${response.status} ${await response.text()}`);
  return (await response.json()).materialization;
};

const p2Target = join(materializeRoot, "p2");
const p2Result = await materialize(wpidP2, p2Target);
if (p2Result.status !== "completed") fail("materialize p2", JSON.stringify(p2Result));
if (!p2Result.notices.some((notice) => notice.includes("no secret files synced")))
  fail(
    "materialize p2",
    `expected "no secret files synced" notice, got ${JSON.stringify(p2Result.notices)}`,
  );
if (!existsSync(join(p2Target, "README.md"))) fail("materialize p2", "clone missing README.md");
if (p2Result.localProjectId === null) fail("materialize p2", "project not registered on B");
pass('P2 materialized with honest "no secret files synced" notice');

// ── 7. materialize P1 on B: clone + vault applied, registered ─────────
const p1Target = join(materializeRoot, "p1");
const p1Result = await materialize(wpidP1, p1Target);
if (p1Result.status !== "completed") fail("materialize p1", JSON.stringify(p1Result));
if (!existsSync(join(p1Target, "README.md"))) fail("materialize p1", "clone missing README.md");
const appliedEnv = readFileSync(join(p1Target, ".env"), "utf8");
if (appliedEnv !== P1_ENV) fail("materialize p1", `vault .env mismatch: ${appliedEnv}`);
if (p1Result.localProjectId === null) fail("materialize p1", "project not registered on B");
const cloneStep = p1Result.steps.find((step) => step.step === "clone");
const vaultStep = p1Result.steps.find((step) => step.step === "apply-vault");
if (cloneStep?.status !== "completed" || vaultStep?.status !== "completed")
  fail("materialize p1", `unexpected steps: ${JSON.stringify(p1Result.steps)}`);
pass("one action took B from empty to a registered checkout with vault files, A offline");

// ── 8. the resolved conflict record survives as an inspectable notice ─
// (D1: resolution is automatic; the record is superseded by the next
// accepted write for the key — covered by unit tests.)
if (readConflictLoser() === null)
  fail("conflict record", "auto-resolved conflict record disappeared without a superseding write");
pass("auto-resolved conflict record retained for inspection (no manual resolve surface)");

console.log("\nM2 ACCEPTANCE: ALL CRITERIA PASS");
