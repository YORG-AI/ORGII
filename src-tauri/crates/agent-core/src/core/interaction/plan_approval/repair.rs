//! Startup repair for half-committed `create_plan` calls, and the
//! revision-id listing used by the startup repair scan.

use std::path::{Path, PathBuf};

use tracing::{info, warn};

use super::persistence::{PendingPlanRow, PlanApprovalStore};
use super::snapshot::{plan_id_for, revision_id_for};

/// Startup repair for half-committed `create_plan` calls.
///
/// Covers the failure window where `create_plan` wrote the plan file and the
/// tool-call event, but the process was stopped before `mark_ready` inserted a
/// pending row and before the tool_result was persisted.
pub async fn repair_orphaned_create_plan_submissions() {
    let repaired =
        match tokio::task::spawn_blocking(repair_orphaned_create_plan_submissions_sync).await {
            Ok(Ok(count)) => count,
            Ok(Err(err)) => {
                warn!("[plan_approval] orphan create_plan repair failed: {err}");
                return;
            }
            Err(err) => {
                warn!("[plan_approval] orphan create_plan repair join error: {err}");
                return;
            }
        };

    if repaired > 0 {
        info!("[plan_approval] Repaired {repaired} orphaned create_plan submission(s)");
    }
}

#[derive(Debug)]
struct OrphanCreatePlanSubmission {
    session_id: String,
    tool_call_id: String,
    title: String,
    content: String,
    workspace_path: Option<String>,
    created_at_ms: i64,
    pending_created_at_ms: Option<i64>,
}

pub(super) fn repair_orphaned_create_plan_submissions_sync(
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let conn = database::db::get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT e.session_id,
                e.id,
                e.args_json,
                e.created_at,
                s.workspace_path,
                p.created_at
         FROM events e
         JOIN session_turns t
           ON t.session_id = e.session_id
          AND t.status = 'pending'
          AND e.history_sequence >= t.start_sequence
          AND (t.end_sequence IS NULL OR e.history_sequence <= t.end_sequence)
         LEFT JOIN agent_sessions s ON s.session_id = e.session_id
         LEFT JOIN pending_plan_approvals p ON p.session_id = e.session_id
         WHERE e.function_name = 'create_plan'
           AND e.event_type = 'tool_call'
           AND (p.session_id IS NULL OR e.created_at > datetime(p.created_at / 1000, 'unixepoch'))
           AND NOT EXISTS (
               SELECT 1 FROM events r
                WHERE r.session_id = e.session_id
                  AND r.event_type = 'tool_result'
                  AND json_extract(r.meta_json, '$.callId') = json_extract(e.meta_json, '$.callId')
           )
         ORDER BY e.session_id ASC, e.history_sequence DESC",
    )?;

    let rows = stmt
        .query_map([], |row| {
            let event_id: String = row.get(1)?;
            let args_json: String = row.get(2)?;
            let args: serde_json::Value = serde_json::from_str(&args_json).unwrap_or_default();
            let title = args
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Plan")
                .to_string();
            let content = args
                .get("content")
                .or_else(|| args.get("streamContent"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            Ok(OrphanCreatePlanSubmission {
                session_id: row.get(0)?,
                tool_call_id: event_id
                    .strip_prefix("tool-call-")
                    .unwrap_or(&event_id)
                    .to_string(),
                title,
                content,
                workspace_path: row.get(4)?,
                created_at_ms: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(3)?)
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis()),
                pending_created_at_ms: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut repaired = 0usize;
    let mut seen_sessions = std::collections::HashSet::new();
    for row in rows {
        if !seen_sessions.insert(row.session_id.clone()) {
            continue;
        }
        if row.content.is_empty()
            || row
                .pending_created_at_ms
                .is_some_and(|created| row.created_at_ms <= created)
        {
            continue;
        }
        let Some(plan_path) = find_existing_plan_path(&row) else {
            continue;
        };
        let plan_path = plan_path.to_string_lossy().into_owned();
        let plan_id = plan_id_for(&row.session_id, &plan_path);
        let plan_revision_id = revision_id_for(Some(&row.tool_call_id), &plan_id);
        let pending = PendingPlanRow {
            session_id: row.session_id,
            tool_call_id: Some(plan_revision_id.clone()),
            plan_id,
            plan_revision_id,
            origin_tool_call_id: Some(row.tool_call_id),
            plan_path,
            plan_title: row.title,
            plan_content: row.content,
            created_at_ms: row.created_at_ms,
        };
        PlanApprovalStore::upsert(&pending)?;
        repaired += 1;
    }

    Ok(repaired)
}

fn find_existing_plan_path(row: &OrphanCreatePlanSubmission) -> Option<PathBuf> {
    let workspace = row.workspace_path.as_deref().map(Path::new)?;
    let dir = workspace.join(".orgii").join("plans");
    let slug = crate::session::plan_mode::slugify_plan_title(&row.title);
    let prefix = format!("{slug}_");
    let mut candidates = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".plan.md"))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    candidates
        .into_iter()
        .rev()
        .find(|path| std::fs::read_to_string(path).is_ok_and(|content| content == row.content))
}

/// List every live pending plan's revision id. Used by the startup repair
/// scan to distinguish legitimately-awaiting `create_plan` events from
/// historical strands whose row is gone.
pub fn pending_revision_ids() -> Result<Vec<String>, String> {
    PlanApprovalStore::list_all()
        .map(|rows| rows.into_iter().map(|row| row.plan_revision_id).collect())
        .map_err(|err| err.to_string())
}
