//! Read paths: full-row `get`/`list`, the narrow operational projection used by
//! recovery and prompt snapshots, the compact byte-budgeted summary page, the
//! open-task-id preview, and (test-only) history listing.

use database::db::get_connection;
use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_payload_limits::{
    TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT, TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
    TASK_SUMMARY_DESCRIPTION_MAX_CHARS, TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT,
    TASK_SUMMARY_PAGE_MAX_BYTES,
};

#[cfg(test)]
use super::super::helpers::row_to_task_history_event;
use super::super::helpers::{list_tasks_with_conn, row_to_task, SELECT_COLUMNS};
#[cfg(test)]
use super::super::TaskHistoryEvent;
use super::super::{
    Task, TaskExecutionMode, TaskGraphIndex, TaskOutputSummary, TaskStatus, TaskSummary,
    TaskSummaryPage, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
};
use super::validation::ensure_task_rows_safe_for_operational_projection;
use super::AgentOrgTaskStore;

fn decode_summary_array(raw: String, column: usize) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error.into())
    })
}

fn task_summary_scalar_predicate_sql(alias: &str) -> String {
    use crate::coordination::agent_org_payload_limits as limits;

    format!(
        "{alias}.status IN ('pending','in_progress','completed')
         AND trim({alias}.id)<>''
         AND {alias}.id=trim({alias}.id)
         AND length({alias}.id)<={}
         AND length(CAST({alias}.id AS BLOB))<={}
         AND length({alias}.created_at)<={}
         AND length(CAST({alias}.created_at AS BLOB))<={}
         AND length({alias}.updated_at)<={}
         AND length(CAST({alias}.updated_at AS BLOB))<={}",
        limits::TASK_IDENTIFIER_MAX_CHARS,
        limits::TASK_IDENTIFIER_MAX_BYTES,
        limits::RFC3339_TIMESTAMP_MAX_CHARS,
        limits::RFC3339_TIMESTAMP_MAX_BYTES,
        limits::RFC3339_TIMESTAMP_MAX_CHARS,
        limits::RFC3339_TIMESTAMP_MAX_BYTES,
    )
}

