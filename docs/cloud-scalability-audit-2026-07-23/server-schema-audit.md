# Server-Side Scalability Audit (org2_cloud schema)

Auditor: fable subagent, 2026-07-23. Source of truth: `ORGII-cloud-infra/supabase/migrations/0001_org2_cloud_schema.sql` (5708 lines, main). Note: the comment-task system (0002) was removed in cloud-infra commit `f69961e`; `supabase_realtime` publication contains only `org_change_signals` + `org_memberships`.

## CRITICAL

### C1. `org_change_signals` is a single hot row per org — every write in the org serializes on it, and it double-fires per segment push

- One row per org, PK `org_id` (5599–5606). Trigger fires `FOR EACH ROW` on `cloud_projects` (5654), `cloud_work_items` (5658), `cloud_session_comments` (5665), `cloud_sessions` (5673) with `ON CONFLICT DO UPDATE set last_change_at = now(), seq = s.seq + 1` (5642–5647).
- `cloud_append_session_events` updates `cloud_sessions` at 689–694 **and again** inside `enforce_stored_bytes_quota` (3205–3207) → sessions trigger fires twice per push. Same for `cloud_rewrite_session_events` (2260 + quota update).
- The ON CONFLICT row lock is held until commit → org-wide write concurrency collapses to 1; in the append path the lock is taken _before_ the O(N) quota scans (C3), so every writer in the org waits behind them. `cloud_delete_project` tombstones N items → N consecutive updates of the same hot row in one transaction.
- Every bump fans out via postgres_changes to every subscribed member (2 events per segment push).

**Fix:** statement-level triggers with transition tables (one bump per statement per org); debounce the hot row (`where s.last_change_at < now() - interval '250 milliseconds'`); eliminate the second `cloud_sessions` update by passing the byte delta into `enforce_stored_bytes_quota` or folding `stored_bytes` into the main summary UPDATE.

### C2. `cloud_list_org_sessions` is unbounded, with a per-row comment-count LATERAL

- Final definition 5487–5565: no LIMIT anywhere; paid plans skip retention windowing entirely (`v_retention_days is null` 5551; pro/team/enterprise seed `replayRetentionDays: null` at 5216/5238/5267). Data is never hard-deleted (5142–5149).
- Per returned row: comment-count LATERAL over `cloud_session_comments` (5523–5534) + share-probe EXISTS (5537–5546).
- Client forces a FULL pull on every Realtime (re)subscribe true-edge, so every reconnect of every member replays the full listing.
- A team org at seeded cap (5000 synced sessions/month) accretes ~60k rows/year: full pull = 60k heap rows + up to 3×10^7 comment-index entries + one giant `jsonb_agg` (100–200MB potential) → blows the 8s authenticated statement_timeout exactly when the org gets big. Delta path (`since` + `cloud_sessions_org_updated_idx (org_id, updated_at)`, 4064) is fine; cold starts and reconnects die.

**Fix:** keyset pagination (`p_limit`, `(updated_at, session_id) >` cursor, `limit least(p_limit, 500)`) + maintain `comment_count`/`unresolved_count` as counter columns on `cloud_sessions` (comment RPCs already serialize per session via advisory lock 5419–5421).

### C3. `enforce_stored_bytes_quota` recomputes org storage by scanning every session row of the org on every segment push

