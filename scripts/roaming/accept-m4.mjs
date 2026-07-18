// M4 takeover + divergence acceptance on the fresh M0 two-instance harness.
// Covers: lease-driven activity records in the shell (the "active on
// <machine>" chip data), takeover snapshot pinning, the two-sided divergence
// data route, both divergence resolutions (keep local / take peer) with the
// losing side recoverable as a ref, and the lease moving on takeover.
// The canonical pairing/thin-client walk remains accept-m2.5.mjs and is
// rerun separately; classifier changes also rerun the full m35–m38 ladder.
//
// Transport: origins hide refs/t3 by default (bundle fallback), matching
// accept-m38; T3_M4_TRANSPORT=origin runs the origin-refs path. The
// divergence setup relies on the sync pause, which only fully stops
// exchange in bundle mode — in origin mode the pause window is covered by
// creating both sides' commits back-to-back before the next apply pass.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const { execFileSync } = NodeChildProcess;
const { randomUUID } = NodeCrypto;
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = NodeFS;
const { join } = NodePath;

const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const A = {
  url: "http://127.0.0.1:14801",
  base: join(HARNESS_DIR, "instance-a/basedir"),
};
const B = {
  url: "http://127.0.0.1:14802",
  base: join(HARNESS_DIR, "instance-b/basedir"),
};
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
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "m4",
  GIT_AUTHOR_EMAIL: "m4@test",
  GIT_COMMITTER_NAME: "m4",
  GIT_COMMITTER_EMAIL: "m4@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" }).trim();
const api = (base, path, { method = "GET", token, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const waitFor = async (step, timeoutMs, probe, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  fail(step, `condition not met within ${timeoutMs / 1000}s`);
};
const settings = (instance) => {
  const file = join(instance.base, "userdata/settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
const shellOf = async (instance, token) => {
  const response = await api(instance.url, "/api/orchestration/shell", { token });
  return response.ok ? response.json() : null;
};

for (const instance of [A, B]) {
  const up = await api(instance.url, "/.well-known/t3/environment").then(
    (response) => response.ok,
    () => false,
  );
  if (!up) fail("preflight", `${instance.url} is not running`);
  if (settings(instance).roaming === true) fail("preflight", "harness is not fresh");
}
pass("fresh M0 harness");

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
const envA = (await (await api(A.url, "/.well-known/t3/environment")).json()).environmentId;
const envB = (await (await api(B.url, "/.well-known/t3/environment")).json()).environmentId;
if (!envA || !envB) fail("preflight", "environment ids not discoverable");

// ── Setup: one repo on A, pair once with WIP on, materialize on B ────────
const work = join(HARNESS_DIR, "m4-primary-work");
const origin = join(HARNESS_DIR, "m4-primary-origin.git");
rmSync(work, { recursive: true, force: true });
rmSync(origin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", origin]);
if (process.env.T3_M4_TRANSPORT !== "origin") {
  git(["-C", origin, "config", "receive.hideRefs", "refs/t3"]);
}
git(["init", "-b", "main", work]);
writeFileSync(join(work, "README.md"), "M4 Primary\n");
git(["-C", work, "add", "."]);
git(["-C", work, "commit", "-m", "base"]);
git(["-C", work, "remote", "add", "origin", origin]);
git(["-C", work, "push", "origin", "main"]);
const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `m4-primary-${randomUUID()}`,
    title: "M4 Primary",
    workspaceRoot: work,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) fail("project.create", `${created.status}`);

const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "M4 other machine", scopes: ADMIN_SCOPES },
});
if (!codeResponse.ok) fail("pairing code", `${codeResponse.status}`);
const paired = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: (await codeResponse.json()).credential,
    syncOptions: { secretsSync: true, wipSync: true },
  },
});
if (!paired.ok || (await paired.json()).peer === null) fail("pairing", `${paired.status}`);
pass("paired once with WIP enabled");

const registry = await waitFor("registry reaches B", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  return (
    shell?.roamingProjects?.find((candidate) => candidate.title === "M4 Primary") ?? null
  );
});
const wsid = registry.workspaceProjectId;
const bRoot = join(HARNESS_DIR, "m4-b-workspace");
const bWork = join(bRoot, "primary");
rmSync(bRoot, { recursive: true, force: true });
mkdirSync(bRoot, { recursive: true });
const materialized = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wsid, targetPath: bWork },
});
if (!materialized.ok) fail("materialize", `${materialized.status}`);
if ((await materialized.json()).materialization.status !== "completed")
  fail("materialize", "step machine did not complete");
pass("materialized on B");

