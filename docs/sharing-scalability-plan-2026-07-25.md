# Session Sharing — Scalability / Maintainability Campaign

Branch `codex/sharing-scale-maintain` off develop @ `e47f4b74b` (PR #535 merged).
Correctness matrix is green (14 fixes, dual-instance verified); this campaign
attacks the SCALE gaps named in the 535 handoff. Ordered by measured evidence.

## P0 — Freeze-line mutation horizon (write amplification, evidence in hand)

**Symptom (measured 2026-07-25):** a live claudecodeapp session logged repeated
`epoch rewrite … chainMismatch=true` (frozen=3196 cursorFrozen=3185): each
rewrite re-uploads the ENTIRE frozen history (3000+ events, MBs with
screenshots), several times per hour per live session.

**Root cause:** `computeFrozenEventCount` freezes every event up to the first
non-terminal `displayStatus`. The Claude Code ingest AMENDS recently-terminal
events afterwards (`es_merge_events` tool-result backfill,
`es_remove_synthetic_user_inputs`), so terminal ≠ immutable. Any amendment to
a frozen event breaks the prefix chain (the check at
`org2CloudSessionSync.ts:457-483` is correct — the data genuinely changed) and
forces the expensive epoch-rewrite path.

**Fix:** hold back a mutation horizon from freezing while the session is
live — do not freeze the trailing N events (and/or events younger than T
minutes) even when terminal, so ingest amendments land in the mutable tail
(one small segment re-upload) instead of invalidating frozen history. On
quiescence/completion the line advances to the end — steady-state output
identical to today. Constraints: keep frozenEventCount monotonic vs cursor
(shrink path unchanged); respect the 256KB tail-segment budget when choosing
N (screenshot-bearing events are large — budget-aware holdback, not a fixed
count). Verify: rewrite-frequency before/after on a live session
(`grep -c "epoch rewrite"` per hour), plus the existing segment tests.

**Status: SHIPPED (`f3ccbe2dc`) and verified live.** 20-minute window on the
same live session, ingest actively tailing: three push waves grew the cloud
row 3762 → 3851 events with `events_epoch` constant at 19 and zero
`epoch rewrite` lines. Morning baseline on the pre-fix build was 10
rewrites in one hour of comparable activity (2/4/10/1 per hour across the
07:00–11:00 span). The one rewrite after deploy was the predicted one-time
re-anchor when the lowered line first disagreed with the persisted cursor.

## P1 — Org listing latency

**Status: CLOSED by measurement — premise refuted, no migration needed.**
Seeded a test org to 506 live rows (service role, cleaned up after) and
timed `cloud_list_org_sessions` as an authenticated member, 3 runs per
size: 9 rows ≈ 0.28s, ~50 rows ≈ 0.28s, 506 rows ≈ 0.28s. Latency is FLAT
across a 56× row spread: the ~0.3-0.5s seen in the perf panel is fixed
cost (network RTT + PostgREST/auth), not per-row work. An index/LATERAL
migration would have optimized a term that does not move. Revisit only
past ~5k rows per org or if the panel shows growth with org size.

## P2 — Inactive-org consistency

**Status: SHIPPED and verified end-to-end.** Once per engine run, orgs the
user is NOT looking at that hold LOCAL push markers get a retract-only
reconcile: same `decidePushAdmission`, same server-confirmed scope
boundary, only rows this client can prove it pushed; locally-absent
sessions stay with the vanished sweep's two-strike verdict. Cost per org:
one TTL-shared scope fetch plus local work — no pushes, no replay, no
listing RPC. Verified on-device: a resurrected subagent row in a
background org was retracted at boot with zero workspace switches, the
tombstone timestamp matching the reconcile log line to the second; the
active org's live session and every other marked row untouched.

## P3 — Server hygiene

**Status: SHIPPED — 0009 applied to the live project and verified** (zero
live subagent rows anywhere; all 50 rows in the deleted org tombstoned
with the org's original deletion timestamp).
Org soft-delete now cascades a tombstone to the org's sessions in the same
transaction, plus a one-time idempotent backfill for the 45 orphans already
stranded in deleted org `6c14735d`. Deleted-org rows are invisible to
clients, so this was quota/storage hygiene, not correctness.

## P4 — Maintainability (architecture-audit per CLAUDE.md before refactor)

**First seam landed (`dc240ab1b`):** `decidePushAdmission` in
`org2CloudPushAdmission.ts` is now the single definition of the admission
rules (fork provenance + ownership gate), returning the denial reason the
retract log prints. This is the prerequisite for P2 — a reconcile that
retracts under different rules than the push admitted under is a bug
generator. Ten tests; removed `floorEligible`, a disjunction that was
constant-true at the only point it was read.

Remaining seams (unstarted): retract executor, pass scheduler. Do NOT mix
refactor commits with P0-P3 behavior fixes.

## Explicitly out of scope this campaign

Home-endpoint sharding cutover (0007 scaffolding), same-account multi-device
(needs a third signed install), load tests beyond the P1 seeding.

## Member-scale stress (workstream #1, harness: tests/stress/orgFanout.mjs)

Live-backend run, 50 real auth users in one team-plan org (2026-07-25):

- **Realtime fan-out** (the app's actual channel — client-sent broadcast
  nudges on `presence:org:<id>`): 50/50 subscribed, **49/49 receivers
  delivered — 100%, zero loss** (four consecutive runs; the one "missing"
  client was always index 0, the writer itself, excluded by broadcast
  `self:false` — the earlier 2%-loss reading was a harness denominator
  artifact). Harness timestamps include RPC+settle overhead; net
  propagation is sub-second.
- **Concurrent comments**: 50 simultaneous `cloud_add_session_comment`
  writers — 50/50 ok, zero errors, p50 1.0s / p95 1.15s under full
  contention (single-writer baseline ≈0.28s).
- **Concurrent owner pushes**: 20 parallel metadata upserts — 20/20 ok,
  p50 370ms.
- **Invite contention**: 49 accepts against ONE invite code — 49/49 ok.

**Real gates found ahead of performance:**

1. **GoTrue sign-in rate limiting** — ~30 password grants per window per
   IP; a 50-member 9am sign-in storm hits 429s (harness needed backoff +
   refresh-token reuse). Project auth rate config, not app code.
2. **Entitlements** — free plan caps `maxOrgMembers` at 3; member scale
   is plan-bound before it is ever load-bound (worked as designed; the
   stress org runs on a `team` org_entitlements override).

Stress fixtures (50 `@org2-stress.invalid` users, org `0830d453`, 18
boot-cost orgs) are LIVE for reuse; `node tests/stress/orgFanout.mjs
cleanup` tears the fan-out set down.

## Org-count boot cost (workstream #3)

Boot pass span (first engine log line → background reconcile complete),
build 25, one run per point, stress orgs created/deleted around the
measurement: 9 orgs 5.7s · 16 orgs 7.2s · 26 orgs 9.5s. **Linear** at
~0.22s/org (serialized, RTT-bound per-org RPC chain) over a ~3.7s fixed
base — no super-linear term. Extrapolated 50-org boot ≈ 15s. No action
needed at current scale; the lever, if ever needed, is parallelizing the
per-org chain, not indexing.

## Sharding Phase A (workstream #4)

**Status: routing layer SHIPPED.** `org2CloudOrgEndpointRouter` holds the
per-pass directory the engine now publishes from the roster's resolved
`homeEndpoint`s (0007); the sync client's org-scoped data-plane calls
(metadata upsert, append/rewrite, list, session events readers, scopes,
delete) resolve their endpoint per org with the official project as the
universal fallback. Guest-share reads keep their explicit endpoint
precedence. Verified: unit tests prove divergent routing + republish
semantics; full suite (6361) and an on-device run prove byte-identical
behavior while the directory is identity (all orgs on the official
project) — pushes flowed, zero errors, P0 epoch still constant.

**Phase B (needs user-provisioned infra):** a real second Supabase
project (schema 0001-0009 applied), an anon-key directory keyed by
endpoint origin, `cloud_set_org_home_endpoint` cutover of one test org,
and the cross-project live proof. The client half is now ready for it.

## Sustained write pressure (harness `sustain` mode, 2026-07-26)

10 writers × 5 minutes at 2s cadence against per-writer sessions:
~1310 comment writes, **zero errors, no latency drift** (p50 flat at
254-328ms, p95 330-470ms across every minute). Control-plane writes hold
steady under sustained pressure; full segment-protocol sustain remains
an app-level exercise.

**Product finding along the way:** the 0001 abuse guard caps comments at
500 per session counting live AND tombstoned rows — deleting comments
does not return budget, so a long-lived high-activity team session can
permanently exhaust its comment quota. Working as designed today; worth
a product decision (tombstone-excluding count, or per-window cap) before
50-member orgs live in one session for months.
