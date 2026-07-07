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
   patterns), Work in progress (arrives M3), Conversations (arrives M6).
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
> **NEXT UP: M4 (bootstrap recipes)** — its analysis pass must scope
> honest limits (v1 targets scriptable setups; capture-what-happened over
> guaranteed-boot). M2.5 DONE 2026-07-06 (PRs #19–#29+).
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
> **How to execute:** this document is self-contained. To start work in a fresh
> thread, paste one of the kickoff prompts from the [Kickoff prompts](#kickoff-prompts)
> section at the end. Milestones run strictly in order (M0 → M2, M2.5, M3 → M7; renumbered 2026-07-06 so execution order and numbers agree).
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

**Shell/UI (as built, M1–M2.5):** data plumbing =
`OrchestrationShellSnapshot.roamingProjects` plus reducer/atom changes in
`packages/client-runtime/src/state/{shellReducer,projectEntities}.ts`. The
presentation is **one project list**: rows merge three sources — local
checkout, live remote project (existing attach), mirrored registry copy —
with states *local* / *live on <machine>* / *offline — available*
(Materialize action). The sync opt-in lives **inside the existing
pairing/thin-client flow** (Add environment → Remote link) as a
JetBrains-style options step: Projects (always on), Secret files
(pre-checked, default patterns), later WIP (M3) and Conversations (M6)
rows. There is no separate sync pairing: one code, one dialog, one
handshake establishing BOTH the client attach and the machine-to-machine
mirror credential (mechanics under Landed constraints → M2.5).

**Risk:** the registry entry is a mutable shared document — versioned LWW with
surfaced conflicts is fine (it changes rarely); resist the urge to make it a
CRDT.

## Step 2 — Vault

**Manifest (revised 2026-07-07, M3.5 — user decision, supersedes the
2026-07-05 wording):** secrets sync remains the **global category toggle**
in the sync-options step of the one pairing flow (pre-checked; see canonical
workflow). What travels is defined by **two editable files with exact
.gitignore semantics — no hidden pattern list, no registry override**
(git's `core.excludesFile` model):
- **Global `<stateDir>/t3sync`** — written ONCE, pre-populated with the
  defaults (`.env`, `.env.*`, `*.local.*`, key/cert files), then never
  regenerated. Deleting a line stops that pattern syncing everywhere.
  Repos are never touched by the app.
- **Repo-root `.t3sync`** — optional, purely user-created, per project like
  `.gitignore`. Extends the global file (`.idea/` to sync a gitignored
  tree) or vetoes it (`!.env` keeps this project's `.env` local) — project
  patterns are processed after global ones, so they win.
Matching runs through git's own exclude engine (`ls-files -o -i
--exclude-from` global-then-project), so directories, globs, and negation
behave exactly like `.gitignore`, including nested paths (monorepo
`packages/*/.env` now matches — the old defaults were top-level-only).
The M2 `vaultOverrides` registry mechanism is retired (schema field
remains, no longer consumed — it never had a way to be edited).
Never sync all gitignored content; patterns only. Guard rails: a size cap
on the vault bundle (a pattern accidentally matching something huge must
not silently ship it), and the prompt-before-overwrite on apply below.
When M7's cloud backend arrives, this consent is re-asked — secrets moving
to a third place is a different question than secrets moving between the
user's own two machines.

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
3. Fetch and apply the newest WIP snapshot if one exists (step 5 machinery,
   restore path = `CheckpointStore.restoreCheckpoint`), controlled by an
   explicit `restoreWip` toggle on the materialize request — **default ON**
   (revised in the M3 analysis pass: materialize means bring-to-latest; the
   original "off for just-browse" distinction belongs to M5's takeover flow).
   Rendered as a pre-checked checkbox in the existing materialize
   folder-prompt step. Sources, in order: origin `refs/t3/wip/<wsid>/*`
   (explicit fetch — the default refspec never sees them), then `kind=wip`
   bundle blobs (local copy, or on-demand peer fetch like vault blobs).
   Newest by committer timestamp across environments; skipped with a recorded
   notice when no snapshot exists, when the snapshot tree equals the clone's
   HEAD tree, or when the target tree is not clean. The applied snapshot's
   age and authoring machine are recorded in the step detail (a snapshot
   older than the clone's HEAD can legitimately win — the notice keeps that
   honest). **Ordering (M3 analysis, review finding): restore-wip runs
   BEFORE apply-vault** — restore's cleanliness check and `git clean -fd`
   then operate on the pristine clone instead of depending on vault files
   being gitignored; content-wise the order is free because WIP capture
   subtracts the vault set (step 5), so the two file sets are disjoint.
   Resume of pre-M3 in-flight materialization records must tolerate the
   old step order.
4. Apply vault (step 2 machinery) from the local blob copy; warn with
   last-mirror-contact age if the peer hasn't been seen recently.
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

*(As built in M3; the analysis-pass narrative that shaped this section is in
the history file.)*

**Capture:** the temp-index recipe (`GIT_INDEX_FILE` + `read-tree HEAD` /
`add -A` / `write-tree` / `commit-tree` / `update-ref`) is reimplemented in
`roaming/` (~40 lines of the proven `captureCheckpoint` recipe run through the
existing process runner — no upstream-file edits) rather than calling the
driver op verbatim, for two verified reasons: WIP commits must carry
**`parent = HEAD`** (checkpoint commits are parentless; a 2026-07-06 spike
showed parentless commits make `git bundle --not --remotes=origin` emit FAT
whole-tree bundles since bundle thinning is commit-ancestry-based — with
parent=HEAD the same bundle is bytes-sized with HEAD as the satisfied
prerequisite; parents are also what give M5's divergence flow its common
ancestor), and capture must return `{ treeOid, commitOid }` for no-op
detection. The driver's `restoreCheckpoint` IS reused verbatim for restore.
**WIP capture subtracts the project's effective vault set from the temp index
before `write-tree`** — vault-targeted files are gitignored by convention
(gitignored files are excluded from `add -A` anyway), but a vault include
override can name a non-gitignored file, and vault content must never reach
the origin host (it is P2P-only by design). New reactor
`roaming/WipSnapshotReactor.ts` (modeled on `VaultSync`, the closest roaming
reactor): triggered by `thread.turn-diff-completed` domain events (post-turn,
tree stable), a startup scan, and an interval scan (default 120s — equal to
the debounce cap, so per-cwd `VcsStatusBroadcaster` subscriptions would add no
effective freshness; there is no global dirty-transition stream and no
idle/pre-sleep hook in the codebase); coalesced per project via
`makeKeyedCoalescingWorker`. Known window (accepted): a manual CLI commit
fires no domain event, so a stale dirty snapshot can outlive the commit by up
to one interval tick; the restore-side age/author notice keeps it honest.

**Snapshot semantics — the WIP ref mirrors the worktree TREE, dirty or
clean.** Capturing also when the tree becomes clean is what prevents a stale
dirty snapshot on the origin from shadowing work the user has since committed.
No-op detection: skip the push when the new tree OID equals the last-pushed
tree OID (last-pushed commit tracked in a local marker ref
`refs/t3/wip-pushed/<workspaceProjectId>/<environmentId>`, adopted from the
remote on lease mismatch). Restore correspondingly skips when the snapshot
tree equals the target clone's HEAD tree, and applies only to a clean target
tree. Staged/unstaged distinction is flattened on restore (existing checkpoint
restore semantics; accepted).

**No durable job queue needed:** a snapshot is a pure function of the current
tree, not a queue of missed deltas. On startup, snapshot any enrolled project
whose tree differs from its last WIP ref. Done.

**Transport, two modes per project:**
- *Origin refs* (default): `git push origin refs/t3/wip/...` with
  `--force-with-lease=<ref>:<last-pushed>` — zero new infrastructure,
  delta-compressed, works with any host, **and works while the authoring
  machine is off** (the origin is the middleman). The driver's push/fetch API
  is branch-oriented only, so WIP push/fetch runs as raw git through the
  existing process runner from `roaming/` code (no upstream-file edits).
  **Controlled-origin guard (revised): push rights cannot be proven without
  pushing — the guard IS a push probe.** Permission-shaped failures
  (denied/403/read-only) flip the project to bundle mode (held in memory,
  re-probed on restart so granted rights self-heal); other failures retry and
  surface. **Validated in M0** against the real hosts in use (the spike script
  itself did not survive; the GO verdict in Landed constraints stands).
- *Mirrored bundles* (fallback): `git bundle create <wip> --not
  --remotes=origin` → blob `kind=wip` over the peer mirror, payload
  `{ schemaVersion, capturedAt, refName, commitOid, treeOid, bundleBase64 }`,
  size-capped (`ROAMING_WIP_BUNDLE_MAX_BYTES`, default 8 MiB; oversize skipped
  with a surfaced warning — vault pattern). For repos without push rights on
  the origin. Freshness then depends on mirror overlap, like other small state.
  **Spiked GO 2026-07-06:** with parent=HEAD the bundle is thin (prerequisite
  = HEAD, satisfied by any fresh clone of the origin; `bundle verify` +
  fetch-from-bundle + checkpoint-restore round-trip confirmed); parentless
  commits would make every bundle a whole-tree fat bundle — hence the
  parent=HEAD capture decision above.

**Consent (new in the analysis pass — vault logic does not transfer):** WIP
content goes to the project's ORIGIN, a third-party host, unlike vault data
which never leaves the user's machines. So `roamingWipSync` defaults to false
in the settings schema; the pairing dialog's pre-checked "Work in progress"
row is the consent and applies to both machines as one decision (same rule as
Secret files). Machines paired before M3 enable it via the ordinary settings
row — it does not switch itself on.

**Push-failure surfacing:** a `roamingWipStatus` shell-snapshot field (same
merge-point pattern as `roamingMaterializations`) carries per-project
`{ mode, lastCapturedAt, lastPushedAt, lastError }` for the UI.

**Accepted risks:** a cloned state dir (two machines sharing one persisted
environmentId) makes both write the same WIP ref and lease-adopt each
other's pushes in a ping-pong — same class as the accepted initiator-side
environmentId clobber; a re-install minting a new environmentId orphans the
old machine's WIP ref on the origin (bounded: one stale ref per abandoned
environmentId, prunable by hand).

**Interference guards** (the riskiest point in this step — the same worktree is
touched by turn checkpoints, user git commands, and provider runs): capture is
worktree-read-only (temp index; it never touches the real index or files) and
the only mutating op — restore — runs at materialize time on a fresh clone, so
the originally planned shared semaphore with `CheckpointStore` is dropped (no
such lock exists to share; adding one means editing upstream files to guard a
non-mutating race). The reactor serializes itself per project via the keyed
worker; skips while `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` exist; caps
snapshot frequency (default: 2-min debounce, on turn-complete, on startup —
no idle/pre-sleep hooks exist to ride). Thread worktrees live under
`<baseDir>/worktrees/`, outside project roots, so snapshotting only the
project root excludes them by construction. Retention: local rolling history
refs, last N (default 20) per (project, machine), oldest slot overwritten
after each successful push; the origin holds only the newest snapshot.

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
| **M2 — Vault + materialize + product-model UI** *(shipped with a deviation: pairing was built as a standalone "Machine sync" flow, so the live-remote state never became reachable — see the history file; corrected in M2.5)* | Steps 2 + 3, plus the 2026-07-05 product model: pairing sync-options dialog (opt-in + secrets toggle), automatic registration of all projects on pairing/creation, and the merged single project list (local / live-remote / offline-available states) replacing M1's sidebar section. | One action takes instance B from empty to a registered checkout with vault files applied while A is offline (using B's mirrored copy); a concurrent vault edit on both sides surfaces as a conflict, not a merge; the desktop's projects appear in the laptop's single project list with no separate section, and materializing a project without synced secrets succeeds with an honest "no secret files synced" notice. |
| **M2.5 — Unified pairing (corrective)** | Fold M2's standalone "Machine sync" pairing into the existing pairing/thin-client flow, per the canonical workflow: one pairing code establishes the live remote attach (client session + saved remote environment) AND the machine-to-machine mirror credential in the same handshake; the sync-options step renders inside that flow; delete the separate Machine sync section and pair dialog (the secrets toggle survives as an ordinary settings row). The handshake sits behind one peer-introduction seam (manual URL+code today; T3 Cloud/relay discovery later — see decisions log) so cloud pairing lands as a new producer, not a redesign. | A single pairing action on real or harness instances makes the peer's projects appear **live** in the one list — opening one runs a conversation on the peer — with registry and vault mirrored silently behind it; killing the peer flips the same rows to offline + Materialize; at no point does the UI show a second pairing flow or any "sync"/"roaming" concept. The canonical workflow (steps 1–4) demonstrated end to end. |
| **M3 — WIP snapshots** | Step 5 (capture + transport; restore already lands inside materialize). Adds the "Work in progress" row to the sync-options step of the one pairing flow (default on, subject to the controlled-origin guard). | Dirty tree on instance A appears on instance B via materialize with A's process killed (origin-refs path); push failures surfaced in UI; bundle fallback covered by a harness test. Canonical workflow re-run. |
| **M3.5 — Sync completion (field-driven)** | Delivery + freshness for step 5, per the 2026-07-07 field session: auto-apply of newer other-machine snapshots onto clean/strictly-behind checkouts (applied-marker ref `refs/t3/wip-applied/<wsid>`; locally-edited trees are never touched — notice only); filesystem-watch capture (seconds, not minutes; 2-min sweep as fallback); graceful-shutdown snapshot; `.t3sync` per-project include file (gitignore syntax) carrying gitignored paths like `.idea/` over the machine-to-machine channel; origin-mode size guard; per-machine consent copy/propagation fix. | Create a file on machine A → it appears on machine B's clean checkout within seconds, no user action; a locally-edited checkout on B is never overwritten and surfaces a notice; `.idea/` listed in `.t3sync` round-trips A→B while staying out of the origin; an oversized untracked file is skipped with a surfaced notice, never pushed. Canonical workflow re-run. |
| **M3.6 — Field round 2 (delivery gaps + visibility)** | Same-day field findings on the real machines: (1) **vault delivery** — vault blobs apply on arrival (and at startup catch-up) to linked checkouts, not only at materialize: missing files written, files unmodified since OUR last apply updated (per-file applied-hash record under `<stateDir>/vault-applied/`), locally-modified files never overwritten (notice); peer-deleted files are NOT deleted locally (v1 accepted gap — the mirrored bundle holds the only other copy). (2) **based-on fast-forward** — WIP capture embeds a `T3-Based-On` trailer (the applied-marker commit); apply additionally accepts a peer snapshot whose based-on tree equals the current worktree tree (the peer built on exactly what this machine has — e.g. laptop edits on top of the desktop's WIP flowing back to the still-unchanged desktop). Edited-since stays blocked (M5). (3) **sync visibility** — `blockedReason` on the wip status entry + a per-project sync indicator (error > blocked > synced-recently > idle). | With A dirty-but-unchanged: a file created on B lands on A within seconds (based-on path); with A edited since, A's tree is untouched and the indicator shows blocked. A `.t3sync` line added on A delivers the matched files to an already-materialized B without re-materializing; an updated secret reaches B's unmodified copy; B's locally-edited copy is never overwritten. Canonical re-run. |
| **M4 — Bootstrap recipes** | Step 4. | First materialize triggers an agent setup thread that writes a recipe; second materialize replays it; a broken recipe escalates to an agent turn. Canonical workflow re-run. |
| **M5 — Takeover + divergence** | Step 6. | Takeover applies newest snapshot and moves the lease; two-sided dirty divergence shows the diff-and-choose screen; the losing side remains recoverable as a ref. Canonical workflow re-run. |
| **M6 — Briefs + transcripts** | Step 7. Adds the "Conversations" row to the sync-options step of the one pairing flow. | Threads from instance A readable on instance B after a mirror pass; park produces an editable brief; resume seeds a new local thread with it. Canonical workflow re-run. |
| **M7 — Cloud store backend (gated)** | E2E encryption (key-management one-pager written and reviewed first — root key, recovery code, per-project data keys; this is the entry gate) + a cloud `RoamingBlobStore` implementation: private git store repo, or T3 relay if the waitlist has cleared by then. Extends D3 records with encryption fields. Must re-ask the secrets-sync consent before any cloud backend activates. | Small state reaches a fresh machine with zero online overlap with any other machine; a test asserts the cloud side holds ciphertext only. |

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
  resurrection; timestamps compare with `<=`, so ties skip).
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
  checkout, no-clobber of a locally-edited checkout, `.t3sync` `.idea/`
  round-trip with origin hygiene, oversize warning) + the
  canonical-workflow re-run.

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
- **Flagged follow-ups (observed during M3.6 acceptance, not fixed):**
  (1) A→B delivery latency varies 1s–56s across identical-code runs — the
  beacon fast path sometimes loses to the periodic pass; worst case stays
  bounded by the 60s mirror interval. Needs instrumentation before
  optimizing. (2) Under harness load the settings file-watcher stopped
  delivering external-edit reloads (no errors logged) — suspected inotify
  instance exhaustion from the recursive per-project watchers; the
  acceptance step was made restart-based, but watcher budgeting deserves a
  real look (it could starve settings/skills watching on user machines
  with many projects).

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
6. **Update this document, then prune it** — status line and decisions log
   at top, and the milestone's still-binding constraints as bullets under
   [Landed constraints](#landed-constraints-m0m25). Move the full
   analysis/results narrative verbatim to `21-roaming-history.md`
   (append-only; never read by kickoff prompts). This doc is the only
   cross-thread memory, so it must stay CURRENT-STATE: superseded text is
   noise that every future thread pays to read and can be misled by — the
   M2 deviation started as a transcription error that lived here.

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
(e.g. "M2 complete 2026-07-19; M4 next") so the next fresh thread orients
instantly.
