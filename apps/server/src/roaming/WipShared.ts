/**
 * Shared WIP-sync building blocks: the target/transport types, the wip blob
 * payload codecs, repo-state guards, the vault subtraction set, and the
 * blob-store reads used by capture (WipCapture.ts), delivery (WipApply.ts),
 * and the reactor (WipSnapshotReactor.ts).
 */
import {
  RoamingWipPayload,
  type ProjectId,
  type RoamingWipStatusEntry,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { buildCandidatePaths, listTrackedCandidates } from "./VaultSync.ts";
import { resolveOid, wipRefGlob } from "./WipSnapshots.ts";

export type WipTransportMode = RoamingWipStatusEntry["mode"];

export interface WipTarget {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly workspaceRoot: string;
  readonly localProjectId: ProjectId;
}

export const encodeWipPayloadJson = Schema.encodeEffect(Schema.fromJsonString(RoamingWipPayload));

export const decodeWipPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingWipPayload),
);

export const inProgressOperationExists = (cwd: string) =>
  Effect.gen(function* () {
    for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
      if ((yield* resolveOid(cwd, marker)) !== null) {
        return true;
      }
    }
    return false;
  });

export const isGitWorktree = (cwd: string) =>
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
export const vaultExcludePathsFor = (target: WipTarget) =>
  Effect.gen(function* () {
    const candidates = yield* buildCandidatePaths(target.workspaceRoot, target.workspaceProjectId);
    const tracked = yield* listTrackedCandidates(target.workspaceRoot, candidates);
    if (tracked._tag === "unavailable") {
      return null;
    }
    return candidates.filter((path) => !tracked.paths.has(path));
  });

/** The current WIP blob payload, or null (no blob / undecodable). */
export const bundleShipped = (workspaceProjectId: WorkspaceProjectId, environmentId: string) =>
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
    return payload;
  });

/**
 * Every decodable wip payload for a project from the mirrored blob store,
 * with the undecodable blob keys reported rather than dropped. The ONE
 * manifest-scan recipe (S8) behind payloadForCommit, the apply selector,
 * and the materialize restore.
 */
export const listWipPayloads = (
  workspaceProjectId: WorkspaceProjectId,
  options?: { readonly excludeKey?: string },
) =>
  Effect.gen(function* () {
    const blobStore = yield* RoamingBlobStore;
    const manifest = yield* blobStore.manifest().pipe(Effect.orElseSucceed(() => []));
    const payloads: Array<{ readonly key: string; readonly payload: RoamingWipPayload }> = [];
    const undecodable: string[] = [];
    for (const entry of manifest) {
      if (
        entry.kind !== "wip" ||
        !entry.key.startsWith(`${workspaceProjectId}/`) ||
        entry.key === options?.excludeKey
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
        undecodable.push(entry.key);
        continue;
      }
      payloads.push({ key: entry.key, payload });
    }
    return { payloads, undecodable };
  });

export const payloadForCommit = (
  workspaceProjectId: WorkspaceProjectId,
  commitOid: string | null,
) =>
  Effect.gen(function* () {
    if (commitOid === null) return null;
    const { payloads } = yield* listWipPayloads(workspaceProjectId);
    return payloads.find(({ payload }) => payload.commitOid === commitOid)?.payload ?? null;
  });

export const primaryRemoteName = (cwd: string) =>
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

export interface PeerWipRefCandidate {
  readonly refName: string;
  readonly committedAtUnix: number;
  readonly committedAtIso: string;
  readonly commitOid: string;
}

export interface PeerWipScan {
  /** Decodable payloads keyed by `refName\0commitOid`. */
  readonly payloads: ReadonlyMap<string, RoamingWipPayload>;
  /** Local wip refs after the freshen, unsorted; callers pick their newest. */
  readonly candidates: ReadonlyArray<PeerWipRefCandidate>;
  /** Blob keys whose payload did not decode. */
  readonly undecodable: ReadonlyArray<string>;
  /** Blob keys whose bundle failed to import even after the retry. */
  readonly failedBundles: ReadonlyArray<string>;
}

/**
 * The ONE freshen-and-scan recipe (S1) behind the apply selector and the
 * materialize restore: fetch peer wip refs from the primary remote when one
 * exists, import mirrored bundle blobs into the same local namespace
 * (skipping bundles whose ref is already current, retrying once after a
 * plain remote fetch — bundles omit objects the remote advertises), then
 * list the resulting refs. Selection and validation stay with the callers;
 * their semantics differ on purpose (orphan-ref guard vs legacy notice).
 */
export const scanPeerWipRefs = (input: {
  readonly cwd: string;
  readonly workspaceProjectId: WorkspaceProjectId;
  /** Skip this machine's own blob and ref (the apply path). */
  readonly excludeEnvironmentId?: string;
}) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const { cwd } = input;
    const glob = yield* wipRefGlob(input.workspaceProjectId);

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
        workspaceProjectId: input.workspaceProjectId,
        durationMs: fetchDoneMs - fetchStartedMs,
      });
    }

    const listed = yield* listWipPayloads(input.workspaceProjectId, {
      ...(input.excludeEnvironmentId !== undefined
        ? { excludeKey: `${input.workspaceProjectId}/${input.excludeEnvironmentId}` }
        : {}),
    });
    const payloads = new Map<string, RoamingWipPayload>();
    const failedBundles: string[] = [];
    for (const { key, payload } of listed.payloads) {
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
          failedBundles.push(key);
          yield* Effect.logWarning("roaming wip: peer bundle import failed", {
            workspaceProjectId: input.workspaceProjectId,
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

    const listing = yield* git.execute({
      operation: "WipSnapshotReactor.listPeerWipRefs",
      cwd,
      args: [
        "for-each-ref",
        "--format=%(refname) %(committerdate:unix) %(committerdate:iso-strict) %(objectname)",
        glob.slice(0, -1),
      ],
      allowNonZeroExit: true,
    });
    const candidates: PeerWipRefCandidate[] =
      listing.exitCode !== 0
        ? []
        : listing.stdout
            .split("\n")
            .map((line) => line.trim().split(" "))
            .flatMap((parts) =>
              parts.length === 4 && parts[0]!.length > 0
                ? [
                    {
                      refName: parts[0]!,
                      committedAtUnix: Number(parts[1]!),
                      committedAtIso: parts[2]!,
                      commitOid: parts[3]!,
                    },
                  ]
                : [],
            );

    return {
      payloads,
      candidates,
      undecodable: listed.undecodable,
      failedBundles,
    } satisfies PeerWipScan;
  });
