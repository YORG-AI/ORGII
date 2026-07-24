//! Durable compaction lineage and source-range retrieval.

use crate::foundation::db_bridge::get_connection;
use crate::foundation::persistence::db_helpers::AgentMessageRow;
use rusqlite::{params, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Serialize};

pub const COMPACTION_SCHEMA_VERSION: &str = "grill-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionBoundaryRecord {
    pub id: String,
    pub source_session_id: String,
    pub target_session_id: String,
    pub parent_session_id: Option<String>,
    pub compaction_index: i64,
    pub covered_from_sequence: Option<i64>,
    pub covered_to_sequence: Option<i64>,
    pub kept_from_sequence: Option<i64>,
    pub kept_to_sequence: Option<i64>,
    pub summary_message_id: Option<String>,
    pub trigger: String,
    pub model: Option<String>,
    pub route: Option<String>,
    pub schema_version: String,
    pub created_at: String,
}

pub fn ensure_schema(conn: &rusqlite::Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_compaction_boundaries (
            id TEXT PRIMARY KEY,
            source_session_id TEXT NOT NULL,
            target_session_id TEXT NOT NULL,
            parent_session_id TEXT,
            compaction_index INTEGER NOT NULL,
            covered_from_sequence INTEGER,
            covered_to_sequence INTEGER,
            kept_from_sequence INTEGER,
            kept_to_sequence INTEGER,
            summary_message_id TEXT,
            trigger TEXT NOT NULL,
            model TEXT,
            route TEXT,
            schema_version TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_acb_target_index
            ON agent_compaction_boundaries(target_session_id, compaction_index);
        CREATE INDEX IF NOT EXISTS idx_acb_source
            ON agent_compaction_boundaries(source_session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_acb_parent
            ON agent_compaction_boundaries(parent_session_id, created_at);",
    )
}

pub fn next_compaction_index(target_session_id: &str) -> SqliteResult<i64> {
    let conn = get_connection()?;
    ensure_schema(&conn)?;
    conn.query_row(
        "SELECT COALESCE(MAX(compaction_index), 0) + 1
         FROM agent_compaction_boundaries WHERE target_session_id = ?1",
        [target_session_id],
        |row| row.get(0),
    )
}

pub fn save_compaction_boundary(record: &CompactionBoundaryRecord) -> SqliteResult<()> {
    let conn = get_connection()?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO agent_compaction_boundaries (
            id, source_session_id, target_session_id, parent_session_id, compaction_index,
            covered_from_sequence, covered_to_sequence, kept_from_sequence, kept_to_sequence,
            summary_message_id, trigger, model, route, schema_version, created_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
         )",
        params![
            record.id,
            record.source_session_id,
            record.target_session_id,
            record.parent_session_id,
            record.compaction_index,
            record.covered_from_sequence,
            record.covered_to_sequence,
            record.kept_from_sequence,
            record.kept_to_sequence,
            record.summary_message_id,
            record.trigger,
            record.model,
            record.route,
            record.schema_version,
            record.created_at,
        ],
    )?;
    Ok(())
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CompactionBoundaryRecord> {
    Ok(CompactionBoundaryRecord {
        id: row.get(0)?,
        source_session_id: row.get(1)?,
        target_session_id: row.get(2)?,
        parent_session_id: row.get(3)?,
        compaction_index: row.get(4)?,
        covered_from_sequence: row.get(5)?,
        covered_to_sequence: row.get(6)?,
        kept_from_sequence: row.get(7)?,
        kept_to_sequence: row.get(8)?,
        summary_message_id: row.get(9)?,
        trigger: row.get(10)?,
        model: row.get(11)?,
        route: row.get(12)?,
        schema_version: row.get(13)?,
        created_at: row.get(14)?,
    })
}

const SELECT_BOUNDARIES: &str = "SELECT id, source_session_id, target_session_id, parent_session_id, compaction_index, covered_from_sequence, covered_to_sequence, kept_from_sequence, kept_to_sequence, summary_message_id, trigger, model, route, schema_version, created_at FROM agent_compaction_boundaries";

pub fn list_compaction_boundaries(session_id: &str) -> SqliteResult<Vec<CompactionBoundaryRecord>> {
    let conn = get_connection()?;
    ensure_schema(&conn)?;
    let mut query = conn.prepare(&format!(
        "{SELECT_BOUNDARIES} WHERE target_session_id = ?1 OR source_session_id = ?1 OR parent_session_id = ?1 ORDER BY created_at"
    ))?;
    let boundaries = query.query_map([session_id], record_from_row)?.collect();
    boundaries
}

pub fn get_compaction_boundary(id: &str) -> SqliteResult<Option<CompactionBoundaryRecord>> {
    let conn = get_connection()?;
    ensure_schema(&conn)?;
    conn.query_row(
        &format!("{SELECT_BOUNDARIES} WHERE id = ?1"),
        [id],
        record_from_row,
    )
    .optional()
}

pub fn load_boundary_source_messages(
    id: &str,
    from: Option<i64>,
    to: Option<i64>,
) -> SqliteResult<Vec<AgentMessageRow>> {
    let Some(boundary) = get_compaction_boundary(id)? else {
        return Ok(Vec::new());
    };
    let lower_bound = from.or(boundary.covered_from_sequence).unwrap_or(i64::MIN);
    let upper_bound = to.or(boundary.covered_to_sequence).unwrap_or(i64::MAX);
    let conn = get_connection()?;
    let mut query = conn.prepare(
        "SELECT id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output,
                model, sequence, created_at, images, compact_from_sequence,
                compact_tokens_before, compact_tokens_after
         FROM agent_messages
         WHERE session_id = ?1 AND sequence BETWEEN ?2 AND ?3
         ORDER BY sequence",
    )?;
    let rows = query.query_map(
        params![boundary.source_session_id, lower_bound, upper_bound],
        |row| {
            Ok(AgentMessageRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_name: row.get(4)?,
                tool_call_id: row.get(5)?,
                tool_input: row.get(6)?,
                tool_output: row.get(7)?,
                model: row.get(8)?,
                sequence: row.get(9)?,
                created_at: row.get(10)?,
                images: row.get(11)?,
                compact_from_sequence: row.get(12)?,
                compact_tokens_before: row.get(13)?,
                compact_tokens_after: row.get(14)?,
            })
        },
    )?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_initialization_is_idempotent() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        ensure_schema(&conn).expect("first schema initialization");
        ensure_schema(&conn).expect("second schema initialization");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_compaction_boundaries'",
                [],
                |row| row.get(0),
            )
            .expect("query schema");
        assert_eq!(count, 1);
    }
}
