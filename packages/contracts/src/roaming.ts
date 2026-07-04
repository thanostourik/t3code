import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceProjectId,
} from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";

// ── Roaming blob record (decision D3) ───────────────────────────────
//
// Every kind of roaming state — registry entries, vault bundles, recipes,
// WIP bundles, transcripts, briefs, leases — is one record shape addressed
// by (kind, key). Blobs live in each machine's local `roaming_blobs` table
// and reconcile through the mirror: per key, higher version wins; same
// version with a different contentHash means concurrent writes and is
// surfaced as a conflict, never auto-merged.

export const RoamingBlobKind = Schema.Literals([
  "registry",
  "vault",
  "recipe",
  "wip",
  "transcript",
  "brief",
  "lease",
]);
export type RoamingBlobKind = typeof RoamingBlobKind.Type;

export const RoamingBlobRef = Schema.Struct({
  kind: RoamingBlobKind,
  key: TrimmedNonEmptyString,
});
export type RoamingBlobRef = typeof RoamingBlobRef.Type;

export const RoamingBlobRecord = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  kind: RoamingBlobKind,
  key: TrimmedNonEmptyString,
  workspaceProjectId: WorkspaceProjectId,
  /** Monotonic per (kind, key); writers bump it on every change. */
  version: PositiveInt,
  /** Hex sha-256 of the exact `payload` string; must be stable across machines. */
  contentHash: TrimmedNonEmptyString,
  authorEnvironmentId: EnvironmentId,
  updatedAt: IsoDateTime,
  /**
   * Kind-specific content. Registry entries are JSON text (see
   * `RoamingRegistryPayload`); binary kinds encode as base64. Kept a plain
   * string so hashing and storage are byte-exact, and so M7 can swap in
   * ciphertext without changing the record shape.
   */
  payload: Schema.String,
});
export type RoamingBlobRecord = typeof RoamingBlobRecord.Type;

export const RoamingBlobManifestEntry = Schema.Struct({
  kind: RoamingBlobKind,
  key: TrimmedNonEmptyString,
  version: PositiveInt,
  contentHash: TrimmedNonEmptyString,
});
export type RoamingBlobManifestEntry = typeof RoamingBlobManifestEntry.Type;

/**
 * Concurrent writes to the same (kind, key) at the same version. Recorded
 * locally by the blob store and surfaced to the user; resolution is always
 * an explicit pick, never a merge.
 */
export const RoamingBlobConflict = Schema.Struct({
  kind: RoamingBlobKind,
  key: TrimmedNonEmptyString,
  workspaceProjectId: WorkspaceProjectId,
  version: PositiveInt,
  localContentHash: TrimmedNonEmptyString,
  remoteContentHash: TrimmedNonEmptyString,
  remoteAuthorEnvironmentId: EnvironmentId,
  detectedAt: IsoDateTime,
});
export type RoamingBlobConflict = typeof RoamingBlobConflict.Type;

// ── Registry entry payload (kind=registry, key=workspaceProjectId) ──

export const RoamingRegistryPayload = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  repository: RepositoryIdentity,
  defaultBranch: Schema.optional(TrimmedNonEmptyString),
  /** Repo-relative globs of vault-tracked files (step 2; empty until then). */
  vaultManifest: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Blob key of the bootstrap recipe (step 4), when one exists. */
  recipeRef: Schema.optional(TrimmedNonEmptyString),
  /** Where each machine materializes this project. */
  perMachineRoots: Schema.Record(EnvironmentId, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type RoamingRegistryPayload = typeof RoamingRegistryPayload.Type;

// ── Shell projection of roaming projects ────────────────────────────

/**
 * A registry entry as shown in the workspace list. Derived from the local
 * blob copy — rendering never requires a live peer. `localProjectId` links
 * to the local project when the entry is materialized on this machine.
 */
export const RoamingProjectShell = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  repository: RepositoryIdentity,
  localProjectId: Schema.NullOr(ProjectId),
  authorEnvironmentId: EnvironmentId,
  perMachineRoots: Schema.Record(EnvironmentId, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** When this machine last completed a mirror pass with any peer; null before the first. */
  lastMirrorContactAt: Schema.NullOr(IsoDateTime),
  /** From the registry blob — when the entry itself last changed. */
  updatedAt: IsoDateTime,
});
export type RoamingProjectShell = typeof RoamingProjectShell.Type;

// ── Peers ────────────────────────────────────────────────────────────

