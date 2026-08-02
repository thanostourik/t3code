# Roaming workspace — technical reference

Current-state mechanics that bind future work: schemas, ref namespaces,
invariants, harness facts. Updated alongside code changes (document-hygiene
step of the plan's execution process). No narrative — results and rationale
live in `21-roaming-history.md`.

## Fork surface (upstream-file discipline)

- Roaming code lives in roaming-owned files; touches to upstream files are
  a cost to minimize (rebases are continuous). **Rule since 2026-08-02:**
  when roaming needs more than ~20 lines inside a file upstream also
  edits, it goes behind a seam in a roaming-owned module and the upstream
  file keeps call sites only. Landed seams: `roaming/shellStream.ts`
  (ws.ts shell subscription — live-source buffer, snapshot overlay,
  warm-resume catch-up) and `components/roamingSidebar.tsx` (offline
  project rows, materialize hook/dialog, sync indicator, M5.5 mirrored
  rows). This cut ws.ts +317→+111 and Sidebar.tsx +847→+225.
- Replacements of upstream BEHAVIOR (not additions) cannot be seamed away
  and are permanent merge surface — currently `ConnectionsSettings.tsx`
  (one-device session grouping, merged remote-environment rows, unified
  handshake replacing `connectPairing`). Each traces to a locked product
  decision; keep the list short.
- Rebase reality check: the 2026-08-02 rebase (21 upstream commits,
  including ws.ts / Sidebar.tsx / ConnectionsSettings.tsx / Migrations.ts)
  conflicted in exactly ONE file — `serverRuntimeStartup.ts`, where each
  milestone's reactor registration replays against upstream's
  restructured startup. Resolution recipe: keep upstream's structure,
  re-graft the `const x = yield* X` dep and its
  `yield* x.start().pipe(Scope.provide(reactorScope))` line.

## Harness + acceptance

- `scripts/roaming/harness.sh start|stop|status` — two `t3 serve` instances
  from source on `127.0.0.1:14801/14802`, base dirs under
  `/tmp/t3-roaming-harness/instance-{a,b}/basedir`, distinct persisted
  environment-ids; state in `<baseDir>/userdata`; never pass
  `--tailscale-serve`.
- The harness serves the PREBUILT `apps/web/dist` bundle — rebuild
  (`cd apps/web && pnpm run build`) after web changes or browser walks test
  stale UI. Headless web login: the `/pair` page + a one-time admin code.
- `scripts/roaming/harness-lib.mjs` (2026-07-22, O6) owns the shared
  accept-script plumbing: instance layout, api/cli/git helpers (raw +
  trimmed git variants), admin login recipe, waitFor, settings/peer
  readers, D3 freshness preflight. Script semantics stay in the scripts.
- Acceptance scripts: `accept-m1.mjs`, `accept-m2.mjs`, `accept-m2.5.mjs`,
  `accept-m3.mjs`, `accept-m35.mjs`, `accept-m36.mjs`, `accept-m37.mjs`,
  `accept-m37-stress.mjs`, `accept-m38.mjs`, `accept-m4.mjs`,
  `accept-m5.mjs` (transcripts ride the P2P mirror only — no transport
  variants; includes a harness-restart leg asserting B's reconcile never
  tombstones A's transcripts; its resume leg predates M5.5 and now
  simulates only the server-visible half of resume — thread.create with
  the brief text — the product flow is the M5.5 draft; its park leg was
  replaced by a briefs/save leg when hand-off was removed 2026-07-31),
  `accept-m55.mjs` (M5.5 server-verifiable criteria: payload
  modelSelection, stateless zero-prep brief generation on B, supersession
  lifecycle incl. link-before-thread and restore-on-delete, and a
  tight-loop probe of the author delete-race window). The M5.5 UI
  criteria (one row per thread, greyed fallback, resume-as-draft) are
  client-side and were verified by a browser walk on the harness —
  headless caveat in Accepted risks.
  `accept-m56.mjs` walks the whole toggle story in ONE run (harness
  starts loopback; the script restarts instance B per leg via
  `T3_ROAMING_HARNESS_BIND`): pair while loopback-only → nothing
  registered (2026-07-31 field-bug regression); restart routable, NO
  re-pair → registration arrives over the standing channel; restart
  loopback → withdrawn + session revoked; restart routable → returns;
  then teardown both directions. M5.6 server-verifiable criteria: attach
  registration exists on the callee only and 404s pre-pairing; advertises
  no loopback URL; carries the
  initiator's envId/label/URLs with `no-store`; its token reads the
  initiator's shell but not admin routes; unpair on the initiator kills
  the token, unpair on the callee drops the registration). The M5.6 row
  presentation (live on the callee while the initiator is reachable,
  greyed fallback when not) is client-side and was verified by a browser
  walk on the harness — headless caveat in Accepted risks.
  `accept-m2.5.mjs` is the canonical-workflow re-run every milestone ends
  with. `accept-m38.mjs` and `accept-m4.mjs` run their origins with
  `receive.hideRefs refs/t3` (bundle fallback) by default and again with
  `T3_M38_TRANSPORT=origin` / `T3_M4_TRANSPORT=origin`; both runs must
  pass — the transports take different classifier baselines. `accept-m4`
  builds its divergence under the peer sync pause, which only fully stops
  exchange in bundle mode.
  Server-to-server auth
  smoke test: `scripts/roaming/spike-server-to-server.mjs`.