impl AgentOrgTaskStore {
    pub(crate) fn list_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        list_tasks_with_conn(conn, org_run_id)
    }

    pub fn get(org_run_id: &str, task_id: &str) -> Result<Option<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
             WHERE org_run_id=?1 AND id=?2"
        );
        conn.query_row(&sql, params![org_run_id, task_id], row_to_task)
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn list(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        list_tasks_with_conn(&conn, org_run_id)
    }

    /// Load the narrow task fields needed by recovery and per-turn prompt
    /// snapshots. Full descriptions and TaskOutput metadata intentionally stay
    /// behind `get`/`task_get`; a periodic watchdog or model prompt must not
    /// deserialize up to 64 KiB of result metadata for every task.
    pub fn list_operational(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_operational_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_operational_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        ensure_task_rows_safe_for_operational_projection(conn, org_run_id)?;
        Self::list_operational_after_validated_with_connection(conn, org_run_id)
    }

    /// Internal projection for a caller that has already run the shared
    /// finality/corruption assessment in the same SQLite read snapshot.
    /// Keeping this separate avoids evaluating the expensive JSON integrity
    /// predicate twice per watchdog tick while the public wrapper remains
    /// fail-closed for every other caller.
    pub(crate) fn list_operational_after_validated_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT task.id,
                        task.org_run_id,
                        substr(task.subject, 1, 200),
                        task.owner,
                        task.status,
                        task.blocks_json,
                        task.blocked_by_json,
                        CASE WHEN json_valid(task.metadata_json)
                                  AND json_type(task.metadata_json, '$.eligible_member_ids')='array'
                             THEN json_extract(task.metadata_json, '$.eligible_member_ids')
                             ELSE '[]' END,
                        task.created_at,
                        task.updated_at
                 FROM (
                     SELECT id, org_run_id, subject, description, active_form,
                            owner, status, created_at, updated_at,
                            CASE WHEN length(CAST(blocks_json AS BLOB))<=?2
                                 THEN blocks_json ELSE '!' END AS blocks_json,
                            CASE WHEN length(CAST(blocked_by_json AS BLOB))<=?2
                                 THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                            CASE WHEN metadata_json IS NULL
                                      OR length(CAST(metadata_json AS BLOB))<=?3
                                 THEN metadata_json ELSE '!' END AS metadata_json
                     FROM agent_org_tasks
                 ) task
                 WHERE task.org_run_id=?1
                 ORDER BY task.created_at ASC, task.id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES
                        as i64,
                    crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES as i64,
                ],
                |row| {
                    let status_raw: String = row.get(4)?;
                    let eligible = decode_summary_array(row.get(7)?, 7)?;
                    let metadata = (!eligible.is_empty()).then(
                        || serde_json::json!({ (TASK_METADATA_ELIGIBLE_MEMBER_IDS): eligible }),
                    );
                    Ok(Task {
                        id: row.get(0)?,
                        org_run_id: row.get(1)?,
                        subject: row.get(2)?,
                        description: String::new(),
                        active_form: None,
                        owner: row.get(3)?,
                        status: TaskStatus::from_wire(&status_raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        blocks: decode_summary_array(row.get(5)?, 5)?,
                        blocked_by: decode_summary_array(row.get(6)?, 6)?,
                        metadata,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut tasks = rows
            .map(|row| row.map_err(|err| err.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        TaskGraphIndex::new(&tasks).apply_projection(&mut tasks);
        Ok(tasks)
    }

    pub fn list_summary_page(
        org_run_id: &str,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_summary_page_with_connection(
            &conn,
            org_run_id,
            status,
            owner,
            after_task_id,
            limit,
        )
    }

    /// Read one compact task page directly from SQLite. The cursor is first
    /// resolved to its `(created_at, id)` tuple, then the page uses that stable
    /// pair as its boundary so equal timestamps cannot reorder or skip rows.
    pub fn list_summary_page_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let bounded_limit = limit.clamp(1, 200);
        let cursor = after_task_id
            .map(|task_id| {
                conn.query_row(
                    "SELECT created_at, id FROM agent_org_tasks
                     WHERE org_run_id=?1 AND id=?2
                       AND length(id)<=?3 AND length(CAST(id AS BLOB))<=?4
                       AND length(created_at)<=?5
                       AND length(CAST(created_at AS BLOB))<=?6",
                    params![
                        org_run_id,
                        task_id,
                        crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS
                            as i64,
                        crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES
                            as i64,
                        crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_CHARS
                            as i64,
                        crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_BYTES
                            as i64,
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|err| err.to_string())?
                .ok_or_else(|| {
                    format!(
                        "task_list after_task_id '{task_id}' does not exist or is corrupt in this run"
                    )
                })
            })
            .transpose()?;
        let (cursor_created_at, cursor_id) = cursor
            .as_ref()
            .map(|(created_at, id)| (Some(created_at.as_str()), Some(id.as_str())))
            .unwrap_or((None, None));
        let status_wire = status.map(|status| status.as_wire());

        let summary_scalar_predicate = task_summary_scalar_predicate_sql("task");
        let filtered_total_sql = format!(
            "SELECT COUNT(*) FROM agent_org_tasks task
             WHERE task.org_run_id=?1
               AND {summary_scalar_predicate}
               AND (?2 IS NULL OR task.status=?2)
               AND (?3 IS NULL OR task.owner=?3)"
        );
        let filtered_total: i64 = conn
            .query_row(
                &filtered_total_sql,
                params![org_run_id, status_wire, owner],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;

        let summary_sql = "SELECT
                     task.id,
                     substr(task.subject, 1, 200),
                     substr(task.description, 1, ?6),
                     CASE WHEN length(task.description) > ?6 THEN 1 ELSE 0 END,
                     CASE WHEN task.active_form IS NULL THEN NULL
                          ELSE substr(task.active_form, 1, 1000) END,
                     task.owner,
                     task.status,
                     CASE WHEN json_valid(task.blocks_json) THEN
                         CASE WHEN json_type(task.blocks_json)='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.blocks_json)
                                  WHERE type='text' LIMIT ?8
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.blocked_by_json) THEN
                         CASE WHEN json_type(task.blocked_by_json)='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.blocked_by_json)
                                  WHERE type='text' LIMIT ?8
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.eligible_member_ids')='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.metadata_json, '$.eligible_member_ids')
                                  WHERE type='text' LIMIT ?9
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.required_role')='text'
                              THEN substr(json_extract(task.metadata_json, '$.required_role'), 1, 200)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.execution_mode')='text'
                              THEN substr(json_extract(task.metadata_json, '$.execution_mode'), 1, 20)
                              ELSE 'build' END
                     ELSE 'build' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.summary')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.summary'), 1, 1000)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.artifactIds')='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.metadata_json, '$.output.artifactIds')
                                  WHERE type='text' LIMIT ?10
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.producedByMemberId')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.producedByMemberId'), 1, 1000)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.producedAt')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.producedAt'), 1, 100)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.content')='text' THEN 1 ELSE 0 END
                     ELSE 0 END,
                     task.created_at,
                     task.updated_at,
                     CASE WHEN json_valid(task.blocks_json)
                               AND json_type(task.blocks_json)='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.blocks_json) WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.blocked_by_json)
                               AND json_type(task.blocked_by_json)='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.blocked_by_json) WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.metadata_json)
                               AND json_type(task.metadata_json, '$.eligible_member_ids')='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.metadata_json, '$.eligible_member_ids') WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.metadata_json)
                               AND json_type(task.metadata_json, '$.output.artifactIds')='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.metadata_json, '$.output.artifactIds') WHERE type='text')
                          ELSE 0 END
                 FROM (
                     SELECT id, org_run_id, subject, description, active_form,
                            CASE WHEN owner IS NULL THEN NULL
                                 WHEN trim(owner)<>''
                                      AND length(owner)<={id_chars}
                                      AND length(CAST(owner AS BLOB))<={id_bytes}
                                 THEN owner ELSE NULL END AS owner,
                            status, created_at, updated_at,
                            CASE WHEN length(CAST(blocks_json AS BLOB))<=?11
                                 THEN blocks_json ELSE '!' END AS blocks_json,
                            CASE WHEN length(CAST(blocked_by_json AS BLOB))<=?11
                                 THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                            CASE WHEN metadata_json IS NULL
                                      OR length(CAST(metadata_json AS BLOB))<=?12
                                 THEN metadata_json ELSE '!' END AS metadata_json
                     FROM agent_org_tasks
                 ) task
                 WHERE task.org_run_id=?1
                   AND {summary_scalar_predicate}
                   AND (?2 IS NULL OR task.status=?2)
                   AND (?3 IS NULL OR task.owner=?3)
                   AND (
                       ?4 IS NULL
                       OR task.created_at > ?4
                       OR (task.created_at = ?4 AND task.id > ?5)
                   )
                 ORDER BY task.created_at ASC, task.id ASC
                 LIMIT ?7"
            .replace("{id_chars}", &crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS.to_string())
            .replace("{id_bytes}", &crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES.to_string())
            .replace("{timestamp_chars}", &crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_CHARS.to_string())
            .replace("{timestamp_bytes}", &crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_BYTES.to_string())
            .replace("{summary_scalar_predicate}", &summary_scalar_predicate);
        let mut stmt = conn.prepare(&summary_sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    status_wire,
                    owner,
                    cursor_created_at,
                    cursor_id,
                    TASK_SUMMARY_DESCRIPTION_MAX_CHARS as i64,
                    (bounded_limit + 1) as i64,
                    TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT as i64,
                    crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES
                        as i64,
                    crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES as i64,
                ],
                |row| {
                    let status_raw: String = row.get(6)?;
                    let execution_mode_raw: String = row.get(11)?;
                    let output_summary: Option<String> = row.get(12)?;
                    let artifact_ids = decode_summary_array(row.get(13)?, 13)?;
                    let artifact_count = row.get::<_, i64>(22)?.max(0) as usize;
                    let output = output_summary
                        .map(|summary| {
                            Ok::<TaskOutputSummary, rusqlite::Error>(TaskOutputSummary {
                                summary,
                                artifact_ids,
                                artifact_ids_truncated: artifact_count
                                    > TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT,
                                produced_by_member_id: row.get(14)?,
                                produced_at: row.get(15)?,
                                has_content: row.get::<_, i64>(16)? != 0,
                            })
                        })
                        .transpose()?;
                    let blocks = decode_summary_array(row.get(7)?, 7)?;
                    let blocked_by = decode_summary_array(row.get(8)?, 8)?;
                    let eligible_member_ids = decode_summary_array(row.get(9)?, 9)?;
                    Ok(TaskSummary {
                        id: row.get(0)?,
                        subject: row.get(1)?,
                        description: row.get(2)?,
                        description_truncated: row.get::<_, i64>(3)? != 0,
                        active_form: row.get(4)?,
                        owner: row.get(5)?,
                        status: TaskStatus::from_wire(&status_raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        blocks,
                        blocks_truncated: row.get::<_, i64>(19)?.max(0) as usize
                            > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        blocked_by,
                        blocked_by_truncated: row.get::<_, i64>(20)?.max(0) as usize
                            > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        eligible_member_ids,
                        eligible_member_ids_truncated: row.get::<_, i64>(21)?.max(0) as usize
                            > TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT,
                        required_role: row.get(10)?,
                        execution_mode: TaskExecutionMode::from_wire(&execution_mode_raw)
                            .unwrap_or(TaskExecutionMode::Build),
                        output,
                        created_at: row.get(17)?,
                        updated_at: row.get(18)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut tasks = Vec::new();
        let mut serialized_bytes = 2usize; // surrounding JSON array
        let mut has_more = false;
        for row in rows {
            let task = row.map_err(|err| err.to_string())?;
            if tasks.len() == bounded_limit {
                has_more = true;
                break;
            }
            let task_bytes = serde_json::to_vec(&task)
                .map_err(|err| format!("serialize TaskSummary for payload budget failed: {err}"))?
                .len();
            let separator = usize::from(!tasks.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(task_bytes)
                > TASK_SUMMARY_PAGE_MAX_BYTES
            {
                has_more = true;
                break;
            }
            serialized_bytes = serialized_bytes
                .saturating_add(separator)
                .saturating_add(task_bytes);
            tasks.push(task);
        }
        let next_cursor = has_more
            .then(|| tasks.last().map(|task| task.id.clone()))
            .flatten();
        Ok(TaskSummaryPage {
            tasks,
            filtered_total: filtered_total.max(0) as usize,
            has_more,
            next_cursor,
        })
    }

    /// Return a bounded preview of unresolved task ids from an existing read
    /// snapshot. The boolean reports whether more ids exist beyond `limit`.
    /// Callers that only render run-level guidance must not load full task
    /// rows (and their potentially large descriptions/output metadata) merely
    /// to name a few blockers.
    pub(crate) fn open_task_ids_preview_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        limit: usize,
    ) -> Result<(Vec<String>, bool), String> {
        let bounded_limit = limit.clamp(1, 500);
        let mut stmt = conn
            .prepare(
                "SELECT id FROM agent_org_tasks
                 WHERE org_run_id=?1 AND status<>'completed'
                   AND trim(id)<>''
                   AND length(id)<=?3
                   AND length(CAST(id AS BLOB))<=?4
                 ORDER BY created_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    (bounded_limit + 1) as i64,
                    crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS as i64,
                    crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES as i64,
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        let mut ids = Vec::new();
        let mut bytes = 2usize; // surrounding JSON array
        let mut truncated = false;
        for row in rows {
            let id = row.map_err(|err| err.to_string())?;
            let encoded_id_bytes = serde_json::to_vec(&id)
                .map_err(|err| format!("serialize open task id preview failed: {err}"))?
                .len();
            let separator = usize::from(!ids.is_empty());
            if ids.len() == bounded_limit
                || bytes
                    .saturating_add(encoded_id_bytes)
                    .saturating_add(separator)
                    > crate::coordination::agent_org_payload_limits::TASK_OPEN_ID_PREVIEW_MAX_BYTES
            {
                truncated = true;
                break;
            }
            bytes = bytes
                .saturating_add(encoded_id_bytes)
                .saturating_add(separator);
            ids.push(id);
        }
        Ok((ids, truncated))
    }

    #[cfg(test)]
    pub fn list_history(org_run_id: &str) -> Result<Vec<TaskHistoryEvent>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, org_run_id, task_id, event_type, previous_owner, next_owner,
                    previous_status, next_status, actor_member_id, created_at
                 FROM agent_org_task_events
                 WHERE org_run_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], row_to_task_history_event)
            .map_err(|err| err.to_string())?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row.map_err(|err| err.to_string())?);
        }
        Ok(events)
    }
}
