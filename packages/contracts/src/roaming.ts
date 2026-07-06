import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
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

/**
 * The reconciliation address is `(kind, key)`. `key` must be globally unique
 * within its kind; the derivation is part of this contract:
 *
 * - `registry`, `vault`, `recipe`, `lease` → `<workspaceProjectId>`
 * - `wip`                                  → `<workspaceProjectId>/<environmentId>`
 * - `transcript`, `brief`                  → `<threadId>`
 *
 * `workspaceProjectId` on the record is a denormalized grouping attribute
 * (indexing, per-project listing), not part of the address.
 */
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
  /**
   * Monotonic per (kind, key); writers bump it on every change. Accepted
   * limitation: a scalar version only detects concurrency at *equal*
   * versions — if two machines diverge and one races ahead, higher-version-
   * wins overwrites silently. Registry-class data changes rarely enough
   * that the common both-bumped-once case is the one that matters (and it
   * does surface as a conflict).
   */
  version: PositiveInt,
  /** Hex sha-256 of the exact `payload` string; must be stable across machines. */
  contentHash: TrimmedNonEmptyString,
  authorEnvironmentId: EnvironmentId,
  updatedAt: IsoDateTime,
  /**
   * Kind-specific content. Registry entries are JSON text (see
   * `RoamingRegistryPayload`); binary kinds encode as base64. Kept a plain
   * string so hashing and storage are byte-exact, and so M7 can swap in
   * ciphertext without changing the record shape. The payload string is
   * authoritative: store and transport it verbatim, and never re-serialize
   * a decoded payload before hashing — re-encoding is not byte-stable.
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
 * an explicit pick, never a merge. The full remote record is retained so
 * the resolution flow can show both payloads (the local one lives in the
 * store).
 */
export const RoamingBlobConflict = Schema.Struct({
  kind: RoamingBlobKind,
  key: TrimmedNonEmptyString,
  workspaceProjectId: WorkspaceProjectId,
  version: PositiveInt,
  localContentHash: TrimmedNonEmptyString,
  remote: RoamingBlobRecord,
  detectedAt: IsoDateTime,
});
export type RoamingBlobConflict = typeof RoamingBlobConflict.Type;

// ── Vault (step 2) ───────────────────────────────────────────────────
//
// Secret-file capture is a global category: `DEFAULT_VAULT_PATTERNS` applies
// to every enrolled project's root-level files, filtered to those git
// actually ignores. Per-project overrides are the rare exception: `include`
// adds explicit repo-relative paths (may be nested; not globs), `exclude`
// drops files the defaults matched. Effective set = defaults + include −
// exclude.

/**
 * Matching alone never captures: the server additionally requires the file
 * to be untracked (committed lookalikes like `.env.example` match `.env.*`
 * but travel via git and stay out).
 */
export const DEFAULT_VAULT_PATTERNS = [
  ".env",
  ".env.*",
  "*.local.*",
  "*.pem",
  "*.key",
  "*.crt",
  "*.p12",
  "*.pfx",
] as const;

/**
 * Total decoded-bytes cap per vault bundle. A pattern accidentally matching
 * something huge must not silently ship it: an oversize capture is skipped
 * and surfaced as a warning, never truncated or partially written.
 */
export const ROAMING_VAULT_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

export const RoamingVaultOverrides = Schema.Struct({
  /** Repo-relative paths (posix separators), added to the default matches. */
  include: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Repo-relative paths to drop from the default matches. */
  exclude: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type RoamingVaultOverrides = typeof RoamingVaultOverrides.Type;

export const RoamingVaultFileEntry = Schema.Struct({
  /** Repo-relative, posix separators. */
  path: TrimmedNonEmptyString,
  /** Unix permission bits, when capture knows them (0o600 certs stay 0o600). */
  mode: Schema.optional(NonNegativeInt),
  /** Hex sha-256 of the decoded file bytes — the per-file conflict signal. */
  sha256: TrimmedNonEmptyString,
  contentBase64: Schema.String,
});
export type RoamingVaultFileEntry = typeof RoamingVaultFileEntry.Type;

/** Payload of blob kind=vault (key=workspaceProjectId), JSON-encoded. */
export const RoamingVaultBundle = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  capturedAt: IsoDateTime,
  files: Schema.Array(RoamingVaultFileEntry),
});
export type RoamingVaultBundle = typeof RoamingVaultBundle.Type;

