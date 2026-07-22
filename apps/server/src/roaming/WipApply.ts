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
import { CheckpointRef, EnvironmentId, type RoamingWipDivergence } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import {
  bundleShipped,
  isGitWorktree,
  inProgressOperationExists,
  payloadForCommit,
  scanPeerWipRefs,
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
  wipRefName,
  wipRejectedRefName,
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

/**
 * Everything the apply classifier consults, gathered by one effectful pass
 * over git/blob state so the decision itself (classifyWipApply) is pure and
 * exhaustively testable. Field semantics:
 *
 * - `conflictAlreadyResolved` — this machine captured its kept-local result
 *   for exactly this peer snapshot (marker's T3-Peer-Snapshot names it, our
 *   shipment's T3-Based-On names the marker); reprocessing would recreate a
 *   false Take over on every boot.
 * - `exactShippedEcho` — the peer snapshot is byte-for-byte our own last
 *   shipment coming back (its T3-Based-On names our shipped commit and
 *   branch/HEAD/tree all match): marker bookkeeping only.
 * - `staleBasedOn` — different-branch snapshot whose T3-Based-On predates
 *   our latest shipment (the peer has not seen our current state).
 * - `provenEcho` — ...and it is clean AND its position is already contained
 *   in our history (peer HEAD is our ancestor): a delayed echo of a branch
 *   move we made, safe to ignore. An UNPROVEN stale snapshot is a real
 *   divergence and must block, never silently skip (audit 2026-07-15).
 * - `untouched` — worktree equals the applied-marker tree or the HEAD tree,
 *   and our latest captured payload still matches this branch/HEAD.
 * - `peerBehind` / `fastForwardSafe` — same-branch ancestry between the two
 *   HEADs; meaningful only once same-context handling has been passed.
 * - `peerBranchHasLocalCommits` — a local branch with the peer's name exists
 *   and is not fast-forward-safe to the peer's HEAD.
 */
export interface WipContextFacts {
  readonly branchName: string;
  readonly sameBranch: boolean;
  readonly sameHead: boolean;
  readonly conflictAlreadyResolved: boolean;
  readonly exactShippedEcho: boolean;
  readonly newestIsApplied: boolean;
  readonly newestTreeIsWorktree: boolean;
  readonly staleBasedOn: boolean;
  readonly provenEcho: boolean;
  readonly peerBehind: boolean;
  readonly fastForwardSafe: boolean;
  readonly untouched: boolean;
  readonly hasInFlightTurn: boolean;
  readonly peerBranchHasLocalCommits: boolean;
}

export type WipApplyDecision =
  | { readonly _tag: "skip" }
  | { readonly _tag: "advanceMarker" }
  | { readonly _tag: "mergeSameContext" }
  | { readonly _tag: "fastForward" }
  | { readonly _tag: "reproduceReset" }
  | { readonly _tag: "switchBranch"; readonly clean: boolean }
  | {
      readonly _tag: "blocked";
      readonly reason: string;
      /**
       * Two-sided divergence (M4): both machines moved the same branch.
       * Surfaces the diff-and-choose resolution alongside takeover.
       */
      readonly divergence: boolean;
      /**
       * Whether explicit takeover would actually service this block —
       * false while an agent turn is in flight (takeover refuses too).
       */
      readonly takeoverServiceable: boolean;
    };

/**
 * The apply decision table (.plans/21-roaming-workspace.md "Apply —
 * reproduce completely or touch nothing"), pure over gathered facts. Row
 * order IS the semantics — echo/bookkeeping rows fire before same-context
 * handling, which fires before any HEAD-moving classification; takeover
 * bypasses every guard except an in-flight agent turn.
 */
export const classifyWipApply = (facts: WipContextFacts, takeover: boolean): WipApplyDecision => {
  const onPeerBranch = `the other machine is on ${facts.branchName}`;
  const divergedReason = `${facts.branchName} has diverged between your machines`;
  if (!takeover && facts.conflictAlreadyResolved) {
    return { _tag: "skip" };
  }
  if (facts.exactShippedEcho) {
    return { _tag: "advanceMarker" };
  }
  if (facts.sameBranch && facts.sameHead && !takeover) {
    if (facts.newestIsApplied) return { _tag: "skip" };
    if (facts.newestTreeIsWorktree) return { _tag: "advanceMarker" };
    return { _tag: "mergeSameContext" };
  }
  if (!takeover && !facts.sameBranch && facts.staleBasedOn) {
    return facts.provenEcho
      ? { _tag: "skip" }
      : {
          _tag: "blocked",
          reason: onPeerBranch,
          divergence: false,
          takeoverServiceable: !facts.hasInFlightTurn,
        };
  }
  if (!takeover && facts.peerBehind) {
    return { _tag: "skip" };
  }
  if (facts.hasInFlightTurn) {
    return {
      _tag: "blocked",
      reason: "an agent is working in this project; try again when it finishes",
      divergence: false,
      takeoverServiceable: false,
    };
  }
  if (!takeover && !facts.untouched) {
    // Same branch + non-ancestor HEADs is a real divergence even while the
    // checkout has local edits — "moved forward" would misdescribe it.
    return facts.sameBranch && !facts.fastForwardSafe
      ? { _tag: "blocked", reason: divergedReason, divergence: true, takeoverServiceable: true }
      : {
          _tag: "blocked",
          reason: facts.sameBranch
            ? `the other machine moved ${facts.branchName} forward; you have local edits`
            : onPeerBranch,
          divergence: false,
          takeoverServiceable: true,
        };
  }
  if (!takeover && facts.sameBranch && !facts.fastForwardSafe) {
    return { _tag: "blocked", reason: divergedReason, divergence: true, takeoverServiceable: true };
  }
  if (!takeover && !facts.sameBranch && facts.peerBranchHasLocalCommits) {
    return {
      _tag: "blocked",
      reason: `${facts.branchName} has local commits on this machine`,
      divergence: false,
      takeoverServiceable: true,
    };
  }
  if (facts.sameBranch) {
    return facts.fastForwardSafe && !takeover
      ? { _tag: "fastForward" }
      : { _tag: "reproduceReset" };
  }
  return { _tag: "switchBranch", clean: takeover };
};

/**
 * Per-path merge decision, pure over the four content oids and the causality
 * facts. `baseSource` names which tree supplied the merge base so conflict
 * pins stay diffable. The own-shipment fallback base is causality-gated: it
 * applies only when the path is absent locally (a local deletion of a file we
 * authored must not read as untouched absence), the peer's deletion of it
 * carried Based-On proof, or the peer snapshot descends from our shipment
 * (its edit is a reply, not a concurrent write). An unproven concurrent
 * snapshot must NOT use our own shipment as base: our unacknowledged edit
 * would compare equal to it, read "untouched", and the peer's bytes would
 * silently overwrite local work (accept-m35 no-clobber regression,
 * 2026-07-15).
 */
export const resolveWipPathAction = (input: {
  readonly ourOid: string | null;
  readonly peerOid: string | null;
  readonly markerBaseOid: string | null;
  readonly shippedPathOid: string | null;
  readonly cleanAtHead: boolean;
  readonly peerSawOurShipment: boolean;
  readonly shippedOnlyDelete: boolean;
}): {
  readonly action: "skip" | "keepOurs" | "conflict" | "deleteLocal" | "applyPeer";
  readonly baseSource: "marker" | "shipped" | null;
} => {
  const shippedBaseUsable =
    input.ourOid === null || input.peerSawOurShipment || input.shippedOnlyDelete;
  const baseOid =
    input.markerBaseOid ?? (input.cleanAtHead || !shippedBaseUsable ? null : input.shippedPathOid);
  const baseSource = baseOid === null ? null : input.markerBaseOid !== null ? "marker" : "shipped";
  if (input.ourOid === input.peerOid) {
    // Already at the peer's state (same content, or deleted on both).
    return { action: "skip", baseSource };
  }
  // A clean checkout can mean an intentional deletion of a file we authored.
  // Preserve it while the peer merely echoes the exact shipped bytes. If the
  // peer has DIFFERENT bytes at the same path, it recreated the filename from
  // clean state; apply that new file instead of manufacturing a conflict.
  if (
    input.cleanAtHead &&
    input.markerBaseOid === null &&
    input.ourOid === null &&
    input.shippedPathOid !== null &&
    input.peerOid === input.shippedPathOid
  ) {
    return { action: "skip", baseSource };
  }
  if (input.ourOid !== baseOid) {
    // WE changed this file since the last sync (edited or deleted it). If the
    // peer still holds exactly the synced version they did NOT touch it — our
    // change wins silently and our next capture propagates it (a clean local
    // delete, not a conflict). Only a genuine both-sides change surfaces.
    return input.peerOid !== baseOid
      ? { action: "conflict", baseSource }
      : { action: "keepOurs", baseSource };
  }
  if (input.peerOid === null) {
    return { action: "deleteLocal", baseSource };
  }
  return { action: "applyPeer", baseSource };
};

export type WipApplyOutcome =
  | { readonly _tag: "skipped" }
  | {
      readonly _tag: "blocked";
      readonly reason: string;
      /** The peer snapshot commit that produced this block. */
      readonly snapshotOid: string;
      readonly fromEnvironmentId: EnvironmentId;
      /** Two-sided divergence — the diff-and-choose resolution applies. */
      readonly divergence: boolean;
      /** Whether explicit takeover would service this block. */
      readonly takeoverServiceable: boolean;
    }
  | {
      readonly _tag: "applied";
      readonly fromEnvironmentId: EnvironmentId;
      readonly capturedAtIso: string;
    }
  | {
      readonly _tag: "applied-with-conflicts";
      readonly fromEnvironmentId: EnvironmentId;
      readonly capturedAtIso: string;
      readonly snapshotOid: string;
      readonly conflicts: ReadonlyArray<string>;
    };

export interface WipApplyOptions {
  readonly hasInFlightTurn?: boolean;
  readonly takeover?: boolean;
  /**
   * Takeover pinning (M4): the snapshot the user was shown. When the newest
   * available snapshot differs, the takeover refuses instead of applying
   * work the user never saw.
   */
  readonly expectedSnapshotOid?: string;
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

export type NewestPeerSnapshot =
  | { readonly _tag: "none" }
  /** Payload predates v2 branch/HEAD context — never auto-applies. */
  | {
      readonly _tag: "legacy";
      readonly commitOid: string;
      readonly fromEnvironmentId: EnvironmentId;
    }
  /** Snapshot integrity failed (tree/parent/branch-ref mismatch). */
  | {
      readonly _tag: "invalid";
      readonly commitOid: string;
      readonly fromEnvironmentId: EnvironmentId;
    }
  | {
      readonly _tag: "snapshot";
      readonly refName: string;
      readonly commitOid: string;
      readonly treeOid: string;
      readonly branchRef: string;
      readonly headOid: string;
      readonly peerHeadTree: string;
      readonly capturedAt: string;
      readonly unix: number;
      readonly iso: string;
      readonly fromEnvironmentId: EnvironmentId;
    };

/**
 * Freshen (origin fetch + mirrored bundle import) and select the newest
 * peer WIP snapshot for a project, validating its integrity. Shared by the
 * apply pass and the M4 divergence routes so both always reason about the
 * same snapshot.
 */
export const selectNewestPeerSnapshot = Effect.fn("WipSnapshotReactor.selectNewestPeerSnapshot")(
  function* (target: WipTarget) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const cwd = target.workspaceRoot;
    const ownRef = yield* wipRefName(target.workspaceProjectId, environmentId);

    const scan = yield* scanPeerWipRefs({
      cwd,
      workspaceProjectId: target.workspaceProjectId,
      excludeEnvironmentId: environmentId,
    });
    const payloads = scan.payloads;

    // Newest peer snapshot (own env excluded).
    const candidates = scan.candidates.filter((candidate) => candidate.refName !== ownRef);
    // Reinstalls and interrupted bundle imports can leave orphan refs behind.
    // Never let an unmatched stale ref outrank the current mirrored snapshot
    // and manufacture a false legacy/takeover state.
    const newest = [...candidates]
      .sort((left, right) => right.committedAtUnix - left.committedAtUnix)
      .find(
        (candidate) => payloads.get(`${candidate.refName}\0${candidate.commitOid}`) !== undefined,
      );
    const newestCommit = newest?.commitOid ?? null;
    const payload =
      newest === undefined ? undefined : payloads.get(`${newest.refName}\0${newest.commitOid}`);
    if (newest === undefined || newestCommit === null || payload === undefined) {
      return { _tag: "none" } as NewestPeerSnapshot;
    }
    const fromEnvironmentId = EnvironmentId.make(newest.refName.split("/").pop() ?? "unknown");
    if (
      payload.schemaVersion < 2 ||
      payload.branchRef === undefined ||
      payload.headOid === undefined
    ) {
      return { _tag: "legacy", commitOid: newestCommit, fromEnvironmentId } as NewestPeerSnapshot;
    }
    const newestTree = yield* resolveOid(cwd, `${newest.refName}^{tree}`);
    const peerHeadTree = yield* resolveOid(cwd, `${payload.headOid}^{tree}`);
    const peerParent = yield* resolveOid(cwd, `${newest.refName}^`);
    if (
      newestTree === null ||
      peerHeadTree === null ||
      newestTree !== payload.treeOid ||
      peerParent !== payload.headOid ||
      !(yield* validBranchRef(cwd, payload.branchRef))
    ) {
      return { _tag: "invalid", commitOid: newestCommit, fromEnvironmentId } as NewestPeerSnapshot;
    }
    return {
      _tag: "snapshot",
      refName: newest.refName,
      commitOid: newestCommit,
      treeOid: payload.treeOid,
      branchRef: payload.branchRef,
      headOid: payload.headOid,
      peerHeadTree,
      capturedAt: payload.capturedAt,
      unix: newest.committedAtUnix,
      iso: newest.committedAtIso,
      fromEnvironmentId,
    } as NewestPeerSnapshot;
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
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const cwd = target.workspaceRoot;

  if (!(yield* isGitWorktree(cwd))) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  if (yield* inProgressOperationExists(cwd)) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  const appliedMarker = yield* wipAppliedMarkerRefName(target.workspaceProjectId);
  const takeover = options.takeover === true;

  const newest = yield* selectNewestPeerSnapshot(target);
  if (newest._tag === "none") {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  if (newest._tag === "legacy") {
    return {
      _tag: "blocked",
      reason: "the other machine must update this project before its changes can be applied",
      snapshotOid: newest.commitOid,
      fromEnvironmentId: newest.fromEnvironmentId,
      divergence: false,
      takeoverServiceable: false,
    } as WipApplyOutcome;
  }
  if (newest._tag === "invalid") {
    return {
      _tag: "blocked",
      reason: "the other machine's project state cannot be applied automatically",
      snapshotOid: newest.commitOid,
      fromEnvironmentId: newest.fromEnvironmentId,
      divergence: false,
      takeoverServiceable: false,
    } as WipApplyOutcome;
  }
  if (
    takeover &&
    options.expectedSnapshotOid !== undefined &&
    newest.commitOid !== options.expectedSnapshotOid
  ) {
    return {
      _tag: "blocked",
      reason:
        "the other machine's work changed since you looked; review the latest state and try again",
      snapshotOid: newest.commitOid,
      fromEnvironmentId: newest.fromEnvironmentId,
      divergence: false,
      takeoverServiceable: true,
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
  const appliedCommit = yield* resolveOid(cwd, appliedMarker);
  if (!(yield* validBranchRef(cwd, localState.branchRef))) {
    return {
      _tag: "blocked",
      reason: "the other machine's project state cannot be applied automatically",
      snapshotOid: newest.commitOid,
      fromEnvironmentId: newest.fromEnvironmentId,
      divergence: false,
      takeoverServiceable: false,
    } as WipApplyOutcome;
  }

  // ── Gather the classifier facts ────────────────────────────────────────
  // Provenance glossary — four trailers answer four questions:
  //   peerBasedOn          what peer state did THIS SNAPSHOT consume?
  //                        (T3-Based-On of the peer snapshot)
  //   ownBasedOn           what peer state did OUR last shipment consume?
  //                        (T3-Based-On of our shipped commit)
  //   recordedConflictPeer which exact peer commit did our pinned conflict
  //                        resolution answer? (marker's T3-Peer-Snapshot)
  //   shippedBase          what did we last ship? (pushed marker / bundle
  //                        payload, read PRE-capture by the reactor)
  const sameBranch = newest.branchRef === localState.branchRef;
  const sameHead = newest.headOid === localState.headOid;
  const shippedBase =
    shippedBaseOid !== undefined
      ? shippedBaseOid
      : yield* resolveOid(
          cwd,
          yield* wipPushedMarkerRefName(target.workspaceProjectId, environmentId),
        );
  const ownPayload = yield* bundleShipped(target.workspaceProjectId, environmentId);
  const appliedContextPayload = yield* payloadForCommit(target.workspaceProjectId, appliedCommit);
  const localContextBaseline = ownPayload ?? appliedContextPayload;
  const localContextCaptured =
    localContextBaseline === null ||
    localContextBaseline === undefined ||
    (localContextBaseline.branchRef === localState.branchRef &&
      localContextBaseline.headOid === localState.headOid);
  const peerBasedOn = yield* readBasedOn(cwd, newest.refName);
  const ownBasedOn =
    ownPayload === null || ownPayload === undefined
      ? null
      : yield* readBasedOn(cwd, ownPayload.commitOid);
  const recordedConflictPeer =
    appliedCommit === null ? null : yield* readConflictPeer(cwd, appliedCommit);
  // Ancestry facts are consulted (and were historically computed) only once
  // same-context handling has been passed; gather them under the same
  // conditions so the pass cost is unchanged.
  const contextDiffers = !(sameBranch && sameHead && !takeover);
  const staleBasedOn =
    !sameBranch && peerBasedOn !== null && shippedBase !== null && peerBasedOn !== shippedBase;
  const peerHeadInLocalHistory =
    contextDiffers && (sameBranch || staleBasedOn)
      ? yield* isAncestor(cwd, newest.headOid, localState.headOid)
      : false;
  const fastForwardSafe =
    contextDiffers && sameBranch
      ? yield* isAncestor(cwd, localState.headOid, newest.headOid)
      : false;
  const markerTree = contextDiffers ? yield* resolveOid(cwd, `${appliedMarker}^{tree}`) : null;
  const localPeerBranchOid =
    contextDiffers && !sameBranch ? yield* resolveOid(cwd, newest.branchRef) : null;
  const peerBranchHasLocalCommits =
    localPeerBranchOid !== null && !(yield* isAncestor(cwd, localPeerBranchOid, newest.headOid));

  const facts: WipContextFacts = {
    branchName: newest.branchRef.slice("refs/heads/".length),
    sameBranch,
    sameHead,
    conflictAlreadyResolved:
      ownBasedOn === appliedCommit &&
      localContextCaptured &&
      recordedConflictPeer === newest.commitOid,
    exactShippedEcho:
      shippedBase !== null &&
      peerBasedOn === shippedBase &&
      ownPayload?.commitOid === shippedBase &&
      ownPayload.branchRef === newest.branchRef &&
      ownPayload.headOid === newest.headOid &&
      ownPayload.treeOid === newest.treeOid,
    newestIsApplied: newest.commitOid === appliedCommit,
    newestTreeIsWorktree: newest.treeOid === worktreeTree,
    staleBasedOn,
    provenEcho: staleBasedOn && newest.treeOid === newest.peerHeadTree && peerHeadInLocalHistory,
    peerBehind: contextDiffers && sameBranch && peerHeadInLocalHistory,
    fastForwardSafe,
    // A user may deliberately clean/reset an earlier synchronized WIP tree.
    // Git-clean at HEAD is still an untouched checkout for branch movement;
    // a retained applied marker must not manufacture local edits forever.
    untouched: (markerTree === worktreeTree || headTree === worktreeTree) && localContextCaptured,
    hasInFlightTurn: options.hasInFlightTurn === true,
    peerBranchHasLocalCommits,
  };

  // ── Decide, then execute ───────────────────────────────────────────────
  const decision = classifyWipApply(facts, takeover);
  if (decision._tag === "skip") {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  if (decision._tag === "blocked") {
    return {
      _tag: "blocked",
      reason: decision.reason,
      snapshotOid: newest.commitOid,
      fromEnvironmentId: newest.fromEnvironmentId,
      divergence: decision.divergence,
      takeoverServiceable: decision.takeoverServiceable,
    } as WipApplyOutcome;
  }
  if (decision._tag === "advanceMarker") {
    yield* git.execute({
      operation: "WipSnapshotReactor.updateAppliedMarker",
      cwd,
      args: ["update-ref", appliedMarker, newest.commitOid],
    });
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  let mergeBaseOverride: string | null = null;
  if (decision._tag !== "mergeSameContext") {
    // Park before ANY HEAD move — per-branch parked refs make auto-switch
    // and takeover lossless, and multi-branch WIP survives switching.
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
    if (decision._tag === "fastForward") {
      yield* git.execute({
        operation: "WipSnapshotReactor.fastForward",
        cwd,
        // The untouched fact proved the checkout still equals the last
        // applied snapshot. Reproduce the peer's committed state first; the
        // per-file pass below then reapplies its WIP tree on top. This
        // handles both newly committed files and files that already arrived
        // as untracked WIP before becoming committed.
        args: ["reset", "--hard", newest.headOid],
      });
    } else if (decision._tag === "reproduceReset") {
      yield* git.execute({
        operation: "WipSnapshotReactor.takeoverReset",
        cwd,
        args: ["reset", "--hard", newest.headOid],
      });
      yield* git.execute({
        operation: "WipSnapshotReactor.takeoverClean",
        cwd,
        args: ["clean", "-fd"],
      });
    } else {
      yield* git.execute({
        operation: "WipSnapshotReactor.switchBranch",
        cwd,
        args: ["switch", "-C", facts.branchName, newest.headOid],
      });
      if (decision.clean) {
        yield* git.execute({
          operation: "WipSnapshotReactor.takeoverClean",
          cwd,
          args: ["clean", "-fd"],
        });
      }
    }
    mergeBaseOverride = newest.headOid;
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
    appliedCommit ??
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
  const peerBasedOnPeer = yield* readBasedOnPeer(cwd, newest.refName);
  // The peer snapshot provably descends from our last shipment: its Based-On
  // (or the transported conflict proof) names that exact commit. Only then is
  // our shipped snapshot common history usable as a per-file merge base.
  const peerSawOurShipment =
    shippedBase !== null && (peerBasedOn === shippedBase || peerBasedOnPeer === shippedBase);

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
      const seenState = peerBasedOnPeer === shippedBase ? shippedBase : peerBasedOn;
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
    const resolution = resolveWipPathAction({
      ourOid,
      peerOid,
      markerBaseOid,
      shippedPathOid,
      cleanAtHead,
      peerSawOurShipment,
      shippedOnlyDelete: shippedOnlyDeletes.has(relativePath),
    });
    const baseSourceTree =
      resolution.baseSource === "marker"
        ? base
        : resolution.baseSource === "shipped"
          ? shippedBase
          : null;
    if (resolution.action === "skip" || resolution.action === "keepOurs") {
      continue;
    }
    if (resolution.action === "conflict") {
      holdConflict(relativePath, baseSourceTree);
      continue;
    }
    if (resolution.action === "deleteLocal") {
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
        args: ["update-ref", appliedMarker, newest.commitOid],
      });
      return {
        _tag: "applied",
        fromEnvironmentId: newest.fromEnvironmentId,
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
  if (conflicts.length === 0) {
    yield* git.execute({
      operation: "WipSnapshotReactor.updateAppliedMarker",
      cwd,
      args: ["update-ref", appliedMarker, newest.commitOid],
    });
  } else {
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
          args: ["read-tree", newest.commitOid],
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
            `T3-Peer-Snapshot: ${newest.commitOid}`,
          ],
          env: {
            ...markerEnv,
            GIT_AUTHOR_DATE: `${newest.unix - 1} +0000`,
            GIT_COMMITTER_DATE: `${newest.unix - 1} +0000`,
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
      fromEnvironmentId: newest.fromEnvironmentId,
      commitOid: appliedCommitOid,
      applied: applied.length,
      conflicts,
    });
    return {
      _tag: "applied-with-conflicts",
      fromEnvironmentId: newest.fromEnvironmentId,
      capturedAtIso: newest.iso,
      snapshotOid: newest.commitOid,
      conflicts,
    } as WipApplyOutcome;
  }
  yield* Effect.logInfo("roaming wip: applied peer changes per-file", {
    workspaceProjectId: target.workspaceProjectId,
    fromEnvironmentId: newest.fromEnvironmentId,
    commitOid: appliedCommitOid,
    applied: applied.length,
  });
  return {
    _tag: "applied",
    fromEnvironmentId: newest.fromEnvironmentId,
    capturedAtIso: newest.iso,
  } as WipApplyOutcome;
});

// ── Divergence (M4) ──────────────────────────────────────────────────────

/** Mirrors the checkpoint-diff cap; a capped patch is marked, never split. */
const DIVERGENCE_PATCH_MAX_OUTPUT_BYTES = 10_000_000;

const divergencePatch = (cwd: string, baseSpec: string, sideSpec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.divergencePatch",
      cwd,
      args: ["diff", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", baseSpec, sideSpec],
      allowNonZeroExit: true,
      maxOutputBytes: DIVERGENCE_PATCH_MAX_OUTPUT_BYTES,
    });
    return result.exitCode === 0
      ? { patch: result.stdout, truncated: result.stdoutTruncated === true }
      : null;
  });

/**
 * The two-sided divergence for a project, or null when it is not currently
 * diverged (same branch on both machines, neither HEAD an ancestor of the
 * other). Patches run merge-base → each side's full working state; the
 * local side diffs the live worktree tree (vault-subtracted), so its
 * `snapshotOid` is a TREE oid — current state, not a captured snapshot.
 */
export const getWipDivergenceForTarget = Effect.fn("WipSnapshotReactor.getWipDivergenceForTarget")(
  function* (target: WipTarget) {
    const git = yield* GitVcsDriver;
    const cwd = target.workspaceRoot;
    if (!(yield* isGitWorktree(cwd))) return null;
    const newest = yield* selectNewestPeerSnapshot(target);
    if (newest._tag !== "snapshot") return null;
    const excludePaths = yield* vaultExcludePathsFor(target);
    if (excludePaths === null) return null;
    const localState = yield* writeWorktreeTree({ cwd, vaultExcludePaths: excludePaths });
    if (newest.branchRef !== localState.branchRef || newest.headOid === localState.headOid) {
      return null;
    }
    if (
      (yield* isAncestor(cwd, localState.headOid, newest.headOid)) ||
      (yield* isAncestor(cwd, newest.headOid, localState.headOid))
    ) {
      return null;
    }
    const mergeBase = yield* git.execute({
      operation: "WipSnapshotReactor.divergenceMergeBase",
      cwd,
      args: ["merge-base", localState.headOid, newest.headOid],
      allowNonZeroExit: true,
    });
    // Unrelated histories have no merge-base: diff both sides in full.
    const baseOid =
      mergeBase.exitCode === 0 && mergeBase.stdout.trim().length > 0
        ? mergeBase.stdout.trim()
        : EMPTY_TREE_OID;
    const localPatch = yield* divergencePatch(cwd, baseOid, localState.treeOid);
    const peerPatch = yield* divergencePatch(cwd, baseOid, newest.commitOid);
    if (localPatch === null || peerPatch === null) return null;
    const nowIso = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return {
      workspaceProjectId: target.workspaceProjectId,
      baseOid,
      local: {
        branchRef: localState.branchRef,
        headOid: localState.headOid,
        snapshotOid: localState.treeOid,
        capturedAt: nowIso,
        patch: localPatch.patch,
        ...(localPatch.truncated ? { truncated: true } : {}),
      },
      peer: {
        environmentId: newest.fromEnvironmentId,
        branchRef: newest.branchRef,
        headOid: newest.headOid,
        snapshotOid: newest.commitOid,
        capturedAt: newest.capturedAt,
        patch: peerPatch.patch,
        ...(peerPatch.truncated ? { truncated: true } : {}),
      },
    } satisfies RoamingWipDivergence;
  },
);

export type KeptLocalResolution =
  | { readonly resolved: true; readonly preservedRef: string }
  | { readonly resolved: false; readonly reason: string };

/**
 * Divergence resolution, pick=local: keep this checkout exactly as it is,
 * pin the rejected peer snapshot to `refs/t3/wip-rejected/<wsid>/<envid>`
 * (recoverable after the peer force-updates its moving ref), and write a
 * kept-local applied marker — a synthetic commit of the CURRENT worktree
 * tree whose `T3-Peer-Snapshot` trailer names the rejected commit. The
 * caller then forces an acknowledgement capture; once that ships, the
 * classifier's conflictAlreadyResolved row keeps this exact snapshot
 * settled on every future pass. Touches no worktree state.
 */
export const resolveKeptLocalDivergence = Effect.fn(
  "WipSnapshotReactor.resolveKeptLocalDivergence",
)(function* (target: WipTarget, expectedPeerSnapshotOid: string) {
  const git = yield* GitVcsDriver;
  const cwd = target.workspaceRoot;
  const changedReason =
    "the other machine's work changed since you looked; review the latest state and try again";
  if (!(yield* isGitWorktree(cwd))) {
    return { resolved: false, reason: "not a git checkout" } as KeptLocalResolution;
  }
  const newest = yield* selectNewestPeerSnapshot(target);
  if (newest._tag !== "snapshot" || newest.commitOid !== expectedPeerSnapshotOid) {
    return { resolved: false, reason: changedReason } as KeptLocalResolution;
  }
  const rejectedRef = yield* wipRejectedRefName(
    target.workspaceProjectId,
    newest.fromEnvironmentId,
  );
  yield* git.execute({
    operation: "WipSnapshotReactor.pinRejectedSnapshot",
    cwd,
    args: ["update-ref", rejectedRef, newest.commitOid],
  });
  const excludePaths = yield* vaultExcludePathsFor(target);
  if (excludePaths === null) {
    return {
      resolved: false,
      reason: "could not read the project's sync manifests",
    } as KeptLocalResolution;
  }
  const localState = yield* writeWorktreeTree({ cwd, vaultExcludePaths: excludePaths });
  // Dated 1s before the peer snapshot, like the per-file conflict pin, so
  // newest-selection keeps re-examining that snapshot until it is settled.
  const marker = yield* git.execute({
    operation: "WipSnapshotReactor.keptLocalMarkerCommit",
    cwd,
    args: [
      "commit-tree",
      localState.treeOid,
      "-m",
      "t3 wip applied marker (divergence resolved, kept local)",
      "-m",
      `T3-Peer-Snapshot: ${newest.commitOid}`,
    ],
    env: {
      ...process.env,
      ...COMMIT_ENV_IDENTITY,
      GIT_AUTHOR_DATE: `${newest.unix - 1} +0000`,
      GIT_COMMITTER_DATE: `${newest.unix - 1} +0000`,
    },
  });
  yield* git.execute({
    operation: "WipSnapshotReactor.updateAppliedMarker",
    cwd,
    args: [
      "update-ref",
      yield* wipAppliedMarkerRefName(target.workspaceProjectId),
      marker.stdout.trim(),
    ],
  });
  return { resolved: true, preservedRef: rejectedRef } as KeptLocalResolution;
});
