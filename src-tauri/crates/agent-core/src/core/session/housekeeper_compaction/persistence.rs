use rusqlite::{params, Connection, OptionalExtension};

const TABLE: &str = "housekeeper_context_compaction";

#[derive(Clone, Debug)]
pub(crate) struct CompactionRecord {
    pub enabled: bool,
    pub summary: String,
    pub covered_message_count: usize,
    pub covered_prefix_hash: String,
    pub source_tokens: usize,
    pub summary_tokens: usize,
    pub status: String,
    pub last_error: Option<String>,
    pub last_run_at: Option<String>,
}

impl Default for CompactionRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            summary: String::new(),
            covered_message_count: 0,
            covered_prefix_hash: String::new(),
            source_tokens: 0,
            summary_tokens: 0,
            status: "disabled".to_string(),
            last_error: None,
            last_run_at: None,
        }
    }
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {TABLE} (
            session_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL DEFAULT '',
            covered_message_count INTEGER NOT NULL DEFAULT 0,
            covered_prefix_hash TEXT NOT NULL DEFAULT '',
            source_tokens INTEGER NOT NULL DEFAULT 0,
            summary_tokens INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'disabled',
            last_error TEXT,
            last_run_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_housekeeper_context_compaction_enabled
            ON {TABLE}(enabled, last_run_at);
        UPDATE {TABLE}
           SET status = CASE WHEN enabled = 1 THEN 'idle' ELSE 'disabled' END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status = 'running';"
    ))
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<CompactionRecord> {
    Ok(CompactionRecord {
        enabled: row.get::<_, i64>(0)? != 0,
        summary: row.get(1)?,
        covered_message_count: row.get::<_, i64>(2)?.max(0) as usize,
        covered_prefix_hash: row.get(3)?,
        source_tokens: row.get::<_, i64>(4)?.max(0) as usize,
        summary_tokens: row.get::<_, i64>(5)?.max(0) as usize,
        status: row.get(6)?,
        last_error: row.get(7)?,
        last_run_at: row.get(8)?,
    })
}

fn load_with_conn(conn: &Connection, session_id: &str) -> rusqlite::Result<CompactionRecord> {
    conn.query_row(
        &format!(
            "SELECT enabled, summary, covered_message_count, covered_prefix_hash,
                    source_tokens, summary_tokens, status, last_error, last_run_at
               FROM {TABLE}
              WHERE session_id = ?1"
        ),
        [session_id],
        row_to_record,
    )
    .optional()
    .map(Option::unwrap_or_default)
}

pub(crate) fn load(session_id: &str) -> Result<CompactionRecord, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    load_with_conn(&conn, session_id).map_err(|err| err.to_string())
}

pub(crate) fn set_enabled(session_id: &str, enabled: bool) -> Result<(), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        &format!(
            "INSERT INTO {TABLE} (session_id, enabled, status, updated_at)
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(session_id) DO UPDATE SET
                enabled = excluded.enabled,
                status = excluded.status,
                last_error = NULL,
                updated_at = excluded.updated_at"
        ),
        params![
            session_id,
            i64::from(enabled),
            if enabled { "idle" } else { "disabled" }
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn acquire_run(session_id: &str) -> Result<bool, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let changed = conn
        .execute(
            &format!(
                "UPDATE {TABLE}
                    SET status = 'running', last_error = NULL,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE session_id = ?1 AND enabled = 1 AND status <> 'running'"
            ),
            [session_id],
        )
        .map_err(|err| err.to_string())?;
    Ok(changed == 1)
}

pub(crate) fn mark_idle(session_id: &str) -> Result<(), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        &format!(
            "UPDATE {TABLE}
                SET status = 'idle', last_error = NULL,
                    last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE session_id = ?1"
        ),
        [session_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn mark_error(session_id: &str, error: &str) -> Result<(), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        &format!(
            "UPDATE {TABLE}
                SET status = 'error', last_error = ?2,
                    last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE session_id = ?1"
        ),
        params![session_id, error],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn reset_progress(session_id: &str) -> Result<(), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        &format!(
            "UPDATE {TABLE}
                SET summary = '', covered_message_count = 0,
                    covered_prefix_hash = '', source_tokens = 0,
                    summary_tokens = 0, status = 'idle', last_error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE session_id = ?1"
        ),
        [session_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn save_success(
    session_id: &str,
    summary: &str,
    covered_message_count: usize,
    covered_prefix_hash: &str,
    source_tokens: usize,
    summary_tokens: usize,
) -> Result<(), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        &format!(
            "UPDATE {TABLE}
                SET summary = ?2, covered_message_count = ?3,
                    covered_prefix_hash = ?4, source_tokens = ?5,
                    summary_tokens = ?6, status = 'complete', last_error = NULL,
                    last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE session_id = ?1 AND enabled = 1"
        ),
        params![
            session_id,
            summary,
            covered_message_count as i64,
            covered_prefix_hash,
            source_tokens as i64,
            summary_tokens as i64,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn background_candidates(limit: usize) -> Result<Vec<String>, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT session_id
               FROM {TABLE}
              WHERE enabled = 1
                AND status <> 'running'
                AND (
                    status <> 'idle'
                    OR last_run_at IS NULL
                    OR datetime(last_run_at) <= datetime('now', '-2 minutes')
                )
                AND (
                    status <> 'error'
                    OR last_run_at IS NULL
                    OR datetime(last_run_at) <= datetime('now', '-5 minutes')
                )
              ORDER BY CASE WHEN last_run_at IS NULL THEN 0 ELSE 1 END,
                       datetime(last_run_at) ASC
              LIMIT ?1"
        ))
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([limit as i64], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_progress_without_touching_enablement() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        init_schema(&conn).expect("schema");
        conn.execute(
            &format!(
                "INSERT INTO {TABLE} (session_id, enabled, status) VALUES ('s1', 1, 'running')"
            ),
            [],
        )
        .expect("seed");
        conn.execute(
            &format!(
                "UPDATE {TABLE}
                    SET summary = 'summary', covered_message_count = 4,
                        covered_prefix_hash = 'hash', source_tokens = 100,
                        summary_tokens = 20, status = 'complete'
                  WHERE session_id = 's1'"
            ),
            [],
        )
        .expect("save");

        let record = load_with_conn(&conn, "s1").expect("load");
        assert!(record.enabled);
        assert_eq!(record.summary, "summary");
        assert_eq!(record.covered_message_count, 4);
        assert_eq!(record.status, "complete");
    }

    #[test]
    fn startup_recovers_running_rows() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        init_schema(&conn).expect("schema");
        conn.execute(
            &format!(
                "INSERT INTO {TABLE} (session_id, enabled, status) VALUES ('s1', 1, 'running')"
            ),
            [],
        )
        .expect("seed");

        init_schema(&conn).expect("re-run schema");
        assert_eq!(load_with_conn(&conn, "s1").expect("load").status, "idle");
    }
}
