# Roaming workspace — local-first plan

## Canonical workflow — read this first, it overrides everything below

Stated by the user repeatedly (M1 product thread and twice on 2026-07-05,
after M2 shipped a deviation). Every milestone's design AND acceptance must
reduce to this workflow; where any other sentence in this document conflicts
with it, this section wins and the document must be corrected before coding.

1. **Open T3 Code on the laptop.** You see your local projects. Nothing else.
2. **Pair the desktop — once.** This is the *existing* pairing/thin-client
   flow (one code, one dialog), which gains a JetBrains-style **what to
   sync** step: Projects (always on), Secret files (pre-checked, default
   patterns), Work in progress (arrives M4), Conversations (arrives M6).
3. **Remote conversations work immediately.** The desktop's projects appear
   live in the ONE project list; opening one runs on the desktop (thin
   client). If pairing succeeded but a remote conversation doesn't work,
   the milestone is not done — no exceptions.
4. **Optionally materialize.** Any of those projects can be materialized
   locally (clone + synced secrets + registration) to keep working while
   the desktop is offline. The mirror syncs silently behind the live
   connection to make exactly this possible; offline rows stay in the same
   list, greyed, with Materialize as the action.

Prohibitions that follow — permanent, not per-milestone: no user-visible
"roaming", "machine sync", or "enrollment" concept, section, toggle-page, or
second pairing flow; no second project list; sync options appear only inside
the one pairing flow (plus ordinary settings rows for changing your mind
later); pairing must never leave the user in a state where the other
machine's projects are visible but dead.

