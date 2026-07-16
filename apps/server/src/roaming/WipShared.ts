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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { buildCandidatePaths, listTrackedCandidates } from "./VaultSync.ts";
import { resolveOid } from "./WipSnapshots.ts";

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

export const payloadForCommit = (
  workspaceProjectId: WorkspaceProjectId,
  commitOid: string | null,
) =>
  Effect.gen(function* () {
    if (commitOid === null) return null;
    const blobStore = yield* RoamingBlobStore;
    const manifest = yield* blobStore.manifest().pipe(Effect.orElseSucceed(() => []));
    for (const entry of manifest) {
      if (entry.kind !== "wip" || !entry.key.startsWith(`${workspaceProjectId}/`)) continue;
      const blob = yield* blobStore
        .get({ kind: "wip", key: entry.key })
        .pipe(Effect.orElseSucceed(() => null));
      if (blob === null) continue;
      const payload = yield* decodeWipPayloadJson(blob.payload).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (payload?.commitOid === commitOid) return payload;
    }
    return null;
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
