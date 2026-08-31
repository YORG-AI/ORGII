use rusqlite::{params, OptionalExtension, Transaction};

use crate::projects::types::WorkItemRun;

use super::error;
use super::store::db;

const PATH_LOCK_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

pub(super) fn acquire_path_lock(
    tx: &Transaction<'_>,
    run: &WorkItemRun,
    now: i64,
) -> Result<(), String> {
    if run.target_snapshot.allow_shared_checkout {
        return Ok(());
    }
    let Some(workspace_path) = run
        .target_snapshot
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    db(tx.execute(
        "DELETE FROM pm_work_item_path_locks WHERE lease_expires_at <= ?1",
        params![now],
    ))?;
    let expires_at = now.saturating_add(PATH_LOCK_TTL_MS);
    let changed = db(tx.execute(
        "INSERT INTO pm_work_item_path_locks (
             workspace_path, run_id, work_item_id, acquired_at,
             lease_expires_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?4)
         ON CONFLICT(workspace_path) DO UPDATE SET
             run_id = excluded.run_id,
             work_item_id = excluded.work_item_id,
             acquired_at = excluded.acquired_at,
             lease_expires_at = excluded.lease_expires_at,
             updated_at = excluded.updated_at
         WHERE pm_work_item_path_locks.run_id = excluded.run_id
            OR pm_work_item_path_locks.lease_expires_at <= excluded.acquired_at",
        params![workspace_path, run.id, run.work_item_id, now, expires_at],
    ))?;
    if changed == 0 {
        let owner: Option<(String, String)> = db(tx
            .query_row(
                "SELECT run_id, work_item_id FROM pm_work_item_path_locks
                 WHERE workspace_path = ?1",
                params![workspace_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        let detail = owner
            .map(|(owner_run, owner_item)| format!("{owner_run}:{owner_item}"))
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "{}:{}:{}",
            error::PATH_LOCKED,
            workspace_path,
            detail
        ));
    }
    Ok(())
}

pub(super) fn release_path_lock(tx: &Transaction<'_>, run_id: &str) -> Result<(), String> {
    db(tx.execute(
        "DELETE FROM pm_work_item_path_locks WHERE run_id = ?1",
        params![run_id],
    ))?;
    Ok(())
}
