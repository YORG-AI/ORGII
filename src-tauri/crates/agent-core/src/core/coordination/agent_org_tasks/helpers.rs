use rusqlite::{params, Connection, Result as SqliteResult, Transaction};

#[cfg(test)]
use super::TaskHistoryEvent;
use super::{Task, TaskExecutionMode, TaskOutput, TaskStatus, TaskTerminalReason};

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

pub(super) fn encode_optional_json<T: serde::Serialize>(
    label: &str,
    value: Option<&T>,
) -> Result<Option<String>, String> {
    value
        .map(|value| serde_json::to_string(value).map_err(|err| format!("encode {label}: {err}")))
        .transpose()
}

fn decode_optional_json<T: serde::de::DeserializeOwned>(
    raw: Option<String>,
    column_index: usize,
    label: &str,
) -> SqliteResult<Option<T>> {
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                column_index,
                rusqlite::types::Type::Text,
                format!("decode {label}: {err}").into(),
            )
        })
    })
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
        execution_mode,
        blocked_by_json,
        metadata_json,
        output_json,
        failure_reason_json,
        cancel_reason_json,
        created_by_participant_id,
        source_turn_intent_id,
        originating_message_id,
        replaces_task_id,
        created_at,
        updated_at";

pub(super) fn row_to_task(row: &rusqlite::Row<'_>) -> SqliteResult<Task> {
    let blocked_by_json: String = row.get(8)?;
    let metadata_raw: Option<String> = row.get(9)?;
    let output_raw: Option<String> = row.get(10)?;
    let failure_reason_raw: Option<String> = row.get(11)?;
    let cancel_reason_raw: Option<String> = row.get(12)?;
    let status_raw: String = row.get(6)?;
    let execution_mode_raw: String = row.get(7)?;

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
        execution_mode: TaskExecutionMode::from_wire(&execution_mode_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, err.into())
        })?,
        blocks: Vec::new(),
        blocked_by: decode_json_array(&blocked_by_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, err.into())
        })?,
        metadata: decode_metadata(metadata_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, err.into())
        })?,
        output: decode_optional_json::<TaskOutput>(output_raw, 10, "task output")?,
        failure_reason: decode_optional_json::<TaskTerminalReason>(
            failure_reason_raw,
            11,
            "task failure reason",
        )?,
        cancel_reason: decode_optional_json::<TaskTerminalReason>(
            cancel_reason_raw,
            12,
            "task cancel reason",
        )?,
        created_by_participant_id: row.get(13)?,
        source_turn_intent_id: row.get(14)?,
        originating_message_id: row.get(15)?,
        replaces_task_id: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
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
        actor_kind: row.get(9)?,
        source_turn_intent_id: row.get(10)?,
        created_at: row.get(11)?,
    })
}

#[cfg(test)]
pub(super) fn insert_task_history_event(
    tx: &Transaction<'_>,
    org_run_id: &str,
    task_id: &str,
    event_type: &str,
    previous: Option<&Task>,
    next: &Task,
    actor_member_id: Option<&str>,
) -> Result<(), String> {
    let actor_kind =
        if actor_member_id == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID) {
            "graph_writer"
        } else if actor_member_id.is_some() {
            "owner_execution"
        } else {
            "system"
        };
    tx.execute(
        "INSERT INTO agent_org_runtime_task_events (
            id, org_run_id, task_id, event_type, previous_owner, next_owner,
            previous_status, next_status, actor_member_id, actor_kind,
            source_turn_intent_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)",
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
            actor_kind,
            &next.updated_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn insert_task_history_event_as(
    tx: &Transaction<'_>,
    org_run_id: &str,
    task_id: &str,
    event_type: &str,
    previous: Option<&Task>,
    next: &Task,
    actor: &super::actor::TaskActorAudit,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO agent_org_runtime_task_events (
            id, org_run_id, task_id, event_type, previous_owner, next_owner,
            previous_status, next_status, actor_member_id, actor_kind,
            source_turn_intent_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            uuid::Uuid::new_v4().to_string(),
            org_run_id,
            task_id,
            event_type,
            previous.and_then(|task| task.owner.as_deref()),
            next.owner.as_deref(),
            previous.map(|task| task.status.as_wire()),
            next.status.as_wire(),
            &actor.participant_id,
            actor.kind.as_wire(),
            actor.turn_intent_id.as_deref(),
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
        "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
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
