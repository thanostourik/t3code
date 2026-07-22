/**
 * WipSnapshotReactor - continuous WIP snapshots for roaming projects.
 *
 * The reactor is the wiring: triggers (startup, interval, fs watch via
 * treeWatcher.ts, branch/HEAD poll, settings enabling, turn completion,
 * wip-blob arrival, enrollment, graceful shutdown), per-project coalescing,
 * transport-mode memory, and status bookkeeping. The work happens in
 * WipCapture.ts (snapshot + origin push / bundle fallback + beacon) and
 * WipApply.ts (classify + reproduce-or-block + per-file merge + parking);
 * shared helpers live in WipShared.ts. Gates on `hasPeers && roamingWipSync`
 * per pass (the VaultSync pattern). Push rights cannot be probed without
 * pushing, so the origin/bundle mode per project is a Ref re-probed each
 * process start.
 */
import {
  type ProjectId,
  type RoamingWipDivergence,
  type RoamingWipStatusEntry,
  type WorkspaceProjectId,
} from "@t3tools/contracts";

import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { RoamingPeers } from "./RoamingPeers.ts";
import { VaultSync } from "./VaultSync.ts";
import { watchTreeEvents } from "./treeWatcher.ts";
import {
  getWipDivergenceForTarget,
  resolveKeptLocalDivergence,
  restoreParkedWipForTarget,
  runWipApplyForTarget,
} from "./WipApply.ts";
import { runWipPassForTarget } from "./WipCapture.ts";
import { renewLease } from "./WipLease.ts";
import { bundleShipped, type WipTarget, type WipTransportMode } from "./WipShared.ts";
import {
  resolveOid,
  wipAppliedMarkerRefName,
  wipParkedRefName,
  wipPushedMarkerRefName,
} from "./WipSnapshots.ts";

const WIP_INTERVAL = Duration.minutes(2);
const GIT_CONTEXT_INTERVAL = Duration.seconds(10);
const WATCH_DEBOUNCE = Duration.seconds(5);
const SHUTDOWN_SNAPSHOT_TIMEOUT = Duration.seconds(10);

// Fallback pacing when a watch cannot exist: capture sweeps every 10s (NOT
// the 2-minute interval — that cliff is the M3.7 defect), and a real watch
// is re-attempted after 30 ticks (~5 min) in case budget freed up.
const WATCH_FALLBACK_SWEEP = Duration.seconds(10);
const WATCH_REINSTALL_TICKS = 30;
// A watch stream that stays alive this long is considered healthy and the
// degraded notice is withdrawn.
const WATCH_HEALTHY_AFTER = Duration.seconds(30);
const WATCH_FALLBACK_NOTICE =
  "File watching is unavailable on this system right now — changes sync every 10 seconds instead of instantly";

export class WipSnapshotReactor extends Context.Service<
  WipSnapshotReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly snapshotProject: (workspaceProjectId: WorkspaceProjectId) => Effect.Effect<void>;
    readonly takeover: (
      workspaceProjectId: WorkspaceProjectId,
      /** Pin: refuse when the newest snapshot is not the one the user saw. */
      snapshotOid?: string,
    ) => Effect.Effect<{ readonly applied: boolean; readonly reason?: string }>;
    readonly divergence: (
      workspaceProjectId: WorkspaceProjectId,
    ) => Effect.Effect<RoamingWipDivergence | null>;
    readonly resolveDivergence: (
      workspaceProjectId: WorkspaceProjectId,
      pick: "local" | "peer",
      peerSnapshotOid: string,
    ) => Effect.Effect<{
      readonly resolved: boolean;
      readonly preservedRef?: string;
      readonly reason?: string;
    }>;
    readonly snapshotAll: () => Effect.Effect<void>;
    readonly listStatuses: () => Effect.Effect<ReadonlyArray<RoamingWipStatusEntry>>;
    readonly subscribeUpdates: Effect.Effect<
      PubSub.Subscription<RoamingWipStatusEntry>,
      never,
      Scope.Scope
    >;
  }
>()("t3/roaming/WipSnapshotReactor") {}

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

/**
 * Strip every blocked-state field (S6): blockedReason and its satellites are
 * one unit — a field added in one strip site and forgotten in the other was
 * a standing bug class.
 */
