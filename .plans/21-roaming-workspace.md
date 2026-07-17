# Roaming workspace — plan

Three documents, three jobs — keep them that way:

- **This file** — the plan: product contract, architecture, current design,
  milestones. Current-state only; no results, no narrative.
- [`21-roaming-reference.md`](21-roaming-reference.md) — technical reference:
  ref namespaces, schemas, invariants, harness/acceptance inventory. Updated
  alongside code.
- [`21-roaming-history.md`](21-roaming-history.md) — append-only archive:
  per-milestone results, field-session narratives, superseded decisions.
  Never loaded by kickoff prompts.

## Canonical workflow — read this first, it overrides everything below

Stated by the user repeatedly (M1 product thread and twice on 2026-07-05).
Every milestone's design AND acceptance must reduce to this workflow; where
any other sentence in this document conflicts with it, this section wins and
the document must be corrected before coding.

1. **Open T3 Code on the laptop.** You see your local projects. Nothing else.
2. **Pair the desktop — once.** This is the *existing* pairing/thin-client
   flow (one code, one dialog), which gains a JetBrains-style **what to
   sync** step: Projects (always on), Secret files (pre-checked, default
   patterns), Work in progress (M3), Conversations (M5).
3. **Remote conversations work immediately.** The desktop's projects appear
   live in the ONE project list; opening one runs on the desktop (thin
   client). If pairing succeeded but a remote conversation doesn't work,
   the milestone is not done — no exceptions.
4. **Optionally materialize.** Any of those projects can be materialized
   locally (clone + synced secrets + WIP + registration) to keep working
   while the desktop is offline. The mirror syncs silently behind the live
   connection to make exactly this possible; offline rows stay in the same
   list, greyed, with Materialize as the action.

Permanent prohibitions: no user-visible "roaming", "machine sync", or
"enrollment" concept, section, toggle-page, or second pairing flow; no second
project list; sync options appear only inside the one pairing flow (plus
ordinary settings rows for changing your mind later); pairing must never
leave the user in a state where the other machine's projects are visible but
dead.

## Status