> **Status:** M2 complete 2026-07-05 — exit criteria pass on the harness
> (`scripts/roaming/accept-m2.mjs`; see [M2 results](#m2-results-2026-07-05));
> **M2.5 (unified pairing — corrective) is next**, then M3. M2's separate
> "Machine sync" pairing violates the canonical workflow; see the decisions
> log entry below and the M2.5 milestone row.
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
> **How to execute:** this document is self-contained. To start work in a fresh
> thread, paste one of the kickoff prompts from the [Kickoff prompts](#kickoff-prompts)
> section at the end. Milestones run strictly in order (M0 → M2, M2.5, M3 → M7).
> Every milestone begins by re-reading the Canonical workflow section and ends
> by demonstrating it end to end.

**Thesis:** every enrolled machine can bring any project to its latest state — code,
secrets, uncommitted work, runtime setup, agent context — in one action. Code
lives at each project's git origin. Uncommitted work rides the origin too, as
hidden refs, so it survives the desktop being powered off. The remaining small
state — project list, vault files, chat history — mirrors **directly between your
machines whenever both are online**, and each machine keeps a full local copy.
No new always-on service, no account, no encryption layer in v1: data only
travels over the already-authenticated connection between your own machines.

The laptop is a full working machine (local dev servers, local browser, local LLM
runs against a local checkout) — *and*, before anything is materialized, a thin
client: the same pairing that enables sync is the existing remote-attach, so the
desktop's projects are live and conversational the moment machines are paired.
This plan's added job is eliminating the clone-and-setup ritual per machine;
remote-attach supplies the live half of the one experience and this plan must
never regress or bypass it.

**Known v1 limitation (accepted):** small state is only as fresh as the last time
both machines were online together. In practice the project list and vault files
change rarely (days/weeks), so overlap windows keep them fresh; uncommitted code
— the state that changes every minute — doesn't depend on the mirror at all
(origin hidden refs). The one real failure case — a project never opened on the
laptop, desktop unreachable, secrets needed *now* — is what milestone M7 (cloud
store backend) later removes.

## Deployment reality (read first)

This repo is a **fork** of upstream T3 Code. Two consequences shape everything
below:

1. **Upstream's cloud service (T3 Connect: Clerk login + hosted relay) is
   invite-gated and not usable by us.** The relay code in `infra/relay` is real,
   but it's upstream's deployment. Nothing in v1 depends on it — the mirror uses
   only the fork's own machine-to-machine connectivity. All storage goes through
   a `RoamingBlobStore` interface, so a cloud backend (a private git store repo,
   or the T3 relay if the waitlist ever clears) can be added in M7 without
   touching callers.
2. **Upstream updates flow into `main` continuously.** Roaming work happens on a
   long-lived `feature/roaming` branch, never merged to `main` (see Execution
   process). Code is kept deliberately *additive* — new directories
   (`apps/server/src/roaming/`), new contract files
   (`packages/contracts/src/roaming.ts`), minimal touches to existing files — so
   upstream rebases stay cheap.

## 1. Workspace registry

Projects become user-owned and machine-independent, keyed by repo identity, not
per-machine entries. (No account or service involved — "owned" means recorded in
your mirrored roaming state, present on every enrolled machine.) Every machine
shows the full list — materialized or not — with per-machine workspace-root
mapping (plus per-project path overrides). This is the spine everything else
hangs off, and it fixes an existing wart: today a project and its clone on
another machine are unrelated objects.

## 2. Vault

Per-project allowlist of gitignored-but-precious files — `.env`, local certs, tool
configs — captured automatically on change, versioned, and mirrored between
machines. Plaintext never leaves your own machines in v1: transfer happens only
over the authenticated machine-to-machine channel, and copies rest on your own
disks exactly like the originals do today. (At-rest/cloud encryption arrives
with M7, where data would leave your machines.)

## 3. One-action materialize

Pick a project on the laptop → clone from origin, apply vault, restore the latest
work snapshot (see 5), register at the mapped path. This is the "new laptop" and
"urgent bug from the café" story in one button.

## 4. Bootstrap recipes

The clone was never the expensive part — the setup is. On first materialization
anywhere, an agent runs the setup (installs deps, provisions the database,
verifies the dev server actually boots), and records what it did as a replayable
recipe. Later materializations replay the recipe, with the agent falling back to
figuring it out when the recipe breaks. An agent tool is uniquely positioned to do
this, and nothing else does it.

## 5. Continuous work snapshots

A background job on each machine snapshots the dirty working tree — staged,
unstaged, and untracked, via a temporary index — debounced on activity, plus on
idle and before sleep. Snapshot is a commit on a shadow ref
(`refs/t3/wip/<project>/<machine>`), pushed to the project's origin — so it
survives the desktop being off, with git providing transport, delta-compression,
and integrity. No custom sync engine; the shadow-ref trick gets ~90% of "Dropbox
for working trees" using machinery that's been debugged for twenty years. For
repos whose origin won't accept extra refs (no push rights), fallback: the
snapshot travels as a git bundle over the machine-to-machine mirror instead.

## 6. Takeover and divergence

One active machine per project: opening a project that's active elsewhere shows
"active on desktop, snapshot 4 min ago" and an explicit **take over** action
that applies that snapshot. Freshness comes from the origin WIP refs themselves
plus mirrored lease info. If both machines edited anyway, both snapshots exist
as commits — surface an explicit diff-and-choose flow. Never a silent merge;
never a heuristic.

## 7. Handoff briefs and thread mirroring

Explicit "park" = final snapshot + an agent-written resumption brief (what I was
doing, what's broken, what's next). Resuming on another machine starts a fresh
provider session seeded with the brief and the thread history. Thread transcripts
mirror per-project as versioned blobs — readable everywhere, writable where the
session ran. Deliberately **not** doing native provider-session transplants:
undocumented internals that break on every provider update, and a rebuilt context
from a good brief is usually better than a transplanted one.

## Explicitly not building

- A required always-on daemon/server/VPS — origins carry the code and WIP; the
  mirror carries the rest.
- A dependency on upstream's hosted T3 Connect / Clerk service (invite-gated,
  not ours). Kept open as one possible M7 backend.
- An E2E encryption layer in v1 — nothing leaves your machines, so there is
  nothing new to encrypt. (Mandatory in M7 before any cloud backend ships.)
- A custom content-addressed file-sync engine — shadow refs over git for working
  trees; the mirror only moves small versioned blobs.
- Native session-state transfer between machines — briefs + rebuild instead.
- Replicating the internal orchestration event log across machines — transcripts
  mirror as data; live remote work on a running machine is delivered by the
  existing attach, which pairing wires in (canonical workflow step 3), not by
  replicating its event stream.

---

# Implementation deep-dive

Grounded in a full codebase mapping (2026-07-03). Summary of what exists that
changes the plan's economics:

- **The snapshot engine already exists and is battle-tested.** `CheckpointStore`
  (`apps/server/src/checkpointing/CheckpointStore.ts`, landed 2026-02-17,
  actively maintained) captures dirty working trees — staged, unstaged,
  untracked — via a temp index (`GIT_INDEX_FILE` + `read-tree`/`add -A`/
  `write-tree`/`commit-tree`) into hidden refs under `refs/t3/checkpoints/`,
  with restore and diff. It powers the live "revert to turn N" feature
  (filesystem restore + `providerService.rollbackConversation`) and per-turn
  diff summaries. Step 5 is a generalization of this to continuous capture +
  remote transport — capture/restore/diff themselves are proven code.
- **The materialize/bootstrap composition pattern exists (single-machine
  only).** `dispatchBootstrapTurnStart` (`apps/server/src/ws.ts:679`) chains
  create-thread → prepare-worktree → run-setup-script → start-turn behind one
  command, and `SourceControlRepositoryService.cloneRepository` handles clone in
  the add-project flow. Nothing does cross-machine materialization — but step 3
  is a new composition of these proven pieces, not new primitives.
- **Machine-to-machine connectivity building blocks exist.** Remote access
  (pairing, bearer sessions, Tailscale/LAN endpoints) lets a *client* reach a
  server; the CLI already talks to a live server programmatically via
  `EnvironmentHttpApi`. What v1 adds is one server acting as a client of
  another — new code, existing protocol. Validated by an M0 spike.
- **Projects are event-sourced and machine-local.** `OrchestrationProject`
  (`packages/contracts/src/orchestration.ts`) has no repo-URL field;
  `repositoryIdentity` is derived at read time from local git metadata. The
  local `ProjectId` must not change meaning.
- **Reactor infrastructure is ready to reuse.** `makeDrainableWorker`,
  `makeKeyedCoalescingWorker` (`packages/shared`), the `CheckpointReactor` /
  `AgentAwarenessRelay` patterns (domain-event subscription + coalesced
  background publish), `VcsStatusBroadcaster` as a dirty-tree signal, and
  `FileSystem.watch` debounce patterns in `ServerSettingsService`.

## Global architecture decisions

**D0 — Transport: peer mirror in v1, pluggable store behind one interface.**
All small roaming state (registry entries, vault bundles, recipes, WIP bundles,
transcripts, briefs, leases) is a set of versioned blobs addressed by
`(workspaceProjectId, kind, key)`. Blobs live locally on every machine (SQLite
table `roaming_blobs` in the existing state DB) and reconcile through a
`RoamingBlobStore` interface. V1 implementation: `PeerMirror` — enrolled
machines exchange blob manifests and transfer newer versions whenever they can
reach each other, over the fork's existing authenticated channel. M7 adds a
cloud implementation (private git store repo, or T3 relay if it opens) behind
the same interface for the no-overlap / 3+ machines / offsite-backup cases.
Callers never know which backend moved the bytes.

**D1 — Two-tier project identity.** Introduce `WorkspaceProjectId`
(machine-independent, minted on first enrollment, carried in the mirrored
registry) as a *new* identity alongside the local `ProjectId`. Local projects
link to it via a persisted field; nothing about local `ProjectId` semantics,
shell snapshots, or thread routing changes (the codebase mapping flagged
migrating `ProjectId` semantics as the riskiest possible move — don't). A
project is "roaming" iff it has a `workspaceProjectId`. Ids are minted
automatically for every project once the machine is paired (the single
pairing/thin-client flow — there is no separate "pair for sync"), and on
project creation thereafter — there is no user-facing enrollment step
(2026-07-05 decision; the internal `project.roaming.enroll` command is the
plumbing the pairing flow drives).

**D2 — The server (not the UI) is the roaming agent.** All registry sync, vault
watching, snapshotting, and mirror traffic lives in `apps/server` (new
`src/roaming/` subtree), because the server already holds the VCS layer, the
secret store, and the reactor infrastructure. UIs only render new shell-state
entities and dispatch commands.

**D3 — One blob record shape for every kind.** Registry metadata, vault
bundles, recipes, WIP bundles, transcripts, briefs are all just `kind`s over
the same record: `{ schemaVersion, kind, key, workspaceProjectId, version
(monotonic per key), contentHash, authorEnvironmentId, updatedAt, payload }`.
One mechanism, one reconciliation rule, one test suite; not six bespoke
formats. Reconciliation: per key, higher version wins; same version but
different hash = concurrent writes → surface as a conflict, never auto-merge.
(M7 extends the record with `keyId`/`nonce`/ciphertext fields; the payload
becomes opaque to the cloud backend.)

**D4 — Peer trust rides existing pairing.** Machines are enrolled by the
pairing flows that already exist for remote access — the SAME user action
that attaches the client (canonical workflow step 2), not a parallel flow;
that one handshake additionally
mints a long-lived, scoped machine-to-machine credential (stored in
`ServerSecretStore`) so either server can authenticate to the other for mirror
RPCs without a user session. Machine identity = the existing persisted server
`environmentId` (`apps/server/src/environment/ServerEnvironment.ts`) — do not
confuse with desktop pool ids like `"primary"`.

**D5 — Encryption is deferred to M7, deliberately.** In v1, blobs move only
between your own machines over the already-authenticated channel and rest on
your own disks with the same protections the originals have today — an
encryption layer would protect against nothing new. The moment any cloud
backend enters (M7), E2E encryption becomes mandatory and its key-management
design (root key, recovery code, per-project data keys) must be written up and
reviewed **before** M7 code. That one-pager is an M7 entry gate, not an M0
task.

## Step 1 — Workspace registry + mirror engine

**Blob space:** migration adding `roaming_blobs` (columns per D3) to the
server's SQLite. Registry entry = blob `kind=registry`, `key=<workspaceProjectId>`;
decrypted... *decoded* form: `{ workspaceProjectId, title, repoRemoteUrl,
defaultBranch, vaultManifest, recipeRef, perMachineRoots:
Record<EnvironmentId, path> }`.

**Contracts:** `WorkspaceProjectId` branded id in
`packages/contracts/src/baseSchemas.ts`; blob record, registry payload, and
mirror RPC schemas in new `packages/contracts/src/roaming.ts`. Mirror RPC:
`roaming.syncManifest` (exchange `(kind, key, version, contentHash)` lists) +
`roaming.fetchBlobs` / `roaming.pushBlobs`.

**Server:** `roaming/RoamingBlobStore.ts` (local blob CRUD + reconciliation
rule), `roaming/PeerMirror.ts` — a reactor (modeled on `AgentAwarenessRelay`:
drainable worker + event subscription) that tries paired peers on startup, on
interval, and on local blob writes; on contact, reconciles manifests both ways.
Peer reachability uses the same endpoint discovery remote access already does
(LAN/Tailscale). `project.meta-updated` gains an optional `workspaceProjectId`
field (additive event-schema change, replay-safe). New command
`project.enroll-roaming` mints the id, resolves the remote URL via the existing
`RepositoryIdentityResolver`/`listRemotes`, and writes the first registry blob.

**Shell/UI (revised 2026-07-05):** the data plumbing stands as built in M1 —
`OrchestrationShellSnapshot.roamingProjects` plus reducer/atom changes in
`packages/client-runtime/src/state/{shellReducer,projectEntities}.ts`. The
presentation is **one project list**, not a separate section: rows are keyed
by `WorkspaceProjectId` and merge three sources — local checkout, live remote
project (existing attach), mirrored registry copy. Row states: *local* /
*live on <machine>* (open remotely, as attach does today) / *offline —
available* (served from the local mirror copy, staleness label, Materialize
action once M2 lands). The M1 sidebar "Roaming" section is a stopgap and is
deleted when the merged list ships in M2. The sync opt-in lives **inside the
existing pairing/thin-client flow** (Add environment / remote link — the same
flow that establishes live attach) as a JetBrains-style options step:
Projects (always on), Secret files (pre-checked, default patterns), later
WIP (M4) and Conversations (M6) rows. There is no separate sync pairing:
one code, one dialog, and the handshake behind it establishes BOTH the
client attach session and the machine-to-machine mirror credential (M2
built the mirror half standalone as a "Machine sync" section — a recorded
deviation, corrected in M2.5).

**Risk:** the registry entry is a mutable shared document — versioned LWW with
surfaced conflicts is fine (it changes rarely); resist the urge to make it a
CRDT.

## Step 2 — Vault

**Manifest (revised 2026-07-05):** secrets sync is a **global category
toggle** in the sync-options step of the one pairing flow (pre-checked;
see canonical workflow), applying a default
pattern list (`.env`, `.env.*`, `*.local.*`, key/cert files) to every
project's `vaultManifest` automatically — including projects created later.
Per-project settings survive only as a rarely-used override: add a file the
defaults miss, or exclude a matched file. Never sync all gitignored content;
patterns only. Guard rails: a size cap on the vault bundle (a pattern
accidentally matching something huge must not silently ship it), and the
prompt-before-overwrite on apply below. When M7's cloud backend arrives, this
consent is re-asked — secrets moving to a third place is a different question
than secrets moving between the user's own two machines.

**Capture:** `roaming/VaultSync.ts` reactor: `FileSystem.watch` on allowlisted
paths (same debounce pattern as `ServerSettingsService`), coalesced per project
via `makeKeyedCoalescingWorker`. On change: tar the allowlisted files → write
blob `kind=vault` with incremented version. Concurrent-write conflicts (both
machines edited vault files while apart) surface per D3 — compare content
hashes per file in the UI, user picks; never merge file contents.

**Apply:** on materialize, and on demand ("pull vault files"). Files that exist
locally with different content prompt before overwrite.

**Deliberately small:** whole-bundle versioning, not per-file history; no
secret-manager UI; no sharing.

## Step 3 — One-action materialize

New server RPC `roaming.materialize(workspaceProjectId)` implemented as an
explicit resumable step machine (flagged risk: today only the back half of this
composition exists in one transaction). Steps, each idempotent and checkpointed
in a small `roaming_materializations` SQLite table:

1. Resolve target path from `perMachineRoots[thisEnvironmentId]`, else default
   root + repo name (`addProjectBaseDirectory` already exists in settings as
   the default-root precedent).
2. Clone via `SourceControlRepositoryService.cloneRepository` (skip if the path
   already holds a clone of the right remote — verify via `listRemotes`).
3. Apply vault (step 2 machinery) from the local blob copy; warn with
   last-mirror-contact age if the peer hasn't been seen recently.
4. Fetch and apply the newest WIP snapshot if one exists (step 5 machinery,
   restore path = `CheckpointStore.restoreCheckpoint`), only with an explicit
   user toggle — default on for takeover flows, off for "just browse".
5. Dispatch `project.create` with the registry title + link
   `workspaceProjectId`, reusing the normal decider path so projections/shell
   update for free.
6. Optionally kick bootstrap (step 4).

Progress streams to the UI over the existing WS notification pattern
(`VcsStatusBroadcaster.streamStatus` is the model). Failure at any step leaves a
resumable record, and re-running materialize continues, not restarts.

## Step 4 — Bootstrap recipes

**Recipe format:** a markdown document with fenced, annotated command steps —
agent-readable and agent-writable, human-auditable, no bespoke DSL. Stored as
blob `kind=recipe`, referenced from the registry entry. The existing
`ProjectScript`/`ProjectSetupScriptRunner` stays as the fast path: a recipe can
*compile down* to a setup script for repos where setup is one command.

**First materialization (no recipe):** reuse the `dispatchBootstrapTurnStart`
composition to start a provider turn in the new project with a system-authored
instruction: set up the repo, verify the dev server boots (the agent can use
project scripts/terminals it already has), then write the recipe file and
register it. This is a normal thread — user watches/approves like any agent run.

**Replay:** run recipe steps via `ProjectSetupScriptRunner`'s terminal path; on
any step failing, escalate to an agent turn seeded with the recipe + the failure
output ("fix setup, update the recipe"). Recipes rot; the agent fallback is the
feature, the recipe is the cache.

**Gap to accept:** there's no headless "run agent task" API — bootstrap runs as
a visible thread turn, which is fine (arguably better: approvals and audit for
free).

## Step 5 — Continuous WIP snapshots

**Capture:** generalize the checkpoint primitive: extract the temp-index capture
from `GitVcsDriver.makeVcsDriverShape` checkpoint ops so it can target a new
namespace `refs/t3/wip/<workspaceProjectId>/<environmentId>`. New reactor
`roaming/WipSnapshotReactor.ts` (modeled on `CheckpointReactor`): triggered by
`VcsStatusBroadcaster` dirty-status transitions, turn-completion domain events,
and a debounce timer; coalesced per project root via
`makeKeyedCoalescingWorker`. Cheap no-op detection: compare the new
`write-tree` OID against the last snapshot's tree — identical tree, no commit,
no push.

**No durable job queue needed:** a snapshot is a pure function of the current
tree, not a queue of missed deltas. On startup, snapshot any enrolled project
whose tree differs from its last WIP ref. Done.

**Transport, two modes per project:**
- *Origin refs* (default): `git push origin refs/t3/wip/...` — zero new
  infrastructure, delta-compressed, works with any host, **and works while the
  authoring machine is off** (the origin is the middleman). Guard: refuse this
  mode when the remote is one you don't control pushes to. **Validated in M0**
  against the real hosts in use.
- *Mirrored bundles* (fallback): `git bundle create <last-synced>..<wip>` →
  blob `kind=wip` over the peer mirror. For repos without push rights on the
  origin. Freshness then depends on mirror overlap, like other small state.

**Interference guards** (the riskiest point in this step — the same worktree is
touched by turn checkpoints, user git commands, and provider runs): serialize
capture with `CheckpointStore` per cwd (shared semaphore keyed by workspace
root); skip while `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` exist; skip
worktree paths belonging to thread worktrees (`thread.worktreePath`) — those
are turn-checkpoint territory; cap snapshot frequency (default: 2-min debounce,
on-idle, on turn-complete). Retention: keep last N (default 20) per machine,
prune older refs opportunistically after push.

**Worktrees decision:** v1 snapshots the *project root* only. Thread worktrees
are branch-backed and turn-checkpointed already; roaming them adds little and
doubles the interference surface.

## Step 6 — Takeover and divergence

**Activity signal:** a lease blob per project (`kind=lease`):
`{ holderEnvironmentId, acquiredAt, heartbeatAt, lastSnapshotAt }`, written by
the `WipSnapshotReactor` (it already knows when work happens) and mirrored like
any blob. Because origin WIP refs carry commit timestamps and the authoring
`environmentId` in the ref name, freshness display works from a plain
`git fetch` of the WIP namespace **even when the mirror is stale** — the lease
blob only enriches it. Lease is advisory, not a lock: it powers UX, it never
blocks a write (machines go offline holding leases; hard locks would strand
projects).

**UI:** project header chip — "active on *desktop*, snapshot 4 min ago".
**Take over** = fetch newest WIP ref/bundle → if local tree clean, restore and
claim the lease; if local tree dirty, snapshot local first (both states now
safe as commits), then show the divergence flow.

**Divergence flow:** two WIP commits with a common ancestor — render with the
existing diff machinery (`diffCheckpoints` / `getReviewDiffPreview`): "desktop
version / laptop version / diff", user picks a side (the losing side stays as a
ref, recoverable). No three-way merge, no auto-resolution, ever. This screen is
small in code and is the whole trust story of the feature.

## Step 7 — Handoff briefs and thread mirroring

**Source of truth decision:** mirror *projected transcripts*, not raw
orchestration events. Raw events are machine-sequenced and soaked in
environment-specific state (worktree paths, provider session ids); transcripts
are already exactly what `ProjectionSnapshotQuery.getThreadDetailById`
rehydrates. Define `RoamingTranscript` in contracts: thread meta + messages +
activities, minus `worktreePath`/session/runtime fields, with a
`transcriptVersion`.

**Mirror out:** `roaming/TranscriptMirror.ts` reactor (drainable worker on
domain events — subscribe, coalesce per thread, publish on turn completion, not
per token): serialize → blob `kind=transcript`, `key=threadId`. Single-writer
per thread in practice (threads live where they run), so conflicts are rare and
the D3 rule suffices.

**Mirror in:** mirrored threads render as a read-only thread list section per
project ("from desktop"), hydrated from local blobs — **never** imported into
the local event log or projections. No import path means no cross-machine event
conflict model at all; that entire problem class is deleted.

**Park:** one command = final WIP snapshot + brief generation + lease release.
Brief via the existing `textGenerationModelSelection` text-model path fed with
the serialized transcript tail (cheap, no agent turn needed), stored as blob
`kind=brief`, editable by the user before it saves.

**Resume:** "Continue from brief" on a mirrored thread = new local thread whose
first turn is seeded with the brief + a pointer to the mirrored transcript.
Plain `thread.create` + `thread.turn.start` with prefilled message — no
provider session state involved.

## Milestones

Strictly ordered; each is independently shippable. M0 exists because the two
load-bearing assumptions are cheap to verify before building on them.

| # | Scope | Exit criteria |
|---|-------|--------------------------------|
| **M0 — Pre-flight** | (a) Spike: push/fetch `refs/t3/wip/test/*` against the real git hosts in use; verify nonstandard ref namespaces round-trip. (b) Spike: from one running T3 server process, authenticate to a second one and complete an RPC round-trip using existing pairing/bearer machinery (the mirror's load-bearing assumption). (c) Two-instance test harness: two server processes with separate state dirs on one box — every later milestone's acceptance runs on this. | All three artifacts exist; go/no-go on origin-refs transport and server-to-server auth recorded in this doc. |
| **M1 — Blob store + mirror + registry** | D0–D4 + step 1: `roaming_blobs` migration, `RoamingBlobStore`, `PeerMirror` reactor, machine enrollment credential, registry blobs, roaming project list in shell/UI with staleness display. | Enroll a project on instance A; instance B shows it (title, repo, per-machine status) after a mirror pass; kill A; B still shows it from its local copy. |
| **M2 — Vault + materialize + product-model UI** *(shipped with a deviation: pairing was built as a standalone "Machine sync" flow, so the live-remote state never became reachable — see M2 results; corrected in M2.5)* | Steps 2 + 3, plus the 2026-07-05 product model: pairing sync-options dialog (opt-in + secrets toggle), automatic registration of all projects on pairing/creation, and the merged single project list (local / live-remote / offline-available states) replacing M1's sidebar section. | One action takes instance B from empty to a registered checkout with vault files applied while A is offline (using B's mirrored copy); a concurrent vault edit on both sides surfaces as a conflict, not a merge; the desktop's projects appear in the laptop's single project list with no separate section, and materializing a project without synced secrets succeeds with an honest "no secret files synced" notice. |
| **M2.5 — Unified pairing (corrective)** | Fold M2's standalone "Machine sync" pairing into the existing pairing/thin-client flow, per the canonical workflow: one pairing code establishes the live remote attach (client session + saved remote environment) AND the machine-to-machine mirror credential in the same handshake; the sync-options step renders inside that flow; delete the separate Machine sync section and pair dialog (the secrets toggle survives as an ordinary settings row). The handshake sits behind one peer-introduction seam (manual URL+code today; T3 Cloud/relay discovery later — see decisions log) so cloud pairing lands as a new producer, not a redesign. | A single pairing action on real or harness instances makes the peer's projects appear **live** in the one list — opening one runs a conversation on the peer — with registry and vault mirrored silently behind it; killing the peer flips the same rows to offline + Materialize; at no point does the UI show a second pairing flow or any "sync"/"roaming" concept. The canonical workflow (steps 1–4) demonstrated end to end. |
| **M3 — Bootstrap recipes** | Step 4. | First materialize triggers an agent setup thread that writes a recipe; second materialize replays it; a broken recipe escalates to an agent turn. Canonical workflow re-run. |
| **M4 — WIP snapshots** | Step 5 (capture + transport; restore already lands inside materialize). Adds the "Work in progress" row to the sync-options step of the one pairing flow (default on, subject to the controlled-origin guard). | Dirty tree on instance A appears on instance B via materialize with A's process killed (origin-refs path); push failures surfaced in UI; bundle fallback covered by a harness test. Canonical workflow re-run. |
| **M5 — Takeover + divergence** | Step 6. | Takeover applies newest snapshot and moves the lease; two-sided dirty divergence shows the diff-and-choose screen; the losing side remains recoverable as a ref. Canonical workflow re-run. |
| **M6 — Briefs + transcripts** | Step 7. Adds the "Conversations" row to the sync-options step of the one pairing flow. | Threads from instance A readable on instance B after a mirror pass; park produces an editable brief; resume seeds a new local thread with it. Canonical workflow re-run. |
| **M7 — Cloud store backend (gated)** | E2E encryption (key-management one-pager written and reviewed first — root key, recovery code, per-project data keys; this is the entry gate) + a cloud `RoamingBlobStore` implementation: private git store repo, or T3 relay if the waitlist has cleared by then. Extends D3 records with encryption fields. Must re-ask the secrets-sync consent before any cloud backend activates. | Small state reaches a fresh machine with zero online overlap with any other machine; a test asserts the cloud side holds ciphertext only. |

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
  factored out). The client's persistent session stays standard-scoped; the
  admin bearer is used only inside the handshake and never stored.
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
  only offline availability needs the admin-capable code.
- **The machine-credential route becomes flag-independent and carries
  consent.** Today all roaming routes 404 while the peer's `roaming` setting
  is off — the desktop would need a settings ritual before pairing could
  succeed (chicken-and-egg). The mint route is un-gated from the flag (still
  `access:write`); a successful mint flips the peer's `roaming` setting on and
  applies a new `syncOptions: { secretsSync?: boolean }` request field to the
  peer's `roamingSecretsSync`. Consent story: the desktop user consented by
  generating the admin-scoped code; the laptop user picked the sync options in
  the one dialog; both machines belong to the same owner. The sync-options
  choice propagates to BOTH machines' settings (each machine's setting remains
  the mechanism; ordinary settings rows remain for changing your mind later).
