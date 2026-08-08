//! Durable, explicit navigation state for the gateway's project tree.
//!
//! This deliberately lives beside, rather than inside, `gateway_bindings`:
//! a binding answers which conversation receives a normal message, while this
//! snapshot answers which read-only menu a chat is currently browsing.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use super::SessionKey;

pub const PAGE_SIZE: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowseLevel {
    Project,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrowseOption {
    Project {
        workspace_id: Option<String>,
        project_slug: String,
        name: String,
    },
    Session {
        session_id: String,
        terminal_turn_id: String,
        terminal_turn_status: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseState {
    pub session_key: String,
    pub level: BrowseLevel,
    pub workspace_id: Option<String>,
    pub project_slug: Option<String>,
    pub page: usize,
    pub options: Vec<BrowseOption>,
    pub updated_at: String,
}

pub fn load(key: &SessionKey) -> SqliteResult<Option<BrowseState>> {
    let conn = database::db::get_connection()?;
    init_schema(&conn)?;
    load_from(&conn, key.as_str())
}

pub fn save(state: &BrowseState) -> SqliteResult<()> {
    let conn = database::db::get_connection()?;
    init_schema(&conn)?;
    save_to(&conn, state)
}

pub fn clear(key: &SessionKey) -> SqliteResult<()> {
    let conn = database::db::get_connection()?;
    init_schema(&conn)?;
    conn.execute(
        "DELETE FROM gateway_browse_state WHERE session_key = ?1",
        [key.as_str()],
    )?;
    Ok(())
}

pub fn new_state(
    session_key: &SessionKey,
    level: BrowseLevel,
    workspace_id: Option<String>,
    project_slug: Option<String>,
    options: Vec<BrowseOption>,
) -> BrowseState {
    BrowseState {
        session_key: session_key.as_str().to_string(),
        level,
        workspace_id,
        project_slug,
        page: 0,
        options,
        updated_at: Utc::now().to_rfc3339(),
    }
}

pub fn page_slice(state: &BrowseState) -> &[BrowseOption] {
    let start = state.page.saturating_mul(PAGE_SIZE);
    if start >= state.options.len() {
        return &[];
    }
    let end = (start + PAGE_SIZE).min(state.options.len());
    &state.options[start..end]
}

pub fn page_count(state: &BrowseState) -> usize {
    state.options.len().div_ceil(PAGE_SIZE).max(1)
}

pub fn selection(state: &BrowseState, number: usize) -> Option<BrowseOption> {
    if number == 0 {
        return None;
    }
    page_slice(state).get(number - 1).cloned()
}

pub fn set_page(state: &mut BrowseState, page: usize) {
    state.page = page.min(page_count(state).saturating_sub(1));
    state.updated_at = Utc::now().to_rfc3339();
}

/// Install the durable browse state in `sessions.db`.
///
/// This is called by the unified session schema initializer. The public
/// function is also used by the read/write helpers so isolated callers that
/// open a raw connection retain the same idempotent behavior.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gateway_browse_state (
            session_key TEXT PRIMARY KEY NOT NULL,
            level TEXT NOT NULL,
            workspace_id TEXT,
            project_slug TEXT,
            work_item_id TEXT,
            page INTEGER NOT NULL,
            option_snapshot_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
}

fn load_from(conn: &Connection, session_key: &str) -> SqliteResult<Option<BrowseState>> {
    conn.query_row(
        "SELECT session_key, level, workspace_id, project_slug, work_item_id,
                page, option_snapshot_json, updated_at
         FROM gateway_browse_state WHERE session_key = ?1",
        [session_key],
        |row| {
            let level = match row.get::<_, String>(1)?.as_str() {
                "project" => BrowseLevel::Project,
                "session" => BrowseLevel::Session,
                other => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        format!("unknown gateway browse level {other:?}").into(),
                    ));
                }
            };
            let snapshot: String = row.get(6)?;
            let options = serde_json::from_str(&snapshot).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    err.into(),
                )
            })?;
            Ok(BrowseState {
                session_key: row.get(0)?,
                level,
                workspace_id: row.get(2)?,
                project_slug: row.get(3)?,
                page: row.get::<_, i64>(5)?.max(0) as usize,
                options,
                updated_at: row.get(7)?,
            })
        },
    )
    .optional()
}

fn save_to(conn: &Connection, state: &BrowseState) -> SqliteResult<()> {
    let level = match state.level {
        BrowseLevel::Project => "project",
        BrowseLevel::Session => "session",
    };
    let snapshot = serde_json::to_string(&state.options)
        .map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?;
    conn.execute(
        "INSERT INTO gateway_browse_state
            (session_key, level, workspace_id, project_slug, work_item_id, page,
             option_snapshot_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_key) DO UPDATE SET
            level = excluded.level,
            workspace_id = excluded.workspace_id,
            project_slug = excluded.project_slug,
            work_item_id = excluded.work_item_id,
            page = excluded.page,
            option_snapshot_json = excluded.option_snapshot_json,
            updated_at = excluded.updated_at",
        params![
            state.session_key,
            level,
            state.workspace_id,
            state.project_slug,
            Option::<String>::None,
            state.page as i64,
            snapshot,
            state.updated_at,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_with_its_stable_option_snapshot() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let state = BrowseState {
            session_key: "feishu:chat-1".to_string(),
            level: BrowseLevel::Session,
            workspace_id: Some("workspace-1".to_string()),
            project_slug: Some("org2".to_string()),
            page: 0,
            options: vec![BrowseOption::Session {
                session_id: "session-1".to_string(),
                terminal_turn_id: "turn-1".to_string(),
                terminal_turn_status: "completed".to_string(),
            }],
            updated_at: "2026-08-05T00:00:00Z".to_string(),
        };
        save_to(&conn, &state).unwrap();
        assert_eq!(load_from(&conn, "feishu:chat-1").unwrap(), Some(state));
    }

    #[test]
    fn legacy_work_item_snapshot_fails_closed_instead_of_restoring_old_hierarchy() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO gateway_browse_state
             (session_key, level, workspace_id, project_slug, work_item_id, page,
              option_snapshot_json, updated_at)
             VALUES (?1, 'work_item', NULL, 'org2', 'ORG-1', 0, '[]', ?2)",
            params!["feishu:legacy", "2026-08-08T00:00:00Z"],
        )
        .unwrap();
        assert!(load_from(&conn, "feishu:legacy").is_err());
    }

    #[test]
    fn selection_is_scoped_to_the_current_page() {
        let key = SessionKey("feishu:chat-1".to_string());
        let mut state = new_state(
            &key,
            BrowseLevel::Project,
            None,
            None,
            (0..9)
                .map(|n| BrowseOption::Project {
                    workspace_id: Some(format!("workspace-{n}")),
                    project_slug: format!("project-{n}"),
                    name: format!("项目 {n}"),
                })
                .collect(),
        );
        assert_eq!(selection(&state, 8).is_some(), true);
        assert_eq!(selection(&state, 9), None);
        set_page(&mut state, 1);
        assert_eq!(selection(&state, 1).is_some(), true);
        assert_eq!(selection(&state, 2), None);
    }
}