export const RoamingPeer = Schema.Struct({
  environmentId: EnvironmentId,
  /**
   * Base URLs to try in order when contacting this peer. Recorded at
   * enrollment — the server has no LAN/Tailscale endpoint discovery of its
   * own (see plan doc, M1 analysis).
   */
  baseUrls: Schema.Array(TrimmedNonEmptyString),
  lastContactAt: Schema.NullOr(IsoDateTime),
  enrolledAt: IsoDateTime,
});
export type RoamingPeer = typeof RoamingPeer.Type;

// ── Mirror RPCs (peer-to-peer, bearer-authenticated) ────────────────
//
// One direction of connectivity gives bidirectional data flow: the caller
// exchanges manifests, then pushes blobs the peer lacks and fetches blobs
// it lacks itself.

export const RoamingSyncManifestRequest = Schema.Struct({
  environmentId: EnvironmentId,
  manifest: Schema.Array(RoamingBlobManifestEntry),
});
export type RoamingSyncManifestRequest = typeof RoamingSyncManifestRequest.Type;

export const RoamingSyncManifestResponse = Schema.Struct({
  environmentId: EnvironmentId,
  manifest: Schema.Array(RoamingBlobManifestEntry),
});
export type RoamingSyncManifestResponse = typeof RoamingSyncManifestResponse.Type;

export const RoamingFetchBlobsRequest = Schema.Struct({
  refs: Schema.Array(RoamingBlobRef),
});
export type RoamingFetchBlobsRequest = typeof RoamingFetchBlobsRequest.Type;

export const RoamingFetchBlobsResponse = Schema.Struct({
  blobs: Schema.Array(RoamingBlobRecord),
});
export type RoamingFetchBlobsResponse = typeof RoamingFetchBlobsResponse.Type;

export const RoamingPushBlobOutcome = Schema.Literals(["applied", "stale", "conflict"]);
export type RoamingPushBlobOutcome = typeof RoamingPushBlobOutcome.Type;

export const RoamingPushBlobsRequest = Schema.Struct({
  environmentId: EnvironmentId,
  blobs: Schema.Array(RoamingBlobRecord),
});
export type RoamingPushBlobsRequest = typeof RoamingPushBlobsRequest.Type;

export const RoamingPushBlobsResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      kind: RoamingBlobKind,
      key: TrimmedNonEmptyString,
      outcome: RoamingPushBlobOutcome,
    }),
  ),
});
export type RoamingPushBlobsResponse = typeof RoamingPushBlobsResponse.Type;

// ── Enrollment RPCs ──────────────────────────────────────────────────

/**
 * Called on a peer with a short-lived bearer (obtained by exchanging a
 * pairing credential at /oauth/token) to mint the long-lived
 * machine-to-machine credential (decision D4). The peer records the caller
 * as a known peer.
 */
export const RoamingMachineCredentialRequest = Schema.Struct({
  environmentId: EnvironmentId,
  baseUrls: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type RoamingMachineCredentialRequest = typeof RoamingMachineCredentialRequest.Type;

export const RoamingMachineCredentialResponse = Schema.Struct({
  environmentId: EnvironmentId,
  token: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type RoamingMachineCredentialResponse = typeof RoamingMachineCredentialResponse.Type;

/** Local (user-session) RPC: enroll a peer machine given its pairing credential. */
export const RoamingAddPeerRequest = Schema.Struct({
  baseUrls: Schema.Array(TrimmedNonEmptyString).check(Schema.isNonEmpty()),
  pairingCredential: TrimmedNonEmptyString,
});
export type RoamingAddPeerRequest = typeof RoamingAddPeerRequest.Type;

export const RoamingAddPeerResponse = Schema.Struct({
  peer: RoamingPeer,
});
export type RoamingAddPeerResponse = typeof RoamingAddPeerResponse.Type;

/** Local (user-session) RPC: enroll a local project into roaming. */
export const RoamingEnrollProjectRequest = Schema.Struct({
  projectId: ProjectId,
});
export type RoamingEnrollProjectRequest = typeof RoamingEnrollProjectRequest.Type;

export const RoamingEnrollProjectResponse = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
});
export type RoamingEnrollProjectResponse = typeof RoamingEnrollProjectResponse.Type;

// ── HTTP paths ───────────────────────────────────────────────────────

export const ROAMING_MIRROR_MANIFEST_PATH = "/api/roaming/mirror/manifest";
export const ROAMING_MIRROR_FETCH_PATH = "/api/roaming/mirror/fetch";
export const ROAMING_MIRROR_PUSH_PATH = "/api/roaming/mirror/push";
export const ROAMING_MACHINE_CREDENTIAL_PATH = "/api/roaming/machine-credential";
export const ROAMING_PEERS_PATH = "/api/roaming/peers";
export const ROAMING_ENROLL_PROJECT_PATH = "/api/roaming/projects/enroll";
