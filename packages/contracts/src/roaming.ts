import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorkspaceProjectId,
} from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";

// ── Roaming blob record (decision D3) ───────────────────────────────
//
// Every kind of roaming state — registry entries, vault bundles, recipes,
// WIP bundles, transcripts, briefs, leases — is one record shape addressed
// by (kind, key). Blobs live in each machine's local `roaming_blobs` table
// and reconcile through the mirror: per key, higher version wins; same
// version with a different contentHash means concurrent writes and
// auto-resolves newest-updatedAt-wins (see RoamingBlobConflict), never
// content-merged.

// The speculative `recipe` kind was removed 2026-07-22 (O2); it returns
// with M6's contracts PR. `transcript`/`brief` landed with M5.
export const RoamingBlobKind = Schema.Literals([
  "registry",
  "vault",
  "wip",
  "lease",
  "transcript",
  "brief",
]);
export type RoamingBlobKind = typeof RoamingBlobKind.Type;

/**
 * The reconciliation address is `(kind, key)`. `key` must be globally unique
 * within its kind; the derivation is part of this contract:
 *
 * - `registry`, `vault`, `recipe` → `<workspaceProjectId>`
 * - `wip`, `lease`                → `<workspaceProjectId>/<environmentId>`
 * - `transcript`, `brief`         → `<threadId>`
 *
 * `lease` is per-machine deliberately: each machine only ever writes its
 * own record, so concurrent activity on two machines can never produce an
 * equal-version blob conflict — which a per-project singleton would hit
 * exactly when both machines are active, the case the activity chip exists
 * to show.
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
 * Concurrent writes to the same (kind, key) at the same version. The store
 * auto-resolves newest-updatedAt-wins (D1, 2026-07-22) and records the
 * outcome here: `localContentHash` is the winner this machine now holds,
 * `remote` the full losing concurrent write, preserved for inspection. The
 * record surfaces as a notice on the project row and is superseded by the
 * next accepted write for the key.
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
// Secret-file capture is driven by two editable manifests with exact
// .gitignore semantics (M3.5): a global t3sync file in the server state dir
// (written once, pre-populated from DEFAULT_VAULT_PATTERNS below) and an
// optional user-created repo-root .t3sync that extends or vetoes it. The
// server additionally requires a matched file to be untracked (committed
// lookalikes travel via git). RoamingVaultOverrides below is retired — the
// schema field survives for payload compatibility but is no longer consumed.

/** Seeds the GLOBAL t3sync manifest on first run; not consulted directly. */
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
// 16 MiB since M3.5: the bundle also carries .t3sync-selected trees like
// .idea/ — still P2P-only, still skipped-with-warning when exceeded.
export const ROAMING_VAULT_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

/** Cap on the WIP bundle-fallback blob (compressed git bundle bytes). */
export const ROAMING_WIP_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Per-file cap for untracked files entering WIP snapshots. Anything larger
 * is excluded from the snapshot with a surfaced warning — origin-refs mode
 * pushes to the project's git host, which must never silently receive a
 * dropped-in dataset (git hosts commonly refuse >100 MB blobs anyway).
 */
export const ROAMING_WIP_MAX_FILE_BYTES = 50 * 1024 * 1024;

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

/**
 * A synced secret file the capturing machine deliberately no longer has
 * (G4). Without it, deleting a synced file on one machine resurrected it on
 * the next capture from the other. Delivery removes the local copy (into a
 * recoverable holding dir) only when the user has not edited it since the
 * last sync; a file re-created after `deletedAt` lives again and drops the
 * tombstone on the next capture.
 */
export const RoamingVaultTombstone = Schema.Struct({
  /** Repo-relative, posix separators. */
  path: TrimmedNonEmptyString,
  /** When the capturing machine observed the file gone. */
  deletedAt: IsoDateTime,
});
export type RoamingVaultTombstone = typeof RoamingVaultTombstone.Type;

