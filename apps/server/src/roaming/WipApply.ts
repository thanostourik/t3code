// @effect-diagnostics nodeBuiltinImport:off
/**
 * The delivery half of WIP sync: classify the newest peer snapshot against
 * this checkout's git state (same context / fast-forward / different branch /
 * peer behind / diverged — see the decision table in
 * .plans/21-roaming-workspace.md), reproduce safe transitions completely
 * (parking local state first) or touch nothing, and per-file-merge the dirty
 * tree with causality-gated bases. Also owns parked-ref restoration and
 * explicit takeover (the same classifier with the guards bypassed).
 */
import { CheckpointRef, EnvironmentId, type RoamingWipPayload } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import {
  bundleShipped,
  decodeWipPayloadJson,
  isGitWorktree,
  inProgressOperationExists,
  payloadForCommit,
  primaryRemoteName,
  vaultExcludePathsFor,
  type WipTarget,
} from "./WipShared.ts";
import {
  COMMIT_ENV_IDENTITY,
  captureWipSnapshot,
  readBasedOn,
  readBasedOnPeer,
  readConflictPeer,
  resolveOid,
  wipAppliedMarkerRefName,
  wipParkedRefName,
  wipPushedMarkerRefName,
  wipRefGlob,
  wipRefName,
  writeWorktreeTree,
} from "./WipSnapshots.ts";

const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.isAncestor",
      cwd,
      args: ["merge-base", "--is-ancestor", ancestor, descendant],
      allowNonZeroExit: true,
    });
    return result.exitCode === 0;
  });

const validBranchRef = (cwd: string, branchRef: string) =>
  Effect.gen(function* () {
    if (!branchRef.startsWith("refs/heads/")) return false;
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.checkBranchRef",
      cwd,
      args: ["check-ref-format", branchRef],
      allowNonZeroExit: true,
    });
    return result.exitCode === 0;
  });

/** Git's canonical empty-tree object — the diff base when a snapshot has no parent. */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type WipApplyOutcome =
  | { readonly _tag: "skipped" }
  | { readonly _tag: "blocked"; readonly reason: string }
  | {
      readonly _tag: "applied";
      readonly fromEnvironmentId: EnvironmentId;
      readonly capturedAtIso: string;
    }
  | {
      readonly _tag: "applied-with-conflicts";
      readonly fromEnvironmentId: EnvironmentId;
      readonly capturedAtIso: string;
      readonly conflicts: ReadonlyArray<string>;
    };

export interface WipApplyOptions {
  readonly hasInFlightTurn?: boolean;
  readonly takeover?: boolean;
}

export const restoreParkedWipForTarget = Effect.fn("WipSnapshotReactor.restoreParkedWipForTarget")(
  function* (target: WipTarget) {
    const git = yield* GitVcsDriver;
    const vcs = yield* VcsDriver;
    const branch = yield* git.execute({
      operation: "WipSnapshotReactor.parkedCurrentBranch",
      cwd: target.workspaceRoot,
      args: ["symbolic-ref", "-q", "HEAD"],
      allowNonZeroExit: true,
    });
    if (branch.exitCode !== 0) return false;
    const parkedRef = yield* wipParkedRefName(target.workspaceProjectId, branch.stdout.trim());
    const parkedOid = yield* resolveOid(target.workspaceRoot, parkedRef);
    if (parkedOid === null) return false;
    const parkedParent = yield* resolveOid(target.workspaceRoot, `${parkedRef}^`);
    const headOid = yield* resolveOid(target.workspaceRoot, "HEAD");
    if (parkedParent === null || parkedParent !== headOid) return false;
    const status = yield* git.execute({
      operation: "WipSnapshotReactor.parkedStatus",
      cwd: target.workspaceRoot,
      args: ["status", "--porcelain"],
    });
    if (status.stdout.trim().length > 0) return false;
    const checkpoints = vcs.checkpoints;
    if (checkpoints === undefined) return false;
    const restored = yield* checkpoints.restoreCheckpoint({
      cwd: target.workspaceRoot,
      checkpointRef: CheckpointRef.make(parkedRef),
    });
    if (!restored) return false;
    yield* git.execute({
      operation: "WipSnapshotReactor.consumeParkedRef",
      cwd: target.workspaceRoot,
      args: ["update-ref", "-d", parkedRef, parkedOid],
    });
    return true;
  },
);

