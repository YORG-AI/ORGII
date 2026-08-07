//! Write / mutation database operations against `projects.db`.
//!
//! All functions here perform INSERT, UPDATE, or DELETE operations on
//! `outbox_entries` or the `projects` sync columns. The atomic claim
//! path is the centerpiece: a single UPDATE … SET status='in_flight'
//! WHERE id=? AND status='pending' moves a row out of the pending pool
//! with no race window.

use rusqlite::{params, Connection, OptionalExtension};

use super::super::types::{EntityType, OutboxEntry, OutboxOp, OutboxStatus};
use super::{
    read::{load_by_id, read_adapter_binding, SyncCursor},
    MAX_RETRY_COUNT, RETRY_BACKOFF_SECS,
};

// ── Outbox append ─────────────────────────────────────────────────────────────

/// Append a new outbox row. Returns the assigned `id`.
pub fn append(c: &Connection, entry: &OutboxEntry) -> Result<i64, String> {
    c.execute(
        "INSERT INTO outbox_entries
            (project_slug, entity_type, entity_id, op, field_path,
             payload_json, created_at, retry_count, last_attempted_at,
             last_error, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            entry.project_slug,
            entry.entity_type.as_db_str(),
            entry.entity_id,
            entry.op.as_db_str(),
            entry.field_path,
            entry.payload_json,
            entry.created_at,
            entry.retry_count,
            entry.last_attempted_at,
            entry.last_error,
            entry.status.as_db_str(),
        ],
    )
    .map_err(|err| format!("DB error (insert outbox): {}", err))?;
    Ok(c.last_insert_rowid())
}

