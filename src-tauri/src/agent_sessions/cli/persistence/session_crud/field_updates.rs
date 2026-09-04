//! Per-session field writes: display name, model/account switch, project
//! linkage, mode axes, composer state, pin state, and proxy credentials.

use rusqlite::{params, OptionalExtension, Result as SqliteResult};

use agent_core::session::AgentExecMode;
use database::db::get_connection;

use super::resume_state::mapped_cli_session_id_for_account_with_conn;
use super::shared::{now_iso, sync_orgtrack_mirror};

/// Update the display name for a CLI session.
/// Metadata write — does not bump `updated_at`.
pub fn update_name(session_id: &str, name: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET name = ?2 WHERE session_id = ?1",
        params![session_id, name],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the model and/or account_id for mid-session switching.
/// Config write — does not bump `updated_at`.
///
/// Transactional: the read of the current row + resume map and the UPDATE
/// happen atomically, so a concurrent writer (slow old runner committing a
/// fresh cli_session_id, health checker) cannot interleave between the read
/// and the write and make the carried `cli_session_id` stale.
pub fn update_model_and_account(
    session_id: &str,
    model: Option<&str>,
    account_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let tx = conn.unchecked_transaction()?;
    let current: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT account_id, cli_session_id FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mapped_cli_session_id = if let Some(target_account_id) = account_id {
        let mapped =
            mapped_cli_session_id_for_account_with_conn(&tx, session_id, Some(target_account_id))?;
        match (mapped, current.as_ref()) {
            (Some(cli_session_id), _) => Some(cli_session_id),
            (None, Some((current_account_id, current_cli_session_id)))
                if current_account_id.as_deref() == Some(target_account_id) =>
            {
                current_cli_session_id.clone()
            }
            (None, _) => None,
        }
    } else {
        None
    };
    let affected = match (model, account_id) {
        (Some(model), Some(account_id)) => tx.execute(
            "UPDATE code_sessions
             SET model = ?2,
                 account_id = ?3,
                 cli_session_id = ?4
             WHERE session_id = ?1",
            params![session_id, model, account_id, mapped_cli_session_id],
        )?,
        (Some(model), None) => tx.execute(
            "UPDATE code_sessions SET model = ?2 WHERE session_id = ?1",
            params![session_id, model],
        )?,
        (None, Some(account_id)) => tx.execute(
            "UPDATE code_sessions
             SET account_id = ?2,
                 cli_session_id = ?3
             WHERE session_id = ?1",
            params![session_id, account_id, mapped_cli_session_id],
        )?,
        (None, None) => 0,
    };
    tx.commit()?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Link the Project root Work Item created by the bootstrap flow.
/// Guarded on `work_item_id IS NULL` so a concurrent duplicate submit
/// can never repoint an already-linked session (same contract as the
/// agent-side `link_bootstrap_work_item`).
pub fn link_bootstrap_work_item(session_id: &str, work_item_id: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions
         SET work_item_id = ?2, updated_at = ?3
         WHERE session_id = ?1 AND work_item_id IS NULL",
        params![session_id, work_item_id, now_iso()],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Set the product-mode axis (validated upstream by `session_patch`).
pub fn update_product_mode(session_id: &str, product_mode: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET product_mode = ?2, updated_at = ?3 WHERE session_id = ?1",
        params![session_id, product_mode, now_iso()],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the per-session execution mode on a CLI session row.
/// Mirrors `agent_core::session::persistence::update_agent_exec_mode`.
/// Does not bump `updated_at`; this is composer control state, not activity.
pub fn update_agent_exec_mode(session_id: &str, mode: &str) -> SqliteResult<bool> {
    let parsed = AgentExecMode::parse(mode).ok_or_else(|| {
        rusqlite::Error::ToSqlConversionFailure(
            format!("unknown AgentExecMode value: {mode:?}").into(),
        )
    })?;
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET agent_exec_mode = ?2 WHERE session_id = ?1",
        params![session_id, parsed.as_str()],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Atomically update the product-mode and execution-mode axes behind one
/// composer selection. See the native-session equivalent for the invariant.
pub fn update_mode_axes(
    session_id: &str,
    product_mode: &str,
    agent_exec_mode: &str,
) -> SqliteResult<bool> {
    let parsed = AgentExecMode::parse(agent_exec_mode).ok_or_else(|| {
        rusqlite::Error::ToSqlConversionFailure(
            format!("unknown AgentExecMode value: {agent_exec_mode:?}").into(),
        )
    })?;
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions
         SET product_mode = ?2, agent_exec_mode = ?3
         WHERE session_id = ?1",
        params![session_id, product_mode, parsed.as_str()],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the per-session unsent draft text on a CLI session row.
/// Mirror of `agent_core::session::persistence::update_draft_text` —
/// see that helper for the empty-string normalization rationale.
/// Composer state — does not bump `updated_at`.
pub fn update_draft_text(session_id: &str, text: Option<&str>) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let normalized = match text {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE code_sessions SET draft_text = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}

/// Update the per-session reply target event id on a CLI session row.
/// Composer state — does not bump `updated_at`.
pub fn update_reply_target_event_id(
    session_id: &str,
    event_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let normalized = match event_id {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE code_sessions SET reply_target_event_id = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}

/// Update the sidebar pin state on a CLI session row.
pub fn update_pinned(session_id: &str, pinned: bool) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET pinned = ?2 WHERE session_id = ?1",
        params![session_id, pinned],
    )?;
    Ok(affected > 0)
}

/// Update proxy credentials (token, URL, proxy_session_id) after re-allocation.
/// Token rotation is config — does not bump `updated_at`.
pub fn update_proxy_credentials(
    session_id: &str,
    proxy_token: &str,
    proxy_url: &str,
    proxy_session_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET proxy_token = ?2, proxy_url = ?3, proxy_session_id = ?4 WHERE session_id = ?1",
        params![session_id, proxy_token, proxy_url, proxy_session_id],
    )?;
    Ok(affected > 0)
}