/**
 * The delivery half of WIP sync. PER-FILE merge (M3.7): apply the files a
 * peer changed relative to the shared base, but only where THIS machine has
 * not modified that same file — so a new/updated file lands even while local
 * edits exist on other files, and both machines can be worked on at once. A
 * file both sides changed is left as ours and surfaced as a conflict; the
 * peer's tree is never restored wholesale, local work is never overwritten.
 * A snapshot older than HEAD or the applied marker never applies (no stale
 * echo). Same safety contract as the vault delivery.
 */
export const runWipApplyForTarget = Effect.fn("WipSnapshotReactor.runWipApplyForTarget")(function* (
  target: WipTarget,
  // The commit WE last shipped for this project (pushed-marker), captured
  // BEFORE this pass's capture clobbers it. It records files THIS machine
  // authored and synced outward — which the applied marker never does. Used
  // as the local-change base so deleting a locally-created file is seen as
  // our deletion, not "untouched" (which re-added it — the delete flap).
  // Omitted (tests / direct callers): read the current pushed marker.
  shippedBaseOid?: string | null,
  options: WipApplyOptions = {},
) {
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const blobStore = yield* RoamingBlobStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const cwd = target.workspaceRoot;

  if (!(yield* isGitWorktree(cwd))) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  if (yield* inProgressOperationExists(cwd)) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  const glob = yield* wipRefGlob(target.workspaceProjectId);
  const ownRef = yield* wipRefName(target.workspaceProjectId, environmentId);
  const appliedMarker = yield* wipAppliedMarkerRefName(target.workspaceProjectId);

  // Freshen peer snapshots: origin refs when reachable, bundle blobs from
  // the mirror always (both non-fatal — apply works from whatever arrived).
  const remote = yield* primaryRemoteName(cwd);
  if (remote !== null) {
    const fetchStartedMs = yield* Clock.currentTimeMillis;
    yield* git.execute({
      operation: "WipSnapshotReactor.fetchPeerWipRefs",
      cwd,
      args: ["fetch", remote, `+${glob}:${glob}`],
      allowNonZeroExit: true,
    });
    const fetchDoneMs = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("roaming timing: peer-refs-fetched", {
      workspaceProjectId: target.workspaceProjectId,
      durationMs: fetchDoneMs - fetchStartedMs,
    });
  }
  const manifest = yield* blobStore.manifest().pipe(Effect.orElseSucceed(() => []));
  const payloads = new Map<string, RoamingWipPayload>();
  for (const entry of manifest) {
    if (
      entry.kind !== "wip" ||
      !entry.key.startsWith(`${target.workspaceProjectId}/`) ||
      entry.key === `${target.workspaceProjectId}/${environmentId}`
    ) {
      continue;
    }
    const blob = yield* blobStore
      .get({ kind: "wip", key: entry.key })
      .pipe(Effect.orElseSucceed(() => null));
    if (blob === null) {
      continue;
    }
    const payload = yield* decodeWipPayloadJson(blob.payload).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (payload === null) {
      continue;
    }
    payloads.set(`${payload.refName}\0${payload.commitOid}`, payload);
    // Beacons carry no pack (origin mode); the origin fetch above is the
    // transport there. Skip the import when the local ref already has this
    // exact commit.
    if (
      payload.bundleBase64.length === 0 ||
      (yield* resolveOid(cwd, payload.refName)) === payload.commitOid
    ) {
      continue;
    }
    const tempDir = yield* fs
      .makeTempDirectory({ prefix: "t3-wip-apply-" })
      .pipe(Effect.orElseSucceed(() => null));
    if (tempDir === null) {
      continue;
    }
    yield* Effect.gen(function* () {
      const bundlePath = pathService.join(tempDir, "wip.bundle");
      yield* fs.writeFile(bundlePath, Buffer.from(payload.bundleBase64, "base64"));
      let imported = yield* git.execute({
        operation: "WipSnapshotReactor.fetchPeerWipBundle",
        cwd,
        args: ["fetch", bundlePath, `+${payload.refName}:${payload.refName}`],
        allowNonZeroExit: true,
      });
      // Bundle creation omits objects advertised by the normal remote. The
      // receiver may not have fetched a newly pushed branch/merge yet, so an
      // otherwise valid bundle can report a missing prerequisite. Refresh
      // ordinary remote refs and retry once before rejecting the payload.
      if (imported.exitCode !== 0 && remote !== null) {
        yield* git.execute({
          operation: "WipSnapshotReactor.fetchBundlePrerequisites",
          cwd,
          args: ["fetch", remote],
          allowNonZeroExit: true,
        });
        imported = yield* git.execute({
          operation: "WipSnapshotReactor.retryPeerWipBundle",
          cwd,
          args: ["fetch", bundlePath, `+${payload.refName}:${payload.refName}`],
          allowNonZeroExit: true,
        });
      }
      if (imported.exitCode !== 0) {
        yield* Effect.logWarning("roaming wip: peer bundle import failed", {
          workspaceProjectId: target.workspaceProjectId,
          stderr: imported.stderr.trim().slice(0, 200),
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("roaming wip: peer bundle import failed", { cause }),
      ),
      Effect.ensuring(fs.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  }

  // Newest peer snapshot (own env excluded).
  const listing = yield* git.execute({
    operation: "WipSnapshotReactor.listPeerWipRefs",
    cwd,
    args: [
      "for-each-ref",
      "--format=%(refname) %(committerdate:unix) %(committerdate:iso-strict)",
      glob.slice(0, -1),
    ],
    allowNonZeroExit: true,
  });
  const candidates =
    listing.exitCode !== 0
      ? []
      : listing.stdout
          .split("\n")
          .map((line) => line.trim().split(" "))
          .flatMap((parts) =>
            parts.length === 3 && parts[0]!.length > 0 && parts[0] !== ownRef
              ? [
                  {
                    refName: parts[0]!,
                    unix: Number(parts[1]!),
                    iso: parts[2]!,
                  },
                ]
              : [],
          );
  if (candidates.length === 0) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  // Reinstalls and interrupted bundle imports can leave orphan refs behind.
  // Never let an unmatched stale ref outrank the current mirrored snapshot
  // and manufacture a false legacy/takeover state.
  let newest: (typeof candidates)[number] | undefined;
  let newestCommit: string | null = null;
  let payload: RoamingWipPayload | undefined;
  for (const candidate of [...candidates].sort((left, right) => right.unix - left.unix)) {
    const commit = yield* resolveOid(cwd, candidate.refName);
    const candidatePayload =
      commit === null ? undefined : payloads.get(`${candidate.refName}\0${commit}`);
    if (candidatePayload !== undefined) {
      newest = candidate;
      newestCommit = commit;
      payload = candidatePayload;
      break;
    }
  }
  if (newest === undefined || newestCommit === null || payload === undefined) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  const newestUnix = newest.unix;
  const fromEnvironmentId = EnvironmentId.make(newest.refName.split("/").pop() ?? "unknown");
  if (
    payload.schemaVersion < 2 ||
    payload.branchRef === undefined ||
    payload.headOid === undefined
  ) {
    return {
      _tag: "blocked",
      reason: "the other machine must update this project before its changes can be applied",
    } as WipApplyOutcome;
  }

  const excludePaths = yield* vaultExcludePathsFor(target);
  if (excludePaths === null) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  const localState = yield* writeWorktreeTree({
    cwd,
    vaultExcludePaths: excludePaths,
  });
  const worktreeTree = localState.treeOid;
  const headTree = yield* resolveOid(cwd, "HEAD^{tree}");
  const cleanAtHead = headTree === worktreeTree;
  const newestTree = yield* resolveOid(cwd, `${newest.refName}^{tree}`);
  const peerHeadTree = yield* resolveOid(cwd, `${payload.headOid}^{tree}`);
  const peerParent = yield* resolveOid(cwd, `${newest.refName}^`);
  const appliedCommit = yield* resolveOid(cwd, appliedMarker);
  if (
    newestCommit === null ||
    newestTree === null ||
    peerHeadTree === null ||
    newestTree !== payload.treeOid ||
    peerParent !== payload.headOid ||
    !(yield* validBranchRef(cwd, payload.branchRef)) ||
    !(yield* validBranchRef(cwd, localState.branchRef))
  ) {
    return {
      _tag: "blocked",
      reason: "the other machine's project state cannot be applied automatically",
    } as WipApplyOutcome;
  }

  const sameBranch = payload.branchRef === localState.branchRef;
  const sameHead = payload.headOid === localState.headOid;
  const shippedBase =
    shippedBaseOid !== undefined
      ? shippedBaseOid
      : yield* resolveOid(
          cwd,
          yield* wipPushedMarkerRefName(target.workspaceProjectId, environmentId),
        );
  const ownPayload = yield* bundleShipped(target.workspaceProjectId, environmentId);
  const localAppliedCommit = yield* resolveOid(cwd, appliedMarker);
  const appliedContextPayload = yield* payloadForCommit(
    target.workspaceProjectId,
    localAppliedCommit,
  );
  const localContextBaseline = ownPayload ?? appliedContextPayload;
  const localContextCaptured =
    localContextBaseline === null ||
    localContextBaseline === undefined ||
    (localContextBaseline.branchRef === localState.branchRef &&
      localContextBaseline.headOid === localState.headOid);
  const basedOn = yield* readBasedOn(cwd, newest.refName);
  const ownBasedOn =
    ownPayload === null || ownPayload === undefined
      ? null
      : yield* readBasedOn(cwd, ownPayload.commitOid);
  const recordedConflictPeer =
    appliedCommit === null ? null : yield* readConflictPeer(cwd, appliedCommit);
  let legacyRecordedConflictPeer: string | null = null;
  if (
    recordedConflictPeer === null &&
    appliedCommit !== null &&
    ownBasedOn === appliedCommit &&
    localContextCaptured
  ) {
    const marker = yield* git.execute({
      operation: "WipSnapshotReactor.readLegacyConflictMarker",
      cwd,
      args: ["show", "-s", "--format=%s%x00%ct", appliedCommit],
      allowNonZeroExit: true,
    });
    const [subject, timestamp] = marker.stdout.trim().split("\0");
    if (
      marker.exitCode === 0 &&
      subject === "t3 wip applied marker (conflicts pinned to base)" &&
      Number(timestamp) + 1 === newestUnix
    ) {
      legacyRecordedConflictPeer = newestCommit;
    }
  }
  // Once this machine has captured its kept-local result after a conflict,
  // the exact peer snapshot is resolved here. Reprocessing it on every boot
  // recreates a false Take over forever; a new peer commit still re-evaluates.
  if (
    !options.takeover &&
    ownBasedOn === appliedCommit &&
    localContextCaptured &&
    (recordedConflictPeer === newestCommit || legacyRecordedConflictPeer === newestCommit)
  ) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  if (
    shippedBase !== null &&
    basedOn === shippedBase &&
    ownPayload?.commitOid === shippedBase &&
    ownPayload.branchRef === payload.branchRef &&
    ownPayload.headOid === payload.headOid &&
    ownPayload.treeOid === payload.treeOid
  ) {
    yield* git.execute({
      operation: "WipSnapshotReactor.updateAppliedMarker",
      cwd,
      args: ["update-ref", appliedMarker, newestCommit],
    });
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  let mergeBaseOverride: string | null = null;

  if (sameBranch && sameHead && !options.takeover) {
    if (newestCommit === appliedCommit) {
      return { _tag: "skipped" } as WipApplyOutcome;
    }
    if (newestTree === worktreeTree) {
      yield* git.execute({
        operation: "WipSnapshotReactor.updateAppliedMarker",
        cwd,
        args: ["update-ref", appliedMarker, newestCommit],
      });
      return { _tag: "skipped" } as WipApplyOutcome;
    }
  } else {
    const branchName = payload.branchRef.slice("refs/heads/".length);
    // A peer can publish its pre-apply branch just after this machine ships a
    // newer branch transition. Its Based-On then names an older local
    // snapshot. Never let that delayed echo reverse the newer branch; a real
    // concurrent branch choice must be explicit through takeover.
    if (
      !options.takeover &&
      !sameBranch &&
      basedOn !== null &&
      shippedBase !== null &&
      basedOn !== shippedBase
    ) {
      // A clean snapshot is dismissible as a delayed echo ONLY when proven:
      // its position must already be contained in our history (peer HEAD is
      // an ancestor of ours). An unproven clean different-branch snapshot is
      // a real divergence — dismissing it as an echo would settle both
      // machines on "Synced" while they silently drift apart (review
      // finding 2026-07-15); block so takeover stays offered.
      return newestTree === peerHeadTree &&
        (yield* isAncestor(cwd, payload.headOid, localState.headOid))
        ? ({ _tag: "skipped" } as WipApplyOutcome)
        : ({
            _tag: "blocked",
            reason: `the other machine is on ${branchName}`,
          } as WipApplyOutcome);
    }

    const peerBehind = sameBranch && (yield* isAncestor(cwd, payload.headOid, localState.headOid));
    if (peerBehind && !options.takeover) {
      return { _tag: "skipped" } as WipApplyOutcome;
    }

    const fastForward = sameBranch && (yield* isAncestor(cwd, localState.headOid, payload.headOid));
    const markerTree = yield* resolveOid(cwd, `${appliedMarker}^{tree}`);
    // A user may deliberately clean/reset an earlier synchronized WIP tree.
    // Git-clean at HEAD is still an untouched checkout for branch movement;
    // a retained applied marker must not manufacture local edits forever.
    const untouched =
      (markerTree === worktreeTree || headTree === worktreeTree) && localContextCaptured;

    if (options.hasInFlightTurn === true) {
      return {
        _tag: "blocked",
        reason: "an agent is working in this project; try again when it finishes",
      } as WipApplyOutcome;
    }
    if (!options.takeover && !untouched) {
      return {
        _tag: "blocked",
        reason: sameBranch
          ? `the other machine moved ${branchName} forward; you have local edits`
          : `the other machine is on ${branchName}`,
      } as WipApplyOutcome;
    }
    if (!options.takeover && sameBranch && !fastForward) {
      return {
        _tag: "blocked",
        reason: `${branchName} has diverged between your machines`,
      } as WipApplyOutcome;
    }

    if (!sameBranch && !options.takeover) {
      const localBranchOid = yield* resolveOid(cwd, payload.branchRef);
      if (localBranchOid !== null && !(yield* isAncestor(cwd, localBranchOid, payload.headOid))) {
        return {
          _tag: "blocked",
          reason: `${branchName} has local commits on this machine`,
        } as WipApplyOutcome;
      }
    }

    const parked = yield* captureWipSnapshot({
      cwd,
      workspaceProjectId: target.workspaceProjectId,
      environmentId,
      vaultExcludePaths: excludePaths,
    });
    if (parked !== null) {
      yield* git.execute({
        operation: "WipSnapshotReactor.parkLocalState",
        cwd,
        args: [
          "update-ref",
          yield* wipParkedRefName(target.workspaceProjectId, localState.branchRef),
          parked.commitOid,
        ],
      });
    }

    if (sameBranch) {
      if (fastForward && !options.takeover) {
        yield* git.execute({
          operation: "WipSnapshotReactor.fastForward",
          cwd,
          // The untouched-tree guard above proves the checkout still equals
          // the last applied snapshot. Reproduce the peer's committed state
          // first; the per-file pass below then reapplies its WIP tree on top.
          // This handles both newly committed files and files that already
          // arrived as untracked WIP before becoming committed.
          args: ["reset", "--hard", payload.headOid],
        });
      } else {
        yield* git.execute({
          operation: "WipSnapshotReactor.takeoverReset",
          cwd,
          args: ["reset", "--hard", payload.headOid],
        });
        yield* git.execute({
          operation: "WipSnapshotReactor.takeoverClean",
          cwd,
          args: ["clean", "-fd"],
        });
      }
    } else {
      yield* git.execute({
        operation: "WipSnapshotReactor.switchBranch",
        cwd,
        args: ["switch", "-C", branchName, payload.headOid],
      });
      if (options.takeover) {
        yield* git.execute({
          operation: "WipSnapshotReactor.takeoverClean",
          cwd,
          args: ["clean", "-fd"],
        });
      }
    }
    mergeBaseOverride = payload.headOid;
  }

  // PER-FILE MERGE (M3.7 — replaces the whole-tree restore that blocked on
  // ANY local edit, so nothing ever crossed when both machines were being
  // worked on). Apply exactly the files the peer changed relative to its
  // own HEAD (= the shared base while neither side has committed), and only
  // where THIS machine has not modified that same file. A new/updated file
  // lands even while local edits exist on OTHER files; a file both sides
  // changed is left as ours and surfaced as a conflict. Same safety
  // contract as the vault delivery that already works both ways.
  // A Git-clean checkout has authoritatively discarded any older WIP recorded
  // by the applied marker. Using that stale marker as the per-file base makes
  // a newly re-created same-name file look like a conflict, then turns the
  // clean checkout's absence into a destructive deletion on the author.
  // Rebase clean state to HEAD; only dirty checkouts need the applied marker
  // to distinguish local edits from the last synced version.
  const base =
    mergeBaseOverride ??
    (cleanAtHead ? yield* resolveOid(cwd, "HEAD") : null) ??
    localAppliedCommit ??
    (yield* resolveOid(cwd, "HEAD")) ??
    EMPTY_TREE_OID;
  // Our last-shipped snapshot: knows about files we authored (the applied
  // marker doesn't). Passed in from the reactor as the PRE-capture value;
  // direct callers get the current pushed marker.
  const diff = yield* git.execute({
    operation: "WipSnapshotReactor.peerDiff",
    cwd,
    args: ["diff", "--name-status", "-z", "--no-renames", base, newest.refName],
    allowNonZeroExit: true,
  });
  if (diff.exitCode !== 0) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  const fields = diff.stdout.split("\0").filter((f) => f.length > 0);
  const changes: Array<{ readonly status: string; readonly path: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changes.push({ status: fields[i]![0]!, path: fields[i + 1]! });
  }

  // Paths we SHIPPED that the peer's snapshot no longer carries are invisible
  // to the base diff whenever the applied marker never recorded them (the
  // author's own echoes are tree-equal and skipped, so its marker can lag).
  // Union in the peer-deletions visible only against our shipped snapshot;
  // each is gated below on the peer PROVABLY having seen the file — its
  // snapshot's T3-Based-On state must contain it — so an out-of-order
  // snapshot that merely predates the file can never become a destructive
  // delete (the 92b641b4 flap).
  const shippedOnlyDeletes = new Set<string>();
  if (shippedBase !== null && shippedBase !== base) {
    const basePaths = new Set(changes.map((change) => change.path));
    const shippedDiff = yield* git.execute({
      operation: "WipSnapshotReactor.shippedDiff",
      cwd,
      args: ["diff", "--name-status", "-z", "--no-renames", shippedBase, newest.refName],
      allowNonZeroExit: true,
    });
    if (shippedDiff.exitCode === 0) {
      const shippedFields = shippedDiff.stdout.split("\0").filter((f) => f.length > 0);
      for (let i = 0; i + 1 < shippedFields.length; i += 2) {
        const path = shippedFields[i + 1]!;
        if (shippedFields[i]![0] === "D" && !basePaths.has(path)) {
          changes.push({ status: "D", path });
          shippedOnlyDeletes.add(path);
        }
      }
    }
  }
  const basedOnPeer = yield* readBasedOnPeer(cwd, newest.refName);
  // The peer snapshot provably descends from our last shipment: its Based-On
  // (or the transported conflict proof) names that exact commit. Only then is
  // our shipped snapshot common history usable as a per-file merge base.
  const peerSawOurShipment =
    shippedBase !== null && (basedOn === shippedBase || basedOnPeer === shippedBase);

  const hashWorking = (relativePath: string) =>
    git
      .execute({
        operation: "WipSnapshotReactor.hashWorking",
        cwd,
        args: ["hash-object", "--", relativePath],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() || null : null)),
        Effect.orElseSucceed(() => null),
      );

  // hash-object returns null for an ABSENT path but ALSO for a directory (or a
  // path blocked by a file at a leading component). So a null ourOid does not
  // prove the path is free — a `git restore` onto it would silently clobber
  // that local structure (e.g. peer adds file `foo`, we have an untracked dir
  // `foo/` of unsaved work). Before creating a path we believe is absent,
  // confirm nothing local occupies it or any parent component.
  const collidesOnDisk = (relativePath: string) =>
    Effect.gen(function* () {
      const parts = relativePath.split("/");
      let prefix = cwd;
      for (let i = 0; i < parts.length; i++) {
        prefix = pathService.join(prefix, parts[i]!);
        const info = yield* fs.stat(prefix).pipe(Effect.orElseSucceed(() => null));
        if (info === null) return false; // nothing here (or below) — safe to create
        if (i === parts.length - 1) return true; // target path already occupied
        if (info.type !== "Directory") return true; // a file blocks our path
      }
      return false;
    });

  const applied: string[] = [];
  const conflicts: string[] = [];
  // For the pinned applied marker: which tree holds each conflicted path's
  // base version (null = the base never had it, drop it from the marker so
  // the path stays diffable and the conflict re-surfaces next pass).
  const conflictPins: Array<{ readonly path: string; readonly sourceTree: string | null }> = [];
  const holdConflict = (relativePath: string, sourceTree: string | null) => {
    conflicts.push(relativePath);
    conflictPins.push({ path: relativePath, sourceTree });
  };
  for (const change of changes) {
    const relativePath = change.path;
    // git diff paths are repo-relative and slash-normalized; reject anything
    // that could escape the worktree before it reaches the filesystem.
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.split("/").includes("..")
    ) {
      continue;
    }
    const absolutePath = pathService.join(cwd, relativePath);
    // A deletion visible only against our shipped snapshot counts ONLY when
    // the peer's snapshot provably descends from a state that had the file;
    // otherwise the peer simply hasn't seen it yet and absence means nothing.
    if (shippedOnlyDeletes.has(relativePath)) {
      const seenState = basedOnPeer === shippedBase ? shippedBase : basedOn;
      const seenByPeer =
        seenState === null ? null : yield* resolveOid(cwd, `${seenState}:${relativePath}`);
      if (seenByPeer === null) {
        continue;
      }
    }
    const peerOid = yield* resolveOid(cwd, `${newest.refName}:${relativePath}`); // null = deleted by peer
    const markerBaseOid = yield* resolveOid(cwd, `${base}:${relativePath}`);
    const shippedPathOid =
      shippedBase === null ? null : yield* resolveOid(cwd, `${shippedBase}:${relativePath}`);
    const ourOid = yield* hashWorking(relativePath); // null = absent locally
    // Last-synced version: the selected merge base's copy. Dirty checkouts
    // additionally fall back to what we last shipped — but ONLY when that
    // shipment is provably common history: the path is absent locally (a
    // local deletion of a file we authored must not read as untouched
    // absence), the peer's deletion of it carried Based-On proof, or the
    // peer snapshot descends from our shipment (its edit is a reply, not a
    // concurrent write). An unproven concurrent snapshot must NOT use our
    // own shipment as base: our unacknowledged edit would compare equal to
    // it, read "untouched", and the peer's bytes would silently overwrite
    // local work (accept-m35 no-clobber regression, 2026-07-15).
    const shippedBaseUsable =
      ourOid === null || peerSawOurShipment || shippedOnlyDeletes.has(relativePath);
    const baseOid = markerBaseOid ?? (cleanAtHead || !shippedBaseUsable ? null : shippedPathOid);
    const baseSourceTree = baseOid === null ? null : markerBaseOid !== null ? base : shippedBase;

    if (ourOid === peerOid) {
      continue; // already at the peer's state (same content, or deleted on both)
    }
    // A clean checkout can mean an intentional deletion of a file we authored.
    // Preserve it while the peer merely echoes the exact shipped bytes. If the
    // peer has DIFFERENT bytes at the same path, it recreated the filename from
    // clean state; apply that new file instead of manufacturing a conflict.
    if (
      cleanAtHead &&
      markerBaseOid === null &&
      ourOid === null &&
      shippedPathOid !== null &&
      peerOid === shippedPathOid
    ) {
      continue;
    }
    const localUntouched = ourOid === baseOid; // both null (absent both) counts as untouched
    if (!localUntouched) {
      // WE changed this file since the last sync (edited or deleted it). If the
      // peer still holds exactly the synced version (peerOid === baseOid) they
      // did NOT touch it — our change wins silently and our next capture
      // propagates it (this is a clean local delete, not a conflict). Only a
      // genuine both-sides change is surfaced as a conflict.
      if (peerOid !== baseOid) {
        holdConflict(relativePath, baseSourceTree);
      }
      continue;
    }

    if (peerOid === null) {
      // Peer deleted a file we hadn't touched: remove it locally.
      yield* fs.remove(absolutePath, { force: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("roaming wip: could not remove peer-deleted file", {
            path: relativePath,
            cause,
          }),
        ),
      );
      applied.push(relativePath);
      continue;
    }
    if (ourOid === null && (yield* collidesOnDisk(relativePath))) {
      holdConflict(relativePath, baseSourceTree); // local dir/file sits on this path — keep ours
      continue;
    }
    // Write the peer's version (any tracked/untracked path; preserves mode)
    // straight from the snapshot tree — no index or clean side effects.
    const wrote = yield* git
      .execute({
        operation: "WipSnapshotReactor.restorePath",
        cwd,
        args: ["restore", `--source=${newest.refName}`, "--worktree", "--", relativePath],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((r) => r.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );
    if (wrote) {
      applied.push(relativePath);
    } else {
      holdConflict(relativePath, baseSourceTree);
    }
  }

  if (applied.length === 0 && conflicts.length === 0) {
    if (mergeBaseOverride !== null) {
      yield* git.execute({
        operation: "WipSnapshotReactor.updateAppliedMarker",
        cwd,
        args: ["update-ref", appliedMarker, newestCommit],
      });
      return {
        _tag: "applied",
        fromEnvironmentId,
        capturedAtIso: newest.iso,
      } as WipApplyOutcome;
    }
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  // Advance the applied marker EVERY pass — cleanly to the peer snapshot, or,
  // with conflicts, to a synthetic commit of the peer tree with each conflicted
  // path pinned back to its base version. The old conflicts-only gate held the
  // whole marker back on ANY conflict, so a file applied in that same pass was
  // never recorded as synced; deleting it later read null==null "untouched"
  // and the peer's stale copy resurrected it (field bug 2026-07-10). Pinned
  // paths stay diffable so the conflict re-surfaces each pass until resolved,
  // and the commit is dated just before the peer snapshot so the staleness
  // gate keeps re-examining that snapshot while the conflict lives.
  if (newestCommit !== null && conflicts.length === 0) {
    yield* git.execute({
      operation: "WipSnapshotReactor.updateAppliedMarker",
      cwd,
      args: ["update-ref", appliedMarker, newestCommit],
    });
  } else if (newestCommit !== null) {
    yield* Effect.gen(function* () {
      const commonDirResult = yield* git.execute({
        operation: "WipSnapshotReactor.markerCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const rawCommonDir = commonDirResult.stdout.trim();
      const gitCommonDir = pathService.isAbsolute(rawCommonDir)
        ? rawCommonDir
        : pathService.resolve(cwd, rawCommonDir);
      const tempIndexPath = pathService.join(
        gitCommonDir,
        `t3-wip-marker-index-${NodeCrypto.randomUUID()}`,
      );
      const markerEnv = { ...process.env, GIT_INDEX_FILE: tempIndexPath, ...COMMIT_ENV_IDENTITY };
      yield* Effect.gen(function* () {
        yield* git.execute({
          operation: "WipSnapshotReactor.markerReadTree",
          cwd,
          args: ["read-tree", newestCommit],
          env: markerEnv,
        });
        for (const pin of conflictPins) {
          // Pin to the base entry when one exists; otherwise (or when the base
          // entry cannot be read) drop the path so it keeps diffing against
          // future snapshots and the conflict is re-detected, never absorbed.
          const entry =
            pin.sourceTree === null
              ? null
              : yield* git
                  .execute({
                    operation: "WipSnapshotReactor.markerBaseEntry",
                    cwd,
                    args: ["ls-tree", "-r", pin.sourceTree, "--", pin.path],
                    env: markerEnv,
                    allowNonZeroExit: true,
                  })
                  .pipe(
                    Effect.map((result) =>
                      result.exitCode === 0
                        ? (result.stdout.match(/^(\d{6}) blob ([0-9a-f]+)\t/) ?? null)
                        : null,
                    ),
                    Effect.orElseSucceed(() => null),
                  );
          if (entry === null) {
            yield* git.execute({
              operation: "WipSnapshotReactor.markerDropPath",
              cwd,
              args: ["update-index", "--force-remove", "--", pin.path],
              env: markerEnv,
              allowNonZeroExit: true,
            });
            continue;
          }
          yield* git.execute({
            operation: "WipSnapshotReactor.markerPinPath",
            cwd,
            args: ["update-index", "--add", "--cacheinfo", `${entry[1]},${entry[2]},${pin.path}`],
            env: markerEnv,
          });
        }
        const treeResult = yield* git.execute({
          operation: "WipSnapshotReactor.markerWriteTree",
          cwd,
          args: ["write-tree"],
          env: markerEnv,
        });
        const commitResult = yield* git.execute({
          operation: "WipSnapshotReactor.markerCommitTree",
          cwd,
          args: [
            "commit-tree",
            treeResult.stdout.trim(),
            "-m",
            "t3 wip applied marker (conflicts pinned to base)",
            "-m",
            `T3-Peer-Snapshot: ${newestCommit}`,
          ],
          env: {
            ...markerEnv,
            GIT_AUTHOR_DATE: `${newestUnix - 1} +0000`,
            GIT_COMMITTER_DATE: `${newestUnix - 1} +0000`,
          },
        });
        yield* git.execute({
          operation: "WipSnapshotReactor.updateAppliedMarker",
          cwd,
          args: ["update-ref", appliedMarker, commitResult.stdout.trim()],
        });
      }).pipe(Effect.ensuring(fs.remove(tempIndexPath, { force: true }).pipe(Effect.ignore)));
    }).pipe(
      Effect.catchCause((cause) =>
        // Non-fatal: falling back to the old not-advanced marker only loses
        // the resurrection protection for this pass, never correctness.
        Effect.logWarning("roaming wip: could not advance pinned applied marker", {
          workspaceProjectId: target.workspaceProjectId,
          cause,
        }),
      ),
    );
  }

  const appliedCommitOid = yield* resolveOid(cwd, newest.refName);
  if (conflicts.length > 0) {
    yield* Effect.logInfo("roaming wip: applied peer changes with conflicts held back", {
      workspaceProjectId: target.workspaceProjectId,
      fromEnvironmentId,
      commitOid: appliedCommitOid,
      applied: applied.length,
      conflicts,
    });
    return {
      _tag: "applied-with-conflicts",
      fromEnvironmentId,
      capturedAtIso: newest.iso,
      conflicts,
    } as WipApplyOutcome;
  }
  yield* Effect.logInfo("roaming wip: applied peer changes per-file", {
    workspaceProjectId: target.workspaceProjectId,
    fromEnvironmentId,
    commitOid: appliedCommitOid,
    applied: applied.length,
  });
  return {
    _tag: "applied",
    fromEnvironmentId,
    capturedAtIso: newest.iso,
  } as WipApplyOutcome;
});
