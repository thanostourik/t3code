/**
 * WipSnapshotReactor - continuous WIP snapshots for roaming projects.
 *
 * Captures each enrolled project's dirty working tree onto
 * `refs/t3/wip/<workspaceProjectId>/<environmentId>` (WipSnapshots.ts) and
 * ships it: pushed to the project's primary remote by default, falling back
 * to a git bundle over the peer mirror (blob `kind=wip`) when the remote
 * refuses pushes. The WIP ref mirrors the worktree TREE even when clean -
 * that is what keeps a stale dirty snapshot from shadowing work the user has
 * since committed.
 *
 * Triggers: startup, a fixed interval, settings enabling, and
 * `thread.turn-diff-completed` domain events (post-turn, tree stable), all
 * coalesced per project. Gates on `roaming && roamingWipSync` per pass (the
 * VaultSync pattern). Push rights cannot be probed without pushing, so the
 * origin/bundle mode per project is a Ref re-probed each process start.
 */
import {
  CheckpointRef,
  EnvironmentId,
  ROAMING_WIP_BUNDLE_MAX_BYTES,
  RoamingVaultBundle,
  RoamingWipPayload,
  type RoamingWipStatusEntry,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import { applyVaultBundle, buildCandidatePaths, listTrackedCandidates } from "./VaultSync.ts";
import {
  captureWipSnapshot,
  resolveOid,
  wipAppliedMarkerRefName,
  wipPushedMarkerRefName,
  wipRefGlob,
  wipRefName,
  writeWorktreeTree,
} from "./WipSnapshots.ts";

const WIP_INTERVAL = Duration.minutes(2);

export type WipTransportMode = RoamingWipStatusEntry["mode"];

export interface WipTarget {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly workspaceRoot: string;
  readonly localProjectId: string;
}

export class WipSnapshotReactor extends Context.Service<
  WipSnapshotReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly snapshotProject: (workspaceProjectId: WorkspaceProjectId) => Effect.Effect<void>;
    readonly snapshotAll: () => Effect.Effect<void>;
    readonly listStatuses: () => Effect.Effect<ReadonlyArray<RoamingWipStatusEntry>>;
    readonly subscribeUpdates: Effect.Effect<
      PubSub.Subscription<RoamingWipStatusEntry>,
      never,
      Scope.Scope
    >;
  }
>()("t3/roaming/WipSnapshotReactor") {}

const encodeWipPayloadJson = Schema.encodeEffect(Schema.fromJsonString(RoamingWipPayload));

const PERMISSION_STDERR =
  /permission denied|403|forbidden|not authorized|access denied|read.?only|protected ref|pre-receive hook declined/i;

const LEASE_STDERR = /stale info|\[rejected\]|fetch first|failed to push some refs/i;

const inProgressOperationExists = (cwd: string) =>
  Effect.gen(function* () {
    for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
      if ((yield* resolveOid(cwd, marker)) !== null) {
        return true;
      }
    }
    return false;
  });

const isGitWorktree = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.isGitWorktree",
      cwd,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowNonZeroExit: true,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  });

/**
 * The vault subtraction set: pattern/override candidates that are untracked
 * (the same set vault capture would ship peer-to-peer). Fail-closed: when git
 * cannot tell tracked from untracked we skip the snapshot entirely rather
 * than risk pushing a secret to the origin host.
 */
const vaultExcludePathsFor = (target: WipTarget) =>
  Effect.gen(function* () {
    const candidates = yield* buildCandidatePaths(target.workspaceRoot, target.workspaceProjectId);
    const tracked = yield* listTrackedCandidates(target.workspaceRoot, candidates);
    if (tracked._tag === "unavailable") {
      return null;
    }
    return candidates.filter((path) => !tracked.paths.has(path));
  });

const decodeWipPayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingWipPayload));