// ── Registry entry payload (kind=registry, key=workspaceProjectId) ──

export const RoamingRegistryPayload = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  repository: RepositoryIdentity,
  defaultBranch: Schema.optional(TrimmedNonEmptyString),
  /** Per-project exceptions to the global vault defaults (rarely used). */
  vaultOverrides: RoamingVaultOverrides.pipe(
    Schema.withDecodingDefault(Effect.succeed({ include: [], exclude: [] })),
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
  /** Unresolved blob conflicts for this project (equal version, different hash). */
  conflicts: Schema.Array(
    Schema.Struct({
      kind: RoamingBlobKind,
      detectedAt: IsoDateTime,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type RoamingProjectShell = typeof RoamingProjectShell.Type;

// ── Materialize (step 3) ─────────────────────────────────────────────
//
// One resumable materialization per (workspaceProjectId) per machine,
// checkpointed in `roaming_materializations`. The RPC is synchronous — it
// runs (or resumes) the step machine and returns the final record; live
// step transitions ride the shell stream as `roaming-materialization-updated`
// events. Re-running a failed materialization continues, never restarts.

export const RoamingMaterializeStepName = Schema.Literals([
  "resolve-path",
  "clone",
  "apply-vault",
  /** Recorded as skipped until M4 lands WIP snapshots. */
  "restore-wip",
  "register-project",
  /** Recorded as skipped until M3 lands bootstrap recipes. */
  "bootstrap",
]);
export type RoamingMaterializeStepName = typeof RoamingMaterializeStepName.Type;

export const RoamingMaterializeStepStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
]);
export type RoamingMaterializeStepStatus = typeof RoamingMaterializeStepStatus.Type;

export const RoamingMaterializationStatus = Schema.Literals(["running", "completed", "failed"]);
export type RoamingMaterializationStatus = typeof RoamingMaterializationStatus.Type;

export const RoamingMaterializationRecord = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  status: RoamingMaterializationStatus,
  steps: Schema.Array(
    Schema.Struct({
      step: RoamingMaterializeStepName,
      status: RoamingMaterializeStepStatus,
      /** Human-readable outcome ("cloned to ~/src/app", failure text). */
      detail: Schema.optional(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Honest caveats that are not failures — e.g. "no secret files synced"
   * when materializing a project whose vault has no local blob.
   */
  notices: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  targetPath: Schema.NullOr(TrimmedNonEmptyString),
  /** Set once register-project completes. */
  localProjectId: Schema.NullOr(ProjectId),
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RoamingMaterializationRecord = typeof RoamingMaterializationRecord.Type;

export const RoamingMaterializeRequest = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  /**
   * Overrides perMachineRoots / default-root resolution when set. Ignored
   * when a completed materialization already exists for the project — the
   * RPC then returns that record unchanged (re-materialize to a new path is
   * not an M2 flow).
   */
  targetPath: Schema.optional(TrimmedNonEmptyString),
});
export type RoamingMaterializeRequest = typeof RoamingMaterializeRequest.Type;

export const RoamingMaterializeResponse = Schema.Struct({
  materialization: RoamingMaterializationRecord,
});
export type RoamingMaterializeResponse = typeof RoamingMaterializeResponse.Type;

// ── Conflict surfacing / resolution ─────────────────────────────────
//
// POST bodies rather than path params — `wip` keys contain `/`. Resolution
// is always an explicit pick; the chosen side is written as a new
// higher-version local blob (which supersedes and clears the conflict) and
// mirrors out like any write.

export const RoamingConflictGetRequest = Schema.Struct({
  ref: RoamingBlobRef,
});
export type RoamingConflictGetRequest = typeof RoamingConflictGetRequest.Type;

export const RoamingConflictGetResponse = Schema.Struct({
  conflict: RoamingBlobConflict,
  /** The local record the remote one collided with. */
  local: RoamingBlobRecord,
});
export type RoamingConflictGetResponse = typeof RoamingConflictGetResponse.Type;

export const RoamingConflictResolveRequest = Schema.Struct({
  ref: RoamingBlobRef,
  pick: Schema.Literals(["local", "remote"]),
});
export type RoamingConflictResolveRequest = typeof RoamingConflictResolveRequest.Type;

export const RoamingConflictResolveResponse = Schema.Struct({
  record: RoamingBlobRecord,
});
export type RoamingConflictResolveResponse = typeof RoamingConflictResolveResponse.Type;

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
  /**
   * Sync on/off is a pause on the standing pairing (2026-07-06 decision):
   * off gates outbound passes and inbound mirror RPCs but keeps the peer
   * and its credential, so re-enabling never needs a new pairing code.
   * A code is only needed when no peer record exists at all.
   */
  syncEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
 * Sync choices made in the pairing dialog (M2.5). Travels with the unified
 * handshake so one pairing action configures both machines. A peer applies
 * received options only when the same request flips its `roaming` setting
 * off→on (first pairing) — an explicit prior choice on a machine is never
 * overridden remotely.
 */
export const RoamingPairSyncOptions = Schema.Struct({
  /** Maps to the `roamingSecretsSync` setting (vault capture consent). */
  secretsSync: Schema.optional(Schema.Boolean),
});
export type RoamingPairSyncOptions = typeof RoamingPairSyncOptions.Type;

/**
 * Called on a peer with a short-lived bearer (obtained by exchanging a
 * pairing credential at /oauth/token) to mint the long-lived
 * machine-to-machine credential (decision D4). The peer records the caller
 * as a known peer. This route is deliberately NOT gated on the `roaming`
 * setting: a successful mint is what turns the setting on (pairing is the
 * consent — the peer's operator minted the administrative pairing code),
 * and it applies `syncOptions` per the first-pairing-only rule above.
 */
export const RoamingMachineCredentialRequest = Schema.Struct({
  environmentId: EnvironmentId,
  baseUrls: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  syncOptions: Schema.optional(RoamingPairSyncOptions),
  /** Human name of the calling machine — used to label the minted sessions. */
  callerLabel: Schema.optional(TrimmedNonEmptyString),
});
export type RoamingMachineCredentialRequest = typeof RoamingMachineCredentialRequest.Type;

export const RoamingMachineCredentialResponse = Schema.Struct({
  environmentId: EnvironmentId,
  token: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type RoamingMachineCredentialResponse = typeof RoamingMachineCredentialResponse.Type;

/**
 * Local (user-session) RPC: the unified pairing handshake (M2.5). The
 * caller's own server exchanges the single-use pairing credential at the
 * peer's /oauth/token exactly once — with NO scope parameter, because the
 * credential is consumed before the peer's scope check, so requesting
 * scopes a weaker code lacks would burn it — and branches on the granted
 * scopes from the response: with access:write it establishes the mirror
 * (machine credential + peer record) and derives a fresh standard-scoped
 * attach bearer for the client; without it, attach-only. The handshake
 * session cannot be revoked (the peer forbids revoking the calling
 * session); it ages out on its TTL and stays visible in the peer's
 * authorized-clients list. This route is NOT gated on the `roaming`
 * setting (a fresh machine pairs before any setting exists); success flips
 * the local setting on and applies `syncOptions` locally.
 */
export const RoamingAddPeerRequest = Schema.Struct({
  baseUrls: Schema.Array(TrimmedNonEmptyString).check(Schema.isNonEmpty()),
  pairingCredential: TrimmedNonEmptyString,
  syncOptions: Schema.optional(RoamingPairSyncOptions),
});
export type RoamingAddPeerRequest = typeof RoamingAddPeerRequest.Type;

/**
 * The attach half of the handshake result: a standard-scoped bearer the
 * client registers as an ordinary remote-environment connection (the same
 * shape `connectPairing` would have produced). `baseUrl` is the peer base
 * URL that actually answered — the client must register that one, not the
 * first entry it submitted. Responses carrying this MUST be served with
 * `cache-control: no-store` and the token must never be logged.
 */
export const RoamingAttachGrant = Schema.Struct({
  environmentId: EnvironmentId,
  baseUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type RoamingAttachGrant = typeof RoamingAttachGrant.Type;

/**
 * Why the mirror half was skipped while the attach half still succeeded.
 * Attach-only is a first-class outcome, not an error: the same dialog
 * attaches to servers the user does not administer.
 *
 * - `credential-not-administrative`: the exchanged bearer lacks
 *   `access:write`, so the peer-side mints are impossible. Fix: regenerate
 *   the code with the administrative preset.
 * - `peer-does-not-support-machine-pairing`: the peer has no roaming
 *   machine-credential route (e.g. an upstream T3 server).
 */
export const RoamingMirrorUnavailableReason = Schema.Literals([
  "credential-not-administrative",
  "peer-does-not-support-machine-pairing",
]);
export type RoamingMirrorUnavailableReason = typeof RoamingMirrorUnavailableReason.Type;

/**
 * Unified handshake result. `attach` is always present — without it the
 * pairing failed and the route errors instead. `peer` is set iff the mirror
 * was established; otherwise `mirrorUnavailableReason` says why not.
 */
export const RoamingPairMachineResponse = Schema.Struct({
  attach: RoamingAttachGrant,
  peer: Schema.NullOr(RoamingPeer),
  mirrorUnavailableReason: Schema.NullOr(RoamingMirrorUnavailableReason),
});
export type RoamingPairMachineResponse = typeof RoamingPairMachineResponse.Type;

/**
 * Local (user-session) RPCs backing the per-environment sync controls
 * (2026-07-06 product decision): each saved environment row shows whether a
 * mirror to that machine exists and lets the user turn it off. Turning it
 * ON again needs a fresh one-time code (the unified handshake), so that
 * path goes through RoamingAddPeerRequest instead.
 */
export const RoamingListPeersResponse = Schema.Struct({
  peers: Schema.Array(RoamingPeer),
});
export type RoamingListPeersResponse = typeof RoamingListPeersResponse.Type;

export const RoamingSetPeerSyncRequest = Schema.Struct({
  environmentId: EnvironmentId,
  syncEnabled: Schema.Boolean,
});
export type RoamingSetPeerSyncRequest = typeof RoamingSetPeerSyncRequest.Type;

export const RoamingSetPeerSyncResponse = Schema.Struct({
  peer: Schema.NullOr(RoamingPeer),
});
export type RoamingSetPeerSyncResponse = typeof RoamingSetPeerSyncResponse.Type;

export const RoamingRemovePeerRequest = Schema.Struct({
  environmentId: EnvironmentId,
});
export type RoamingRemovePeerRequest = typeof RoamingRemovePeerRequest.Type;

export const RoamingRemovePeerResponse = Schema.Struct({
  removed: Schema.Boolean,
});
export type RoamingRemovePeerResponse = typeof RoamingRemovePeerResponse.Type;

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
export const ROAMING_PEERS_LIST_PATH = "/api/roaming/peers/list";
export const ROAMING_PEERS_REMOVE_PATH = "/api/roaming/peers/remove";
export const ROAMING_PEERS_SYNC_PATH = "/api/roaming/peers/sync";
export const ROAMING_HANDSHAKE_COMPLETE_PATH = "/api/roaming/handshake-complete";
export const ROAMING_ENROLL_PROJECT_PATH = "/api/roaming/projects/enroll";
export const ROAMING_MATERIALIZE_PATH = "/api/roaming/materialize";
export const ROAMING_CONFLICT_GET_PATH = "/api/roaming/conflicts/get";
export const ROAMING_CONFLICT_RESOLVE_PATH = "/api/roaming/conflicts/resolve";