M0–M3.8 done (2026-07-04 → 2026-07-11; results in the history file), plus
the 2026-07-15 post-M3.8 audit fixes and the 2026-07-16 code cleanup
(reactor split, decision-table classifier, shim removal — PRs #57–#60).
The branch-aware ship gate is closed. M4–M7 remain queued in execution
order (renumbered 2026-07-17): M4 takeover + divergence, M5 briefs +
transcripts, M6 bootstrap recipes, M7 cloud store. M4 is active
(started 2026-07-17; analysis pass done, deltas recorded in its design
section).

## Thesis

Every paired machine can bring any project to its latest state — code,
secrets, uncommitted work, runtime setup, agent context — in one action.
Code lives at each project's git origin; uncommitted work rides the origin
too as hidden refs, so it survives the authoring machine being off. The
remaining small state (project list, vault files, transcripts) mirrors
directly between the user's machines whenever both are online, with a full
local copy on each. No always-on service, no account, no encryption layer in
v1: data only travels over the already-authenticated connection between the
user's own machines.

**Deployment reality:** this repo is a fork of upstream T3 Code. Upstream's
cloud service (T3 Connect) is invite-gated and unusable here — nothing in v1
depends on it; all storage goes through `RoamingBlobStore` so a cloud backend
can arrive in M7 without touching callers. Upstream flows into `main`
continuously, so roaming stays additive (new directories, new contract
files, minimal touches to existing files) on the long-lived `feature/roaming`
branch — see Execution process.

**Accepted v1 limitation:** small state is only as fresh as the last time
both machines were online together; uncommitted code doesn't depend on the
mirror at all (origin hidden refs). The one real failure case — project
never opened on the laptop, desktop unreachable, secrets needed now — is
what M7 removes.

## Binding decisions

Dated user decisions still in force; full text and superseded entries in the
history file.

- **2026-07-04 — transport:** v1 small-state transport = machine-to-machine
  mirror; cloud store deferred to gated M7 behind the same `RoamingBlobStore`
  interface.
- **2026-07-05 — product model locked:** one project list; no user-visible
  roaming concept; "pairing" means the EXISTING pairing/thin-client flow,
  which carries the sync-options step. Registry metadata syncs automatically
  for all projects once paired.
- **2026-07-05 — cloud-pairing readiness:** if upstream's cloud discovery
  opens up, it replaces only the manual introduction (URL + code), never the
  trust model — new producer behind the `PeerIntroduction` seam.
- **2026-07-06 — M2.5 product corrections (field):** sync on/off is a PAUSE
  on the standing pairing, never a new code; ONE secrets decision per
  pairing; one paired machine = one Authorized-clients row; Materialize is
  enabled-iff-workable, disabled-with-reason otherwise; revoked/auth-failed
  remotes flip to offline + Materialize.
- **2026-07-07 — t3sync manifests:** what the vault syncs is defined by two
  editable files with exact .gitignore semantics (global `<stateDir>/t3sync`
  + optional repo-root `.t3sync`); `vaultOverrides` retired.
- **2026-07-11 — full-working-state sync model:** apply either reproduces
  the peer's complete git state (branch + HEAD + dirty tree) or touches
  nothing; auto-switch on an untouched checkout is accepted (parking makes
  it lossless). Now fully expressed by the WIP sync design section below.
- **2026-07-17 — milestone numbers always match execution order:** current
  order M4 takeover + divergence, M5 briefs + transcripts, M6 bootstrap
  recipes, M7 cloud store — the first two finish the core sync story;
  recipes are the open-ended comfort feature and run last before the gated
  cloud milestone. Kickoff prompts address milestones by number; records
  keep the numbering of their date (era map at the top of the history
  file).

## Architecture

- **D0 — Transport:** all small roaming state is versioned blobs addressed
  by `(workspaceProjectId, kind, key)`, stored locally in SQLite
  (`roaming_blobs`) on every machine, reconciled through the
  `RoamingBlobStore` interface. V1 backend: `PeerMirror` — paired machines
  exchange manifests and transfer newer versions over the fork's existing
  authenticated channel. M7 adds a cloud backend behind the same interface.
- **D1 — Two-tier identity:** `WorkspaceProjectId` (machine-independent,
  minted automatically at pairing/creation) alongside the untouched local
  `ProjectId`. A project is roaming iff it has one. No user-facing
  enrollment step.
- **D2 — The server is the roaming agent:** all sync, watching,
  snapshotting, and mirror traffic lives in `apps/server/src/roaming/`. UIs
  only render shell-state entities and dispatch commands.
- **D3 — One blob record shape for every kind** (registry, vault, wip,
  recipe, lease, transcript, brief): `{ schemaVersion, kind, key,
  workspaceProjectId, version, contentHash, authorEnvironmentId, updatedAt,
  payload }`. Per key, higher version wins; same version, different hash =
  surfaced conflict, never auto-merge.
- **D4 — Peer trust rides existing pairing:** the one pairing handshake
  additionally mints a long-lived scoped machine-to-machine credential.
  Machine identity = the persisted server `environmentId`.
- **D5 — Encryption deferred to M7 deliberately:** v1 blobs move only
  between the user's own machines over the authenticated channel. Any cloud
  backend makes E2E encryption mandatory, key-management design reviewed
  before M7 code.

## Design

Current-state design per subsystem. Mechanics (schemas, ref names, decision
tables, caps) live in the reference file.

### Registry + mirror

Projects are user-owned and machine-independent: registry blobs carry title,
remote URL, default branch, and per-machine roots; every machine shows the
full list — local / live-on-peer / offline-available — merged into the one
project list. Renames roam (registry title propagation, event-triggered both
directions). `PeerMirror` reconciles on startup, on interval (60s), on local
blob writes, and via a `mirror/wait` long-poll so the callee side (which
holds no credential for the initiator — one-directional connectivity by
design) delivers in seconds, not on the interval. The registry entry is
versioned LWW with surfaced conflicts — it changes rarely; resist making it
a CRDT.

### Vault

Per-project sync of gitignored-but-precious files (`.env`, certs, tool
configs), captured on change (fs watch + 30s interval backbone — the watcher
is an optimization, never a guarantee), versioned as whole bundles, mirrored
P2P only — vault content never reaches the origin host. What travels is
defined by the two t3sync manifest files (gitignore semantics, project lines
win). Delivery applies on arrival to linked checkouts: missing files
written, files unmodified since our last apply updated, locally-modified
files never overwritten (notice); peer-deleted files are not deleted locally
(v1 accepted gap). Size-capped; oversize skipped with a surfaced warning.
Concurrent edits on both machines surface as a conflict; user picks a side;
never merge file contents.

### Materialize

One action takes a project from "on the other machine" to a registered local
checkout: resolve path → clone → restore WIP → apply vault → register, as a
resumable idempotent step machine with progress streamed to the UI. Fetches
registry and vault blobs on demand from a reachable peer. With M3.8,
restore-WIP is branch-aware: if the newest snapshot's branch differs from
the clone's default branch, materialize creates and checks out that branch
at the snapshot's HEAD before restoring the dirty diff.

### WIP sync — branch-aware model

**The unit of sync is the full git working state: branch + HEAD commit +
dirty tree.** A snapshot without its branch/HEAD context is meaningless —
tree-only sync (shipped M3–M3.7) is what produced uncommitted soup across
branches and triggered the ship gate.

**Capture** (mechanics, triggers, and transport in the reference):
temp-index snapshot of the full working state — staged/unstaged flattened,
vault set subtracted, oversize untracked files excluded — committed with
parent = HEAD and provenance trailers, shipped via origin push or bundle
blob fallback. Snapshots capture the clean state too (a stale dirty
snapshot must never shadow committed work), and the no-op identity is the
full `(branchRef, headOid, treeOid)` tuple, so a branch/HEAD move with an
unchanged tree still ships. A snapshot without v2 branch/HEAD context is
legacy and never auto-applies — ref ancestry alone cannot recover the
checked-out branch.

**Apply — reproduce completely or touch nothing.** Given peer snapshot
`{branch Bp, head Hp, tree Tp}` and local `{branch Bl, head Hl}`, classify
by ancestry (merge-base), never wall clock:

| Case | Condition | Behavior |
|---|---|---|
| Same context | Bp=Bl, Hp=Hl | Per-file merge (M3.7 machinery, unchanged): peer-changed files cross, both-changed files keep ours + surface, deletions gated on Based-On provenance. |
| Fast-forward | Bp=Bl, Hp descendant of Hl | Untouched checkout: fetch, move HEAD to Hp (hard reset — fast-forward by construction, gated on ancestry + untouched + parking), apply dirty diff on top. Locally edited: **blocked** ("peer moved <branch> forward; you have local edits"). |
| Different branch | Bp≠Bl | Untouched checkout: park, create/update local Bp at Hp (only if fast-forward-safe), `git switch`, apply diff. Touched, or local Bp not ff-safe: **blocked** ("peer is on <branch>"). |
| Peer behind | Hp ancestor of Hl | Skip (marker bookkeeping only). |
| Diverged / detached / legacy payload | everything else | **Blocked.** Divergence resolution UI is M4. |

**Untouched** = worktree tree equals either the applied-marker tree or the
current HEAD tree (a Git-clean checkout stays untouched when retained sync
metadata describes earlier WIP); no merge/rebase/cherry-pick in progress; no
in-flight agent turn in the project; local branch/HEAD still matches this
machine's latest captured payload (or the applied payload before its first
local capture). The turn guard uses a project-level projection query (the
current thread repository has no session-state query).
Auto-switch on an untouched checkout is accepted behavior (user decision
2026-07-11): it is the roaming promise, and parking makes it lossless.

