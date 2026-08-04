# Invariant and Determinism Cells

These cells are mandatory for every dual-instance verification run. They catch
silent surplus actions that presence-only foreground checks cannot see.

## Two-boot determinism

With local state unchanged, cold-boot the instance twice and let sync passes run.
Boot 2 must produce zero epoch rewrites and zero destructive-effect hits. Boot 1
may re-anchor once after a legitimate format/order change, but every rewrite must
be explained as exactly-once.

## Absence requires liveness

Pair every "zero X" claim with a mover proving the engine ran over the rows in
question: `events_count`, `updated_at`, or an explicit pass counter. Deferred or
skipped sessions are uncovered, not passing.

## Fault injection

Run at least one degraded-state cell per verification. Rotate among moving a
local source database mid-read, blocking identity lookup, and terminating the app
mid-transfer. The system must defer or refuse destructive work under the fault.

## Upgrade compatibility

When a change reads durable state written by an earlier build, run the old
build over the same data homes first, then replace only the binary with the new
build and continue. Cover push cursors, cache metadata, parser output, settings,
and any other persisted input the change consumes. The new build must take the
ordinary incremental path without an epoch rewrite, refusal, or silent
re-derivation; then run a second new-build write/read cycle to prove idempotence.

Fresh-state fixtures created only by the new build do not cover migration. Also
verify second-order persistence: lineage stamps or other metadata written by the
new build must survive its next scan or rescan instead of being erased by a
later writer.

## Unexplained deltas

Promote the first unexplained ledger delta, log line, resource pattern, or
store-versus-UI discrepancy to a scenario in the current run. Do not close it as
"background noise" or defer it without a mechanism-level verdict.

## Baseline attribution

Baseline A/B establishes attribution, not correctness. Record separately:

1. whether the current PR caused the symptom; and
2. whether the symptom is a defect or expected behavior, with the mechanism.

If the local store contains rows while the UI renders none, treat the mismatch as
a defect until the command and filter responsible are identified.
