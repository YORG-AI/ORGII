//! Demand-driven Task annotation writes and bounded keyset reads.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};

use super::super::actor::TaskActorAudit;
use super::super::helpers::{now_rfc3339, row_to_task, SELECT_COLUMNS};
use super::super::{
    Task, TaskAnnotation, TaskAnnotationKind, TaskAnnotationPage, TaskGraphWriterAdmin,
    TaskOwnerExecution, TaskStatus,
};
use super::validation::ensure_run_allows_task_mutation;
use super::AgentOrgTaskStore;
use crate::coordination::agent_org_payload_limits::TASK_ANNOTATION_PAGE_MAX_BYTES;

const TASK_ANNOTATION_BODY_MAX_CHARS: usize = 8_000;
const TASK_ANNOTATION_BODY_MAX_BYTES: usize = 32_000;

impl AgentOrgTaskStore {
    pub fn append_owner_annotation(
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        kind: TaskAnnotationKind,
        body: String,
    ) -> Result<TaskAnnotation, String> {
        if !matches!(
            kind,
            TaskAnnotationKind::Progress | TaskAnnotationKind::Evidence
        ) {
            return Err("Owner may append only progress or evidence".to_string());
        }
        append_annotation(org_run_id, task_id, kind, body, |tx, task| {
            let audit = actor.validate(tx, org_run_id, task_id)?;
            if task.status != TaskStatus::InProgress
                || task.owner.as_deref() != Some(audit.participant_id.as_str())
            {
                return Err("Owner annotations require the Owner's in-progress task".to_string());
            }
            Ok(audit)
        })
    }

    pub(crate) fn append_owner_annotation_in_tx(
        conn: &rusqlite::Connection,
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        kind: TaskAnnotationKind,
        body: String,
    ) -> Result<TaskAnnotation, String> {
        if !matches!(
            kind,
            TaskAnnotationKind::Progress | TaskAnnotationKind::Evidence
        ) {
            return Err("Owner may append only progress or evidence".to_string());
        }
        append_annotation_in_tx(conn, org_run_id, task_id, kind, body, |tx, task| {
            let audit = actor.validate(tx, org_run_id, task_id)?;
            if task.status != TaskStatus::InProgress
                || task.owner.as_deref() != Some(audit.participant_id.as_str())
            {
                return Err("Owner annotations require the Owner's in-progress task".to_string());
            }
            Ok(audit)
        })
    }

    pub fn append_audit_annotation(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        body: String,
    ) -> Result<TaskAnnotation, String> {
        append_annotation(
            org_run_id,
            task_id,
            TaskAnnotationKind::AuditNote,
            body,
            |tx, task| {
                let audit = actor.validate(tx, org_run_id)?;
                if !task.status.is_terminal() {
                    return Err("audit_note is available only after a task is terminal".to_string());
                }
                Ok(audit)
            },
        )
    }

    pub(crate) fn append_audit_annotation_in_tx(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        body: String,
    ) -> Result<TaskAnnotation, String> {
        append_annotation_in_tx(
            conn,
            org_run_id,
            task_id,
            TaskAnnotationKind::AuditNote,
            body,
            |tx, task| {
                let audit = actor.validate(tx, org_run_id)?;
                if !task.status.is_terminal() {
                    return Err("audit_note is available only after a task is terminal".to_string());
                }
                Ok(audit)
            },
        )
    }

