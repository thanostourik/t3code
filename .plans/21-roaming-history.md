# Roaming workspace — history archive

Superseded decisions and full per-milestone analysis/results narratives,
moved verbatim out of `21-roaming-workspace.md` when milestones complete.
The main plan keeps only current state and still-binding constraints; this
file exists so rejected alternatives and their rationale stay discoverable
without digging through git. Append-only; never loaded by kickoff prompts.

**Numbering eras (records below keep the numbering of their date — never
rewritten):**

| Era | M3 | M4 | M5 | M6 |
|---|---|---|---|---|
| ≤ 2026-07-06 | Bootstrap recipes | WIP snapshots | Takeover + divergence | Briefs + transcripts |
| 2026-07-06 → 2026-07-17 | WIP snapshots | Bootstrap recipes | Takeover + divergence | Briefs + transcripts |
| ≥ 2026-07-17 | WIP snapshots | Takeover + divergence | Briefs + transcripts | Bootstrap recipes |

M0–M2.5, the M3.x sub-milestones, and M7 (cloud store) mean the same thing
in every era.

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


## M2.5 field-hardening (2026-07-06)

After the original M2.5 build (PRs #19–#24) the user ran the feature on a
real desktop+laptop pair for the first time. A long session of findings
reshaped the product model; each was fixed on `roaming/m25-pair-dialog`
(PR #29) with the server/UI change verified on the M0 harness and confirmed
by the user on real machines. Superseded design notes moved here so the main
plan stays current-state.

Findings and resolutions, in order:

- **Revocation didn't bite live sockets (security).** A revoked client kept
  driving the peer over its established WebSocket for ~5 min. Fix (#26):
  the connection races its own `clientRemoved` event and closes in ~7ms; a
  30s `listActive` existence check backstops the non-replaying pubsub and
  also retires expired-session sockets.
- **Materialize invisible on live rows, then always-visible, then finally
  enabled-iff-workable.** Three iterations: (a) it was gated on the local
  mirror copy, so it never appeared while the peer was live; (b) over-
  corrected to always-visible (user: "why show a button that can't work");
  (c) final: renders on every live remote-only row, ENABLED when it can
  succeed (peer sync on or a retained local copy), DISABLED with a tooltip
  reason otherwise. Plus on-demand registry+vault blob fetch so it never
  depends on background-sync timing.
- **"Sync" was two toggles and code-driven.** The original model kept a
  per-machine `roamingSecretsSync` and a first-pairing-only propagation,
  and toggling sync implied re-pairing. Replaced by: `sync_enabled` pause
  flag on the peer row (migration 036, gates outbound + inbound), instant
  toggle with no code (code only for a first enable), and ONE secrets
  decision from the pairing dialog applied to both machines. This overrode
  M2's "each machine consents to its own files" and M2.5's first-pairing-
  only rule — both at the user's explicit, repeated direction.
- **Authorized clients showed the plumbing.** One pairing left three
  cryptically-named sessions ("Paired machine", "Roaming mirror credential
  for <uuid>", and the handshake session). Fixes: the handshake session
  self-revokes via a new `handshake-complete` route (the original build's
  "cannot be revoked" was wrong — the endpoint forbids self-revoke, the
  server internally does not); session labels inherit the name the user
  typed on the pairing link; and the UI collapses every credential behind a
  machine into ONE row with one Revoke.
- **Revoke vanished the project instead of flipping it offline.** Stale
  `localProjectId` links (from add/remove churn) made rows read as
  materialized-so-hidden. Fix: a `localProjectId` pointing at a project
  that no longer exists counts as unmaterialized; auth-failed remotes count
  as dead so their rows flip to offline+Materialize.
- **Clone failures said nothing.** The vcs layer scrubs git's stderr from
  errors (token safety). Fix: on clone failure the Materializer runs a
  BatchMode `ls-remote` diagnostic, redacts credentials, and reports the
  real message; generic wrapper text is filtered out.
- **First materialize clone hit "Host key verification failed."** The
  background server never accepted the origin's SSH host key. Fix: for
  well-known public hosts (github/gitlab/bitbucket/azure) the clone step
  seeds the key via ssh-keyscan and retries once; unknown hosts surface the
  failure with manual instructions.
- **Materialize dead-ended when no projects folder was configured.** Fix
  (polish): a shared `useMaterialize` hook prompts for a folder, saves it as
  `addProjectBaseDirectory`, and retries — asked once, never again.

Deliberately left for later, stated to the user: uncommitted/unstaged work
does not sync — that is milestone M4 (WIP snapshots), not built; today's
materialize is clone + secret files. The desktop's own duplicate
authorized-client rows are upstream behavior, left alone by decision.

---

## M3 — WIP snapshots (DONE 2026-07-07, PRs #32–#37)

### Analysis pass (2026-07-06, PR #32)

Codex (gpt-5.5) read the codebase; deviations from the plan text, verified
and independently reviewed (opus), all folded into the doc before code:

1. `captureCheckpoint`'s ref name was already parameterized — but capture
   was still reimplemented in `roaming/` because checkpoint commits are
   parentless and a spike showed `git bundle --not --remotes=origin` emits
   FAT whole-tree bundles for parentless commits (bundle thinning is
   commit-ancestry-based). With parent=HEAD the same bundle was 385 bytes
   with HEAD as a satisfied prerequisite. Parents also give M5 divergence
   its common ancestor.
2. The planned "shared semaphore with CheckpointStore" was dropped: no such
   lock exists to share, capture is worktree-read-only (temp index), and
   the only mutating op (restore) runs on fresh clones at materialize time.
3. No global dirty-transition stream or idle/pre-sleep hooks exist;
   triggers became turn-diff-completed + interval + settings-enable.
4. Consent deviation: WIP content reaches the ORIGIN HOST (unlike vault
   data, which never leaves the user's machines) — so `roamingWipSync`
   defaults false and the pre-checked pairing row is the consent.
5. The review round added: vault-set subtraction from WIP capture (an
   include override can name a non-gitignored file; vault content is
   P2P-only by design), restore-wip reordered before apply-vault (its
   cleanliness check runs on the pristine clone), and the WIP-ref-mirrors-
   the-tree-even-when-clean rule (a stale dirty snapshot on the origin
   would otherwise resurrect committed work as phantom dirt on restore).

### Build (PRs #33–#36)

Contracts (#33, codex-implemented from spec, reviewed line-by-line);
WipSnapshotReactor + WipSnapshots (#34, authored in-session after two
consecutive codex hangs — high-effort opus review found the bundle-mode
blob churn (fixed: shipped-tree no-op baseline), permission-before-lease
classification, and stale-status clearing); Materializer restore-wip +
completed-record revalidation (#35, review verdict merge-as-is — traced
the duplicate-project concern to a non-issue since registerProject keys on
the stable workspaceProjectId); UI (#36 — pairing row, settings row,
push-failure list, materialize checkbox; review confirmed no canonical-
workflow violations).

### Field bug fixed en route (2026-07-07, user report)

Materialize → delete project from the app → delete files → materialize
again returned a success toast while doing nothing: the completed
`roaming_materializations` record short-circuited unconditionally (an M2
"accepted" constraint that real use disproved); only wiping `~/.t3-fork`
recovered. Fix in #35: completed records revalidate (targetPath has .git
AND linked project live) before short-circuiting. Regression-tested at
unit and harness level.

### Acceptance (2026-07-07)

`accept-m2.5.mjs` (canonical workflow: pair once → live remote thread on
the peer → kill peer → materialize with secrets) re-ran green on the new
code. `accept-m3.mjs`, three projects on a fresh harness:

- P1 (healthy origin): dirty tree + untracked file captured within one
  interval tick, pushed as `refs/t3/wip/<wsid>/<envid>` with parent=HEAD,
  `.env` EXCLUDED from the snapshot tree; A SIGKILLed; materialize on B
  restored the dirty tree from the origin's hidden refs and the `.env`
  from the vault.
- P2 (pre-receive deny hook): first push flipped the project to bundle
  mode; the wip blob mirrored to B; materialize on B (A still dead)
  restored from the bundle.
- P3 (origin removed after setup): push failure surfaced as
  `roamingWipStatus.lastError` over the HTTP shell snapshot (that route
  gained the reactor merge in #37 — the ws-only merge would have missed
  the HTTP-first shell load).
- Field-bug regression: deleting the materialized files and re-running
  materialize re-cloned and re-restored for real.

All nine checks passed (M3-EXIT:0).

### M3 field session (2026-07-07, same night as M3 close) → M3.5 inserted

Real two-machine use immediately after M3 merged surfaced three findings:

1. **No delivery path outside materialize.** M3 shipped continuous capture,
   but an already-materialized checkout never pulls newer WIP — nothing
   fetches, nothing applies, and the revalidated completed record correctly
   short-circuits re-materialize. A file created on the desktop therefore
   never reaches the laptop's working tree. Per the user's stated
   expectation (Dropbox semantics between one's own machines), M3.5 adds
   auto-apply for the safe case: strictly-behind checkouts (clean, or
   exactly at the last-applied snapshot tracked by a local
   refs/t3/wip-applied marker) fast-forward automatically; locally-edited
   trees are never touched (divergence stays M5's explicit flow).
2. **Per-machine consent trap.** The M3 settings row writes roamingWipSync
   locally only; the one-decision-for-both-machines behavior rides the
   pairing handshake. Machines paired before M3 must flip the row on BOTH
   machines — the user hit exactly this (laptop never captured).
3. **`.idea` moved via git, not via sync.** Tracked files travel in clones
   and WIP snapshots regardless of .gitignore (gitignore never affects
   tracked files) — the user's .idea was presumed committed-then-ignored.
   The design gap it exposed is real either way: there was no channel for
   "gitignored but should travel between my machines" beyond secret
   patterns. M3.5 adds `.t3sync` (per-project, repo root, gitignore
   syntax) feeding the vault/P2P channel.

Also flagged: origin-refs mode had NO size cap (bundle mode caps at 8 MiB)
— a huge untracked file would be pushed to the git host. M3.5 adds the
guard. Capture latency: the 2-min interval was the analysis-pass
simplification; the user directed Dropbox-class freshness now, so the
originally-planned watch-based trigger lands in M3.5 (VaultSync's
FileSystem.watch + debounce is the in-repo precedent).

---

## M3.5 — Sync completion (DONE 2026-07-07, PRs #38–#42, same-night field session)

Inserted hours after M3 closed, when real two-machine use showed capture
without delivery isn't sync. Narrative highlights beyond the landed
constraints:

- **Auto-apply** went through a high-effort adversarial review that found
  two silent data-loss windows before merge: a TOCTOU between the
  edit-free judgment and the destructive restore (closed by re-verifying
  the worktree tree immediately before restore), and locally-edited
  vault-manifest files being invisible to the vault-subtracted guard,
  deleted by `clean -fd`, then resurrected from a possibly-stale mirrored
  blob (closed by preserving the WORKTREE's own copies across the
  restore). Both have regression tests.
- **The t3sync design went through three user-driven iterations in one
  sitting**: (1) per-project include file only → (2) "defaults
  pre-populated into every project's .t3sync" — rejected by the user's own
  probing: the app would write files into every repo unprompted →
  (3) OPTION A, git's core.excludesFile model: one global editable
  defaults file in the app's state dir + optional user-created repo-root
  .t3sync with veto power. The registry vaultOverrides mechanism — M2
  plumbing that never got an editing surface — was retired the same
  moment. Process note: iteration (2) was implemented before the user had
  agreed to it; he had explicitly said "answer, don't implement". The
  option-A rework cost an extra round. Ask, then build.
- **Freshness beacon**: the origin-refs path had no peer notification
  (bundle mode got one for free via blob writes), capping delivery at the
  2-minute tick. An empty-bundle wip blob per successful push rides the
  existing mirror write-trigger; measured A→B delivery on the harness:
  ~1 second.
- Acceptance (`accept-m35.mjs`, all green + canonical re-run): 1s
  delivery onto a clean checkout; a locally-edited checkout survives 45s
  of delivery pressure untouched; gitignored `.idea/` listed in .t3sync
  round-trips A→B while `git ls-tree` proves the origin's WIP refs hold
  neither `.idea/` nor `.env`; a 60 MiB untracked file surfaces a warning
  and never reaches the origin.

---

## M3.6 — Field round 2 (DONE 2026-07-07, PRs #43–#47)

Second same-day field session, hours after M3.5. Findings and outcomes:

1. Laptop→desktop never delivered: correct-but-invisible blocking (the
   desktop always holds its own WIP). Fixed the right half with based-on
   provenance (T3-Based-On trailer + pure-fast-forward allow path,
   adversarially reviewed: self-gating on a locally-resolvable based-on
   commit makes even peer deletions recoverable), and made the blocking
   half VISIBLE (blockedReason + the project-row indicator).
2. `.t3sync` additions delivered the bundle to the peer's blob store where
   it sat forever — the vault channel had capture and transport but no
   delivery, the same disease M3.5 cured for WIP. Vault apply-on-arrival
   with the per-file applied-hash contract closed it; the update path
   (changed secret reaching an unmodified peer copy) only works because
   the applied record distinguishes "unmodified since MY apply" from
   "locally edited".
3. The user asked how Dropbox-class tools signal sync state; the indicator
   is the deliberately minimal version (silent when healthy).

Process notes: the session-restart pattern kept killing background
acceptance runs mid-flight ("are you stuck again?") — the fix was
launching the gauntlet as a detached setsid process with a log file,
immune to app restarts. Worth keeping for all future long harness runs.

---

## M3.7 — Sync hardening (DONE 2026-07-10, PR #52 + per-file-apply PR)

Planned as latency instrumentation + watcher budgeting; became three field
sessions of sync-correctness work once real usage surfaced what the M3.6
model actually did under concurrent two-machine edits.

1. **Root cause round (PR #52):** the M3.6 "bimodal latency" and the
   settings-watcher flake were one bug — `fs.inotify.max_user_instances`
   exhaustion (128 shared with every desktop app; recursive project watches
   register into node_modules/.git). Evidence-only PR; the mitigation became
   interval backbones: VaultSync got a 30s sweep (capture AND deliver), so no
   sync direction depends on a live watcher.
2. **Per-file apply:** whole-tree blocking replaced by a per-file three-way
   merge (peer-changed vs base; ours-wins + surfaced on both-changed).
   First delete handling shipped, was reverted for propagating deletions too
   eagerly, then landed correctly (9eeb12d2) for the AUTHOR side via the
   pushed-marker fallback.
3. **Field round 3 (the receiver-side delete disaster):** deleting a
   peer-authored file on the receiving machine showed Waiting for minutes and
   then resurrected it (the user's `go-to-desktop.md` / GNOME
   `Untitled Document` case). Three distinct defects, each with a regression
   test that fails on the old code:
   - a conflict on ANY path held the whole applied marker back, unrecording
     files applied in the same pass → later deletes read null==null
     "untouched" and re-added the peer copy. Fix: marker advances every pass;
     conflicted paths pinned to their base blob in a synthetic commit dated
     newestUnix-1 (staleness gate keeps re-examining; Waiting stays honest).
   - the author never learned about the delete: its own echoes are tree-equal
     no-ops, so its marker lagged and the deletion produced no diff vs HEAD
     (untracked file). Fix: deletions also enumerate against the shipped
     snapshot, gated on the peer's T3-Based-On state PROVABLY containing the
     file — the 92b641b4 destructive-delete flap stays impossible by
     construction (an ignorant snapshot fails the guard).
   - capture dedup swallowed the delete: post-delete the tree equals a
     previously-shipped tree → "nothing to ship" while the peer had moved
     past that state. Fix: ship once when the applied marker moved since the
     last ship (the Based-On update IS the message), settle next pass; the
     applied-marker-tree is a second no-op baseline so two idle machines
     never ACK-ping-pong.
4. **Pill data path:** `projects[].workspaceProjectId` was null in every
   shell response — `listProjectRows` (and three sibling mappings) never
   selected the column, masked by `withDecodingDefault(null)`. Same omission
   in the decider read model had silently disabled the double-enrollment
   invariant. Statuses: baseline publish on first pass, seeding into resumed
   ws subscriptions, and restart survival by reconstructing timestamps from
   marker-ref commit dates (rejected a persistence table: git already holds
   the durable fact; a table is a second source of truth with migration +
   drift costs).
5. **Titles roam:** rename → registry blob rewrite (title only, other fields
   preserved) → mirror → peer applies to its linked project. Event-triggered
   both directions; pass-based reconciliation was explicitly rejected (a
   stale pass would undo an in-flight remote rename). Sidebar group label
   prefers a shared member title over the repo name (the "project renamed
   itself after materialize" bug was label precedence, not data).

Verification: full server suite (1452), roaming suite, and repeated
fresh-harness E2E — pair → materialize → WIP both ways → receiver-side delete
clean AND with a live README conflict (no resurrection, deletion propagates
~60s, conflict surfaces as Waiting) → server restart shows seeded "Synced"
timestamps. The row's formal exit criteria (10× delivery-latency run, watcher
stress fixture) were NOT run — user closed the stage 2026-07-10 accepting
that gap; revisit under M4 if field latency complaints persist.

Process notes: unit tests alone missed two of the three deletion defects —
only the two-instance harness exposed the capture-dedup and marker-timing
interactions. `codex exec` background runs hang reading a non-TTY stdin
unless `</dev/null` is appended (root cause of three sessions of "silent
codex hangs"); model pinning (`-m`) is now explicit in the codex skills.

## M3.7 formal exit criteria session (2026-07-10, reopened same day)

The first M3.7 close skipped the row's formal exit criteria; this session
executed them per user directive ("these are DEFECTS in the shipped sync").
Instrumentation strictly first, fixes only for measured stalls.

**Measurement infrastructure.** Every delivery stage now logs a permanent
`roaming timing:` line keyed by commitOid/blob version: watch-trigger →
captured → origin-pushed → beacon-written → mirror-exchange (with trigger
provenance: interval/blob-write/peer-notify/manual, threaded through a
sliding-queue-of-string) → blobs-pushed-to-peer → wip-blob-ingested →
arrival trigger → peer-refs-fetched → apply. `accept-m37.mjs` writes a file
on A ten times, polls B at 100ms, and prints a per-stage table per delivery
from the two server.log files.

**Analysis-pass correction (measured).** The first close attributed the
ENOSPC to `max_user_instances` per watcher. Measured: libuv shares ONE
inotify instance per process regardless of fs.watch call count — instances
are consumed per PROCESS (zombies, desktop apps), while the recursive
watchers exhausted `max_user_watches` (one running desktop instance held
~167,340 watches, node_modules/.git registered). Same ENOSPC, different
budget; the fix directions held for both.

**Baseline (clean machine!).** The bimodality reproduced immediately:
delivery 1 ~28s, deliveries 2-10 all ~52s phase-locked. The stage table
attributed it in one read: A captured/pushed/beaconed in ~500ms, then
NOTHING on A — B's own 60s interval pass fetched the beacon. Root cause:
mirror connectivity is one-directional (M2.5 tamper resistance: the callee
holds no credential/URL for the initiator; the server cannot discover its
own reachable URLs, so a reciprocal-credential handshake is a dead end).
The "fast" runs in the field were writes that rode an adjacent trigger.
M3.5's "~1s A→B" acceptance number was exactly that luck.

**Fix 1 — mirror/wait long-poll.** The initiator (only side with
credential+URL) holds `POST /api/roaming/mirror/wait` (25s hold, same
gating as all mirror routes) against an in-memory blob-store change
revision; any callee blob write returns it and the initiator passes
immediately. Works for existing pairings without re-pairing. Run 3:
delivery 1 dropped to 0.6s — and exposed fix 2.

**Fix 2 — enrollment trigger.** The pairing-time settings scan raced
RoamingAutoEnroll: a project enrolled after the scan had no watcher and no
first snapshot until the 2-min sweep (run 2/3: first delivery waited ~106s
or ~2min). `project.meta-updated` with a workspaceProjectId now triggers a
scan. Also found here: the recursive watcher was dying within ~1s of
install on git's transient `.git` churn (Node's Linux recursive watch
errors on vanished dirs mid-registration) — the probable mechanism behind
much of the field's "watcher flake", distinct from budget exhaustion.

**Fix 3 — staleness tie deadlock.** With the pipeline sub-second, A's
fresh snapshot and B's echo marker routinely land in the same 1-second
committer stamp; M3.5's `<=` skip then blocked delivery until A's tree
changed again (run 4: hot file captured+beaconed in 900ms, B refused it
forever). Applied-marker ties now evaluate (identical commit still skips);
unit regression test added. Codex review (P1, verified real) kept HEAD
ties at `<=`: with no applied marker the merge base falls back to HEAD,
and a tied-but-stale snapshot lacking a just-committed file reads as a
peer deletion of it — base-diff deletions are not Based-On-gated (that
remains a flagged narrow gap for no-marker states generally).

**Fix 4 — waiter spawn latency.** Run 5: 9/10 deliveries ~5.5s, one 43.7s
outlier — the waiter for a fresh pairing spawned only on the 30s reconcile
scan, missing the first beacons. Waiters now also reconcile on every
mirror drain pass (atomic claim against double-spawn).

**Run 6 (criterion): 0.7, 5.6, 5.5, 5.7, 5.5, 5.6, 5.7, 5.4, 5.3, 5.8 —
max 5.8s, all ≤10s.** Steady state = 5s watch debounce + ~0.5s chain.

**Watcher budget.** Linux tree watching rewritten to per-directory
registration (walk skipping .git/node_modules/dist/build/target/out/
.venv/__pycache__, symlinks never followed, dir-create walks the new
subtree, dir-delete prunes watchers by prefix), 4096-dir cap per project.
Watch death/cap → 10s fallback sweep + `notice` field on the status entry
(new optional contracts field; amber "Sync on" pill with concept-free
copy) + real-watch retry ~5min; the notice is reactor state merged into
every publish so passes cannot wipe it, and clears only after a fresh
watch stays healthy 30s. Settings watcher backed by an unconditional 2s
mtime poll (the "can never starve" guarantee — external edit honored
within 5s at zero budget). Measured after: 1 inotify instance, ~5k watches
for 13 harness projects.

**Stress fixture pivot.** The first fixture exhausted real
`max_user_instances` (200 `tail -f` holders) and restarted A — the server
CRASHED in upstream watch paths (git driver watching .git/hooks and
FETCH_HEAD, atomic-write temp files) before roaming code was reached.
Fixing upstream watch error handling is outside the milestone's blast
radius (fork discipline), so `accept-m37-stress.mjs` instead drives the
budget machinery deterministically: 12 live projects + a 13th with 4200
directories (over the cap) — notice surfaced, fallback-sweep delivery,
healthy projects unaffected, settings edits ≤5s in both phases (measured
340/350ms). The instance-exhaustion crash is recorded as an accepted
known limit.

Process notes: the codex CLI's `review --base` rejects a custom prompt in
this version (both stdin `-` and positional) — the default review stance
still surfaced the one real P1. Compound Bash one-liners (harness restart
chained with nohup launches) misfired twice; step-by-step absolute-path
commands are the reliable pattern. Every harness/acceptance run went
through /tmp scripts with /tmp logs and was judged from the log on disk.

## M3.7 addendum: field verification round (2026-07-10, same day)

User field testing after the criteria session surfaced three reports:
creations "a few seconds" (= the designed 5s debounce + chain), deletions
"minutes", and remote-thread rows flapping on the laptop. A timed harness
deletion test reproduced the deletion report as a PERMANENT deadlock (not
latency): the author-side delete returned the worktree to an old
applied-marker tree, the unconditional applied-tree no-op baseline skipped
capture forever, and the shipped ref kept advertising the deleted file.
Fixed by gating that baseline on agreement with the shipped tree; ~5.5s
deletions both directions after; unit regression added; full ladder
(m37/m35/m36/m2.5) re-run green. A 4-minute churn/responsiveness test found
zero server stalls (238 probes, max 38ms), so the flapping had no harness
repro; the user later reported it stopped after the fixes. The branch-blind
sync finding from the same field round became the M3.8 SHIP GATE (see the
decisions log). Harness readiness curl got --max-time 5 after an untimed
probe wedged a suite run under parallel CPU load.


## 2026-07-11 — M3.8 options analysis + decision (branch-aware sync model)

Context: the 2026-07-10 field finding (see the ship-gate decision below in
the archived decisions log) — committed branch work on machine A arrived on
machine B's different branch as unstaged soup, and stayed soup even after A
merged and pushed. Root cause is the v1 snapshot semantics working as
specified: the WIP ref mirrors the worktree TREE only; branch/HEAD/index are
invisible to sync.

Code-mapping findings that grounded the analysis (gpt-5.6-sol read-only pass
over `apps/server/src/roaming/` + contracts, 2026-07-11):

- Nothing anywhere records a branch name. The wip payload is
  `{ schemaVersion, capturedAt, refName, commitOid, treeOid, bundleBase64 }`;
  the only branch provenance is implicit (snapshot commit's parent = the
  HEAD it sat on). The apply side never asks git for the current branch.
- The M3.5 "edit-free checkouts fast-forward" never moved a branch ref or
  HEAD in live apply OR materialize — it wrote worktree files and advanced
  the hidden applied marker. So committed work had no delivery mode other
  than "appear as modifications."
- Materialize had the same defect latent: it restored the newest WIP tree
  onto the default branch regardless of which branch the WIP came from.
- The apply staleness gate compared committer wall-clock timestamps against
  HEAD's commit time — a heuristic that ancestry checks can replace once
  head identity travels with the snapshot.
- Useful accident: pushing the WIP ref uploads its parent closure, so a
  peer's local-only commits (never pushed to a branch) already reach the
  origin as objects; bundles (`--not --remotes=origin`) likewise carry
  them. Branch-aware apply therefore needs no new transport.

Options assessed (per the M3.8 row's mandate):

- (a) Gate auto-apply on same branch/HEAD, surface "on different branches"
  — a guard, not a model; alone it leaves the field scenario permanently
  stuck. Kept as the surfaced state when the gate blocks.
- (b) Branch-aware snapshots — carry `branchRef` + `headOid`, apply
  reproduces the peer's git state (checkout/ff) before laying the dirty
  diff on top. The industry-precedented model (Codespaces auto-save,
  git-wip workflows, jj's working-copy-as-commit). Smallest delta from the
  shipped code since parent=HEAD already exists. CHOSEN as the model.
- (c) Auto-apply only onto never-locally-touched checkouts — not an
  alternative but (b)'s safety condition; alone it doesn't fix
  branch-blindness. CHOSEN as the gate.
- (d) Other directions: syncing `.git` raw (rejected — repo-corruption
  class); demoting all apply to explicit takeover (kept as the documented
  fallback re-scope if full-state auto-apply still feels wrong in real
  use — deletes the surprise class while keeping most of the value).

Decision (user, 2026-07-11): (b)+(c) with (a) as the blocked-state surface,
under the principle "auto-apply reproduces the peer's complete git state or
touches nothing." Three sub-decisions, user picked the recommendation on
all: (1) auto-switch branches on untouched checkouts: YES (parking makes it
lossless; downgrading to explicit-only later is cheap — it's one slice);
(2) minimal takeover ships inside M3.8: YES (blocked states must not
dead-end; full takeover UX stays M5); (3) per-branch parked refs: YES
(`refs/t3/wip-parked/<wsid>/<branch>` — multi-branch WIP survives
switching; a machine's single live wip ref would otherwise overwrite).

Migration decisions: wip payload schemaVersion bump; legacy payloads never
auto-apply (surfaced notice, age out on next capture); both machines must
run ≥M3.8 builds before branch-aware behavior holds end-to-end (acceptable
for a two-machine fork); no ref renames, no marker migration; the
timestamp-vs-HEAD staleness gate is deleted rather than kept alongside the
classifier (two overlapping gates caused M3.7's tie-deadlock).

## 2026-07-11 — plan restructure (three-file split)

User directive: the plan had grown to 1241 lines of mixed plan, status,
results, and constraints — unreadable. Restructured into three documents:
`21-roaming-workspace.md` (lean current-state plan), `21-roaming-reference.md`
(NEW — binding technical mechanics: refs, schemas, invariants, harness),
and this history file (narratives, results, superseded text). The plan's
"Landed constraints" section was redistributed: behavior-defining rules
into the plan's Design sections, mechanics into the reference file. The
sections below preserve the evicted plan text verbatim as of commit
1fd049d7 (pre-restructure) — first the status/decisions blockquote, then
the full Landed constraints.

### Archived: plan status + decisions blockquote (verbatim, pre-restructure)

> **Status:** M3 (WIP snapshots) DONE 2026-07-07 — PRs #32–#37: analysis
> pass (independently reviewed; bundle spike flipped WIP commits to
> parent=HEAD), contracts, WipSnapshotReactor (capture + origin-refs push +
> bundle fallback + status surfacing), materialize restore-wip (+ the
> 2026-07-07 field bug: stale completed materialization records now
> revalidate), UI (Work in progress row in the one pairing flow, settings
> row, push-failure surfacing, materialize toggle). Acceptance green on the
> M0 harness: `accept-m3.mjs` (origin-refs path with A killed, bundle
> fallback end-to-end, push failures surfaced, field-bug regression) plus
> the canonical-workflow re-run (`accept-m2.5.mjs`). Materialize now =
> clone + WIP snapshot + secret files + registration. **M3.5 (sync completion)
> DONE 2026-07-07** — PRs #38–#42, driven by the same-night field session:
> auto-apply delivery (edit-free checkouts fast-forward; local work is
> never touched), filesystem-watch capture + freshness beacon (~1s A→B
> end-to-end on the harness), graceful-shutdown snapshot, t3sync manifests
> (global defaults file + per-project .t3sync, user decision — replaces
> vaultOverrides and the hidden pattern list), origin-mode size guard.
> Acceptance green: `accept-m35.mjs` + canonical re-run (`accept-m2.5.mjs`).
> Constraints under [Landed constraints](#landed-constraints-m0m35).
> **M3.6 (field round 2) DONE 2026-07-07** — PRs #43–#47, same-day field
> findings: HTTP shell snapshot respects the roaming flag; vault bundles
> deliver on arrival to live checkouts (missing/unmodified/locally-edited
> per-file contract, applied-hash record); based-on fast-forward (edits
> made on the materialized machine flow back to the still-unchanged dirty
> author via T3-Based-On provenance; divergence stays blocked for M5);
> blockedReason + per-project sync indicator in the one list. Acceptance:
> `accept-m36.mjs` + `accept-m35.mjs` + canonical re-run, all green.
> **M3.7 (sync hardening) DONE 2026-07-10** — PR #52 (root cause: inotify
> `max_user_instances` exhaustion) + the per-file-apply PR. Scope grew
> beyond the row's spec, driven by two field sessions: per-file WIP merge
> (replaces whole-tree blocking; concurrent edits to different files
> cross), a correct two-machine deletion model (always-advanced applied
> marker with conflicted paths pinned to base; shipped-diff deletions
> gated on T3-Based-On provenance; causality re-ship when an unchanged
> tree follows a marker move), sync pill data path (shell projections now
> carry `workspaceProjectId`; statuses baseline-publish, seed on ws
> resume, and survive restarts via marker commit dates), project-title
> propagation through the registry (renames roam), vault interval
> backbone (30s sweep; the fs watcher is an optimization, not a
> guarantee). Verified: unit suite + repeated two-instance harness E2E
> (pair → materialize → WIP both ways → receiver-side delete with a live
> conflict → restart). **Formal exit criteria MET 2026-07-10 (reopened and
> completed the same day, user directive)** — the criteria had been skipped
> on the first close. Instrumentation-first per the row: every delivery
> stage logs a "roaming timing" line keyed by commitOid. Measured on a
> CLEAN machine, the harness baseline was bimodal exactly as reported
> (~0.8s or ~52s phase-locked); three root causes found and fixed:
> (1) mirror connectivity is ONE-directional — only the pairing initiator
> holds a credential/URL pair, so the callee's beacons sat until the
> initiator's 60s interval → new `mirror/wait` long-poll (initiator holds
> it; callee blob writes return it; works for existing pairings, no
> re-pair); (2) nothing triggered the WIP reactor on enrollment, so a
> fresh pairing had no watcher/first snapshot until the 2-min sweep;
> (3) the M3.5 staleness guard's `<=` tie-skip deadlocked the now
> sub-second pipeline (1s committer stamps) — marker ties now evaluate
> (identical commit still skips; HEAD ties stay `<=`, review finding).
> Watcher budget: per-directory registration on Linux excluding
> node_modules/.git/build (recursive fs.watch held ~167k watches for one
> desktop instance; now 1 instance + ~hundreds per project), 4096-dir cap
> per project, watch death/cap → surfaced notice + 10s sweep (never the
> silent 2-min cliff), settings watcher backed by an unconditional 2s
> mtime poll. Criteria green: `accept-m37.mjs` 10/10 deliveries ≤10s
> (max 5.8s, steady ~5.5s = 5s watch debounce + ~0.5s chain);
> `accept-m37-stress.mjs` (12 live projects + over-cap 13th: notice
> surfaced, sweep delivery, others unaffected, settings ≤5s);
> `accept-m35.mjs` + `accept-m36.mjs` + canonical re-run all green.
> **SHIP GATE — NEXT UP: M3.8 (branch-aware sync model). Declared by the
> user 2026-07-10 after real two-machine use: branch-blind WIP auto-apply
> is COMPLETELY BROKEN for real git workflows and BLOCKS SHIPPING THE SYNC
> FEATURE AT ALL — not a side-note on any milestone, its own
> analysis/decision phase whose outcome may change the sync model's
> direction. Nothing ships until its decision lands (see the M3.8 row and
> the 2026-07-10 decisions-log entry).** M4 (bootstrap recipes; its
> analysis pass must scope honest limits — v1 targets scriptable setups;
> capture-what-happened over guaranteed-boot) queues behind it. M2.5 DONE
> 2026-07-06 (PRs #19–#29+).
> **Decisions log (still binding; full log + superseded entries in
> [21-roaming-history.md](21-roaming-history.md)):**
> 2026-07-04 — v1 transport for small state = machine-to-machine mirror
> (user decision); cloud store backend deferred to gated milestone M7
> behind the same `RoamingBlobStore` interface.
> 2026-07-05 — **Product model locked (user decision): one project list, no
> user-visible "roaming"/"machine sync"/enrollment concept, and "pairing"
> means the EXISTING pairing/thin-client flow** — that one flow carries the
> JetBrains-style sync-options step (Projects always on; Secret files
> pre-checked; WIP and Conversations rows arrive with M3/M6). Registry
> metadata syncs automatically for ALL projects once machines are paired;
> per-project configuration survives only as the vault include/exclude
> override. Guard rails: vault bundle size cap; never overwrite local files
> silently on apply; M7 must re-ask the secrets consent before any cloud
> backend activates. (M2 shipped a standalone "Machine sync" flow in
> violation; M2.5 was the corrective — the canonical workflow section above
> now exists to stop that class of drift, and every milestone re-runs it.)
> 2026-07-05 — **Cloud-pairing readiness (user directive):** when upstream's
> T3 Cloud environment discovery opens up, it replaces only the manual
> introduction (URL + code) — never the trust model. Pairing sits behind the
> peer-introduction seam (`PeerIntroduction` in client-runtime): cloud
> arrives as a new producer behind an existing seam, not a redesign. Same
> discipline as D0's `RoamingBlobStore` for the M7 storage backend.
> 2026-07-06 — **M2.5 product model finalized under real two-machine use
> (user, across a long field session).** Corrections that OVERRIDE earlier
> wording, now reflected in [Landed constraints](#landed-constraints-m0m25):
> (1) sync on/off is a PAUSE on the standing pairing, never a code — codes
> are only for the first enable on an unpaired machine; (2) the pairing's
> "Secret files" choice is ONE decision applied to whichever machine holds
> each project (overrides M2's per-machine consent); (3) one paired machine
> = one row in Authorized clients, credentials collapsed, user's pairing
> label wins over hostnames; (4) Materialize is enabled-iff-workable
> (visible+disabled-with-reason otherwise), fetches blobs on demand, auto-
> trusts well-known SSH host keys, and prompts once for a projects folder;
> (5) revoked/auth-failed remotes go dead and flip to offline+Materialize.
> Full field-findings narrative in the history file. Materialize today =
> clone + secrets; uncommitted-work sync remains M3.
> 2026-07-06 — **Milestones RENUMBERED to execution order (user decision):
> M3 = WIP snapshots (was M4), M4 = bootstrap recipes (was M3).** WIP-first
> rationale: uncommitted work is in the thesis's first sentence and kept
> surfacing as the missing piece in real use; recipes are the comfort
> feature — and recipes are open-ended risk (an agent setting up an
> arbitrary unknown project — unscripted services, databases, system deps —
> is a black box; the milestone's "small" size is plumbing only). The
> recipes milestone's analysis pass must scope honest limits (v1 targets
> scriptable setups; capture-what-happened over guaranteed-boot). Documents
> written before 2026-07-06 (the history file) use the OLD numbering.
> 2026-07-10 — **SHIP GATE (user directive, field session): branch-blind
> WIP sync is not shippable — period.** Field finding on the real machines:
> the user modernized a repo on the desktop on a NEW branch (all work
> committed there); the laptop — still on `master` — received that work as
> UNSTAGED modifications on `master`. After merge+push on the desktop, the
> laptop again showed the merged content as an unstaged mess. This is the
> v1 model working AS SPECIFIED (snapshots mirror the worktree TREE only;
> branches/HEAD/index are invisible to sync, commits travel via origin) —
> and the user's verdict is that the specification itself is COMPLETELY
> BROKEN for real git usage: "we can't be creating such a mess in the
> git; this is not acceptable to ship." Explicitly NOT to be recorded as
> a bullet under M5 or any existing milestone: it is its own phase (M3.8)
> whose outcome — up to and including a direction change for the whole
> sync model — gates ANY shipping of the sync feature. Proper handling is
> an OPEN QUESTION; the user has deliberately not picked a direction, and
> no implementation may start before an options analysis and an explicit
> user decision.
> **How to execute:** this document is self-contained. To start work in a fresh
> thread, paste one of the kickoff prompts from the [Kickoff prompts](#kickoff-prompts)
> section at the end. Milestones run strictly in order (M0 → M2, M2.5, M3 → M7; renumbered 2026-07-06 so execution order and numbers agree).
> Every milestone begins by re-reading the Canonical workflow section and ends
> by demonstrating it end to end.

### Archived: Landed constraints M0–M3.7 (verbatim, pre-restructure)

## Landed constraints (M0–M3.5)

Full analysis/results narratives live in
[21-roaming-history.md](21-roaming-history.md); git history and the PRs hold
the diffs and rationale. This section keeps ONLY what still binds future
work. When a milestone completes, its constraints land here and its
narrative moves to the history file — this document stays current-state.

### Platform + harness facts (M0, 2026-07-04)

- Origin hidden refs: GO on GitHub over SSH (the only real host in use).
  Non-fast-forward updates need `--force` → WIP pushes use
  `--force-with-lease` or fast-forward chains; ref deletion works (pruning
  viable); the default fetch refspec never sees `refs/t3/*`. Spot-check any
  new host the first time a project uses one.
- Server-to-server auth: GO — pairing credential → `/oauth/token` bearer
  exchange works headless (`scripts/roaming/spike-server-to-server.mjs` is
  the smoke test).
- Harness: `scripts/roaming/harness.sh start|stop|status` — two `t3 serve`
  instances from source on `127.0.0.1:14801/14802`, base dirs under
  `/tmp/t3-roaming-harness/instance-{a,b}/basedir`, distinct persisted
  environment-ids; state in `<baseDir>/userdata`; never pass
  `--tailscale-serve`. Acceptance scripts: `accept-m{1,2,2.5}.mjs`.
- The harness serves the PREBUILT `apps/web/dist` bundle — rebuild
  (`cd apps/web && pnpm run build`) after web changes or browser walks test
  stale UI. Headless web login: the `/pair` page + a one-time admin code.
- The settings file stores non-default values only: a boolean set to its
  default reads back as absence.

### Registry + mirror (M1, PRs #2–#5)

- `roaming` flag = `ServerSettings` boolean (default false); reactors
  always start and internally no-op while it is off.
- No server-side peer endpoint discovery exists: peer base URLs are
  recorded at pairing and tried in order (revisit at M3/M5 when real
  two-box usage starts).
- Mirror RPCs = raw authenticated HTTP routes, schemas in
  `packages/contracts/src/roaming.ts`; `roaming:mirror` is granted nowhere
  by default and deliberately NOT requestable via `/oauth/token`.
- Blob address = `(kind, key)` with contractual per-kind key derivation
  (registry/vault/recipe/lease → workspaceProjectId; wip →
  workspaceProjectId/environmentId; transcript/brief → threadId). Payload
  strings are byte-authoritative for hashing — never re-serialize before
  hashing. Conflict records retain the full remote record. The blob store
  serializes read-modify-write and verifies `contentHash` on ingest.
- `workspaceProjectId` is persisted in the SQL projection path, not only
  the in-memory projector.
- Enrollment/administrative routes require `access:write`; mirror routes
  require `roaming:mirror`.
- Callee-side peer records are tamper-resistant: `ensurePeer` is
  insert-only and callers' advertised base URLs are ignored. (The
  initiator side is deliberately NOT — see M2.5 accepted risks.)
- `project.roaming.enroll` dispatches before the registry blob write (the
  decider gates double-enroll; no orphan blob can mirror out); re-enroll is
  idempotent and self-heals a missing blob.
- `lastMirrorContactAt` = global max across peers, written only by a
  completed mirror pass (revisit ~M3 for per-project staleness).
- Roaming shell stream events ride `sequence: 0`; the client reducer owns
  all sequencing rules.
- Flag-off behavior: shell snapshots hide `roamingProjects`; roaming routes
  404 — EXCEPT the two pairing routes (M2.5); local blob data is retained.

### Vault + materialize (M2, PRs #7–#16)

- Vault bundle = JSON `{ schemaVersion, capturedAt, files: [{ path, mode,
  sha256, contentBase64 }] }`; cap = total decoded bytes
  (`ROAMING_VAULT_BUNDLE_MAX_BYTES`, 16 MiB since M3.5 — the bundle also
  carries `.t3sync`-selected trees — enforced from `stat` before any read);
  oversize captures are skipped with a surfaced warning, never truncated.
- Effective vault set (REVISED M3.5, supersedes the M2 rule): the global
  `<stateDir>/t3sync` file (defaults written into it once) plus the
  optional repo-root `.t3sync`, matched by git's own exclude engine —
  `vaultOverrides` and the hidden top-level pattern scan are retired. A
  file is captured only if manifest-matched AND untracked (`git ls-files`;
  `check-ignore` is the wrong tool — it flags committed lookalikes).
  Fail-closed: a genuine ls-files failure skips capture. Symlinks are never
  captured; apply refuses symlinked targets/parents outside the workspace
  root and writes new files with their mode up front.
- `roamingSecretsSync` = per-machine capture consent (pairing-time
  propagation rule under M2.5 below).
- Materialize = synchronous `POST /api/roaming/materialize` + resumable
  step machine in `roaming_materializations` (migration 035): resolve-path,
  clone, apply-vault, restore-wip (recorded-as-skipped until M3),
  register-project, bootstrap (skipped until M4). Failed runs return the
  failed record over HTTP 200; resume continues from the failed step; a
  completed record short-circuits even with a different targetPath
  (REVISED M3: only while the targetPath still holds a git checkout AND
  the registered project is live — see M3 constraints).
  apply-vault never overwrites an existing differing file (notice instead);
  interactive overwrite belongs to the on-demand "pull vault files" path.
  Live progress = the step machine's own PubSub merged at the shell
  subscribe point (`roaming-materialization-updated` events +
  `roamingMaterializations` snapshot field).
- `RoamingAutoEnroll` triggers on startup, peer-added (both directions),
  `project.created`, and settings changes; it skips any workspaceRoot that
  is a materialization target path (fork guard on the D1 identity).
- `ensureRegistryRoot` merges `perMachineRoots` on raw JSON so
  newer-schema peers' fields survive an older machine's version bump.
- Accepted per D3: two machines materializing from the same registry
  version produce an equal-version conflict (disjoint perMachineRoots keys
  are not auto-merged).
- Conflict get/resolve routes require `access:write` (they carry secret
  payloads); resolution = pick a side, written as a new higher version.

### Unified pairing (M2.5, PRs #19–#29 + field-hardening)

Handshake (unchanged from the original M2.5 build):
- ONE handshake, orchestrated by the initiating machine's own server
  (`POST /api/roaming/peers`): exchange the single-use code at the peer's
  `/oauth/token` with NO scope parameter (the peer consumes the code before
  its scope check, so requesting scopes a weaker code lacks would burn it),
  then branch on the granted scopes. With `access:write`: mint the 365-day
  `roaming:mirror` credential AND derive a fresh STANDARD attach bearer.
  Without it: attach-only with a typed reason, zero side effects — a
  first-class outcome. The peers + machine-credential routes are NOT gated
  on the `roaming` flag; pairing is what turns it on.
- The handshake session IS retired: `POST /api/roaming/handshake-complete`
  self-revokes it (the generic revoke endpoint forbids self-revocation;
  this route exists for exactly this). One pairing leaves no stray admin
  session. (Corrects the original build's "cannot be revoked".)
- Peer-introduction seam: `PeerIntroduction` + `registerBearerGrant` in
  `packages/client-runtime`; manual dialog is producer #1, relay/cloud
  discovery later constructs the same value.
- Credential hygiene: bearer responses carry `cache-control: no-store`;
  tokens never logged; the attach grant names the reachable base URL; all
  network steps complete before anything persists locally.

Product model — LOCKED by the user across the 2026-07-06 two-machine
sessions; these OVERRIDE earlier M2/M2.5 wording:
- **Sync on/off is a PAUSE, never a pairing code.** `sync_enabled` on the
  peer row (migration 036) gates outbound passes AND inbound mirror RPCs
  (paused peer → 403 by session subject) while the credential survives. A
  one-time code is needed ONLY for the first enable on a machine with no
  pairing at all. `POST /api/roaming/peers/{list,sync,remove}` back the
  per-environment controls; Remove is full teardown (row + credential +
  revoke the peer's inbound sessions).
- **ONE secrets decision for the pairing.** The dialog's "Secret files"
  choice ALWAYS applies to the paired-into machine (not first-pairing-only)
  — the machine holding a project captures its secrets with no second
  toggle anywhere. Overrides M2's "each machine consents to its own files".
- **ONE device = ONE row** in Authorized clients: all credentials behind a
  paired machine collapse to a single entry named after the machine, whose
  Revoke tears them all down. Session labels inherit the name the user
  typed on the pairing link ("Laptop"), never a hostname.
- **Materialize** shows on every live remote-only row; it's ENABLED when it
  can work (peer sync on, or a retained local copy) and DISABLED-with-reason
  otherwise — never hidden on invisible state, never a doomed click. It
  fetches the registry AND vault blobs on demand from the reachable peer
  (no dependence on background-sync timing), auto-trusts well-known SSH host
  keys on first clone (github/gitlab/bitbucket/azure; others surface the
  real git error), and prompts once for a projects folder when none is
  configured (saved as the default).
- **Revoked / auth-failed remotes count as dead:** their rows leave the
  merged list and the mirrored offline+Materialize rows surface (rows from
  a connection in phase `error`, plus the `live`/`synchronizing`-only
  liveness filter; primary and desktopLocal exempt).
- **Scope shipped today:** materialize = clone + synced secret files +
  register. Syncing the uncommitted working tree (staged/unstaged/untracked)
  is milestone **M3**, NOT built — materialize does not restore dirty work
  yet, by design.
- `MachineSyncSettings` deleted; no user-visible "roaming"/"machine sync"
  concept anywhere.

Accepted risks (rationale in history file): initiator-side environmentId
clobber; first-pairing settings TOCTOU.

Acceptance: `accept-m2.5.mjs` (transport chain) + the canonical-workflow
browser walk + `round3` field-sequence walk (standard-then-upgrade pairing,
live-row materialize, revoke→offline flip), all green on the M0 harness.

### WIP snapshots (M3, PRs #32–#37)

- Capture = the temp-index recipe reimplemented in `roaming/WipSnapshots.ts`
  (NOT the driver op): WIP commits carry **parent=HEAD** (thin bundles are
  ancestry-based — spiked; also M5's common ancestor) and return
  `{ commitOid, treeOid }`. The effective vault set is subtracted from the
  temp index before `write-tree` (vault content is P2P-only; only untracked
  candidates — removing a tracked path would make restore delete it);
  fail-closed when git can't distinguish tracked/untracked. Ref components
  validated `[A-Za-z0-9._-]`.
- The WIP ref mirrors the worktree TREE even when clean (a stale dirty
  snapshot must never shadow committed work). No-op baseline = last SHIPPED
  tree: marker ref `refs/t3/wip-pushed/<wsid>/<envid>` in origin mode
  (written only after a successful push — never by bundle mode, or a mode
  flip would push with a never-pushed lease), the wip blob's `treeOid` in
  bundle mode.
- Push = `--force-with-lease` with the marker as lease (empty = expect
  absent), adopt-remote-and-retry-once on lease failure. Permission-shaped
  stderr classifies BEFORE lease-shaped (git prints lease-shaped lines on
  denials too). Permission → bundle mode, in-memory only, re-probed each
  boot; other failures stay origin mode and surface.
- Bundle fallback: `git bundle create <ref> --not --remotes=<remote>` →
  blob `kind=wip`, payload `{ schemaVersion, capturedAt, refName, commitOid,
  treeOid, bundleBase64 }`, capped by `ROAMING_WIP_BUNDLE_MAX_BYTES`
  (contracts constant, 8 MiB); oversize skipped with a surfaced warning.
- `roamingWipSync` defaults false — WIP reaches the project's ORIGIN HOST,
  unlike vault data, so the pre-checked pairing-dialog row is the consent
  (one decision, applied to both machines like Secret files). Machines
  paired before M3 opt in via the ordinary settings row. Reactor gates
  `roaming && roamingWipSync` per pass; statuses clear on disable.
- Reactor triggers: 2-min interval (covers startup), settings enable,
  `thread.turn-diff-completed`; keyed-coalesced per project; skips while
  MERGE/REBASE/CHERRY_PICK markers exist; thread worktrees excluded by
  construction (they live under `<baseDir>/worktrees/`, outside roots).
- `roamingWipStatus` (per-project `{ mode, lastCapturedAt, lastPushedAt,
  lastError }`) is reactor state merged at BOTH shell surfaces — the ws
  subscribe point and the HTTP `/api/orchestration/shell` route (the
  HTTP-first shell load would otherwise miss it); flag-off = empty.
- Materialize: restore-wip runs BEFORE apply-vault; `restoreWip` request
  flag defaults ON (pre-checked checkbox in the materialize prompt);
  sources = origin `refs/t3/wip/<wsid>/*` (explicit fetch) then wip blobs
  (with one on-demand mirror pull); newest committer date across
  environments wins; skip-not-fail on dirty target / equal tree / nothing
  found / disabled; staged-vs-unstaged is flattened on restore (checkpoint
  semantics).
- A completed materialization record short-circuits ONLY while its
  targetPath still holds a git checkout AND the registered project is live;
  otherwise materialize resets to a fresh run (2026-07-07 field bug: the
  unconditional short-circuit returned success while materializing
  nothing).
- Retention: 20 local rolling history refs per (project, machine); the
  origin holds only the newest snapshot.
- Accepted risks: cloned-state-dir environmentId collision (WIP ref
  ping-pong); re-install orphans one origin ref per abandoned
  environmentId; a manual CLI commit leaves a stale dirty snapshot for up
  to one interval tick (restore-side age notice keeps it honest).
- Acceptance: `accept-m3.mjs` (three-project matrix: origin-refs with A
  killed, bundle fallback end-to-end, push-failure surfacing, field-bug
  regression) + the canonical-workflow re-run.

### Sync completion (M3.5, PRs #38–#42)

- **Auto-apply (delivery):** a peer's newer snapshot fast-forwards a
  checkout ONLY when it provably carries no local edits — its
  vault-subtracted worktree tree equals HEAD's tree or the
  `refs/t3/wip-applied/<wsid>` marker's tree (stamped by every auto-apply
  and by materialize restore-wip). Anything else is blocked, never touched
  (M5 owns divergence). The judgment is re-verified against a fresh
  worktree tree in the last instant before the destructive restore (TOCTOU
  guard); locally-present vault files are preserved across the restore from
  the WORKTREE's copies, never from a possibly-stale blob. A snapshot older
  than HEAD or the applied marker never applies (no stale-echo
  resurrection). REVISED M3.7: committer stamps are 1-second and the fast
  path is sub-second, so applied-marker TIES evaluate (identical commit
  still skips; the per-file merge's base-diff/local-edit/Based-On gates own
  safety); HEAD ties keep the conservative `<=` skip — with no marker the
  merge base falls back to HEAD and a tied-but-stale snapshot lacking a
  just-committed file would read as a peer deletion.
- **Freshness beacon:** origin-mode pushes ALSO write an empty-bundle wip
  blob (metadata only — refName/commitOid/treeOid, `bundleBase64: ""`);
  the mirror pushes on every blob write, and peers run the project's pass
  on any arriving wip blob — end-to-end delivery is seconds, not the
  2-minute tick. Importers skip empty-bundle payloads (the origin fetch is
  their transport). This supersedes M3's "origin-refs mode ships no blob".
- **Instant capture:** recursive filesystem watch per enrolled root
  (node `fs.watch` wrapped as a stream; `.git`/`node_modules`/build-dir
  noise filtered at source; 5s debounce; dead watchers self-evict so scans
  re-install them). The 2-minute interval is the fallback sweep — also the
  only trigger under sustained sub-5s write storms (debounce never goes
  quiet) and on platforms without recursive watch. Graceful shutdown runs
  one final bounded capture+ship per project (10s cap, 4-wide).
- **Size guard:** untracked files over `ROAMING_WIP_MAX_FILE_BYTES`
  (50 MiB) are excluded from snapshots with a surfaced warning that
  survives real push errors (origin mode previously had NO cap).
- **t3sync manifests (user decision, supersedes vaultOverrides):** global
  `<stateDir>/t3sync` written once with the defaults + optional repo-root
  `.t3sync` (user-created only — the app never writes into repos), matched
  by git's exclude engine, project lines win (incl. `!` negation). Vault
  cap 16 MiB. Full statement under Step 2's Manifest paragraph.
- **Consent trap (field):** the per-environment settings row writes
  `roamingWipSync` on ITS machine only (copy now says so); the one-decision
  propagation runs only in the pairing handshake. Machines paired before
  M3 must enable the row on BOTH machines (or re-pair). The
  paired-into machine still has no settings UI for this — flagged for a
  future Authorized-clients sync row.
- Accepted risks: peer clock skew can defeat the stale-echo timestamp
  guard (only ever affects edit-free checkouts; recoverable via refs); the
  laptop's first post-apply capture echoes an identical-tree snapshot once
  (settles via tree-equality skips).
- Acceptance: `accept-m35.mjs` (1-second A→B delivery onto a clean
  checkout, no-clobber of locally-edited FILES — step 5 revised by M3.7's
  per-file merge, same as accept-m36 step 6: a local edit no longer blocks
  the whole tree, a same-file conflict keeps ours on both sides —
  `.t3sync` `.idea/` round-trip with origin hygiene, oversize warning) +
  the canonical-workflow re-run.

### Field round 2 (M3.6, PRs #43–#47)

- HTTP `GET /api/orchestration/shell` strips ALL roaming fields when the
  roaming setting is off, mirroring the ws path (closes the M2.5
  reconciliation gap; `accept-m35.mjs` carries the invariant step).
- **Vault delivery:** vault blobs apply on arrival (blob-arrival trigger +
  startup catch-up) to the linked checkout. Per file: missing → write;
  equal to incoming → align; equal to what WE last applied (per-file
  sha256 record under `<stateDir>/vault-applied/<wsid>.json`) → update;
  anything else is a local edit — never overwritten. Peer-dropped files
  are NOT deleted locally (v1: the overwritten bundle may hold the only
  other copy). Materialize's apply-vault uses the same recording variant
  so its files stay updatable. Receiver gate = `roaming` only (the
  capturing machine's consent decided the bundle's contents).
- **Based-on fast-forward:** snapshot commits carry a `T3-Based-On`
  trailer (the applied-marker commit at capture). Apply allows an incoming
  snapshot whose based-on TREE equals the current worktree tree — the peer
  built on exactly this state, so the incoming tree is a superset and
  nothing local is unique. Self-gating: the based-on commit must resolve
  locally (deleted content stays recoverable from it); missing/legacy
  trailer, or any local movement since, stays blocked (M5 owns
  divergence). The TOCTOU recheck covers this path like the others.
- **Visibility:** `blockedReason` on the wip status entry, published when
  an apply is held back and cleared when the state resolves; the project
  list shows a per-project dot — red (error) / amber (blocked, with
  plain-language guidance) / brief green (recent send/receive) / nothing
  when idle. No new concepts, no roaming wording.
- Applied marker is project-scoped (not per-peer): fine at 2 machines,
  revisit if a third machine ever joins (marker thrash, not a safety
  issue — the tree-equality checks govern safety regardless).
- Acceptance: `accept-m36.mjs` (post-materialize vault delivery, secret
  update + no-clobber, based-on backflow onto a dirty-but-unchanged
  author, divergence blocked + surfaced) + `accept-m35.mjs` + canonical.
- ~~Flagged follow-ups~~ Both M3.6 flags became M3.7 and are CLOSED there:
  the latency variance had three distinct causes (one-directional mirror
  connectivity, the missing enrollment trigger, the staleness tie-skip),
  and watcher budgeting landed as per-directory registration + cap +
  surfaced fallback — see Sync hardening (M3.7) below.

### Sync hardening (M3.7)

- **Per-file WIP merge:** apply moves exactly the files the peer changed
  relative to the base; a file changed on both sides is kept ours and
  surfaced (`blockedReason` → "Waiting"); everything else crosses even
  while local edits exist. Whole-tree blocking is gone.
- **No-op baseline (REVISED in the criteria session — deletion deadlock):**
  the applied-marker tree counts as a capture no-op baseline ONLY while it
  equals the last-shipped tree (their agreement is what ends the idle-ACK
  ping-pong). Unconditional, it deadlocked deletions: a worktree returning
  to an OLD applied state while the shipped ref still advertised the
  deleted file skipped capture forever (measured: the author-side delete
  never propagated, >300s; field report "deletion took minutes"). A
  worktree the shipped ref does not match must always ship. After the fix,
  deletions propagate in ~5.5s in both directions (timed harness test);
  unit regression fails on the old baseline.
- **Deletion model (three invariants, each a field bug):** (1) the applied
  marker advances EVERY apply pass — clean applies to the peer snapshot,
  conflicted passes to a synthetic commit with only the conflicted paths
  pinned to base — so one conflict can no longer unrecord another file's
  arrival (that unrecorded arrival is what resurrected deleted files).
  (2) Peer-absence counts as a deletion beyond the marker diff only for
  paths we SHIPPED, and only when the peer's snapshot `T3-Based-On` state
  provably contained the file — an out-of-order snapshot that merely
  predates the file can never delete it. (3) A tree identical to the last
  shipped one still ships ONCE when the applied marker has moved (the
  Based-On update is how a receiver-side delete that returns the tree to
  an already-shipped state reaches the author), and settles the next
  pass — no ACK ping-pong.
- **Sync pill:** shell projections carry `workspaceProjectId` (four query/
  mapping sites had silently dropped it — also re-arming the decider's
  double-enrollment invariant); statuses publish a baseline on a project's
  first pass, seed into resumed ws subscriptions, and after a server
  restart the activity timestamps are reconstructed from the marker refs'
  commit dates (git is the durable store; no status table).
- **Titles roam:** a rename rewrites the registry blob's title (other
  fields preserved) and mirrors; peers apply an arrived registry title to
  the linked local project. Event-triggered in both directions (never
  pass-based reconciliation, which could undo an in-flight remote rename);
  the grouped sidebar label prefers a shared member title over the
  repository name.
- **Mirror wait long-poll (formal-criteria session, 2026-07-10):** mirror
  connectivity is ONE-directional by design (M2.5 tamper resistance: the
  callee holds no credential/URL for the initiator, and the server cannot
  discover its own reachable URLs) — so the callee's write-trigger pass is
  a no-op and its beacons used to wait for the initiator's 60s interval
  (the measured ~52s phase-locked deliveries). `POST
  /api/roaming/mirror/wait` (same gating as every mirror route: roaming
  flag 404, `roaming:mirror` scope, paused-peer 403) holds up to 25s
  against an in-memory per-boot blob-store change revision (compared only
  for inequality; restart wakes the waiter into one no-op pass). PeerMirror
  runs one waiter fiber per reachable enabled peer (atomic claim; waiters
  self-terminate when the peer is paused/removed/roaming off; reconciled
  every drain pass + a 30s scan; 15s backoff on failure, 40s client cap).
  The 60s interval remains the delivery guarantee; the waiter is the fast
  path and self-heals for pre-M3.7 pairings without re-pairing.
- **Enrollment trigger:** `project.meta-updated` carrying a
  `workspaceProjectId` runs a reactor scan — a fresh pairing's projects get
  watchers and a first snapshot immediately, not on the next 2-min sweep.
- **Watcher budget (Linux):** tree watching registers PER DIRECTORY,
  skipping `.git`/`node_modules`/`dist`/`build`/`target`/`out`/`.venv`/
  `__pycache__` at REGISTRATION (libuv shares one inotify instance per
  process; the watches budget is what recursive fs.watch exhausted —
  ~167k watches measured for one desktop instance), capped at 4096
  dirs/project; macOS/Windows keep native recursive. A single dead
  directory no longer kills a project's watch (this was the silent
  watcher-death mechanism: git's transient `.git` churn erroring the
  recursive watcher). Watch death or cap → per-project fallback: 10s
  capture sweep + `notice` on the status entry (amber "Sync on" pill,
  concept-free copy) + a real-watch retry every ~5 min — NEVER a silent
  fall to the 2-min interval. Notices live in reactor state merged into
  every published entry; passes cannot wipe them.
- **Settings freshness guarantee:** an unconditional 2s mtime poll backs
  the settings watcher (upstream file, minimal diff) — an external
  settings.json edit is honored within ~2-4s even with ZERO inotify
  budget; watch death also logs a warning instead of ending silently.
- **Timing instrumentation is permanent:** every delivery stage logs a
  `roaming timing:` line keyed by commitOid/blob version (watch-trigger,
  captured, origin-pushed, beacon-written, mirror-exchange with trigger
  source, blobs-pushed-to-peer, wip-blob-ingested, arrival trigger,
  peer-refs-fetched, apply) — slow deliveries are attributable from the
  two server.log files alone. Beacon write failure is a WARNING (it
  silently costs the fast path). `accept-m37.mjs` prints a per-stage
  table per delivery.
- Known limits (accepted): total inotify-INSTANCE exhaustion at server
  boot crashes UPSTREAM watch paths (git driver, atomic-write temp files)
  before roaming code runs — out of M3.7's blast radius; M3.7 removes the
  dominant watch consumer, making that state unlikely. Base-diff peer
  deletions when NO applied marker exists yet are not Based-On-gated
  (pre-existing, narrow: markers appear on first exchange; HEAD-tie `<=`
  covers the same-second case). The M3.5 "~1s A→B" acceptance number rode
  adjacent-trigger luck; the honest steady-state fast path is ~5.5s
  (5s watch debounce + ~0.5s chain), ~0.5s when riding another trigger.
- Acceptance: unit suite (deletion-model + tie-deadlock regression tests
  fail on the old code) + `accept-m37.mjs` (ten consecutive A→B
  deliveries, all ≤10s, max 5.8s) + `accept-m37-stress.mjs` (12 live
  projects + an over-cap 13th: notice surfaced, fallback-sweep delivery,
  healthy projects unaffected, settings edit ≤5s in both phases) +
  `accept-m36.mjs` step 6 updated for per-file merge + `accept-m35.mjs` +
  canonical re-run.

### Branch-aware sync model (M3.8)

- Replaced tree-only snapshot identity with payload v2
  `(branchRef, headOid, treeOid)`. Origin refs require an exact metadata
  beacon join; legacy/mismatched snapshots block or skip without touching the
  checkout. Capture no-op detection uses the full tuple, so same-tree branch
  and HEAD moves still ship.
- Replaced timestamp-vs-HEAD apply gates with ancestry classification:
  same context keeps M3.7 per-file merge; clean same-branch descendants
  fast-forward; clean different-branch snapshots switch only when the target
  branch is fast-forward-safe; behind snapshots skip; divergence, detached,
  legacy, local edits, and in-flight turns block with specific reasons.
- Every HEAD move parks the local snapshot under its branch. The minimal
  takeover action parks and reproduces peer branch + HEAD + dirty tree; a
  clean return to the parked branch restores its tree. The project pill is
  the only UI action—no new project list or sync surface.
- Materialize now requires v2 context, checks out the snapshot branch at its
  HEAD, restores the dirty diff, and writes the applied marker. Legacy WIP is
  skipped with a notice.
- Analysis corrections found during the milestone: origin metadata must join
  refs exactly; untouched falls back to HEAD when no marker exists; active
  turns needed a project-level projection query; tree-only no-op detection
  hid branch moves; `.git` exclusion required a 10s branch/HEAD poll.
- Field runs found three forms of branch feedback: pre-apply capture shipped
  stale receiver context; an applied peer tuple was re-shipped as locally
  authored; and an incoming snapshot could race a local CLI switch before the
  10s poll captured it. Reactor ordering is apply-then-capture, exact applied
  tuples suppress acknowledgments until local work ships, exact provenance
  echoes only advance marker bookkeeping, and untouched now requires captured
  branch/HEAD context. The canonical four-stage run then stayed clean after
  branch creation, commit, return, and merge.
- A later field reset exposed two retained-state paths. First, a Git-clean
  checkout could be classified as edited solely because its applied marker
  still described earlier WIP; untouched now accepts either the applied tree
  or `HEAD^{tree}`. The exact field state then exposed the decisive second
  path: A had already kept `advance.txt` and `b-local.txt` deleted and captured
  that resolution, while B's unchanged older payload still contained them.
  The synthetic conflict marker preserved deletion safety but originally did
  not record which peer snapshot it represented, so every startup recreated
  `Take over`. Naming the peer fixed that display loop but exposed a transport
  hole: A's deletion snapshot named the local-only marker in `T3-Based-On`, so
  B could not resolve the marker's files and therefore could not prove that A
  had seen B's `advance.txt` and `b-local.txt`. B retained and republished both.
  Conflict markers now name the exact peer commit, and the next single-parent
  snapshot transports that acknowledgement as `T3-Based-On-Peer` in the same
  trailer paragraph as `T3-Based-On`. B can validate the exact match against
  its own shipped snapshot and accept the deletions without importing A's
  synthetic marker. A timestamp/subject migration recognizes pre-fix pinned
  markers, and missing transported proof forces exactly one re-capture.
- The same exact A installation exposed a third retained-state path in the
  desktop client. Its IndexedDB shell cache repeatedly contained the old
  `blockedReason: "changed on both machines, kept yours: b-local.txt"` and
  `takeoverAvailable: true` row, so merely opening A could render `Take over`
  before B was running even after the server stopped recreating the conflict.
  WIP status is now live-only: cache hydration discards the array and cache
  persistence omits it; warm resume authoritatively replaces it from the
  reactor. A regression starts from that exact cached takeover shape and
  asserts an empty rendered status.
- Acceptance on fresh M0 harness state: `accept-m38.mjs` passed the canonical
  branch workflow, dirty-main block, touched-own-branch block, takeover with
  restorable parking, return restoration, and branch materialization;
  `accept-m35.mjs`, `accept-m36.mjs`, and `accept-m37.mjs` stayed green (M3.7:
  10/10 deliveries ≤10s, max 5.7s); `accept-m2.5.mjs` passed pairing, live
  attach, mirror, offline transition, and materialize. The collaborative UI
  preview could not run in this session because both preview status/open
  returned `Auth required`; no product criterion was redefined around that
  tooling limitation.
- The final field-state replay used the preserved commits directly: A started
  from applied marker `1955fd`, stale deletion snapshot `bd8166`, and B's peer
  snapshot `989c15`. Current code emitted one-parent snapshot `876733` with
  both trailers; an isolated B containing the two untracked files applied two
  deletions, stayed on `testing`, and ended clean. A single regression now
  reproduces that entire private-marker transport/deletion chain and passed 20
  consecutive randomized repository runs. Then 36 reactor tests, 14 client
  cache/reducer tests, three additional fresh `accept-m38.mjs` runs, and a
  separate fresh canonical `accept-m2.5.mjs` all passed. The packaged AppImage
  server itself also passed the complete M3.8 acceptance, and its served web
  bundle contains none of the removed fake-`Syncing` copy. `vp run typecheck`
  passed. Repository formatting passed; repository-wide lint remained red on
  unrelated existing files, while every changed implementation/test/harness
  file linted cleanly.
- The next real installation exposed a fourth retained-state failure. A was
  clean at `HEAD` but its old applied marker still contained `b-local.txt`.
  When B created a new file at that path (`4fb0a0`), A used the stale marker as
  its same-context merge base, falsely classified A's clean absence plus B's
  new bytes as a both-sides conflict, emitted `Take over`, and then published
  the absence as a deletion. B deleted the new file; its still-retained
  `advance.txt` reappeared on both machines. Clean worktrees now rebase the
  per-file merge to HEAD. The last-shipped fallback remains only for dirty
  worktrees, except that a clean local deletion still wins when the peer
  carries the exact last-shipped bytes; different peer bytes at the same path
  are treated as a new file. An isolated replay using the actual `1955fd`,
  `7fe98e`, and `4fb0a0` objects applied `B local` to A, created no synthetic
  marker or deletion snapshot, and stayed stable across restart. The exact
  regression passed 20 consecutive runs; all 37 reactor and 14 client tests,
  fresh M3.8 acceptance, and fresh canonical M2.5 acceptance passed. The
  fork.41 packaged server then passed both the exact real-object replay and
  the complete fresh M3.8 acceptance suite.
- Pre-Test-5 cleanup then exposed a fifth retained-state path: both visible
  repositories were clean while T3 was closed, yet opening fork.41 restored
  `advance.txt` and `b-local.txt`. A first captured clean snapshot `f05312`;
  B then published both files as `1f5db5`, explicitly based on `f05312`, and A
  correctly applied that causally-new state. The files had already been
  resurrected on B by `restoreParkedWipForTarget`: it ran unconditionally on
  every pass/startup and never consumed a successfully restored parked ref.
  Parked restoration is now restricted to a branch transition observed in the
  running process and consumes the ref after success. Each pass detects the
  transition directly in addition to the 10s poll, closing a peer-event race
  found by the first acceptance rerun. An exact startup replay with a clean
  `testing` checkout and parked `1f5db5` stayed clean while keeping the ref
  recoverable; a live branch-away/return restored both files once and consumed
  it. All 51 focused tests and the complete M3.8 harness then passed.
- Test 6 then exposed a sixth classifier failure. With A on `a-work` plus
  `a-wip.txt` and B on `b-work` plus `b-wip.txt`, both machines initially
  blocked, but a later pass dismissed the same peer state as a delayed branch
  echo because its `T3-Based-On` named an older local shipment. Status is
  pass-authoritative, so that incorrect `skipped` result cleared `Take over`
  and both machines settled on `Synced` while still divergent. The echo guard
  now applies only when the peer snapshot tree equals its HEAD; a peer tree
  containing WIP is genuine active work and returns `blocked` on every pass.
  The exact two-active-branch regression asserts two consecutive blocked
  outcomes and untouched local branch/files. All 52 focused tests, fresh M3.8
  acceptance, and fresh canonical M2.5 acceptance passed from source.
- Continuing the same field workflow exposed one Test 7 hole and one mistaken
  test expectation. After A took over B, A never emitted its resulting
  `b-work`/`b-wip.txt` tuple because exact applied tuples were treated as
  no-op echoes, so B remained on `Take over`; successful takeover now forces
  one causal acknowledgement capture. Ordinary `git switch a-work` correctly
  carried the untracked `b-wip.txt` across. Expecting T3 to delete that file
  and restore `a-wip.txt` was wrong: a manual Git switch is not an implicit
  destructive recovery command. Dirty checkouts remain untouched and blocked,
  while the parked ref remains recoverable; restoration occurs only after the
  returned checkout is clean. The unit and M3.8 acceptance previously hid this
  distinction by cleaning before the switch. They now switch back dirty first,
  assert Git's carryover survives and the parked work stays hidden, then clean
  and assert the parked work restores. The peer-clear acknowledgement is also
  asserted. All 53 focused tests, revised fresh M3.8 acceptance, and fresh
  canonical M2.5 acceptance passed from source.
- Preparing to rerun Test 6 exposed a seventh classifier path. Both visible
  repositories had been reset while T3 was closed, but the mirror still
  carried B's last published dirty `b-work` snapshot. A opened first on clean
  `testing`: the first pass blocked and captured the reset, then the next pass
  treated the older B snapshot as eligible for clean different-branch
  auto-switch and moved A to `b-work` with `b-wip.txt`. A dirty
  different-branch snapshot whose `T3-Based-On` does not equal this machine's
  latest shipment now remains blocked on every pass; only explicit takeover
  may apply it. The exact clean-reset/old-dirty-peer regression asserts two
  blocked passes, unchanged `testing`, and no peer file. M3.8 acceptance now
  repeats the field sequence and waits beyond the second pass before asserting
  that the branch and tree remain unchanged. Its first run still failed in
  bundle fallback: the pre-apply baseline read only the origin pushed marker,
  which does not exist in bundle mode, so the causal guard was bypassed. Bundle
  mode now uses the current locally mirrored payload commit as its baseline.
  All 54 focused tests, the revised M3.8 acceptance, and fresh canonical M2.5
  acceptance passed from source.

## 2026-07-15 — Independent post-fix audit (regression found and fixed)

After the seventh fix, an independent review session audited the accumulated
uncommitted diff: full re-read of the reactor, an adversarial opus-4.8 pass
over the classifier, and the complete acceptance ladder on fresh harness
state — the first re-run of the PRE-M3.8 suites since fix #3 (fixes #4–#7
had only re-run `accept-m38` + canonical M2.5; the older suites are where
the earlier guarantees live).

**Regression found: `accept-m35` no-clobber FAILED (reproduced twice).**
"B's change was applied over A's locally-edited file" — the oldest guarantee
of the sync feature (M3.5: local edits are never overwritten). Forensics on
preserved harness state: in the per-file merge, a path missing from the
merge base fell back to using OUR OWN last-shipped snapshot as its base on
dirty checkouts. A file this machine authored and shipped therefore compared
equal to "its base" (own copy == own shipment), read as locally untouched,
and a peer's CONCURRENT different bytes at the same path overwrote the local
edit silently — no conflict, applied marker advanced to the raw peer commit.
The fallback was added for the M3.7 delete flap and also serves the M3.6
"peer edited the file we shipped" delivery, so it could not simply be
removed. Fix: the own-shipment base applies only when it is provably common
history — the local path is absent (our own deletion), the path is a
proof-gated shipped-only delete, or the peer snapshot's `T3-Based-On` /
`T3-Based-On-Peer` names our shipment (a reply, not a concurrent write).
Three unit regressions pin the triangle: concurrent same-path bytes now
conflict-keep-ours; a Based-On reply still applies; the delete flap stays
fixed. Root-cause window: opened by the fix #4–#7 interplay (prompt
post-conflict acknowledgement re-captures made the concurrent-snapshot
timing routine), which is why the M3.8-close ladder run had still passed.

**Review finding (opus-4.8, confirmed): silent divergence via the clean echo
arm.** The fix #6/#7 delayed-echo guard dismissed ANY clean different-branch
snapshot whose Based-On predated our latest shipment as an echo — including
a peer that committed real work on a new branch and went clean. Both
machines then settled on "Synced" while on different branches forever (the
fix #6 pathology, re-opened for the clean case). Fix: a clean snapshot is
dismissible only when the echo is PROVEN — the peer's HEAD is an ancestor of
ours (its position is already contained in our history); otherwise blocked
with takeover offered. The fix #6 branch-switch echo (same HEAD) still
skips; unit regression added.

**Takeover edge fixed:** `takeover()` treated `applied-with-conflicts` as
failure and returned `applied: false` — but the branch switch, reset, and
clean had already happened by the time conflicts are known (an ignored file
colliding with a peer path, a failed restore). The UI toasted an error over
a successfully mutated worktree and the acknowledgement capture was skipped,
so the peer stayed on "Take over" (the Test 7 disease through an edge path).
Both applied tags now count as success.

**Transport coverage restored:** the fix #7 revision had added
`receive.hideRefs refs/t3` to every `accept-m38` test origin, silently
flipping the ENTIRE branch-aware suite to bundle fallback and leaving
origin-refs — the transport of any GitHub-backed project per the M0 spike —
uncovered. The script now takes `T3_M38_TRANSPORT=origin`; closing state
requires BOTH runs green.

**Verdict on the code's state (review + audit):** coherent enough to keep —
no guard contradiction, park-before-destructive-move holds on every path,
capture no-op baselines neither deadlock nor ping-pong; the migration shims
(legacy conflict marker, ±1s heuristic) are fresh-install-safe and should be
deleted once the field machines have cycled past them. Standing debt, not
blocking: the classifier re-derives overlapping provenance in six separate
guards and would benefit from one computed peer-relationship classification;
the unit suite is incident-replay-heavy and light on invariants (all three
of this session's regressions sat exactly in states no incident replayed).

Validation: 80 roaming unit tests (3 new), 113 client-runtime state tests,
typecheck across 15 workspaces, and the full fresh-state ladder —
`accept-m35`, `accept-m38` (bundle AND origin transports), `accept-m36`,
`accept-m37`, `accept-m2.5`.

## 2026-07-17/18 — M4 takeover + divergence (results)

Landed as PRs #63–#69 on 2026-07-17, accepted 2026-07-18. Delivered per the
plan's M4 section: per-machine advisory lease records (key `<wsid>/<envid>`
— the analysis pass rejected the per-project singleton, which would produce
equal-version blob conflicts exactly when both machines are active),
"active on <machine>" chips, the distinct divergence surface with two-sided
merge-base patches and diff-and-choose resolution (losing side always
recoverable: parked ref for pick=peer, new `wip-rejected` pin for
pick=local), honest `takeoverAvailable`, and snapshot pinning on
takeover/resolve (no race-to-newest from the UI).

Notable analysis-pass findings (recorded in #63 before coding): `lease` was
already plumbed generically since the contracts era; divergence existed
only as a blocked-reason string; the plan's `merge --ff-only` wording did
not match the shipped ancestry-gated hard reset; the losing peer side of a
kept-local resolution previously lived only in the peer's force-updatable
wip ref.

Field bugs caught by acceptance (both invisible to unit tests):

- #69 — the bundle transport's blob dedupe compared only tree/branch/HEAD,
  silently dropping acknowledgement captures whose only change is the
  causality trailers: a keep-local divergence resolution never settled in
  bundle mode (the pill stuck after a reported success). The dedupe now
  compares T3-Based-On/T3-Based-On-Peer too; regression test proves
  exactly one ack ships, then the settled state dedupes again. The origin
  transport pushes unconditionally and was unaffected — validation for
  running accept scripts on BOTH transports.
- #70 — the receiver's acknowledgement ship renewed its own lease, so the
  activity chip pointed at the RECEIVING machine after every delivery (the
  accept-m4 activity assertion only passed its first run by racing the
  ack). Echo ships now never move the lease; takeover and kept-local
  resolution renew forcibly as explicit user actions.

Review notes (independent reviewers per PR): takeover's explicit lease
renewal needed a `force` past the 60s activity throttle (#65 fix);
pick=peer re-verifies the divergence before takeover so a meanwhile
fast-forward cannot become a surprise backward reset (#66 fix); a red
"Sync error" pill must not carry a hidden click action (#67 fix). Accepted
(documented, not coded): pick=local reports `resolved: true` while the
settle awaits a successful ship — self-healing, inherited from the
conflict-pin mechanism; lease derivation trusts wall clocks.

Validation: 47 roaming reactor tests (2 new suites: WipLease, divergence
integration; fact-space invariants extended with takeover-honesty and
divergence-exactness), typecheck across contracts/client-runtime/server/
web, and the full fresh-state ladder — accept-m35, m36, m37, m37-stress,
m38 (bundle AND origin), accept-m4 (bundle AND origin), accept-m2.5
canonical re-run.

## 2026-07-17 — milestones renumbered to execution order (second renumber)

User decision after the pre-M4 cleanup closed: takeover/divergence and
roaming conversations FINISH the core sync story that M0–M3.8 built, while
bootstrap recipes are the open-ended comfort feature — agent setup of
arbitrary unknown projects has unbounded tool/environment combinations and
no pre-specified steps, so it is the hardest thing to get right and the
least essential to the roaming promise. New order: M4 = takeover +
divergence (was M5), M5 = briefs + transcripts (was M6), M6 = bootstrap
recipes (was M4); M7 unchanged. The user explicitly rejected keeping stale
numbers with a reordered table: numbers must always match execution order
(kickoff prompts address milestones by number — the 2026-07-06 renumber
set the precedent), and archaeology is served by the numbering-era map now
at the top of this file rather than by freezing the numbering.