- **Live→offline is a real UI gap (reviewer-grade catch).** A disconnected
  bearer environment keeps its cached shell snapshot, so a dead peer's
  projects stay in `projectsAtom` as live-looking rows AND suppress the
  mirrored offline rows via the canonicalKey dedup — exactly the "visible but
  dead" state the canonical workflow prohibits. Fix in the sidebar merge:
  rows from a non-live remote environment stop counting as live; the mirrored
  registry rows then surface as offline + Materialize. (The reverse dedup —
  peer alive, registry row suppressed — already works.)
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
  offline flip) is demonstrated on the real desktop build.

## Execution process

**Branching (fork discipline):** `main` tracks upstream and receives their
updates; never merge roaming work into it. All roaming work lands on a
long-lived `feature/roaming` branch via small PRs (one per seam, not one per
milestone). Rebase `feature/roaming` onto `main` at the start of every
milestone and after any large upstream sync. The additive file layout (D0/D2)
is what keeps these rebases near-conflict-free — treat any edit to an existing
upstream file as a cost to be minimized and isolated.

**Feature flag:** everything behind a `roaming` server setting; reactors don't
start when unset (same pattern as T3 Connect being disabled without its env
config). The flag is what makes rebasing onto a moving upstream safe.

**Per-milestone loop:**
0. **Re-read the Canonical workflow section** (top of this doc). Restate the
   milestone's scope as a delta against those four steps; if the milestone's
   design cannot be expressed that way, the design is wrong — correct this
   document before writing code. M2 skipped this and shipped a second
   pairing concept; that class of drift is what this step exists to stop.
