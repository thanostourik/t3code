# 22 — Roaming review remediation

Status: **draft — awaiting go**
Input: three-reviewer suite run 2026-07-22 against `git diff main...feature/roaming`
(post-rebase, typecheck clean, full test suite green): general correctness
(fable-5), simplification (opus-4.8), over-engineering audit (fable-5).
Convention: every phase is a topic branch `roaming/<slug>` PR'd into
`feature/roaming`, squash-merged. Phases are ordered so that behavior fixes land
before refactors that would churn the same files.

## Finding inventory → phase map

| ID | Finding (source) | Phase |
|----|------------------|-------|
| G1 | `roamingWipSync` missing from `ServerSettingsPatch` — UI consent toggle silently dropped (general, major) | 1 |
| G2 | Equal-version blob conflict → unthrottled mirror hot loop (general, major) | 3 |
| G3 | `takeover`/`resolveDivergence` mutate worktree outside the keyed worker (general, major) | 4 |
| G4 | Synced vault file cannot be deleted — two-machine resurrection (general, major) | 5 |
| G5 | Roaming live pubsubs attach after catch-up drain; publish in window lost (general, minor; partly a rebase regression) | 2 |
| G6 | `hasActiveTurnByProjectIdQuery` missing `deleted_at IS NULL` — dead-end blocked state (general, minor) | 1 |
| G7 | PeerMirror data-path HTTP has no timeout (general, minor) | 1 |
| G8 | `mintMachineCredential` applies remote syncOptions unconditionally, contradicting contract (general, minor) | 1b |
| — | Stored `roaming` flag is a stale "has ever paired" cache; nothing ever clears it (pre-phase investigation) | 1b |
| G9 | `Materializer.materialize` unguarded per-project concurrency (general, minor) | 4 |
| G10 | Raw NUL byte makes `PeerMirror.ts` binary to git (general/self, minor) | 1 |
| S1 | `restoreWip` duplicates `selectNewestPeerSnapshot` (~100 LOC) (simplify) | 6 |
| S2 | shellReducer keyed upsert ×3 (simplify) | 6 |
| S3 | ws.ts sequence-0 stream scaffold ×3 (simplify) | 2 |
| S4 | Dead `vaultOverrides` + `defaultBranch` in registry contract (simplify + over-eng) | 3 |
| S5 | `roaming-project-removed` event defined/reduced/tested, never emitted (simplify) | 3 |
| S6 | "strip blocked fields" destructure ×2 in reactor (simplify) | 6 |
| S7 | Two `streamDomainEvents` subscriptions per reactor (simplify) | 6 |
| S8 | WIP-blob manifest scan ×3 (simplify) | 6 |
| S9 | Temp-index + commit-env recipe ×3 (simplify, medium risk) | deferred |
| S10 | `readGitContext` reimplemented inline in poll (simplify) | 6 |
| S11 | `projectEntities` flatten memo ×3 (simplify, low priority) | deferred |
| O1 | Blob-conflict get/resolve API has zero UI callers; Sidebar tooltip points at nonexistent surface (over-eng) | 3 |
| O2 | Speculative blob kinds `recipe`/`transcript`/`brief` (over-eng) | 3 |
| O3 | = S4 | 3 |
| O4 | Materializer persisted resume machinery exceeds need, caused its own field bug (over-eng) | 7 |
| O5 | Classifier re-derives provenance in six guards → one computed peer-relationship (over-eng + 2026-07-15 audit) | 8 |
| O6 | Acceptance scripts duplicate ~60-line harness plumbing ×10 (over-eng) | 9 |
| O7 | Migration shims sentenced by audit (±1s timestamp heuristic) once field machines cycle (over-eng) | deferred |
| — | Dual WIP transport / Tern-throwaway layer: **no action** — do not deepen before the M7 decision | guidance |

## Pre-phase finding: the stored `roaming` flag is redundant — replace it with a derived gate