/// Record a local user-driven update by appending one `update` outbox
/// row, **only if** the project is currently bound to an adapter
/// (`sync_kind != 'none'`). For unbound projects this is a no-op so
/// the outbox doesn't accumulate dead entries for users who never
/// configured sync.
///
/// `changed_fields` lists the canonical sync-tracked field names that
/// the caller mutated (matching
/// [`crate::sync::adapter::EntityField::as_local_name`]).
/// `payload` is the full JSON object holding each changed field's new
/// value — adapters use this directly when constructing their push
/// payloads, so the outbox row is self-contained and the adapter
/// doesn't need to re-read the work item from the DB.
///
/// `field_path` on the row carries the comma-joined `changed_fields`
/// for observability (`project_sync_status` uses it to surface
/// "changed: title, status" to users) and so adapters that prefer a
/// list-based input can split it back without re-deriving from the
/// payload keys.
pub fn record_local_update(
    project_slug: &str,
    short_id: &str,
    changed_fields: &[&'static str],
    payload: &serde_json::Value,
) -> Result<(), String> {
    if changed_fields.is_empty() {
        return Ok(());
    }
    let connection = super::conn()?;
    if read_adapter_binding(&connection, project_slug)?.is_none() {
        // Adapter binding and collab-org sync are mutually exclusive per
        // project (design §16.10): with no adapter bound, a project whose
        // org is collab-synced routes the change to the orgii_collab
        // bridge queue instead.
        crate::sync::collab_bridge::record_project_work_item_update(
            &connection,
            project_slug,
            short_id,
            changed_fields,
        )?;
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let entry = OutboxEntry {
        id: None,
        project_slug: project_slug.to_string(),
        entity_type: EntityType::WorkItem,
        entity_id: short_id.to_string(),
        op: OutboxOp::Update,
        field_path: Some(changed_fields.join(",")),
        payload_json: payload.to_string(),
        created_at: now,
        retry_count: 0,
        last_attempted_at: None,
        last_error: None,
        status: OutboxStatus::Pending,
    };
    append(&connection, &entry)?;
    Ok(())
}

// ── Atomic claim ──────────────────────────────────────────────────────────────

/// Atomically claim the next pending row whose retry-eligibility delay
/// has elapsed. Returns `Ok(None)` when the pending pool is empty or
/// every pending row is still backing off.
///
/// The two-step (`SELECT id` then `UPDATE WHERE status='pending'`)
/// would race against another worker; the WHERE clause matches `id` AND
/// `status='pending'` so `UPDATE … RETURNING` wins atomically.
pub fn claim_next_pending(c: &Connection, now_ms: i64) -> Result<Option<OutboxEntry>, String> {
    // Pull-cycle artifacts (`merge_external`) are owned by the
    // resolver; the push path must skip them or they'd be
    // dispatched to adapters that reject them as Permanent and
    // immediately abandon. Filtering at claim time keeps the
    // discrimination in one place rather than scattered across every
    // adapter's push implementation.
    //
    // Rows with a non-NULL `org_id` belong to the orgii_collab TS
    // bridge (see `crate::sync::collab_bridge`); the worker must not
    // claim them — process_entry would resolve `sync_kind='none'` and
    // mark them succeeded as a no-op before the bridge ever drained
    // them.
    let candidate: Option<i64> = c
        .query_row(
            "SELECT id FROM outbox_entries
             WHERE status = ?1
               AND op != ?3
               AND org_id IS NULL
               AND (last_attempted_at IS NULL OR last_attempted_at <= ?2)
             ORDER BY created_at ASC, id ASC
             LIMIT 1",
            params![
                OutboxStatus::Pending.as_db_str(),
                now_ms,
                crate::sync::types::OutboxOp::MergeExternal.as_db_str(),
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("DB error (claim outbox): {}", err))?;

    let Some(id) = candidate else {
        return Ok(None);
    };

    let updated = c
        .execute(
            "UPDATE outbox_entries
                SET status = ?1, last_attempted_at = ?2
              WHERE id = ?3 AND status = ?4",
            params![
                OutboxStatus::InFlight.as_db_str(),
                now_ms,
                id,
                OutboxStatus::Pending.as_db_str()
            ],
        )
        .map_err(|err| format!("DB error (claim update): {}", err))?;

    if updated == 0 {
        // Lost the race to another worker; let the caller retry.
        return Ok(None);
    }

    Ok(Some(load_by_id(c, id)?))
}

/// Atomically claim the next pending `merge_external` row. Mirrors
/// [`claim_next_pending`] but inverted on `op`: only `merge_external`
/// rows are eligible. Used by [`super::super::worker::merge_cycle`] so the
/// resolver and the push path can drain independent queues without
/// stepping on each other.
pub fn claim_next_merge_external(
    c: &Connection,
    now_ms: i64,
) -> Result<Option<OutboxEntry>, String> {
    let candidate: Option<i64> = c
        .query_row(
            "SELECT id FROM outbox_entries
             WHERE status = ?1
               AND op = ?3
               AND org_id IS NULL
               AND (last_attempted_at IS NULL OR last_attempted_at <= ?2)
             ORDER BY created_at ASC, id ASC
             LIMIT 1",
            params![
                OutboxStatus::Pending.as_db_str(),
                now_ms,
                crate::sync::types::OutboxOp::MergeExternal.as_db_str(),
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("DB error (claim merge_external): {}", err))?;

    let Some(id) = candidate else {
        return Ok(None);
    };

    let updated = c
        .execute(
            "UPDATE outbox_entries
                SET status = ?1, last_attempted_at = ?2
              WHERE id = ?3 AND status = ?4",
            params![
                OutboxStatus::InFlight.as_db_str(),
                now_ms,
                id,
                OutboxStatus::Pending.as_db_str()
            ],
        )
        .map_err(|err| format!("DB error (merge claim update): {}", err))?;

    if updated == 0 {
        return Ok(None);
    }

    Ok(Some(load_by_id(c, id)?))
}

// ── Status transitions ────────────────────────────────────────────────────────

/// Mark an in-flight row as succeeded. Idempotent.
pub fn mark_succeeded(c: &Connection, id: i64) -> Result<(), String> {
    c.execute(
        "UPDATE outbox_entries
            SET status = ?1, last_error = NULL
          WHERE id = ?2",
        params![OutboxStatus::Succeeded.as_db_str(), id],
    )
    .map_err(|err| format!("DB error (mark succeeded): {}", err))?;
    Ok(())
}

/// Mark a row as failed. Bumps `retry_count`, schedules the next
/// attempt via `RETRY_BACKOFF_SECS`, and transitions to `Abandoned`
/// once the budget is exhausted.
///
/// `now_ms` is the current wall clock (passed in for testability).
///
/// `force_abandon` short-circuits the backoff schedule for errors the
/// adapter classified as `Permanent` / `AuthFailed`: the row jumps
/// straight to `Abandoned` so the user retries explicitly via
/// `project_sync_force_push` after fixing the underlying issue.
pub fn mark_failed_with_backoff(
    c: &Connection,
    id: i64,
    now_ms: i64,
    error_message: &str,
    force_abandon: bool,
) -> Result<OutboxStatus, String> {
    let current_retry: u32 = c
        .query_row(
            "SELECT retry_count FROM outbox_entries WHERE id = ?1",
            [id],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|err| format!("DB error (load retry_count): {}", err))?;

    let next_retry = current_retry.saturating_add(1);
    let new_status = if force_abandon || next_retry >= MAX_RETRY_COUNT {
        OutboxStatus::Abandoned
    } else {
        OutboxStatus::Pending
    };

    let next_attempt_after = if matches!(new_status, OutboxStatus::Pending) {
        let idx = (next_retry as usize).saturating_sub(1);
        let secs = RETRY_BACKOFF_SECS
            .get(idx)
            .copied()
            .unwrap_or_else(|| RETRY_BACKOFF_SECS[RETRY_BACKOFF_SECS.len() - 1]);
        Some(now_ms.saturating_add((secs as i64).saturating_mul(1000)))
    } else {
        None
    };

    c.execute(
        "UPDATE outbox_entries
            SET status = ?1,
                retry_count = ?2,
                last_attempted_at = ?3,
                last_error = ?4
          WHERE id = ?5",
        params![
            new_status.as_db_str(),
            next_retry,
            next_attempt_after,
            error_message,
            id,
        ],
    )
    .map_err(|err| format!("DB error (mark failed): {}", err))?;

    Ok(new_status)
}

/// Demote every `in_flight` row back to `pending`. Called once at boot
/// from `worker::start_worker` to recover from a crash mid-push.
///
/// `last_attempted_at` is cleared so the row is immediately claimable
/// on the next push tick rather than respecting whatever stale backoff
/// stamp the previous process left behind.
pub fn reset_in_flight_to_pending(c: &Connection) -> Result<usize, String> {
    let updated = c
        .execute(
            "UPDATE outbox_entries
                SET status = ?1,
                    last_attempted_at = NULL
              WHERE status = ?2",
            params![
                OutboxStatus::Pending.as_db_str(),
                OutboxStatus::InFlight.as_db_str()
            ],
        )
        .map_err(|err| format!("DB error (reset in-flight): {}", err))?;
    Ok(updated)
}

/// Garbage-collect succeeded outbox rows older than `older_than_ms`.
/// Returns the number of rows actually deleted (capped at `limit`).
///
/// The worker runs this once per push cycle so the table
/// doesn't grow unboundedly. We retain succeeded rows for an audit
/// window (default 7 days) so a user investigating "why didn't this
/// edit reach Linear?" can still see the row's history. After the
/// window, the row is no longer useful — the adapter's external state
/// is now the source of truth and the local watermark in
/// `field_revisions` is enough to drive subsequent merges.
///
/// We bound `limit` per call so a long-stalled GC sweep can't block
/// the push cycle's actual work; the next tick picks up where this
/// one left off.
pub fn gc_succeeded(
    c: &Connection,
    now_ms: i64,
    older_than_ms: i64,
    limit: usize,
) -> Result<usize, String> {
    let cutoff = now_ms.saturating_sub(older_than_ms);
    let deleted = c
        .execute(
            "DELETE FROM outbox_entries
              WHERE id IN (
                  SELECT id FROM outbox_entries
                   WHERE status = ?1
                     AND created_at <= ?2
                   ORDER BY created_at ASC
                   LIMIT ?3
              )",
            params![OutboxStatus::Succeeded.as_db_str(), cutoff, limit as i64],
        )
        .map_err(|err| format!("DB error (gc succeeded): {}", err))?;
    Ok(deleted)
}

/// Force-requeue every `failed` and `abandoned` row for one project so
/// the user can manually retry through `project_sync_force_push`.
///
/// Resets `last_attempted_at` to `NULL` so the row is immediately
/// claimable on the next worker tick.
pub fn requeue_for_project(c: &Connection, project_slug: &str) -> Result<u64, String> {
    let updated = c
        .execute(
            "UPDATE outbox_entries
                SET status = ?1,
                    last_attempted_at = NULL
              WHERE project_slug = ?2
                AND status IN (?3, ?4)",
            params![
                OutboxStatus::Pending.as_db_str(),
                project_slug,
                OutboxStatus::Failed.as_db_str(),
                OutboxStatus::Abandoned.as_db_str()
            ],
        )
        .map_err(|err| format!("DB error (requeue): {}", err))?;
    Ok(updated as u64)
}

/// Requeue exactly one row by id. Flips status to `pending`, clears
/// `last_attempted_at` so the next push tick claims it immediately,
/// and clears `last_error` so the UI no longer surfaces the stale
/// failure. `retry_count` is intentionally **not** reset — it remains
/// the cumulative attempt counter for the row's lifetime so the
/// backoff schedule on the next genuine failure picks up where the
/// previous attempt left off.
///
/// Returns the `project_slug` of the touched row so the caller can
/// emit a `SyncStatusEvent` for the right project without a separate
/// SELECT round-trip. Returns an error when no row matched the id.
pub fn requeue_one(c: &Connection, entry_id: i64) -> Result<String, String> {
    let project_slug: String = c
        .query_row(
            "SELECT project_slug FROM outbox_entries WHERE id = ?1",
            [entry_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("DB error (load slug for requeue): {}", err))?
        .ok_or_else(|| format!("outbox row not found: id={}", entry_id))?;

    let updated = c
        .execute(
            "UPDATE outbox_entries
                SET status = ?1,
                    last_attempted_at = NULL,
                    last_error = NULL
              WHERE id = ?2",
            params![OutboxStatus::Pending.as_db_str(), entry_id],
        )
        .map_err(|err| format!("DB error (requeue_one): {}", err))?;
    if updated == 0 {
        return Err(format!("outbox row vanished mid-requeue: id={}", entry_id));
    }
    Ok(project_slug)
}

/// Hard-delete one outbox row by id. Returns the `project_slug` of
/// the deleted row (or an error when no row matched) so the caller
/// can emit a `SyncStatusEvent` after the delete commits.
///
/// **Why DELETE and not status='abandoned'?** `requeue_for_project`
/// (used by `project_sync_force_push`) re-queues both `Failed` and
/// `Abandoned` rows, so transitioning to `Abandoned` here would let
/// the next bulk force-push immediately un-discard everything the
/// user just discarded. Hard-delete is the only semantics that
/// honors the user's intent across both retry paths.
///
/// Idempotency: a second `discard_one` on the same id returns an
/// "outbox row not found" error rather than silently succeeding —
/// the UI is expected to remove the row from its local list on the
/// first success and never call again, so the second call is always
/// a bug worth surfacing.
pub fn discard_one(c: &Connection, entry_id: i64) -> Result<String, String> {
    let project_slug: String = c
        .query_row(
            "SELECT project_slug FROM outbox_entries WHERE id = ?1",
            [entry_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("DB error (load slug for discard): {}", err))?
        .ok_or_else(|| format!("outbox row not found: id={}", entry_id))?;

    let deleted = c
        .execute("DELETE FROM outbox_entries WHERE id = ?1", [entry_id])
        .map_err(|err| format!("DB error (discard_one): {}", err))?;
    if deleted == 0 {
        return Err(format!("outbox row vanished mid-discard: id={}", entry_id));
    }
    Ok(project_slug)
}

// ── Adapter binding writes ────────────────────────────────────────────────────

/// Bind a project to an adapter. Stored on the `projects` row so the
/// worker can resolve the adapter on the next push tick.
///
/// `adapter_id` MUST exist in `super::super::adapters::registry()`; callers
/// validate before calling.
pub fn attach_adapter(
    c: &Connection,
    project_slug: &str,
    adapter_id: &str,
    config_json: &str,
    connection_id: &str,
) -> Result<(), String> {
    let n = c
        .execute(
            "UPDATE projects
                SET sync_kind = ?1,
                    sync_config_json = ?2,
                    sync_connection_id = ?3
              WHERE slug = ?4",
            params![adapter_id, config_json, connection_id, project_slug],
        )
        .map_err(|err| format!("DB error (attach adapter): {}", err))?;
    if n == 0 {
        return Err(format!("project not found: {}", project_slug));
    }
    Ok(())
}

/// Unbind a project from any adapter; resets the sync_kind to `none`.
pub fn detach_adapter(c: &Connection, project_slug: &str) -> Result<(), String> {
    let n = c
        .execute(
            "UPDATE projects
                SET sync_kind = 'none',
                    sync_config_json = NULL,
                    sync_connection_id = NULL
              WHERE slug = ?1",
            params![project_slug],
        )
        .map_err(|err| format!("DB error (detach adapter): {}", err))?;
    if n == 0 {
        return Err(format!("project not found: {}", project_slug));
    }
    Ok(())
}

/// Persist the cursor + last-pull stamp after a successful pull cycle.
/// Atomic: both columns are updated in one statement so a partial write
/// can't leave the cursor newer than its stamp.
pub fn write_sync_cursor(
    c: &Connection,
    project_slug: &str,
    cursor: &SyncCursor,
) -> Result<(), String> {
    let updated = c
        .execute(
            "UPDATE projects
                SET sync_last_pull_at = ?1,
                    sync_cursor_blob = ?2
              WHERE slug = ?3",
            params![cursor.last_pull_at, cursor.cursor_blob, project_slug],
        )
        .map_err(|err| format!("DB error (write sync cursor): {}", err))?;
    if updated == 0 {
        return Err(format!("project not found: {}", project_slug));
    }
    Ok(())
}