/** Payload of blob kind=vault (key=workspaceProjectId), JSON-encoded. */
export const RoamingVaultBundle = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  capturedAt: IsoDateTime,
  files: Schema.Array(RoamingVaultFileEntry),
  /** Absent in pre-G4 bundles, which keep the old never-delete semantics. */
  tombstones: Schema.Array(RoamingVaultTombstone).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type RoamingVaultBundle = typeof RoamingVaultBundle.Type;

// Origin-refs mode ships no blob at all; this exists only for the bundle fallback.
export const RoamingWipPayload = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  capturedAt: IsoDateTime,
  refName: Schema.String,
  commitOid: Schema.String,
  treeOid: Schema.String,
  /** Symbolic HEAD (`refs/heads/...`) or an invalid-ref sentinel. Added in v2. */
  branchRef: Schema.optional(Schema.String),
  /** Commit checked out when the snapshot was captured. Added in v2. */
  headOid: Schema.optional(Schema.String),
  bundleBase64: Schema.String,
});
export type RoamingWipPayload = typeof RoamingWipPayload.Type;

// ── Lease (M4: takeover + divergence) ───────────────────────────────

/**
 * How stale a lease may be and still render as "active on <machine>".
 * Advisory UI threshold shared by server projections and clients — a lease
 * is never a lock, and an expired one blocks nothing.
 */
export const ROAMING_LEASE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * A machine's advisory activity record for one project, both the payload
 * of blob kind=lease (key=<workspaceProjectId>/<environmentId>) and the
 * per-machine entry surfaced on `RoamingProjectShell.activity`. "The
 * lease" is derived, not stored: the machine with the newest `renewedAt`
 * is where work is live. Takeover moves it by writing a fresh record for
 * the taking machine. Accepted limitation: `renewedAt` values come from
 * each machine's own clock, so derivation assumes roughly-synced clocks —
 * under skew a fresh record can lose to a stale one. Advisory data only;
 * the chip self-heals within the active window.
 */
export const RoamingProjectActivity = Schema.Struct({
  environmentId: EnvironmentId,
  /** Renewed on WIP capture activity, in-flight agent turns, and takeover. */
  renewedAt: IsoDateTime,
  /** `capturedAt` of this machine's newest WIP snapshot, when one exists. */
  lastSnapshotAt: Schema.optional(IsoDateTime),
});
export type RoamingProjectActivity = typeof RoamingProjectActivity.Type;

/** Payload of blob kind=lease, JSON-encoded. */
export const RoamingLeasePayload = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  ...RoamingProjectActivity.fields,
});
export type RoamingLeasePayload = typeof RoamingLeasePayload.Type;

// ── Transcripts + briefs (M5) ───────────────────────────────────────
//
// A transcript is a *reduced presentation payload* built from the committed
// SQLite projections — never the raw event log, and never the full
// OrchestrationThread projection (whose activity payloads carry raw tool
// output and median ~0.7 MB per thread). Mirrored transcripts render
// read-only on the other machine and are never imported into the local
// orchestration event log: no import path exists, so no cross-machine event
// conflict model needs to. Only the authoring machine writes a thread's
// transcript/brief blobs; deletion mirrors as a tombstone payload
// (`deleted: true`) because the blob store has no delete.
//
// These schemas are deliberately self-contained (roaming.ts cannot import
// orchestration.ts): a reduced message/activity/plan shape is the contract,
// not a re-export of the live projection types.

/**
 * Whole-payload cap for a serialized transcript blob. Oversize transcripts
 * drop oldest activities first, then oldest messages, and set `truncated` —
 * the newest turns are the ones a user reads on the other machine.
 */
export const ROAMING_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Per-activity payload cap inside a transcript. Activity payloads are
 * `unknown` upstream and routinely carry full tool output (1 MB+ observed);
 * anything over the cap ships summary-only with `payloadTruncated`.
 */
export const ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES = 16 * 1024;

/** Cap on a resumption brief (markdown chars) — a brief is a briefing, not a dump. */
export const ROAMING_BRIEF_MAX_CHARS = 20_000;

