# Roaming workspace — technical reference

Current-state mechanics that bind future work: schemas, ref namespaces,
invariants, harness facts. Updated alongside code changes (document-hygiene
step of the plan's execution process). No narrative — results and rationale
live in `21-roaming-history.md`. Items marked **(M3.8)** are decided but not
yet built.

## Harness + acceptance

- `scripts/roaming/harness.sh start|stop|status` — two `t3 serve` instances
  from source on `127.0.0.1:14801/14802`, base dirs under
  `/tmp/t3-roaming-harness/instance-{a,b}/basedir`, distinct persisted
  environment-ids; state in `<baseDir>/userdata`; never pass
  `--tailscale-serve`.
- The harness serves the PREBUILT `apps/web/dist` bundle — rebuild
  (`cd apps/web && pnpm run build`) after web changes or browser walks test
  stale UI. Headless web login: the `/pair` page + a one-time admin code.
- Acceptance scripts: `accept-m1/m2/m2.5/m3/m35/m36/m37/m37-stress.mjs`
  (+ `accept-m38.mjs` arriving with M3.8). `accept-m2.5.mjs` is the
  canonical-workflow re-run every milestone ends with. Server-to-server auth
  smoke test: `scripts/roaming/spike-server-to-server.mjs`.
- Run discipline: scripts and logs under /tmp, fresh harness state per
  acceptance script, no compound one-liners; stale accept-script semantics
  get revised with the milestone that changed them, never worked around.
- Timing instrumentation is permanent: every delivery stage logs a
  `roaming timing:` line keyed by commitOid/blob version (watch-trigger,
  captured, origin-pushed, beacon-written, mirror-exchange + trigger source,
  blobs-pushed-to-peer, wip-blob-ingested, arrival trigger,
  peer-refs-fetched, apply). Slow deliveries must be attributable from the
  two server.log files alone. Beacon write failure logs a WARNING.
- Honest steady-state delivery: ~5.5s (5s watch debounce + ~0.5s chain);
  ~0.5s riding another trigger; 60s mirror interval is the guarantee.

## Flags + settings

- `roaming` — ServerSettings boolean, default false. Reactors always start
  and internally no-op while off. Flag-off: shell snapshots (ws AND HTTP
  `GET /api/orchestration/shell`) strip all roaming fields; roaming routes
  404 EXCEPT the two pairing routes; local blob data is retained.
- `roamingWipSync` — default false (WIP reaches the origin host; consent
  required). The pairing dialog's pre-checked "Work in progress" row is the
  consent, ONE decision applied to both machines (same rule as Secret
  files). The per-environment settings row writes its OWN machine only;
  propagation happens only in the pairing handshake — machines paired
  before M3 must enable it on both machines (or re-pair). Reactor gates
  `roaming && roamingWipSync` per pass; statuses clear on disable.
- `roamingSecretsSync` — per-machine capture consent, propagated at pairing
  (the paired-into machine has no settings UI for it — flagged for a future
  Authorized-clients sync row).
- The settings file stores non-default values only: a boolean set to its
  default reads back as absence.
- Settings freshness: an unconditional 2s mtime poll backs the settings
  watcher; an external settings.json edit is honored within ~2–4s even with
  zero inotify budget.

## Ref namespaces (`refs/t3/*`)

- `refs/t3/wip/<wsid>/<envid>` — latest WIP snapshot per (project, machine);
  local and, in origin mode, on the primary remote. Ref components
  validated `[A-Za-z0-9._-]`.
- `refs/t3/wip-pushed/<wsid>/<envid>` — local record of the last
  successfully origin-pushed snapshot: the force-with-lease expectation, a
  capture no-op baseline, and the "last shipped" base in per-file merge.
  Written only after a successful push, never by bundle mode.
- `refs/t3/wip-applied/<wsid>` — project-scoped (NOT per-peer; fine at 2
  machines, revisit at 3+) record of incoming state consumed by this
  checkout. Supplies the `T3-Based-On` trailer on capture and the primary
  per-file merge base. After a conflicted pass it points to a synthetic
  commit with conflicted paths pinned to base.
- `refs/t3/wip-history/<wsid>/<envid>/<slot>` — 20 local rolling retention
  slots, oldest overwritten; never pushed.
- `refs/t3/wip-parked/<wsid>/<branch>` — **(M3.8)** per-branch parked local
  state, written before any auto/explicit branch switch; restored on return
  to that branch.
- `refs/t3/checkpoints/<base64url-threadId>/turn/<n>` — thread-turn
  checkpoints (upstream checkpointing subsystem, not roaming's).
- The origin holds only the newest WIP snapshot per (project, machine); the
  default fetch refspec never sees `refs/t3/*`; WIP fetches are explicit.

## Blob store + mirror

- Record shape (D3): `{ schemaVersion, kind, key, workspaceProjectId,
  version (monotonic per key), contentHash, authorEnvironmentId, updatedAt,
  payload }` in SQLite `roaming_blobs`. Payload strings are
  byte-authoritative for hashing — never re-serialize before hashing. The
  store serializes read-modify-write and verifies `contentHash` on ingest.
  Conflict records retain the full remote record.
- Key derivation per kind: registry/vault/recipe/lease →
  `<wsid>`; wip → `<wsid>/<envid>`; transcript/brief → `<threadId>`.
- Reconciliation: per key, higher version wins; same version + different
  hash = surfaced conflict, never auto-merge. Conflict get/resolve routes
  require `access:write` (they carry secret payloads); resolution picks a
  side, written as a new higher version.
- Mirror RPCs = raw authenticated HTTP routes (schemas in
  `packages/contracts/src/roaming.ts`): `syncManifest`, `fetchBlobs`,
  `pushBlobs`, plus `POST /api/roaming/mirror/wait` (long-poll, ≤25s
  against an in-memory per-boot change revision; 40s client cap; 15s
  failure backoff). All mirror routes: roaming flag off → 404,
  `roaming:mirror` scope required, paused peer → 403. `roaming:mirror` is
  granted nowhere by default and NOT requestable via `/oauth/token`.
  Enrollment/administrative routes require `access:write`.
- Mirror connectivity is ONE-directional by design (callee holds no
  credential/URL for the initiator). PeerMirror runs on startup, 60s
  interval, local blob writes, and one waiter fiber per reachable enabled
  peer (atomic claim; self-terminates on pause/remove/roaming-off;
  reconciled every drain pass + 30s scan). The interval is the delivery
  guarantee; the waiter is the fast path.
- No server-side peer endpoint discovery: peer base URLs recorded at
  pairing, tried in order.
- `lastMirrorContactAt` = global max across peers, written only by a
  completed mirror pass.
- Roaming shell stream events ride `sequence: 0`; the client reducer owns
  sequencing.
- `workspaceProjectId` is persisted in the SQL projection path and carried
  by shell projections (sync pill depends on it).

## Pairing + peers

- ONE handshake, orchestrated by the initiator's server
  (`POST /api/roaming/peers`): exchange the single-use code at the peer's
  `/oauth/token` with NO scope parameter; with `access:write` it mints the
  365-day `roaming:mirror` credential AND a standard attach bearer; without
  it, attach-only with a typed reason (first-class outcome). The handshake
  session self-revokes via `POST /api/roaming/handshake-complete`.
- Peers/machine-credential routes are NOT gated on the `roaming` flag —
  pairing is what turns it on.
- Peer-introduction seam: `PeerIntroduction` + `registerBearerGrant` in
  `packages/client-runtime`; the manual dialog is producer #1, cloud
  discovery later constructs the same value.
- Sync on/off = `sync_enabled` on the peer row: gates outbound passes AND
  inbound mirror RPCs (403) while the credential survives. Codes are only
  for the first enable on an unpaired machine.
  `POST /api/roaming/peers/{list,sync,remove}`; Remove = full teardown
  (row + credential + revoke the peer's inbound sessions).
- One device = one Authorized-clients row (credentials collapse; user's
  pairing label wins over hostnames).
- Callee-side peer records are tamper-resistant: `ensurePeer` insert-only,
  callers' advertised base URLs ignored. Initiator side deliberately not.
- Materialize on remote-only rows: enabled-iff-workable,
  disabled-with-reason otherwise; fetches registry + vault blobs on demand;
  auto-trusts well-known SSH host keys (github/gitlab/bitbucket/azure);
  prompts once for a projects folder. Revoked/auth-failed remotes leave the
  merged list and their mirrored offline+Materialize rows surface.
- Credential hygiene: bearer responses `cache-control: no-store`; tokens
  never logged; all network steps complete before anything persists.
- `RoamingAutoEnroll` triggers on startup, peer-added (both directions),
  `project.created`, settings changes; skips any workspaceRoot that is a
  materialization target path. `project.roaming.enroll` dispatches before
  the registry blob write; re-enroll is idempotent and self-heals a missing
  blob. `ensureRegistryRoot` merges `perMachineRoots` on raw JSON so
  newer-schema peers' fields survive.

## Vault

- Bundle = JSON `{ schemaVersion, capturedAt, files: [{ path, mode, sha256,
  contentBase64 }] }`; cap = total decoded bytes
  (`ROAMING_VAULT_BUNDLE_MAX_BYTES`, 16 MiB), enforced from `stat` before
  any read; oversize captures are skipped with a surfaced warning, never
  truncated.
- Effective vault set: global `<stateDir>/t3sync` (defaults written once,
  never regenerated) + optional repo-root `.t3sync` (user-created only),
  matched by git's own exclude engine global-then-project (project lines
  win, incl. `!` negation). A file is captured only if manifest-matched AND
  untracked per `git ls-files` (`check-ignore` is the wrong tool — flags
  committed lookalikes). Fail-closed: a genuine ls-files failure skips
  capture.
- Symlinks are never captured; apply refuses symlinked targets/parents
  outside the workspace root; new files written with their mode up front.
- Vault content is P2P-only — never reaches the origin host. WIP capture
  subtracts the effective vault set from its temp index (untracked
  candidates only; removing a tracked path would make restore delete it).
- Delivery on arrival + startup catch-up, per file: missing → write; equal
  to incoming → align; equal to what WE last applied (per-file sha256
  record under `<stateDir>/vault-applied/<wsid>.json`) → update; anything
  else = local edit, never overwritten (notice). Peer-deleted files are NOT
  deleted locally (v1 accepted gap). Receiver gate = `roaming` only (the
  capturing machine's consent decided the bundle's contents).
- Capture triggers: fs watch + 30s interval backbone (the watcher is an
  optimization, never a guarantee).

## WIP sync

### Capture

- Temp-index recipe in `roaming/WipSnapshots.ts` (NOT the driver op): seed
  from HEAD, `add -A`, subtract vault set, `write-tree`, `commit-tree` with
  **parent = HEAD** (thin bundles are ancestry-based; also M5's common
  ancestor) and `T3-Based-On: <applied-marker oid>` trailer; returns
  `{ commitOid, treeOid }`. Real index and worktree untouched. Fixed
  author/committer identity.
- **(M3.8)** payload v2 adds `branchRef` (symbolic HEAD; sentinel for
  detached/unborn) and `headOid`. Origin refs get this context from the
  mirrored beacon only on an exact `(refName, commitOid)` match; a ref with
  no matching v2 metadata is legacy. Legacy payloads never auto-apply.
- The WIP ref mirrors the worktree tree even when clean (a stale dirty
  snapshot must never shadow committed work). No-op baseline = last SHIPPED
  tree (`wip-pushed` marker in origin mode; the wip blob's `treeOid` in
  bundle mode). The applied-marker tree counts as a no-op baseline ONLY
  while it equals the last-shipped tree (unconditional, it deadlocked
  deletions). A tree identical to the last shipped one still ships ONCE
  when the applied marker has moved (causality re-ship), then settles.
- Untracked files over `ROAMING_WIP_MAX_FILE_BYTES` (50 MiB) are excluded
  with a surfaced warning that survives real push errors.
- Triggers: per-directory fs watch (5s debounce), 2-min interval sweep
  (also the only trigger under sustained sub-5s write storms), settings
  enable, `thread.turn-diff-completed`, `project.meta-updated` carrying a
  workspaceProjectId (enrollment), graceful shutdown (one bounded final
  capture+ship per project, 10s cap, 4-wide). Keyed-coalesced per project;
  skips while MERGE/REBASE/CHERRY_PICK markers exist. Thread worktrees live
  under `<baseDir>/worktrees/`, outside project roots — excluded by
  construction.
- Watcher budget (Linux): per-DIRECTORY registration skipping
  `.git`/`node_modules`/`dist`/`build`/`target`/`out`/`.venv`/`__pycache__`
  at registration; 4096-dir cap per project; macOS/Windows keep native
  recursive. Watch death or cap → 10s capture sweep + `notice` on the
  status entry + real-watch retry ~5 min — never a silent fall to the 2-min
  interval. Notices live in reactor state; passes cannot wipe them.

### Transport

- Origin mode (default): `git push <remote> <ref>:<ref>
  --force-with-lease=<ref>:<expected>` where expected = the `wip-pushed`
  marker (empty = expect absent). Lease-shaped rejection → fetch-adopt the
  remote value into the marker, retry once. Permission-shaped stderr
  classifies BEFORE lease-shaped (git prints lease lines on denials too);
  permission → bundle mode (in-memory only, re-probed each boot); other
  failures stay origin mode and surface. Successful pushes ALSO write an
  empty-bundle beacon blob (metadata only) — peers run the project's apply
  pass on any arriving wip blob; importers skip empty-bundle payloads.
- Bundle mode (fallback): `git bundle create <ref> --not --remotes=<remote>`
  → blob kind=wip, payload `{ schemaVersion, capturedAt, refName,
  commitOid, treeOid, bundleBase64 }` (+ v2 fields, M3.8), capped by
  `ROAMING_WIP_BUNDLE_MAX_BYTES` (8 MiB); oversize skipped with a surfaced
  warning.

### Apply

- **(M3.8 — replaces the shipped timestamp gates)** Context classifier by
  ancestry: same-context → per-file merge below; fast-forward (same branch,
  peer HEAD descendant, untouched checkout) → `merge --ff-only` + diff on
  top; different branch (untouched, ff-safe) → park, switch, apply;
  peer-behind → skip; diverged/detached/legacy → blocked. Untouched =
  worktree tree equals applied-marker tree (or HEAD when no marker exists) +
  no in-progress git op + no in-flight agent turn. The in-flight guard uses
  a project-level projection query joining threads to sessions. Every blocked
  case sets a specific `blockedReason` and surfaces the takeover action. The
  shipped "strictly newer than HEAD" committer-timestamp staleness gate is
  DELETED with M3.8, not kept alongside. Newest-peer selection across
  environments stays committer-timestamp (fine at 2 machines).
- Per-file merge (M3.7, survives as the same-context path): base =
  applied marker, else HEAD, else empty tree; peer changes via
  `git diff --name-status --no-renames <base> <peer>`. Per path with
  `{ baseOid, peerOid, ourOid(worktree hash) }`: ours=peer → skip; local
  changed + peer unchanged → keep local silently; both changed → conflict,
  keep ours, surface; local untouched + peer deleted → remove; local
  untouched + peer content → `git restore --source=<peer> --worktree`;
  path occupied by a directory/conflicting parent → conflict. Apply never
  touches HEAD, branch refs, or the real index (pre-M3.8; M3.8 adds the
  explicit ff/switch cases above).
- Deletion invariants (each was a field bug): (1) the applied marker
  advances EVERY pass that applies or records conflicts — clean passes to
  the peer snapshot, conflicted passes to a synthetic commit with only the
  conflicted paths pinned to base (dated 1s before the peer snapshot) — so
  one conflict can never unrecord another file's arrival. (2) Peer-absence
  counts as a deletion beyond the marker diff only for paths we SHIPPED and
  only when the peer's `T3-Based-On` state provably contained the path.
  (3) See the causality re-ship rule under Capture.
- TOCTOU guard: destructive decisions re-verify against a fresh worktree
  tree in the last instant before writing.

### Status surfacing

- `roamingWipStatus` per project: `{ mode, lastCapturedAt, lastPushedAt,
  lastError?, blockedReason?, notice?, lastAppliedAt?, lastAppliedFrom? }`,
  merged at BOTH shell surfaces (ws subscribe point and HTTP shell route);
  flag-off = empty. Baseline publish on a project's first pass; seeds into
  resumed ws subscriptions; after restart, activity timestamps reconstruct
  from marker-ref commit dates (git is the durable store).
- Sync pill priority: error (red) > blocked (amber, plain-language
  guidance) > notice (amber) > recent activity (brief green) > idle.
  Concept-free copy — no "roaming"/"sync engine" wording.
- `blockedReason` is cleared on every non-blocked pass. **(M3.8)** adds the
  enumerated branch-context reasons ("peer is on <branch>", "peer moved
  <branch> forward; you have local edits", divergence, legacy snapshot).

## Materialize

- Synchronous `POST /api/roaming/materialize` + resumable idempotent step
  machine in `roaming_materializations`: resolve-path → clone →
  restore-wip → apply-vault → register-project → bootstrap (M4). Failed
  runs return the failed record over HTTP 200; resume continues from the
  failed step. Progress = step-machine PubSub merged at the shell subscribe
  point.
- A completed record short-circuits ONLY while its targetPath still holds a
  git checkout AND the registered project is live; otherwise a fresh run.
- restore-wip runs BEFORE apply-vault (cleanliness check + `git clean -fd`
  operate on the pristine clone; the file sets are disjoint by the vault
  subtraction). `restoreWip` flag defaults ON (pre-checked checkbox).
  Sources: origin `refs/t3/wip/<wsid>/*` (explicit fetch) then wip blobs
  (one on-demand mirror pull); newest committer date across environments
  wins; skip-not-fail on dirty target / equal tree / nothing found /
  disabled; an older-than-HEAD snapshot may legitimately win (recorded
  notice with age + authoring machine). Restore goes through checkpoint
  restore (whole tree; staged/unstaged flattened; `git clean -fd`; index
  reset to HEAD; HEAD itself never moves) and then writes the applied
  marker. **(M3.8)** if the snapshot's branch differs from the clone's
  default branch, create + switch to it at the snapshot's `headOid` first.
- apply-vault never overwrites an existing differing file (notice;
  interactive overwrite belongs to the on-demand "pull vault files" path),
  and uses the recording variant so its files stay updatable by later
  vault delivery.

## Accepted risks / known limits

- Cloned state dir (two machines, one environmentId) → WIP ref ping-pong;
  re-install orphans one origin ref per abandoned environmentId (prunable
  by hand).
- A manual CLI commit fires no domain event: a stale dirty snapshot can
  outlive it by up to one interval tick.
- Peer clock skew can defeat timestamp-based newest-peer selection
  (recoverable via refs; the dangerous decisions move to ancestry with
  M3.8).
- Two machines materializing from the same registry version → equal-version
  conflict (disjoint perMachineRoots not auto-merged).
- Initiator-side environmentId clobber; first-pairing settings TOCTOU
  (rationale in history).
- Total inotify-instance exhaustion at server boot crashes upstream watch
  paths before roaming runs (M3.7 removed the dominant consumer; state now
  unlikely).
- Base-diff peer deletions with NO applied marker yet are not
  Based-On-gated (narrow: markers appear on first exchange).
- Stashes, in-progress rebases, the staged/unstaged split, reflog, and
  other local branches do not roam **(scope, restated by M3.8)**. Both
  machines must run ≥M3.8 builds before branch-aware behavior holds
  end-to-end.
