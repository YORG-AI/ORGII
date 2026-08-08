---
name: dual-instance-verification
description: Dual-instance (双机) real-machine verification protocol for ORG2 cloud sync and session sharing. Use before declaring any sharing/sync/collab feature or fix "verified": share/unshare, push/retract, fork/import, comments, member-floor, replay, continuation, or anything touching Org2CloudSyncEngine, collab engines, or the session channel pipeline. Also use when a sharing bug escaped earlier testing, to check which discipline below was skipped.
---

# Dual-Instance Verification (双机实测)

Real-machine verification of session sharing across ORG2 (primary, Neonforge) and
ORG2 Instance 2 (VantaNode). Born from a four-bug escape on 2026-07-24 where every
bug passed the old three-piece check (resource curves + feature signals +
WARN/ERROR delta). The disciplines below exist because each one, applied that day,
would have caught at least one escaped bug.

## Core principle

**Assert invariants, not absence of errors.** A scenario passes only when the
positive end-state is proven on THREE surfaces — sender instance, receiver
instance, and the cloud rows — and every state mutation in between is explainable.

## Non-negotiables

1. **Cloud ground-truth ledger — fleet-wide, invariant-based.** Snapshot
   `cloud_sessions` (session_id, deleted_at, access_mode, events_count,
   events_frozen_seq, events_epoch, stored_bytes) BEFORE and AFTER every
   scenario, via service key — for EVERY org the instances can see, not just the
   org under test. Diff must be explainable line-by-line, and "explainable"
   means a verified mechanism, not a plausible story ("that session is active"
   is a story; "its rollout grew by N lines, here they are" is a mechanism).
   On top of the diff, assert invariants: for every session the scenario did
   NOT deliberately touch, `events_epoch` is CONSTANT and `events_count` is
   monotone; flag any row with `events_epoch` above a small threshold (>3)
   anywhere in the fleet. Any unexplained `deleted_at`, access_mode downgrade,
   events_count drop, or epoch bump is a FAILURE even if the UI looks fine.
   (Would have caught: vanished-sweep mass retract, boot out-of-scope retract,
   and the #608 rewrite storm — a 28-epoch counter sat in this column for weeks
   while diffs on the test org alone stayed clean.)

2. **Destructive-effect audit at INFO level — classify by effect, not verb.**
   After each scenario AND after each app boot, grep both instances'
   frontend+backend logs for
   `retract|untag|drop|delete|demote|evict|vanish|superseded|epoch rewrite|rewrite`
   at ALL levels, not just WARN/ERROR. Every hit needs a justification. The
   audit's unit is "anything that replaces or deletes cloud bytes" — a full
   epoch rewrite re-uploads and REPLACES the entire stored copy and is more
   destructive than a retract, yet it wears routine INFO wording and matches no
   scary verb. When new log lines gain the power to mutate cloud rows, add them
   to this list in the same PR.

3. **Lifecycle-boundary cells are mandatory.** The matrix is feature ×
   lifecycle-event, not feature × instance. For every sharing feature, run at
   minimum these transition cells:
   - **Cold boot**: relaunch each instance, then audit the FIRST 3 sync passes'
     cloud mutations (ledger diff + verb audit). Boot-window races (empty scope
     mirror, unrefreshed token, rebuilding cache) must never be treated as
     authoritative absence.
   - **/compact mid-share**: continue a shared session into a continuation
     sibling; the cloud row must survive (not retract) and sharing must carry on.
   - **Cache wipe/rebuild**: wipe imported-history cache, boot, confirm zero
     retracts during rebuild (two-strike must defer).
   - **Fork-on-write**: owner-side AND guest-side, with a real (small) agent run.
     Assert the fork's cloud row access_mode equals the inherited level, events
     and frozen segments actually land, and the receiver can OPEN the replay
     (bright row + content renders). "Row appears in the list" is NOT success —
     a metadata-only ghost also appears.

4. **Watchdog/fallback fires are test failures.** Any
   `usePlanningIndicator watchdog`, dead-man, forced-idle, or retry-exhausted
   line during a scenario fails that scenario, even though the UI self-heals.
   Self-healing masks the bug it recovers from. Turn-completion latency must be
   asserted: terminal reaches the UI within 5s of Rust `state=Completed`.