/** Attachment bytes do not roam (v1): names render, content is unavailable. */
export const RoamingTranscriptAttachment = Schema.Struct({
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type RoamingTranscriptAttachment = typeof RoamingTranscriptAttachment.Type;

export const RoamingTranscriptMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(RoamingTranscriptAttachment)),
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});
export type RoamingTranscriptMessage = typeof RoamingTranscriptMessage.Type;

export const RoamingTranscriptActivity = Schema.Struct({
  id: EventId,
  tone: Schema.Literals(["info", "tool", "approval", "error"]),
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  /** JSON-encoded activity payload; absent when it exceeded the per-activity cap. */
  payloadJson: Schema.optional(Schema.String),
  payloadTruncated: Schema.optional(Schema.Boolean),
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});
export type RoamingTranscriptActivity = typeof RoamingTranscriptActivity.Type;

export const RoamingTranscriptPlan = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type RoamingTranscriptPlan = typeof RoamingTranscriptPlan.Type;

/** Payload of blob kind=transcript (key=threadId), JSON-encoded. */
export const RoamingTranscriptPayload = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  threadId: ThreadId,
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(Schema.String),
  capturedAt: IsoDateTime,
  /** Thread creation/update timestamps on the authoring machine. */
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Terminal state of the newest turn at capture time, when one exists. */
  lastTurnState: Schema.optional(Schema.Literals(["running", "interrupted", "completed", "error"])),
  /** Set by park: this thread was deliberately handed off (a brief exists or is coming). */
  parked: Schema.optional(Schema.Boolean),
  /**
   * Tombstone: the authoring machine deleted (or archived) the thread. All
   * content arrays ship empty; receivers drop the row from their lists.
   */
  deleted: Schema.optional(Schema.Boolean),
  /** Set when the whole-payload cap forced dropping oldest entries. */
  truncated: Schema.optional(Schema.Boolean),
  messages: Schema.Array(RoamingTranscriptMessage),
  proposedPlans: Schema.Array(RoamingTranscriptPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(RoamingTranscriptActivity).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type RoamingTranscriptPayload = typeof RoamingTranscriptPayload.Type;

/**
 * Payload of blob kind=brief (key=threadId), JSON-encoded. Generated by the
 * background text-generation facility at park (never as a thread turn), then
 * user-editable: an edit writes a new blob version with `editedAt` set —
 * ordinary newest-wins reconciliation, either machine may edit.
 */
export const RoamingBriefPayload = Schema.Struct({
  schemaVersion: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  threadId: ThreadId,
  workspaceProjectId: WorkspaceProjectId,
  markdown: Schema.String,
  generatedAt: IsoDateTime,
  editedAt: Schema.optional(IsoDateTime),
});
export type RoamingBriefPayload = typeof RoamingBriefPayload.Type;

/**
 * A mirrored thread as shown in its project's thread list — summary data
 * from the local transcript blob copy; rendering never requires a live
 * peer. Threads authored by THIS machine are not surfaced (the local
 * thread shell is authoritative); `deleted` upserts tell receivers to drop
 * the row.
 */
export const RoamingThreadShell = Schema.Struct({
  threadId: ThreadId,
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  authorEnvironmentId: EnvironmentId,
  capturedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  lastTurnState: Schema.optional(Schema.Literals(["running", "interrupted", "completed", "error"])),
  parked: Schema.optional(Schema.Boolean),
  hasBrief: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deleted: Schema.optional(Schema.Boolean),
});
export type RoamingThreadShell = typeof RoamingThreadShell.Type;

/** Local (user-session) RPC: full mirrored transcript + brief for one thread. */
export const RoamingThreadTranscriptRequest = Schema.Struct({
  threadId: ThreadId,
});
export type RoamingThreadTranscriptRequest = typeof RoamingThreadTranscriptRequest.Type;

export const RoamingThreadTranscriptResponse = Schema.Struct({
  /** Null when no transcript blob exists locally for the thread. */
  transcript: Schema.NullOr(RoamingTranscriptPayload),
  brief: Schema.NullOr(RoamingBriefPayload),
  /** Author of the transcript record, for the "from <machine>" label. */
  authorEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type RoamingThreadTranscriptResponse = typeof RoamingThreadTranscriptResponse.Type;

/**
 * Local (user-session) RPC: park a LOCAL thread — force a final transcript
 * capture (marked `parked`), generate the resumption brief, request a final
 * WIP capture when WIP consent is on (skip-not-fail, surfaced in
 * `notices`). Returns the written brief for immediate editing.
 */
export const RoamingThreadParkRequest = Schema.Struct({
  threadId: ThreadId,
});
export type RoamingThreadParkRequest = typeof RoamingThreadParkRequest.Type;

export const RoamingThreadParkResponse = Schema.Struct({
  brief: RoamingBriefPayload,
  /** Honest caveats that are not failures ("WIP snapshot skipped: sync is off"). */
  notices: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type RoamingThreadParkResponse = typeof RoamingThreadParkResponse.Type;

/** Local (user-session) RPC: save an edited brief (new blob version, newest-wins). */
export const RoamingBriefSaveRequest = Schema.Struct({
  threadId: ThreadId,
  markdown: Schema.String.check(Schema.isMaxLength(ROAMING_BRIEF_MAX_CHARS)),
});
export type RoamingBriefSaveRequest = typeof RoamingBriefSaveRequest.Type;

export const RoamingBriefSaveResponse = Schema.Struct({
  brief: RoamingBriefPayload,
});
export type RoamingBriefSaveResponse = typeof RoamingBriefSaveResponse.Type;

// ── Registry entry payload (kind=registry, key=workspaceProjectId) ──

export const RoamingRegistryPayload = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  title: TrimmedNonEmptyString,
  repository: RepositoryIdentity,
  // `defaultBranch` and `vaultOverrides` were retired 2026-07-22 (S4);
  // Schema.Struct tolerates unknown keys on decode, so blobs minted by
  // pre-fix machines still parse. No migration.
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
  /**
   * Advisory per-machine activity (from kind=lease blobs), newest first.
   * Powers the "active on <machine>, snapshot <age> ago" chip; freshness
   * is judged against ROAMING_LEASE_ACTIVE_WINDOW_MS.
   */
  activity: Schema.Array(RoamingProjectActivity).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
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
  "restore-wip",
  "apply-vault",
  "register-project",
  /** Recorded as skipped until M6 lands bootstrap recipes. */
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
  /** Default ON; skipped when the snapshot tree equals the clone HEAD tree or the target tree is dirty. */
  restoreWip: Schema.optional(Schema.Boolean),
});
export type RoamingMaterializeRequest = typeof RoamingMaterializeRequest.Type;

export const RoamingMaterializeResponse = Schema.Struct({
  materialization: RoamingMaterializationRecord,
});
export type RoamingMaterializeResponse = typeof RoamingMaterializeResponse.Type;

export const RoamingWipStatusEntry = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  mode: Schema.Literals(["origin-refs", "bundle"]),
  lastCapturedAt: Schema.optional(IsoDateTime),
  lastPushedAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(Schema.String),
  /**
   * Why the last incoming snapshot was NOT applied — plain language,
   * enumerated by the apply classifier (local edits, peer on another
   * branch, divergence, legacy/invalid snapshot, agent turn in flight).
   */
  blockedReason: Schema.optional(Schema.String),
  /**
   * The blocked snapshot can be reproduced explicitly after parking local
   * work. Set only for blocks takeover can actually service (M4) — an
   * in-flight local turn or an unusable snapshot blocks without it.
   */
  takeoverAvailable: Schema.optional(Schema.Boolean),
  /** The peer snapshot commit that produced blockedReason; echo it in takeover requests. */
  blockedSnapshotOid: Schema.optional(Schema.String),
  /** Author environment of that snapshot. */
  blockedFrom: Schema.optional(EnvironmentId),
  /**
   * Set when the block is a two-sided divergence: both machines moved the
   * same branch. The divergence routes below render and resolve it;
   * takeover remains the "just take theirs" shortcut.
   */
  divergenceAvailable: Schema.optional(Schema.Boolean),
  /**
   * Degraded-but-working advisory (M3.7): set while file watching is
   * unavailable (inotify budget) and capture runs on the short sweep
   * instead. Informational — sync still works, unlike lastError.
   */
  notice: Schema.optional(Schema.String),
  /** Set when auto-apply last fast-forwarded this checkout (M3.5). */
  lastAppliedAt: Schema.optional(IsoDateTime),
  /** environmentId whose snapshot was last auto-applied here. */
  lastAppliedFrom: Schema.optional(EnvironmentId),
});
export type RoamingWipStatusEntry = typeof RoamingWipStatusEntry.Type;

export const RoamingWipTakeoverRequest = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  /**
   * The snapshot the user was shown (status `blockedSnapshotOid`). When
   * set, takeover refuses instead of applying a newer snapshot that
   * arrived between render and click; omitted, newest wins (M3.8
   * behavior, kept for the CLI/harness).
   */
  snapshotOid: Schema.optional(Schema.String),
});
export type RoamingWipTakeoverRequest = typeof RoamingWipTakeoverRequest.Type;

