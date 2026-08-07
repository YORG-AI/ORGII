use rusqlite::{params, Result as SqliteResult};

use agent_core::foundation::session_bridge;
use core_types::activity::ActivityChunk;
use database::db::get_connection;

use super::session_crud::{clear_cli_resume_state_with_tx, now_iso};

/// Get the maximum sequence number for a session's chunks.
/// Returns -1 if no chunks exist (so base_sequence + 1 == 0 for first run).
pub fn max_chunk_sequence(session_id: &str) -> SqliteResult<i64> {
    let conn = get_connection()?;
    let max_seq: Option<i64> = conn.query_row(
        "SELECT MAX(sequence) FROM code_session_chunks WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    Ok(max_seq.unwrap_or(-1))
}

/// Store an ActivityChunk.
pub fn insert_chunk(chunk: &ActivityChunk, sequence: i64) -> SqliteResult<()> {
    let conn = get_connection()?;
    // `serde_json::to_string` on `serde_json::Value` is infallible — the
    // value tree was already validated when the chunk was constructed.
    // Using `expect` here (instead of the previous silent fallback to
    // `"{}"`) means any future schema break, not an empty fallback,
    // fails the write loud and clear and pairs symmetrically with the
    // load side which now refuses to silently substitute `{}` for a
    // corrupt row.
    let args_str = serde_json::to_string(&chunk.args)
        .expect("ActivityChunk.args -> JSON string is infallible for Value");
    let result_str = serde_json::to_string(&chunk.result)
        .expect("ActivityChunk.result -> JSON string is infallible for Value");

    conn.execute(
        "INSERT OR REPLACE INTO code_session_chunks
            (chunk_id, session_id, action_type, function,
             args_json, result_json, thread_id, process_id, sequence, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            chunk.chunk_id,
            chunk.session_id,
            chunk.action_type,
            chunk.function,
            args_str,
            result_str,
            chunk.thread_id,
            chunk.process_id,
            sequence,
            chunk.created_at,
        ],
    )?;

    run_chunk_side_effects_with_args(chunk, args_str);

    Ok(())
}

/// Chunk side effects that must survive even when the chunk row itself is
/// not persisted (native-transcript sessions): lineage provenance for
/// file-edit chunks and the OpenCode subagent child `code_sessions` row
/// (metadata-only, idempotent).
pub fn run_chunk_side_effects(chunk: &ActivityChunk) {
    let args_str = serde_json::to_string(&chunk.args)
        .expect("ActivityChunk.args -> JSON string is infallible for Value");
    run_chunk_side_effects_with_args(chunk, args_str);
}

fn run_chunk_side_effects_with_args(chunk: &ActivityChunk, args_str: String) {
    // Record lineage provenance for file-edit chunks (non-blocking, best-effort)
    let sid = chunk.session_id.clone();
    let func = chunk.function.clone();
    std::thread::spawn(move || {
        project_management::lineage::event_hook::process_chunk(&sid, &func, &args_str);
    });

    if is_subagent_chunk(chunk) {
        if let Err(err) = persist_subagent_child_session(chunk) {
            tracing::warn!(
                "[chunk_ops] failed to persist subagent child session for {}: {err}",
                chunk.session_id
            );
        }
    }
}

/// True when this chunk is an OpenCode/CLI subagent delegation that should
/// spawn a child code_session row. The frontend uses that child row to attach
/// imported subagent history to the right parent and to keep the child out of
/// the primary left sidebar.
fn is_subagent_chunk(chunk: &ActivityChunk) -> bool {
    chunk.action_type == "tool_call" && chunk.function == "subagent"
}

/// Extract the subagent session id from a delegation chunk. Falls back to a
/// derived id from the parent so the child always has a stable session_id.
pub fn subagent_session_id(chunk: &ActivityChunk) -> Option<String> {
    if !is_subagent_chunk(chunk) {
        return None;
    }
    if let Some(id) = chunk
        .args
        .get("subagentSessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(id.to_string());
    }
    if let Some(id) = chunk
        .result
        .get("subagentSessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(id.to_string());
    }
    let prompt_preview = chunk
        .args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("subagent");
    let prefix = prompt_preview
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect::<String>();
    let prefix = if prefix.is_empty() {
        "subagent".to_string()
    } else {
        prefix
    };
    Some(format!("opencodeapp-{}-{}", chunk.chunk_id, prefix))
}

/// Persist a `code_sessions` row representing the child subagent session.
/// Idempotent on (session_id) — repeated chunk events for the same delegation
/// do not create duplicate rows or bump `updated_at`.
pub fn persist_subagent_child_session(chunk: &ActivityChunk) -> SqliteResult<bool> {
    let child_id = match subagent_session_id(chunk) {
        Some(id) => id,
        None => return Ok(false),
    };
    let parent_id = chunk.session_id.clone();
    let prompt = chunk
        .args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let task_label = if prompt.is_empty() {
        truncate_label(&child_id)
    } else {
        truncate_label(&prompt)
    };
    let name = format!("OpenCode ({task_label})");
    let ts = now_iso();
    let conn = get_connection()?;
    // Use INSERT OR IGNORE so a re-emitted chunk (e.g. agent_replay) does not
    // mutate an existing child row. `user_input` carries the prompt for
    // sidebar previews; parent_session_id is what the visibility helper keys on.
    let affected = conn.execute(
        "INSERT OR IGNORE INTO code_sessions
            (session_id, name, status, flow, runner, cli_agent_type,
             user_input, parent_session_id, org_id, key_source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            child_id,
            name,
            "completed",
            "opencode_subagent",
            "Local",
            "opencode",
            prompt,
            parent_id,
            "personal-org",
            "own_key",
            ts,
        ],
    )?;
    Ok(affected > 0)
}

fn truncate_label(s: &str) -> String {
    if s.chars().count() <= 32 {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(29).collect();
        format!("{}...", truncated)
    }
}

/// Load all chunks for a session, ordered by sequence.
pub fn load_chunks(session_id: &str) -> SqliteResult<Vec<ActivityChunk>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT chunk_id, session_id, action_type, function,
                args_json, result_json, thread_id, process_id, created_at
         FROM code_session_chunks
         WHERE session_id = ?1
         ORDER BY sequence ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let args_str: String = row.get(4)?;
        let result_str: String = row.get(5)?;
        // The args/result columns are written as serialized JSON by the
        // chunk writer. Silently rendering a corrupt blob as `{}`
        // (the previous behaviour) made it impossible to tell whether
        // a tool call genuinely had no arguments or whether the row
        // had been corrupted out of band — both look identical to the
        // frontend, but the second case is a real data-integrity bug
        // that would have stayed invisible. Surface a typed
        // `FromSqlConversionFailure` instead so the loader returns
        // an error and the UI can show a real failure state.
        let args = serde_json::from_str::<serde_json::Value>(&args_str).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                format!("invalid args_json for chunk: {err}").into(),
            )
        })?;
        let result = serde_json::from_str::<serde_json::Value>(&result_str).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                format!("invalid result_json for chunk: {err}").into(),
            )
        })?;
        Ok(ActivityChunk {
            chunk_id: row.get(0)?,
            session_id: row.get(1)?,
            action_type: row.get(2)?,
            function: row.get(3)?,
            args,
            result,
            thread_id: row.get(6)?,
            process_id: row.get(7)?,
            created_at: row.get(8)?,
            broadcast_only: false,
        })
    })?;
    let chunks: Vec<ActivityChunk> = rows.collect::<SqliteResult<Vec<_>>>()?;
    tracing::info!(
        "[load_chunks] session={}, returned {} chunks",
        session_id,
        chunks.len()
    );
    Ok(chunks)
}