- WIP-classifier changes re-run the FULL ladder (m35–m38 + canonical),
  never just the current milestone's script — the earlier suites hold the
  earlier guarantees (the m35 no-clobber regression hid behind m38-only
  reruns for four days).
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

- `roaming` — DERIVED gate, not a stored setting (2026-07-22, D3): on iff
  at least one peer row exists (`RoamingPeers.roamingEnabled`, in-memory,
  refreshed on every peer mutation). Auto-on at first pairing, auto-off
  when the last peer is removed; reactors additionally wake on peer
  changes (no settings write happens at pairing). Reactors always start
  and internally no-op while off. Gate-off: shell snapshots (ws AND HTTP
  `GET /api/orchestration/shell`) strip all roaming fields; roaming routes
  404 EXCEPT the two pairing routes; local blob data is retained. The web
  UI derives roamingEnabled from the fetched peer list; acceptance
  scripts read `roaming_peers` from state.sqlite.
- `roamingWipSync` — default false (WIP reaches the origin host; consent
  required). The pairing dialog's pre-checked "Work in progress" row is the
  consent, ONE decision applied to both machines (same rule as Secret
  files). The per-environment settings row writes its OWN machine only;
  propagation happens only in the pairing handshake — machines paired
  before M3 must enable it on both machines (or re-pair). Reactor gates
  `roaming && roamingWipSync` per pass; statuses clear on disable.
- `roamingTranscriptSync` — default false; consent to mirror this
  machine's conversation transcripts (P2P only, never the origin host).
  The pairing dialog's pre-checked "Conversations" row is the consent,
  ONE decision applied to both machines (first-pairing-only on the
  callee, G8).
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
  commit with conflicted paths pinned to base and
  `T3-Peer-Snapshot: <peer oid>`.
- `refs/t3/wip-history/<wsid>/<envid>/<slot>` — 20 local rolling retention
  slots, oldest overwritten; never pushed.
- `refs/t3/wip-rejected/<wsid>/<envid>` — local pin of a peer snapshot
  rejected in divergence resolution (pick=local, M4); `<envid>` is the
  REJECTED peer's environmentId. Never pushed; keeps the losing side
  recoverable after the peer force-updates its moving wip ref.
- `refs/t3/wip-parked/<wsid>/<branch>` — per-branch parked local
  state, written before any auto/explicit branch switch. A branch transition
  observed in the running process restores a clean checkout whose HEAD equals
  the parked snapshot parent, then deletes the ref (one-shot). Startup never
  restores merely because a parked ref matches the current branch;
  advanced/dirty branches leave it untouched and recoverable. Every reactor
  pass checks the branch/HEAD tuple directly, while the 10s context poll is a
  fallback, so a peer event cannot race branch-return restoration.
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
- Key derivation per kind: registry/vault/recipe → `<wsid>`; wip/lease →
  `<wsid>/<envid>` (lease per-machine so two active machines never produce
  an equal-version conflict); transcript/brief → `<threadId>` (UUID —
  probabilistic cross-machine uniqueness accepted; author machine only).
- Wire kinds are PERMISSIVE (M5): the mirror envelopes (refs, manifests,
  records, push results) type `kind` as a plain string — a closed literal
  made every new kind a breaking wire change that wedged ALL sync against
  an older build. Unknown kinds are skipped by `diffManifests` and
  rejected as `stale` by `applyRemote`; the strict `RoamingBlobKind`
  literal stays the local typing for writes and rows.
- Reconciliation: per key, higher version wins; same version + different
  hash auto-resolves newest-updatedAt-wins (author-id tie-break — both
  machines pick the same winner), never content-merged; the loser is
  preserved in the conflict record and surfaced as a dismissible notice
  (dismissal keyed by detection). The manual conflict get/resolve API was
  deleted 2026-07-22 (zero UI callers). A local win over an equal-version
  remote does NOT republish the local record (mirror hot-loop fix, G2).
- Mirror RPCs = raw authenticated HTTP routes (schemas in
  `packages/contracts/src/roaming.ts`): `syncManifest`, `fetchBlobs`,
  `pushBlobs`, plus `POST /api/roaming/mirror/wait` (long-poll, ≤25s
  against an in-memory per-boot change revision; 40s client cap; 15s
  failure backoff; 30s timeout on manifest/fetch/push requests — a
  black-holed peer degrades to a failed pass, G7). All mirror routes:
  roaming gate off → 404,
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

## T3 Connect introduction (M6 — planned, not yet built)

- Facts established by the 2026-08-02 analysis pass (options and rejected
  alternatives in `.plans/scratch/t3-connect-roaming-analysis.md`):
  - Discovery is CLIENT-ONLY. A server's relay surface is limited to
    linking/unlinking its OWN tunnel (`/v1/client/environment-links` in
    `cloud/http.ts`); it cannot enumerate the user's environments, so a
    client must always perform the introduction.
  - A linked environment publishes a public `RelayManagedEndpoint
    { httpBaseUrl, wsBaseUrl }` via plain `cloudflared tunnel run`
    (`ManagedEndpointRuntime.ts`). The tunnel is a dumb reverse proxy to
    `localHttpHost:localHttpPort` — requests hit the server's own HTTP
    stack and its own auth, with no relay policy in the data path. A
    credential minted WITHOUT a proof thumbprint is therefore usable as
    an ordinary bearer over the public URL (no DPoP dependency for
    server-to-server mirror traffic).
  - The relay is an introducer, never an authority: `connectEnvironment`
    signs a short-lived mint proof that the ENVIRONMENT verifies
    (`cloudMintCredentialHandler`) against its own linked cloud user.
  - **Relay-brokered sessions cannot carry mirror authority**: that
    handler issues `AuthStandardClientScopes`, `ttl: 2 minutes`, bound to
    the client's proof key, gated on a cloud-signed `environment:connect`
    scope checked with `hasExactScope`. Widening it needs either T3's
    cloud (not ours) or a downgrade of our own verification (rejected).