1. **Analysis pass** — re-validate this plan's assumptions for the milestone
   against the *current* code (upstream moves; the 2026-07-03 mapping rots).
   Verify against the canonical workflow explicitly, not just against
   technical assumptions. Record deviations by editing this document before
   writing code.
2. **Contracts PR first** — schemas in `packages/contracts` as their own small
   PR; reviewed hardest of anything, everything downstream types against it.
3. **Implement along seams** — server reactor / blob store / client-runtime
   state / web UI as separate PRs. Well-specced pieces are good delegation
   candidates; judgment-heavy UX (divergence screen, enrollment, materialize
   progress) is not.
4. **Review every PR independently of its author.** Mirror auth and
   blob-reconciliation code gets the highest-effort review; UI plumbing can go
   lighter.
5. **Milestone acceptance** — run the exit criteria from the table on the M0
   harness, end-to-end, before starting the next milestone. From M2.5 on,
   acceptance always includes the canonical workflow itself: pair once →
   live remote conversation → optional materialize with the peer offline.
6. **Update this document** — status/decisions log at top, deviations, and any
   decision changes. The doc is the only cross-thread memory.

## Kickoff prompts

Each milestone runs in a fresh thread. The only context a thread needs is this
document and the current code. Paste one of these:

**M0:**
> Read `.plans/21-roaming-workspace.md` in full. Execute milestone M0
> (Pre-flight) per the milestone table and Execution process. Deliverables: the
> two spike results (origin hidden-ref round-trip; server-to-server
> authenticated RPC) and the two-instance test harness. Record spike outcomes
> and the go/no-go calls by editing the plan doc. Do not start M1.

**M2.5–M7 (template — substitute the milestone number):**
> Read `.plans/21-roaming-workspace.md` in full — the Canonical workflow
> section first and last — plus the Execution process and the current
> status/decisions log. Execute milestone M<N> only. Start with the analysis
> pass: verify the plan's assumptions for this milestone against the current
> code AND against the canonical workflow, and update the doc with any
> deviations before implementing. Work on `feature/roaming` (rebase onto
> `main` first), small PRs per seam, everything behind the `roaming` flag.
> Finish by running the milestone's exit criteria on the M0 harness
> end-to-end — including the canonical workflow (pair once → live remote
> conversation → optional materialize with the peer offline) — and updating
> the doc's status line. Do not start the next milestone. (M7 only: the
> key-management one-pager must be written and reviewed before any
> implementation.)

When a milestone completes, update the **Status** line at the top of this file
(e.g. "M2 complete 2026-07-19; M3 next") so the next fresh thread orients
instantly.