5. **Receiver-depth assertions.** On the receiving instance: open the shared/fork
   row, confirm content renders, and for replay confirm the latest round matches
   the sender's last round verbatim. Grayed-out rows must be explained by an
   asserted access mode, never shrugged off.

6. **Both directions.** Each cell runs A→B and B→A where roles permit. Guest-side
   limitations (e.g. no API key on inst2) mean the cell moves to the other
   instance, not that it gets skipped. If a cell is skipped for cost, record it as
   UNCOVERED in the delivery message — the 2026-07-24 fork bugs lived in exactly
   such a silently skipped cell.

7. **Silent early-returns need a diagnostic.** When touching sync/channel/handler
   code: any `return` that swallows a lifecycle-relevant frame or skips a push
   must have a rate-limited log. The four-bug escape survived five instrumentation
   builds only because `bus dispatch`, `waitForSessionChannelReady`,
   `routeSessionChannelEvent`, `handleEvent(_disposed)`, and the runtime-status
   gate all dropped silently. Those five now log; keep that bar for new code.

8. **Resource three-piece stays — and anomalies are defects until mechanized.**
   cmd+5/Activity Monitor curves (idle ≈0%, RSS returns to baseline), feature
   signals, and WARN/ERROR delta with each new line triaged. This skill ADDS to
   it; it does not replace it. A recurring resource anomaly (a CPU wave on
   every boot, RSS that climbs per pass) must open an investigation cell — it
   may NOT be closed with a narrative. The #608 storm's boot-time CPU wave was
   observed, named "ingest re-hash convergence", and normalized; the re-hash
   WAS the bug. Naming an anomaly is not explaining it.

## Invariant & determinism cells (mandatory additions per run)

Born from the 2026-07-30 reflection on why #608 (rewrite storm), the hollow
wipe, and the scope flap all survived multiple live rounds: the protocol
asserted presence (the tested flow works) while these bugs were silent surplus
actions in the background, invisible to every existing cell.

- **Two-boot determinism cell.** With local state unchanged, cold-boot the
  instance twice and let sync passes run. Boot 2 must produce ZERO epoch
  rewrites and zero destructive-effect hits (boot 1 may re-anchor once after a
  legitimate format/order change — each such rewrite must be explained as
  exactly-once). Nondeterminism bugs are per-process (HashMap iteration order,
  random seeds); a single boot cannot sample them by construction. Measured
  cost: ~18 minutes wall clock, mostly unattended.
- **Absence needs liveness beside it.** Any "zero X since the fix" claim must
  pair the constant (epoch, deleted_at) with a mover (events_count,
  updated_at, pass counters in the log) proving the engine actually ran over
  the rows in question. Deferred/skipped sessions (e.g. scope-guard deferrals)
  are UNCOVERED, not passing.
- **At least one fault-injection cell per run.** Healthy instances sample only
  the happy path; the hollow wipe (empty local read while cursor covers >0)
  and the scope flap (transient GitHub identity failure) lived exclusively in
  degraded states no healthy-path cell can reach. Rotate through: rename/move
  a local source DB mid-run (hollow read), block the identity endpoint
  (lookup failure), kill the app mid-transfer (partial persist). The guard
  under test must defer/refuse — any destructive act under injected fault is
  a failure. When the change ADDS a fault point (a new read, probe, or IPC
  call), inject THAT fault — the rotation list only covers yesterday's
  failure modes.
