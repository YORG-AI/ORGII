//! Session CRUD operations: upsert / list / status / model / parent links / delete.
//!
//! All queries against `agent_sessions` go through the constants and row
//! mapper in [`super::record`] so the column list stays in one place.

use chrono::Utc;
use rusqlite::{params, Result as SqliteResult};
use tracing::warn;

use crate::persistence::db_helpers as shared;
use database::db::{get_connection, with_sessions_writer};

use super::super::super::types::{SessionListFilter, SessionStatus};
use super::record::{row_to_record, session_type, UnifiedSessionRecord, UNIFIED_SESSION_SELECT};

/// SQL statement used by [`upsert_session`].
///
/// Lives at module scope (not inside the function) so the round-trip
/// test below can exercise the same string against an in-memory DB,
/// catching column-list / placeholder-count drift without needing the
/// real `~/.orgii` connection.
pub(super) const UPSERT_SESSION_SQL: &str = r#"
INSERT INTO agent_sessions (
    session_id, name, status, model, account_id, user_input,
    created_at, updated_at, session_type, channel, chat_id,
    workspace_path, org_id, project_id, project_name,
    work_item_id, agent_role, worktree_path,
    worktree_branch, base_branch, merge_status,
    project_slug, agent_definition_id, org_member_id, parent_session_id, parent_event_id,
    workspace_additional_json, key_source, agent_exec_mode, native_harness_type,
    draft_text, reply_target_event_id, pinned
)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)
ON CONFLICT(session_id) DO UPDATE SET
    name                       = excluded.name,
    status                     = excluded.status,
    model                      = COALESCE(excluded.model, agent_sessions.model),
    account_id                 = COALESCE(excluded.account_id, agent_sessions.account_id),
    user_input                 = excluded.user_input,
    updated_at                 = excluded.updated_at,
    session_type               = excluded.session_type,
    channel                    = COALESCE(excluded.channel, agent_sessions.channel),
    chat_id                    = COALESCE(excluded.chat_id, agent_sessions.chat_id),
    workspace_path               = COALESCE(excluded.workspace_path, agent_sessions.workspace_path),
    org_id                     = COALESCE(excluded.org_id, agent_sessions.org_id),
    project_id                 = COALESCE(excluded.project_id, agent_sessions.project_id),
    project_name               = COALESCE(excluded.project_name, agent_sessions.project_name),
    work_item_id               = COALESCE(excluded.work_item_id, agent_sessions.work_item_id),
    agent_role                 = COALESCE(excluded.agent_role, agent_sessions.agent_role),
    worktree_path             = COALESCE(excluded.worktree_path, agent_sessions.worktree_path),
    worktree_branch            = COALESCE(excluded.worktree_branch, agent_sessions.worktree_branch),
    base_branch                = COALESCE(excluded.base_branch, agent_sessions.base_branch),
    merge_status               = COALESCE(excluded.merge_status, agent_sessions.merge_status),
    project_slug               = COALESCE(excluded.project_slug, agent_sessions.project_slug),
    agent_definition_id        = COALESCE(excluded.agent_definition_id, agent_sessions.agent_definition_id),
    org_member_id              = COALESCE(excluded.org_member_id, agent_sessions.org_member_id),
    parent_session_id          = COALESCE(excluded.parent_session_id, agent_sessions.parent_session_id),
    parent_event_id            = COALESCE(excluded.parent_event_id, agent_sessions.parent_event_id),
    -- Preserve existing workspace JSON unless the caller
    -- explicitly wrote a non-default value. This stops
    -- full-record upserts from `UnifiedSessionRecord::from_session`
    -- (which uses the `'{}'` default) from clobbering dirs
    -- added via `save_workspace`.
    workspace_additional_json  = CASE
        WHEN excluded.workspace_additional_json = '{}' THEN agent_sessions.workspace_additional_json
        ELSE excluded.workspace_additional_json
    END,
    -- `key_source` is set once at session create and never
    -- mutated by background upserts (compaction-fork, gateway
    -- pipeline, project-init re-runs). Preserving the original
    -- value on conflict keeps the billing dimension stable for
    -- the lifetime of the row; otherwise a `Default::default()`
    -- spread on a partial upsert would silently re-flag a
    -- market session as `own_key'.
    key_source                 = agent_sessions.key_source,
    -- `agent_exec_mode` is the user's per-session ModePill choice. Like
    -- `key_source` above, it must NOT be touched by background upserts
    -- (turn finalization, compaction-fork, gateway pipeline) — only the
    -- explicit `update_agent_exec_mode` path (driven by `session_patch`
    -- from the frontend) writes here. Preserving the existing value on
    -- conflict guarantees the user's last ModePill click survives every
    -- background row refresh.
    agent_exec_mode            = agent_sessions.agent_exec_mode,
    -- `native_harness_type` is selected at session create and must remain
    -- stable for the session lifetime; background row refreshes use default
    -- records and must not clear or switch the provider implementation.
    native_harness_type        = COALESCE(agent_sessions.native_harness_type, excluded.native_harness_type),
    -- `draft_text` and `reply_target_event_id` are user composer state
    -- (P3). Same posture as `agent_exec_mode` above: only the explicit
    -- `update_draft_text` / `update_reply_target_event_id` helpers
    -- (driven by `session_patch` from the frontend) ever write them.
    -- Background row refreshes must not stomp on what the user is
    -- currently typing or replying to.
    draft_text                 = agent_sessions.draft_text,
    reply_target_event_id      = agent_sessions.reply_target_event_id,
    -- `pinned` is user-set metadata. Only the explicit `update_pinned`
    -- helper writes it; upserts must preserve whatever the user set last.
    pinned                     = agent_sessions.pinned
"#;

/// Upsert a unified session.
pub fn upsert_session(record: &UnifiedSessionRecord) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let key_source_str = record.key_source.as_ref();
        conn.execute(
            UPSERT_SESSION_SQL,
            params![
                record.session_id,
                record.name,
                record.status,
                record.model,
                record.account_id,
                record.user_input,
                record.created_at,
                record.updated_at,
                record.session_type,
                record.channel,
                record.chat_id,
                record.workspace_path,
                record.org_id,
                record.project_id,
                record.project_name,
                record.work_item_id,
                record.agent_role,
                record.worktree_path,
                record.worktree_branch,
                record.base_branch,
                record.merge_status,
                record.project_slug,
                record.agent_definition_id,
                record.org_member_id,
                record.parent_session_id,
                record.parent_event_id,
                record.workspace_additional_json,
                key_source_str,
                record.agent_exec_mode,
                record.native_harness_type,
                record.draft_text,
                record.reply_target_event_id,
                record.pinned as i64,
            ],
        )?;
        Ok(())
    })
}

/// Get a session by ID.
pub fn get_session(session_id: &str) -> SqliteResult<Option<UnifiedSessionRecord>> {
    let conn = get_connection()?;
    let sql = format!("{UNIFIED_SESSION_SELECT} WHERE s.session_id = ?1");
    shared::query_optional(conn.query_row(&sql, [session_id], row_to_record))
}

/// List sessions with optional filtering.
pub fn list_sessions(filter: &SessionListFilter) -> SqliteResult<Vec<UnifiedSessionRecord>> {
    let conn = get_connection()?;

    let mut conditions: Vec<String> = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ref type_name) = filter.type_name {
        conditions.push(format!("s.session_type = ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(type_name.clone()));
    } else {
        // Gateway is infrastructure, not a user-visible conversation.
        // Callers who explicitly want it must ask via `type_name = Some("gateway")`.
        conditions.push(format!("s.session_type != ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(session_type::GATEWAY.to_string()));
    }

    if let Some(ref status) = filter.status {
        conditions.push(format!("s.status = ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(status.clone()));
    } else {
        // Archived sessions (closed by idle-reset / compact-fork)
        // are hidden from default list views. They're recoverable via
        // explicit `filter.status = Archived` for audit/debug tooling,
        // but we don't want them polluting the session picker / sidebar.
        // Hermes parallel: `gateway/session.py:761` closes the old session
        // with reason `session_reset` so it no longer appears in active
        // listings.
        conditions.push(format!("s.status != ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(SessionStatus::Archived.as_str().to_string()));
    }

    if let Some(ref channel) = filter.channel {
        conditions.push(format!("s.channel = ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(channel.clone()));
    }

    if let Some(ref prefix) = filter.workspace_path_prefix {
        conditions.push(format!("s.workspace_path LIKE ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(format!("{}%", prefix)));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let limit_clause = filter
        .limit
        .map(|limit| format!("LIMIT {}", limit))
        .unwrap_or_default();

    let offset_clause = filter
        .offset
        .map(|offset| format!("OFFSET {}", offset))
        .unwrap_or_default();

    let sql = format!(
        "{UNIFIED_SESSION_SELECT} {where_clause} ORDER BY s.updated_at DESC {limit_clause} {offset_clause}"
    );

    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_refs.as_slice(), row_to_record)?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(rows)
}

/// Mark all sessions with an in-flight status (`running`, `waiting_for_user`,
/// `waiting_for_funds`) as `abandoned`.
///
/// Called once at app startup to clean up sessions that were mid-turn when the
/// process was killed (crash, dev-server restart, force-quit).  Without this,
/// `postLoad` reads a stale "running" status from SQLite and the frontend
/// shows a phantom active session that Rust knows nothing about.
///
/// Returns the number of rows updated.
pub fn mark_stale_running_sessions_abandoned() -> SqliteResult<usize> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let now = Utc::now().to_rfc3339();
        // The "in-flight" set: every status that means "an event loop or user
        // intent owns this session right now". Sourced from the typed enum so
        // adding a new in-flight variant only requires updating one place.
        let updated = conn.execute(
            "UPDATE agent_sessions SET status = ?1, updated_at = ?2 \
             WHERE status IN (?3, ?4, ?5)",
            params![
                SessionStatus::Abandoned.as_str(),
                now,
                SessionStatus::Running.as_str(),
                SessionStatus::WaitingForUser.as_str(),
                SessionStatus::WaitingForFunds.as_str(),
            ],
        )?;
        Ok(updated)
    })
}

/// Update session status.
pub fn update_status(session_id: &str, status: SessionStatus) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let now = Utc::now().to_rfc3339();
        let updated = conn.execute(
            "UPDATE agent_sessions SET status = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, status.as_str(), now],
        )?;
        Ok(updated > 0)
    })
}

/// Atomically persist the durable terminal-turn marker and the UI-visible
/// session status.
///
/// `agent:complete` is a transient stream signal; this helper gives the
/// backend a durable, queryable record that a turn reached a terminal state so
/// list/sidebar state can be reconciled if a process or frontend misses a
/// broadcast. The update is idempotent: repeating the same terminal marker for
/// a session leaves the row in the same final state.
pub fn finalize_terminal_turn_status(
    session_id: &str,
    turn_id: &str,
    turn_status: &str,
    session_status: SessionStatus,
    completed_at: &str,
) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let updated = conn.execute(
            "UPDATE agent_sessions
             SET status = ?2,
                 updated_at = ?3,
                 last_terminal_turn_id = ?4,
                 last_terminal_turn_status = ?5,
                 last_terminal_turn_at = ?3
             WHERE session_id = ?1",
            params![
                session_id,
                session_status.as_str(),
                completed_at,
                turn_id,
                turn_status,
            ],
        )?;
        Ok(updated > 0)
    })
}

/// Repair rows that still say `running` even though this backend has already
/// durably recorded a terminal turn for them.
///
/// This catches the exact failure mode where a turn finished and wrote its
/// terminal marker, but a later process/frontend observation still sees the
/// session-level status stuck in an in-flight state.
pub fn reconcile_sessions_with_terminal_turn_markers() -> SqliteResult<usize> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let updated = conn.execute(
            "UPDATE agent_sessions
             SET status = CASE
                   WHEN last_terminal_turn_status = ?4 THEN ?5
                   WHEN last_terminal_turn_status = ?6 THEN ?7
                   ELSE ?1
                 END,
                 updated_at = COALESCE(last_terminal_turn_at, updated_at)
             WHERE status IN (?2, ?3)
               AND last_terminal_turn_id IS NOT NULL
               AND last_terminal_turn_status IN (?4, ?6, ?8)",
            params![
                SessionStatus::Completed.as_str(),
                SessionStatus::Running.as_str(),
                SessionStatus::WaitingForFunds.as_str(),
                "cancelled",
                SessionStatus::Cancelled.as_str(),
                "failed",
                SessionStatus::Failed.as_str(),
                "completed",
            ],
        )?;
        Ok(updated)
    })
}

/// Link an existing session record to a Work Item. This is metadata, not
/// conversation activity, so it intentionally leaves `updated_at` untouched.
pub fn update_work_item_link(
    session_id: &str,
    org_id: &str,
    project_id: Option<&str>,
    project_name: Option<&str>,
    project_slug: &str,
    work_item_id: &str,
    agent_role: Option<&str>,
) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let updated = conn.execute(
            "UPDATE agent_sessions
             SET org_id = ?2,
                 project_id = COALESCE(?3, project_id),
                 project_name = COALESCE(?4, project_name),
                 work_item_id = ?5,
                 project_slug = ?6,
                 agent_role = COALESCE(?7, agent_role)
             WHERE session_id = ?1",
            params![
                session_id,
                org_id,
                project_id,
                project_name,
                work_item_id,
                project_slug,
                agent_role
            ],
        )?;
        Ok(updated > 0)
    })
}

/// Set the canonical Agent Org roster member id for a session.
pub fn update_org_member_id(session_id: &str, org_member_id: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let updated = conn.execute(
            "UPDATE agent_sessions SET org_member_id = ?2 WHERE session_id = ?1",
            params![session_id, org_member_id],
        )?;
        Ok(updated > 0)
    })
}

// `updated_at` invariant
// ----------------------
// `agent_sessions.updated_at` reflects **real conversation activity** —
// a user message landed, the agent replied, a turn finished, a status
// flipped. The sidebar order, Kanban time filter, and any "last
// touched" badges read it with that meaning.
//
// Per-session config / composer state writes (model picker, account
// switch, ModePill, draft text, reply pin, workspace dir add) are
// orthogonal to that signal. Touching them while a session sits idle
// must not move `updated_at`, otherwise an old completed thread the
// user merely opened to look at — or whose composer was re-seeded from
// a persisted draft on mount — would float to the top of every
// time-bucketed view.
//
// All `update_*` helpers below for those config columns therefore
// write only their target column, leaving `updated_at` to the
// activity-bearing paths (`update_status`, `upsert_session` from the
// send-message flow, etc.). Same posture is mirrored in
// `agent_sessions/cli/persistence.rs` for `code_sessions`.

/// Update the display name for a session. Does not bump `updated_at` —
/// renaming is metadata, not conversation activity.
pub fn update_name(session_id: &str, name: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = conn.execute(
            "UPDATE agent_sessions SET name = ?2 WHERE session_id = ?1",
            params![session_id, name],
        )?;
        Ok(affected > 0)
    })
}

/// Update the model for a session. Does not bump `updated_at` —
/// switching models is config, not activity.
pub fn update_model(session_id: &str, model: &str) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET model = ?2 WHERE session_id = ?1",
            params![session_id, model],
        )?;
        Ok(())
    })
}

/// Update the account_id for a session. Does not bump `updated_at`
/// (see invariant note above).
pub fn update_account_id(session_id: &str, account_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET account_id = ?2 WHERE session_id = ?1",
            params![session_id, account_id],
        )?;
        Ok(())
    })
}

/// Atomically update `model` and `account_id` together.
///
/// Used by `session_patch` so the frontend never observes a row where
/// `model` and `account_id` disagree mid-write (would mis-route the next
/// dispatch to the wrong key). Pass `account_id = None` if the caller is
/// only changing the model name within the same account.
///
/// Does not bump `updated_at` (see invariant note above).
pub fn update_model_and_account(
    session_id: &str,
    model: &str,
    account_id: Option<&str>,
) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = if let Some(acc_id) = account_id {
            conn.execute(
                "UPDATE agent_sessions SET model = ?2, account_id = ?3 WHERE session_id = ?1",
                params![session_id, model, acc_id],
            )?
        } else {
            conn.execute(
                "UPDATE agent_sessions SET model = ?2 WHERE session_id = ?1",
                params![session_id, model],
            )?
        };
        Ok(affected > 0)
    })
}

/// Update the per-session execution mode (`build` / `ask` /
/// `plan` / `debug` / `review` / `wingman`).
///
/// Only mutated through this function — never through the upsert path
/// (`UPSERT_SESSION_SQL` deliberately preserves the existing value on
/// conflict). The frontend `ModePill` calls this via `session_patch`
/// every time the user picks a mode for a specific session.
///
/// Does not bump `updated_at` (see invariant note above).
pub fn update_agent_exec_mode(session_id: &str, mode: &str) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = conn.execute(
            "UPDATE agent_sessions SET agent_exec_mode = ?2 WHERE session_id = ?1",
            params![session_id, mode],
        )?;
        Ok(affected > 0)
    })
}

/// Update the per-session unsent draft text. `text = None` clears the
/// column (i.e. "no draft"); `Some("")` is treated the same as `None`
/// so a debounced patch coming from an empty editor doesn't keep an
/// empty string lying around.
///
/// Same isolation contract as `update_agent_exec_mode`: only this
/// helper writes the column, the upsert path preserves it on conflict.
///
/// Does not bump `updated_at` (see invariant note above) — typing in
/// the composer is not conversation activity.
pub fn update_draft_text(session_id: &str, text: Option<&str>) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        update_draft_text_with_conn(&conn, session_id, text)
    })
}

/// Connection-injectable variant of [`update_draft_text`]. Production
/// callers go through the no-arg version above (which opens
/// `get_connection()`); the in-memory persistence tests build a
/// `Connection::open_in_memory()` and call this directly so the
/// "draft normalization + upsert isolation" contract is verified
/// against the real SQL, not just the function call.
pub fn update_draft_text_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    text: Option<&str>,
) -> SqliteResult<bool> {
    let normalized = match text {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE agent_sessions SET draft_text = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}

/// Update the per-session reply target message id. `event_id = None`
/// clears the banner (cleared on send / dismiss).
///
/// Does not bump `updated_at` (see invariant note above) — pinning a
/// reply target is composer state, not activity.
pub fn update_reply_target_event_id(
    session_id: &str,
    event_id: Option<&str>,
) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        update_reply_target_event_id_with_conn(&conn, session_id, event_id)
    })
}

/// Connection-injectable variant of [`update_reply_target_event_id`].
/// See [`update_draft_text_with_conn`] for the rationale.
pub fn update_reply_target_event_id_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    event_id: Option<&str>,
) -> SqliteResult<bool> {
    let normalized = match event_id {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE agent_sessions SET reply_target_event_id = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}
/// Update the `pinned` column for a session.
pub fn update_pinned(session_id: &str, pinned: bool) -> SqliteResult<bool> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = conn.execute(
            "UPDATE agent_sessions SET pinned = ?2 WHERE session_id = ?1",
            params![session_id, pinned as i64],
        )?;
        Ok(affected > 0)
    })
}

/// Set `agent_definition_id` on a session row that doesn't have one yet.
///
/// Used during init for auto-registered sessions (OS/SDE) whose DB row
/// was created before the definition was known.
pub fn backfill_agent_definition_id(session_id: &str, definition_id: &str) -> Result<(), String> {
    with_sessions_writer(|| -> Result<(), String> {
        let conn = get_connection().map_err(|err| format!("DB connection failed: {}", err))?;
        conn.execute(
            "UPDATE agent_sessions SET agent_definition_id = ?1 WHERE session_id = ?2 AND agent_definition_id IS NULL",
            params![definition_id, session_id],
        )
        .map_err(|err| format!("DB update failed: {}", err))?;
        Ok(())
    })
}

/// Delete a session and all related data.
///
/// Cascade order — each step is best-effort; a failure in a later step does
/// not roll back earlier ones because the row-level cleanups are independent:
///
/// 1. **Hard-delete tables** via `delete_session_cascade` (keyed by
///    `session_id`):
///    - `agent_messages` (with associated image-file cleanup)
///    - `agent_todos`
///    - `agent_snapshots`
///    - `agent_file_resolutions`
///    - `session_token_usage`
///    - `events` + `events_fts*` (event-sourced history)
///    - `pending_plan_approvals` (Plan-mode approval state)
///    - `agent_sessions` (the row itself, always last)
/// 2. **Lineage rows** via `lineage::delete_session_lineage`. Both
///    `node_provenance` (keyed by `session_id`) and `commit_lineage`
///    (keyed by `provenance_id` → `node_provenance.id`) — `commit_lineage`
///    can't ride the generic cascade because it has no `session_id` column.
/// 3. **Null-out soft references** in `learnings.source_session_id` — a
///    learning is a knowledge artefact that outlives the session that
///    produced it; we keep the row and only drop the back-pointer so it
///    never dangles to a dead session.
/// 4. **Per-session file-history directory** under `~/.orgii/file-history/`.
/// 5. **Agent worktree** (git worktree + `agent/<sid>` branch) under
///    `~/.orgii/agent-worktrees/<repo_hash>/<sid>/`. Only attempted when
///    the session had a `workspace_path` (worktree is rooted under the
///    project repo). The CLI-agent path cleans up via
///    `agent_sessions::cli::commands::delete_session` before hitting this
///    function, so a missing worktree is expected and not an error.
///
/// Note: `gateway_bindings` is **not** cleaned here because it has an
/// in-memory cache on top of the SQLite table (`BindingStore`) — writing
/// the DB directly would cause memory-vs-DB split-brain per Rule 6.
/// Orphan bindings are reaped by `infrastructure::housekeeping::
/// run_deferred_cleanup` instead, which can delete DB rows without
/// racing the runtime because the cache rehydrates from DB at startup.
pub fn delete_session(session_id: &str) -> SqliteResult<()> {
    let workspace_path = {
        let conn = get_connection()?;
        let row: SqliteResult<Option<String>> = conn.query_row(
            "SELECT workspace_path FROM agent_sessions WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        );
        match row {
            Ok(p) => p,
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(err) => {
                warn!(
                    "Failed to read workspace_path for session {}: {}",
                    session_id, err
                );
                None
            }
        }
    };

    shared::delete_session_cascade(
        session_id,
        &[
            "agent_messages",
            "agent_todos",
            "agent_snapshots",
            "agent_file_resolutions",
            "session_token_usage",
            "events",
            "pending_plan_approvals",
            "agent_sessions",
        ],
    )?;

    // Lineage tables can't ride the generic cascade: `commit_lineage` is keyed
    // by `provenance_id` (FK into `node_provenance`), not `session_id`, so the
    // generic `DELETE FROM commit_lineage WHERE session_id = ?1` fails at
    // prepare time. Walk the join explicitly and drop both tables here.
    if let Err(err) = project_management::lineage::delete_session_lineage(session_id) {
        warn!(
            "Failed to delete lineage rows for session {}: {}",
            session_id, err
        );
    }

    // Soft-unlink learnings produced by this session: keep the learning
    // itself (it is a knowledge artefact, not session transient state) but
    // null the back-pointer so it no longer dangles to a deleted session.
    let unlink_result = with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE learnings SET source_session_id = NULL WHERE source_session_id = ?1",
            [session_id],
        )?;
        Ok(())
    });
    if let Err(err) = unlink_result {
        warn!(
            "Failed to null learnings.source_session_id for deleted session {}: {}",
            session_id, err
        );
    }

    // Per-session file-history is addressed by session_id alone, so drop the
    // whole directory regardless of workspace_path. Other sessions on the same
    // project are untouched.
    if let Err(err) = crate::tools::file_history::remove_session(session_id) {
        warn!(
            "Failed to remove file-history for deleted session {}: {}",
            session_id, err
        );
    }

    // Tear down the per-session worktree + `agent/<sid>` branch. Only
    // meaningful when the session was grounded in a project; pure-channel
    // OS sessions without a `workspace_path` never had a worktree.
    if let Some(ref repo_path_str) = workspace_path {
        let repo_path = std::path::PathBuf::from(repo_path_str);
        if repo_path.exists() {
            if let Err(err) = git::worktree::remove_session_worktree(&repo_path, session_id, true) {
                warn!(
                    "Failed to remove agent worktree for deleted session {}: {}",
                    session_id, err
                );
            }
        }
    }

    Ok(())
}