Investigated 2026-07-22. The *gate* is real and required: seven live sites
no-op the subsystem while roaming is off — roaming HTTP routes 404
(`roaming/http.ts:126`), ws shell masking/overlay seeding (`ws.ts:1242`),
HTTP shell snapshot masking (`orchestration/http.ts:69`), VaultSync
sweep+delivery (×3), WipSnapshotReactor passes (×2, AND'd with
`roamingWipSync`), RoamingAutoEnroll passes + its settings-change wake filter.
That gating keeps every reactor inert on a fresh, un-paired install and stays.

But the *stored setting* `ServerSettings.roaming` is a redundant — and stale —
cache of "has this machine ever paired": pairing sets it `true`
unconditionally, nothing anywhere sets it back to `false`, no UI reads or
writes it. Once paired, the subsystem runs forever even after the last peer is
removed. Decision (owner, 2026-07-22): **delete the stored flag and derive
`roamingEnabled` from "at least one peer exists"** — auto-on at first pairing,
auto-off when the last peer goes, no second source of truth to rot. The sync
checkboxes are unaffected: they set the two independent consent flags, which
every consent site AND's on top of the master gate (`hasPeers &&
roamingSecretsSync`, `hasPeers && roamingWipSync`), so pairing without sync
consent works exactly as today. Trade-off accepted: the flag can no longer act
as a manual "pause roaming without unpairing" kill-switch — nothing uses that
today. Implemented in Phase 1b.

## Phase 1 — `roaming/small-fixes`: independent one-liners and consent fixes

All small, independent, no design decisions.

- **1a (G1)** Add `roamingWipSync: Schema.optionalKey(Schema.Boolean)` to
  `ServerSettingsPatch` (`packages/contracts/src/settings.ts:545-547`).
  Test: decode a patch containing both consent keys and assert neither is
  stripped (this is the regression that made the toggle a no-op). The
  `roaming` key itself is removed from the patch schema in Phase 1b.
- **1b (G10)** Replace the raw NUL in `PeerMirror.ts` `manifestKey` with the
  `"\0"` escape. Confirm `git diff` renders the file as text afterward.
- **1c (G6)** Add `pt.deleted_at IS NULL` to `hasActiveTurnByProjectIdQuery`
  (`apps/server/src/persistence/Layers/ProjectionThreads.ts:149-161`), matching
  its siblings. Test: soft-deleted thread with a lingering `active_turn_id`
  session no longer reports the project busy.
- **1d (G7)** `Effect.timeout` (30s) on PeerMirror `postJson` data-path calls
  (manifest/fetch/push), mapped to the existing per-pass failure handling so a
  black-holed base URL degrades to a logged failed pass instead of stalling the
  drain loop for minutes and hanging `syncNowAndWait` callers.

Verify: typecheck + focused unit tests.

## Phase 1b — `roaming/derive-roaming-gate`: delete the stored flag (pre-phase finding, G8)

Own branch — touches the pairing flow, the contract, and all seven gate
sites, so it should not hide inside the one-liner batch.

- **1b-a** RoamingService maintains an in-memory `hasPeers`
  (`SubscriptionRef<boolean>`, seeded from the peers table at startup, updated
  in `addPeer`/`removePeer`) exposed as the subsystem's single
  `roamingEnabled` accessor, so hot paths (every `subscribeShell`, every
  reactor pass) pay no DB read.
- **1b-b** Switch the seven gate sites from `settings.roaming` to the derived
  accessor. `RoamingAutoEnroll`'s settings-change wake filter
  (`RoamingAutoEnroll.ts:258`) becomes a subscription to peer changes.
- **1b-c** Pairing stops writing `roaming: true`
  (`RoamingService.ts:571-581, 622-632`). Remove `roaming` from
  `ServerSettings`, `ServerSettingsPatch`, and `DEFAULT_SERVER_SETTINGS`
  (`contracts/src/settings.ts:420-424, 545`). `Schema.Struct` ignores unknown
  keys on decode, so existing settings rows carrying the key still parse; no
  migration.
- **1b-d (G8)** Re-key the consent rule in `mintMachineCredential`: apply
  received `syncOptions` only when this machine has **no peers yet** (first
  pairing); an explicit prior choice is never overridden by a re-pair. Update
  the contract doc (`contracts/src/roaming.ts:617-623`), which currently words
  the rule as an off→on transition of the now-deleted flag. Test: paired
  machine with `roamingWipSync: false` receives a re-pair with wip enabled →
  stays false.
- **1b-e** Sweep the acceptance scripts and tests for direct
  `roaming: true` settings writes (harness setup may enable the flag without
  pairing); convert them to real pairing or a peer-record fixture.

Verify: typecheck + unit tests, then the two-instance harness: fresh instances
→ subsystem inert; pair (no sync boxes) → registry/materialize baseline active,
vault+WIP off; remove last peer → all gate sites off again (routes 404,
snapshot masked); re-pair with sync boxes checked on a machine that previously
declined → consents stay declined (1b-d).

## Phase 2 — `roaming/ws-live-attach`: close the resume delivery gap (G5, S3)

One file (`apps/server/src/ws.ts`), one behavior fix plus the cleanup that
touches the same lines.

- **2a (G5)** Attach the three roaming source streams eagerly, the same way
  domain events are handled: fork each into the scope-bound buffer (or a
  sibling scope-bound queue) *before* `loadSnapshot`/catch-up runs, so a
  materialization/WIP/registry publish during a warm-resume replay is buffered,
  not dropped. Note the pre-rebase code had a narrower window on the resume
  path; the 2026-07-22 rebase widened it — this closes it fully for both the
  cold and resume paths, which the old code never did.
- **2b (S3)** While in there: collapse the three
  `Stream.unwrap(subscribe → fromSubscription → map)` scaffolds into one local
  helper; replace the nested `Stream.merge` chain with a single merge-all.

Verify: server unit tests incl. the upstream coalescing suite (must stay
green — the overlay-seed ordering assertions encode the wire contract), plus a
targeted test: publish a materialization update while a resume catch-up is
draining, assert delivery.

## Phase 3 — `roaming/conflict-surface`: hot loop + dead API + dead contract surface (G2, O1, O2, S4, S5)

One coherent overhaul of the registry-blob conflict story. Decision D1
resolved (owner, 2026-07-22): delete the API, auto-resolve newest-wins with a
notice.

- **3a (G2)** Independent of the resolution model, stop the loop mechanically:
  `applyRemote` must not republish an already-recorded identical conflict
  (compare against the stored conflict record before `publishChange`), and
  `diffManifests` must not re-queue a known-conflicted key into `toFetch` on
  every pass. Test: simulate the equal-version/different-hash pair, run
  multiple mirror passes, assert exactly one conflict record, one publish, no
  further fetches.
- **3b (O1, D1: decided)** **Delete the conflict get/resolve API** (both
  routes in `roaming/http.ts`, both client functions, the four schemas) and
  resolve registry-blob conflicts automatically: newest `updatedAt` wins,
  loser preserved in the conflict record, surfaced as a dismissible notice on
  the project row (registry blobs carry titles/prefs — low stakes; the
  2-machine reality does not justify a manual resolution surface the UI never
  built). **3c**: replace the Sidebar conflict tooltip (it currently points at
  a "sync details" surface that doesn't exist) with the notice presentation.
- **3d (S4/O3)** Delete `RoamingVaultOverrides` (retired 2026-07-07), its empty
  write at `RoamingService.ts:181`, and the never-written/never-read
  `defaultBranch` field. `Schema.Struct` tolerates unknown keys on decode, so
  blobs minted by pre-fix machines still decode; no migration.
- **3e (O2)** Remove speculative blob kinds `recipe`/`transcript`/`brief` from
  `RoamingBlobKind`; they return with their milestones' contracts PRs, where
  the process says contracts get written.
- **3f (S5)** Delete the never-emitted `roaming-project-removed` shell event
  (contract variant, reducer branch, reducer test) — the decided newest-wins
  model does not emit it.

Verify: typecheck, unit tests, then the two-instance harness: create the
conflict (concurrent rename while apart → reconnect), assert no hot loop
(watch mirror pass logs), assert newest-wins resolution + notice end-to-end.

## Phase 4 — `roaming/serialize-mutations`: worktree and materialize races (G3, G9)

- **4a (G3)** Route `takeover` and `resolveDivergence` worktree mutations
  through the same per-project keyed coalescing worker as regular passes so a
  `reset --hard`/`clean -fd` can never interleave with a concurrent capture or
  per-file apply. Preserve the existing behavior that the shutdown finalizer
  bypasses the worker (fibers already interrupted there). Watch the UX
  constraint from #71: keep-local must still clear the pill before the resolve
  call returns — the worker hand-off must not reintroduce that latency.
- **4b (G9)** Serialize `Materializer.materialize` per `workspaceProjectId`
  (in-memory keyed lock or the same worker utility): a second concurrent
  request for a project already materializing awaits/attaches to the running
  one rather than racing a second clone and a second `project.create`.

Verify: unit test for 4b (two concurrent materialize calls → one clone, one
project). 4a: acceptance `accept-m4.mjs` (takeover/divergence paths) plus a
stress rerun of `accept-m37-stress.mjs`; per the harness memory: fresh state,
scripts and logs under /tmp.

## Phase 5 — `roaming/vault-tombstones`: deleting a synced secret must stick (G4)

Design (small, inside the existing bundle format): the vault bundle gains
per-file tombstones. Capture: when the previous bundle version contained a file
that is now locally absent, record `{ path, deletedAt }` instead of silently
shrinking the file set. Delivery: a tombstone newer than the local file's
last-synced state deletes the local copy (move to a `.t3/trash`-style holding
dir rather than unlink, consistent with the branch's deletion-recoverability
lock-in from M3.6); a tombstone for a file the peer re-created *after* the
tombstone's `deletedAt` is ignored. Capture no longer re-ships a file that the
current blob tombstones unless its mtime is newer than `deletedAt` (that is the
"user re-created it, it lives again" path). Old bundles without tombstones keep
today's semantics.

This is the one Phase that changes sync semantics for secrets, so it gets the
full treatment per the E2E verification memory: two-instance harness delete/
re-create/both-sides matrix, then the applicable acceptance ladder before
merge. Surface every tombstone application as a notice (secrets deletions must
never be silent).

## Phase 6 — `roaming/simplify-seams`: behavior-preserving dedup (S1, S2, S6, S7, S8, S10, S12)

Strictly no behavior change; each item verified by existing tests.

- **6a (S1+S8)** Extract the shared fetch+import+select+validate core from
  `selectNewestPeerSnapshot` and have `Materializer.restoreWip` consume it.
  Constraint from the review: materialize's granular notice strings
  ("undecodable work-in-progress blob…", "bundle from X did not apply", legacy
  branch-context notice) must survive — extend the selector to surface per-blob
  notices rather than flattening them. Include the shared `listWipPayloads`
  manifest-scan helper (removes the third copy in `WipShared.payloadForCommit`).
- **6b (S2)** `upsertByWsid` helper in `shellReducer.ts`; three branches become
  one-liners.
- **6c (S6)** `clearBlockedFields(entry)` helper in the reactor; both
  destructure sites call it (closes the "field added in one site, forgotten in
  the other" bug class).
- **6d (S7)** One `streamDomainEvents` subscription per reactor
  (WipSnapshotReactor, RoamingAutoEnroll) dispatching on `event.type`.
- **6e (S10)** Startup poll loop calls `readGitContext` instead of inlining the
  `${branch}\0${headOid}` recipe.
- **6f (S12)** Hoist the duplicated `alreadyMatched` ternary condition in
  `restoreWip` (subsumed by 6a if that lands first).

Verify: typecheck + full unit suite; no acceptance rerun needed (no behavior
change) — but 6a is close to apply semantics, so run `accept-m38.mjs` once as a
belt-and-braces check.

## Phase 7 — `roaming/stateless-materialize` (O4) — D2 resolved: go stateless

Decided (owner, 2026-07-22), per YAGNI and per the field record (the
persistence caused the one recorded materialize bug): drop resume-from-step.
Materialize becomes a
stateless idempotent re-run — clone-if-missing, every step already re-runnable,
progress streamed from memory. `roaming_materializations` table dropped by a
new migration 037 (migration 035 already shipped to field machines; it stays).
The shell's materialization status entries then derive from live runs only;
"completed" is observable from the project row existing — audit the UI's use of
`roamingMaterializations` for anything that genuinely needs the durable record
before deleting (if the sidebar depends on persisted `completed` entries for
offline rows, keep a minimal completed-marker file in the checkout instead of
the DB machinery). ~250-300 LOC + one failure class removed.

Verify: materialize E2E in the two-instance harness including: kill server
mid-clone → relaunch → re-run succeeds; re-materialize over an existing
checkout is a no-op.

## Phase 8 — `roaming/classifier-relation` (O5) — the big one, last of the behavior-adjacent work

Consolidate the six overlapping provenance guards in `WipApply.ts` into one
computed `PeerRelation` (what has the peer provably seen: based-on state,
ack state, echo class, pin state) consumed by `classifyWipApply`'s decision
table. This is the audit's own recommendation and the largest conceptual
shrink available (−300-400 LOC target; based-on/provenance/causality/echo
become one named idea).

Rules of engagement, per the hardening history: the decision table's
*outcomes* are frozen — every existing invariant test and incident-replay test
must pass unmodified. Add fact-space invariant tests (the audit noted the
suite is replay-heavy, invariant-light) *before* refactoring, so the refactor
is caught by properties, not just replays. Then, per the E2E memory, the full
ladder: m35 → m36 → m37 → m38 → m4 + canonical two-instance walk. No other
phase may share this branch.

## Phase 9 — `roaming/accept-harness-lib` (O6)

Extract `scripts/roaming/harness-lib.mjs` (api/cli/git helpers, login/pairing
cookie handling, fail/pass reporting) and convert the 10 acceptance scripts.
~500-600 LOC; more importantly, pairing/login gotchas get encoded once instead
of re-learned per milestone (M4 history records exactly that). Semantics of
each script are frozen — this is plumbing only. Verify by running the full
ladder once on the converted scripts against a known-good build; per the
harness memory, revise stale accept-script semantics only with their
milestone, not here.

## Deferred (recorded, not scheduled)

- **S9** `withTempIndex` helper — touches the pin/kept-local marker-writing
  paths; fold into Phase 8's branch if convenient, else skip. The
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` overrides must be preserved exactly.
- **S11** `projectEntities` flatten-memo helper — low leverage, atom memo
  semantics easy to get subtly wrong.
