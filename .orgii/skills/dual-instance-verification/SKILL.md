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

1. **Cloud ground-truth ledger.** Snapshot the org's `cloud_sessions` (session_id,
   deleted_at, access_mode, events_count, events_frozen_seq, stored_bytes) BEFORE
   and AFTER every scenario, via service key. Diff must be explainable
   line-by-line. Any unexplained `deleted_at`, access_mode downgrade, or
   events_count drop is a FAILURE even if the UI looks fine.
   (Would have caught: vanished-sweep mass retract, boot out-of-scope retract.)

2. **Destructive-verb audit at INFO level.** After each scenario AND after each
   app boot, grep both instances' frontend+backend logs for
   `retract|untag|drop|delete|demote|evict|vanish|superseded` at ALL levels, not
   just WARN/ERROR. Every hit needs a justification. Destructive actions wearing
   legitimate INFO wording are exactly how retract bugs hid.

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

8. **Resource three-piece stays.** cmd+5/Activity Monitor curves (idle ≈0%,
   RSS returns to baseline), feature signals, and WARN/ERROR delta with each new
   line triaged. This skill ADDS to it; it does not replace it.

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