- 3193–3223, called from every append (698–700) and rewrite (2269–2271): sums all segments of the session AND `sum(stored_bytes)` over ALL `cloud_sessions` of the org (tombstones included, never GC'd; comment 3209–3210). Neither column is in any index. 10^5 rows read per push, per actively syncing member, while holding the org signal-row lock (C1).

**Fix:** delta-maintained org byte counter (append: `v_upload_bytes`; rewrite: new_total − old_total, old total already loaded FOR UPDATE) + nightly reconciliation. If recompute must stay: covering indexes `(org_id, session_id) include (byte_size)` and `(org_id) include (stored_bytes)`.

## HIGH

### H1. Lock-order inversion between `usage_monthly` and the signal row → deadlocks

- `cloud_upsert_session_metadata` first-insert path: `usage_monthly` upsert (2966–2971, lock A) then `insert into cloud_sessions` (2977) → trigger → signal-row lock B.
- `cloud_append_session_events`: `update cloud_sessions` (689) → lock B first, then `bump_monthly_upload_quota` → lock A (300–305, called at 703). Same in rewrite (2260 → 2274).
- Two members of one org (one creating, one pushing) = classic 40P01; frequency grows quadratically with concurrent sync. `usage_monthly (org_id, period)` is itself a second org-wide hot row.

**Fix:** unify order — bump upload quota _before_ the `cloud_sessions` update in append/rewrite.

### H2. `cloud_get_session_events` returns the entire replay as one jsonb value; no per-session size cap

- 1451–1473: `jsonb_agg` of every segment's `payload_gz` for the epoch; `p_after_seq` only helps re-pulls. Org-level quotas only (1GB free / 10GB pro / 100GB team) — a single session can hold the entire org quota and becomes permanently unreadable (memory blow-up, ~1GB varlena ceiling, 8s timeout). Rewrite has the same wall (2224–2258 deletes + reinserts all segments in one txn).

**Fix:** page by seq via PK `(org_id, session_id, epoch, seq)` (3863): `p_max_segments`/byte budget + `hasMore`; client already loops on `afterSeq`.

### H3. `cloud_list_org_collab_state` full pull returns every project/work-item version ever, tombstones included, forever

- 1581–1618: `since` defaults to epoch 1970; tombstones intentionally returned and never hard-deleted; no LIMIT; payloads up to 64KB each. Cold-start pull grows monotonically for org lifetime.

**Fix:** keyset pagination on existing `(org_id, updated_at)` indexes (4078, 4022) + tombstone GC (hard-delete `deleted_at < now() - 90d` via pg_cron; clients with pre-GC cursors do a full resync).

### H4. Realtime postgres_changes: per-subscriber RLS evaluation on every signal bump + platform quotas

- Clients subscribe postgres_changes on `org_change_signals` (RLS `is_org_member`, 5614–5615) and `org_memberships` (REPLICA IDENTITY FULL, 5621–5622). Supabase's WAL poller is single-threaded and evaluates RLS per change × per subscriber; all orgs share one signals table so matching scales with TOTAL connected desktops.
- Quotas: concurrent connections ~200 Free / 500 Pro before add-ons; messages ~2M/mo Free, ~5M/mo Pro. A 20-member org doing ~2k writes/day ≈ 2.4M messages/mo alone — the first platform limit this schema hits.

**Fix:** move the nudge to Broadcast from Database (`realtime.broadcast_changes` on topic `org:<id>`): private-channel auth evaluated once at join (the `realtime.messages` policies already exist, 5694–5706). Keep postgres_changes only for the self-row `org_memberships` eviction path.

### H5. Replay bytes live in Postgres as base64 TEXT with 100GB/org entitlements

- `cloud_session_segments.payload_gz text` (3606); base64 +33% over gzip; all in primary Postgres volume (backups/PITR/WAL/replicas). A few team orgs near entitlement = TB-scale Postgres.

**Fix:** move payloads to Supabase Storage keyed `(org, session, epoch, seq, hash)`; keep pointer + byte_size + hash rows; serve via signed URLs. Interim: `bytea` (−25%).

## MEDIUM

### M1. Every work-item upsert takes FOR UPDATE on the owning project row

- 3026–3031 + allocator update 3110–3113. N members editing N different items of one project fully serialize (~50–100 writes/s per project, org-wide, stacked under C1). **Fix:** take the project lock only around the `next_work_item_id` advance; rely on the advisory item lock (3036–3038) otherwise, keeping project-then-item order.

### M2. `cloud_delete_account` is one transaction through the caller's PostgREST connection

- 789–911; web route runs with caller JWT (route.ts:40–42). Missing indexes for user-id predicates: `cloud_sessions(owner_user_id)`, `cloud_session_comments(author_user_id)`, `cloud_session_shares(grantee_user_id)/(owner_user_id)`, `subscriptions(owner_user_id)`. FK cascade deletes potentially GBs of segments under an 8s timeout → heavy users can't be erased (GDPR risk).
  **Fix:** add the indexes; move execution to a service-role background job that batch-deletes segments first.

### M3. No index serves the retention-window predicate on free-plan listings

- Filter `s.last_activity_at > now() - make_interval(...)` (5550–5553); only PK + `(org_id, updated_at)` exist. **Fix:** `create index on cloud_sessions (org_id, last_activity_at desc) where deleted_at is null;`

### M4. Unpaginated comment listing + refetch-on-nudge herd

- `cloud_list_session_comments` (5312–5345) ships all rows (≤500 cap incl. tombstones, ~2MB worst case) with per-comment profiles join; every comment bumps the org signal → every open member re-pulls the full thread. **Fix:** delta via `p_since` (index 4029 exists) or scope the nudge to the session via Broadcast.

## LOW

- L1: append path deletes + reinserts the seq-0 tail row per push (670–687); delete predicate lacks `epoch`. Bloat amplifier; monitor autovacuum.
- L2: forever-growing bookkeeping — `stripe_webhook_events` (no pruning), `org_repo_scope_events` (reads windowed by index 4106, storage-only cost), comment tombstones consume the 500 cap permanently (spam-then-delete permanently caps a thread).
- L3: quota COUNT(\*) gates verified fine (seat counts, comment cap under advisory lock, last-admin counts — all bounded).

## Top 5 first

1. Redesign the signal fan-out (C1) — org write-throughput ceiling AND realtime message burner.
2. Paginate `cloud_list_org_sessions` (C2) + materialized comment counts.
3. O(1) storage-quota enforcement (C3).
4. Fix the usage_monthly ↔ signal lock-order inversion (H1) — one-line reorder.
5. Page `cloud_get_session_events` (H2) and plan the Storage migration (H5).
