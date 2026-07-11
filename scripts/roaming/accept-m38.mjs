// M3.8 branch-aware WIP acceptance on the fresh M0 two-instance harness.
// Covers the canonical branch workflow, blocked variants, takeover parking,
// and branch-aware materialization. The canonical pairing/thin-client walk
// remains accept-m2.5.mjs and is rerun separately after this script.

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
  GIT_AUTHOR_NAME: "m38",
  GIT_AUTHOR_EMAIL: "m38@test",
  GIT_COMMITTER_NAME: "m38",
  GIT_COMMITTER_EMAIL: "m38@test",
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

const createRepo = async (title, slug) => {
  const work = join(HARNESS_DIR, `${slug}-work`);
  const origin = join(HARNESS_DIR, `${slug}-origin.git`);
  rmSync(work, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
  git(["init", "--bare", "-b", "main", origin]);
  git(["init", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), `${title}\n`);
  git(["-C", work, "add", "."]);
  git(["-C", work, "commit", "-m", "base"]);
  git(["-C", work, "remote", "add", "origin", origin]);
  git(["-C", work, "push", "origin", "main"]);
  const response = await api(A.url, "/api/orchestration/dispatch", {
    method: "POST",
    token: adminA,
    body: {
      type: "project.create",
      commandId: randomUUID(),
      projectId: `${slug}-${randomUUID()}`,
      title,
      workspaceRoot: work,
      createdAt: new Date().toISOString(),
    },
  });
  if (!response.ok) fail("project.create", `${response.status} ${await response.text()}`);
  return { work, origin };
};

const primary = await createRepo("M38 Primary", "m38-primary");
const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "M38 other machine", scopes: ADMIN_SCOPES },
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

const probeMint = await api(B.url, "/api/roaming/machine-credential", {
  method: "POST",
  token: adminB,
  body: { environmentId: "m38-probe", baseUrls: [] },
});
if (!probeMint.ok) fail("probe token", `${probeMint.status}`);
const probeToken = (await probeMint.json()).token;
const findRegistry = (title) =>
  waitFor(`registry ${title}`, 120_000, async () => {
    const manifestResponse = await api(B.url, "/api/roaming/mirror/manifest", {
      method: "POST",
      token: probeToken,
      body: { environmentId: "m38-probe", manifest: [] },
    });
    if (!manifestResponse.ok) return null;
    for (const entry of (await manifestResponse.json()).manifest.filter(
      (candidate) => candidate.kind === "registry",
    )) {
      const fetched = await api(B.url, "/api/roaming/mirror/fetch", {
        method: "POST",
        token: probeToken,
        body: { refs: [{ kind: "registry", key: entry.key }] },
      });
      if (!fetched.ok) continue;
      const blob = (await fetched.json()).blobs[0];
      if (blob && JSON.parse(blob.payload).title === title) return JSON.parse(blob.payload);
    }
    return null;
  });

const primaryRegistry = await findRegistry("M38 Primary");
const bRoot = join(HARNESS_DIR, "m38-b-workspace");
const bPrimary = join(bRoot, "primary");
rmSync(bRoot, { recursive: true, force: true });
mkdirSync(bRoot, { recursive: true });
const materialized = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: primaryRegistry.workspaceProjectId, targetPath: bPrimary },
});
if (!materialized.ok) fail("materialize primary", `${materialized.status}`);
if ((await materialized.json()).materialization.status !== "completed")
  fail("materialize primary", "step machine did not complete");

const assertCleanState = async (step, branch, head) =>
  waitFor(step, 120_000, async () => {
    if (git(["-C", bPrimary, "branch", "--show-current"]) !== branch) return null;
    if (git(["-C", bPrimary, "rev-parse", "HEAD"]) !== head) return null;
    return git(["-C", bPrimary, "status", "--porcelain"]) === "" ? true : null;
  });

git(["-C", primary.work, "switch", "-c", "feature/m38"]);
await assertCleanState(
  "B follows A's new branch without soup",
  "feature/m38",
  git(["-C", primary.work, "rev-parse", "HEAD"]),
);
pass("branch creation reproduced cleanly");

writeFileSync(join(primary.work, "feature.txt"), "feature commit\n");
git(["-C", primary.work, "add", "feature.txt"]);
git(["-C", primary.work, "commit", "-m", "feature work"]);
const featureHead = git(["-C", primary.work, "rev-parse", "HEAD"]);
await assertCleanState("B fast-forwards feature branch without soup", "feature/m38", featureHead);
pass("feature commit reproduced as a commit, not uncommitted soup");

git(["-C", primary.work, "switch", "main"]);
await assertCleanState(
  "B returns to main without soup",
  "main",
  git(["-C", primary.work, "rev-parse", "HEAD"]),
);
pass("return to main reproduced cleanly");

git(["-C", primary.work, "merge", "--no-ff", "feature/m38", "-m", "merge feature"]);
git(["-C", primary.work, "push", "origin", "main"]);
const mergeHead = git(["-C", primary.work, "rev-parse", "HEAD"]);
await assertCleanState("B lands on pushed merge without soup", "main", mergeHead);
pass("canonical branch workflow ends clean at the merge commit");

