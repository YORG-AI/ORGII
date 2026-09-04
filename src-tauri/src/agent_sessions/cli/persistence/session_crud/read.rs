//! Read-side queries over `code_sessions` (single row, full list, paged
//! sidebar keyset, lifecycle-only snapshots) and the shared row mapper.

use rusqlite::{params, Result as SqliteResult};

use agent_core::session::AgentExecMode;
use database::db::get_connection;

use crate::agent_sessions::cli::persistence::types::{CliSessionStatusSnapshot, CodeSession};
use crate::agent_sessions::cli::types::{KeySource, SessionStatus};

/// Column list shared by get_session and list_sessions.
/// COALESCE(cli_agent_type, platform) provides backward compat for rows written before the migration.
const SESSION_COLUMNS: &str =
    "cs.session_id, cs.name, cs.status, cs.flow, cs.runner,
     COALESCE(cs.cli_agent_type, cs.platform), cs.model, cs.tier, cs.account_id, cs.repo_path, cs.branch, cs.user_input,
     cs.proxy_token, cs.proxy_url, cs.hosted_token, cs.error_message,
     COALESCE((SELECT total_tokens FROM orgtrack_core_session_usage WHERE session_id = cs.session_id), 0),
     cs.pid, cs.cli_session_id, cs.proxy_session_id,
     cs.worktree_path, cs.worktree_branch, cs.base_branch, cs.merge_status,
     COALESCE(cs.background, 0),
     COALESCE(cs.key_source, 'own_key'),
     cs.agent_exec_mode, cs.draft_text, cs.reply_target_event_id,
     COALESCE(cs.pinned, 0), cs.additional_directories,
     cs.parent_session_id, cs.org_member_id,
     COALESCE(cs.org_id, 'personal-org'), cs.project_id, cs.project_name,
     cs.project_slug, cs.work_item_id, cs.agent_role,
     cs.created_at, cs.updated_at,
     COALESCE(cs.transcript_source, 'chunks'), cs.product_mode";

/// Get a session by ID.
pub fn get_session(session_id: &str) -> SqliteResult<Option<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs WHERE cs.session_id = ?1",
        SESSION_COLUMNS
    );
    let result = conn.query_row(&query, [session_id], row_to_session);
    match result {
        Ok(s) => Ok(Some(s)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// List all code sessions, newest first.
pub fn list_sessions() -> SqliteResult<Vec<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs ORDER BY cs.created_at DESC",
        SESSION_COLUMNS
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([], row_to_session)?;
    rows.collect()
}

/// Load only lifecycle fields for a bounded set of sessions. This is used by
/// reconnect/focus reconciliation and deliberately avoids hydrating complete
/// session rows or scanning unrelated sessions.
pub fn status_snapshots(session_ids: &[String]) -> SqliteResult<Vec<CliSessionStatusSnapshot>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = get_connection()?;
    let placeholders = std::iter::repeat_n("?", session_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT session_id, status, updated_at FROM code_sessions WHERE session_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(session_ids), |row| {
        let raw_status: String = row.get(1)?;
        let status = SessionStatus::parse(&raw_status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                format!("invalid code session status: {raw_status}").into(),
            )
        })?;
        Ok(CliSessionStatusSnapshot {
            session_id: row.get(0)?,
            status,
            updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// One page of sessions ordered by recent activity. Serves the sidebar's
/// paginated category view without loading the whole table.
pub fn list_sessions_page(limit: usize, offset: usize) -> SqliteResult<Vec<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs ORDER BY cs.updated_at DESC LIMIT ?1 OFFSET ?2",
        SESSION_COLUMNS
    );
    let limit = limit.min(i64::MAX as usize) as i64;
    let offset = offset.min(i64::MAX as usize) as i64;
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params![limit, offset], row_to_session)?;
    rows.collect()
}

