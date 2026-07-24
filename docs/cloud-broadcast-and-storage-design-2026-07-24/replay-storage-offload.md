# Replay Segment Payload Offload to Supabase Storage (audit item H5)

Date: 2026-07-24. Basis: segment-lifecycle architecture map (agent survey of
0001/0002/0003 + client push/pull paths). Companion: `broadcast-change-signals.md`.

## Decision summary

| Question                | Decision                                                                                                                                     | Why                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What moves to Storage   | **Frozen segments only** (`seq >= 1`)                                                                                                        | Immutable + append-only + the bulk of bytes. No overwrite churn, no orphan risk on the hot path.                                                                                                                               |
| What stays in Postgres  | **Tail (`seq = 0`) stays `payload_gz` inline**                                                                                               | Mutable, rewritten every push, small (recent non-terminal events). Keeps append OCC single-transaction.                                                                                                                        |
| Object encoding         | raw gzip bytes (`application/gzip`)                                                                                                          | Drops the base64 +33% leg entirely; codec already isolates the base64 step (`segmentCodec.ts`).                                                                                                                                |
| Object key              | `replay/{org_id}/{session_id}/{epoch}/{seq}-{segment_hash}.gz`                                                                               | Immutable-by-name; hash in key makes retry idempotent and collision-safe inside the org/session auth domain (no cross-tenant dedup by design — see SharedSessionPerformance.md side-channel note).                             |
| Member reads/writes     | **Direct Storage REST with user JWT + storage RLS**                                                                                          | The whole member auth ladder (membership → retention → metadata_only → restricted-visibility grant) is already SQL (`assert_session_readable`); a `security definer` helper called from the storage policy reuses it verbatim. |
| Share-token guest reads | **Vercel signer route** (`apps/org2-cloud-web`, has `SUPABASE_SERVICE_ROLE_KEY`)                                                             | Guest tier has no `auth` role, inexpressible in storage RLS. RPC mints a short-lived grant; the route redeems it and returns signed URLs. Rare path.                                                                           |
| Atomicity               | **Upload blobs first, then commit manifest RPC**                                                                                             | RPC verifies each object exists in `storage.objects` and reads its真实 size from object metadata — server-measured bytes, no client attestation. Missing object ⇒ `ORG2_VALIDATION`, nothing committed.                        |
| Quota unit              | `byte_size` = raw object bytes (frozen) / `octet_length(payload_gz)` (tail, unchanged)                                                       | −25% vs base64 accounting: quotas get slightly looser, matches what is actually stored. Documented, not compensated.                                                                                                           |
| Orphan GC               | SQL view `replay_orphan_objects` (objects with no matching segment row, older than 24h) + service-role sweep via Storage API (Vercel cron)   | Postgres FK cascade cannot delete bucket objects; rewrite/delete-account leave objects behind by design and the sweep reaps them.                                                                                              |
| Rollout                 | Additive: `cloud_session_segments.storage_path text null`; null = legacy inline. Read RPCs return `storagePath` XOR `payloadGz` per segment. | Old clients fail closed on new-format sessions (zod `payloadGz` missing ⇒ import error, no corruption). Pre-release population is auto-updating; accepted.                                                                     |

## Server (cloud-infra migration, offline-validatable parts)

1. `cloud_session_segments.storage_path text` + relax `payload_gz` to nullable
   with `check ((payload_gz is not null) or (storage_path is not null))` and
   `check (seq = 0 → payload_gz is not null)` (tail always inline).
2. Bucket `replay` (private) + storage RLS policies delegating to
   `org2_cloud.can_read_replay_object(name)` / `can_write_replay_object(name)`
   security-definer helpers (path parse → session ladder / owner+entitlement
   gates + epoch/seq sanity).
3. `cloud_append_session_events` / `cloud_rewrite_session_events`: frozen
   segment wire accepts `{seq, storagePath, eventCount, segmentHash}` as an
   alternative to `payloadGz`; on the storage form the RPC looks the object up
   in `storage.objects` (existence + `(metadata->>'size')::bigint` + key must
   embed the claimed `segment_hash`), charges quota with the object size, and
   stores `storage_path`. Legacy inline form byte-identical behavior.
4. `cloud_get_session_events(_page)`: rows return `storagePath` when set,
   `payloadGz` otherwise. Guest grant RPC `cloud_authorize_replay_read` +
   redeem RPC (service-role) for the signer route.
5. `reconcile_org_stored_bytes` unchanged (byte_size stays truthful).
6. `replay_orphan_objects` view + `gc_replay_orphans` bookkeeping (row side);
   object deletion happens in the cron sweeper, not SQL.

## Client (ORGII)

- Push seam: inside `org2CloudSyncClient.appendSessionEvents`/`rewrite…` —
  before the RPC, upload each frozen segment's raw gzip bytes via
  `PUT /storage/v1/object/replay/{key}` (JWT), bounded concurrency (reuse
  `mapSegmentsBounded` cap 4); segment wire swaps `payloadGz` →
  `storagePath`. Tail keeps the base64 inline path.
- Pull seam: `decodeCloudSegments` (`org2CloudBackendAdapter.ts`) — when a
  segment carries `storagePath`, `GET /storage/v1/object/replay/{key}` (JWT)
  → gunzip raw bytes; integrity check unchanged (sha256 of pre-gzip bytes vs
  `segmentHash`). Share-token imports call the signer route first.
- Capability fallback mirror of the 0004 pattern: on storage-form rejection
  (pre-migration backend), remember per endpoint and fall back to inline
  wire. Full backward compatibility both directions.

## Explicitly out of scope

- Migrating EXISTING inline segments (backfill mover is a later service-role
  batch job; inline reads stay supported indefinitely).
- TUS/resumable uploads (objects are ≤ ~256 KiB pre-gzip; far below 6 MB).
- Cross-org content dedup (side channel, rejected in SharedSessionPerformance).

## Validation plan

- Offline (brew PG + storage schema stub): migration idempotency, wire A/B
  (inline form byte-identical vs 0004 DB), manifest commit vs missing object,
  quota deltas with mixed inline/storage segments, orphan view correctness.
- Live: real Storage bucket + policies (user pastes migration, bucket created
  via dashboard or SQL insert into storage.buckets), dual-instance push/pull,
  cmd+5 + CPU/RAM per standing rule.
