//! Bounded Task reads.  History results and annotations stay behind explicit
//! detail/page calls; operational polling never deserializes terminal output.

use base64::Engine;
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
    Task, TaskExecutionMode, TaskGraphIndex, TaskOutputSummary, TaskPageBucket, TaskPageDirection,
    TaskStatus, TaskSummary, TaskSummaryPage, TaskTerminalReason,
    TASK_METADATA_ELIGIBLE_MEMBER_IDS,
};
use super::validation::ensure_task_rows_safe_for_operational_projection;
use super::AgentOrgTaskStore;

fn decode_array(raw: String, column: usize) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error.into())
    })
}

fn decode_optional_json<T: serde::de::DeserializeOwned>(
    raw: Option<String>,
    column: usize,
) -> rusqlite::Result<Option<T>> {
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                error.into(),
            )
        })
    })
    .transpose()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct TaskPageCursor {
    version: u8,
    bucket: TaskPageBucket,
    status: Option<TaskStatus>,
    sort_at: String,
    id: String,
}

fn encode_task_page_cursor(
    bucket: TaskPageBucket,
    status: Option<TaskStatus>,
    task: &TaskSummary,
) -> Result<String, String> {
    let raw = serde_json::to_vec(&TaskPageCursor {
        version: 2,
        bucket,
        status,
        sort_at: match bucket {
            TaskPageBucket::Current => task.created_at.clone(),
            TaskPageBucket::History => task.updated_at.clone(),
        },
        id: task.id.clone(),
    })
    .map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw))
}

fn decode_task_page_cursor(
    raw: &str,
    bucket: TaskPageBucket,
    status: Option<TaskStatus>,
) -> Result<(String, String), String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "invalid_task_page_cursor".to_string())?;
    let cursor: TaskPageCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid_task_page_cursor".to_string())?;
    if cursor.version != 2 || cursor.bucket != bucket || cursor.status != status {
        return Err("task_page_cursor_filter_mismatch".to_string());
    }
    Ok((cursor.sort_at, cursor.id))
}