- **Connect is OFF in source builds unless configured.** `publicConfig.ts`
  reads build-time defines injected by `apps/server/vite.config.ts` from
  the repo `.env` (`loadRepoEnv`): `T3CODE_RELAY_URL`,
  `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`,
  `T3CODE_CLERK_JWT_TEMPLATE`. Unset (this fork today) → Connect features
  are disabled entirely, which is why fork builds are not connected.
  These are PUBLIC values (a publishable key and a URL); `.env.example`
  documents them and forbids server-side secrets in that file. Release
  builds inject their own. A fork build therefore reaches whichever relay
  its `.env` names — official T3 Connect, or a self-hosted `infra/relay`
  deployment (in-tree, and its deploys write the URL back automatically).
- Environments are keyed by `baseDir` (`stateDir = <baseDir>/userdata`, or
  `dev` under a devUrl), so a fork build and an official install on the
  same machine are DIFFERENT environments with different environmentIds:
  both can link, both appear in the account, and both consume tunnel
  quota (`maxTunnels` is a per-account relay limit).
- Design consequence: M6 keeps `roaming_peers` as internal state (derived
  gate + pause + credential key) with Connect as a second producer behind
  the `PeerIntroduction` seam; Connect-introduced rows store no base URLs
  (the relay endpoint is authoritative, client-refreshed). Authorization
  comes from a fork-side same-account elevation route: proof that the
  request rides a session minted for THIS environment's own linked cloud
  user (`readInstalledCloudUserId`) + an explicit confirm on the target,
  then the ordinary D4 mirror credential is minted.
- Not changed by Connect: the blob store, reconciliation, vault/WIP/
  transcript mechanics, materialize, and the cloud-store milestone (M8) —
  Connect supplies discovery and transport, never a store.

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
- Attach registrations (M5.6, standing-channel model 2026-08-01 — NOT a
  handshake product): `ReverseAttach.ensureForPeer` runs after every
  successful mirror pass (PeerMirror hook, same credential + base URL the
  pass used). It compares the current advertised addresses against the
  last pushed signature (in-memory per boot; a restart re-pushes once —
  idempotent upsert): changed + non-empty → sweep old sessions with
  subject `roaming-peer:<peer>` on THIS machine (all such local sessions
  are reverse-attach ones), mint a standard-scoped 365-day session
  (label `<own label> — attach`), POST `RoamingAttachRegistration
  { environmentId, label, baseUrls, token, expiresAt }` to the peer's
  `POST /api/roaming/attach-registration`; empty (loopback-only bind,
  network access off) → `POST .../attach-registration/withdraw` + sweep,
  so the peer's clients fall back to honest offline. Register accepts the
  MIRROR credential with a tamper-narrow subject check (a session may
  only write the registration of the machine its subject names) or
  access:write; withdraw is mirror-credential-only (subject names whose
  registration goes); both deliberately NOT gated on sync pause (pause
  stops blob sync, never attach — same as forward). Registration is only
  accepted for an existing peer; self-registration rejected. 404
  (pre-M5.6 peer) revokes the unused session and settles until addresses
  change or restart; transient failures revoke and retry next pass;
  failures log failure TAGS only (bodies carry live bearers).
  Consequences: pairing order and pairing-time reachability don't
  matter; the network-access toggle drives everything (on → live within
  ~a mirror pass + client poll; off → withdrawn); pre-M5.6 pairings
  self-heal on upgrade with no new handshake. Advertised URLs come from `advertisedBaseUrls` in
  `startupAccess.ts` — only URLs the socket listens on AND that mean
  something to a PEER: routable specific bind → that address; wildcard →
  external IPv4 interfaces; actual port from the persisted server-runtime
  state (config fallback). **Loopback is never advertised** (2026-07-31
  field bug): `127.0.0.1` names the READER's machine, whose own backend
  answers as the wrong environment and pins the row on "connected
  environment X does not match Y". A loopback-only server (desktop
  Network access off → `--host 127.0.0.1`) therefore advertises NOTHING,
  and the reverse half is skipped before minting — pairing degrades to
  one-directional with a warning naming the fix (enable network access,
  re-pair).
- Peer-side storage: `roaming_attach_registrations` (migration 042 —
  environment_id PK, label, base_urls JSON, expires_at, registered_at);
  token in ServerSecretStore `roaming-attach-<envId>` (written BEFORE
  the row). `RoamingAttachRegistrations.list()` re-joins tokens and
  skips rows with a missing secret (fail-closed). Peer removal drops
  registration + secret. `POST /api/roaming/attach-registration/list`
  (access:write, roaming-gated 404, `no-store`) hands them to this
  machine's clients. Store changes emit the payload-free
  `roaming-attach-registrations-changed` shell event (tokens never ride
  the shell stream); the web client currently POLLS instead of
  consuming the event.