/// One stable-keyset page of unpinned, top-level CLI sessions for the sidebar.
///
/// `pinned` and `parent_session_id` are filtered before LIMIT so neither
/// pinned sessions nor worker/subagent rows consume ordinary CLI capacity.
pub fn list_unpinned_root_sessions_page(
    limit: usize,
    cursor: Option<(&str, &str)>,
) -> SqliteResult<Vec<CodeSession>> {
    let conn = get_connection()?;
    let bounded_limit = limit.min(i64::MAX as usize) as i64;
    if let Some((updated_at, session_id)) = cursor {
        let query = format!(
            "SELECT {} FROM code_sessions cs
             WHERE cs.pinned = 0
               AND cs.parent_session_id IS NULL
               AND (
                 cs.updated_at < ?1
                 OR (cs.updated_at = ?1 AND cs.session_id < ?2)
               )
             ORDER BY cs.updated_at DESC, cs.session_id DESC
             LIMIT ?3",
            SESSION_COLUMNS
        );
        let mut stmt = conn.prepare(&query)?;
        let rows = stmt.query_map(
            params![updated_at, session_id, bounded_limit],
            row_to_session,
        )?;
        return rows.collect();
    }

    let query = format!(
        "SELECT {} FROM code_sessions cs
         WHERE cs.pinned = 0
           AND cs.parent_session_id IS NULL
         ORDER BY cs.updated_at DESC, cs.session_id DESC
         LIMIT ?1",
        SESSION_COLUMNS
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params![bounded_limit], row_to_session)?;
    rows.collect()
}

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<CodeSession> {
    let status_str: String = row.get(2)?;
    let key_source_str: String = row.get(25)?;

    // DB columns must round-trip the typed enum. An unknown variant means
    // either DB corruption or an out-of-band write — surface it as a
    // `FromSqlConversionFailure` instead of silently mapping to a generic
    // default, which would mis-bill (key_source) or hide a stuck-state row
    // (status).
    let status = SessionStatus::parse(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("unknown SessionStatus value: {status_str:?}").into(),
        )
    })?;
    let key_source = KeySource::parse(&key_source_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            25,
            rusqlite::types::Type::Text,
            format!("unknown KeySource value: {key_source_str:?}").into(),
        )
    })?;
    let agent_exec_mode: Option<String> = row.get(26)?;
    if let Some(mode) = agent_exec_mode.as_deref() {
        if AgentExecMode::parse(mode).is_none() {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                26,
                rusqlite::types::Type::Text,
                format!("unknown AgentExecMode value: {mode:?}").into(),
            ));
        }
    }

    Ok(CodeSession {
        session_id: row.get(0)?,
        name: row.get(1)?,
        status,
        flow: row.get(3)?,
        runner: row.get(4)?,
        cli_agent_type: row.get(5)?,
        model: row.get(6)?,
        tier: row.get(7)?,
        account_id: row.get(8)?,
        repo_path: row.get(9)?,
        branch: row.get(10)?,
        user_input: row.get(11)?,
        proxy_token: row.get(12)?,
        proxy_url: row.get(13)?,
        hosted_token: row.get(14)?,
        error_message: row.get(15)?,
        total_tokens: row.get(16)?,
        pid: row.get(17)?,
        cli_session_id: row.get(18)?,
        proxy_session_id: row.get(19)?,
        worktree_path: row.get(20)?,
        worktree_branch: row.get(21)?,
        base_branch: row.get(22)?,
        merge_status: row.get(23)?,
        background: row.get::<_, bool>(24).unwrap_or(false),
        key_source,
        agent_exec_mode,
        draft_text: row.get(27)?,
        reply_target_event_id: row.get(28)?,
        pinned: row.get::<_, bool>(29).unwrap_or(false),
        additional_directories: row
            .get::<_, Option<String>>(30)?
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .filter(|v| !v.is_empty()),
        parent_session_id: row.get(31)?,
        org_member_id: row.get(32)?,
        org_id: row.get(33)?,
        project_id: row.get(34)?,
        project_name: row.get(35)?,
        project_slug: row.get(36)?,
        work_item_id: row.get(37)?,
        agent_role: row.get(38)?,
        created_at: row.get(39)?,
        updated_at: row.get(40)?,
        transcript_source: row.get(41)?,
        product_mode: row.get(42)?,
    })
}