**Parked refs:** before any HEAD move, local state snapshots to
`refs/t3/wip-parked/<wsid>/<branch>` (per branch — work on multiple branches
survives switching). A branch return observed while T3 is running restores
the snapshot once. Startup alone never restores a parked ref.

**Takeover (minimal, pulled forward from the takeover milestone):** every
blocked state surfaces
one explicit action — park local state, switch/create the peer's branch at
its HEAD, restore its dirty diff. Leases, activity chips, and the
diff-and-choose divergence screen stay M4; M3.8 only guarantees blocked
states are never dead ends.

**What roams and what doesn't:** the checked-out branch + HEAD + dirty tree
roam; the roaming state follows wherever HEAD points, automatically — no
branch checklist. Other local branches, stashes, in-progress rebases, the
staged/unstaged split, and reflog do not roam. Committed-and-pushed work is
the degenerate case (empty diff): apply = fast-forward, i.e. "git pull for
free" — but only following the peer's snapshot, never a general
auto-puller, and only ever fast-forward.

**Consent:** WIP content reaches the project's ORIGIN host (unlike vault
data), so `roamingWipSync` defaults off; the pre-checked "Work in progress"
pairing row is the consent, one decision for both machines.

### Takeover + divergence (M4)

Advisory lease blob per project (never a lock) powering "active on desktop,
snapshot 4 min ago" chips; full takeover UX; two-sided divergence rendered
with the existing diff machinery — desktop version / laptop version, user
picks a side, the losing side stays recoverable as a ref. No three-way
merge, no auto-resolution, ever. This screen is the trust story of the
feature.

