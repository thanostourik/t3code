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
export const WIP_BRANCH_DETACHED = "T3:detached";
export const WIP_BRANCH_UNBORN = "T3:unborn";

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

/**
 * Local-only marker: the snapshot auto-apply last fast-forwarded this
 * checkout to. A worktree that still matches this tree has no local edits
 * of its own, so a newer peer snapshot may apply without ever risking a
 * silent merge.
 */
export const wipAppliedMarkerRefName = (workspaceProjectId: WorkspaceProjectId) =>
  refSafe(workspaceProjectId).pipe(Effect.map((id) => `refs/t3/wip-applied/${id}`));

export const wipParkedRefName = (
  workspaceProjectId: WorkspaceProjectId,
  branchRef: string,
): Effect.Effect<string, WipRefIdError> =>
  Effect.gen(function* () {
    yield* refSafe(workspaceProjectId);
    if (!branchRef.startsWith("refs/heads/") || branchRef.length === "refs/heads/".length) {
      return yield* new WipRefIdError({ id: branchRef });
    }
    return `refs/t3/wip-parked/${workspaceProjectId}/${branchRef.slice("refs/heads/".length)}`;
  });

export const COMMIT_ENV_IDENTITY = {
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

/** The T3-Based-On trailer of a snapshot commit, or null. */
export const readBasedOn = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshots.readBasedOn",
      cwd,
      args: ["show", "-s", "--format=%(trailers:key=T3-Based-On,valueonly)", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const value = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  });

/** Peer snapshot recorded by a synthetic conflict marker, or null. */
export const readConflictPeer = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshots.readConflictPeer",
      cwd,
      args: ["show", "-s", "--format=%(trailers:key=T3-Peer-Snapshot,valueonly)", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  });

/** Peer snapshot acknowledged by a captured conflict resolution, or null. */
export const readBasedOnPeer = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshots.readBasedOnPeer",
      cwd,
      args: ["show", "-s", "--format=%(trailers:key=T3-Based-On-Peer,valueonly)", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  });

export interface CaptureWipInput {
  readonly cwd: string;
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly environmentId: EnvironmentId;
  /** Repo-relative paths subtracted from the snapshot (the vault set). */
  readonly vaultExcludePaths: ReadonlyArray<string>;
  /** Skip commit + ref moves when the full working-state identity matches. */
  readonly skipIfSnapshots?: ReadonlyArray<WipSnapshotIdentity>;
}

export interface WipSnapshotIdentity {
  readonly branchRef: string;
  readonly headOid: string;
  readonly treeOid: string;
}

export interface CaptureWipResult extends WipSnapshotIdentity {
  readonly commitOid: string;
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

/**
 * The worktree's tree OID in WIP-normalized space (vault set subtracted),
 * computed on a throwaway temp index — no refs move, nothing is committed.
 * This is the value every WIP comparison (no-op detection, auto-apply
 * safety) is defined over.
 */
export const writeWorktreeTree = Effect.fn("WipSnapshots.writeWorktreeTree")(function* (input: {
  readonly cwd: string;
  readonly vaultExcludePaths: ReadonlyArray<string>;
}) {
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;

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
    const symbolicHead = yield* git.execute({
      operation: "WipSnapshots.symbolicHead",
      cwd: input.cwd,
      args: ["symbolic-ref", "-q", "HEAD"],
      allowNonZeroExit: true,
    });
    const branchRef =
      headOid === null
        ? WIP_BRANCH_UNBORN
        : symbolicHead.exitCode === 0
          ? symbolicHead.stdout.trim()
          : WIP_BRANCH_DETACHED;
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
    return { treeOid: writeTreeResult.stdout.trim(), headOid: headOid ?? "", branchRef };
  }).pipe(Effect.ensuring(cleanupTempIndex));
});

export const captureWipSnapshot = Effect.fn("WipSnapshots.captureWipSnapshot")(function* (
  input: CaptureWipInput,
) {
  const git = yield* GitVcsDriver;
  const refName = yield* wipRefName(input.workspaceProjectId, input.environmentId);
  const historyPrefix = yield* wipHistoryRefPrefix(input.workspaceProjectId, input.environmentId);
  const appliedMarker = yield* wipAppliedMarkerRefName(input.workspaceProjectId);

  const { treeOid, headOid, branchRef } = yield* writeWorktreeTree({
    cwd: input.cwd,
    vaultExcludePaths: input.vaultExcludePaths,
  });
  if (
    input.skipIfSnapshots?.some(
      (snapshot) =>
        snapshot.treeOid === treeOid &&
        snapshot.headOid === headOid &&
        snapshot.branchRef === branchRef,
    )
  ) {
    return null;
  }

  // Provenance for the peer's fast-forward check (M3.6): this machine's
  // edits started from the snapshot it last auto-applied. A peer whose
  // worktree still IS that snapshot can apply this one safely.
  const basedOn = yield* resolveOid(input.cwd, appliedMarker);
  const basedOnPeer = basedOn === null ? null : yield* readConflictPeer(input.cwd, basedOn);
  const trailers = [
    ...(basedOn !== null ? [`T3-Based-On: ${basedOn}`] : []),
    ...(basedOnPeer !== null ? [`T3-Based-On-Peer: ${basedOnPeer}`] : []),
  ];

  const commitTreeResult = yield* git.execute({
    operation: "WipSnapshots.commitTree",
    cwd: input.cwd,
    args: [
      "commit-tree",
      treeOid,
      ...(headOid.length > 0 ? ["-p", headOid] : []),
      "-m",
      "t3 wip snapshot",
      ...(trailers.length > 0 ? ["-m", trailers.join("\n")] : []),
    ],
    env: { ...process.env, ...COMMIT_ENV_IDENTITY },
  });
  const commitOid = commitTreeResult.stdout.trim();

  yield* git.execute({
    operation: "WipSnapshots.updateWipRef",
    cwd: input.cwd,
    args: ["update-ref", refName, commitOid],
  });
  yield* writeHistorySlot(input.cwd, historyPrefix, commitOid);

  return { commitOid, treeOid, refName, branchRef, headOid } satisfies CaptureWipResult;
});
