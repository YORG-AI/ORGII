---
name: dual-instance-verification
description: Dual-instance real-machine verification protocol for ORG2 cloud sync and session sharing. Use before declaring sharing, sync, collaboration, share/unshare, push/retract, fork/import, comments, member-floor, replay, continuation, Org2CloudSyncEngine, collaboration engine, or session-channel changes verified; also use to investigate sharing defects that escaped prior testing.
---

# Dual-Instance Verification

Verify session sharing across the primary ORG2 instance, the secondary instance, and the authoritative cloud rows.

## Core principle

**Assert invariants, not absence of errors.** A scenario passes only when the
positive end-state is proven on THREE surfaces — sender instance, receiver
instance, and the cloud rows — and every state mutation in between is explainable.

## Non-negotiables

1. **Cloud ground-truth ledger — fleet-wide and invariant-based.** Snapshot
   `cloud_sessions` for every visible org before and after each scenario. Explain
   every delta mechanically; for untouched sessions, require constant
   `events_epoch` and monotone `events_count`. Any unexplained delete, access
   downgrade, count drop, or epoch bump is a failure even when the UI looks fine.

2. **Destructive-effect audit at INFO level.** After each scenario and app boot,
   grep both instances' frontend/backend logs for destructive effects, including
   retract/delete/demotion and epoch rewrites. Classify by effect rather than
   severity or wording, and justify every hit.

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

8. **Resource three-piece stays — anomalies require a mechanism.** Preserve
   cmd+5/Activity Monitor curves (idle ≈0%, RSS returns to baseline), feature
   signals, and WARN/ERROR deltas. A recurring CPU/RSS anomaly is a defect cell
   until it is explained mechanically; naming it is not a disposition.

## Conditional references

- Read [ledger-commands.md](references/ledger-commands.md) when running or recording a real dual-instance scenario.
- Read [invariant-determinism.md](references/invariant-determinism.md) for every verification run; its two-boot, liveness, fault-injection, upgrade-compatibility, unexplained-delta, and baseline-attribution cells are mandatory.
- Read [failure-taxonomy.md](references/failure-taxonomy.md) when diagnosing an escaped defect, designing regression coverage, or checking whether the evidence repeats a known false-positive pattern.

## When NOT to use

Pure UI styling/copy changes, single-file bug fixes with no sync surface, and
Rust-only refactors covered by unit tests that touch no cloud or channel path.