/// Get all child sessions for a given parent session.
pub fn get_child_sessions(parent_session_id: &str) -> SqliteResult<Vec<UnifiedSessionRecord>> {
    let conn = get_connection()?;
    let sql = format!(
        "{UNIFIED_SESSION_SELECT} WHERE s.parent_session_id = ?1 ORDER BY s.created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([parent_session_id], row_to_record)?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Get the parent session for a given child session.
pub fn get_parent_session(session_id: &str) -> SqliteResult<Option<UnifiedSessionRecord>> {
    let session = get_session(session_id)?;
    match session.and_then(|s| s.parent_session_id) {
        Some(parent_id) => get_session(&parent_id),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_types::key_source::KeySource;

    /// Mirror the production `agent_sessions` schema columns referenced by
    /// [`UPSERT_SESSION_SQL`] and [`UNIFIED_SESSION_SELECT`]. Kept in this
    /// test module so it travels with the SQL strings — when a column is
    /// added/renamed the test breaks loudly instead of silently desyncing
    /// from the migration.
    const TEST_SCHEMA: &str = r#"
        CREATE TABLE agent_sessions (
            session_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            model TEXT,
            account_id TEXT,
            user_input TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            session_type TEXT NOT NULL DEFAULT 'agent',
            channel TEXT,
            chat_id TEXT,
            workspace_path TEXT,
            org_id TEXT,
            project_id TEXT,
            project_name TEXT,
            work_item_id TEXT,
            agent_role TEXT,
            worktree_path TEXT,
            worktree_branch TEXT,
            base_branch TEXT,
            merge_status TEXT,
            project_slug TEXT,
            agent_definition_id TEXT,
            org_member_id TEXT,
            parent_session_id TEXT,
            parent_event_id TEXT,
            workspace_additional_json TEXT NOT NULL DEFAULT '{}',
            key_source TEXT NOT NULL DEFAULT 'own_key',
            agent_exec_mode TEXT,
            native_harness_type TEXT,
            draft_text TEXT,
            reply_target_event_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE session_token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            session_type TEXT NOT NULL DEFAULT 'sde',
            model TEXT,
            account_id TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            context_tokens INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            created_at TEXT NOT NULL DEFAULT ''
        );
    "#;

    fn make_record(session_id: &str, key_source: KeySource) -> UnifiedSessionRecord {
        UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: "round-trip".to_string(),
            status: "idle".to_string(),
            model: Some("gpt-4o".to_string()),
            account_id: Some("acct-1".to_string()),
            workspace_path: Some("/tmp/proj".to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            session_type: "sde".to_string(),
            agent_definition_id: Some("builtin:sde".to_string()),
            key_source,
            ..Default::default()
        }
    }

    fn upsert_into(conn: &rusqlite::Connection, record: &UnifiedSessionRecord) {
        let key_source_str = record.key_source.as_ref();
        conn.execute(
            UPSERT_SESSION_SQL,
            params![
                record.session_id,
                record.name,
                record.status,
                record.model,
                record.account_id,
                record.user_input,
                record.created_at,
                record.updated_at,
                record.session_type,
                record.channel,
                record.chat_id,
                record.workspace_path,
                record.org_id,
                record.project_id,
                record.project_name,
                record.work_item_id,
                record.agent_role,
                record.worktree_path,
                record.worktree_branch,
                record.base_branch,
                record.merge_status,
                record.project_slug,
                record.agent_definition_id,
                record.org_member_id,
                record.parent_session_id,
                record.parent_event_id,
                record.workspace_additional_json,
                key_source_str,
                record.agent_exec_mode,
                record.native_harness_type,
                record.draft_text,
                record.reply_target_event_id,
                record.pinned as i64,
            ],
        )
        .unwrap();
    }

    fn select_one(conn: &rusqlite::Connection, session_id: &str) -> UnifiedSessionRecord {
        let sql = format!("{UNIFIED_SESSION_SELECT} WHERE s.session_id = ?1");
        conn.query_row(&sql, [session_id], row_to_record).unwrap()
    }

    /// Regression for the `key_source` split-brain: prior to wiring
    /// `key_source` into `UnifiedSessionRecord` + `UPSERT_SESSION_SQL`,
    /// the column existed in the schema with a `DEFAULT 'own_key'` but
    /// every Rust-agent session row was inserted without ever touching
    /// it, so the aggregator hard-coded `KeySource::OwnKey` for SDE/OS
    /// sessions and a market session would be mis-billed in the listing
    /// view.
    #[test]
    fn key_source_round_trip_persists_and_reads_back() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        let market = make_record("sid-market", KeySource::HostedKey);
        upsert_into(&conn, &market);
        let own = make_record("sid-own", KeySource::OwnKey);
        upsert_into(&conn, &own);

        let market_back = select_one(&conn, "sid-market");
        assert_eq!(market_back.key_source, KeySource::HostedKey);
        let own_back = select_one(&conn, "sid-own");
        assert_eq!(own_back.key_source, KeySource::OwnKey);
    }

    #[test]
    fn org_project_work_item_context_round_trips() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        let mut record = make_record("sid-org", KeySource::OwnKey);
        record.org_id = Some("org-platform".to_string());
        record.project_id = Some("project-runtime".to_string());
        record.project_name = Some("Runtime".to_string());
        record.project_slug = Some("runtime".to_string());
        record.work_item_id = Some("RUN-12".to_string());
        record.agent_role = Some("reviewer".to_string());
        upsert_into(&conn, &record);

        let back = select_one(&conn, "sid-org");
        assert_eq!(back.org_id.as_deref(), Some("org-platform"));
        assert_eq!(back.project_id.as_deref(), Some("project-runtime"));
        assert_eq!(back.project_name.as_deref(), Some("Runtime"));
        assert_eq!(back.project_slug.as_deref(), Some("runtime"));
        assert_eq!(back.work_item_id.as_deref(), Some("RUN-12"));
        assert_eq!(back.agent_role.as_deref(), Some("reviewer"));
    }

    /// Mirror of `key_source_is_immutable_on_conflict` for the P3
    /// composer columns: `draft_text` and `reply_target_event_id` must
    /// not be wiped by a background row refresh while the user is
    /// still typing or has a reply banner pinned. The upsert path
    /// is invoked by every turn finalization, compaction-fork, and
    /// gateway router — none of them carry the user's draft, so a
    /// naive `excluded.draft_text` would clobber it on every refresh.
    #[test]
    fn draft_and_reply_target_are_immutable_on_conflict() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        // Seed the row through a normal upsert (no draft / reply).
        let mut initial = make_record("sid", KeySource::OwnKey);
        initial.draft_text = None;
        initial.reply_target_event_id = None;
        upsert_into(&conn, &initial);

        // Simulate the frontend writing a draft + reply target via the
        // dedicated helpers (this is the path `session_patch` takes).
        update_draft_text_with_conn(&conn, "sid", Some("typing in progress")).unwrap();
        update_reply_target_event_id_with_conn(&conn, "sid", Some("evt-7")).unwrap();

        // Now a background upsert lands (e.g. turn finalization) with
        // `..Default::default()` for the composer columns. A correct
        // ON CONFLICT clause keeps the user's typed state; a regressed
        // one would null both columns.
        let mut bg = make_record("sid", KeySource::OwnKey);
        bg.name = "background-refresh".to_string();
        upsert_into(&conn, &bg);

        let back = select_one(&conn, "sid");
        assert_eq!(back.name, "background-refresh", "row did refresh");
        assert_eq!(
            back.draft_text.as_deref(),
            Some("typing in progress"),
            "draft_text must survive background upsert"
        );
        assert_eq!(
            back.reply_target_event_id.as_deref(),
            Some("evt-7"),
            "reply_target_event_id must survive background upsert"
        );
    }

    /// `update_draft_text(None)` and `update_draft_text(Some(""))` both
    /// clear the column. A persisted empty string would render an
    /// "I had a draft, restore it" affordance that the user never
    /// actually typed — the debounced patch normalizes empties to NULL.
    #[test]
    fn update_draft_text_normalizes_empty_to_null() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        let initial = make_record("sid", KeySource::OwnKey);
        upsert_into(&conn, &initial);

        update_draft_text_with_conn(&conn, "sid", Some("hello")).unwrap();
        assert_eq!(
            select_one(&conn, "sid").draft_text.as_deref(),
            Some("hello")
        );

        update_draft_text_with_conn(&conn, "sid", Some("")).unwrap();
        assert!(select_one(&conn, "sid").draft_text.is_none());

        update_draft_text_with_conn(&conn, "sid", Some("world")).unwrap();
        update_draft_text_with_conn(&conn, "sid", None).unwrap();
        assert!(select_one(&conn, "sid").draft_text.is_none());
    }

    /// `key_source` is intentionally NOT updated by `ON CONFLICT`. A
    /// background upsert (compaction-fork, gateway pipeline,
    /// project-init re-run) that spreads `..Default::default()` would
    /// otherwise silently re-flag a market session as `own_key` halfway
    /// through its life. Pin that.
    #[test]
    fn key_source_is_immutable_on_conflict() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        let initial = make_record("sid", KeySource::HostedKey);
        upsert_into(&conn, &initial);

        let mut second = make_record("sid", KeySource::OwnKey);
        second.name = "second-write".to_string();
        upsert_into(&conn, &second);

        let back = select_one(&conn, "sid");
        assert_eq!(back.name, "second-write", "non-billing fields update");
        assert_eq!(
            back.key_source,
            KeySource::HostedKey,
            "key_source must not be re-flagged by a partial upsert"
        );
    }
}
