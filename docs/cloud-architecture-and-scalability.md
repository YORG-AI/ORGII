# ORG2 Cloud — Architecture and Scalability Reference

Last consolidated: 2026-07-24. This is the single living reference for the
ORG2 Cloud scalability program. It supersedes and replaces
`docs/cloud-scalability-audit-2026-07-23/` (three audit reports + priority
README) and `docs/cloud-broadcast-and-storage-design-2026-07-24/` (H4/H5
design notes + scale-out note), both removed. Server source of truth:
`ORGII-cloud-infra/supabase/migrations/` (0001 frozen baseline + numbered
increments). Client source of truth: `src/features/Org2Cloud/**`.

---

## 1. System topology

Three layers, one managed Supabase project:

| Layer                                         | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop (local SQLite)                        | UX source of truth. Cloud is a sync target/replica; every read the UI renders comes from local storage, populated by event-driven pulls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Supabase (single project `org2_cloud` schema) | (a) Postgres behind an **RPC-only surface** — all client access goes through `security definer` RPCs; direct table SELECT/DML grants to `anon`/`authenticated` are revoked, so RLS policies on data tables are defense-in-depth, not the API. (b) **Realtime**: one private org channel `presence:org:<org_id>` per active client (presence + client broadcasts + server `org-db-changed` signals), plus one `postgres_changes` subscription on the caller's own `org_memberships` row (Slice A self-eviction). (c) **Storage**: private `replay` bucket holding frozen replay segments as raw-gzip objects. |
| Vercel (`apps/org2-cloud-web`)                | Auth bridge (hosted login → desktop deep link), Stripe checkout/webhook/billing portal, replay **signer** (`/api/replay/sign`), orphan **GC cron** (`/api/replay/gc`, daily 04:00 UTC), inline-segment **backfill** (`/api/replay/backfill`). Holds `SUPABASE_SERVICE_ROLE_KEY` and Stripe secrets; desktop/browser only ever see the Supabase URL, the anon key, and the user's own tokens.                                                                                                                                                                                                                 |

**Capability probe.** `get_cloud_capabilities()` returns
`{broadcastSignals, storageSegments, replaySignerGrants}` (0005/0006). The
client probes once per endpoint URL and remembers the result
(`org2CloudCapabilities.ts`; success-only caching); `PGRST202` (function
missing) ⇒ legacy backend ⇒ the client keeps the old wire (postgres_changes
signal channels, inline segment payloads, no signer). The same
probe-and-remember pattern covers the 0004 paged listings (opt-in
parameters; legacy call shapes stay byte-identical). Net effect: every
server upgrade is backward compatible (old clients ignore additive keys)
and forward compatible (new clients degrade against old backends).
`ORG2_VALIDATION` errors never trigger fallback — real bugs must surface.

---

## 2. Scalability model, by resource

### Connections

Realtime bills peak concurrent connections per billing cycle (Pro includes
500; $10/1,000 over) plus messages ($2.50/M over 5M). The client holds a
**foreground lease**: connected while focused; on blur the release is
deferred by a **45s grace** (`REALTIME_LEASE_RELEASE_GRACE_MS`; refocus
cancels the timer); hidden/pagehide release immediately. This keeps the
peak-connection billing win of release-on-blur while eliminating the
teardown/recovery burst on routine alt-tabs (and the presence
viewer-chip-vanishes regression).

Recovery on (re)subscribe edges is **disconnect-gated**
(`org2CloudRealtimeRecovery.ts`): short disconnect (<5min, or a full
refresh within the last 30s) → cursor delta; only long disconnects pay a
full listing + a force-bumped comment refresh for the active session
(bypassing the 30s comments TTL that used to swallow short-blur comments).
Reconnects carry 0–3s jitter (`reconnectAfterMs` override); comment-fetch
retries back off exponentially (10s → 5min cap, failure count preserved
across evictions).

Channels per client: 1 socket; post-0005 topology is 2 channels (private
org channel + Slice A postgres_changes), down from 4. `eventsPerSecond: 5`,
presence budget 5/30s. Subscription scope is O(1) per client: active org
only.

### Realtime messages

Signals ride **Broadcast-from-Database** (0005): every data-table write
funnels through `org2_cloud.nudge_org_signal(org_id, kind)`, which upserts
a debounce row and — iff the debounced bump fired — `realtime.send`s an
`org-db-changed {kind}` broadcast to the existing private org channel.
Authorization is evaluated once at channel join (the 0001
`realtime.messages` policies), not per change × per subscriber as
`postgres_changes` did on the shared single-threaded WAL poller — that
per-subscriber RLS evaluation was the platform's first scalability wall
(a 20-member org at ~2k writes/day ≈ 2.4M messages/month alone).