impl AgentOrgTaskStore {
    pub(crate) fn list_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        list_tasks_with_conn(conn, org_run_id)
    }

    pub fn get(org_run_id: &str, task_id: &str) -> Result<Option<Task>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id=?2"
        );
        let mut task = conn
            .query_row(&sql, params![org_run_id, task_id], row_to_task)
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(task) = task.as_mut() {
            // `blocked_by_json` is the only persisted edge. A detail read is
            // the explicit, bounded-on-demand place where callers can ask
            // for the complete reverse projection omitted from list pages.
            let mut stmt = conn
                .prepare(
                    "SELECT downstream.id
                     FROM agent_org_runtime_tasks downstream,
                          json_each(downstream.blocked_by_json) edge
                     WHERE downstream.org_run_id=?1 AND edge.value=?2
                     ORDER BY downstream.created_at ASC, downstream.id ASC",
                )
                .map_err(|error| error.to_string())?;
            task.blocks = stmt
                .query_map(params![org_run_id, task_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .map(|row| row.map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
        }
        Ok(task)
    }

    pub fn list(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        list_tasks_with_conn(&conn, org_run_id)
    }

    pub fn list_operational(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        Self::list_operational_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_operational_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        ensure_task_rows_safe_for_operational_projection(conn, org_run_id)?;
        Self::list_operational_after_validated_with_connection(conn, org_run_id)
    }

    pub(crate) fn list_operational_after_validated_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        let mut stmt = conn
            .prepare(
                "WITH operational_ids(id) AS (
                     SELECT id
                     FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND status IN ('pending','in_progress')
                     UNION
                     SELECT CAST(edge.value AS TEXT)
                     FROM agent_org_runtime_tasks open_task,
                          json_each(
                              CASE WHEN json_valid(open_task.blocked_by_json)
                                   THEN open_task.blocked_by_json ELSE '[]' END
                          ) edge
                     WHERE open_task.org_run_id=?1
                       AND open_task.status IN ('pending','in_progress')
                       AND edge.type='text'
                 )
                 SELECT task.id, task.org_run_id, task.activation_generation,
                        substr(task.subject,1,200),
                        task.owner, task.status,
                        execution_mode, blocked_by_json,
                        CASE WHEN task.metadata_json IS NOT NULL
                                  AND json_valid(task.metadata_json)
                                  AND json_type(task.metadata_json,'$.eligible_member_ids')='array'
                             THEN json_extract(task.metadata_json,'$.eligible_member_ids')
                             ELSE '[]' END,
                        task.created_at, task.updated_at
                 FROM agent_org_runtime_tasks task
                 JOIN operational_ids ON operational_ids.id=task.id
                 WHERE task.org_run_id=?1
                 ORDER BY task.created_at ASC, task.id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], |row| {
                let status_raw: String = row.get(5)?;
                let execution_mode_raw: String = row.get(6)?;
                let eligible = decode_array(row.get(8)?, 8)?;
                Ok(Task {
                    id: row.get(0)?,
                    org_run_id: row.get(1)?,
                    activation_generation: row.get(2)?,
                    subject: row.get(3)?,
                    description: String::new(),
                    active_form: None,
                    owner: row.get(4)?,
                    status: TaskStatus::from_wire(&status_raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            error.into(),
                        )
                    })?,
                    execution_mode: TaskExecutionMode::from_wire(&execution_mode_raw).map_err(
                        |error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        },
                    )?,
                    blocks: Vec::new(),
                    blocked_by: decode_array(row.get(7)?, 7)?,
                    metadata: (!eligible.is_empty()).then(
                        || serde_json::json!({ (TASK_METADATA_ELIGIBLE_MEMBER_IDS): eligible }),
                    ),
                    output: None,
                    failure_reason: None,
                    cancel_reason: None,
                    created_by_participant_id: String::new(),
                    source_turn_intent_id: String::new(),
                    originating_message_id: None,
                    replaces_task_id: None,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut tasks = rows
            .map(|row| row.map_err(|error| error.to_string()))
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
        let conn = get_connection().map_err(|error| error.to_string())?;
        Self::list_summary_page_with_connection(
            &conn,
            org_run_id,
            status,
            owner,
            after_task_id,
            limit,
        )
    }

    pub fn list_summary_page_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let cursor = after_task_id
            .map(|task_id| {
                conn.query_row(
                    "SELECT created_at,id FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND id=?2",
                    params![org_run_id, task_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("task cursor not found in run: {task_id}"))
            })
            .transpose()?;
        let mut page = Self::query_summary_page_with_connection(
            conn,
            org_run_id,
            None,
            status,
            owner,
            cursor,
            TaskPageDirection::Forward,
            limit,
        )?;
        page.next_cursor = page
            .has_more
            .then(|| page.tasks.last().map(|task| task.id.clone()))
            .flatten();
        page.previous_cursor = None;
        Ok(page)
    }

    pub fn list_task_page(
        org_run_id: &str,
        bucket: TaskPageBucket,
        status: Option<TaskStatus>,
        cursor: Option<&str>,
        direction: TaskPageDirection,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        Self::list_task_page_with_connection(
            &conn, org_run_id, bucket, status, cursor, direction, limit,
        )
    }

    pub fn list_task_page_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        bucket: TaskPageBucket,
        status: Option<TaskStatus>,
        cursor: Option<&str>,
        direction: TaskPageDirection,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        if status.is_some_and(|status| !bucket.accepts(status)) {
            return Err("task_page_status_bucket_mismatch".to_string());
        }
        let decoded_cursor = cursor
            .map(|raw| decode_task_page_cursor(raw, bucket, status))
            .transpose()?;
        Self::query_summary_page_with_connection(
            conn,
            org_run_id,
            Some(bucket),
            status,
            None,
            decoded_cursor,
            direction,
            limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn query_summary_page_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        bucket: Option<TaskPageBucket>,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        cursor: Option<(String, String)>,
        direction: TaskPageDirection,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        // The legacy model-facing list promises an exact total and a whole-
        // board corruption verdict. Current/History UI pages deliberately do
        // neither: a long-lived Team can retain substantial history, so those
        // reads validate only the at-most `limit + 1` rows they materialize.
        if bucket.is_none() {
            ensure_task_rows_safe_for_operational_projection(conn, org_run_id)?;
        }
        let bounded_limit = limit.clamp(1, 200);
        let (cursor_sort_at, cursor_id) = cursor
            .as_ref()
            .map(|(sort_at, id)| (Some(sort_at.as_str()), Some(id.as_str())))
            .unwrap_or((None, None));
        let status_wire = status.map(|status| status.as_wire());
        let bucket_wire = bucket.map(TaskPageBucket::as_wire);
        let filtered_total: i64 = if bucket.is_none() {
            conn.query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND (?2 IS NULL OR status=?2)
                   AND (?3 IS NULL OR owner=?3)",
                params![org_run_id, status_wire, owner],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?
        } else {
            0
        };
        // Current work follows graph creation order. Terminal History follows
        // its latest transition time, newest first. `Forward` always advances
        // in the canonical display order; `Backward` returns the prior page.
        let history_newest_first = bucket == Some(TaskPageBucket::History);
        let sort_column = if history_newest_first {
            "task.updated_at"
        } else {
            "task.created_at"
        };
        let (cursor_comparison, ordering) = match (history_newest_first, direction) {
            (false, TaskPageDirection::Forward) => (">", "ASC"),
            (false, TaskPageDirection::Backward) => ("<", "DESC"),
            (true, TaskPageDirection::Forward) => ("<", "DESC"),
            (true, TaskPageDirection::Backward) => (">", "ASC"),
        };
        let cursor_predicate = format!(
            "(?5 IS NULL OR {sort_column}{cursor_comparison}?5 OR \
             ({sort_column}=?5 AND task.id{cursor_comparison}?6))"
        );
        let ordering = format!("{sort_column} {ordering}, task.id {ordering}");
        let (blocks_preview, blocks_count) = if bucket.is_none() {
            (
                "COALESCE((SELECT json_group_array(id) FROM (
                    SELECT downstream.id AS id
                    FROM agent_org_runtime_tasks downstream, json_each(downstream.blocked_by_json) edge
                    WHERE downstream.org_run_id=task.org_run_id AND edge.value=task.id
                    ORDER BY downstream.created_at, downstream.id LIMIT ?9
                )),'[]')",
                "(SELECT COUNT(*) FROM agent_org_runtime_tasks downstream, json_each(downstream.blocked_by_json) edge
                  WHERE downstream.org_run_id=task.org_run_id AND edge.value=task.id)",
            )
        } else {
            // Reverse dependencies are intentionally absent from a bounded
            // Current/History page. `blocked_by` remains canonical and the
            // flag tells consumers to request detail if they need a complete
            // reverse projection.
            ("'[]'", "1")
        };
        let corrupt_predicate = super::super::corrupt_task_row_predicate_sql();
        let sql = format!(
            "SELECT task.id,
                    substr(task.subject,1,200),
                    substr(task.description,1,?7),
                    length(task.description)>?7,
                    CASE WHEN task.active_form IS NULL THEN NULL ELSE substr(task.active_form,1,1000) END,
                    task.owner, task.status, task.execution_mode,
                    {blocks_preview},
                    {blocks_count},
                    COALESCE((SELECT json_group_array(value) FROM (
                        SELECT value FROM json_each(task.blocked_by_json) LIMIT ?9
                    )),'[]'),
                    (SELECT COUNT(*) FROM json_each(task.blocked_by_json)),
                    NOT EXISTS (
                        SELECT 1
                        FROM json_each(task.blocked_by_json) edge
                        LEFT JOIN agent_org_runtime_tasks blocker
                          ON blocker.org_run_id=task.org_run_id
                         AND blocker.id=edge.value
                        WHERE blocker.id IS NULL OR blocker.status<>'completed'
                    ),
                    CASE WHEN task.metadata_json IS NOT NULL
                              AND json_type(task.metadata_json,'$.eligible_member_ids')='array'
                         THEN COALESCE((SELECT json_group_array(value) FROM (
                             SELECT value FROM json_each(task.metadata_json,'$.eligible_member_ids') LIMIT ?10
                         )),'[]') ELSE '[]' END,
                    CASE WHEN task.metadata_json IS NOT NULL
                              AND json_type(task.metadata_json,'$.eligible_member_ids')='array'
                         THEN (SELECT COUNT(*) FROM json_each(task.metadata_json,'$.eligible_member_ids')) ELSE 0 END,
                    CASE WHEN task.metadata_json IS NOT NULL
                              AND json_type(task.metadata_json,'$.required_role')='text'
                         THEN substr(json_extract(task.metadata_json,'$.required_role'),1,200) ELSE NULL END,
                    CASE WHEN task.output_json IS NULL THEN NULL ELSE substr(json_extract(task.output_json,'$.summary'),1,1000) END,
                    CASE WHEN task.output_json IS NULL THEN '[]' ELSE COALESCE((SELECT json_group_array(value) FROM (
                        SELECT value FROM json_each(task.output_json,'$.artifactIds') LIMIT ?11
                    )),'[]') END,
                    CASE WHEN task.output_json IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM json_each(task.output_json,'$.artifactIds')) END,
                    CASE WHEN task.output_json IS NULL THEN NULL ELSE json_extract(task.output_json,'$.producedByMemberId') END,
                    CASE WHEN task.output_json IS NULL THEN NULL ELSE json_extract(task.output_json,'$.producedAt') END,
                    CASE WHEN task.output_json IS NOT NULL AND json_type(task.output_json,'$.content')='text' THEN 1 ELSE 0 END,
                    task.failure_reason_json, task.cancel_reason_json, task.replaces_task_id,
                    task.created_at, task.updated_at, task.activation_generation,
                    {corrupt_predicate}
             FROM agent_org_runtime_tasks task
             WHERE task.org_run_id=?1
               AND (?2 IS NULL OR task.status=?2)
               AND (?3 IS NULL OR task.owner=?3)
               AND (?4 IS NULL
                    OR (?4='current' AND task.status IN ('pending','in_progress'))
                    OR (?4='history' AND task.status IN ('completed','failed','cancelled')))
               AND {cursor_predicate}
             ORDER BY {ordering} LIMIT ?8"
        );
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    status_wire,
                    owner,
                    bucket_wire,
                    cursor_sort_at,
                    cursor_id,
                    TASK_SUMMARY_DESCRIPTION_MAX_CHARS as i64,
                    (bounded_limit + 1) as i64,
                    TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT as i64,
                ],
                |row| {
                    if row.get::<_, i64>(28)? != 0 {
                        return Err(rusqlite::Error::FromSqlConversionFailure(
                            28,
                            rusqlite::types::Type::Integer,
                            "corrupt Task row selected by bounded page".into(),
                        ));
                    }
                    let status_raw: String = row.get(6)?;
                    let execution_mode_raw: String = row.get(7)?;
                    let blocks = decode_array(row.get(8)?, 8)?;
                    let blocked_by = decode_array(row.get(10)?, 10)?;
                    let eligible_member_ids = decode_array(row.get(13)?, 13)?;
                    let output_summary: Option<String> = row.get(16)?;
                    let artifact_ids = decode_array(row.get(17)?, 17)?;
                    let artifact_count = row.get::<_, i64>(18)?.max(0) as usize;
                    let produced_by_member_id = row.get(19)?;
                    let produced_at = row.get(20)?;
                    let has_content = row.get::<_, i64>(21)? != 0;
                    let output = output_summary.map(|summary| TaskOutputSummary {
                        summary,
                        artifact_ids,
                        artifact_ids_truncated: artifact_count
                            > TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT,
                        produced_by_member_id,
                        produced_at,
                        has_content,
                    });
                    Ok(TaskSummary {
                        id: row.get(0)?,
                        activation_generation: row.get(27)?,
                        subject: row.get(1)?,
                        description: row.get(2)?,
                        description_truncated: row.get(3)?,
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
                        blocks_truncated: bucket.is_some()
                            || row.get::<_, i64>(9)?.max(0) as usize
                                > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        blocked_by,
                        blocked_by_truncated: row.get::<_, i64>(11)?.max(0) as usize
                            > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        dependencies_satisfied: row.get::<_, i64>(12)? != 0,
                        eligible_member_ids,
                        eligible_member_ids_truncated: row.get::<_, i64>(14)?.max(0) as usize
                            > TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT,
                        required_role: row.get(15)?,
                        execution_mode: TaskExecutionMode::from_wire(&execution_mode_raw).map_err(
                            |error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    7,
                                    rusqlite::types::Type::Text,
                                    error.into(),
                                )
                            },
                        )?,
                        output,
                        failure_reason: decode_optional_json::<TaskTerminalReason>(
                            row.get(22)?,
                            22,
                        )?,
                        cancel_reason: decode_optional_json::<TaskTerminalReason>(
                            row.get(23)?,
                            23,
                        )?,
                        replaces_task_id: row.get(24)?,
                        created_at: row.get(25)?,
                        updated_at: row.get(26)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        let mut tasks = Vec::new();
        let mut serialized_bytes = 2usize;
        let mut has_more = false;
        for row in rows {
            let task = row.map_err(|error| error.to_string())?;
            if tasks.len() == bounded_limit {
                has_more = true;
                break;
            }
            let bytes = serde_json::to_vec(&task)
                .map_err(|error| error.to_string())?
                .len();
            let separator = usize::from(!tasks.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(bytes)
                > TASK_SUMMARY_PAGE_MAX_BYTES
            {
                has_more = true;
                break;
            }
            serialized_bytes = serialized_bytes
                .saturating_add(separator)
                .saturating_add(bytes);
            tasks.push(task);
        }
        if direction == TaskPageDirection::Backward {
            tasks.reverse();
        }
        let (previous_cursor, next_cursor) = match bucket {
            Some(bucket) => {
                let previous = match direction {
                    TaskPageDirection::Forward => cursor
                        .as_ref()
                        .and_then(|_| tasks.first())
                        .map(|task| encode_task_page_cursor(bucket, status, task))
                        .transpose()?,
                    TaskPageDirection::Backward => has_more
                        .then(|| tasks.first())
                        .flatten()
                        .map(|task| encode_task_page_cursor(bucket, status, task))
                        .transpose()?,
                };
                let next = match direction {
                    TaskPageDirection::Forward => has_more
                        .then(|| tasks.last())
                        .flatten()
                        .map(|task| encode_task_page_cursor(bucket, status, task))
                        .transpose()?,
                    TaskPageDirection::Backward => cursor
                        .as_ref()
                        .and_then(|_| tasks.last())
                        .map(|task| encode_task_page_cursor(bucket, status, task))
                        .transpose()?,
                };
                (previous, next)
            }
            None => (None, None),
        };
        Ok(TaskSummaryPage {
            tasks,
            filtered_total: filtered_total.max(0) as usize,
            has_more,
            next_cursor,
            previous_cursor,
        })
    }

    pub(crate) fn open_task_ids_preview_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        limit: usize,
    ) -> Result<(Vec<String>, bool), String> {
        let bounded_limit = limit.clamp(1, 500);
        let mut stmt = conn
            .prepare(
                "SELECT id FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND status IN ('pending','in_progress')
                 ORDER BY created_at ASC,id ASC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id, (bounded_limit + 1) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        let mut ids = Vec::new();
        let mut bytes = 2usize;
        let mut truncated = false;
        for row in rows {
            let id = row.map_err(|error| error.to_string())?;
            let encoded = serde_json::to_vec(&id)
                .map_err(|error| error.to_string())?
                .len();
            let separator = usize::from(!ids.is_empty());
            if ids.len() == bounded_limit
                || bytes.saturating_add(separator).saturating_add(encoded)
                    > crate::coordination::agent_org_payload_limits::TASK_OPEN_ID_PREVIEW_MAX_BYTES
            {
                truncated = true;
                break;
            }
            bytes = bytes.saturating_add(separator).saturating_add(encoded);
            ids.push(id);
        }
        Ok((ids, truncated))
    }

    #[cfg(test)]
    pub fn list_history(org_run_id: &str) -> Result<Vec<TaskHistoryEvent>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,org_run_id,task_id,event_type,previous_owner,next_owner,
                        previous_status,next_status,actor_member_id,actor_kind,
                        source_turn_intent_id,created_at
                 FROM agent_org_runtime_task_events WHERE org_run_id=?1
                 ORDER BY created_at ASC,id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], row_to_task_history_event)
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }
}