/** Tree the current wip blob carries, or null (no blob / undecodable). */
const bundleTreeOid = (workspaceProjectId: WorkspaceProjectId, environmentId: string) =>
  Effect.gen(function* () {
    const blobStore = yield* RoamingBlobStore;
    const blob = yield* blobStore
      .get({ kind: "wip", key: `${workspaceProjectId}/${environmentId}` })
      .pipe(Effect.orElseSucceed(() => null));
    if (blob === null) {
      return null;
    }
    const payload = yield* decodeWipPayloadJson(blob.payload).pipe(
      Effect.orElseSucceed(() => null),
    );
    return payload?.treeOid ?? null;
  });

const primaryRemoteName = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.listRemoteNames",
      cwd,
      args: ["remote"],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const names = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return names.includes("origin") ? "origin" : (names[0] ?? null);
  });

export type WipPassOutcome =
  | { readonly _tag: "skipped" }
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

  const refName = yield* wipRefName(target.workspaceProjectId, environmentId);
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
  const markerTree = yield* resolveOid(cwd, `${markerRef}^{tree}`);
  const shippedTree =
    mode === "bundle" ? yield* bundleTreeOid(target.workspaceProjectId, environmentId) : markerTree;

  // Fast path: clean worktree whose HEAD tree is already the shipped tree.
  if (shippedTree !== null) {
    const status = yield* git.execute({
      operation: "WipSnapshotReactor.statusPorcelain",
      cwd,
      args: ["status", "--porcelain"],
    });
    if (status.stdout.trim().length === 0) {
      const headTree = yield* resolveOid(cwd, "HEAD^{tree}");
      if (headTree !== null && headTree === shippedTree) {
        return { _tag: "skipped" } as WipPassOutcome;
      }
    }
  }

  const captured = yield* captureWipSnapshot({
    cwd,
    workspaceProjectId: target.workspaceProjectId,
    environmentId,
    vaultExcludePaths: excludePaths,
    skipIfTreeOid: shippedTree,
  });
  if (captured === null) {
    return { _tag: "skipped" } as WipPassOutcome;
  }
  const capturedAt = yield* nowIso;

  const entryBase = {
    workspaceProjectId: target.workspaceProjectId,
    lastCapturedAt: capturedAt,
  };

  const remote = yield* primaryRemoteName(cwd);
  if (remote === null) {
    return {
      _tag: "done",
      nextMode: mode,
      entry: { ...entryBase, mode, lastError: "no git remote configured" },
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
          lastError: `bundle create failed: ${bundled.stderr.trim().slice(0, 200)}`,
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
          lastError: "wip bundle exceeds size cap",
        } satisfies RoamingWipStatusEntry;
      }
      // The origin→bundle flip captures before knowing the blob baseline:
      // skip the write when the blob already carries this exact tree.
      if ((yield* bundleTreeOid(target.workspaceProjectId, environmentId)) === captured.treeOid) {
        return { ...entryBase, mode: "bundle" } satisfies RoamingWipStatusEntry;
      }
      const content = yield* fs.readFile(bundlePath);
      const payload = yield* encodeWipPayloadJson({
        schemaVersion: 1,
        capturedAt,
        refName: captured.refName,
        commitOid: captured.commitOid,
        treeOid: captured.treeOid,
        bundleBase64: Buffer.from(content).toString("base64"),
      });
      yield* blobStore.writeLocal({
        kind: "wip",
        key: `${target.workspaceProjectId}/${environmentId}`,
        workspaceProjectId: target.workspaceProjectId,
        payload,
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
    yield* git.execute({
      operation: "WipSnapshotReactor.updateMarker",
      cwd,
      args: ["update-ref", markerRef, captured.commitOid],
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
      lastError: `push failed: ${pushResult.stderr.trim().slice(0, 200)}`,
    },
  } as WipPassOutcome;
});

const decodeVaultBundleJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingVaultBundle));

const committerUnix = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.committerUnix",
      cwd,
      args: ["show", "-s", "--format=%ct", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const unix = Number(result.stdout.trim());
    return Number.isFinite(unix) ? unix : null;
  });