- **O7** Migration shims (±1s timestamp heuristic and friends) — cut only once
  both field machines have cycled through current builds; check the audit's
  list at that point.
- **Dual transport / Tern layer** — no investment beyond bugfixes in
  PeerMirror/RoamingPeers/mirror-routes/waiter machinery until the M7
  speak-Tern decision; if Tern is adopted, bundle transport is first to go.

## Decisions (all resolved, owner, 2026-07-22)

- **D1 (Phase 3):** delete the blob-conflict API; registry conflicts
  auto-resolve newest-`updatedAt`-wins, loser kept in the conflict record,
  dismissible notice on the project row.
- **D2 (Phase 7):** stateless idempotent materialize; drop the persisted step
  machine and the `roaming_materializations` table (migration 037).
- **D3 (pre-phase / Phase 1b):** stored `roaming` flag deleted; the gate is
  derived from peer existence.

## Ordering rationale

Phases 1, 1b, and 2 are pure fixes with no open decisions and unblock
nothing — land first (1b before Phase 3, since Phase 3's masking/notice work
should build on the derived gate, not the deleted flag).
Phase 3 removes the ugliest live behavior (hot loop). Phase 4–5
are the remaining correctness items, isolated from each other. Phases 6–9 are
refactors and land after behavior is settled so they never carry a behavior
change hidden inside a cleanup. Phase 8 stays last of the code phases because
it churns the most hardened files and needs the full verification ladder.