const clearBlockedFields = (
  entry: RoamingWipStatusEntry,
): Omit<
  RoamingWipStatusEntry,
  | "blockedReason"
  | "takeoverAvailable"
  | "blockedSnapshotOid"
  | "blockedFrom"
  | "divergenceAvailable"
> => {
  const {
    blockedReason: _blockedReason,
    takeoverAvailable: _takeoverAvailable,
    blockedSnapshotOid: _blockedSnapshotOid,
    blockedFrom: _blockedFrom,
    divergenceAvailable: _divergenceAvailable,
    ...rest
  } = entry;
  return rest;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const git = yield* GitVcsDriver;
  const blobStore = yield* RoamingBlobStore;
  const projectRepository = yield* ProjectionProjectRepository;
  const threadRepository = yield* ProjectionThreadRepository;
  const serverSettings = yield* ServerSettingsService;
  const peers = yield* RoamingPeers;
  const vaultSync = yield* VaultSync;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const hostPlatform = yield* HostProcessPlatform;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const statuses = yield* Ref.make(new Map<WorkspaceProjectId, RoamingWipStatusEntry>());
  const modes = yield* Ref.make(new Map<WorkspaceProjectId, WipTransportMode>());
  const gitContexts = yield* Ref.make(new Map<WorkspaceProjectId, string>());
  const pendingParkedRestores = yield* Ref.make(new Set<WorkspaceProjectId>());
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

  const isEnabled = Effect.gen(function* () {
    if (!(yield* peers.roamingEnabled)) {
      return false;
    }
    const settings = yield* serverSettings.getSettings;
    return settings.roamingWipSync;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("roaming wip: failed to read settings", { cause }).pipe(Effect.as(false)),
    ),
  );

  const readGitContext = (target: WipTarget) =>
    Effect.gen(function* () {
      const branch = yield* git.execute({
        operation: "WipSnapshotReactor.recordBranch",
        cwd: target.workspaceRoot,
        args: ["symbolic-ref", "-q", "HEAD"],
        allowNonZeroExit: true,
      });
      const headOid = yield* providePassDeps(resolveOid(target.workspaceRoot, "HEAD"));
      return `${branch.exitCode === 0 ? branch.stdout.trim() : "detached"}\0${headOid ?? "unborn"}`;
    });

  const recordGitContext = (target: WipTarget) =>
    Effect.gen(function* () {
      const context = yield* readGitContext(target);
      yield* Ref.update(gitContexts, (contexts) =>
        new Map(contexts).set(target.workspaceProjectId, context),
      );
    });

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

  // Degraded-watch advisories, merged into every published status entry so
  // a pass cannot wipe them (the notice outlives individual passes).
  const watchNotices = yield* Ref.make(new Map<WorkspaceProjectId, string>());

  const setWatchNotice = (target: WipTarget, message: string | null) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(watchNotices, (map) => {
        if ((map.get(target.workspaceProjectId) ?? null) === message) {
          return [false, map] as const;
        }
        const next = new Map(map);
        if (message === null) {
          next.delete(target.workspaceProjectId);
        } else {
          next.set(target.workspaceProjectId, message);
        }
        return [true, next] as const;
      });
      if (!changed) return;
      const current = (yield* Ref.get(statuses)).get(target.workspaceProjectId);
      if (current === undefined) return;
      const { notice: _stale, ...rest } = current;
      yield* publishEntry(message === null ? rest : { ...rest, notice: message });
    });

  const processTarget = (
    target: WipTarget,
    options: { readonly acknowledgeApplied?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) {
        return;
      }
      const mode =
        (yield* Ref.get(modes)).get(target.workspaceProjectId) ?? ("origin-refs" as const);
      const recordedContext = (yield* Ref.get(gitContexts)).get(target.workspaceProjectId);
      const contextChanged =
        recordedContext !== undefined && recordedContext !== (yield* readGitContext(target));
      if (contextChanged) {
        yield* Ref.update(pendingParkedRestores, (pending) =>
          new Set(pending).add(target.workspaceProjectId),
        );
      }
      if ((yield* Ref.get(pendingParkedRestores)).has(target.workspaceProjectId)) {
        const restored = yield* providePassDeps(restoreParkedWipForTarget(target));
        if (restored) {
          yield* Ref.update(pendingParkedRestores, (pending) => {
            const next = new Set(pending);
            next.delete(target.workspaceProjectId);
            return next;
          });
        }
      }
      // The commit we last shipped, read BEFORE capture overwrites the pushed
      // marker with this pass's snapshot — so apply can tell a locally-created
      // file we just deleted from a genuinely new peer file (the delete flap).
      const shippedBaseOid =
        mode === "bundle"
          ? ((yield* providePassDeps(bundleShipped(target.workspaceProjectId, environmentId)))
              ?.commitOid ?? null)
          : yield* providePassDeps(
              wipPushedMarkerRefName(target.workspaceProjectId, environmentId).pipe(
                Effect.flatMap((ref) => resolveOid(target.workspaceRoot, ref)),
              ),
            );
      const hasInFlightTurn = yield* threadRepository
        .hasActiveTurnByProjectId({ projectId: target.localProjectId })
        .pipe(Effect.orElseSucceed(() => true));
      // An agent working here is activity even while the tree is unchanged —
      // keep this machine's lease fresh so the peer's chip stays honest
      // (renewLease throttles itself).
      if (hasInFlightTurn) {
        yield* providePassDeps(
          renewLease({ workspaceProjectId: target.workspaceProjectId, environmentId }),
        );
      }
      const applied = yield* providePassDeps(
        runWipApplyForTarget(target, shippedBaseOid, { hasInFlightTurn }),
      );
      // Apply before capture. Branch-moving paths park first and same-context
      // merge preserves local files, so local work remains recoverable. The
      // reverse order shipped the receiver's stale pre-apply branch back to
      // the author and created a branch-feedback loop.
      const outcome = yield* providePassDeps(
        runWipPassForTarget(target, mode, {
          ...options,
          // A ship right after applying peer content (or an explicit
          // acknowledgement) is an echo, not local activity — it must not
          // move the advisory lease toward the receiving machine.
          suppressLeaseRenewal:
            options.acknowledgeApplied === true ||
            applied._tag === "applied" ||
            applied._tag === "applied-with-conflicts",
        }),
      );
      if (outcome._tag === "done") {
        yield* Ref.update(modes, (map) =>
          new Map(map).set(target.workspaceProjectId, outcome.nextMode),
        );
      }
      yield* recordGitContext(target);
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
      // The watch notice is owned by the watch loop, not the pass — strip
      // whatever the previous entry carried and re-merge the current one.
      const { notice: _staleNotice, ...baseWithoutBlocked } = clearBlockedFields(base);
      // Watch advisory wins the single notice slot; a vault tombstone
      // deletion (G4) fills it otherwise — secrets removals are never
      // silent.
      const vaultNotice = (yield* vaultSync.deletionNotices).get(target.workspaceProjectId);
      const currentNotice =
        (yield* Ref.get(watchNotices)).get(target.workspaceProjectId) ?? vaultNotice;
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
                takeoverAvailable: true,
                blockedSnapshotOid: applied.snapshotOid,
                blockedFrom: applied.fromEnvironmentId,
              }
            : applied._tag === "blocked"
              ? {
                  ...withWarning,
                  blockedReason: applied.reason,
                  takeoverAvailable: applied.takeoverServiceable,
                  blockedSnapshotOid: applied.snapshotOid,
                  blockedFrom: applied.fromEnvironmentId,
                  ...(applied.divergence ? { divergenceAvailable: true } : {}),
                }
              : withWarning;
      const entryWithNotice: RoamingWipStatusEntry =
        currentNotice === undefined ? entry : { ...entry, notice: currentNotice };
      const seeded =
        previous === undefined
          ? yield* providePassDeps(seedActivityFromMarkers(target, entryWithNotice, mode))
          : entryWithNotice;
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

  // G3: takeover and divergence resolution mutate the worktree (branch
  // switch, reset --hard, clean -fd) and must never interleave with a
  // concurrent capture or per-file apply. One lock per project serializes
  // the worker's passes and those explicit mutations against each other.
  // The shutdown finalizer deliberately bypasses this (and the worker) —
  // pass fibers are already interrupted there.
  const projectLocks = yield* Ref.make(new Map<WorkspaceProjectId, Semaphore.Semaphore>());
  const withProjectLock =
    (workspaceProjectId: WorkspaceProjectId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Ref.modify(projectLocks, (locks) => {
        const existing = locks.get(workspaceProjectId);
        if (existing !== undefined) {
          return [existing, locks] as const;
        }
        const created = Semaphore.makeUnsafe(1);
        const next = new Map(locks);
        next.set(workspaceProjectId, created);
        return [created, next] as const;
      }).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  const worker = yield* makeKeyedCoalescingWorker<WorkspaceProjectId, WipTarget, never, never>({
    merge: (_current, next) => next,
    process: (workspaceProjectId, target) =>
      withProjectLock(workspaceProjectId)(processTarget(target).pipe(Effect.asVoid)),
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
  // to seconds after the last write. When a watch cannot exist (inotify
  // budget, unsupported platform) or dies, the project falls back to a 10s
  // capture sweep with a surfaced notice — NEVER silently to the 2-minute
  // interval (the M3.7 latency cliff) — and periodically re-attempts a real
  // watch. Swap scopes atomically — the VaultSync watcher lesson.
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
      const runWatchOnce = Effect.gen(function* () {
        // The notice withdraws only once the fresh watch proves healthy —
        // an install that dies instantly must not blink the advisory.
        const clearFiber = yield* Effect.sleep(WATCH_HEALTHY_AFTER).pipe(
          Effect.andThen(setWatchNotice(target, null)),
          Effect.forkIn(scope),
        );
        yield* Stream.runForEach(
          watchTreeEvents(target.workspaceRoot, hostPlatform).pipe(Stream.debounce(WATCH_DEBOUNCE)),
          (relative) =>
            Effect.logInfo("roaming timing: watch-trigger", {
              workspaceProjectId: target.workspaceProjectId,
              path: relative,
            }).pipe(Effect.andThen(worker.enqueue(target.workspaceProjectId, target))),
        ).pipe(Effect.ignoreCause({ log: true }), Effect.ensuring(Fiber.interrupt(clearFiber)));
      });
      const watchLoop = Effect.gen(function* () {
        while (true) {
          yield* runWatchOnce;
          // Reached only when the stream ended on its own — scope
          // interruption never gets here. Loud + surfaced + short sweep.
          yield* Effect.logWarning("roaming wip: tree watch unavailable, sweeping every 10s", {
            workspaceProjectId: target.workspaceProjectId,
          });
          yield* setWatchNotice(target, WATCH_FALLBACK_NOTICE);
          for (let tick = 0; tick < WATCH_REINSTALL_TICKS; tick++) {
            yield* Effect.sleep(WATCH_FALLBACK_SWEEP);
            yield* worker.enqueue(target.workspaceProjectId, target);
          }
        }
      });
      yield* watchLoop.pipe(
        Effect.ignoreCause({ log: true }),
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

  // Unlocked core — resolveDivergence's take-the-peer path runs it while
  // already holding the project lock.
  const runTakeover = (workspaceProjectId: WorkspaceProjectId, snapshotOid?: string) =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) return { applied: false as const };
      const target = (yield* listTargets).find(
        (candidate) => candidate.workspaceProjectId === workspaceProjectId,
      );
      if (target === undefined) return { applied: false as const };
      const hasInFlightTurn = yield* threadRepository
        .hasActiveTurnByProjectId({ projectId: target.localProjectId })
        .pipe(Effect.orElseSucceed(() => true));
      const outcome = yield* providePassDeps(
        runWipApplyForTarget(target, undefined, {
          hasInFlightTurn,
          takeover: true,
          ...(snapshotOid !== undefined ? { expectedSnapshotOid: snapshotOid } : {}),
        }),
      );
      // applied-with-conflicts is still a SUCCESSFUL takeover: the branch
      // switch and reset already happened by the time conflicts are known
      // (a leftover ignored file colliding with a peer path, a failed
      // restore). Reporting false here would toast an error over a mutated
      // worktree and skip the acknowledgement capture the peer needs to
      // clear its own "Take over".
      if (outcome._tag !== "applied" && outcome._tag !== "applied-with-conflicts") {
        return {
          applied: false as const,
          ...(outcome._tag === "blocked" ? { reason: outcome.reason } : {}),
        };
      }
      const previous = (yield* Ref.get(statuses)).get(workspaceProjectId) ?? {
        workspaceProjectId,
        mode: "origin-refs" as const,
      };
      const rest = clearBlockedFields(previous);
      yield* publishEntry({
        ...rest,
        lastAppliedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
        lastAppliedFrom: outcome.fromEnvironmentId,
      });
      // Move the lease here and now — the acknowledgement capture below also
      // renews it on a successful ship, but the takeover must move the chip
      // even when that ship no-ops or fails; force past the activity throttle.
      yield* providePassDeps(renewLease({ workspaceProjectId, environmentId, force: true }));
      yield* processTarget(target, { acknowledgeApplied: true });
      return { applied: true as const };
    });

  const takeover: WipSnapshotReactor["Service"]["takeover"] = (workspaceProjectId, snapshotOid) =>
    withProjectLock(workspaceProjectId)(runTakeover(workspaceProjectId, snapshotOid)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: takeover failed", { workspaceProjectId, cause }).pipe(
          Effect.as({ applied: false as const }),
        ),
      ),
    );

  const divergence: WipSnapshotReactor["Service"]["divergence"] = (workspaceProjectId) =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) return null;
      const target = (yield* listTargets).find(
        (candidate) => candidate.workspaceProjectId === workspaceProjectId,
      );
      if (target === undefined) return null;
      return yield* providePassDeps(getWipDivergenceForTarget(target));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: divergence query failed", {
          workspaceProjectId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  const resolveDivergence: WipSnapshotReactor["Service"]["resolveDivergence"] = (
    workspaceProjectId,
    pick,
    peerSnapshotOid,
  ) =>
    withProjectLock(workspaceProjectId)(
      Effect.gen(function* () {
        if (!(yield* isEnabled)) {
          return { resolved: false as const, reason: "sync is not enabled for this project" };
        }
        const target = (yield* listTargets).find(
          (candidate) => candidate.workspaceProjectId === workspaceProjectId,
        );
        if (target === undefined) {
          return { resolved: false as const, reason: "project is not on this machine" };
        }
        if (pick === "peer") {
          // Re-verify the divergence still exists on exactly this snapshot: a
          // fast-forward that settled things between render and click must not
          // turn "take the other version" into a surprise backward reset.
          const current = yield* providePassDeps(getWipDivergenceForTarget(target));
          if (current === null || current.peer.snapshotOid !== peerSnapshotOid) {
            return {
              resolved: false as const,
              reason:
                "the machines no longer disagree on this project (or the other machine's work changed); review the latest state",
            };
          }
          // Taking the peer side IS a pinned takeover; the losing local state
          // lands on the per-branch parked ref written before the HEAD move.
          const branch = yield* git.execute({
            operation: "WipSnapshotReactor.divergenceLocalBranch",
            cwd: target.workspaceRoot,
            args: ["symbolic-ref", "-q", "HEAD"],
            allowNonZeroExit: true,
          });
          const parkedRef =
            branch.exitCode === 0
              ? yield* wipParkedRefName(target.workspaceProjectId, branch.stdout.trim()).pipe(
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
          const result = yield* runTakeover(workspaceProjectId, peerSnapshotOid);
          return {
            resolved: result.applied,
            ...(result.applied && parkedRef !== undefined ? { preservedRef: parkedRef } : {}),
            ...(!result.applied && result.reason !== undefined ? { reason: result.reason } : {}),
          };
        }
        const result = yield* providePassDeps(resolveKeptLocalDivergence(target, peerSnapshotOid));
        if (!result.resolved) {
          return { resolved: false as const, reason: result.reason };
        }
        // Keeping local IS an explicit user action here — move the lease like
        // takeover does (the acknowledgement ship itself never renews).
        yield* providePassDeps(renewLease({ workspaceProjectId, environmentId, force: true }));
        // The acknowledgement capture ships our kept-local state naming the
        // rejected snapshot. That pass classifies BEFORE it ships, so it still
        // reports the divergence; run one more pass so the settled state
        // (conflictAlreadyResolved → skip) publishes the cleared pill NOW
        // instead of on the next interval tick (field finding 2026-07-22:
        // "Review changes" lingered up to 2 minutes after a successful keep).
        yield* processTarget(target, { acknowledgeApplied: true });
        yield* processTarget(target);
        return { resolved: true as const, preservedRef: result.preservedRef };
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming wip: divergence resolution failed", {
          workspaceProjectId,
          cause,
        }).pipe(Effect.as({ resolved: false as const, reason: "internal error" })),
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
      // `.git` is deliberately excluded from the filesystem watcher, so a
      // clean CLI branch switch or commit otherwise waits for the two-minute
      // sweep. Poll only the cheap branch/HEAD tuple and enqueue on change.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            if (yield* isEnabled) {
              for (const target of yield* listTargets) {
                const context = yield* readGitContext(target);
                const captured = yield* providePassDeps(
                  bundleShipped(target.workspaceProjectId, environmentId),
                );
                const differsFromCapture =
                  captured?.branchRef !== undefined &&
                  captured.headOid !== undefined &&
                  `${captured.branchRef}\0${captured.headOid}` !== context;
                const contextChange = yield* Ref.modify(gitContexts, (contexts) => {
                  const previous = contexts.get(target.workspaceProjectId);
                  const next = new Map(contexts).set(target.workspaceProjectId, context);
                  return [
                    {
                      changed:
                        differsFromCapture || (previous !== undefined && previous !== context),
                      branchTransition: previous !== undefined && previous !== context,
                    },
                    next,
                  ] as const;
                });
                if (contextChange.branchTransition) {
                  yield* Ref.update(pendingParkedRestores, (pending) =>
                    new Set(pending).add(target.workspaceProjectId),
                  );
                }
                if (contextChange.changed) {
                  yield* worker.enqueue(target.workspaceProjectId, target);
                }
              }
            }
            yield* Effect.sleep(GIT_CONTEXT_INTERVAL);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("roaming wip: git-context poll failed", { cause }).pipe(
                Effect.andThen(Effect.sleep(GIT_CONTEXT_INTERVAL)),
              ),
            ),
          ),
        ),
      );
      // Enabling (consent flip via settings, or the master gate flip via
      // peer changes — pairing writes no setting since D3) triggers a scan so
      // it takes effect immediately; disabling drops the retained statuses.
      const applyEnabledState = isEnabled.pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? snapshotAll()
            : Ref.set(statuses, new Map()).pipe(Effect.andThen(closeAllWatchers)),
        ),
      );
      yield* Effect.forkScoped(
        serverSettings.streamChanges.pipe(
          Stream.runForEach(() => applyEnabledState),
          Effect.ignoreCause({ log: true }),
        ),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const peerChanges = yield* peers.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(peerChanges).pipe(Effect.andThen(applyEnabledState)),
          );
        }).pipe(Effect.ignoreCause({ log: true })),
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
                  ? Effect.logInfo("roaming timing: wip-blob-arrival trigger", {
                      workspaceProjectId: record.workspaceProjectId,
                      key: record.key,
                      version: record.version,
                    }).pipe(Effect.andThen(snapshotProject(record.workspaceProjectId)))
                  : Effect.void,
              ),
            ),
          );
        }),
      );
      // ONE domain-event subscription (S7), dispatching on event type:
      // — Enrollment: a project gains its workspaceProjectId AFTER pairing
      //   has already run the settings-triggered scan, so without this
      //   trigger the fresh project has no watcher and no first snapshot
      //   until the next interval sweep (~2-minute stall, M3.7 harness).
      // — Turn completion: snapshot just that project, post-checkpoint.
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          Effect.gen(function* () {
            if (
              event.type === "project.meta-updated" &&
              event.payload.workspaceProjectId !== undefined
            ) {
              return yield* snapshotAll();
            }
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
    takeover,
    divergence,
    resolveDivergence,
    snapshotAll,
    listStatuses,
    subscribeUpdates: PubSub.subscribe(updates),
  } satisfies WipSnapshotReactor["Service"];
});

export const layer = Layer.effect(WipSnapshotReactor, make);