export type WipApplyOutcome =
  | { readonly _tag: "skipped" }
  | { readonly _tag: "blocked"; readonly reason: string }
  | {
      readonly _tag: "applied";
      readonly fromEnvironmentId: EnvironmentId;
      readonly capturedAtIso: string;
    };

/**
 * The delivery half of WIP sync (M3.5): fetch the peers' snapshots and
 * fast-forward this checkout when that is provably safe. "Safe" = the
 * worktree carries no local edits — it matches HEAD's tree (untouched
 * checkout) or the tree of the snapshot we last auto-applied
 * (refs/t3/wip-applied/<wsid>). Anything else is local work: never touched,
 * surfaced as blocked (M5 owns the divergence flow). A snapshot older than
 * HEAD or than the last-applied snapshot never applies (a peer's stale echo
 * must not resurrect superseded state).
 */
export const runWipApplyForTarget = Effect.fn("WipSnapshotReactor.runWipApplyForTarget")(function* (
  target: WipTarget,
) {
  const git = yield* GitVcsDriver;
  const vcs = yield* VcsDriver;
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
    yield* git.execute({
      operation: "WipSnapshotReactor.fetchPeerWipRefs",
      cwd,
      args: ["fetch", remote, `+${glob}:${glob}`],
      allowNonZeroExit: true,
    });
  }
  const manifest = yield* blobStore.manifest().pipe(Effect.orElseSucceed(() => []));
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
    // Skip the import when the local ref already has this exact commit.
    if ((yield* resolveOid(cwd, payload.refName)) === payload.commitOid) {
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
      yield* git.execute({
        operation: "WipSnapshotReactor.fetchPeerWipBundle",
        cwd,
        args: ["fetch", bundlePath, `+${payload.refName}:${payload.refName}`],
        allowNonZeroExit: true,
      });
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
  const newest = [...candidates].sort((left, right) => right.unix - left.unix)[0]!;

  const excludePaths = yield* vaultExcludePathsFor(target);
  if (excludePaths === null) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  const { treeOid: worktreeTree } = yield* writeWorktreeTree({
    cwd,
    vaultExcludePaths: excludePaths,
  });
  const newestTree = yield* resolveOid(cwd, `${newest.refName}^{tree}`);
  if (newestTree === null || newestTree === worktreeTree) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  // Local-edit safety: the worktree must be provably free of its own work.
  const headTree = yield* resolveOid(cwd, "HEAD^{tree}");
  const appliedTree = yield* resolveOid(cwd, `${appliedMarker}^{tree}`);
  if (worktreeTree !== headTree && (appliedTree === null || worktreeTree !== appliedTree)) {
    return {
      _tag: "blocked",
      reason: "local changes present; newer work from the other machine not applied",
    } as WipApplyOutcome;
  }

  // Staleness: never resurrect state older than what this checkout has.
  const newestUnix = newest.unix;
  const headUnix = yield* committerUnix(cwd, "HEAD");
  const appliedUnix = appliedTree === null ? null : yield* committerUnix(cwd, appliedMarker);
  if (
    (headUnix !== null && newestUnix <= headUnix) ||
    (appliedUnix !== null && newestUnix <= appliedUnix)
  ) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  const checkpoints = vcs.checkpoints;
  if (checkpoints === undefined) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }
  const restored = yield* checkpoints
    .restoreCheckpoint({ cwd, checkpointRef: CheckpointRef.make(newest.refName) })
    .pipe(Effect.orElseSucceed(() => false));
  if (!restored) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  // Restore's `git clean -fd` removes untracked non-ignored files that are
  // not in the snapshot — which is exactly where vault include-overrides
  // live. Re-apply the local vault copy so no secret is lost.
  const vaultBlob = yield* blobStore
    .get({ kind: "vault", key: target.workspaceProjectId })
    .pipe(Effect.orElseSucceed(() => null));
  if (vaultBlob !== null) {
    const bundle = yield* decodeVaultBundleJson(vaultBlob.payload).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (bundle !== null) {
      yield* applyVaultBundle({ workspaceRoot: cwd, bundle, overwrite: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("roaming wip: vault re-apply after auto-apply failed", { cause }),
        ),
      );
    }
  }

  const newestCommit = yield* resolveOid(cwd, newest.refName);
  if (newestCommit !== null) {
    yield* git.execute({
      operation: "WipSnapshotReactor.updateAppliedMarker",
      cwd,
      args: ["update-ref", appliedMarker, newestCommit],
    });
  }
  const fromEnvironmentId = EnvironmentId.make(newest.refName.split("/").pop() ?? "unknown");
  yield* Effect.logInfo("roaming wip: applied newer snapshot from peer", {
    workspaceProjectId: target.workspaceProjectId,
    fromEnvironmentId,
    capturedAt: newest.iso,
  });
  return {
    _tag: "applied",
    fromEnvironmentId,
    capturedAtIso: newest.iso,
  } as WipApplyOutcome;
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const git = yield* GitVcsDriver;
  const blobStore = yield* RoamingBlobStore;
  const projectRepository = yield* ProjectionProjectRepository;
  const threadRepository = yield* ProjectionThreadRepository;
  const serverSettings = yield* ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const statuses = yield* Ref.make(new Map<WorkspaceProjectId, RoamingWipStatusEntry>());
  const modes = yield* Ref.make(new Map<WorkspaceProjectId, WipTransportMode>());
  const updates = yield* PubSub.unbounded<RoamingWipStatusEntry>();

  const vcs = yield* VcsDriver;
  const providePassDeps = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | GitVcsDriver
      | VcsDriver
      | RoamingBlobStore
      | FileSystem.FileSystem
      | Path.Path
      | ServerEnvironment.ServerEnvironment
    >,
  ) =>
    effect.pipe(
      Effect.provideService(GitVcsDriver, git),
      Effect.provideService(VcsDriver, vcs),
      Effect.provideService(RoamingBlobStore, blobStore),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
    );

  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.roaming && settings.roamingWipSync),
    Effect.catch((cause) =>
      Effect.logWarning("roaming wip: failed to read settings", { cause }).pipe(Effect.as(false)),
    ),
  );

  const listTargets = Effect.gen(function* () {
    const projects = yield* projectRepository
      .listAll()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming wip: failed to list projects", { cause }).pipe(Effect.as([])),
        ),
      );
    const targets: WipTarget[] = [];
    for (const project of projects) {
      if (project.deletedAt !== null || project.workspaceProjectId === null) {
        continue;
      }
      const stat = yield* fs.stat(project.workspaceRoot).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "Directory") {
        continue;
      }
      targets.push({
        workspaceProjectId: project.workspaceProjectId,
        workspaceRoot: project.workspaceRoot,
        localProjectId: project.projectId,
      });
    }
    return targets;
  });

  const publishEntry = (entry: RoamingWipStatusEntry) =>
    Ref.update(statuses, (map) => new Map(map).set(entry.workspaceProjectId, entry)).pipe(
      Effect.andThen(PubSub.publish(updates, entry)),
      Effect.asVoid,
    );

  const processTarget = (target: WipTarget) =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) {
        return;
      }
      const mode =
        (yield* Ref.get(modes)).get(target.workspaceProjectId) ?? ("origin-refs" as const);
      // Capture before apply: local edits are always snapshotted before the
      // tree is ever considered for a peer fast-forward.
      const outcome = yield* providePassDeps(runWipPassForTarget(target, mode));
      if (outcome._tag === "done") {
        yield* Ref.update(modes, (map) =>
          new Map(map).set(target.workspaceProjectId, outcome.nextMode),
        );
      }
      const applied = yield* providePassDeps(runWipApplyForTarget(target));
      const base =
        outcome._tag === "done"
          ? outcome.entry
          : ((yield* Ref.get(statuses)).get(target.workspaceProjectId) ?? {
              workspaceProjectId: target.workspaceProjectId,
              mode,
            });
      const entry =
        applied._tag === "applied"
          ? {
              ...base,
              lastAppliedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
              lastAppliedFrom: applied.fromEnvironmentId,
            }
          : base;
      if (outcome._tag === "done" || applied._tag === "applied") {
        yield* publishEntry(entry);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: snapshot pass failed", {
          workspaceProjectId: target.workspaceProjectId,
          cause,
        }),
      ),
    );

  const worker = yield* makeKeyedCoalescingWorker<WorkspaceProjectId, WipTarget, never, never>({
    merge: (_current, next) => next,
    process: (_workspaceProjectId, target) => processTarget(target).pipe(Effect.asVoid),
  });

  const pruneStatuses = (targets: ReadonlyArray<WipTarget>) =>
    Effect.gen(function* () {
      const keep = new Set(targets.map((target) => target.workspaceProjectId));
      yield* Ref.update(statuses, (map) => {
        const next = new Map(map);
        for (const key of next.keys()) {
          if (!keep.has(key)) {
            next.delete(key);
          }
        }
        return next;
      });
    });

  const snapshotAll: WipSnapshotReactor["Service"]["snapshotAll"] = () =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? listTargets.pipe(
              Effect.tap(pruneStatuses),
              Effect.flatMap((targets) =>
                Effect.forEach(
                  targets,
                  (target) => worker.enqueue(target.workspaceProjectId, target),
                  { discard: true },
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("roaming wip: full scan failed", { cause })),
    );

  const snapshotProject: WipSnapshotReactor["Service"]["snapshotProject"] = (workspaceProjectId) =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? listTargets.pipe(
              Effect.flatMap((targets) => {
                const target = targets.find(
                  (candidate) => candidate.workspaceProjectId === workspaceProjectId,
                );
                return target === undefined
                  ? Effect.void
                  : worker.enqueue(target.workspaceProjectId, target);
              }),
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: project scan failed", { cause }),
      ),
    );

  // Gated like the snapshot field's contract: no stale entries after the
  // user turns WIP sync off (the roaming flag itself is handled at the ws
  // merge point).
  const listStatuses: WipSnapshotReactor["Service"]["listStatuses"] = () =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? Ref.get(statuses).pipe(
              Effect.map((map) =>
                [...map.values()].sort((left, right) =>
                  left.workspaceProjectId.localeCompare(right.workspaceProjectId),
                ),
              ),
            )
          : Effect.succeed([]),
      ),
    );

  const start: WipSnapshotReactor["Service"]["start"] = () =>
    Effect.gen(function* () {
      // Interval trigger (also covers the startup scan).
      yield* Effect.forkScoped(
        Effect.forever(snapshotAll().pipe(Effect.andThen(Effect.sleep(WIP_INTERVAL)))),
      );
      // Settings enabling triggers a scan so consent takes effect
      // immediately; disabling drops the retained statuses.
      yield* Effect.forkScoped(
        serverSettings.streamChanges.pipe(
          Stream.runForEach((settings) =>
            settings.roaming && settings.roamingWipSync
              ? snapshotAll()
              : Ref.set(statuses, new Map()),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      );
      // Turn completion: snapshot just that project, post-checkpoint.
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          Effect.gen(function* () {
            if (event.type !== "thread.turn-diff-completed") {
              return;
            }
            const thread = yield* threadRepository
              .getById({ threadId: event.payload.threadId })
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isNone(thread)) {
              return;
            }
            const targets = yield* listTargets;
            const target = targets.find(
              (candidate) => candidate.localProjectId === thread.value.projectId,
            );
            if (target !== undefined) {
              // Enqueue directly — processTarget re-checks the settings gate.
              yield* worker.enqueue(target.workspaceProjectId, target);
            }
          }),
        ).pipe(Effect.ignoreCause({ log: true })),
      );
    });

  return {
    start,
    snapshotProject,
    snapshotAll,
    listStatuses,
    subscribeUpdates: PubSub.subscribe(updates),
  } satisfies WipSnapshotReactor["Service"];
});

export const layer = Layer.effect(WipSnapshotReactor, make);
