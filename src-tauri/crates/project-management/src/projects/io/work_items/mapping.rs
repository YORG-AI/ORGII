//! Frontmatter ↔ row mapping helpers shared by the CRUD and atomic
//! write paths.
//!
//! `workitems` (hot columns) + `workitem_labels` (m:n) + `workitem_extras`
//! (JSON blob) together represent one `WorkItemFrontmatter`. This module
//! owns the conversion in both directions and the small `ConnectionLike`
//! trait that lets read helpers run against either a bare `Connection`
//! or an active `Transaction` without duplicate call sites.

use rusqlite::{params, OptionalExtension};

use super::super::helpers::{map_db, to_iso8601};
use super::extras::ExtrasPayload;
use crate::projects::types::{WorkItemData, WorkItemFrontmatter};

/// Hot columns selected from `workitems` for a single work item.
pub(super) struct WorkItemCore {
    pub work_item_id: String,
    pub project_id: Option<String>,
    pub short_id: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub assignee_type: Option<String>,
    pub milestone: Option<String>,
    pub parent: Option<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

/// Map a `workitems` row (in the canonical hot-column order) into a
/// `WorkItemCore`. Callers must select columns in the order used by
/// `read_all_work_items` / `read_work_item` for this to be valid.
pub(super) fn row_to_core(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkItemCore> {
    Ok(WorkItemCore {
        work_item_id: row.get(0)?,
        project_id: row.get(1)?,
        short_id: row.get(2)?,
        title: row.get(3)?,
        body: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        status: row.get(5)?,
        priority: row.get(6)?,
        assignee: row.get(7)?,
        assignee_type: row.get(8)?,
        milestone: row.get(9)?,
        parent: row.get(10)?,
        start_date: row.get(11)?,
        target_date: row.get(12)?,
        created_at_ms: row.get(13)?,
        updated_at_ms: row.get(14)?,
        deleted_at_ms: row.get(15)?,
    })
}

/// Combine the hot row, label set, and extras blob into a full
/// `WorkItemData`.
pub(super) fn assemble_work_item(
    core: WorkItemCore,
    labels: Vec<String>,
    extras: ExtrasPayload,
) -> WorkItemData {
    let frontmatter = WorkItemFrontmatter {
        id: core.work_item_id,
        short_id: core.short_id.clone(),
        title: core.title,
        project: core.project_id,
        status: core.status,
        priority: core.priority,
        assignee: core.assignee,
        assignee_type: core.assignee_type,
        labels,
        milestone: core.milestone,
        parent: core.parent,
        stage: extras.stage,
        start_date: core.start_date,
        target_date: core.target_date,
        created_by: extras.created_by,
        origin_session: extras.origin_session,
        created_at: to_iso8601(core.created_at_ms),
        updated_at: to_iso8601(core.updated_at_ms),
        deleted_at: core.deleted_at_ms.map(to_iso8601),
        starred: extras.starred,
        todos: extras.todos,
        comments: extras.comments,
        history: extras.history,
        delegations: extras.delegations,
        handoff: extras.handoff,
        linked_sessions: extras.linked_sessions,
        proof_of_work: extras.proof_of_work,
        orchestrator_config: extras.orchestrator_config,
        orchestrator_state: extras.orchestrator_state,
        follow_up_items: extras.follow_up_items,
        schedule: extras.schedule,
        routine_source: extras.routine_source,
        execution_lock: extras.execution_lock,
        close_out: extras.close_out,
        work_products: extras.work_products,
    };
    WorkItemData {
        frontmatter,
        body: core.body,
        filename: core.short_id,
    }
}

pub(super) fn read_labels_for<C>(connection: &C, work_item_id: &str) -> Result<Vec<String>, String>
where
    C: ConnectionLike,
{
    connection.query_string_rows(
        "SELECT label_id FROM workitem_labels WHERE work_item_id = ?1 ORDER BY label_id",
        params![work_item_id],
    )
}

pub(super) fn read_extras_for<C>(
    connection: &C,
    work_item_id: &str,
) -> Result<ExtrasPayload, String>
where
    C: ConnectionLike,
{
    let raw = connection.query_row_optional(
        "SELECT extras_json FROM workitem_extras WHERE work_item_id = ?1",
        params![work_item_id],
        |row| row.get::<_, String>(0),
    )?;
    Ok(parse_extras_json(work_item_id, raw.as_deref()))
}

pub(super) fn parse_extras_json(work_item_id: &str, raw: Option<&str>) -> ExtrasPayload {
    // Silent fallback to `ExtrasPayload::default()` on a corrupt row
    // is a data-loss path: the orchestrator/atomic mutators read this
    // payload, mutate it, then write it back — overwriting the corrupt
    // row with a default that has no `field_revisions` / `external_refs`
    // / `orchestrator_state`. Warn so DB corruption / schema drift is
    // visible before the next mutator overwrites the recoverable row.
    match raw {
        Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    work_item_id = %work_item_id,
                    error = %err,
                    raw_len = json.len(),
                    "work_items::read_extras_for: extras_json parse failed; using empty extras (next mutator will OVERWRITE this row)"
                );
                ExtrasPayload::default()
            }
        },
        None => ExtrasPayload::default(),
    }
}

/// Minimal abstraction over `Connection` and `Transaction` so read
/// helpers don't need two implementations. `rusqlite` doesn't ship one,
/// so we keep scope to the two operations actually needed here.
pub(super) trait ConnectionLike {
    fn query_row_optional<T, F>(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
        mapper: F,
    ) -> Result<Option<T>, String>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>;

    fn query_string_rows(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<String>, String>;
}

impl ConnectionLike for rusqlite::Connection {
    fn query_row_optional<T, F>(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
        mapper: F,
    ) -> Result<Option<T>, String>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        map_db(self.query_row(sql, params, mapper).optional())
    }

    fn query_string_rows(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<String>, String> {
        let mut stmt = map_db(self.prepare(sql))?;
        let rows = map_db(stmt.query_map(params, |row| row.get::<_, String>(0)))?;
        let mut out = Vec::new();
        for entry in rows {
            out.push(map_db(entry)?);
        }
        Ok(out)
    }
}

impl ConnectionLike for database::db::PooledConnection {
    fn query_row_optional<T, F>(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
        mapper: F,
    ) -> Result<Option<T>, String>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        rusqlite::Connection::query_row_optional(self, sql, params, mapper)
    }

    fn query_string_rows(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<String>, String> {
        rusqlite::Connection::query_string_rows(self, sql, params)
    }
}

impl ConnectionLike for rusqlite::Transaction<'_> {
    fn query_row_optional<T, F>(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
        mapper: F,
    ) -> Result<Option<T>, String>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        map_db(self.query_row(sql, params, mapper).optional())
    }

    fn query_string_rows(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<String>, String> {
        let mut stmt = map_db(self.prepare(sql))?;
        let rows = map_db(stmt.query_map(params, |row| row.get::<_, String>(0)))?;
        let mut out = Vec::new();
        for entry in rows {
            out.push(map_db(entry)?);
        }
        Ok(out)
    }
}