writeFileSync(join(bPrimary, "b-dirty.txt"), "local dirty\n");
writeFileSync(join(primary.work, "after-merge.txt"), "advance\n");
git(["-C", primary.work, "add", "after-merge.txt"]);
git(["-C", primary.work, "commit", "-m", "advance main"]);
git(["-C", primary.work, "push", "origin", "main"]);
const bHeadBeforeBlock = git(["-C", bPrimary, "rev-parse", "HEAD"]);
const blockedStatus = await waitFor("dirty fast-forward blocks", 120_000, async () => {
  const response = await api(B.url, "/api/orchestration/shell", { token: adminB });
  if (!response.ok) return null;
  return (await response.json()).roamingWipStatus?.find(
    (entry) =>
      entry.workspaceProjectId === primaryRegistry.workspaceProjectId &&
      entry.blockedReason?.includes("local edits") &&
      entry.takeoverAvailable === true,
  );
});
if (!blockedStatus) fail("dirty fast-forward", "missing blocked status");
if (git(["-C", bPrimary, "rev-parse", "HEAD"]) !== bHeadBeforeBlock)
  fail("dirty fast-forward", "HEAD moved while blocked");
if (readFileSync(join(bPrimary, "b-dirty.txt"), "utf8") !== "local dirty\n")
  fail("dirty fast-forward", "local tree changed while blocked");
pass("dirty main blocks with reason and touches nothing");

git(["-C", bPrimary, "fetch", "origin"]);
git(["-C", bPrimary, "reset", "--hard", "origin/main"]);
rmSync(join(bPrimary, "b-dirty.txt"), { force: true });
git(["-C", bPrimary, "switch", "-c", "b/own"]);
writeFileSync(join(bPrimary, "b-owned.txt"), "B commit\n");
git(["-C", bPrimary, "add", "b-owned.txt"]);
git(["-C", bPrimary, "commit", "-m", "B own branch"]);
const bOwnHead = git(["-C", bPrimary, "rev-parse", "HEAD"]);
writeFileSync(join(bPrimary, "b-local-wip.txt"), "B parked WIP\n");

git(["-C", primary.work, "switch", "-c", "a/takeover"]);
writeFileSync(join(primary.work, "a-wip.txt"), "A WIP\n");
await waitFor("B own branch blocks A branch", 120_000, async () => {
  const response = await api(B.url, "/api/orchestration/shell", { token: adminB });
  if (!response.ok) return null;
  return (await response.json()).roamingWipStatus?.some(
    (entry) =>
      entry.workspaceProjectId === primaryRegistry.workspaceProjectId &&
      entry.blockedReason?.includes("a/takeover"),
  );
});
if (git(["-C", bPrimary, "branch", "--show-current"]) !== "b/own")
  fail("B own branch", "auto-apply switched a touched checkout");
pass("B's own branch blocks and stays untouched");

const takeover = await api(B.url, "/api/roaming/wip/takeover", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: primaryRegistry.workspaceProjectId },
});
if (!takeover.ok || !(await takeover.json()).applied) fail("takeover", `${takeover.status}`);
if (git(["-C", bPrimary, "branch", "--show-current"]) !== "a/takeover")
  fail("takeover", "did not switch to A's branch");
if (readFileSync(join(bPrimary, "a-wip.txt"), "utf8") !== "A WIP\n")
  fail("takeover", "A's WIP was not restored");
const parked = `refs/t3/wip-parked/${primaryRegistry.workspaceProjectId}/b/own`;
if (git(["-C", bPrimary, "rev-parse", `${parked}^`]) !== bOwnHead)
  fail("takeover", "B's branch head was not preserved in the parked snapshot");
if (git(["-C", bPrimary, "show", `${parked}:b-local-wip.txt`]) !== "B parked WIP")
  fail("takeover", "B's dirty work is not restorable from the parked ref");
pass("takeover lands on A's branch and parks B's restorable work");

git(["-C", bPrimary, "reset", "--hard"]);
git(["-C", bPrimary, "clean", "-fd"]);
git(["-C", bPrimary, "switch", "b/own"]);
await waitFor("parked work restores on branch return", 30_000, async () =>
  existsSync(join(bPrimary, "b-local-wip.txt")) ? true : null,
);
if (readFileSync(join(bPrimary, "b-local-wip.txt"), "utf8") !== "B parked WIP\n")
  fail("parked restore", "restored content mismatch");
pass("returning to B's branch restores its parked WIP");

const branchProject = await createRepo("M38 Branch Materialize", "m38-materialize");
git(["-C", branchProject.work, "switch", "-c", "feature/materialize"]);
writeFileSync(join(branchProject.work, "branch.txt"), "branch commit\n");
git(["-C", branchProject.work, "add", "branch.txt"]);
git(["-C", branchProject.work, "commit", "-m", "branch commit"]);
writeFileSync(join(branchProject.work, "dirty.txt"), "branch WIP\n");
const branchRegistry = await findRegistry("M38 Branch Materialize");
const branchTarget = join(bRoot, "branch-materialized");
const branchMaterialize = await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: branchRegistry.workspaceProjectId, targetPath: branchTarget },
});
if (!branchMaterialize.ok) fail("branch materialize", `${branchMaterialize.status}`);
if ((await branchMaterialize.json()).materialization.status !== "completed")
  fail("branch materialize", "step machine did not complete");
await waitFor("branch materialize restore", 120_000, async () =>
  git(["-C", branchTarget, "branch", "--show-current"]) === "feature/materialize" &&
  existsSync(join(branchTarget, "dirty.txt"))
    ? true
    : null,
);
if (readFileSync(join(branchTarget, "dirty.txt"), "utf8") !== "branch WIP\n")
  fail("branch materialize", "dirty tree mismatch");
pass("materialize checks out the snapshot branch with its WIP");

console.log("\nM3.8 ACCEPTANCE: ALL CRITERIA PASS");
