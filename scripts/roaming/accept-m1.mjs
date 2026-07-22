// M1 acceptance (.plans/21-roaming-workspace.md): enroll a project on
// instance A; instance B holds it (title, repo, per-machine roots) after a
// mirror pass; kill A; B still serves it from its local copy.
//
// Run the harness first:
//   scripts/roaming/harness.sh start
//   node scripts/roaming/accept-m1.mjs
//
// The script drives only production surfaces: the auth CLI, the orchestration
// dispatch endpoint, and the roaming enrollment + mirror HTTP RPCs. It reads
// A's stored machine credential from A's secret store (local test box) to
// query B the way A's mirror does.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { A, B, HARNESS_DIR, REPO_ROOT, api, cli, fail, makeGitEnv, pass } from "./harness-lib.mjs";
const gitEnv = makeGitEnv("m1");

// ── 0. preconditions ─────────────────────────────────────────────────
for (const inst of [A, B]) {
  const up = await api(inst.url, "/.well-known/t3/environment").then(
    (r) => r.ok,
    () => false,
  );
  if (!up) fail("preflight", `${inst.name} is not running — start the harness first`);
}

// ── 1. test repository with an origin remote ─────────────────────────
const workDir = join(HARNESS_DIR, "m1-project");
const originDir = join(HARNESS_DIR, "m1-origin.git");
rmSync(workDir, { recursive: true, force: true });
rmSync(originDir, { recursive: true, force: true });
execFileSync("git", ["init", "--bare", originDir]);
execFileSync("git", ["init", workDir]);
writeFileSync(join(workDir, "README.md"), "m1 acceptance\n");
execFileSync("git", ["-C", workDir, "add", "."], { env: gitEnv });
execFileSync("git", ["-C", workDir, "commit", "-m", "init"], { env: gitEnv });
execFileSync("git", ["-C", workDir, "remote", "add", "origin", originDir]);
pass("test repo prepared");

// ── 2. admin bearer on A, project create + enroll ─────────────────────
const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);

const projectId = `m1-${randomUUID()}`;
const dispatchResponse = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "M1 Acceptance Project",
    workspaceRoot: workDir,
    createdAt: new Date().toISOString(),
  },
});
if (!dispatchResponse.ok)
  fail("project.create", `${dispatchResponse.status} ${await dispatchResponse.text()}`);
pass("project created on A");

// ── 3. peer enrollment A → B (admin pairing credential from B) ────────
const pairingJson = JSON.parse(
  cli(["auth", "pairing", "create", "--admin", "--base-dir", B.base, "--json"]),
);
const pairingCredential = pairingJson.credential ?? pairingJson.token;
if (!pairingCredential)
  fail("pairing", `unrecognized pairing output: ${JSON.stringify(pairingJson)}`);

const addPeerResponse = await api(A.url, "/api/roaming/peers", {
  method: "POST",
  token: adminA,
  body: { baseUrls: [B.url], pairingCredential },
});
if (!addPeerResponse.ok)
  fail("addPeer", `${addPeerResponse.status} ${await addPeerResponse.text()}`);
const { peer } = await addPeerResponse.json();
pass(`peer enrolled: A now mirrors to ${peer.environmentId}`);

// ── 3b. enroll the project (D3: the roaming routes answer only once a
// peer exists, so enrollment follows pairing) ─────────────────────────
const enrollResponse = await api(A.url, "/api/roaming/projects/enroll", {
  method: "POST",
  token: adminA,
  body: { projectId },
});
if (!enrollResponse.ok) fail("enroll", `${enrollResponse.status} ${await enrollResponse.text()}`);
const { workspaceProjectId } = await enrollResponse.json();
if (!workspaceProjectId) fail("enroll", "no workspaceProjectId in response");
pass(`project enrolled on A as ${workspaceProjectId}`);

// ── 4. B holds the registry entry after a mirror pass ─────────────────
const credentialPath = join(
  A.base,
  "userdata",
  "secrets",
  `roaming-peer-${peer.environmentId}.bin`,
);
if (!existsSync(credentialPath))
  fail("credential", `machine credential not stored at ${credentialPath}`);
const machineToken = readFileSync(credentialPath, "utf8");

const environmentIdA = readFileSync(join(A.base, "userdata", "environment-id"), "utf8").trim();

const waitForBlobOnB = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const manifestResponse = await api(B.url, "/api/roaming/mirror/manifest", {
      method: "POST",
      token: machineToken,
      body: { environmentId: environmentIdA, manifest: [] },
    });
    if (manifestResponse.ok) {
      const { manifest } = await manifestResponse.json();
      if (manifest.some((entry) => entry.kind === "registry" && entry.key === workspaceProjectId)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

if (!(await waitForBlobOnB(30_000))) fail("mirror", "registry blob did not reach B within 30s");
pass("registry entry reached B via mirror pass");

const fetchFromB = async () => {
  const response = await api(B.url, "/api/roaming/mirror/fetch", {
    method: "POST",
    token: machineToken,
    body: { refs: [{ kind: "registry", key: workspaceProjectId }] },
  });
  if (!response.ok) return null;
  const { blobs } = await response.json();
  return blobs[0] ?? null;
};

const blob = await fetchFromB();
if (!blob) fail("fetch", "B did not return the registry blob");
const payload = JSON.parse(blob.payload);
if (payload.title !== "M1 Acceptance Project") fail("payload", `title mismatch: ${payload.title}`);
if (!payload.repository?.locator?.remoteUrl?.includes("m1-origin.git"))
  fail("payload", `repository mismatch: ${JSON.stringify(payload.repository)}`);
if (payload.perMachineRoots?.[environmentIdA] !== workDir)
  fail("payload", `perMachineRoots mismatch: ${JSON.stringify(payload.perMachineRoots)}`);
pass("B's copy carries title, repository, and per-machine root");

// ── 5. kill A; B still serves its local copy ──────────────────────────
const pidA = Number(readFileSync(join(HARNESS_DIR, "instance-a/server.pid"), "utf8").trim());
process.kill(pidA, "SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 1000));

const aDown = await api(A.url, "/.well-known/t3/environment").then(
  (r) => !r.ok,
  () => true,
);
if (!aDown) fail("kill-a", "A is still up");
const bStillUp = await api(B.url, "/.well-known/t3/environment").then(
  (r) => r.ok,
  () => false,
);
if (!bStillUp) fail("kill-a", "B went down with A");

const blobAfterAKilled = await fetchFromB();
if (!blobAfterAKilled) fail("survival", "B lost the registry blob after A was killed");
if (blobAfterAKilled.contentHash !== blob.contentHash) fail("survival", "content hash changed");
pass("A killed; B still serves the registry entry from its local copy");

console.log("\nM1 ACCEPTANCE: ALL CRITERIA PASS");
