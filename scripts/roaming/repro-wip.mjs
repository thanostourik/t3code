// Repro of the 2026-07-07 field report: after BOTH machines materialize,
// (a) a .t3sync file created on A must reach B, (b) a plain new file on A
// must reach B, (c) a file created on B must reach A. All ride the WIP
// working-tree channel (distinct from the vault channel that carries .idea).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
const A = { url: "http://127.0.0.1:14801", base: join(HARNESS_DIR, "instance-a/basedir") };
const B = { url: "http://127.0.0.1:14802", base: join(HARNESS_DIR, "instance-b/basedir") };
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ADMIN = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
];

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args) =>
  execFileSync("node", [join(REPO_ROOT, "apps/server/src/bin.ts"), ...args], {
    encoding: "utf8",
  }).trim();
const api = (base, path, { method = "GET", token, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "r",
  GIT_AUTHOR_EMAIL: "r@t",
  GIT_COMMITTER_NAME: "r",
  GIT_COMMITTER_EMAIL: "r@t",
};
const git = (a) => execFileSync("git", a, { env: gitEnv, encoding: "utf8" });
const waitFile = async (label, path, want, ms = 180_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path) && (want === undefined || readFileSync(path, "utf8") === want)) {
      log(`OK   ${label} (${Math.round((ms - (end - Date.now())) / 1000)}s)`);
      return true;
    }
    await sleep(2000);
  }
  log(`MISS ${label} — never appeared in ${ms / 1000}s`);
  return false;
};

const p1 = join(HARNESS_DIR, "repro-p1");
const origin = join(HARNESS_DIR, "repro-p1-origin.git");
const matRoot = join(HARNESS_DIR, "repro-b-ws");
for (const d of [p1, origin, matRoot]) rmSync(d, { recursive: true, force: true });
mkdirSync(matRoot, { recursive: true });
git(["init", "--bare", "-b", "main", origin]);
git(["init", "-b", "main", p1]);
writeFileSync(join(p1, "README.md"), "base\n");
writeFileSync(join(p1, ".gitignore"), ".env\n.idea/\n");
git(["-C", p1, "add", "."]);
git(["-C", p1, "commit", "-m", "init"]);
git(["-C", p1, "remote", "add", "origin", origin]);
git(["-C", p1, "push", "origin", "main"]);
writeFileSync(join(p1, ".env"), "SECRET=1\n");

const adminA = cli(["auth", "session", "issue", "--base-dir", A.base, "--token-only"]);
const adminB = cli(["auth", "session", "issue", "--base-dir", B.base, "--token-only"]);
await api(A.url, "/api/orchestration/dispatch", {
  method: "POST",
  token: adminA,
  body: {
    type: "project.create",
    commandId: randomUUID(),
    projectId: `r-${randomUUID()}`,
    title: "Repro",
    workspaceRoot: p1,
    createdAt: new Date().toISOString(),
  },
});
const code = (
  await (
    await api(A.url, "/api/auth/pairing-token", {
      method: "POST",
      token: adminA,
      body: { label: "M", scopes: ADMIN },
    })
  ).json()
).credential;
await api(B.url, "/api/roaming/peers", {
  method: "POST",
  token: adminB,
  body: {
    baseUrls: [A.url],
    pairingCredential: code,
    syncOptions: { secretsSync: true, wipSync: true },
  },
});
log("paired");

// B materializes.
const probe = (
  await (
    await api(B.url, "/api/roaming/machine-credential", {
      method: "POST",
      token: adminB,
      body: { environmentId: "probe", baseUrls: [] },
    })
  ).json()
).token;
let wpid = null;
for (let i = 0; i < 60 && !wpid; i++) {
  const man = await (
    await api(B.url, "/api/roaming/mirror/manifest", {
      method: "POST",
      token: probe,
      body: { environmentId: "probe", manifest: [] },
    })
  ).json();
  for (const e of (man.manifest ?? []).filter((x) => x.kind === "registry")) {
    const blob = (
      await (
        await api(B.url, "/api/roaming/mirror/fetch", {
          method: "POST",
          token: probe,
          body: { refs: [{ kind: "registry", key: e.key }] },
        })
      ).json()
    ).blobs[0];
    if (blob && JSON.parse(blob.payload).title === "Repro")
      wpid = JSON.parse(blob.payload).workspaceProjectId;
  }
  if (!wpid) await sleep(2000);
}
const bTarget = join(matRoot, "p1");
await api(B.url, "/api/roaming/materialize", {
  method: "POST",
  token: adminB,
  body: { workspaceProjectId: wpid, targetPath: bTarget },
});
await waitFile("materialize seeded README on B", join(bTarget, "README.md"));
log("both materialized");

// (a) .t3sync file created on A
writeFileSync(join(p1, ".t3sync"), "/.idea\n");
// (b) plain new file on A
writeFileSync(join(p1, "note-a.txt"), "from A\n");
await waitFile("(a) .t3sync file A->B", join(bTarget, ".t3sync"), "/.idea\n");
await waitFile("(b) plain file A->B", join(bTarget, "note-a.txt"), "from A\n");

// (c) file created on B -> back to A
writeFileSync(join(bTarget, "note-b.txt"), "from B\n");
await waitFile("(c) plain file B->A (backflow)", join(p1, "note-b.txt"), "from B\n");

log("REPRO-DONE");
