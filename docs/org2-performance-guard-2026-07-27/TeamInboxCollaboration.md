# ORG2 Performance Guard — Team Inbox Multi-User Collaboration

**Date:** 2026-07-27

| Lifecycle / area | Active                                                                                                                                                         | Idle / hidden                                                     | Repeated open/close                                                                                                            | Verdict and verification                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Roster loading   | One demand read through the shared endpoint/account/org/revision coordinator.                                                                                  | No polling, timer, subscription, or worker added.                 | Cached coordinator result is reused; late identity responses are discarded and effects cancel commits after unmount.           | pass — code trace, ESLint, typecheck                    |
| Inbox listing    | Keyset pages are bounded to 100 rows; full unread total is computed server-side.                                                                               | No background pagination or retained scan.                        | Cache replaces the first page and appends later pages without duplicating authoritative counts.                                | pass — client unit tests and SQL review                 |
| Read mutations   | User-triggered, idempotent upsert/delete; optimistic UI is generation guarded and durable writes are serialized through a queue capped at 100 pending actions. | No retry loop beyond the existing bounded transport retry.        | Account/org generation rejects late completions; server totals repair count state; receipts remain one row per viewer/comment. | pass — focused client tests, typecheck, lifecycle trace |
| Mark all         | One explicit bulk upsert for currently eligible mentions.                                                                                                      | Does not run automatically.                                       | Primary key prevents growth from repeated invocation; returned count is recomputed to include concurrent mentions.             | pass — SQL lifecycle review                             |
| Comment mentions | At most 50 deduplicated member UUIDs per new comment.                                                                                                          | No retained composer data after successful submit.                | Failed submit preserves only local draft state; no duplicate background writer.                                                | pass — client unit tests and SQL validation             |
| Database access  | GIN lookup uses `mentioned_user_ids @> array[viewer]`; row ordering uses `(org_id, created_at desc, id desc)`.                                                 | No database work without a request.                               | Receipt lookup is primary-key/index backed; per-page thread counts are bounded by the page limit.                              | pass with live-query-plan follow-up after deployment    |
| Identity switch  | The active endpoint/account/org is part of the request key and every async path captures a load generation.                                                    | Previous rows/counts are evicted in a layout effect before paint. | Late initial-page, pagination, and receipt completions are discarded after a scope switch.                                     | pass — code trace, typecheck                            |

## Rejection-rule review

- No polling, timer, streaming loop, worker, unbounded cache, or cross-instance singleton was added.
- No scan is initiated while the Inbox is hidden.
- Viewer identity and org scope are part of every cache/request boundary, and prior-scope rows are cleared before paint.
- The only potentially growing state is durable receipt data, bounded to one row per mentioned viewer/comment and cascade-deleted with its org/comment.

## Verdict

- Performance verdict: pass.
- Deployment follow-up: capture `EXPLAIN (ANALYZE, BUFFERS)` for mention list/count on production-like cardinality after applying migration 0010.
