use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::projects::types::{WorkItemRun, WorkItemRunStatus, PERSONAL_ORG_ID};
use crate::work_service;

use super::error;

const RUN_COLUMNS: &str = "id, project_slug, org_id, work_item_id, trigger_json,
    target_json, input_json, status, attempt, max_attempts, parent_run_id,
    session_id, failure_json, usage_json, idempotency_key, generation,
    created_at, updated_at, started_at, completed_at";

pub(super) fn db<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|err| format!("work run store: {err}"))
}

pub(super) fn iso8601(epoch_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(epoch_ms)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| epoch_ms.to_string())
}

pub(super) fn scope_key(project_slug: Option<&str>, org_id: &str) -> String {
    match project_slug {
        Some(slug) => format!("project:{slug}"),
        None => format!("org:{org_id}"),
    }
}

/// Session-plane org scopes may arrive as `cloud:<uuid>`, while the PM store
/// persists the local project-org id without that transport prefix. Unknown
/// scopes follow the same contract as standalone Work Item bootstrap and land
/// in the personal org rather than creating an unreadable split scope.
pub(super) fn canonical_standalone_org_id(
    connection: &Connection,
    raw_org_id: &str,
) -> Result<String, String> {
    let bare = raw_org_id
        .trim()
        .strip_prefix("cloud:")
        .unwrap_or(raw_org_id.trim());
    if bare.is_empty() || bare == PERSONAL_ORG_ID {
        return Ok(PERSONAL_ORG_ID.to_string());
    }
    let exists = db(connection
        .query_row(
            "SELECT 1 FROM project_orgs WHERE id = ?1",
            params![bare],
            |_| Ok(()),
        )
        .optional())?
    .is_some();
    Ok(if exists {
        bare.to_string()
    } else {
        PERSONAL_ORG_ID.to_string()
    })
}

#[allow(clippy::type_complexity)]
fn query_stored_run(
    connection: &Connection,
    run_id: &str,
) -> Result<
    Option<(
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
    )>,
    String,
> {
    let sql = format!("SELECT {RUN_COLUMNS} FROM pm_work_item_runs WHERE id = ?1");
    db(connection
        .query_row(&sql, params![run_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
            ))
        })
        .optional())
}

fn decode_run(connection: &Connection, run_id: &str) -> Result<Option<WorkItemRun>, String> {
    let Some((
        id,
        project_slug,
        org_id,
        work_item_id,
        trigger_json,
        target_json,
        input_json,
        status,
        attempt,
        max_attempts,
        parent_run_id,
        session_id,
        failure_json,
        usage_json,
        idempotency_key,
        generation,
        created_at,
        updated_at,
        started_at,
        completed_at,
    )) = query_stored_run(connection, run_id)?
    else {
        return Ok(None);
    };

    let trigger = serde_json::from_str(&trigger_json)
        .map_err(|err| format!("work run {id}: invalid trigger snapshot: {err}"))?;
    let target_snapshot = serde_json::from_str(&target_json)
        .map_err(|err| format!("work run {id}: invalid target snapshot: {err}"))?;
    let input = serde_json::from_str(&input_json)
        .map_err(|err| format!("work run {id}: invalid input snapshot: {err}"))?;
    let failure = failure_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|err| format!("work run {id}: invalid failure snapshot: {err}"))?;
    let usage = usage_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|err| format!("work run {id}: invalid usage snapshot: {err}"))?
        .unwrap_or_default();

    Ok(Some(WorkItemRun {
        id,
        project_slug,
        org_id,
        work_item_id,
        trigger,
        target_snapshot,
        input,
        status: WorkItemRunStatus::try_from(status.as_str())?,
        attempt: u32::try_from(attempt)
            .map_err(|_| format!("work run attempt out of range: {attempt}"))?,
        max_attempts: u32::try_from(max_attempts)
            .map_err(|_| format!("work run max_attempts out of range: {max_attempts}"))?,
        parent_run_id,
        session_id,
        failure,
        usage,
        idempotency_key,
        generation: u64::try_from(generation)
            .map_err(|_| format!("work run generation out of range: {generation}"))?,
        created_at: iso8601(created_at),
        updated_at: iso8601(updated_at),
        started_at: started_at.map(iso8601),
        completed_at: completed_at.map(iso8601),
    }))
}

pub(super) fn require_run(connection: &Connection, run_id: &str) -> Result<WorkItemRun, String> {
    decode_run(connection, run_id)?.ok_or_else(|| format!("{}:{}", error::NOT_FOUND, run_id))
}
pub(super) fn append_audit(
    tx: &Transaction<'_>,
    run_id: &str,
    operation: &str,
    revision: i64,
    project_slug: Option<&str>,
    org_id: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let seq = work_service::audit::bump_change_seq(tx)?;
    work_service::audit::append_audit_event(
        tx,
        &work_service::audit::AuditEventRow {
            operation,
            entity_type: "work_item_run",
            entity_id: run_id,
            project_slug,
            org_id: Some(org_id),
            actor: None,
            revision,
            seq,
            payload,
        },
    )
}