    pub fn list_annotation_page(
        org_run_id: &str,
        task_id: &str,
        after_annotation_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskAnnotationPage, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let bounded_limit = limit.clamp(1, 200);
        let cursor = after_annotation_id
            .map(|id| {
                conn.query_row(
                    "SELECT created_at, id FROM agent_org_runtime_task_annotations
                     WHERE org_run_id=?1 AND task_id=?2 AND id=?3",
                    params![org_run_id, task_id, id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "annotation cursor not found for task".to_string())
            })
            .transpose()?;
        let (cursor_created_at, cursor_id) = cursor
            .as_ref()
            .map(|(created_at, id)| (Some(created_at.as_str()), Some(id.as_str())))
            .unwrap_or((None, None));
        let mut stmt = conn
            .prepare(
                "SELECT id, org_run_id, task_id, kind, body, actor_kind,
                        actor_participant_id, source_turn_intent_id, created_at
                 FROM agent_org_runtime_task_annotations
                 WHERE org_run_id=?1 AND task_id=?2
                   AND (?3 IS NULL OR created_at>?3 OR (created_at=?3 AND id>?4))
                 ORDER BY created_at ASC, id ASC LIMIT ?5",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    task_id,
                    cursor_created_at,
                    cursor_id,
                    (bounded_limit + 1) as i64
                ],
                |row| {
                    let kind_raw: String = row.get(3)?;
                    Ok(TaskAnnotation {
                        id: row.get(0)?,
                        org_run_id: row.get(1)?,
                        task_id: row.get(2)?,
                        kind: TaskAnnotationKind::from_wire(&kind_raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        body: row.get(4)?,
                        actor_kind: row.get(5)?,
                        actor_participant_id: row.get(6)?,
                        source_turn_intent_id: row.get(7)?,
                        created_at: row.get(8)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        let mut annotations = Vec::new();
        let mut serialized_bytes = 2usize;
        let mut has_more = false;
        for row in rows {
            let annotation = row.map_err(|error| error.to_string())?;
            if annotations.len() == bounded_limit {
                has_more = true;
                break;
            }
            let bytes = serde_json::to_vec(&annotation)
                .map_err(|error| error.to_string())?
                .len();
            let separator = usize::from(!annotations.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(bytes)
                > TASK_ANNOTATION_PAGE_MAX_BYTES
            {
                has_more = true;
                break;
            }
            serialized_bytes = serialized_bytes
                .saturating_add(separator)
                .saturating_add(bytes);
            annotations.push(annotation);
        }
        let next_cursor = has_more
            .then(|| annotations.last().map(|annotation| annotation.id.clone()))
            .flatten();
        Ok(TaskAnnotationPage {
            annotations,
            has_more,
            next_cursor,
        })
    }
}

fn append_annotation(
    org_run_id: &str,
    task_id: &str,
    kind: TaskAnnotationKind,
    body: String,
    validate_actor: impl FnOnce(&rusqlite::Connection, &Task) -> Result<TaskActorAudit, String>,
) -> Result<TaskAnnotation, String> {
    crate::coordination::agent_org_payload_limits::validate_required_text(
        "task annotation body",
        &body,
        TASK_ANNOTATION_BODY_MAX_CHARS,
        TASK_ANNOTATION_BODY_MAX_BYTES,
    )?;
    let annotation = with_sessions_writer(|| -> Result<TaskAnnotation, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let annotation =
            append_annotation_in_tx(&tx, org_run_id, task_id, kind, body, validate_actor)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(annotation)
    })?;
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
    Ok(annotation)
}

fn append_annotation_in_tx(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    task_id: &str,
    kind: TaskAnnotationKind,
    body: String,
    validate_actor: impl FnOnce(&rusqlite::Connection, &Task) -> Result<TaskActorAudit, String>,
) -> Result<TaskAnnotation, String> {
    crate::coordination::agent_org_payload_limits::validate_required_text(
        "task annotation body",
        &body,
        TASK_ANNOTATION_BODY_MAX_CHARS,
        TASK_ANNOTATION_BODY_MAX_BYTES,
    )?;
    ensure_run_allows_task_mutation(conn, org_run_id)?;
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
         WHERE org_run_id=?1 AND id=?2"
    );
    let task = conn
        .query_row(&sql, params![org_run_id, task_id], row_to_task)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("task_not_found: {task_id} in run {org_run_id}"))?;
    let audit = validate_actor(conn, &task)?;
    let annotation = TaskAnnotation {
        id: uuid::Uuid::new_v4().to_string(),
        org_run_id: org_run_id.to_string(),
        task_id: task_id.to_string(),
        kind,
        body,
        actor_kind: audit.kind.as_wire().to_string(),
        actor_participant_id: audit.participant_id.clone(),
        source_turn_intent_id: audit.turn_intent_id.clone(),
        created_at: now_rfc3339(),
    };
    conn.execute(
        "INSERT INTO agent_org_runtime_task_annotations(
            id, org_run_id, task_id, kind, body, actor_kind,
            actor_participant_id, source_turn_intent_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &annotation.id,
            &annotation.org_run_id,
            &annotation.task_id,
            annotation.kind.as_wire(),
            &annotation.body,
            &annotation.actor_kind,
            &annotation.actor_participant_id,
            annotation.source_turn_intent_id.as_deref(),
            &annotation.created_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    crate::coordination::agent_org_finality::record_task_mutation_in_tx(conn, org_run_id, &audit)?;
    Ok(annotation)
}
