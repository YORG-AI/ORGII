# Dual-Instance Verification Failure Taxonomy

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
- **Presence oracles miss surplus actions**: foreground flows can pass while
  background sync silently rewrites, retracts, or wipes unrelated rows. Fleet
  invariants are the surface that exposes actions nobody requested.
- **Per-process nondeterminism is invisible to single-boot runs**: unordered
  iteration can produce a different hash chain after every restart while one
  process stays stable. Compare two cold boots with unchanged local state.
- **Fresh-state runs cannot see migration bugs**: fixtures created by the new
  build sample only the post-change state space. Exercise the transition from
  an earlier build's cursor, parser row, or metadata, and verify that stamps
  written by the new build survive its own next scan or rescan.
- **"Pre-existing" used as a verdict**: baseline reproduction answers whether
  the current PR caused a symptom; it does not decide whether the symptom is a
  defect. Record attribution and mechanism-level verdict separately.
- **Waiting for a pass the engine will never run**: the session plane follows
  visible-org demand — an org's push/retract pass runs only while that org is
  the active workspace. A fix whose cleanup rides "the next pass" looks
  broken for any org you are not looking at. Per-org verification must OPEN
  the org (switch the workspace to it) as the trigger, and cleanup claims
  must name which orgs were actually visited. Corollary: rows pushed in an
  earlier install/test cycle may have no surviving local push-state, and the
  client rightly refuses to retract what it cannot prove it pushed — those
  need a server-side fixture sweep, not more waiting.
