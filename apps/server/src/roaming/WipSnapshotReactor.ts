// @effect-diagnostics nodeBuiltinImport:off
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
  EnvironmentId,
  ROAMING_WIP_BUNDLE_MAX_BYTES,
  ROAMING_WIP_MAX_FILE_BYTES,
  RoamingWipPayload,
  type RoamingWipStatusEntry,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import { buildCandidatePaths, listTrackedCandidates } from "./VaultSync.ts";
import {
  COMMIT_ENV_IDENTITY,
  captureWipSnapshot,
  readBasedOn,
  resolveOid,
  wipAppliedMarkerRefName,
  wipPushedMarkerRefName,
  wipRefGlob,
  wipRefName,
  writeWorktreeTree,
} from "./WipSnapshots.ts";

const WIP_INTERVAL = Duration.minutes(2);
const WATCH_DEBOUNCE = Duration.seconds(5);
const SHUTDOWN_SNAPSHOT_TIMEOUT = Duration.seconds(10);

const WATCH_NOISE = /(^|\/)(\.git|node_modules|dist|build|target|out|\.venv|__pycache__)(\/|$)/;

/**
 * Recursive filesystem events for a project root (the Dropbox model: watch,
 * debounce, ship). Effect's FileSystem.watch is single-directory, so this
 * wraps node's recursive fs.watch (Linux ≥ Node 20 / macOS); on platforms
 * without recursive support the stream ends and the interval sweep remains
 * the only trigger. .git and node_modules churn is filtered at the source.
 */
const watchTreeEvents = (root: string): Stream.Stream<string> =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        try {
          const watcher = NodeFS.watch(root, { recursive: true }, (_event, fileName) => {
            const relative = fileName?.toString() ?? "";
            if (!WATCH_NOISE.test(relative)) {
              Queue.offerUnsafe(queue, relative);
            }
          });
          watcher.on("error", () => Queue.endUnsafe(queue));
          return watcher;
        } catch {
          Queue.endUnsafe(queue);
          return null;
        }
      }),
      (watcher) =>
        Effect.sync(() => {
          watcher?.close();
        }),
    ),
  );

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

const decodeWipPayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingWipPayload));

/** Tree the current wip blob carries, or null (no blob / undecodable). */
const bundleShipped = (workspaceProjectId: WorkspaceProjectId, environmentId: string) =>
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
    return payload === null
      ? null
      : { treeOid: payload.treeOid, commitOid: payload.commitOid, capturedAt: payload.capturedAt };
  });