- **Server debounce**: one bump per **(org, kind)** per **1s** (0006 PART 8;
  0003 started at 250ms per org, 0005 kept it, 0006 reshaped the PK to
  `(org_id, kind)` so planes debounce independently — no kind shadowing).
- **Client throttles**: per-plane (`sessions | comments | projects |
workItems | roster | policy`) 60s trailing-edge refresh (`SignalPlane`),
  with a 5min coarse safety net for legacy backends.
- **Publication cleanup** (0006 PART 6): `org_change_signals` left the
  `supabase_realtime` publication; the rows are now purely debounce clocks.
- **Slice A exception**: `org_memberships` stays published and the client
  keeps one user_id-filtered postgres_changes subscription forever — a
  member removed while disconnected can never be reached by join-time-auth
  broadcast (`is_org_member()` already false).

Broadcast is fire-and-forget; the loss backstop is the existing
SUBSCRIBED-edge recovery on the org channel's join edge.

### Query cost

- **Keyset pagination everywhere**: sessions listing pages by
  `(updated_at, session_id)` (0004 PART 2, ≤500/page); collab-state pages a
  unified `(updated_at, kind, id)` cursor over the projects ∪ work-items
  union (0004 PART 3); replay events page by `seq`
  (`cloud_get_session_events_page`, 0002, default 16 / max 64 segments,
  tail only on the final page); comments patch via `p_since` deltas (0004
  PART 6) keyed on the single `state_changed_at` stamp (0006 PARTs 9–11).
  All paging parameters are opt-in; parameterless calls stay
  byte-identical for old clients.
- **Batched entitlements**: `list_my_orgs` resolves each row's
  `entitlement` in the same round-trip via the exception-wrapped
  `entitlement_state_or_null` (0004 PART 1) — replaces the 1 + N
  `get_entitlement_state` fan-out per roster read.
- **O(1) quota counters**: `orgs.stored_bytes_total` is delta-maintained by
  append/rewrite/erasure (0003); the quota gate is counter + delta > cap,
  not a per-push scan of every session row of the org.
  `reconcile_org_stored_bytes()` (service-role) recomputes from ground
  truth for ops/nightly reconciliation.
- **Materialized comment counts**: `cloud_sessions.comment_count` /
  `unresolved_comment_count` maintained by the comment RPCs (0003) —
  the per-row COUNT LATERAL in the sessions listing is gone.

### Locks

- **Canonical acquisition order** (0003 header is the authority), org-level
  slots: 1 advisory xact locks (per org/session plane) → 2 `cloud_sessions`
  rows → 3 `usage_monthly` row → 4 `orgs` row → 5 comment rows → 6 signal
  row, always statement/transaction-final. The 0003 reorder fixed the
  `usage_monthly` ↔ signal-row inversion (40P01 window between a member
  creating a session and a member pushing).
- **Work-item narrowing** (0004 PART 5): `cloud_upsert_work_item` takes the
  owning project row lock only when the short-id allocator actually
  advances; steady-state edits serialize only on the per-item advisory
  lock, so N members editing N items of one project no longer serialize.
- **Commit-deferred signal triggers** (0006 PART 7): the five data-plane
  signal triggers are `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY
DEFERRED` — the per-org signal-row lock window shrank from "rest of the
  first writer's transaction" to the commit instant, and rollbacks emit
  nothing. A **per-org advisory xact lock** inside `nudge_org_signal`
  totally orders the commit-instant signal writes, making cross-kind
  commit deadlocks impossible. The 3 policy RPCs' nudges stay inline
  (short single-row transactions, already commit-adjacent).

### Storage

Frozen replay segments (`seq >= 1`, immutable) live in the private
`replay` bucket as **raw gzip** objects (no base64 +33%), named
`{org_id}/{session_id}/{epoch}/{seq}-{segment_hash}.gz` where
`segment_hash` = sha256 hex of the pre-gzip canonical bytes —
immutable-by-name, retry-idempotent, collision-safe inside the org/session
auth domain. The mutable tail (`seq = 0`) stays inline in Postgres
(`payload_gz`), keeping append OCC single-transaction; a CHECK forbids a
storage-form tail.

Writes are **upload-blobs-first, commit-manifest-second**: the append/
rewrite RPC verifies each claimed object exists in `storage.objects`, that
its name parses to the exact (org, session, epoch, seq) being committed
and embeds the claimed hash, and charges quotas with the **server-measured**
size from object metadata — no client attestation. Missing/mismatched
object ⇒ `ORG2_VALIDATION`, nothing committed. Read RPCs return
`storagePath` XOR `payloadGz` per segment. Members read/write objects
directly with their JWT via storage RLS policies delegating to
`can_read_replay_object` / `can_write_replay_object` (which reuse the SQL
session-access ladder verbatim); share-token guests go through the Vercel
signer (section 5). Postgres cannot delete bucket objects, so
rewrite/hard-delete orphan them by design; the `replay_orphan_objects`
view (objects >24h old with no matching segment row) feeds the daily cron
sweeper.

