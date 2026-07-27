use rusqlite::{params, Connection, Result as SqliteResult, Transaction};

#[cfg(test)]
use super::TaskHistoryEvent;
use super::{Task, TaskStatus};

pub(super) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(super) fn encode_json_array(values: &[String]) -> Result<String, String> {
    let encoded =
        serde_json::to_string(values).map_err(|err| format!("encode JSON array: {err}"))?;
    let max_bytes = crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    if encoded.len() > max_bytes {
        return Err(format!(
            "encoded task dependency array must be <= {max_bytes} bytes (got {} bytes)",
            encoded.len()
        ));
    }
    Ok(encoded)
}

pub(super) fn decode_json_array(raw: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(raw).map_err(|err| format!("decode JSON array: {err}"))
}

pub(super) fn encode_metadata(
    metadata: Option<&serde_json::Value>,
) -> Result<Option<String>, String> {
    let encoded = metadata
        .map(|value| serde_json::to_string(value).map_err(|err| format!("encode metadata: {err}")))
        .transpose()?;
    if let Some(encoded) = encoded.as_deref() {
        let max_bytes = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
        if encoded.len() > max_bytes {
            return Err(format!(
                "task metadata must be <= {max_bytes} serialized bytes (got {} bytes)",
                encoded.len()
            ));
        }
    }
    Ok(encoded)
}

pub(super) fn decode_metadata(raw: Option<String>) -> Result<Option<serde_json::Value>, String> {
    raw.map(|s| serde_json::from_str(&s).map_err(|err| format!("decode metadata: {err}")))
        .transpose()
}

#[cfg(test)]
pub(super) fn status_from_optional_wire(
    value: Option<String>,
    column_index: usize,
) -> SqliteResult<Option<TaskStatus>> {
    value
        .map(|raw| {
            TaskStatus::from_wire(&raw).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    column_index,
                    rusqlite::types::Type::Text,
                    err.into(),
                )
            })
        })
        .transpose()
}

pub(super) const SELECT_COLUMNS: &str = "id,
        org_run_id,
        subject,
        description,
        active_form,
        owner,
        status,
        blocks_json,
        blocked_by_json,
        metadata_json,
        created_at,
        updated_at";

pub(super) fn row_to_task(row: &rusqlite::Row<'_>) -> SqliteResult<Task> {
    let blocks_json: String = row.get(7)?;
    let blocked_by_json: String = row.get(8)?;
    let metadata_raw: Option<String> = row.get(9)?;
    let status_raw: String = row.get(6)?;

    let task = Task {
        id: row.get(0)?,
        org_run_id: row.get(1)?,
        subject: row.get(2)?,
        description: row.get(3)?,
        active_form: row.get(4)?,
        owner: row.get(5)?,
        status: TaskStatus::from_wire(&status_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, err.into())
        })?,
        blocks: decode_json_array(&blocks_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, err.into())
        })?,
        blocked_by: decode_json_array(&blocked_by_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, err.into())
        })?,
        metadata: decode_metadata(metadata_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, err.into())
        })?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    };
    Ok(task)
}

#[cfg(test)]
pub(super) fn row_to_task_history_event(row: &rusqlite::Row<'_>) -> SqliteResult<TaskHistoryEvent> {
    let previous_status_raw: Option<String> = row.get(6)?;
    let next_status_raw: Option<String> = row.get(7)?;
    Ok(TaskHistoryEvent {
        id: row.get(0)?,
        org_run_id: row.get(1)?,
        task_id: row.get(2)?,
        event_type: row.get(3)?,
        previous_owner: row.get(4)?,
        next_owner: row.get(5)?,
        previous_status: status_from_optional_wire(previous_status_raw, 6)?,
        next_status: status_from_optional_wire(next_status_raw, 7)?,
        actor_member_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub(super) fn insert_task_history_event(
    tx: &Transaction<'_>,
    org_run_id: &str,
    task_id: &str,
    event_type: &str,
    previous: Option<&Task>,
    next: &Task,
    actor_member_id: Option<&str>,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO agent_org_task_events (
            id, org_run_id, task_id, event_type, previous_owner, next_owner,
            previous_status, next_status, actor_member_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            uuid::Uuid::new_v4().to_string(),
            org_run_id,
            task_id,
            event_type,
            previous.and_then(|task| task.owner.as_deref()),
            next.owner.as_deref(),
            previous.map(|task| task.status.as_wire()),
            next.status.as_wire(),
            actor_member_id,
            &next.updated_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn list_tasks_with_conn(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<Task>, String> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
         WHERE org_run_id = ?1
         ORDER BY created_at ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![org_run_id], row_to_task)
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| err.to_string())?);
    }
    let graph = super::TaskGraphIndex::new(&out);
    graph.apply_projection(&mut out);
    Ok(out)
}
