// Shared plumbing for the roaming acceptance scripts (O6): the two-instance
// harness layout, api/cli/git helpers, pairing/login token issuance, and
// pass/fail reporting. Semantics of each acceptance script stay in the
// script; this file owns only the recipes that used to be copy-pasted ten
// times (and the login/pairing gotchas that were re-learned per milestone —
// see the M4 history in .plans/21-roaming-workspace.md).
//
// D3 note: roaming has no stored settings flag — the master gate derives
// from peer records in state.sqlite, so freshness/on-ness checks read the
// peers table (`hasRoamingPeers`).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const HARNESS_DIR = process.env.T3_ROAMING_HARNESS_DIR ?? "/tmp/t3-roaming-harness";
export const REPO_ROOT = new URL("../..", import.meta.url).pathname;

export const A = {
  name: "instance-a",
  url: "http://127.0.0.1:14801",
  base: join(HARNESS_DIR, "instance-a/basedir"),
  log: join(HARNESS_DIR, "instance-a/server.log"),
};
export const B = {
  name: "instance-b",
  url: "http://127.0.0.1:14802",
  base: join(HARNESS_DIR, "instance-b/basedir"),
  log: join(HARNESS_DIR, "instance-b/server.log"),
};

export const fail = (step, detail) => {
  console.error(`FAIL at ${step}: ${detail}`);
  process.exit(1);
};
export const pass = (step) => console.log(`PASS ${step}`);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the server CLI against a base dir (trimmed stdout). */
export const cli = (args) =>
  execFileSync("node", [join(REPO_ROOT, "apps/server/src/bin.ts"), ...args], {
    encoding: "utf8",
  }).trim();

/** Admin bearer for an instance — the one login recipe every script needs. */
export const adminToken = (inst) =>
  cli(["auth", "session", "issue", "--base-dir", inst.base, "--token-only"]);

/** A deterministic git identity env for repo fixtures. */
export const makeGitEnv = (name) => ({
  ...process.env,
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: `${name}@test`,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: `${name}@test`,
});

/** git with the fixture identity; RAW stdout (exact-content assertions rely on trailing newlines). */
export const makeGit = (name) => (args) =>
  execFileSync("git", args, { env: makeGitEnv(name), encoding: "utf8" });

/** git with the fixture identity; trimmed stdout (the m38/m4 house style). */
export const makeGitTrimmed = (name) => (args) =>
  execFileSync("git", args, { env: makeGitEnv(name), encoding: "utf8" }).trim();

export const harness = (cmd) =>
  execFileSync(join(REPO_ROOT, "scripts/roaming/harness.sh"), [cmd], { encoding: "utf8" });

export const api = async (base, path, { method = "GET", token, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

export const waitFor = async (step, timeoutMs, probe, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  fail(step, `condition not met within ${timeoutMs / 1000}s`);
};

export const readSettings = (inst) => {
  const path = join(inst.base, "userdata", "settings.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
};

/** The derived master gate's observable: at least one peer record (D3). */
export const hasRoamingPeers = (base) => {
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

/** Both instances answering and roaming-fresh — the shared preflight. */
export const preflightFresh = async (instances = [A, B]) => {
  for (const inst of instances) {
    const up = await api(inst.url, "/.well-known/t3/environment").then(
      (r) => r.ok,
      () => false,
    );
    if (!up) fail("preflight", `${inst.name} is not running — start the harness first`);
    if (hasRoamingPeers(inst.base))
      fail("preflight", `${inst.name} already has roaming peers — restart the harness fresh`);
  }
};
