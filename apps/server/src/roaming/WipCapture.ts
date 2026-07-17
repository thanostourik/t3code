/**
 * The capture + transport half of WIP sync: one pass snapshots a project's
 * working state (WipSnapshots.ts) and ships it — pushed to the project's
 * primary remote as `refs/t3/wip/<wsid>/<envid>` by default, falling back to
 * a git bundle over the peer mirror (blob kind=wip) when the remote refuses
 * pushes, with an empty-bundle freshness beacon on every successful push.
 * Pure of reactor state: receives the current transport mode, reports the
 * next one. The reactor adds triggers, coalescing, and status bookkeeping.
 */
import {
  ROAMING_WIP_BUNDLE_MAX_BYTES,
  ROAMING_WIP_MAX_FILE_BYTES,
  type RoamingWipStatusEntry,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import {
  bundleShipped,
  encodeWipPayloadJson,
  isGitWorktree,
  inProgressOperationExists,
  payloadForCommit,
  primaryRemoteName,
  vaultExcludePathsFor,
  type WipTarget,
  type WipTransportMode,
} from "./WipShared.ts";
import { renewLease } from "./WipLease.ts";
import {
  captureWipSnapshot,
  readBasedOn,
  readBasedOnPeer,
  readConflictPeer,
  resolveOid,
  wipAppliedMarkerRefName,
  wipPushedMarkerRefName,
} from "./WipSnapshots.ts";

const PERMISSION_STDERR =
  /permission denied|403|forbidden|not authorized|access denied|read.?only|protected ref|hidden ref|remote rejected|pre-receive hook declined/i;

const LEASE_STDERR = /stale info|\[rejected\]|fetch first|failed to push some refs/i;

/**
 * Untracked non-ignored files too large to ride a snapshot (they would land
 * on the git host in origin mode). Excluded from capture, surfaced as a
 * warning; the peer's clean-tree guard keeps its own copy safe.
 */
const oversizeUntrackedPaths = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const listing = yield* git.execute({
      operation: "WipSnapshotReactor.listUntracked",
      cwd,
      args: ["ls-files", "-z", "-o", "--exclude-standard"],
      allowNonZeroExit: true,
    });
    if (listing.exitCode !== 0) {
      return [];
    }
    const oversize: Array<{ readonly path: string; readonly bytes: number }> = [];
    for (const relativePath of listing.stdout.split("\0")) {
      if (relativePath.length === 0) {
        continue;
      }
      const stat = yield* fs
        .stat(pathService.join(cwd, relativePath))
        .pipe(Effect.orElseSucceed(() => null));
      if (stat?.type === "File" && Number(stat.size) > ROAMING_WIP_MAX_FILE_BYTES) {
        oversize.push({ path: relativePath, bytes: Number(stat.size) });
      }
    }
    return oversize;
  });

export type WipPassOutcome =
  | { readonly _tag: "skipped"; readonly warning?: string }
  | {
      readonly _tag: "done";
      readonly entry: RoamingWipStatusEntry;
      readonly nextMode: WipTransportMode;
    };

/**
 * One capture + transport pass for one project. Pure of reactor state:
 * receives the current transport mode, reports the next one. Exported for
 * tests (the reactor itself only adds triggers, coalescing, and status
 * bookkeeping around this).
 */