/** Committer date of a commit-ish as ISO, or null when it does not resolve. */
const commitDateIso = (cwd: string, spec: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const result = yield* git.execute({
      operation: "WipSnapshotReactor.markerCommitDate",
      cwd,
      args: ["show", "-s", "--format=%cI", spec],
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * First pass after boot: the in-memory statuses start empty, but the repo's
 * markers durably record when this checkout last synced — the pushed marker's
 * commit date (the wip blob's capturedAt in bundle mode) and the applied
 * marker's commit date. Seed missing activity timestamps from them so a
 * relaunch shows "Synced <ago>" instead of an amnesiac "Sync on" until the
 * next real edit (field bug 2026-07-10).
 */
const seedActivityFromMarkers = Effect.fn("WipSnapshotReactor.seedActivityFromMarkers")(function* (
  target: WipTarget,
  entry: RoamingWipStatusEntry,
  mode: WipTransportMode,
) {
  if (entry.lastPushedAt !== undefined && entry.lastAppliedAt !== undefined) {
    return entry;
  }
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const cwd = target.workspaceRoot;
  let lastPushedAt = entry.lastPushedAt;
  if (lastPushedAt === undefined) {
    lastPushedAt =
      mode === "bundle"
        ? ((yield* bundleShipped(target.workspaceProjectId, environmentId))?.capturedAt ??
          undefined)
        : ((yield* commitDateIso(
            cwd,
            yield* wipPushedMarkerRefName(target.workspaceProjectId, environmentId),
          )) ?? undefined);
  }
  let lastAppliedAt = entry.lastAppliedAt;
  if (lastAppliedAt === undefined) {
    lastAppliedAt =
      (yield* commitDateIso(cwd, yield* wipAppliedMarkerRefName(target.workspaceProjectId))) ??
      undefined;
  }
  return {
    ...entry,
    ...(lastPushedAt !== undefined ? { lastPushedAt } : {}),
    ...(lastAppliedAt !== undefined ? { lastAppliedAt } : {}),
  } satisfies RoamingWipStatusEntry;
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
  const shippedBundle =
    mode === "bundle" ? yield* bundleShipped(target.workspaceProjectId, environmentId) : null;
  const shippedTree = mode === "bundle" ? (shippedBundle?.treeOid ?? null) : markerTree;
  // An identical tree may still NEED to ship: if the applied marker moved
  // since the last ship (we consumed a peer snapshot), the fresh snapshot's
  // Based-On is the only signal telling the peer "this is still my tree
  // AFTER seeing yours". Without it, a delete that returns the tree to a
  // previously-shipped state (receiver-side delete of a peer-authored file)
  // dedupes into silence and never reaches the author (field bug
  // 2026-07-10). Two no-op baselines remain:
  //  - the shipped tree, while the applied marker still equals the shipped
  //    snapshot's Based-On (a true nothing-happened pass), and
  //  - the applied marker's own tree: our state IS the peer state we just
  //    consumed, so a re-ship says nothing — this is also what stops two
  //    idle machines from ACKing each other's ACKs forever.
  const shippedCommitSpec =
    mode === "bundle" ? (shippedBundle?.commitOid ?? null) : markerTree === null ? null : markerRef;
  const appliedMarkerRef = yield* wipAppliedMarkerRefName(target.workspaceProjectId);
  const appliedNow = yield* resolveOid(cwd, appliedMarkerRef);
  const appliedTree =
    appliedNow === null ? null : yield* resolveOid(cwd, `${appliedMarkerRef}^{tree}`);
  const shippedBasedOn =
    shippedCommitSpec === null ? null : yield* readBasedOn(cwd, shippedCommitSpec);
  const noOpTrees = [
    ...(shippedTree !== null && appliedNow === shippedBasedOn ? [shippedTree] : []),
    ...(appliedTree !== null ? [appliedTree] : []),
  ];

  // Fast path: clean worktree whose HEAD tree is already a no-op baseline.
  if (noOpTrees.length > 0) {
    const status = yield* git.execute({
      operation: "WipSnapshotReactor.statusPorcelain",
      cwd,
      args: ["status", "--porcelain"],
    });
    if (status.stdout.trim().length === 0) {
      const headTree = yield* resolveOid(cwd, "HEAD^{tree}");
      if (headTree !== null && noOpTrees.includes(headTree)) {
        return { _tag: "skipped" } as WipPassOutcome;
      }
    }
  }

  const captured = yield* captureWipSnapshot({
    cwd,
    workspaceProjectId: target.workspaceProjectId,
    environmentId,
    vaultExcludePaths: captureExcludePaths,
    skipIfTreeOids: noOpTrees,
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
      // skip the write when the blob already carries this exact tree.
      const shippedBlob = yield* bundleShipped(target.workspaceProjectId, environmentId);
      if (shippedBlob?.treeOid === captured.treeOid) {
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
    // Freshness beacon: an empty-bundle wip blob rides the mirror (which
    // pushes on every local blob write), so the peer learns "fetch my
    // origin ref" within seconds instead of on its next interval tick.
    yield* Effect.gen(function* () {
      const blobStore = yield* RoamingBlobStore;
      const payload = yield* encodeWipPayloadJson({
        schemaVersion: 1,
        capturedAt,
        refName: captured.refName,
        commitOid: captured.commitOid,
        treeOid: captured.treeOid,
        bundleBase64: "",
      });
      yield* blobStore.writeLocal({
        kind: "wip",
        key: `${target.workspaceProjectId}/${environmentId}`,
        workspaceProjectId: target.workspaceProjectId,
        payload,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("roaming wip: freshness beacon write failed", { cause }),
      ),
    );
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
  const newestUnix = newest.unix;
  const headUnix = yield* committerUnix(cwd, "HEAD");
  const appliedUnix =
    (yield* resolveOid(cwd, appliedMarker)) === null
      ? null
      : yield* committerUnix(cwd, appliedMarker);

  const newestTree = yield* resolveOid(cwd, `${newest.refName}^{tree}`);
  if (newestTree === null || newestTree === worktreeTree) {
    // Peer state == our worktree: reconciled by definition — RECORD that in
    // the applied marker (monotonically) before skipping. The old bare skip
    // left the author's marker forever empty while its own echoes bounced
    // back, so a later peer deletion of a file this machine authored produced
    // no diff against HEAD and never propagated (field bug 2026-07-10:
    // a receiver-side delete never reached the author).
    if (newestTree !== null && (appliedUnix === null || newestUnix > appliedUnix)) {
      const echoCommit = yield* resolveOid(cwd, newest.refName);
      if (echoCommit !== null) {
        yield* git.execute({
          operation: "WipSnapshotReactor.updateAppliedMarker",
          cwd,
          args: ["update-ref", appliedMarker, echoCommit],
        });
      }
    }
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  // Staleness: never resurrect state older than what this checkout has
  // (an offline peer's stale echo must not undo a commit made here since).
  if (
    (headUnix !== null && newestUnix <= headUnix) ||
    (appliedUnix !== null && newestUnix <= appliedUnix)
  ) {
    return { _tag: "skipped" } as WipApplyOutcome;
  }

  // PER-FILE MERGE (M3.7 — replaces the whole-tree restore that blocked on
  // ANY local edit, so nothing ever crossed when both machines were being
  // worked on). Apply exactly the files the peer changed relative to its
  // own HEAD (= the shared base while neither side has committed), and only
  // where THIS machine has not modified that same file. A new/updated file
  // lands even while local edits exist on OTHER files; a file both sides
  // changed is left as ours and surfaced as a conflict. Same safety
  // contract as the vault delivery that already works both ways.
  // Base = the state we last synced FROM the peer (the applied marker), else
  // our own HEAD, else the empty tree. Both "which files the peer changed"
  // and "did WE touch this file" are measured against it — so a file whose
  // current content equals the base is one we have not modified since the
  // last sync (even if that content itself came from a prior peer apply).
  const base =
    (yield* resolveOid(cwd, appliedMarker)) ?? (yield* resolveOid(cwd, "HEAD")) ?? EMPTY_TREE_OID;
  // Our last-shipped snapshot: knows about files we authored (the applied
  // marker doesn't). Passed in from the reactor as the PRE-capture value;
  // direct callers get the current pushed marker.
  const shippedBase =
    shippedBaseOid !== undefined
      ? shippedBaseOid
      : yield* resolveOid(
          cwd,
          yield* wipPushedMarkerRefName(target.workspaceProjectId, environmentId),
        );
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
  const basedOnOid = shippedOnlyDeletes.size === 0 ? null : yield* readBasedOn(cwd, newest.refName);

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
      const seenByPeer =
        basedOnOid === null ? null : yield* resolveOid(cwd, `${basedOnOid}:${relativePath}`);
      if (seenByPeer === null) {
        continue;
      }
    }
    const peerOid = yield* resolveOid(cwd, `${newest.refName}:${relativePath}`); // null = deleted by peer
    // Last-synced version: the applied-marker's copy, else what WE last shipped
    // (shippedBase). The fallback is what stops a locally-created file we then
    // deleted from looking "untouched" and being re-added from the peer.
    const markerBaseOid = yield* resolveOid(cwd, `${base}:${relativePath}`);
    const baseOid =
      markerBaseOid ??
      (shippedBase === null ? null : yield* resolveOid(cwd, `${shippedBase}:${relativePath}`));
    const baseSourceTree = baseOid === null ? null : markerBaseOid !== null ? base : shippedBase;
    const ourOid = yield* hashWorking(relativePath); // null = absent locally

    if (ourOid === peerOid) {
      continue; // already at the peer's state (same content, or deleted on both)
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
  const newestCommit = yield* resolveOid(cwd, newest.refName);
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

  const fromEnvironmentId = EnvironmentId.make(newest.refName.split("/").pop() ?? "unknown");
  if (conflicts.length > 0) {
    yield* Effect.logInfo("roaming wip: applied peer changes with conflicts held back", {
      workspaceProjectId: target.workspaceProjectId,
      fromEnvironmentId,
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
    applied: applied.length,
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
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const statuses = yield* Ref.make(new Map<WorkspaceProjectId, RoamingWipStatusEntry>());
  const modes = yield* Ref.make(new Map<WorkspaceProjectId, WipTransportMode>());
  const updates = yield* PubSub.unbounded<RoamingWipStatusEntry>();

  const vcs = yield* VcsDriver;
  const serverConfig = yield* ServerConfig.ServerConfig;
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
      | ServerConfig.ServerConfig
    >,
  ) =>
    effect.pipe(
      Effect.provideService(GitVcsDriver, git),
      Effect.provideService(VcsDriver, vcs),
      Effect.provideService(RoamingBlobStore, blobStore),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
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
      // The commit we last shipped, read BEFORE capture overwrites the pushed
      // marker with this pass's snapshot — so apply can tell a locally-created
      // file we just deleted from a genuinely new peer file (the delete flap).
      const shippedBaseOid = yield* providePassDeps(
        wipPushedMarkerRefName(target.workspaceProjectId, environmentId).pipe(
          Effect.flatMap((ref) => resolveOid(target.workspaceRoot, ref)),
        ),
      );
      // Capture before apply: local edits are always snapshotted before the
      // tree is ever considered for a peer fast-forward.
      const outcome = yield* providePassDeps(runWipPassForTarget(target, mode));
      if (outcome._tag === "done") {
        yield* Ref.update(modes, (map) =>
          new Map(map).set(target.workspaceProjectId, outcome.nextMode),
        );
      }
      const applied = yield* providePassDeps(runWipApplyForTarget(target, shippedBaseOid));
      const previous = (yield* Ref.get(statuses)).get(target.workspaceProjectId);
      const base =
        outcome._tag === "done"
          ? outcome.entry
          : (previous ?? {
              workspaceProjectId: target.workspaceProjectId,
              mode,
            });
      // blockedReason reflects THIS pass only: set on blocked, cleared on
      // anything else (a stale "blocked" after the user commits would lie).
      const { blockedReason: _stale, ...baseWithoutBlocked } = base;
      const withWarning: RoamingWipStatusEntry =
        outcome._tag === "skipped" && outcome.warning !== undefined
          ? { ...baseWithoutBlocked, lastError: outcome.warning }
          : baseWithoutBlocked;
      const nowIso = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const entry: RoamingWipStatusEntry =
        applied._tag === "applied"
          ? { ...withWarning, lastAppliedAt: nowIso, lastAppliedFrom: applied.fromEnvironmentId }
          : applied._tag === "applied-with-conflicts"
            ? {
                ...withWarning,
                lastAppliedAt: nowIso,
                lastAppliedFrom: applied.fromEnvironmentId,
                blockedReason: `changed on both machines, kept yours: ${applied.conflicts
                  .slice(0, 3)
                  .join(
                    ", ",
                  )}${applied.conflicts.length > 3 ? ` and ${applied.conflicts.length - 3} more` : ""}`,
              }
            : applied._tag === "blocked"
              ? { ...withWarning, blockedReason: applied.reason }
              : withWarning;
      const seeded =
        previous === undefined
          ? yield* providePassDeps(seedActivityFromMarkers(target, entry, mode))
          : entry;
      if (
        // A project's FIRST pass always publishes, even when fully skipped
        // (clean tree, nothing to apply): the sidebar pill renders only for
        // projects that HAVE a status entry, so without this baseline a
        // fresh pairing on a clean checkout shows no sync indication at all
        // (2026-07-09 field bug — the "Sync on" idle state was unreachable).
        previous === undefined ||
        outcome._tag === "done" ||
        applied._tag === "applied" ||
        applied._tag === "applied-with-conflicts" ||
        applied._tag === "blocked" ||
        (outcome._tag === "skipped" && outcome.warning !== undefined) ||
        previous.blockedReason !== seeded.blockedReason
      ) {
        yield* publishEntry(seeded);
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

  const watcherScopes = yield* Ref.make(new Map<WorkspaceProjectId, Scope.Scope>());

  const closeWatcher = (workspaceProjectId: WorkspaceProjectId) =>
    Ref.modify(watcherScopes, (scopes) => {
      const scope = scopes.get(workspaceProjectId);
      const next = new Map(scopes);
      next.delete(workspaceProjectId);
      return [scope, next] as const;
    }).pipe(
      Effect.flatMap((scope) =>
        scope === undefined ? Effect.void : Scope.close(scope, Exit.void).pipe(Effect.asVoid),
      ),
    );

  const closeAllWatchers = Ref.modify(
    watcherScopes,
    (scopes) => [[...scopes.values()], new Map<WorkspaceProjectId, Scope.Scope>()] as const,
  ).pipe(
    Effect.flatMap((scopes) =>
      Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true }),
    ),
  );

  // Watch → debounce → enqueue: capture latency drops from the interval tick
  // to seconds after the last write (the interval stays as the fallback
  // sweep). Swap scopes atomically — the VaultSync watcher lesson.
  const installWatcher = (target: WipTarget) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const previous = yield* Ref.modify(watcherScopes, (scopes) => {
        const old = scopes.get(target.workspaceProjectId);
        const next = new Map(scopes);
        next.set(target.workspaceProjectId, scope);
        return [old, next] as const;
      });
      if (previous !== undefined) {
        yield* Scope.close(previous, Exit.void);
      }
      yield* Stream.runForEach(
        watchTreeEvents(target.workspaceRoot).pipe(Stream.debounce(WATCH_DEBOUNCE)),
        () => worker.enqueue(target.workspaceProjectId, target),
      ).pipe(
        Effect.ignoreCause({ log: true }),
        // A watcher whose stream ends (error, unsupported platform) evicts
        // itself so the next scan re-installs instead of trusting a corpse.
        Effect.ensuring(
          Ref.update(watcherScopes, (scopes) => {
            if (scopes.get(target.workspaceProjectId) !== scope) {
              return scopes;
            }
            const next = new Map(scopes);
            next.delete(target.workspaceProjectId);
            return next;
          }),
        ),
        Effect.forkIn(scope),
      );
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
                Effect.gen(function* () {
                  const keep = new Set(targets.map((target) => target.workspaceProjectId));
                  const watched = yield* Ref.get(watcherScopes);
                  for (const workspaceProjectId of watched.keys()) {
                    if (!keep.has(workspaceProjectId)) {
                      yield* closeWatcher(workspaceProjectId);
                    }
                  }
                  yield* Effect.forEach(
                    targets,
                    (target) =>
                      Effect.gen(function* () {
                        if (!watched.has(target.workspaceProjectId)) {
                          yield* installWatcher(target);
                        }
                        yield* worker.enqueue(target.workspaceProjectId, target);
                      }),
                    { discard: true },
                  );
                }),
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
      // Graceful shutdown: one last bounded capture+ship per project — the
      // close-the-laptop-and-leave case must not lose the final minutes.
      yield* Effect.addFinalizer(() =>
        isEnabled.pipe(
          Effect.flatMap((enabled) =>
            enabled
              ? listTargets.pipe(
                  Effect.flatMap((targets) =>
                    Effect.forEach(
                      targets,
                      (target) =>
                        Effect.gen(function* () {
                          const mode =
                            (yield* Ref.get(modes)).get(target.workspaceProjectId) ??
                            ("origin-refs" as const);
                          yield* providePassDeps(runWipPassForTarget(target, mode)).pipe(
                            Effect.timeout(SHUTDOWN_SNAPSHOT_TIMEOUT),
                          );
                        }).pipe(Effect.ignore),
                      // Concurrent: N projects must not stack N×10s of
                      // shutdown delay — SIGKILL arrives first and the tail
                      // of the list would lose its final snapshot.
                      { concurrency: 4, discard: true },
                    ),
                  ),
                )
              : Effect.void,
          ),
          Effect.catchCause(() => Effect.void),
        ),
      );
      yield* Effect.addFinalizer(() => closeAllWatchers);
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
              : Ref.set(statuses, new Map()).pipe(Effect.andThen(closeAllWatchers)),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      );
      // A peer's wip blob (bundle or beacon) arriving over the mirror means
      // fresh work exists NOW — run that project's pass instead of waiting
      // for the interval.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const ownEnvironmentId = yield* serverEnvironment.getEnvironmentId;
          const changes = yield* blobStore.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(changes).pipe(
              Effect.flatMap((record) =>
                record.kind === "wip" &&
                !record.key.endsWith(`/${ownEnvironmentId}`) &&
                record.authorEnvironmentId !== ownEnvironmentId
                  ? snapshotProject(record.workspaceProjectId)
                  : Effect.void,
              ),
            ),
          );
        }),
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
