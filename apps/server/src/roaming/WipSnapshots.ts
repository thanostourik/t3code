/**
 * WIP snapshot git helpers - capture a project's dirty working tree
 * (staged, unstaged, untracked) as a commit on a hidden ref, without ever
 * touching the real index or worktree.
 *
 * The temp-index recipe is the checkpoint engine's
 * (GitVcsDriver.captureCheckpoint), reimplemented here for three WIP-specific
 * needs: the commit carries `parent = HEAD` (thin bundles exclude by commit
 * ancestry, and divergence needs a common ancestor), the caller learns the
 * `{ commitOid, treeOid }` it needs for no-op detection, and vault-targeted
 * paths are subtracted before `write-tree` (vault content is peer-to-peer
 * only; it must never ride a ref to the origin host).
 */
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId, WorkspaceProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

export const WIP_HISTORY_SLOTS = 20;

const REF_SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class WipRefIdError extends Schema.TaggedErrorClass<WipRefIdError>()("WipRefIdError", {
  id: Schema.String,
}) {}

const refSafe = (id: string): Effect.Effect<string, WipRefIdError> =>
  Effect.suspend(() =>
    REF_SAFE_ID.test(id) ? Effect.succeed(id) : Effect.fail(new WipRefIdError({ id })),
  );

export const wipRefName = (workspaceProjectId: WorkspaceProjectId, environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    yield* refSafe(workspaceProjectId);
    yield* refSafe(environmentId);
    return `refs/t3/wip/${workspaceProjectId}/${environmentId}`;
  });

export const wipPushedMarkerRefName = (
  workspaceProjectId: WorkspaceProjectId,
  environmentId: EnvironmentId,
) =>
  Effect.map(wipRefName(workspaceProjectId, environmentId), (ref) =>
    ref.replace("refs/t3/wip/", "refs/t3/wip-pushed/"),
  );

export const wipHistoryRefPrefix = (
  workspaceProjectId: WorkspaceProjectId,
  environmentId: EnvironmentId,
) =>
  Effect.map(wipRefName(workspaceProjectId, environmentId), (ref) =>
    ref.replace("refs/t3/wip/", "refs/t3/wip-history/"),
  );

/** The WIP namespace for a whole project, for fetch refspecs. */
export const wipRefGlob = (workspaceProjectId: WorkspaceProjectId) =>
  refSafe(workspaceProjectId).pipe(Effect.map((id) => `refs/t3/wip/${id}/*`));

const COMMIT_ENV_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

/** `null` when the ref does not resolve (missing ref, not a repo, ...). */
export const resolveOid = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshots.resolveOid",
      cwd,
      args: ["rev-parse", "-q", "--verify", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const oid = result.stdout.trim();
    return oid.length > 0 ? oid : null;
  });

export interface CaptureWipInput {
  readonly cwd: string;
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly environmentId: EnvironmentId;
  /** Repo-relative paths subtracted from the snapshot (the vault set). */
  readonly vaultExcludePaths: ReadonlyArray<string>;
  /** Skip commit + ref moves when the written tree equals this tree. */
  readonly skipIfTreeOid?: string | null;
}

export interface CaptureWipResult {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly refName: string;
}

/**
 * Rolling local retention: WIP commits are only ever referenced by a single
 * moving ref, so without these slots an overwritten snapshot would be
 * unreachable the moment the next one lands. Twenty slots per (project,
 * machine), oldest overwritten first.
 */