Analysis-pass deltas (2026-07-17) against the shipped M3.8 code:

- The `lease` blob kind is already plumbed generically (contracts, store,
  mirror); M4 adds only its payload schema and semantics. Leases are
  per-machine activity records (key `<wsid>/<envid>`, not the per-project
  singleton originally implied — a singleton written by both active
  machines produces equal-version blob conflicts exactly when the chip
  matters). Renewed by WIP capture activity and in-flight turns; "the
  lease" is derived — newest `renewedAt` wins — and takeover moves it by
  writing a fresh record. Advisory only: a stale or missing lease never
  blocks anything; it only informs the chip.
- Divergence today is one blocked-reason string, contract-indistinguishable
  from other blocks. M4 gives it a distinct status surface plus a new
  two-sided diff operation (merge-base → local, merge-base → peer — the
  merge-base OID is not currently retained and no existing endpoint diffs
  two arbitrary commits). Rendering reuses the existing diff components.
- Choosing a side must explicitly preserve the loser: picking peer already
  parks local state; picking local must pin the peer's rejected snapshot to
  a local ref (today it only lives in the peer's force-updatable wip ref).
- Takeover tightening pulled into M4 scope: `takeoverAvailable` is
  currently set on blocks takeover refuses (in-flight turn, legacy
  snapshot) — make it honest; takeover requests name the snapshot commit
  the user saw (today race-to-newest between pill render and click).
- Chips are powered by the lease + the wip beacon's `capturedAt` (per
  project, per machine); `lastMirrorContactAt` is global across peers and
  is not a chip source. Chip copy stays concept-free: machine label +
  snapshot age, never "lease"/"roaming".

### Briefs + transcripts (M5)

Mirror *projected transcripts*, not raw orchestration events; mirrored
threads render read-only ("from desktop"), never imported into the local
event log — no cross-machine event conflict model exists because no import
path exists. Park = final snapshot + agent-written resumption brief; resume
= new local thread seeded with the brief. Deliberately no provider-session
transplants.

### Bootstrap recipes (M6)

The clone was never the expensive part — setup is. First materialization
runs an agent thread that sets up the repo, verifies the dev server boots,
and records what it did as a replayable markdown recipe (fenced annotated
command steps, no DSL). Replays run the recipe; failures escalate to an
agent turn seeded with the recipe + failure output. Recipes rot; the agent
fallback is the feature, the recipe is the cache. V1 targets scriptable
setups; capture-what-happened over guaranteed-boot.

## Explicitly not building

- A required always-on daemon/server/VPS — origins carry code and WIP; the
  mirror carries the rest.
- A dependency on upstream's invite-gated T3 Connect service (kept open as
  one possible M7 backend).
- An E2E encryption layer in v1 (mandatory in M7 before any cloud backend).
- A custom content-addressed file-sync engine — shadow refs over git.
- Native provider-session transfer — briefs + rebuild instead.
- Cross-machine replication of the internal orchestration event log.
- A general branch auto-puller — sync follows the peer's checked-out state
  only.

## Milestones

Strictly ordered. Done milestones are one line here; results and landed
detail live in the history and reference files.