- Client consumption (web): registrations ride `PlatformConnectionSource`
  (apps/web/src/connection/platform.ts) — fetched from the primary at
  most every 15s riding the 3s platform tick, converted to
  `BearerConnectionRegistration`s (connectionId `bearer:<envId>` → the
  live-gated remote bucket in `reachableEnvironmentIdsAtom`, so the
  M5.5 one-row rules apply unchanged) and reconciled like desktop
  platform entries — add/refresh/remove, never written to the browser
  catalog; primary/desktop-local claims win on envId collision. Candidate
  URLs are identity-probed in order (2s cap each; first descriptor
  answering as the registered environment wins). A wrong-machine answer
  is POISON, never a fallback — only a SILENT candidate may be installed
  unverified (silence is what an offline peer looks like; supervisor
  retry = the offline presentation), and it re-probes each refresh. When
  every candidate answers as another environment the registration is
  SKIPPED entirely (2026-07-31 field bug: installing it rendered a
  permanently failing row and pointed the client at its own backend). Failed list fetch keeps the previous cache; empty/404
  clears it (gate-off masking). Hosted static apps have no platform
  source → no server-provided registrations.
- `enrollProject` losing the decider race to a concurrent enrollment
  (auto-enroll fires on peer-added while the route call is in flight)
  adopts the winner's workspaceProjectId instead of erroring (M5).
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
  else = local edit, never overwritten (notice). Receiver gate = `roaming`
  only (the capturing machine's consent decided the bundle's contents).
- Tombstones (2026-07-22, G4): bundles carry `{ path, deletedAt }` per
  file the previous bundle had that is now absent on disk (absence from
  the candidate list alone is not a deletion); live tombstones carry
  forward; a tombstoned file re-ships only when its mtime is newer than
  `deletedAt` (re-created — it lives again). Delivery removes an
  untouched local copy into `<stateDir>/vault-trash/<wsid>/<ts>/`
  (recoverable; deliberately outside the workspace so t3sync patterns
  can't re-match it); a locally edited copy always survives (keyed by the
  applied-record hash, never mtime). Deletions are never silent: warning
  log + sticky per-project deletion notice merged into the sync status.
  Pre-tombstone bundles decode with the old never-delete semantics.
- Capture triggers: fs watch + 30s interval backbone (the watcher is an
  optimization, never a guarantee).

## WIP sync

### Capture

- Server file layout (split 2026-07-16): `WipSnapshots.ts` git primitives;
  `WipShared.ts` types/codecs/guards/blob reads; `WipCapture.ts` snapshot +
  origin push/bundle transport; `WipApply.ts` classifier + per-file merge +
  parking/takeover; `treeWatcher.ts` fs-watch stream; `WipSnapshotReactor.ts`
  triggers/coalescing/status only.
- Temp-index recipe in `roaming/WipSnapshots.ts` (NOT the driver op): seed
  from HEAD, `add -A`, subtract vault set, `write-tree`, `commit-tree` with
  **parent = HEAD** (thin bundles are ancestry-based; also M4 divergence's common
  ancestor) and `T3-Based-On: <applied-marker oid>` trailer. When that marker
  represents pinned conflicts, the same contiguous trailer block also carries
  `T3-Based-On-Peer: <peer oid>`; snapshot ancestry remains unchanged. Returns
  `{ commitOid, treeOid }`. Real index and worktree untouched. Fixed
  author/committer identity.
- Payload v2 adds `branchRef` (symbolic HEAD; sentinel for
  detached/unborn) and `headOid`. Origin refs get this context from the
  mirrored beacon only on an exact `(refName, commitOid)` match; a ref with
  no matching v2 metadata is legacy. Legacy payloads never auto-apply.
- The WIP ref mirrors the worktree tree even when clean (a stale dirty
  snapshot must never shadow committed work). No-op identity is
  `(branchRef, headOid, treeOid)`; branch/HEAD moves ship even when the tree
  is unchanged. The baseline is the last SHIPPED payload plus the
  `wip-pushed` marker in origin mode. The exact applied peer tuple is
  suppressed until our shipped snapshot names that applied commit in
  `T3-Based-On`; after locally-authored work ships, that suppression turns
  off so deletion causality still propagates.
- Untracked files over `ROAMING_WIP_MAX_FILE_BYTES` (50 MiB) are excluded
  with a surfaced warning that survives real push errors.