### Client discipline: strictly event-driven

No recurring timers, no polling. Sync passes fire on concrete events:
signal broadcasts, agent turn-terminal, outbox writes, boot, focus/
visibility edges, `online`, org activation. Hidden windows still push
outbound (turn-terminal + outbox events pass the hidden gate; inbound
nudges wait for visibility). Measured: after an activation burst the app
goes to complete network silence — 0 "likely polling" entries in the cmd+5
API panel, 0% idle CPU (section 4).

---

## 3. Change ledger

Migration policy (since 2026-07-23): **0001 is a frozen baseline** — the
live project can no longer be wiped, so schema changes ship as numbered
idempotent increments applied in order. `schema_version()` stays 1; the
file sequence is the version record.

| Migration                                  | What shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Applied                                                                                                                           | Validation                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_org2_cloud_schema.sql`               | Consolidated full schema (flattened from the original 0001–0014 + comment-task system later removed): orgs/memberships/invites, sessions + segments + shares, projects/work items, comments, entitlements/Stripe tables, GDPR RPCs, realtime publication + `org_change_signals`, plan seed.                                                                                                                                                                                                                                                                                                                                                                       | Live rebuild 2026-07-07; declared frozen 2026-07-23                                                                               | Adversarially reviewed at consolidation (single-txn safe, byte-equivalent to sequential apply); live probe `schema_version()=1`, 17 tables / 55 functions at freeze-era count                                                                                                                                                                    |
| `0002_bounded_session_event_pages.sql`     | `cloud_get_session_events_page` — seq-keyed paging of replay reads (≤64 segments/page, tail on final page), same auth/summary contract (audit H2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2026-07-23                                                                                                                        | Live paste; signature probe 403-not-PGRST202; client loops on `afterSeq` (note: `p_after_seq` is int4 — head-reads use 2147483647, never `MAX_SAFE_INTEGER`)                                                                                                                                                                                     |
| `0003_scalability_p0.sql`                  | H1 lock-order fix; double signal-bump elimination; C3 O(1) `stored_bytes_total` counter + `reconcile_org_stored_bytes`; C1 partial (250ms/org signal debounce); M4/C2 partial (materialized comment counts); M2/M3 indexes. Documents the canonical lock order.                                                                                                                                                                                                                                                                                                                                                                                                   | 2026-07-23                                                                                                                        | Offline: brew postgresql@16, literal 0001→0002→0003 apply; A/B concurrency proof that the old GDPR statement order deadlocks (40P01) and the shipped order does not. Live: zero-drift verify (reconcile `fixedOrgs:0/fixedSessions:0`, per-org counters exact)                                                                                   |
| `0004_roster_and_listing_scalability.sql`  | 7 PARTs: B1 batched entitlements in `list_my_orgs`; C2 sessions keyset paging; H3 collab-state unified-cursor paging; H3 `gc_collab_tombstones` (90d, keeps tombstone projects referenced by live items); M1 work-item lock narrowing; M4 comments `p_since`; L2 `gc_bookkeeping`. Old 2-arg signatures dropped, not overloaded (PostgREST cannot disambiguate).                                                                                                                                                                                                                                                                                                  | 2026-07-24                                                                                                                        | Offline: disposable PG16 six-item matrix (fresh/delta wire byte-identical, idempotent replay, paged∪ == legacy, GC ACL). Live: 4 new-signature probes 403(42501)≠PGRST202; `list_my_orgs` 7/7 orgs with full 19-key entitlement; paged==legacy walks on the active org                                                                           |
| `0005_broadcast_and_storage_offload.sql`   | 11 PARTs: H4 — `nudge_org_signal` helper (debounced bump + `realtime.send` on the private org channel), trigger kind mapping, roster trigger, 3 policy RPCs onto the helper, `get_cloud_capabilities`; H5 — `storage_path` column + CHECKs, `replay` bucket bootstrap + storage RLS helpers/policies, storage-form append/rewrite with server-measured quota, `storagePath` XOR `payloadGz` reads, `replay_orphan_objects` view. Guarded DO blocks NOTICE dashboard SQL where the runner lacks `storage.objects` ownership.                                                                                                                                       | 2026-07-24                                                                                                                        | Offline: 9-item matrix (idempotency, wire A/B vs 0004, manifest-vs-missing-object, mixed inline/storage quota deltas + mixed-org reconcile zero drift, orphan view, RLS helper ladder). Live: verify tail all `t`; bucket + both policies created by the migration itself; broadcast delivery, member storage reads, retract verified end to end |
| `0006_guest_grants_and_signal_cleanup.sql` | 12 PARTs: `replay_read_grants` (sha256-at-rest, 60s expiry, service-role-only table) + `cloud_authorize_replay_read` (anon-callable mint; auth ladder verbatim from the events RPC) + `cloud_redeem_replay_grant` (service-role, atomic single-use `DELETE..RETURNING`, object list re-derived at redeem under the current epoch) + `replaySignerGrants` capability + grant GC; signal cleanup — publication drop (PART 6), commit-deferred triggers (PART 7), per-(org, kind) 1s debounce + advisory total order (PART 8); `state_changed_at` comment stamp + single-stamp `p_since` (PARTs 9–11); `cloud_ops_stats()` service-role capacity snapshot (PART 12). | Final revision (eb793d9, all 12 PARTs incl. per-kind debounce, `state_changed_at`, ops stats) applied 2026-07-24, verify all `t`. | Offline adversarial matrix incl. deferred-trigger semantics (mid-tx zero sends / one send at commit / rollback zero) and the proof that removing the advisory lock reintroduces a deterministic 40P01. Live: `/api/replay/gc` 200 with key / 401 without; `/api/replay/sign` opaque 401 on a fake grant; pg_locks A/B in section 4               |

Client PRs (ORGII, all `src/features/Org2Cloud/**` unless noted):

| PR                                                                                 | Branch                                     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Gates                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| #507 (merged `f207fa035`)                                                          | `codex/reclaim-cloud-realtime-connections` | Foreground-lease reclaim epic + audit P0 fixes: 45s release grace (hidden/pagehide immediate), A2 full-payload hash seed (+`avatarUrl`), disconnect-gated delta recovery, comments force-bump on full recovery, 0–3s reconnect jitter, comments exponential backoff (incl. the later `consecutiveFailures`-across-evict fix), hidden-outbound (turn-terminal + outbox pass the hidden gate), full listings converged to the active org.                                                                                                                                               | tsc ours 0, 676/676 feature tests; CI green on merge; dual-instance live matrix (section 4)                         |
| #509 (merged `7ae39f13c`)                                                          | `codex/batch-org-entitlement-hydration`    | 0004 client: entitlement seeding from `list_my_orgs` (`seedOrgEntitlement`/`hydrateOrgEntitlements`), sessions keyset paging, collab-state unified-cursor paging (ascending keyset ⇒ mid-walk writes only move into the unread tail; 50-page fuse), PGRST202 fallback + per-endpoint memory.                                                                                                                                                                                                                                                                                          | Full suite 6156/6156; live fallback path verified against pre-0004 shape; post-apply cmd+5 verification (section 4) |
| #511 (merged `93056a38a`)                                                          | `codex/broadcast-and-storage-offload`      | 0005 client: capability probe, Slice B/B-roster channels skipped when `broadcastSignals`, `org-db-changed` on the presence channel, recovery moved to the org-channel join edge; `org2CloudStorageClient` (raw-gzip PUT/GET), segment codec raw-bytes variant, upload-then-manifest push, `storagePath` XOR `payloadGz` decode, `ORG2_VALIDATION` never falls back.                                                                                                                                                                                                                   | Suite green at merge; live e2e: broadcast chain + 73-object storage push (section 4)                                |
| #532 (open; branch `codex/replay-guest-access-and-signal-tuning`, tip `af9eea28a`) | this branch                                | 0006 client: guest signed replay reads via the signer (single-flight URL cache, one re-authorization on expiry, typed signer errors + single retry), B3 listing 2s coalesce window (a full fetch is never satisfied by a delta), comments `p_since` delta (force path stays full to cover un-resolve on pre-0006 backends), policy broadcasts also bump the roster version (kind-shadowing symmetry), per-kind `SignalPlane` dispatch (60s/plane + 5min coarse safety net), Rust import-watermark incremental ingest (`imported_history/watermark.rs` — kills the ~90s boot reparse). | 941/941 → 946/946 across batches; clippy clean                                                                      |

---

## 4. Measured evidence

All numbers from live dual-instance runs (accounts Neonforge98/VantaNode,
shared org "CU Vanta Shares 0721") or pg_locks instrumentation on a
disposable PG16, 2026-07-23/24.

| Claim                              | Measurement                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entitlement fan-out collapsed (B1) | First activation of an org: `get_entitlement_state` exactly ×1 (measured ×7 for the same trigger pre-0004); sessions/collab/members/scopes ×1 each                                                                                                                                                                                                                  |
| Event-driven, zero polling         | Org activation burst ≈48 calls then **complete silence**; switching back to an already-activated org = 0 remote calls; 0 "likely polling" in the cmd+5 API panel across the run; idle CPU 0%, RSS stable (142MB / 95MB, no leak)                                                                                                                                    |
| Restart write storm gone (A2)      | After the hash-seed fix: 0/8 pushed sessions re-upserted on restart (previously 8/8 byte-identical re-sends + broadcast)                                                                                                                                                                                                                                            |
| Lease grace keeps live path (A1)   | Blur-but-visible within grace: subscribe count stays 1 (socket kept), new work items arrive live without refocus; >2min background → refocus produces one delta recovery, items arrive                                                                                                                                                                              |
| C1 lock window (pg_locks A/B)      | Concurrent same-org writer blocked **1.54s** behind a long first transaction with mid-tx AFTER-ROW signal triggers; **0.015s** with 0006 commit-deferred triggers                                                                                                                                                                                                   |
| Deferred-trigger semantics         | Mid-transaction: zero `realtime.send`s; commit: exactly one debounced send; rollback: zero (send is transactional)                                                                                                                                                                                                                                                  |
| Storage offload e2e (H5)           | Boot pass pushed **73 raw-gzip objects** to the `replay` bucket (epoch 1); read RPC returns `storagePath` with no `payloadGz`; **non-owner member JWT direct read 200** + gunzip + sha256 == hash embedded in the path; **anon read 400**; retract cleaned the cloud listing (the 73 objects became the orphan-view/cron design case)                               |
| Broadcast e2e (H4)                 | Raw supabase-js subscription on the private channel receives `org-db-changed {workItems}` (write → trigger → broadcast); desktop: RPC write on instance 2 lands in instance 1's SQLite on the 60s coarse trailing edge; **delete tombstone propagates** (live to the held-socket peer; on refocus delta to the released one); 2.5min of zero calls after the delete |
| Comment delivery                   | RPC comment → peer woke within 1s and pulled exactly one listing delta (materialized `comment_count` arrives)                                                                                                                                                                                                                                                       |
| Hidden outbound                    | Long streaming reply, cmd+H 1.5s after send: server received the push 20s into hidden (events 5→6)                                                                                                                                                                                                                                                                  |

---

## 5. Operations runbook

### Migrations

- Paste numbered files **in order** into the Supabase SQL editor (or
  `supabase db push`). Every increment is idempotent — safe to re-paste; one
  transaction, rolls back on failure.
- Statements touching objects the SQL-editor role may not own
  (`storage.objects` policies, publication membership) are wrapped in
  guarded DO blocks that **NOTICE the exact SQL** to run in the dashboard as
  `supabase_admin` instead of failing the paste. Read the NOTICEs.
- Every migration ends with **verify tails** — SELECTs with expected
  outputs (`t / t / ...`, expected row counts) — run them and check before
  declaring applied. Update the ledger in `ORGII-cloud-infra/README.md`.
- **Wipe is forbidden.** Since 2026-07-23 the live project cannot be
  dropped and rebuilt; 0001 is frozen; changes are additive increments
  keeping legacy call shapes byte-identical unless a client change lands
  with them. Signature changes DROP the old signature rather than
  overloading (PostgREST cannot disambiguate named-arg subsets).

### Vercel

- Env vars (server-only): `SUPABASE_SERVICE_ROLE_KEY`, Stripe keys, and
  `CRON_SECRET`. Vercel cron invocations automatically send
  `Authorization: Bearer $CRON_SECRET`; the gc/backfill routes require
  exactly that header, so manual runs pass the same bearer. Changing
  `CRON_SECRET` requires a redeploy.
- `POST /api/replay/sign` — body `{grant}`. Redeems a
  `cloud_authorize_replay_read` grant (single-use, 60s) via the
  service-role RPC and returns `{urls: {storagePath: signedUrl},
expiresIn: 120}` for **all** of the session's objects (complete set or
  nothing). 401 with an opaque `ORG2_*` code on any redeem failure. CORS
  `*` — the grant token is the entire authorization.
- `GET /api/replay/gc` — cron `0 4 * * *` (vercel.json). Reads the
  service-role `replay_orphan_objects` view (objects **>24h** old with no
  segment row — the 24h window means a first sweep reporting `scanned: 0`
  right after orphan creation is correct, not a bug) and deletes via the
  Storage API in pages of 100, max 50 pages/run. Returns
  `{scanned, deleted, errors}`.
- `POST /api/replay/backfill` — body `{limit?}` (default 200, max 1000).
  Moves legacy inline frozen segments (storage_path null, seq ≥ 1) to the
  bucket at the canonical name and sets `storage_path`; `payload_gz` and
  `byte_size` are left untouched (reversible; base64-unit accounting
  preserved — see section 6). Re-run until `remaining: 0`. A **later
  separate pass nulls `payload_gz`** once the backfill has soaked; run it
  only after signed reads have been exercised against backfilled rows.

### Probe recipes (service key)

- **Function existence**: call the RPC with a role that lacks EXECUTE — a
  **403/42501 proves the function exists** (permission denied), while
  `PGRST202` means it does not. This is the standard post-paste signature
  probe.
- **Real-user token minting** (no OAuth round-trip): auth admin
  `generate_link(type: magiclink)` with the service key →
  `POST /auth/v1/verify` with the hashed token → session
  access/refresh tokens. Used both for RPC verification as a real member
  and for recovering an expired desktop instance login
  (`open "orgii-instance2://auth/callback#access_token=…"`).
- `cloud_ops_stats()` (0006, service-role only): per-org top-50 activity/
  size counts + platform totals — the input to the scale-out signals in
  section 7.

---

## 6. Known gaps and accepted tradeoffs

| Item                                                                                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-0005 desktop clients lose coarse change signals once 0006 PART 6 drops `org_change_signals` from the publication | **Accepted.** The fleet is upgraded; Slice A eviction (org_memberships) still works for any straggler, but data-plane nudges require a 0005+ client                                                                                                                                                                                                                                                                    |
| `byte_size` unit split                                                                                               | Legacy/backfilled rows account in **base64 units**, new storage-form rows in **raw bytes** — quotas effectively loosen ~25% on new data. Documented, deliberately not compensated (backfill keeps old units precisely to avoid usage-counter drift)                                                                                                                                                                    |
| Guest replay availability                                                                                            | Storage-form guest imports depend on the **Vercel signer route** being up (members are unaffected — direct storage RLS reads). Signer failures surface as typed errors with a single retry, not silent fallback                                                                                                                                                                                                        |
| Kind shadowing history                                                                                               | 0005 had one debounce row per org, so e.g. `cloud_set_member_sharing_floor` broadcast as `roster` (the roster trigger claimed the window); 0006's deferral alone would have inverted it to `policy`; 0006 PART 8's per-(org, kind) rows eliminate shadowing (that RPC now emits **both** `policy` and `roster`). The client handles both eras: policy and roster kinds each bump roster version **and** coarse refresh |
| Comments delta un-resolve blind spot                                                                                 | **CLOSED** by `state_changed_at` (0006): un-resolve clears `resolved_at` but now moves the single delta stamp; the client's force path stays full-fetch to cover pre-0006 backends                                                                                                                                                                                                                                     |
| Visible-but-unfocused window beyond the 45s grace                                                                    | Lease still releases; UI can stale until refocus (then heals via cheap delta). Mitigation judged sufficient; hold-while-visible remains an option if users report it                                                                                                                                                                                                                                                   |
| `cloud_delete_account` heavy-user erasure                                                                            | 0003 shipped the user-id indexes, but execution still runs as one transaction through the caller's PostgREST connection under the 8s timeout; the service-role background batch job remains future work                                                                                                                                                                                                                |
| Tail re-upload growth                                                                                                | A long streaming turn re-uploads the whole inline tail per 3s-debounced append — O(turn²) bytes per turn (gzipped). Monitor; cap candidates documented in the client audit's D notes                                                                                                                                                                                                                                   |
| Comment tombstones consume the 500/thread cap permanently                                                            | Spam-then-delete can cap a thread; unaddressed (LOW)                                                                                                                                                                                                                                                                                                                                                                   |
| Append-path tail delete+reinsert bloat (L1)                                                                          | Unaddressed; monitor autovacuum on `cloud_session_segments`                                                                                                                                                                                                                                                                                                                                                            |
| Client localStorage push-cursor/metadata maps lack session-level GC (client C2)                                      | Dead-org pruning exists (roster reconcile + zombie-org sweep); per-session sweep against the local registry remains future work                                                                                                                                                                                                                                                                                        |
| Socket rebuilt on org switch                                                                                         | Minor redundant `list_my_orgs`; reusing the socket and swapping channels would remove it (LOW)                                                                                                                                                                                                                                                                                                                         |

---

## 7. Scale-out roadmap (beyond one Supabase project)

With 0003–0006 applied, every audit-identified bottleneck inside the
single project is closed. Levers for the next magnitude, in order —
pre-decided so the call is not made under fire. Watch `cloud_ops_stats()`
plus the Supabase dashboard.

1. **Read replicas** (first, cheapest). Route the read-heavy RPC allowlist
   (listings, event pages, roster) to a replica. Client prerequisite
   already exists: every call goes through `getCloudEndpoint()`; add a
   `readReplicaUrl` to `CloudEndpoint`. Writes, realtime, storage stay
   primary.
2. **Storage/CDN egress** — already offloaded (0005): replay bytes go
   through the Storage CDN, not Postgres. Nothing further until
   multi-region.
3. **Org sharding** (the real split). The schema is shard-friendly: every
   row is org-scoped; cross-org state is only `orgs` / `org_memberships` /
   `cloud_profiles`. A split is a directory service mapping org → project
   (endpoint + anon key) fetched at roster load; the client already keys
   caches and capability memory per endpoint URL. Realtime channels and
   storage buckets shard with their org's project; grants/billing stay on
   a control-plane project.
4. **Multi-region** follows sharding (orgs assigned to regional projects);
   no code-shape changes beyond the directory.

Action signals: realtime messages/month at 60% of plan → widen per-kind
debounce or narrow refetch further (replicas do not help — messages bill
per delivery); primary CPU sustained >50% or connection peak >300 → read
replicas; any single org >~20% of total write volume → first sharding
candidate.

Explicitly rejected: cross-tenant content-addressed dedup of replay
objects (timing side channel — see SharedSessionPerformance.md); per-user
connection-pooling changes (RPC-only PostgREST keeps connections flat; the
lease bounds realtime sockets).

**User-approved next batch**: `homeEndpoint` directory hook in the client
(step 3's client half); a painless new-project migration runbook; a BCDR
drill (backup/restore of the managed project); the `payload_gz`-nulling
pass once backfill has soaked (section 5).

---

## 8. Audit findings index

This index replaces the full 2026-07-23 audit reports. Server = schema
audit of 0001; Client = desktop usage audit; LR = adversarial
foreground-lease review. "Resolved" = shipped and verified.

### Server schema audit

| ID  | Finding                                                                                                                                                   | Resolution                                                                                                                             | Status                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| C1  | `org_change_signals` = one hot row per org: FOR EACH ROW triggers + append-path double-write serialized all org writes and double-fired realtime per push | 0003 (250ms debounce + double-bump elimination) → 0006 PARTs 7–8 (commit-deferred triggers, per-(org,kind) rows, advisory total order) | Resolved (1.54s → 0.015s)                                 |
| C2  | `cloud_list_org_sessions` unbounded + per-row comment-count LATERAL; cold starts/reconnects replay the full listing                                       | 0003 materialized counts + 0004 PART 2 keyset paging + PR #509                                                                         | Resolved                                                  |
| C3  | `enforce_stored_bytes_quota` O(N) org-wide scan per segment push, under the signal-row lock                                                               | 0003 `orgs.stored_bytes_total` delta counter + `reconcile_org_stored_bytes`                                                            | Resolved (zero-drift verified)                            |
| H1  | `usage_monthly` ↔ signal-row lock-order inversion → 40P01 between create and push                                                                         | 0003 reorder (quota before the sessions update)                                                                                        | Resolved (A/B deadlock proof)                             |
| H2  | `cloud_get_session_events` returns the whole replay as one jsonb; no size cap                                                                             | 0002 `cloud_get_session_events_page` (seq keyset) + client loop                                                                        | Resolved                                                  |
| H3  | Collab-state full pull returns every version ever, tombstones included, forever                                                                           | 0004 PART 3 unified-cursor paging + PART 4 `gc_collab_tombstones` (90d) + PR #509                                                      | Resolved                                                  |
| H4  | postgres_changes = per-change × per-subscriber RLS on a shared single-threaded WAL poller; message quota is the first platform wall                       | 0005 Broadcast-from-Database + 0006 PART 6 publication drop + PRs #511/#532; Slice A stays postgres_changes by design                  | Resolved                                                  |
| H5  | Replay bytes as base64 TEXT in primary Postgres with 100GB/org entitlements                                                                               | 0005 Storage offload + 0006 guest grants + Vercel sign/gc/backfill + PRs #511/#532                                                     | Resolved (backfill ongoing; `payload_gz` nulling pending) |
| M1  | Every work-item upsert took FOR UPDATE on the owning project row                                                                                          | 0004 PART 5 allocator-only lock                                                                                                        | Resolved (pg_locks: no project-row waits)                 |
| M2  | `cloud_delete_account` single-txn via caller connection; missing user-id indexes                                                                          | 0003 indexes shipped; background-job execution not done                                                                                | Partially resolved (section 6)                            |
| M3  | No index for the free-plan retention-window listing predicate                                                                                             | 0003 `(org_id, last_activity_at desc) where deleted_at is null`                                                                        | Resolved                                                  |
| M4  | Unpaginated comment listing + refetch-on-nudge herd                                                                                                       | 0004 PART 6 `p_since` + 0006 `state_changed_at` + PR #532                                                                              | Resolved                                                  |
| L1  | Append path deletes+reinserts the tail row per push; bloat amplifier                                                                                      | Not addressed; monitor autovacuum                                                                                                      | Open (accepted)                                           |
| L2  | Forever-growing bookkeeping (`stripe_webhook_events`, repo-scope events; comment tombstones eat the thread cap)                                           | 0004 PART 7 `gc_bookkeeping` + 0006 PART 5 grant purge; tombstone-cap consumption stands                                               | Mostly resolved                                           |
| L3  | Quota COUNT(\*) gates                                                                                                                                     | Verified bounded/fine                                                                                                                  | No action                                                 |

### Desktop client usage audit

| ID  | Finding                                                                                                                                        | Resolution                                                                                                     | Status                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A1  | Every blur→focus flip = full recovery batch (~6+N RPCs, two full listings) + socket churn; no disconnect-duration gate                         | PR #507: 45s release grace, disconnect-gated delta recovery, recovery routed through version bookkeeping       | Resolved                 |
| A2  | Metadata hash seed stored stripped-payload hash but compared full-payload hash — never matched; every restart re-upserted every pushed session | PR #507: seed stores the full-payload hash (+`avatarUrl`)                                                      | Resolved (0/8 re-pushed) |
| A3  | Visible-but-unfocused window holds no socket and never recovers; UI stales silently                                                            | PR #507 grace covers short blurs; refocus heals via delta                                                      | Mitigated (section 6)    |
| B1  | `get_entitlement_state` × N fan-out per roster read; coordinator deferred instead of dropping                                                  | 0004 PART 1 + PR #509 batched hydration                                                                        | Resolved (7→1)           |
| B2  | Zero jitter anywhere: reconnect, online herd, transport retry, flat 10s comments loop                                                          | PR #507: 0–3s reconnect jitter, exponential comments backoff (10s→5min cap, failures preserved across evict)   | Resolved                 |
| B3  | App start runs the expensive reads twice (`list_my_orgs` ×2, sessions listing ×2, repo scopes ×2)                                              | PR #532: 2s listing coalesce window (full never satisfied by delta); PR #507 killed the A2 upsert storm half   | Resolved                 |
| B4  | `forceAllInbound` = full collab listings for ALL orgs on start/online/roster-change                                                            | PR #507: full listings converged to the active org; others delta/defer-to-activation                           | Resolved                 |
| C1c | Missed-event heal map: gaps for visible-unfocused, non-active-org comments, inactive orgs                                                      | Partially closed by #507 (comments force-bump on full recovery); inactive-org staleness is the stated contract | Accepted                 |
| C2c | Persisted localStorage push-cursor/metadata maps grow without session-level GC                                                                 | Dead-org pruning + zombie-org sweep exist; per-session sweep future work                                       | Open (accepted)          |
| C3c | In-memory bounds (remote sessions 64, comments 128, roster 64, tokens 500)                                                                     | Verified healthy                                                                                               | No action                |
| D   | Payload notes: O(turn²) tail re-upload; 10-min events re-hash; comments always full                                                            | Comments delta shipped (#532); tail growth + re-hash monitored                                                 | Partially resolved       |
| E   | Subscription scope O(1)/client verified; socket rebuilt on org switch                                                                          | Channels 4→2 post-0005; socket-rebuild wart remains                                                            | Open (LOW)               |

### Foreground-lease adversarial review (ship-blockers pre-#507)

| ID  | Finding                                                                                       | Resolution                                                                      | Status                                              |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| LR1 | No hysteresis: every blur pays full teardown/recovery (ship-blocker)                          | PR #507 45s grace                                                               | Resolved                                            |
| LR2 | "Hidden window keeps pushing" was false in code — unbounded outbound staleness (ship-blocker) | PR #507 hidden-outbound on turn-terminal + outbox events                        | Resolved (20s-into-hidden push proof)               |
| LR3 | Presence viewer-chips vanish on every blur (regression the old code warned about)             | Grace period covers it                                                          | Resolved (dual-window visual check still pending)   |
| LR4 | Comments missed during short blur swallowed by the 30s TTL                                    | PR #507 force-bump on full recovery                                             | Resolved                                            |
| LR5 | Reconnect thundering herd, no jitter/cooldown                                                 | PR #507 jitter + backoff                                                        | Resolved (network-fault injection only unit-tested) |
| LR6 | Non-active orgs: staleness unbounded after the recurring pass was removed                     | Contract stated (stale-until-activation); tombstone-on-refocus verified         | Accepted                                            |
| LR7 | Double full sessions listing per refocus                                                      | PR #532 coalesce window                                                         | Resolved                                            |
| LR8 | Zombie connections                                                                            | None found; disposal correct on all paths                                       | No action                                           |
| LR9 | Billing model verification                                                                    | Peak-concurrent billing confirmed; grace keeps the win while deleting flap load | Verified                                            |