export const RoamingWipTakeoverResponse = Schema.Struct({
  applied: Schema.Boolean,
  /** Plain-language explanation when `applied` is false. */
  reason: Schema.optional(Schema.String),
});
export type RoamingWipTakeoverResponse = typeof RoamingWipTakeoverResponse.Type;

// ── Divergence (M4) ─────────────────────────────────────────────────
//
// Two-sided divergence: both machines moved the same branch. Resolution is
// diff-and-choose — the user picks a whole side, never a merge — and the
// losing side always stays recoverable as a local ref. This screen is the
// trust story of the feature; nothing here may auto-resolve.

/**
 * One side of a divergence: that machine's branch/HEAD and newest WIP
 * snapshot, plus a unified patch from the common ancestor (`baseOid`) to
 * the snapshot tree. Patches ride the checkpoint-diff pipeline and share
 * its size cap; `truncated` marks a capped patch.
 */
export const RoamingWipDivergenceSide = Schema.Struct({
  branchRef: Schema.String,
  headOid: Schema.String,
  snapshotOid: Schema.String,
  capturedAt: IsoDateTime,
  patch: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
});
export type RoamingWipDivergenceSide = typeof RoamingWipDivergenceSide.Type;

export const RoamingWipDivergence = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  /** Merge-base of the two HEADs — the diff base for both patches. */
  baseOid: Schema.String,
  local: RoamingWipDivergenceSide,
  peer: Schema.Struct({
    ...RoamingWipDivergenceSide.fields,
    environmentId: EnvironmentId,
  }),
});
export type RoamingWipDivergence = typeof RoamingWipDivergence.Type;