- Triggers: per-directory fs watch (5s debounce), 2-min interval sweep
  (also the only trigger under sustained sub-5s write storms), settings
  enable, `thread.turn-diff-completed`, `project.meta-updated` carrying a
  workspaceProjectId (enrollment), a 10s `(branchRef, headOid)` poll for
  clean CLI switches/commits (`.git` is not watched), graceful shutdown (one
  bounded final capture+ship per project, 10s cap, 4-wide). Keyed-coalesced
  per project; skips while MERGE/REBASE/CHERRY_PICK markers exist. Thread
  worktrees live under `<baseDir>/worktrees/`, outside project roots —
  excluded by construction.
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
  commitOid, treeOid, branchRef, headOid, bundleBase64 }`, capped by
  `ROAMING_WIP_BUNDLE_MAX_BYTES` (8 MiB); oversize skipped with a surfaced
  warning.

### Apply

- Classification (same context / fast-forward / different branch /
  peer-behind / diverged) is the plan's decision table; the EXECUTABLE
  source of truth for guard precedence is `classifyWipApply` in
  `WipApply.ts` — a pure decision table over gathered `WipContextFacts`,
  with invariant tests enumerating the whole fact space. Not restated here.
  Mechanics that bind it:
  - Untouched (defined in the plan) mechanically requires the local
    branch/HEAD to match this machine's latest captured payload (or the
    applied payload before first local capture); the in-flight-turn guard
    uses a project-level projection query joining threads to sessions.
  - Staleness is ancestry, never wall clock (the committer-timestamp gate
    is deleted, not kept alongside). Newest-peer selection across
    environments stays committer-timestamp (fine at 2 machines).
  - Every blocked case sets a specific `blockedReason` and surfaces the
    takeover action.
  - Echo/acknowledgement rules (each answers a field bug):
    - An exact provenance echo (Based-On + branch/HEAD/tree = our last
      shipment) advances marker bookkeeping only; it never reverses a
      newer local branch switch.
    - A different-branch snapshot with a stale Based-On is a delayed echo
      ONLY when clean AND its HEAD is an ancestor of ours; unproven, it
      blocks with takeover offered — a silent skip settles both machines
      on "Synced" while divergent.
    - A dirty stale snapshot is real work but stays blocked until it
      acknowledges our latest shipment; it can never auto-switch a newly
      reset branch.
    - A pinned conflict marker's exact `T3-Peer-Snapshot` commit is
      resolved once this machine's kept-local result ships; it never
      recreates takeover on restart. A different peer commit re-evaluates.
  - Pre-apply causal baseline: the pushed marker in origin mode, the
    current mirrored payload commit in bundle mode — a missing origin
    marker must not disable causal classification in bundle fallback.
  - Passes apply BEFORE capture, so a receiver never ships stale pre-apply
    context back to the author. Successful takeover forces one
    acknowledgement capture even on an exact applied tuple, so the peer
    clears its block.
  - Parked refs: a manual git switch keeps carried WIP exactly as Git
    leaves it — the reactor never deletes files to force a parked snapshot
    into place; restore only when the returned checkout is clean at the
    parked snapshot's parent, and success consumes the ref.
- Per-file merge (the same-context path). Executable source of truth:
  `resolveWipPathAction` (pure, table-tested). Base selection: a
  clean-at-HEAD checkout rebases to HEAD (a retained applied marker must
  not manufacture local edits); dirty checkouts use the applied marker,
  else HEAD, else the empty tree. A path missing from that base may use
  the last-shipped snapshot as base ONLY when it is provably common
  history — locally absent (our own deletion; the delete flap), a
  proof-gated shipped-only delete, or the peer's Based-On/Based-On-Peer
  naming our shipment (a reply, M3.6 delivery); an unproven concurrent
  snapshot conflicts and keeps ours (the m35 no-clobber rule). Per path
  over `{ baseOid, peerOid, ourOid }`: ours=peer → skip; local changed +
  peer unchanged → keep local silently; both changed → conflict, keep
  ours, surface; untouched + peer deleted → remove; untouched + peer
  content → `git restore --source=<peer> --worktree`; occupied path →
  conflict. Clean-at-HEAD deletion echo: exact shipped bytes stay deleted,
  different bytes are a recreated file and apply. Same-context apply never
  touches HEAD, branch refs, or the real index.
- `POST /api/roaming/wip/takeover` reclassifies the newest snapshot, parks
  local state, reproduces the peer branch/HEAD/tree, and returns
  `{ applied, reason? }`. An optional `snapshotOid` pins the takeover to
  the snapshot the user was shown — a newer arrival refuses with a reason
  instead of applying unseen work (M4); omitted = newest-wins (harness/CLI).
  Per-file conflicts during takeover (an ignored file colliding
  with a peer path, a failed restore) still count as applied — the branch
  switch and reset have already happened, and the acknowledgement capture
  must still run so the peer clears its block. The blocked project pill is
  the action; the divergence dialog is the only additional sync surface.
- Divergence (M4): `divergence: true` on a blocked outcome means exactly
  same-branch + non-ancestor HEADs (`classifyWipApply` invariant 11);
  `takeoverServiceable === !hasInFlightTurn` (invariant 10) and maps to the
  status entry's `takeoverAvailable` — legacy/invalid-snapshot blocks are
  not serviceable. `POST /api/roaming/wip/divergence` returns merge-base +
  one capped patch per side (10 MB cap, `truncated` flag; the local side
  diffs the live vault-subtracted worktree TREE oid — its `snapshotOid` is
  a tree, not a captured commit; no merge-base → empty-tree base).
  `POST /api/roaming/wip/divergence/resolve` pins `peerSnapshotOid`:
  pick=peer re-verifies the divergence still exists, then runs the pinned
  takeover (losing side = per-branch parked ref); pick=local pins the
  rejected snapshot to `wip-rejected`, writes a kept-local applied marker
  (synthetic commit of the current worktree tree, `T3-Peer-Snapshot`
  trailer, dated 1s before the snapshot), touches no worktree state, and
  forces the acknowledgement capture — the existing
  `conflictAlreadyResolved` row then keeps that exact snapshot settled.
  Both routes `access:write`. `selectNewestPeerSnapshot` (fetch + bundle
  import + newest selection + integrity validation) is the shared
  selection for apply and both divergence routes.
- Deletion invariants (each was a field bug): (1) the applied marker
  advances EVERY pass that applies or records conflicts — clean passes to
  the peer snapshot, conflicted passes to a synthetic commit with only the
  conflicted paths pinned to base (dated 1s before the peer snapshot) — so
  one conflict can never unrecord another file's arrival. (2) Peer-absence
  counts as a deletion beyond the marker diff only for paths we SHIPPED and
  only when the peer's `T3-Based-On` state provably contained the path.
  If its synthetic marker is local-only, an exact `T3-Based-On-Peer` match
  proves acknowledgement against this machine's own shipped snapshot instead.
  Legacy snapshots missing that proof are re-captured once. (3) See the
  causality re-ship rule under Capture.
- TOCTOU guard: destructive decisions re-verify against a fresh worktree
  tree in the last instant before writing.
- Worktree mutations serialize (2026-07-22, G3): takeover and
  resolveDivergence run under a per-project lock shared with the keyed
  coalescing worker's passes; resolveDivergence's take-the-peer path
  calls the unlocked takeover core (already holds the lock). The
  shutdown finalizer bypasses worker and lock (pass fibers are
  interrupted there).

### Status surfacing

- `roamingWipStatus` per project: `{ mode, lastCapturedAt, lastPushedAt,
  lastError?, blockedReason?, takeoverAvailable?, notice?, lastAppliedAt?,
  lastAppliedFrom? }`,
  merged at BOTH shell surfaces (ws subscribe point and HTTP shell route);
  flag-off = empty. Baseline publish on a project's first pass; seeds into
  resumed ws subscriptions; after restart, activity timestamps reconstruct
  from marker-ref commit dates (git is the durable store).
- Sync pill priority: error (red) > blocked (amber, plain-language
  guidance) > notice (amber) > completed activity (green) > idle. Capture and
  apply timestamps describe completed work, so they render `Synced`
  immediately; there is no timestamp-derived fake `Syncing` interval.
  Concept-free copy — no "roaming"/"sync engine" wording.
- M4 status fields: `blockedSnapshotOid` (the peer snapshot that produced
  the block — echo it in takeover requests), `blockedFrom` (its author
  environment), `divergenceAvailable` (block is a two-sided divergence).
  All blocked fields clear on every non-blocked pass; reasons are
  enumerated plain language ("peer is on <branch>", "peer moved <branch>
  forward; you have local edits", divergence, legacy snapshot). A dirty
  same-branch non-ancestor checkout reads "has diverged", not "moved
  forward" (M4 correction).
- Pill actions (M4): divergence → "Review changes" opens the diff-and-choose
  dialog (takeover stays reachable inside it); serviceable block → "Take
  over" (pinned to `blockedSnapshotOid`); non-serviceable block →
  non-clickable "Waiting"; a red `lastError` pill never carries an action.

### Leases + activity (M4)

- One kind=lease blob per (project, machine), key `<wsid>/<envid>`, payload
  `RoamingLeasePayload { schemaVersion, environmentId, renewedAt,
  lastSnapshotAt? }`. "The lease" is derived: newest `renewedAt` wins;
  advisory only — never blocks anything.
- Renewal (`WipLease.renewLease`): after a successful ship of
  locally-authored work (both transports; always writes, carries
  `capturedAt`) — passes that applied peer content and acknowledgement
  captures suppress renewal, because an echo is not activity and would
  point the chip at the receiving machine after every delivery; while an
  agent turn is in flight (throttled to 60s, preserves `lastSnapshotAt`);
  on takeover and kept-local divergence resolution (forced past the
  throttle — explicit user actions move the lease even when the follow-up
  ship no-ops or fails). Renewals log-and-swallow failures.
- `RoamingProjectShell.activity`: all lease records for the project, newest
  first, no peer filtering — stale machines age out visually via
  `ROAMING_LEASE_ACTIVE_WINDOW_MS` (2 min, shared server/client constant).
  The blob-change shell stream re-projects on lease arrival, so chips
  update live. Chip renders only when the newest record belongs to another
  machine and is inside the window.
- `roamingWipStatus` is transient reactor state, not durable shell data. The
  client strips the entire array from shell-cache loads and writes so a cached
  blocked row cannot resurrect `Take over` before live status arrives. Warm
  resume receives an authoritative `roaming-wip-status-replaced` event,
  including an empty array, before replay/live events.

## Transcripts + briefs (M5, surfacing corrected in M5.5)

- Blob kinds `transcript`/`brief`, key `<threadId>`, JSON payloads
  (`RoamingTranscriptPayload` / `RoamingBriefPayload` in
  `packages/contracts/src/roaming.ts`). Caps:
  `ROAMING_TRANSCRIPT_MAX_BYTES` 4 MiB whole payload (drop oldest
  activities, then oldest messages, `truncated` flag — newest turns
  survive), `ROAMING_TRANSCRIPT_MAX_ACTIVITY_PAYLOAD_BYTES` 16 KiB per
  activity payload (`payloadTruncated`, summary still ships),
  `ROAMING_BRIEF_MAX_CHARS` 20k. Attachment bytes do not roam (name/mime/
  size metadata only).
- M5.5: the payload carries the source thread's `modelSelection`
  (optional `RoamingTranscriptModelSelection` — plain-string instanceId
  per the self-contained-contract rule, schema version unchanged so
  pre-M5.5 payloads decode). It is only ever the resume draft's picker
  DEFAULT, honored when that provider instance is enabled locally AND the
  model slug exists in its model list; otherwise the composer default
  stands.
- `TranscriptSync` (apps/server/src/roaming/TranscriptSync.ts): builds the
  reduced payload from `getThreadDetailById` (committed projections, never
  the event log), keyed-coalesced per threadId. Triggers: thread lifecycle
  events (created / message-sent / turn-diff-completed / meta-updated /
  proposed-plan-upserted / archived / unarchived / deleted / reverted —
  deliberately NOT activity-appended), startup + settings + peer-change
  reconcile (`captureAll`, which also re-enqueues every transcript blob key
  so offline deletions tombstone). No-op compare excludes `capturedAt`.
  Gate: derived roaming gate + `roamingTranscriptSync`; park forces past
  the flag but never the gate.
- AUTHOR-ONLY writes: tombstones require the existing record's
  `authorEnvironmentId` to be this machine (fail-closed) — without the
  guard, B's reconcile tombstoned A's mirrored threads at a higher version
  and killed them on both machines (review critical; regression leg in
  accept-m5).
- Hand-off/park was REMOVED 2026-07-31 (user decision — resume needs
  nothing from the source machine, so the explicit action earned
  nothing): the park route, TranscriptSync.park, the header button, and
  the dialog are gone. The payload's `parked` field and the worker's
  sticky-parked handling survive only so legacy blobs keep decoding.
  `POST /api/roaming/briefs/save` writes edits as new versions (either
  machine, newest-wins). `POST /api/roaming/threads/transcript` returns
  local transcript + brief + author.
- Shell: `roamingThreads` (`RoamingThreadShell`) from
  `listRoamingThreadShells` — transcript blobs, excluding (M5.5, each a
  structural SQL condition): (1) any blob whose `author_environment_id`
  is NOT in `roaming_peers` — this machine is never its own peer, so the
  author can never list its own thread as mirrored under any
  delete/tombstone ordering (the race-proof fix for the author-corpse
  field bug); the LEFT JOIN projection_threads local-row exclusion stays
  as a second belt; (2) any source threadId whose
  `roaming_thread_resumptions` row points at a live (non-deleted)
  projection thread — superseded by the resumed thread; deleting the
  resumed thread restores the fallback row; (3) tombstones.
  `getRoamingThreadShellById` includes tombstones for live upserts.
  Transcript/brief blob changes emit `roaming-thread-upserted`
  (sequence 0; `deleted: true` upsert = removal, no separate event);
  resume catch-up seeds the rows. Gate-off masks to `[]`.
- `roaming_thread_resumptions` (migration 041): machine-local, never
  mirrored — `source_thread_id PK, resumed_thread_id, created_at`,
  insert-or-replace via `RoamingThreadResumptions.record`, written by
  `POST /api/roaming/threads/resumed` (access:write, roaming-gated). The
  web records the link at DRAFT CREATION using the draft session's future
  threadId — the exclusion only bites once that thread actually exists,
  so an unsent draft never hides the source row.
- Supersession transitions are NOT blob changes, so ws.ts additionally
  watches thread.created/thread.deleted domain events: when the threadId
  matches a resumption's resumed thread, it polls briefly for the
  projection write to land and emits the source row's new state on the
  shell stream — the live row when restored, a removal upsert synthesized
  from the raw blob when superseded (the list query rightly refuses to
  return it). Without this the field client kept the stale fallback row
  until a reload (2026-07-31 field fix).
- `POST /api/roaming/briefs/generate` (access:write, roaming-gated):
  stateless brief generation on THIS machine from its local transcript
  copy via `TranscriptSync.generateBrief` — the transcript's carried
  modelSelection drives the text-generation job; no/unusable provider →
  deterministic digest + notice; never writes a brief blob.
- Web one-row gate (M5.5): `reachableEnvironmentIdsAtom`
  (apps/web/src/state/shell.ts) — primary + desktop-local always, a
  remote only while its shell status is `live`. Deliberately STRICTER
  than the project rows' live/synchronizing rule: a dead peer's retry
  loop flaps cached↔synchronizing forever, so a looser rule oscillates
  and components latching different vintages rendered a thread as a live
  row AND a fallback row at once. Read ONCE per commit in
  `SidebarProjectsContent` and prop-drilled to both row kinds:
  `SidebarProjectThreadList` filters cached shells of unreachable
  environments; `SidebarMirroredThreadRows` renders only unreachable
  authors, with a structural belt (no fallback while any reachable
  environment holds a live shell for the same threadId). Fallback rows
  render greyed (`opacity-60`) with "From <machine> (offline) —
  read-only copy".
- Web resume-as-draft (M5.5): the whole flow lives in
  `useContinueHere` (apps/web/src/hooks), consumed by BOTH the live
  thin-client thread's ChatHeader (peer online — 2026-07-31 decision) and
  MirroredThreadView's fallback. On an UNMATERIALIZED project the action
  reads "Materialize & continue" and runs the materialize confirm dialog
  first (shared `useMaterialize`, chained via its onSuccess into the
  draft once the registered project lands); otherwise → existing brief
  blob if present, else `briefs/generate` → reuse the
  project's stored unsent draft session when one exists (fresh draftId
  would DELETE it, prompt included; the brief lands above unsent text)
  else a fresh draft with sticky state → source model seeded only when
  selectable locally → record resumption link → navigate
  `/draft/$draftId`. Nothing auto-starts; disabled-with-reason until
  materialized. The mirrored view header carries the chat header's
  title-bar treatment (workspace-topbar / drag-region / WCO + safe-area
  insets + collapsed-sidebar inset).
- Sync-status copy (M5.5 f): every non-error, non-blocked state renders
  the label "Synced" on both machines (activity timestamps are
  machine-local); freshness/degradation detail lives in the tooltip and
  dot color only. The pill reports WIP sync, which only exists for a
  local checkout — a remote-only (unmaterialized) row renders no pill at
  all (2026-07-31 field fix).
- A project whose only rows are mirrored fallbacks does not render the
  "No threads yet" empty state (`useMirroredFallbackRows` is shared by
  the thread list and the fallback renderer; 2026-07-31 field fix).
- Resume threads are ordinary local threads (new UUID) — never mirrored
  back as the same thread; no import path into the local event log exists.

## Materialize

- Synchronous `POST /api/roaming/materialize`, stateless and idempotent
  (2026-07-22, O4/D2 — the persisted step machine and
  `roaming_materializations` table are gone, migration 039): resolve-path
  → clone → restore-wip → apply-vault → register-project → bootstrap
  (M7 recipes). Records live in memory for the boot (progress streams unchanged
  over the shell — live overlay at the ws/HTTP entry points; the
  projection query returns []); a failed run continues in-boot; across
  restarts a fresh run is idempotent (clone-if-missing, recording vault
  delivery, already-matched WIP restore, register finds the linked
  project). The auto-enroll D1 fork guard reads a workspace marker file
  the clone step writes BEFORE any project.create. An interrupted-clone
  skeleton (registry remote configured, no resolvable HEAD, clean status)
  is wiped and re-cloned. Runs serialize per workspaceProjectId (G9); a
  concurrent request waits and returns the running result.
- A completed in-memory record short-circuits ONLY while its targetPath
  still holds a git checkout AND the registered project is live;
  otherwise a fresh run.
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
  marker. Payload v2 is required; create + switch the snapshot branch to its
  `headOid` before restoring the dirty diff. Legacy snapshots skip with a
  notice.
- apply-vault never overwrites an existing differing file (notice;
  interactive overwrite belongs to the on-demand "pull vault files" path),
  and uses the recording variant so its files stay updatable by later
  vault delivery.

## Accepted risks / known limits

- Cloned state dir (two machines, one environmentId) → WIP ref ping-pong;
  re-install orphans one origin ref per abandoned environmentId (prunable
  by hand).
- A manual CLI branch/HEAD move is detected by the 10s context poll; a dirty
  tree under a sustained sub-5s write storm still waits for the interval.
- Peer clock skew can defeat timestamp-based newest-peer selection
  (recoverable via refs; apply safety decisions use ancestry).
- Two machines materializing from the same registry version → equal-version
  conflict (disjoint perMachineRoots not auto-merged).
- Initiator-side environmentId clobber; first-pairing settings TOCTOU
  (rationale in history).
- Total inotify-instance exhaustion at server boot crashes upstream watch
  paths before roaming runs (M3.7 removed the dominant consumer; state now
  unlikely).
- Base-diff peer deletions with NO applied marker yet are not
  Based-On-gated (narrow: markers appear on first exchange).
- Divergence pick=local reports `resolved: true` once the marker + rejected
  ref are durably written, but the settle rides the acknowledgement
  capture's SHIP — if that fails (origin down), the divergence pill returns
  until a later ship succeeds. Self-healing, idempotent to re-resolve; no
  data loss (inherited from the conflict-pin mechanism).
- Lease derivation trusts cross-machine wall clocks: under skew a fresh
  record can lose to a stale one and the chip lags. Advisory only.
- Stashes, in-progress rebases, the staged/unstaged split, reflog, and
  other local branches do not roam. Both
  machines must run ≥M3.8 builds before branch-aware behavior holds
  end-to-end.
- M5.6 reverse attach: the 365d server-held bearer has no refresh path —
  expiry silently degrades the callee to greyed mirrors until re-pair.
  An UNVERIFIED candidate URL receives the bearer header on connection
  attempts; if that IP is later reassigned (DHCP) the token is exposed
  to whatever listens there — same trust class as the recorded mirror
  base URLs; LAN-local. Registration freshness on the callee's clients
  is poll-bound (≤15s); a removed peer's environment can linger while
  the primary's list fetch fails. The initiator's OTHER browsers still
  hold no registration (forward attach stays per-browser catalog —
  pre-existing gap, unchanged).
- M5.5 one-row invariant: fresh mounts of both states verified on the
  harness (both-online → one live row; peer-dead → one greyed fallback).
  MID-SESSION convergence (row flipping live↔fallback without a reload)
  could not be measured there: the automation browser tab is hidden,
  which freezes rAF-driven exit animations (auto-animate keeps removed
  rows as position:absolute DOM corpses) and throttles schedulers —
  every transition looked duplicated until identified. One
  visible-window kill-the-desktop field check is pending. Removing a
  peer also hides its mirrored thread rows (the peers-membership author
  filter) — consistent with gate-off masking.