export const runWipPassForTarget = Effect.fn("WipSnapshotReactor.runWipPassForTarget")(function* (
  target: WipTarget,
  mode: WipTransportMode,
  options: { readonly acknowledgeApplied?: boolean } = {},
) {
  const git = yield* GitVcsDriver;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const cwd = target.workspaceRoot;

  if (!(yield* isGitWorktree(cwd))) {
    return { _tag: "skipped" } as WipPassOutcome;
  }
  if (yield* inProgressOperationExists(cwd)) {
    return { _tag: "skipped" } as WipPassOutcome;
  }

  const markerRef = yield* wipPushedMarkerRefName(target.workspaceProjectId, environmentId);

  const excludePaths = yield* vaultExcludePathsFor(target);
  if (excludePaths === null) {
    yield* Effect.logWarning("roaming wip: vault set unavailable, skipping snapshot", {
      workspaceProjectId: target.workspaceProjectId,
    });
    return { _tag: "skipped" } as WipPassOutcome;
  }

  // The no-op baseline is the last SHIPPED tree: the pushed-marker ref in
  // origin mode (written only after a successful push), the current wip
  // blob's tree in bundle mode (there is no marker there — without this the
  // bundle path would re-mirror up to 8 MiB every interval on an idle repo).
  const oversize = yield* oversizeUntrackedPaths(cwd);
  const captureExcludePaths = [...excludePaths, ...oversize.map((entry) => entry.path)];
  const oversizeWarning =
    oversize.length === 0
      ? null
      : `large files not synced: ${oversize
          .slice(0, 3)
          .map((entry) => `${entry.path} (${Math.round(entry.bytes / (1024 * 1024))} MB)`)
          .join(", ")}${oversize.length > 3 ? ` and ${oversize.length - 3} more` : ""}`;
  const withOversize = (message: string) =>
    oversizeWarning === null ? message : `${message}; ${oversizeWarning}`;

  const markerTree = yield* resolveOid(cwd, `${markerRef}^{tree}`);
  const shippedPayload = yield* bundleShipped(target.workspaceProjectId, environmentId);
  const shippedTree = mode === "bundle" ? (shippedPayload?.treeOid ?? null) : markerTree;
  // An identical tree may still NEED to ship: if the applied marker moved
  // since the last ship (we consumed a peer snapshot), the fresh snapshot's
  // Based-On is the only signal telling the peer "this is still my tree
  // AFTER seeing yours". Without it, a delete that returns the tree to a
  // previously-shipped state (receiver-side delete of a peer-authored file)
  // dedupes into silence and never reaches the author (field bug
  // 2026-07-10). Two no-op baselines remain:
  //  - the shipped tree, while the applied marker still equals the shipped
  //    snapshot's Based-On (a true nothing-happened pass), and
  //  - the exact applied peer tuple until our own shipped snapshot names it
  //    in Based-On: our state IS the peer state we just consumed, so an echo
  //    says nothing. Once local work ships, this baseline switches off.
  const shippedCommitSpec =
    mode === "bundle"
      ? (shippedPayload?.commitOid ?? null)
      : markerTree === null
        ? null
        : markerRef;
  const appliedMarkerRef = yield* wipAppliedMarkerRefName(target.workspaceProjectId);
  const appliedNow = yield* resolveOid(cwd, appliedMarkerRef);
  const shippedBasedOn =
    shippedCommitSpec === null ? null : yield* readBasedOn(cwd, shippedCommitSpec);
  const appliedConflictPeer = appliedNow === null ? null : yield* readConflictPeer(cwd, appliedNow);
  const shippedBasedOnPeer =
    shippedCommitSpec === null ? null : yield* readBasedOnPeer(cwd, shippedCommitSpec);
  const conflictProofRecorded =
    appliedConflictPeer === null || shippedBasedOnPeer === appliedConflictPeer;
  const appliedPayload = yield* payloadForCommit(target.workspaceProjectId, appliedNow);
  const shippedIdentity =
    shippedPayload?.branchRef === undefined || shippedPayload.headOid === undefined
      ? null
      : {
          branchRef: shippedPayload.branchRef,
          headOid: shippedPayload.headOid,
          treeOid: shippedPayload.treeOid,
        };
  const noOpSnapshots = [
    ...(shippedIdentity !== null &&
    shippedTree !== null &&
    appliedNow === shippedBasedOn &&
    conflictProofRecorded
      ? [shippedIdentity]
      : []),
    ...(!options.acknowledgeApplied &&
    appliedPayload?.branchRef !== undefined &&
    appliedPayload.headOid !== undefined &&
    appliedNow !== shippedBasedOn
      ? [
          {
            branchRef: appliedPayload.branchRef,
            headOid: appliedPayload.headOid,
            treeOid: appliedPayload.treeOid,
          },
        ]
      : []),
  ];

  const captureStartedMs = yield* Clock.currentTimeMillis;
  const captured = yield* captureWipSnapshot({
    cwd,
    workspaceProjectId: target.workspaceProjectId,
    environmentId,
    vaultExcludePaths: captureExcludePaths,
    skipIfSnapshots: noOpSnapshots,
  });
  if (captured === null) {
    // An oversized file may be the ONLY change — the capture no-ops (its
    // exclusion leaves the tree identical) but the user must still learn
    // the file is not syncing.
    return (
      oversizeWarning === null ? { _tag: "skipped" } : { _tag: "skipped", warning: oversizeWarning }
    ) as WipPassOutcome;
  }
  const capturedAt = yield* nowIso;
  // Stage timing (M3.7): every hop of the delivery chain logs one line with
  // the commitOid, so slow deliveries can be attributed to a stage instead
  // of guessed at. Grep key: "roaming timing".
  const captureDoneMs = yield* Clock.currentTimeMillis;
  yield* Effect.logInfo("roaming timing: captured", {
    workspaceProjectId: target.workspaceProjectId,
    commitOid: captured.commitOid,
    treeOid: captured.treeOid,
    durationMs: captureDoneMs - captureStartedMs,
  });

  const entryBase = {
    workspaceProjectId: target.workspaceProjectId,
    lastCapturedAt: capturedAt,
    ...(oversizeWarning === null ? {} : { lastError: oversizeWarning }),
  };

  const remote = yield* primaryRemoteName(cwd);
  if (remote === null) {
    return {
      _tag: "done",
      nextMode: mode,
      entry: { ...entryBase, mode, lastError: withOversize("no git remote configured") },
    } as WipPassOutcome;
  }

  const writeBundleBlob = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const blobStore = yield* RoamingBlobStore;
    const tempDir = yield* fs.makeTempDirectory({ prefix: "t3-wip-bundle-" });
    const bundlePath = pathService.join(tempDir, "wip.bundle");
    return yield* Effect.gen(function* () {
      const bundled = yield* git.execute({
        operation: "WipSnapshotReactor.bundleCreate",
        cwd,
        args: ["bundle", "create", bundlePath, captured.refName, "--not", `--remotes=${remote}`],
        allowNonZeroExit: true,
      });
      if (bundled.exitCode !== 0) {
        return {
          ...entryBase,
          mode: "bundle",
          lastError: withOversize(`bundle create failed: ${bundled.stderr.trim().slice(0, 200)}`),
        } satisfies RoamingWipStatusEntry;
      }
      const stat = yield* fs.stat(bundlePath);
      if (Number(stat.size) > ROAMING_WIP_BUNDLE_MAX_BYTES) {
        yield* Effect.logWarning("roaming wip: bundle exceeds size cap, skipping blob", {
          workspaceProjectId: target.workspaceProjectId,
          bytes: Number(stat.size),
          maxBytes: ROAMING_WIP_BUNDLE_MAX_BYTES,
        });
        return {
          ...entryBase,
          mode: "bundle",
          lastError: withOversize("wip bundle exceeds size cap"),
        } satisfies RoamingWipStatusEntry;
      }
      // The origin→bundle flip captures before knowing the blob baseline:
      // skip the write only when the blob already carries this exact working
      // state. Branch and HEAD are part of the identity even when the tree is
      // unchanged.
      const shippedBlob = yield* bundleShipped(target.workspaceProjectId, environmentId);
      if (
        shippedBlob?.treeOid === captured.treeOid &&
        shippedBlob.branchRef === captured.branchRef &&
        shippedBlob.headOid === captured.headOid
      ) {
        return { ...entryBase, mode: "bundle" } satisfies RoamingWipStatusEntry;
      }
      const content = yield* fs.readFile(bundlePath);
      const payload = yield* encodeWipPayloadJson({
        schemaVersion: 2,
        capturedAt,
        refName: captured.refName,
        commitOid: captured.commitOid,
        treeOid: captured.treeOid,
        branchRef: captured.branchRef,
        headOid: captured.headOid,
        bundleBase64: Buffer.from(content).toString("base64"),
      });
      yield* blobStore.writeLocal({
        kind: "wip",
        key: `${target.workspaceProjectId}/${environmentId}`,
        workspaceProjectId: target.workspaceProjectId,
        payload,
      });
      yield* renewLease({
        workspaceProjectId: target.workspaceProjectId,
        environmentId,
        lastSnapshotAt: capturedAt,
      });
      return {
        ...entryBase,
        mode: "bundle",
        lastPushedAt: capturedAt,
      } satisfies RoamingWipStatusEntry;
    }).pipe(
      Effect.ensuring(fs.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });

  if (mode === "bundle") {
    const entry = yield* writeBundleBlob;
    return { _tag: "done", nextMode: "bundle", entry } as WipPassOutcome;
  }

  const pushOnce = (lease: string) =>
    git.execute({
      operation: "WipSnapshotReactor.pushWipRef",
      cwd,
      args: [
        "push",
        remote,
        `${captured.refName}:${captured.refName}`,
        `--force-with-lease=${captured.refName}:${lease}`,
      ],
      allowNonZeroExit: true,
    });

  const markerOid = yield* resolveOid(cwd, markerRef);
  const pushStartedMs = yield* Clock.currentTimeMillis;
  let pushResult = yield* pushOnce(markerOid ?? "");
  // Permission is terminal — git also prints lease-shaped lines ("failed to
  // push some refs") on denials, so it must be classified first or we would
  // fetch + re-push against a ref we are not allowed to touch.
  if (
    pushResult.exitCode !== 0 &&
    !PERMISSION_STDERR.test(pushResult.stderr) &&
    LEASE_STDERR.test(pushResult.stderr)
  ) {
    // Adopt the remote's value (a lost marker, e.g. a fresh clone of our own
    // state) and retry once. The ref name embeds our environmentId, so the
    // only writer we can race is ourselves.
    const fetched = yield* git.execute({
      operation: "WipSnapshotReactor.fetchWipRef",
      cwd,
      args: ["fetch", remote, `+${captured.refName}:${markerRef}`],
      allowNonZeroExit: true,
    });
    if (fetched.exitCode === 0) {
      const adopted = yield* resolveOid(cwd, markerRef);
      pushResult = yield* pushOnce(adopted ?? "");
    }
  }

  if (pushResult.exitCode === 0) {
    const pushDoneMs = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("roaming timing: origin-pushed", {
      workspaceProjectId: target.workspaceProjectId,
      commitOid: captured.commitOid,
      durationMs: pushDoneMs - pushStartedMs,
    });
    yield* git.execute({
      operation: "WipSnapshotReactor.updateMarker",
      cwd,
      args: ["update-ref", markerRef, captured.commitOid],
    });
    // Freshness beacon: an empty-bundle wip blob rides the mirror (which
    // pushes on every local blob write), so the peer learns "fetch my
    // origin ref" within seconds instead of on its next interval tick.
    yield* Effect.gen(function* () {
      const blobStore = yield* RoamingBlobStore;
      const payload = yield* encodeWipPayloadJson({
        schemaVersion: 2,
        capturedAt,
        refName: captured.refName,
        commitOid: captured.commitOid,
        treeOid: captured.treeOid,
        branchRef: captured.branchRef,
        headOid: captured.headOid,
        bundleBase64: "",
      });
      yield* blobStore.writeLocal({
        kind: "wip",
        key: `${target.workspaceProjectId}/${environmentId}`,
        workspaceProjectId: target.workspaceProjectId,
        payload,
      });
      yield* Effect.logInfo("roaming timing: beacon-written", {
        workspaceProjectId: target.workspaceProjectId,
        commitOid: captured.commitOid,
      });
    }).pipe(
      // A lost beacon silently demotes delivery to the next interval tick
      // (~60-120s) — that must be loud, not debug-level.
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: freshness beacon write failed", {
          workspaceProjectId: target.workspaceProjectId,
          cause,
        }),
      ),
    );
    yield* renewLease({
      workspaceProjectId: target.workspaceProjectId,
      environmentId,
      lastSnapshotAt: capturedAt,
    });
    return {
      _tag: "done",
      nextMode: "origin-refs",
      entry: { ...entryBase, mode: "origin-refs", lastPushedAt: yield* nowIso },
    } as WipPassOutcome;
  }

  if (PERMISSION_STDERR.test(pushResult.stderr)) {
    yield* Effect.logInfo("roaming wip: origin refuses pushes, using bundle transport", {
      workspaceProjectId: target.workspaceProjectId,
    });
    const entry = yield* writeBundleBlob;
    return { _tag: "done", nextMode: "bundle", entry } as WipPassOutcome;
  }

  return {
    _tag: "done",
    nextMode: "origin-refs",
    entry: {
      ...entryBase,
      mode: "origin-refs",
      lastError: withOversize(`push failed: ${pushResult.stderr.trim().slice(0, 200)}`),
    },
  } as WipPassOutcome;
});