export const RoamingWipDivergenceRequest = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
});
export type RoamingWipDivergenceRequest = typeof RoamingWipDivergenceRequest.Type;

/** `divergence` is null when the project is not currently diverged. */
export const RoamingWipDivergenceResponse = Schema.Struct({
  divergence: Schema.NullOr(RoamingWipDivergence),
});
export type RoamingWipDivergenceResponse = typeof RoamingWipDivergenceResponse.Type;

export const RoamingWipDivergenceResolveRequest = Schema.Struct({
  workspaceProjectId: WorkspaceProjectId,
  pick: Schema.Literals(["local", "peer"]),
  /**
   * The exact peer snapshot being resolved. A newer snapshot arriving
   * between render and click refuses instead of being silently chosen.
   */
  peerSnapshotOid: Schema.String,
});
export type RoamingWipDivergenceResolveRequest = typeof RoamingWipDivergenceResolveRequest.Type;

export const RoamingWipDivergenceResolveResponse = Schema.Struct({
  resolved: Schema.Boolean,
  /**
   * Local ref preserving the losing side: the per-branch parked ref when
   * the peer side won, `refs/t3/wip-rejected/<wsid>/<envid>` (the
   * REJECTED peer's environmentId) when the local side won.
   */
  preservedRef: Schema.optional(Schema.String),
  /** Plain-language explanation when `resolved` is false. */
  reason: Schema.optional(Schema.String),
});
export type RoamingWipDivergenceResolveResponse = typeof RoamingWipDivergenceResolveResponse.Type;

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

