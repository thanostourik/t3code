// M3.7 field repro: is the sync pill's data actually in the shell snapshot?
// Sets up the canonical two-instance state (project on A, B pairs with
// wipSync on), waits for a WIP pass, then dumps what the UI would see:
// /api/orchestration/shell projects[].workspaceProjectId + roamingWipStatus.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
const A = { url: "http://127.0.0.1:14801", base: join(HARNESS_DIR, "instance-a/basedir") };
const B = { url: "http://127.0.0.1:14802", base: join(HARNESS_DIR, "instance-b/basedir") };
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "repro",
  GIT_AUTHOR_EMAIL: "repro@test",
  GIT_COMMITTER_NAME: "repro",
  GIT_COMMITTER_EMAIL: "repro@test",
};
const git = (args) => execFileSync("git", args, { env: gitEnv, encoding: "utf8" });

// 1. project on A with an origin + dirty file (the desktop shape)
const pDir = join(HARNESS_DIR, "pill-p1");
const pOrigin = join(HARNESS_DIR, "pill-p1-origin.git");
rmSync(pDir, { recursive: true, force: true });
rmSync(pOrigin, { recursive: true, force: true });
git(["init", "--bare", "-b", "main", pOrigin]);
git(["init", "-b", "main", pDir]);
writeFileSync(join(pDir, "README.md"), "pill repro\n");
git(["-C", pDir, "add", "."]);
git(["-C", pDir, "commit", "-m", "init"]);
git(["-C", pDir, "remote", "add", "origin", pOrigin]);
git(["-C", pDir, "push", "origin", "main"]);
// CLEAN checkout on purpose (2026-07-09 field bug): the pill must appear
// even when no capture ever runs — a dirty file here would mask a
// never-published baseline status like it did on the first repro.

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);

const created = await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `pill-${randomUUID()}`,
    title: "Pill Repro",
    workspaceRoot: pDir,
    createdAt: new Date().toISOString(),
  },
});
if (!created.ok) throw new Error(`project.create ${created.status} ${await created.text()}`);

// 2. pair: B initiates against A (the laptop shape), wipSync on
const codeResponse = await api(A.url, "/api/auth/pairing-token", {
  method: "POST",
  token: adminA,
  body: { label: "Laptop", scopes: ADMIN_SCOPES },
});
const pair = await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: (await codeResponse.json()).credential,
    syncOptions: { secretsSync: true, wipSync: true },
  },
});
if (!pair.ok) throw new Error(`pair ${pair.status} ${await pair.text()}`);
console.log("paired:", JSON.stringify((await pair.json()).peer ?? null) !== "null");

// 3. give the reactors time for a WIP pass on A, then dump what the UI sees
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const shell = await (await api(A.url, "/api/orchestration/shell", { token: adminA })).json();
  const projects = (shell.projects ?? []).map((p) => ({
    title: p.title,
    workspaceProjectId: p.workspaceProjectId ?? null,
  }));
  const wip = shell.roamingWipStatus ?? [];
  console.log(
    `t+${(i + 1) * 5}s A: projects=${JSON.stringify(projects)} roamingWipStatus=${JSON.stringify(wip)}`,
  );
  if (wip.length > 0) break;
}
console.log("adminA token for browser login:", adminA);