/// Truncate chunks at and after a specific timestamp.
/// Used for message editing — removes chunks at or after the given timestamp.
/// Also clears the CLI session ID so the next run starts fresh instead of resuming
/// from the CLI agent's saved state (which still has the old conversation).
pub fn truncate_chunks_after(session_id: &str, created_at: &str) -> SqliteResult<i64> {
    truncate_chunks_after_with_reason(
        session_id,
        created_at,
        session_bridge::CLI_HISTORY_MUTATION_MESSAGE_TRUNCATE,
    )
}

pub fn truncate_chunks_after_with_reason(
    session_id: &str,
    created_at: &str,
    mutation_reason: &str,
) -> SqliteResult<i64> {
    let conn = get_connection()?;

    let tx = conn.unchecked_transaction()?;
    let deleted = tx.execute(
        "DELETE FROM code_session_chunks WHERE session_id = ?1 AND created_at >= ?2",
        params![session_id, created_at],
    )?;

    // Clear cli_session_id so the agent starts fresh on re-submit. We do
    // bump `updated_at` here even though clearing the id is by itself
    // bookkeeping — message editing is real conversation activity, so
    // the session should float in time-bucketed views (sidebar / Kanban
    // filters). See the invariant note above.
    let updated_at = now_iso();
    clear_cli_resume_state_with_tx(&tx, session_id, Some(&updated_at), mutation_reason)?;
    tx.commit()?;

    Ok(deleted as i64)
}