// ── Lease-driven activity: A works, B's shell shows A active ────────────
writeFileSync(join(work, "a-activity.txt"), "A is working\n");
await waitFor("A WIP reaches B", 120_000, async () =>
  existsSync(join(bWork, "a-activity.txt")) ? true : null,
);
const activityOnB = await waitFor("A's activity record reaches B's shell", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  const project = shell?.roamingProjects?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  const newest = project?.activity?.[0];
  return newest && newest.environmentId === envA ? newest : null;
});
if (!activityOnB.lastSnapshotAt) fail("activity", "lease record lacks lastSnapshotAt");
pass("activity chip data: A's lease record is newest on B");

// ── Build a real two-sided divergence under a sync pause ────────────────
const peersOnB = await (
  await api(B.url, "/api/roaming/peers/list", { method: "POST", token: adminB, body: {} })
).json();
const peerRowEnv = peersOnB.peers[0]?.environmentId;
if (!peerRowEnv) fail("peers/list", "B has no peer row");
const setSync = async (enabled) => {
  const response = await api(B.url, "/api/roaming/peers/sync", {
    method: "POST",
    token: adminB,
    body: { environmentId: peerRowEnv, syncEnabled: enabled },
  });
  if (!response.ok) fail("peers/sync", `${response.status}`);
};
await setSync(false);
// Quiesce in-flight passes before creating the divergence.
await sleep(8_000);

writeFileSync(join(work, "a-side.txt"), "A version\n");
git(["-C", work, "add", "a-side.txt"]);
git(["-C", work, "commit", "-m", "A diverging commit"]);
const aDivergedHead = git(["-C", work, "rev-parse", "HEAD"]);
writeFileSync(join(bWork, "b-side.txt"), "B version\n");
git(["-C", bWork, "add", "b-side.txt"]);
git(["-C", bWork, "commit", "-m", "B diverging commit"]);
const bDivergedHead = git(["-C", bWork, "rev-parse", "HEAD"]);
await setSync(true);

const blockedOnB = await waitFor("B blocks with divergence", 180_000, async () => {
  const shell = await shellOf(B, adminB);
  const entry = shell?.roamingWipStatus?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  return entry?.divergenceAvailable === true && entry.blockedSnapshotOid ? entry : null;
});
if (!blockedOnB.blockedReason?.includes("diverged"))
  fail("divergence status", `unexpected reason: ${blockedOnB.blockedReason}`);
if (blockedOnB.blockedFrom !== envA)
  fail("divergence status", "blockedFrom does not name A's environment");
if (blockedOnB.takeoverAvailable !== true)
  fail("divergence status", "divergence must stay takeover-serviceable");
pass("B surfaces the divergence with snapshot identity");

// ── Two-sided divergence data ────────────────────────────────────────────
const divergenceOnB = await waitFor("divergence data on B", 60_000, async () => {
  const response = await api(B.url, "/api/roaming/wip/divergence", {
    method: "POST",
    token: adminB,
    body: { workspaceProjectId: wsid },
  });
  if (!response.ok) return null;
  return (await response.json()).divergence;
});
const expectedBase = git(["-C", bWork, "merge-base", bDivergedHead, aDivergedHead]);
if (divergenceOnB.baseOid !== expectedBase)
  fail("divergence data", "baseOid is not the merge-base of the two HEADs");
if (divergenceOnB.local.headOid !== bDivergedHead || divergenceOnB.peer.headOid !== aDivergedHead)
  fail("divergence data", "sides do not carry the two HEADs");
if (!divergenceOnB.local.patch.includes("b-side.txt"))
  fail("divergence data", "local patch misses B's work");
if (!divergenceOnB.peer.patch.includes("a-side.txt"))
  fail("divergence data", "peer patch misses A's work");
if (divergenceOnB.peer.snapshotOid !== blockedOnB.blockedSnapshotOid)
  fail("divergence data", "peer snapshot differs from the blocked snapshot");
if (divergenceOnB.peer.environmentId !== envA)
  fail("divergence data", "peer side does not name A's environment");
pass("divergence returns merge-base + both sides' full working state");

// ── Takeover pinning refuses a snapshot the user never saw ──────────────
const pinned = await api(B.url, "/api/roaming/wip/takeover", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wsid, snapshotOid: "0".repeat(40) },
});
const pinnedResult = await pinned.json();
if (!pinned.ok || pinnedResult.applied !== false || !pinnedResult.reason)
  fail("takeover pinning", "stale snapshot pin did not refuse with a reason");
if (git(["-C", bWork, "rev-parse", "HEAD"]) !== bDivergedHead)
  fail("takeover pinning", "refused takeover still moved HEAD");
pass("takeover pinned to a stale snapshot refuses with a reason");

// ── Resolve on B: keep local; A's version stays recoverable ─────────────
const mismatch = await (
  await api(B.url, "/api/roaming/wip/divergence/resolve", {
    method: "POST",
    token: adminB,
    body: { workspaceProjectId: wsid, pick: "local", peerSnapshotOid: "0".repeat(40) },
  })
).json();
if (mismatch.resolved !== false) fail("resolve pinning", "stale peer snapshot did not refuse");