const writeHistorySlot = (cwd: string, historyPrefix: string, commitOid: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const listing = yield* git.execute({
      operation: "WipSnapshots.listHistory",
      cwd,
      args: ["for-each-ref", "--format=%(refname) %(committerdate:unix)", `${historyPrefix}/`],
      allowNonZeroExit: true,
    });
    const used = new Map<number, number>();
    if (listing.exitCode === 0) {
      for (const line of listing.stdout.split("\n")) {
        const [refname, unix] = line.trim().split(" ");
        if (refname === undefined || unix === undefined) {
          continue;
        }
        const slot = Number(refname.slice(historyPrefix.length + 1));
        if (Number.isInteger(slot)) {
          used.set(slot, Number(unix));
        }
      }
    }
    let target = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < WIP_HISTORY_SLOTS; slot += 1) {
      const stamp = used.get(slot);
      if (stamp === undefined) {
        target = slot;
        break;
      }
      if (stamp < oldest) {
        oldest = stamp;
        target = slot;
      }
    }
    yield* git.execute({
      operation: "WipSnapshots.writeHistorySlot",
      cwd,
      args: ["update-ref", `${historyPrefix}/${target}`, commitOid],
    });
  });

export const captureWipSnapshot = Effect.fn("WipSnapshots.captureWipSnapshot")(function* (
  input: CaptureWipInput,
) {
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const refName = yield* wipRefName(input.workspaceProjectId, input.environmentId);
  const historyPrefix = yield* wipHistoryRefPrefix(input.workspaceProjectId, input.environmentId);

  const commonDirResult = yield* git.execute({
    operation: "WipSnapshots.resolveGitCommonDir",
    cwd: input.cwd,
    args: ["rev-parse", "--git-common-dir"],
  });
  const rawCommonDir = commonDirResult.stdout.trim();
  const gitCommonDir = pathService.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : pathService.resolve(input.cwd, rawCommonDir);
  const tempIndexPath = pathService.join(gitCommonDir, `t3-wip-index-${NodeCrypto.randomUUID()}`);
  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndexPath,
    ...COMMIT_ENV_IDENTITY,
  };

  const cleanupTempIndex = fs.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);

  return yield* Effect.gen(function* () {
    const headOid = yield* resolveOid(input.cwd, "HEAD");
    if (headOid !== null) {
      yield* git.execute({
        operation: "WipSnapshots.readTree",
        cwd: input.cwd,
        args: ["read-tree", "HEAD"],
        env: commitEnv,
      });
    }
    yield* git.execute({
      operation: "WipSnapshots.addAll",
      cwd: input.cwd,
      args: ["add", "-A", "--", "."],
      env: commitEnv,
    });

    // Subtract the vault set. Only ever untracked paths (the callers filter
    // tracked ones out): removing a HEAD-tracked path from the snapshot tree
    // would make restore on the peer DELETE that file.
    for (let offset = 0; offset < input.vaultExcludePaths.length; offset += 100) {
      const chunk = input.vaultExcludePaths.slice(offset, offset + 100);
      yield* git.execute({
        operation: "WipSnapshots.excludeVaultPaths",
        cwd: input.cwd,
        args: ["update-index", "--force-remove", "--", ...chunk],
        env: commitEnv,
        allowNonZeroExit: true,
      });
    }

    const writeTreeResult = yield* git.execute({
      operation: "WipSnapshots.writeTree",
      cwd: input.cwd,
      args: ["write-tree"],
      env: commitEnv,
    });
    const treeOid = writeTreeResult.stdout.trim();
    if (input.skipIfTreeOid != null && treeOid === input.skipIfTreeOid) {
      return null;
    }

    const commitTreeResult = yield* git.execute({
      operation: "WipSnapshots.commitTree",
      cwd: input.cwd,
      args: [
        "commit-tree",
        treeOid,
        ...(headOid !== null ? ["-p", headOid] : []),
        "-m",
        "t3 wip snapshot",
      ],
      env: commitEnv,
    });
    const commitOid = commitTreeResult.stdout.trim();

    yield* git.execute({
      operation: "WipSnapshots.updateWipRef",
      cwd: input.cwd,
      args: ["update-ref", refName, commitOid],
    });
    yield* writeHistorySlot(input.cwd, historyPrefix, commitOid);

    return { commitOid, treeOid, refName } satisfies CaptureWipResult;
  }).pipe(Effect.ensuring(cleanupTempIndex));
});