/**
 * Long-poll for blob-store changes (M3.7). Mirror connectivity is
 * one-directional (the pairing initiator holds the only credential/URL
 * pair), so the machine that CANNOT be reached needs a way to make its
 * writes visible immediately: the reachable side holds this request open
 * and re-runs a mirror pass when the response reports a new revision.
 * The revision is an in-memory per-boot counter — only ever compared for
 * inequality, never interpreted.
 */
export const RoamingWaitChangesRequest = Schema.Struct({
  sinceRevision: Schema.NullOr(Schema.Int),
});
export type RoamingWaitChangesRequest = typeof RoamingWaitChangesRequest.Type;

export const RoamingWaitChangesResponse = Schema.Struct({
  revision: Schema.Int,
});
export type RoamingWaitChangesResponse = typeof RoamingWaitChangesResponse.Type;

// ── Enrollment RPCs ──────────────────────────────────────────────────

/**
 * Sync choices made in the pairing dialog (M2.5). Travels with the unified
 * handshake so one pairing action configures both machines. A peer applies
 * received options only when it has no enrolled peers yet (first pairing) —
 * an explicit prior choice on a machine is never overridden remotely.
 */
export const RoamingPairSyncOptions = Schema.Struct({
  /** Maps to the `roamingSecretsSync` setting (vault capture consent). */
  secretsSync: Schema.optional(Schema.Boolean),
  /** Maps to the `roamingWipSync` setting (WIP snapshot consent). */
  wipSync: Schema.optional(Schema.Boolean),
  /** Maps to the `roamingTranscriptSync` setting (conversation mirroring consent, M5). */
  transcriptSync: Schema.optional(Schema.Boolean),
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
  /**
   * The label the peer's user gave the pairing link ("Laptop") — the name
   * the user chose ALWAYS wins over machine-derived names downstream.
   */
  label: Schema.optional(TrimmedNonEmptyString),
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
export const ROAMING_MIRROR_WAIT_PATH = "/api/roaming/mirror/wait";
export const ROAMING_MACHINE_CREDENTIAL_PATH = "/api/roaming/machine-credential";
export const ROAMING_PEERS_PATH = "/api/roaming/peers";
export const ROAMING_PEERS_LIST_PATH = "/api/roaming/peers/list";
export const ROAMING_PEERS_REMOVE_PATH = "/api/roaming/peers/remove";
export const ROAMING_PEERS_SYNC_PATH = "/api/roaming/peers/sync";
export const ROAMING_HANDSHAKE_COMPLETE_PATH = "/api/roaming/handshake-complete";
export const ROAMING_ENROLL_PROJECT_PATH = "/api/roaming/projects/enroll";
export const ROAMING_MATERIALIZE_PATH = "/api/roaming/materialize";
export const ROAMING_WIP_TAKEOVER_PATH = "/api/roaming/wip/takeover";
export const ROAMING_WIP_DIVERGENCE_PATH = "/api/roaming/wip/divergence";
export const ROAMING_WIP_DIVERGENCE_RESOLVE_PATH = "/api/roaming/wip/divergence/resolve";
export const ROAMING_THREAD_TRANSCRIPT_PATH = "/api/roaming/threads/transcript";
export const ROAMING_THREAD_PARK_PATH = "/api/roaming/threads/park";
export const ROAMING_BRIEF_SAVE_PATH = "/api/roaming/briefs/save";