const keptLocal = await (
  await api(B.url, "/api/roaming/wip/divergence/resolve", {
    method: "POST",
    token: adminB,
    body: {
      workspaceProjectId: wsid,
      pick: "local",
      peerSnapshotOid: divergenceOnB.peer.snapshotOid,
    },
  })
).json();
if (keptLocal.resolved !== true) fail("keep local", `not resolved: ${keptLocal.reason}`);
const rejectedRef = `refs/t3/wip-rejected/${wsid}/${envA}`;
if (keptLocal.preservedRef !== rejectedRef)
  fail("keep local", `unexpected preservedRef ${keptLocal.preservedRef}`);
if (git(["-C", bWork, "rev-parse", rejectedRef]) !== divergenceOnB.peer.snapshotOid)
  fail("keep local", "rejected snapshot ref does not pin A's snapshot");
if (git(["-C", bWork, "rev-parse", "HEAD"]) !== bDivergedHead)
  fail("keep local", "keep-local moved HEAD");
if (existsSync(join(bWork, "a-side.txt"))) fail("keep local", "A's file leaked into B's worktree");
await waitFor("B clears the divergence after keeping local", 120_000, async () => {
  const shell = await shellOf(B, adminB);
  const entry = shell?.roamingWipStatus?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  return entry && entry.blockedReason === undefined ? true : null;
});
pass("keep-local resolves B: worktree untouched, A's version pinned recoverable");

// ── Resolve on A: take B's version; A's version stays recoverable ───────
const blockedOnA = await waitFor("A blocks with divergence", 180_000, async () => {
  const shell = await shellOf(A, adminA);
  const entry = shell?.roamingWipStatus?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  return entry?.divergenceAvailable === true && entry.blockedSnapshotOid ? entry : null;
});
const divergenceOnA = await waitFor("divergence data on A", 60_000, async () => {
  const response = await api(A.url, "/api/roaming/wip/divergence", {
    method: "POST",
    token: adminA,
    body: { workspaceProjectId: wsid },
  });
  if (!response.ok) return null;
  return (await response.json()).divergence;
});
if (divergenceOnA.peer.environmentId !== envB)
  fail("divergence on A", "peer side does not name B's environment");
const tookPeer = await (
  await api(A.url, "/api/roaming/wip/divergence/resolve", {
    method: "POST",
    token: adminA,
    body: {
      workspaceProjectId: wsid,
      pick: "peer",
      peerSnapshotOid: divergenceOnA.peer.snapshotOid,
    },
  })
).json();
if (tookPeer.resolved !== true) fail("take peer", `not resolved: ${tookPeer.reason}`);
if (git(["-C", work, "rev-parse", "HEAD"]) !== bDivergedHead)
  fail("take peer", "A did not land on B's HEAD");
if (readFileSync(join(work, "b-side.txt"), "utf8") !== "B version\n")
  fail("take peer", "B's committed work missing on A");
const parkedRef = `refs/t3/wip-parked/${wsid}/main`;
if (tookPeer.preservedRef !== parkedRef)
  fail("take peer", `unexpected preservedRef ${tookPeer.preservedRef}`);
if (git(["-C", work, "rev-parse", `${parkedRef}^`]) !== aDivergedHead)
  fail("take peer", "A's losing version is not recoverable from the parked ref");
if (git(["-C", work, "show", `${parkedRef}:a-side.txt`]) !== "A version")
  fail("take peer", "A's losing file content is not recoverable");
await waitFor("A clears the divergence after taking B's version", 120_000, async () => {
  const shell = await shellOf(A, adminA);
  const entry = shell?.roamingWipStatus?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  return entry && entry.blockedReason === undefined ? true : null;
});
pass("take-peer resolves A: lands on B's state, own version parked recoverable");

// ── Takeover moved the lease: A's activity record is now the newest ─────
await waitFor("lease moved to A after takeover", 120_000, async () => {
  const shell = await shellOf(A, adminA);
  const project = shell?.roamingProjects?.find(
    (candidate) => candidate.workspaceProjectId === wsid,
  );
  return project?.activity?.[0]?.environmentId === envA ? true : null;
});
pass("takeover moved the lease: A's activity record is newest");

// ── Both machines settle on the same state ───────────────────────────────
await waitFor("both machines settle non-blocked on the same HEAD", 120_000, async () => {
  if (git(["-C", work, "rev-parse", "HEAD"]) !== git(["-C", bWork, "rev-parse", "HEAD"]))
    return null;
  for (const [instance, token] of [
    [A, adminA],
    [B, adminB],
  ]) {
    const shell = await shellOf(instance, token);
    const entry = shell?.roamingWipStatus?.find(
      (candidate) => candidate.workspaceProjectId === wsid,
    );
    if (!entry || entry.blockedReason !== undefined) return null;
  }
  return true;
});
pass("both machines settle unblocked on the same state");

console.log("M4 ACCEPTANCE PASSED");
