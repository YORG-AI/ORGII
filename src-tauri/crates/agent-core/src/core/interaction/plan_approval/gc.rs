//! DB-backed persistence helpers, the standalone snapshot loader used by
//! read-only queries, and startup garbage collection for orphaned
//! pending-plan rows.

use tracing::{info, warn};

use super::persistence::{self, PendingPlanRow, PlanApprovalStore};
use super::resolution::{resolve_pending, PlanResolution};
use super::snapshot::PendingPlanApproval;

/// Run a blocking `rusqlite` call on the blocking pool, logging failures
/// instead of propagating them. Persistence errors must never block the
/// plan-approval flow — the in-memory slot is still authoritative for the
/// live session; DB sync is for cross-restart continuity only.
pub(super) async fn persist_blocking<F>(f: F)
where
    F: FnOnce() -> Result<(), persistence::StoreError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(f).await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => warn!("[plan_approval] DB write failed: {err}"),
        Err(err) => warn!("[plan_approval] DB write join error: {err}"),
    }
}

/// DB-only snapshot loader used by read-only Tauri queries that must
/// answer before any in-memory `AgentSession` has been registered
/// (e.g. first window focus after an app restart — the session record
/// exists in sqlite, but the agent pipeline has not run yet so no
/// `PlanApprovalManager` lives in memory).
///
/// Mirrors the file-existence gate from
/// [`PlanApprovalManager::rehydrate_from_db`]: if the plan file is
/// missing we delete the orphan row and return `None`, so the FE stops
/// painting a Build button for a plan the user already deleted on
/// disk. Unlike the manager version this function deliberately does
/// NOT broadcast `agent:plan_ready_for_approval` — the caller is a
/// synchronous UI query and the FE atom is updated through the query
/// result, not a bus event.
pub async fn load_snapshot_for_session(
    session_id: &str,
) -> Result<Option<PendingPlanApproval>, String> {
    let sid = session_id.to_string();
    let loaded = tokio::task::spawn_blocking(move || PlanApprovalStore::load_by_session(&sid))
        .await
        .map_err(|err| format!("[plan_approval] snapshot join error: {err}"))?
        .map_err(|err| format!("[plan_approval] snapshot load error: {err}"))?;

    let Some(row) = loaded else {
        return Ok(None);
    };

    if !std::path::Path::new(&row.plan_path).exists() {
        let sid = row.session_id.clone();
        persist_blocking(move || PlanApprovalStore::delete_by_session(&sid)).await;
        info!(
            "[plan_approval] Orphan row dropped: plan file missing (session={}, path={})",
            row.session_id, row.plan_path
        );
        return Ok(None);
    }

    // A pending plan survives mode switches — no exec-mode gate. The row
    // stays actionable from any mode until Build / Skip / supersede /
    // file-or-session deletion.

    Ok(Some(PendingPlanApproval::from_row(row)))
}

/// Startup garbage collection for orphaned pending-plan rows.
///
/// Scans the whole `pending_plan_approvals` table once and resolves as
/// `Orphaned` every row whose:
///   * plan file no longer exists on disk, OR
///   * session row no longer exists in either session store.
///
/// A session having left Plan mode is NOT an orphan condition: pending
/// plans are session-level state decoupled from the exec mode and must
/// survive mode switches and restarts.
/// Called once from app setup after the DB and bridges are initialized.
pub async fn gc_orphaned_pending_plans() {
    let rows = match tokio::task::spawn_blocking(PlanApprovalStore::list_all).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(err)) => {
            warn!("[plan_approval] GC scan failed: {err}");
            return;
        }
        Err(err) => {
            warn!("[plan_approval] GC join error: {err}");
            return;
        }
    };

    let mut collected = 0usize;
    for row in rows {
        let file_missing = !std::path::Path::new(&row.plan_path).exists();
        let session_exists = session_row_exists(&row.session_id);

        if file_missing || !session_exists {
            resolve_pending(&row.session_id, PlanResolution::Orphaned, None).await;
            collected += 1;
        }
    }

    if collected > 0 {
        info!("[plan_approval] GC resolved {collected} orphaned pending plan rows");
    }
}

pub(super) async fn persist_ready_row(previous_session_id: Option<String>, row: PendingPlanRow) {
    if let Some(sid) = previous_session_id {
        persist_blocking(move || PlanApprovalStore::delete_by_session(&sid)).await;
    }
    persist_blocking(move || PlanApprovalStore::upsert(&row)).await;
}

/// Best-effort check whether a session row exists in either store.
fn session_row_exists(session_id: &str) -> bool {
    if matches!(
        crate::session::persistence::get_session(session_id),
        Ok(Some(_))
    ) {
        return true;
    }
    matches!(
        crate::foundation::session_bridge::get_cli_tools_snapshot(session_id),
        Ok(Some(_))
    )
}
