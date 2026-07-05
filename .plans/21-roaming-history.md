# Roaming workspace — history archive

Superseded decisions and full per-milestone analysis/results narratives,
moved verbatim out of `21-roaming-workspace.md` when milestones complete.
The main plan keeps only current state and still-binding constraints; this
file exists so rejected alternatives and their rationale stay discoverable
without digging through git. Append-only; never loaded by kickoff prompts.

## Decisions log (full, as recorded through M2.5 — 2026-07-05)

> **Decisions log:** 2026-07-04 — v1 transport for small state = machine-to-machine
> mirror (user decision); cloud store backend (private git repo or T3 relay)
> deferred to explicit milestone M7 behind the same interface.
> 2026-07-04 — M0: origin-refs transport GO (GitHub round-trips `refs/t3/wip/*`;
> updates need `--force`, so snapshot pushes must use `--force-with-lease` or
> fast-forward chains). Server-to-server auth GO (pairing credential →
> `/oauth/token` bearer exchange works headless; default bearer TTL 30 days —
> the D4 machine credential rides this machinery with custom TTL/scopes).
> 2026-07-04 — M1 analysis pass done (see [M1 analysis](#m1-analysis-2026-07-04)):
> plan assumptions hold with four deviations — `roaming` flag becomes a
> `ServerSettings` boolean (T3 Connect's env-gating is precedent-by-analogy
> only); reactors gate themselves internally (no conditional-start hook);
> peer LAN/Tailscale endpoint discovery does not exist server-side, so M1
> records peer base URLs at enrollment; mirror RPCs go on raw authenticated
> HTTP routes with schemas in `roaming.ts` (not `environmentHttp.ts`).
> 2026-07-05 — M2 analysis pass done (see [M2 analysis](#m2-analysis-2026-07-05)):
> assumptions hold with deltas — vault bundles are JSON (no tar dep); capture
> is top-level + gitignored-only; secrets consent = per-machine
> `roamingSecretsSync` setting; materialize = synchronous HTTP + shell-stream
> progress; auto-enroll reactor replaces the missing pairing-completed event;
> M1 already shipped add-peer RPC and conflict storage.
> 2026-07-05 — Product model locked (user decision; supersedes the step-1 UI
> as merged in M1): **one project list, no user-visible "roaming" concept or
> enrollment step**. **"Pairing" means the EXISTING pairing/thin-client flow
> — not a separate sync concept** (this clause was dropped when the decision
> was first transcribed here; that omission caused the M2 deviation below).
> That one flow gains a JetBrains-style sync-options step
> (Projects always on; Secret files pre-checked with default patterns; WIP
> and Conversations rows arrive with M4/M6). Registry metadata syncs
> automatically for ALL projects once machines are paired; per-project
> configuration survives only as a rarely-used vault include/exclude
> override. M1's separate sidebar section is superseded — replaced by the
> merged list in M2. Guard rails: vault bundle size cap; prompt before
> overwriting local files on apply; M7 must re-ask the secrets consent
> before any cloud backend activates.
> 2026-07-05 (evening) — **Cloud-pairing readiness (user directive).**
> Upstream is building T3 Cloud environment saving/discovery — the client
> already carries relay environment-discovery and cloud-link hooks
> (`apps/web/src/state/relay.ts`, `useRelayEnvironmentDiscovery`,
> `CloudLinkRow`). When it opens to us, it should replace only the manual
> **introduction** (typing a URL + pasting a code) — never the trust model:
> the D4 handshake, credentials, and mirror stay ours. M2.5 must therefore
> implement pairing behind a single **peer-introduction seam**: input =
> "peer base URL + one-time credential", producer = manual dialog today,
> cloud/relay discovery later, everything downstream identical. Same
> discipline as D0's `RoamingBlobStore` (M7 storage backend) — cloud
> arrives as a new producer behind an existing seam, not a redesign.
> 2026-07-05 — M2.5 analysis pass done (see [M2.5 analysis](#m25-analysis-2026-07-05)):
> unified pairing is feasible with one structural correction — pairing codes are
> single-use, so the laptop's server orchestrates the handshake from one
> exchange (attach bearer + mirror credential both derive from it); the
> machine-credential route becomes flag-independent and carries the sync-options
> consent; the Add Environment dialog degrades to attach-only against servers
> you don't administer; the live→offline row flip needs the sidebar merge to
> consult connection liveness (cached snapshots of a dead peer currently
> suppress the Materialize rows).
> 2026-07-05 (late) — M2.5 implemented and harness-accepted; two deviations
> from the reviewed design recorded (see [M2.5 results](#m25-results-2026-07-05)):
> the handshake exchange cannot scope-narrow (the peer consumes the code
> BEFORE its scope check, so requesting scopes a weaker code lacks would
> burn it — exchange sends no scope param and branches on the response),
> and the handshake session cannot be revoked (the peer forbids revoking
> the calling session; it ages out on TTL, labeled and visible in
> authorized clients).
> 2026-07-05 (evening) — **Canonical workflow section added; M2 deviation
> recorded** (user decision, restated during first real two-machine use).
> M2 shipped pairing as a standalone "Machine sync" flow establishing only
> the mirror: pairing succeeded, but the peer's projects rendered as dead
> offline rows and remote conversations did not exist. Corrective milestone
> **M2.5 — Unified pairing** inserted before M3: one pairing code
> establishes the live remote attach AND the mirror; the sync-options step
> moves into that flow; the separate Machine sync section/dialog is
> deleted. Every milestone from M2.5 on re-runs the canonical workflow as
> part of acceptance.

## M0 results (2026-07-04)

**Spike (a) — origin hidden-ref round-trip: GO.** Tested against GitHub over
SSH (`git@github.com:thanostourik/t3code.git`), the only real host currently in
use. Findings:

- `git push origin HEAD:refs/t3/wip/test/spike-m0` accepted; ref advertised by
  `ls-remote`.
- Default clone/fetch refspec (`+refs/heads/*`) does not fetch `refs/t3/*` —
  the namespace is invisible to normal users of the repo.
- Explicit refspec fetch (`+refs/t3/wip/*:refs/t3/wip/*`) into a fresh bare
  repo round-trips the exact commit OID.
- Non-fast-forward ref updates are rejected without `--force` and accepted
  with it → WIP snapshot pushes must use `--force-with-lease` (or keep
  snapshots as fast-forward chains).
- Ref deletion (`git push origin :refs/t3/wip/...`) works → retention pruning
  is viable.
- Caveat: only GitHub was tested. The step-5 guard ("refuse origin-refs mode
  for remotes you don't control") stands; spot-check any new host the first
  time a project uses one.

**Spike (b) — server-to-server authenticated RPC: GO.** Against two live
harness instances (below):

- A pairing credential for instance B can be minted headlessly and offline via
  `t3 auth pairing create --base-dir <B's base dir> --json` — and this works
  while B is running (no SQLite contention; consumption is an atomic UPDATE).
- `POST /oauth/token` (RFC 8693 token-exchange, form-encoded,
  `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`)
  exchanges it for a Bearer token — default expiry ~30 days, standard client
  scopes. No user session, browser, or approval step anywhere in the flow.
- The bearer authenticates real endpoints: `GET /api/auth/session` reports
  `authenticated: true`, and auth-*required* `POST /api/auth/websocket-ticket`
  succeeds; the same call without the token is rejected with 401 (negative
  control).
- Client side ran as plain Node `fetch` — exactly what a server-resident
  `PeerMirror` will execute; D4's long-lived scoped machine credential rides
  this same machinery (`createPairingLink`/`issueSession` accept custom
  TTL/scopes).
- Spike script: `scripts/roaming/spike-server-to-server.mjs` (kept as the
  harness's auth smoke test).

**Harness (c) — two instances on one box:** `scripts/roaming/harness.sh
start|stop|status`. Runs two `t3 serve` processes from source
(`node apps/server/src/bin.ts`), instance-a on `127.0.0.1:14801`, instance-b on
`127.0.0.1:14802`, base dirs under `/tmp/t3-roaming-harness/instance-{a,b}/basedir`
(override root with `T3_ROAMING_HARNESS_DIR`). Separate base dirs yield separate
SQLite DBs, secret stores, and persisted `environment-id`s (verified distinct).
Logs and pids live next to each base dir.

Operational notes for later milestones: state lands in `<baseDir>/userdata`
(`<baseDir>/dev` only when a dev URL is set); ports 148xx avoid both the direct
default (3773) and dev-runner default (13773); never pass `--tailscale-serve`
to harness instances (fixed serve port would clash).

## M1 analysis (2026-07-04)

Assumption check against current code before M1 implementation. Confirmed as
planned: migrations pattern (`apps/server/src/persistence/Migrations.ts`,
statically imported entries; copy migration 031/032 style), branded-id pattern
(`makeEntityId<Brand>()` in `packages/contracts/src/baseSchemas.ts`, barrel
export from `index.ts`), reactor building blocks (`DrainableWorker.ts`,
`KeyedCoalescingWorker.ts` in `packages/shared`; `AgentAwarenessRelay` +
`CheckpointReactor` as models, boot wiring via
`orchestration/Layers/OrchestrationReactor.ts` → `serverRuntimeStartup.ts`),
`createPairingLink`/`issueSession` accept custom TTL/scopes, `/oauth/token`
exchange implemented in `apps/server/src/auth/http.ts`, `ServerSecretStore`
available, persisted `environmentId` via `ServerEnvironment.getEnvironmentId`,
`RepositoryIdentityResolver.resolve(cwd)` + `GitVcsDriver.listRemotes`,
`OrchestrationShellSnapshot` + `shellReducer.ts`/`projectEntities.ts` all where
the plan says.

**Deviations recorded (design deltas applied to step 1):**

- **Reactor gating:** there is no "don't start this reactor" hook keyed on a
  setting. Pattern in use (`AgentAwarenessRelay`) is: service always starts,
  internally no-ops when unconfigured. `PeerMirror` follows it — starts, reads
  the `roaming` setting via `serverSettings` (`getSettings`/`streamChanges`),
  and does nothing while the flag is off.
- **`roaming` flag:** T3 Connect is gated by env/build config, not
  `ServerSettings` — precedent by analogy only. The flag becomes a proper
  boolean in the settings schema (`packages/contracts/src/settings.ts`,
  default `false`) so the harness can flip it per instance.
- **Peer endpoint discovery (real gap):** LAN/Tailscale advertised-endpoint
  machinery lives in desktop code (`DesktopServerExposure.ts`,
  `tailscaleEndpointProvider.ts`; shaping in
  `packages/shared/src/advertisedEndpoint.ts`) — `apps/server` only knows its
  own local origin (`serverRuntimeState.ts`). M1 therefore stores peer base
  URLs explicitly in the peer record at enrollment time; PeerMirror tries the
  recorded URLs in order. Server-side reuse of advertised-endpoint discovery
  is deferred (revisit at M4/M5 when real two-box usage starts).
- **Mirror RPC transport:** raw authenticated HTTP routes (helper at
  `apps/server/src/http.ts:82`) with request/response schemas in
  `packages/contracts/src/roaming.ts` — deliberately *not* added to
  `environmentHttp.ts`, keeping the upstream-file touch minimal. A roaming
  auth scope extends the scope schema in `packages/contracts/src/auth.ts`
  (small additive upstream-file touch, unavoidable).
- **No command registry:** `project.enroll-roaming` follows the schema+decider
  path end to end: contracts command/event union → `orchestration/decider.ts`
  → `orchestration/projector.ts` → shell snapshot → client-runtime
  `operations/commands.ts` → web UI. Matches plan intent; listed here because
  the touch list is longer than "decider + contracts".
- **UI slot:** project list renders in `apps/web/src/components/Sidebar.tsx`
  (`SidebarProjectsContent`; grouping in `sidebarProjectGrouping.ts`), so the
  greyed-out roaming section lands there; `CommandPalette.tsx` is only the
  add-project flow.
- **Blob address convention (D0/D3 sharpened, from contracts review):** the
  wire/manifest address is `(kind, key)` with a contractual per-kind key
  derivation (registry/vault/recipe/lease → workspaceProjectId; wip →
  workspaceProjectId/environmentId; transcript/brief → threadId);
  `workspaceProjectId` on the record is a denormalized grouping attribute.
  Conflict records retain the full remote record so resolution flows can
  show both payloads. Payload strings are byte-authoritative for hashing.
- **Projection persistence (from contracts review):** `workspaceProjectId`
  must also be persisted in the SQL projection path
  (`projection_projects` column + pipeline write + `ProjectionSnapshotQuery`
  read) — the in-memory projector alone loses the link in shell snapshots.
  Lands with the server enrollment PR.
- **Peer credential shape (D4 concretized):** enrollment handshake = operator
  mints a pairing credential on the peer (`t3 auth pairing create`, works
  headless per M0), enrolling server exchanges it at the peer's
  `/oauth/token`, then immediately calls a roaming endpoint on the peer to
  mint a long-lived scoped machine credential (`issueSession` with custom
  TTL/scopes) and stores it in `ServerSecretStore`. One direction of
  connectivity suffices: mirror RPCs reconcile manifests both ways per
  contact, so A→B credentials give bidirectional data flow.

## M1 results (2026-07-04)

> **Superseded in part (2026-07-05):** the sidebar "Roaming" section shipped
> in PR #5 is a stopgap presentation; the locked product model replaces it
> with the merged single project list in M2. All server-side M1 work
> (contracts, blob store, mirror, enrollment plumbing, projection) stands
> unchanged; the enroll RPC becomes plumbing driven by the pairing flow.

Landed as four reviewed PRs into `feature/roaming`: contracts (#2), blob
store (#3), enrollment + PeerMirror (#4), client shell/UI (#5). Exit
criteria verified end-to-end by `scripts/roaming/accept-m1.mjs` on the M0
harness: enroll on A → registry entry (title, repository, per-machine root)
on B after a mirror pass → A killed → B still serves its local copy.

Decisions/deviations recorded during implementation and review:

- **Enrollment is administrative.** The enrollment/mint HTTP routes require
  `access:write`, not `orchestration:operate` (any standard client could
  otherwise mint 365-day mirror credentials). Consequently the D4 handshake
  needs an admin-scoped pairing credential: `t3 auth pairing create --admin`
  (new flag). Mirror RPCs require `roaming:mirror`, which is granted nowhere
  by default.
- **Peer records are tamper-resistant.** A caller of the machine-credential
  route is recorded insert-only (`RoamingPeers.ensurePeer`) and its
  advertised base URLs are ignored — overwriting a credentialed peer's URLs
  would have redirected our authenticated mirror traffic to an attacker.
- **Enroll ordering:** `project.roaming.enroll` dispatches before the
  registry blob write, so the decider gates concurrent double-enrolls and no
  orphan blob can mirror out; the idempotent re-enroll path self-heals a
  missing blob.
- **Honest staleness:** `last_contact_at` is written only by a completed
  mirror pass. Accepted M1 simplification: `lastMirrorContactAt` in the
  shell is a global max across peers, not per-project (revisit ~M4).
- **Flag-off behavior:** shell snapshots hide `roamingProjects` and the live
  roaming stream while the `roaming` setting is off, consistent with the
  routes 404ing. Local blob data is retained.
- **Roaming shell stream events carry `sequence: 0`** (they ride outside the
  event log); the client reducer applies them by key and owns all sequencing
  rules (the redundant outer gate in shell sync was removed).
- **Reconciliation hardening from review:** the blob store serializes its
  read-modify-write behind a semaphore (fiber interleaving could defeat
  equal-version conflict detection) and verifies ingested `contentHash`
  against the payload before applying.

## M2 analysis (2026-07-05)

> **Partly superseded (2026-07-05 evening):** the "Pairing dialog placement"
> decision below — a new "Pair machine for sync" flow driving
> `POST /api/roaming/peers` — is the M2 deviation: a standalone pairing
> concept, forbidden by the canonical workflow. M2.5 folds it into the
> existing pairing/thin-client handshake; see the Canonical workflow
> section, the M2.5 milestone row, and M2 results. The server-side deltas
> (vault, materialize, auto-enroll, conflicts) stand unchanged.

Assumption check against current code before M2 implementation. Confirmed as
planned: file-watch + debounce pattern (`startWatcher` /
`Stream.debounce(100ms)` in `apps/server/src/serverSettings.ts:499`),
`makeDrainableWorker`/`makeKeyedCoalescingWorker` in `packages/shared` (note:
the keyed worker's active precedent is `terminal/Manager.ts`, not the
reactors), boot wiring via `OrchestrationReactor.ts` → `serverRuntimeStartup`;
`SourceControlRepositoryService.cloneRepository` + contracts schemas
(`sourceControl.ts:67`), `GitVcsDriver.listRemotes`,
`RepositoryIdentityResolver`; `addProjectBaseDirectory` in the settings
schema; `project.create` command path with server-side dispatch via
`OrchestrationEngineService.dispatch` (startup bootstrap is the precedent);
migrations at 034 (M2's `roaming_materializations` becomes 035); the
`roaming` flag + PeerMirror internal-gating pattern for new reactors to copy.
M1 left more in place than the plan assumed: `RoamingAddPeerRequest` /
`POST /api/roaming/peers` already exists as the local add-peer RPC (the
pairing dialog drives it), conflict *detection and storage* already exist
(`roaming_blob_conflicts` table + `listConflicts`; M2 adds only surfacing and
pick-a-side resolution), and the registry's `repository: RepositoryIdentity`
carries `locator.remoteUrl` — the clone URL for materialize needs no new
field.

**Deviations recorded (design deltas applied to steps 2–3 and the product
model):**

- **Vault bundle format is JSON, not tar.** No tar/zip utility or dependency
  exists server-side, and blob payloads are TEXT. Bundle payload =
  `{ schemaVersion, capturedAt, files: [{ path, mode, sha256, contentBase64 }] }`.
  Per-file hashes directly serve the planned per-file conflict comparison.
  The size cap applies to total decoded bytes (default 2 MiB); an oversize
  capture is skipped with a surfaced warning, never silently shipped.
- **Registry vault field reshaped.** M1's placeholder `vaultManifest:
  string[]` becomes `vaultOverrides: { include: string[], exclude: string[] }`;
  effective set = shared default pattern list (contract constant
  `DEFAULT_VAULT_PATTERNS`) + include − exclude. Only harness data exists, so
  no blob migration (old payloads decode via defaults).
- **Vault capture scope: top-level + untracked-only.** There is no
  per-project watcher infra and no recursive-glob machinery worth building:
  default patterns match files at the project root's top level only; nested
  secrets are added via explicit per-project include paths (relative paths,
  not globs). A file is captured only if it is pattern-matched **and
  untracked** — committed lookalikes (`.env.example`) are excluded via
  `git ls-files` on the candidates. (Reviewer catch: the plausible-looking
  reuse of `GitVcsDriver.filterIgnoredPaths` is wrong — it runs
  `check-ignore --no-index`, which reports committed files matching a
  `.gitignore` pattern as ignored. Tracked-status, not ignore-status, is
  the invariant: tracked files travel via git.) Watch = `FileSystem.watch`
  on the project root dir (+ parents of explicit includes), debounced, plus
  a startup rescan.
- **Secrets consent is a per-machine setting.** `roamingSecretsSync` boolean
  (default `false`) in `ServerSettings`, set by the pairing sync-options
  dialog; VaultSync captures only while it (and `roaming`) are on. Not
  mirrored — each machine consents to shipping its own files. Materialize
  with no local vault blob (or an empty one) completes with an explicit
  "no secret files synced" notice.
- **Materialize transport: synchronous HTTP + shell-stream progress.**
  `cloneRepository` has no progress callback, and step-level progress is all
  that's honest anyway. `POST /api/roaming/materialize` runs (or resumes) the
  step machine and returns the final record; live progress is a *new* event
  source (the step machine's own PubSub, not the blob-change subscription)
  merged at the same `subscribeShell` merge point M1 uses, as
  `roaming-materialization-updated` events, with a
  `roamingMaterializations` snapshot field so clients connecting mid-run
  see state. No new streaming RPC. Steps persisted per D3-style record in
  `roaming_materializations` (035): resolve-path, clone, apply-vault,
  restore-wip (recorded-as-skipped until M4), register-project, bootstrap
  (skipped until M3). The prompt-before-overwrite guard rail cannot fire
  inside a synchronous RPC: materialize's apply-vault step never overwrites
  an existing differing file — it skips it and adds a notice; interactive
  overwrite lives on the on-demand "pull vault files" path.
- **Auto-enroll hook (no pairing-completed event exists).** A small
  `RoamingAutoEnroll` reactor enrolls every unenrolled local project when
  `roaming` is on and ≥1 peer exists — triggered on startup, on peer-added
  (both directions: local `addPeer` success and inbound
  `ensurePeer` insert from the machine-credential route — each machine
  enrolls *its own* projects; `ensurePeer` is a bare INSERT today, so the
  peer-added signal is a new hook, not free), and on `project.created`
  domain events via
  `OrchestrationEngine.streamDomainEvents`. Startup reconciliation makes it
  self-healing; `project.roaming.enroll` stays the idempotent unit.
- **Pairing dialog placement.** Machine pairing UI = ConnectionsSettings
  (`AuthorizedClientsHeaderAction` mints pairing links; a new "Pair machine
  for sync" flow drives `POST /api/roaming/peers`). The sync-options dialog
  is that flow's confirm step: Projects row always-on (checked, disabled),
  Secret files row pre-checked (sets `roamingSecretsSync`). WIP and
  Conversations rows are *not rendered* until M4/M6. Confirming the first
  peer also flips the `roaming` setting on — the dialog is how the flag
  turns on outside the harness.
- **Conflict surfacing.** `RoamingProjectShell` gains a `conflicts` array
  (kind + detectedAt, default empty); detail + resolution go over new routes
  `POST /api/roaming/conflicts/get` / `.../resolve` (POST bodies, mirror-RPC
  style — `wip` keys contain `/`). Resolution = pick a side, written as a
  new higher-version local blob (the store already clears the conflict row
  on supersede); never a merge.

## M2 results (2026-07-05)

> **Deviation recorded (2026-07-05 evening, user callout during first real
> two-machine use):** M2 shipped pairing as a standalone "Machine sync"
> section/dialog that establishes only the mirror. The locked product model
> says pairing IS the existing pairing/thin-client flow — the transcription
> of that decision into this doc dropped the clause, the M2 analysis pass
> didn't catch it, and the result violated the canonical workflow: pairing
> succeeded but the peer's projects were dead offline rows with no remote
> conversations. Corrected by milestone M2.5 (unified pairing). The M2
> server plumbing (mirror, vault, materialize, auto-enroll) stands; the
> standalone pairing UI is the part being folded away.

Landed as six reviewed PRs into `feature/roaming`: analysis (#7), contracts
(#8), UI — merged list + sync-options dialog (#9, fixes #10), VaultSync +
conflict routes (#11), materialize + auto-enroll (#12). Exit criteria
verified end-to-end by `scripts/roaming/accept-m2.mjs` on the M0 harness:
auto-enroll on pairing AND on later project creation → registry + vault
blobs on B → forged equal-version vault push surfaces as a conflict with
the local copy untouched → A killed → materialize takes B from empty to a
registered checkout with `.env` applied (P1) and an honest "no secret files
synced" notice (P2) → conflict resolved by explicit pick, superseding
version. Server seams were implemented by Codex (gpt-5.5) from specs
derived from this doc; contracts, UI, and all review fixes by hand.

Decisions/deviations recorded during implementation and review:

- **Vault capture is fail-closed on the untracked invariant.** A genuine
  `git ls-files` failure skips the capture; only "not a git repository"
  treats candidates as untracked. The size cap is enforced from `stat`
  before any read. Symlinks are never captured (stat follows them) and
  apply refuses symlinked targets/parents outside the real workspace root;
  new files are written with their mode up front.
- **D1 fork guard:** RoamingAutoEnroll skips any project whose
  workspaceRoot is a `roaming_materializations` target path (persisted
  before `project.create`), closing the window where it could observe a
  freshly-materialized project before the register step links the existing
  workspaceProjectId — reviewer-caught race on the main flow.
- **Registry updates merge on raw JSON.** `ensureRegistryRoot` writes
  perMachineRoots without a schema decode/re-encode round-trip, so fields
  written by newer-schema peers survive an older machine's version bump.
- **Accepted per D3:** two machines materializing the same project from
  the same registry version produce an equal-version conflict (disjoint
  perMachineRoots keys are *not* auto-merged). Surfaced like any conflict;
  revisit only if it annoys in practice.
- **Conflict get/resolve routes require `access:write`** — they return and
  rewrite secret payloads; consistent with M1's administrative posture for
  enrollment. Client calls ride the same-origin cookie / desktop bearer,
  matching `httpLayer` semantics exactly (UI review fix).
- **Materialize is synchronous and honest:** a failed run returns the
  failed record over HTTP 200 (the UI renders steps + error); resume
  continues from the failed step (covered by tests); a completed record
  short-circuits even with a different `targetPath` (per contract note).
- **VaultSync watcher scopes swap atomically** (reviewer-caught leak:
  close-then-set let concurrent rescans strand watch fibers).

## M2.5 analysis (2026-07-05)

Assumption check against current code before M2.5 implementation, run
explicitly against the canonical workflow. Confirmed as planned: the existing
pairing/thin-client flow is the Add Environment → "Remote link" dialog in
`ConnectionsSettings.tsx` (host + pairing code, or a pasted pairing URL) →
`connectPairing` (`packages/client-runtime/src/connection/onboarding.ts`) →
`/.well-known/t3/environment` + `/oauth/token` exchange → persisted
`BearerConnection{Target,Profile,Credential}` in the connection catalog
(IndexedDB on web, encrypted `connection-catalog.json` via IPC on desktop);
remote conversations already work over that attach (environment-scoped
`thread.create`/`thread.turn.start` via WS or `/api/orchestration/dispatch`);
the sidebar already renders ONE list merging local, attached-remote, and
mirrored-offline rows, and `selectOfflineRoamingProjects` already suppresses a
registry row whenever a live row covers the same repository (canonicalKey).
M1/M2 server plumbing (add-peer, machine-credential mint, auto-enroll,
materialize) is all reusable as-is; `RoamingAutoEnroll` already triggers on
peer-added, settings changes, and project-created — no new hook needed on
either side of the unified handshake.

**Deviations recorded (design deltas applied to the M2.5 row):**

- **One code, one exchange — the local server orchestrates the handshake.**
  Pairing credentials are single-use at `/oauth/token`, so the M2.5 row's "one
  pairing code establishes attach AND mirror" cannot mean two exchanges. The
  client sends the introduction to its own server (`POST /api/roaming/peers`,
  extended); that server exchanges the code once at the peer, and from the
  resulting bearer (a) mints the 365-day `roaming:mirror` machine credential
  (existing route) and (b) mints + immediately exchanges a fresh
  standard-scoped pairing credential on the peer, returning the resulting
  **standard** attach bearer in `RoamingAddPeerResponse`. The client registers
  the attach from that bearer (the registration half of `connectPairing`,
  factored out). The client's persistent session stays standard-scoped.
  Handshake-credential hygiene (from design review): the exchange requests
  exactly the scopes the handshake needs (standard + `access:write` — the
  delegation cap forces standard to be present so the attach code can be
  minted), never the code's full grant; the handshake session is revoked on
  the peer best-effort once the mints complete (otherwise every pairing
  strands a live ~30-day privileged session in the peer's SessionStore); the
  bearer-bearing `addPeer` response carries `cache-control: no-store` like
  every auth credential response and the token never reaches logs; and since
  `addPeer` tries `baseUrls` in order, the response's `attach` block names
  the base URL that actually worked so the client never registers an
  unreachable one.
- **The code carries the capability; the preset carries the UX.** The
  handshake's peer-side mints require `access:write`, so the pairing code for
  your own machine must be admin-scoped. The existing create-pairing-URL
  dialog already has scope presets (Read only / Standard) plus per-scope
  checkboxes and an access:write warning; it gains one preset — "Another
  machine of yours" (admin scopes). No new generation flow, no sync concept.
- **Attach-only degradation is a first-class outcome, not an error.** The same
  Add Environment dialog is how users attach to servers they *don't*
  administer. If the exchanged bearer lacks `access:write`, the handshake
  skips the mirror half and returns that bearer for attach registration, with
  `mirror: null` + reason; the UI attaches normally and shows an honest
  notice. Remote conversations (canonical step 3) work in both outcomes;
  only offline availability needs the admin-capable code. UX-cliff guard
  (from review): which outcome you get hinges on a preset chosen on the
  *other* machine at code-generation time, so the degradation notice must say
  how to get the full pairing (regenerate the code with the
  "Another machine of yours" preset), and that preset keeps a loud
  administrative-access warning.
- **The pairing routes become flag-independent; pairing IS how the flag turns
  on — on both machines.** Today ALL roaming routes 404 while the `roaming`
  setting is off, which dead-ends the unified flow twice: the peer's mint
  route (desktop would need a settings ritual before pairing could succeed)
  AND the laptop's own `POST /api/roaming/peers` (a fresh laptop defaults to
  `roaming=false`, so the very call that starts the handshake would 404 —
  design-review blocker). Both routes are un-gated from the flag (auth
  unchanged: `access:write`). A successful mint flips the peer's `roaming`
  on; a successful `addPeer` flips the local one on and applies the dialog's
  sync options locally. Consent story: the desktop user consented by
  generating the admin-scoped code; the laptop user confirmed the one dialog.
- **Sync-options propagation amends M2's "not mirrored" consent decision —
  deliberately and narrowly.** M2 recorded `roamingSecretsSync` as "not
  mirrored — each machine consents to shipping its own files"; a unified
  pairing that leaves the desktop's secrets capture off would regress
  canonical step 4 (materialize with synced secrets must work out of the box)
  into a desktop-side settings ritual. Amendment: the mint request gains
  `syncOptions: { secretsSync?: boolean }`, and the peer applies it **only
  when the same mint flips `roaming` off→on** (first pairing). A later
  pairing never touches it, and an explicit prior choice is never overridden
  remotely — the per-machine setting stays the mechanism and the ordinary
  settings row stays the way to change your mind. (An `access:write` caller
  could already reach files via a terminal, so this grants no new capability
  class; what it changes is turning a manual capability into the standing
  default flow, which is exactly what the canonical workflow's pre-checked
  "Secret files" row asks for.)
- **Live→offline is a real UI gap (reviewer-grade catch).** A disconnected
  bearer environment keeps its cached shell snapshot, so a dead peer's
  projects stay in `projectsAtom` as live-looking rows AND suppress the
  mirrored offline rows via the canonicalKey dedup — exactly the "visible but
  dead" state the canonical workflow prohibits. Fix in the sidebar merge,
  with review-specified semantics: liveness = shell status `live` OR
  `synchronizing` (reconnects pass through synchronizing — flapping rows to
  offline on every blip is worse than a short stale window); the filter
  applies only to non-primary, non-desktopLocal environments (the primary and
  WSL-style local sandboxes are never "dead peers"); and the SAME filtered
  project set must feed both the rendered rows and the
  `selectOfflineRoamingProjects` dedup keyset — filtering only one of the two
  would show a stale live row and its offline twin simultaneously. Accepted:
  WS disconnect detection has latency, so a brief visible-but-dead window
  exists before the flip; acknowledged, not fixable at this layer. (The
  reverse dedup — peer alive, registry row suppressed — already works.)
- **Peer-introduction seam lands client-side.** `PeerIntroduction =
  { baseUrls, pairingCredential, label? }` with a `pairMachine(introduction,
  syncOptions)` operation in `packages/client-runtime` as the single consumer;
  the manual dialog is producer #1, relay/cloud discovery later constructs the
  same value (its hooks — `relay/discovery.ts`, `CloudLinkRow` — already
  yield per-environment availability + connect scopes, so the shape fits).
  Server-side, `RoamingAddPeerRequest` already IS the introduction; it gains
  only `syncOptions`.
- **Sync options render in the Remote-link dialog; the secrets toggle
  survives as one settings row.** The JetBrains-style step (Projects
  checked+disabled; Secret files pre-checked; WIP/Conversations arrive
  M4/M6) renders inside the existing Add Environment → Remote link dialog.
  `MachineSyncSettings.tsx` is deleted; `roamingSecretsSync` gets an ordinary
  settings row (no section, no concept) for changing your mind later.
- **Known scope-schema wart (no action):** `roaming:mirror` exists in the
  auth contract but `/oauth/token`'s explicit-scope parser omits it. The
  design never requests it over OAuth (the mint route issues it), so this
  stays as-is; noted for M7.
- **Harness acceptance scope:** the M0 harness proves the full transport
  chain headlessly — one `POST /api/roaming/peers` call with a real pairing
  code yields both credentials; the attach bearer opens the peer's WS
  (`/api/auth/websocket-ticket` → `subscribeShell`) and streams its projects;
  `thread.create` dispatched over that attach lands in the peer's shell
  stream. A full LLM turn depends on provider keys being present and is run
  when available; the canonical-workflow UI walk (one list, live rows,
  offline flip) is demonstrated on the real desktop build. This split stays
  in the exit criteria explicitly — the harness half must never quietly
  substitute for the UI walk.

This design was independently reviewed before implementation (2026-07-05,
opus-4.8): verdict "ship with changes"; the changes (local route un-gating,
handshake scope-narrowing + session revoke, first-pairing-only consent
propagation, credential-response hygiene, precise liveness semantics, UX-cliff
copy) are folded into the bullets above. The review also settled the
alternative two-exchange design (mint the code with `remainingUses: 2`)
against: the uses counter exists only for the in-memory desktop-bootstrap
grant, not DB-backed pairing links, and a 2-use admin code is strictly weaker
under interception.

## M2.5 results (2026-07-05)

Landed as five reviewed PRs into `feature/roaming`: analysis (#19, reviewed
pre-implementation by an independent opus-4.8 pass — verdict "ship with
changes", changes folded in), contracts (#20), server handshake (#21,
independent opus-4.8 security review "merge with fixes" + codex review),
client/UI (#22, codex review), acceptance (#23). Exit criteria verified
end-to-end by `scripts/roaming/accept-m2.5.mjs` on the M0 harness, starting
from two FRESH machines with `roaming` off on both: mirror routes 404 while
pairing routes answer → one `POST /api/roaming/peers` with an admin-scoped
code returns mirror peer + attach grant with `no-store` headers → the
`roaming` flag and secrets consent flip on BOTH machines from that one call
→ the attach bearer is standard-scoped (negative-checked for
`access:write`), opens the peer's WS, and creates a thread ON the peer over
the same dispatch path the UI uses → registry + vault mirror to the laptop
silently → a standard-scoped code degrades to attach-only with the typed
reason → a re-pair with different sync options does NOT override the peer's
prior consent (first-pairing rule) while applying locally → peer killed →
materialize completes from the mirrored copy with `.env` applied.

**Canonical-workflow UI walk: PASS in a real browser** (2026-07-05 late,
headless Chrome via Playwright against the harness web UI — note the
harness serves the PREBUILT `apps/web/dist` bundle; rebuild it after UI
changes or the walk tests stale code, which is exactly what the first
attempt caught). Verified: empty laptop before pairing → no "MACHINE SYNC"
section anywhere in settings → sync-options step (Secret files) inside the
one Add Environment dialog with no forbidden concepts → one action →
"Machine paired" toast → the desktop's project renders LIVE in the single
project list with no Materialize offered → opening it navigates (thin
client) → peer killed → the SAME row flips to greyed + Materialize.
Screenshot evidence archived from the run. Repeating the walk once on the
real two-machine desktop setup is a recommended spot-check, not a gate.

Decisions/deviations recorded during implementation and review:

- **The exchange consumes before the scope check** (`EnvironmentAuth`
  verified): the design review's "narrow the exchange request" is unsafe —
  requesting scopes a weaker code lacks errors AFTER consumption, burning
  the code with nothing to show. The handshake therefore exchanges with no
  scope parameter and branches on the response's granted `scope` field.
- **No handshake-session revoke exists**: the peer's revoke route forbids
  revoking the calling session and no other credential we hold has
  `access:write` there. Accepted: the session ages out on its TTL, labeled
  `roaming-enrollment`, visible and revocable in the peer's
  authorized-clients list. (Both this and the point above amend the design
  review's hygiene asks; the review's other asks — no-store headers, no
  token logging, reachable base URL in the attach grant — shipped.)
- **All network steps complete before anything persists locally** (review
  fix): a failure while deriving the attach bearer leaves no half-paired
  state. A retry after such a failure needs a fresh code and re-mints a
  365-day credential on the peer, orphaning the first — accepted,
  convergent, visible in the peer's client list.
- **Initiator-side environmentId clobber accepted** (review finding): a
  malicious "peer" claiming another peer's environmentId could overwrite
  that peer's stored credential/URLs — but the mirror already pushes all
  blobs to every paired peer, so pairing with a malicious server grants it
  everything regardless; rejecting collisions would break legitimate
  re-pairing after an address change. The callee-side tamper resistance
  (M1) is unchanged.
- **First-pairing settings TOCTOU accepted**: two concurrent first mints
  could both apply sync options; both set `roaming: true` and the window is
  a fresh machine's first seconds.
- **Seam placement**: `PeerIntroduction` + `registerBearerGrant` (the
  registration half of `connectPairing`, factored out with an
  environmentId-match guard on the descriptor) live in
  `packages/client-runtime`; the pairing orchestration itself lives in the
  Add Environment dialog because the local-server roaming HTTP helper is
  web-side. Relay/cloud discovery later constructs a `PeerIntroduction`
  and drives the same `POST /api/roaming/peers` + `registerBearerGrant`
  pair.
- **Secrets checkbox seeds from the existing choice** (codex review): once
  roaming is on, the dialog initializes "Secret files" from the current
  setting instead of pre-checked — pairing another machine never silently
  re-enables a consent the user explicitly withdrew.
- **The settings file stores non-defaults only**: `roamingSecretsSync:
  false` reads back as absence; acceptance asserts accordingly.
- **Delegation note**: the server seam was specced for Codex (gpt-5.5) but
  the run hung silently (again) and was taken back and written by hand;
  both Codex *reviews* worked fine and each caught a real issue.