| # | Scope | Status / exit criteria |
|---|-------|------------------------|
| M0 — Pre-flight | Origin hidden-refs spike, server-to-server auth spike, two-instance harness. | ✅ 2026-07-04 — both GO. |
| M1 — Blob store + mirror + registry | D0–D4 + registry blobs + roaming rows in shell/UI. | ✅ 2026-07-04. |
| M2 — Vault + materialize | Steps 2 + 3 + product-model UI. | ✅ 2026-07-05 (shipped a pairing deviation; corrected in M2.5). |
| M2.5 — Unified pairing (corrective) | One pairing = attach + mirror credential + sync-options step; no separate sync concept. | ✅ 2026-07-06. |
| M3 — WIP snapshots | Capture + transport (origin refs / bundle fallback) + restore in materialize + consent row. | ✅ 2026-07-07. |
| M3.5 — Sync completion | Auto-apply delivery, fs-watch capture, freshness beacon, shutdown snapshot, t3sync manifests, size guards. | ✅ 2026-07-07. |
| M3.6 — Field round 2 | Vault delivery on arrival, based-on fast-forward, sync visibility (blockedReason + pill). | ✅ 2026-07-07. |
| M3.7 — Sync hardening | Per-file WIP merge, two-machine deletion model, sync pill data path, title propagation, vault interval backbone, watcher budget, mirror/wait long-poll, delivery-latency exit criteria. | ✅ 2026-07-10. |
| M3.8 — Branch-aware sync model (SHIP GATE) | Full working-state snapshots, ancestry classifier, safe HEAD transitions, parking/takeover, branch-aware materialize. | ✅ 2026-07-11. |
| M4 — Takeover + divergence | Leases, activity chips, full takeover UX, diff-and-choose divergence. | Takeover applies newest snapshot and moves the lease; two-sided divergence shows diff-and-choose; the losing side stays recoverable. Canonical re-run. |
| M5 — Briefs + transcripts | Step 7 + "Conversations" pairing row. | Threads from A readable on B; park produces an editable brief; resume seeds a new local thread. Canonical re-run. |
| M6 — Bootstrap recipes | Step 4; analysis pass scopes honest limits first. | First materialize triggers an agent setup thread that writes a recipe; second replays it; a broken recipe escalates. Canonical re-run. |
| M7 — Cloud store backend (gated) | E2E encryption (key-management one-pager is the entry gate) + a cloud `RoamingBlobStore`. Re-asks secrets consent. | Small state reaches a fresh machine with zero overlap; a test asserts the cloud holds ciphertext only. |

## Execution process

**Branching (fork discipline):** `main` tracks upstream; never merge roaming
into it. All work lands on `feature/roaming` via small topic-branch PRs
(`roaming/<slug>`, squash-merged), one per seam. Rebase `feature/roaming`
onto `main` at milestone start and after large upstream syncs. Treat any
edit to an existing upstream file as a cost to minimize and isolate.

**Feature flag:** everything behind the `roaming` server setting; reactors
start unconditionally and no-op while it is off.

**Per-milestone loop:**
0. Re-read the Canonical workflow. Restate the milestone as a delta against
   its four steps; if it can't be expressed that way, correct this document
   before coding.
1. Analysis pass — re-validate the plan's assumptions against the current
   code and the canonical workflow; record deviations by editing this
   document first.
2. Contracts PR first — schemas reviewed hardest, everything types against
   them.
3. Implement along seams — server reactor / blob store / client-runtime /
   web UI as separate PRs. Well-specced pieces are delegation candidates;
   judgment-heavy UX is not.
4. Review every PR independently of its author; mirror auth and
   reconciliation code gets the highest effort.
5. Milestone acceptance — exit criteria on the M0 harness end-to-end,
   including the canonical workflow itself.
6. **Document hygiene (the three-file contract):** this plan stays lean and
   current-state — update the Status line, the affected design sections, and
   the milestone row; put mechanics (schemas, refs, invariants, scripts)
   in the reference file; move results, narratives, and superseded text to
   the history file. Never let status blockquotes, PR lists, or acceptance
   results accrete here — that is what the 2026-07-11 restructure cleaned
   up.

## Kickoff prompt

Each milestone runs in a fresh thread. Paste (substitute the milestone):

> Read `.plans/21-roaming-workspace.md` in full — the Canonical workflow
> section first and last — and skim `.plans/21-roaming-reference.md` for the
> current mechanics. Execute milestone M<N> only. Start with the analysis
> pass: verify the plan's assumptions for this milestone against the current
> code AND the canonical workflow; update the plan with any deviations
> before implementing. Work on `feature/roaming` (rebase onto `main` first),
> small PRs per seam, everything behind the `roaming` flag. Finish by
> running the milestone's exit criteria on the M0 harness end-to-end —
> including the canonical workflow — then apply the document-hygiene step
> (plan lean, mechanics to reference, narrative to history). Do not start
> the next milestone.