- **Upgrade cell: persisted state must cross the version boundary.** Any
  change that reads durable state written by earlier builds (push cursors,
  cache metadata, parser output, settings) gets one cell where the OLD build
  writes the state and the NEW build operates on it: run a pre-change binary
  (a dated `org2-main.exe` or a develop build) through the flow first, then
  swap binaries over the SAME homes and continue. Assert the new build rides
  the ordinary incremental path — no epoch rewrite, no refuse, no silent
  re-derive — and that a second cycle (new build writes, new build reads)
  is idempotent. A fresh-anchor test with only the new binary proves nothing
  about migration: PR #692's costliest bug (every legacy flat cursor forced
  an O(total) epoch rewrite) was invisible to every run that built its state
  with the new code. Second-order cycles count too: state the new build
  STAMPS must survive the new build's own next scan/rescan before the
  invariant is real (PR #693's lineage stamp was erased by the very next
  rescan's metadata rewrite).
- **Unexplained delta becomes a cell.** The first ledger delta, log line,
  resource pattern, or store-vs-UI discrepancy without a mechanism-level
  explanation is promoted to a scenario in the CURRENT run — not noted for
  later, and not handed to a background task. "Background sync noise" is the
  phrase that hid a data-destroying storm; "pre-existing behavior" is the
  phrase that hides everything the current PR did not happen to cause.
- **Baseline A/B answers attribution, not existence.** Reproducing a symptom on
  the develop baseline proves the PR under test did not CAUSE it. It proves
  nothing about whether it is a bug, and it is not a disposition. Write the two
  conclusions on separate lines — attribution (this PR / not this PR) and
  verdict (defect / expected, with the mechanism) — and never let the first
  supply the second. A symptom that survives A/B is either explained
  mechanically in this run or recorded as an OPEN DEFECT with its evidence in
  the delivery message; deferring it to a chip is the same escape as "noted for
  later" above. Corollary signature: **the local store holds N rows and the UI
  renders 0** is always a defect — chase it to the command and the filter that
  ate the rows before moving on, because the two ends disagreeing is itself the
  mechanism-level question. (2026-08-01: instance-2's sidebar OLDER section
  rendered zero imported rows while `imported_history_session_cache` held 257
  cursor_ide rows. A/B correctly cleared PRs #628/#576 of causing it; the
  symptom was then downgraded to a background chip and is STILL unexplained as
  of 2026-08-03, including after the unrelated #654 import-parse regression was
  ruled out as its cause.)

## Ledger commands

Service key lives in `tests/e2e/.env` (machine-local). Snapshot:

```bash
set -a; source tests/e2e/.env; set +a
curl -s "$E2E_CLOUD_SUPABASE_URL/rest/v1/cloud_sessions?org_id=eq.<ORG>&select=session_id,deleted_at,access_mode,events_count,events_frozen_seq,stored_bytes,updated_at&order=session_id" \
  -H "apikey: $E2E_CLOUD_SERVICE_KEY" -H "Authorization: Bearer $E2E_CLOUD_SERVICE_KEY" \
  -H "Accept-Profile: org2_cloud"
```

Diff the before/after JSON; explain every changed row. Logs live at
`~/.orgii/logs/` and `~/.orgii-instance2/logs/` — backend files are UTC-dated and
UTC-stamped, frontend files local-stamped; sweep BOTH around the UTC midnight
rollover or the window silently truncates.

## Failure taxonomy (what escaped and why — keep this list growing)

- **Boot-window absence treated as authority**: empty scope mirror / rebuilding
  cache / unrefreshed token read as "gone" → retract. Guard: grace period or
  two-strike before any destructive act on boot-adjacent passes.
- **Continuation demotion read as deletion**: /compact demotes the old sibling;
  exact-id lookups report it absent by design; sweeps must use the
  superseded-inclusive lookup.
- **Defaults silently degrading shares**: a fork with no sharing-ladder entry
  floors to metadata_only and nobody errors. Assert access_mode on the wire.
- **Self-healing hiding lost signals**: watchdog-forced completion masked every
  lost agent:complete. Assert latency, treat watchdog as failure.
- **A guard upstream of every probe**: the subagent bridge swallowed fork
  terminals before any instrumented drop point ran, so nine instrumented
  builds all stayed silent. When probes disagree with the symptom, suspect the
  model of WHERE the loss happens, not a missed branch — walk the call path
  from its first line, not from the suspected failure.
- **Format drift on a shared field**: `Session.orgId` is a scope selector
  (`cloud:<uuid>`); fork/import wrote a bare uuid, silently removing every
  ownership-derived affordance. When one writer of a shared field disagrees
  with the rest, diff the live values across rows — the odd one out is the
  bug.
- **Tests that encode the bug**: the two specs guarding the ownership stamp
  asserted the bare form, comment included. Green tests are not evidence the
  convention is right; check a spec's expectation against the consumers before
  trusting it.
- **Fixture writes that silently failed**: a direct PATCH on a
  write-hardened table (403 — governance requires the admin RPC) surfaced as
  an empty response body, was read as success, and a whole debugging night ran
  on the false premise that the scope existed server-side. Every mutation of
  test-environment cloud state MUST be followed by a read-back of the same
  row (compare `updated_at`, not just the field). A stale local mirror is not
  server truth either — when a UI decision depends on mirrored state, diff
  mirror vs server before blaming the consumer code.
- **The running binary lags the fix**: the "verified" build predated the
  final commit of the file under test; every on-device probe for 40 minutes
  exercised stale code. Before declaring an on-device verdict, compare the
  bundle mtime against the fix file's mtime — an edit made after the last
  build is not on the device, no matter how green the tests are.
- **A feature unreachable from the surface it was designed for**: Address
  Comments' run path is fork-first BY DESIGN for imported histories, but that
  composer mounts session-scope "none", and every consumer in the chain
  (slash registry, submit interceptor) re-resolved the blank id and silently
  no-opped. Reachability must be verified from the surface the design names.
  Same family: candidate ordering picked a scope-matching org with no server
  row (GitHub rename made two spellings one repo network), and the fork guard
  demanded snapshot == summary while a LIVE source kept growing — equality
  checks against a moving target are boot-window absence in another costume.
- **A silence that proves nothing**: "zero rewrites since the fix" was true
  while the session was not being pushed at all (machine slept, ingest
  follows the open view). An absence metric needs a liveness metric beside
  it: assert the thing you want CONSTANT (ledger epoch) against the thing
  that must still be MOVING (events_count / updated_at). Same shape as
  watchdog-masked completion — silence and health look identical until you
  measure both.
- **Presence oracles miss surplus actions**: every cell asserted "the thing I
  did worked"; the escaped bugs were things NOBODY did — silent rewrites,
  silent retracts, a silent wipe — that break no foreground flow. The fleet
  ledger's invariant columns (epoch constant, count monotone) are the only
  surface where surplus actions are visible at all.
- **Per-process nondeterminism is invisible to single-boot runs**: HashMap
  iteration order reshuffled an unchanged transcript's flushed tail on every
  boot, and positional chunk ids turned the shuffle into a fresh hash chain
  each time. Within one app lifetime everything looked stable; only
  boot-vs-boot comparison of push decisions could see it. (#608 root cause.)
- **Fresh-state runs cannot see migration bugs**: every cell that builds its
  own state with the binary under test samples only the post-change state
  space. Bugs that live in the TRANSITION — legacy cursor meets new hash
  mode, old parser rows meet new election, stamped metadata meets the next
  rescan — need the upgrade cell above. The tell is a verification report
  whose every artifact was created during the run itself.
- **"Pre-existing" used as a verdict**: a symptom reproduces on baseline, is
  correctly cleared of THIS PR's authorship, and is then silently cleared of
  being a bug at all — because the run's attention is scoped to the PR, and
  attribution is the only question the run was asking. Nothing in the protocol
  catches this: every other discipline here fires on something the run DID,
  while this one fires on a verdict the run declined to reach. The tell is a
  finding whose write-up names the PR it exonerates but never names a
  mechanism.
- **Waiting for a pass the engine will never run**: the session plane follows
  visible-org demand — an org's push/retract pass runs only while that org is
  the active workspace. A fix whose cleanup rides "the next pass" looks
  broken for any org you are not looking at. Per-org verification must OPEN
  the org (switch the workspace to it) as the trigger, and cleanup claims
  must name which orgs were actually visited. Corollary: rows pushed in an
  earlier install/test cycle may have no surviving local push-state, and the
  client rightly refuses to retract what it cannot prove it pushed — those
  need a server-side fixture sweep, not more waiting.

## When NOT to use

Pure UI styling/copy changes, single-file bug fixes with no sync surface, and
Rust-only refactors covered by unit tests that touch no cloud or channel path.
