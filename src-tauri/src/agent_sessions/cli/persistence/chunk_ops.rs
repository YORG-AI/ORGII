use rusqlite::{params, OptionalExtension, Result as SqliteResult};

use agent_core::foundation::session_bridge;
use core_types::activity::ActivityChunk;
use database::db::get_connection;

use super::session_crud::{bump_history_mutation_with_tx, clear_cli_resume_state_with_tx, now_iso};

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
    let mut conn = get_connection()?;
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

    let tx = conn.transaction()?;
    let previous = tx
        .query_row(
            "SELECT session_id,action_type,function,args_json,result_json,
                    thread_id,process_id,sequence,created_at
             FROM code_session_chunks WHERE chunk_id=?1",
            [&chunk.chunk_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?;
    let replacement_changed = previous.as_ref().is_some_and(
        |(
            old_session_id,
            old_action_type,
            old_function,
            old_args_json,
            old_result_json,
            old_thread_id,
            old_process_id,
            old_sequence,
            old_created_at,
        )| {
            old_session_id != &chunk.session_id
                || old_action_type != &chunk.action_type
                || old_function != &chunk.function
                || old_args_json != &args_str
                || old_result_json != &result_str
                || old_thread_id != &chunk.thread_id
                || old_process_id != &chunk.process_id
                || *old_sequence != sequence
                || old_created_at != &chunk.created_at
        },
    );

    tx.execute(
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

    if replacement_changed {
        let mut affected_sessions = vec![chunk.session_id.as_str()];
        if let Some((old_session_id, ..)) = previous.as_ref() {
            affected_sessions.push(old_session_id.as_str());
        }
        affected_sessions.sort_unstable();
        affected_sessions.dedup();
        let mutated_at = now_iso();
        for session_id in affected_sessions {
            bump_history_mutation_with_tx(&tx, session_id, "chunk_replaced", &mutated_at)?;
        }
    }
    tx.commit()?;

    // Database replay and its mutation epoch are now committed atomically;
    // lineage/subagent side effects remain best-effort and run afterwards.
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

/// Load only the newest user/assistant text needed by the fresh-process
/// context bridge. SQLite extracts and tail-bounds the scalar text before it
/// crosses into Rust, so a large readerless managed-CLI history is never
/// materialized as `Vec<ActivityChunk>` just to keep 24 short messages.
pub fn load_recent_context_messages(
    session_id: &str,
    max_messages: usize,
    max_chars_per_message: usize,
) -> SqliteResult<Vec<(String, String)>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "WITH candidate AS (
             SELECT sequence,
                    CASE WHEN function = 'user_message'
                         THEN 'User' ELSE 'Assistant' END AS role,
                    CASE
                        WHEN json_type(result_json, '$.message.content') = 'text'
                            THEN json_extract(result_json, '$.message.content')
                        WHEN json_type(result_json, '$.content') = 'text'
                            THEN json_extract(result_json, '$.content')
                        WHEN json_type(result_json, '$.observation') = 'text'
                            THEN json_extract(result_json, '$.observation')
                        ELSE NULL
                    END AS text
             FROM code_session_chunks
             WHERE session_id = ?1
               AND (
                    function = 'user_message'
                    OR action_type IN (
                        'assistant', 'assistant_delta', 'message', 'message_delta'
                    )
               )
         )
         SELECT role, substr(text, -?3)
         FROM candidate
         WHERE text IS NOT NULL AND trim(text) <> ''
         ORDER BY sequence DESC
         LIMIT ?2",
    )?;
    let max_messages = i64::try_from(max_messages).unwrap_or(i64::MAX).max(1);
    let max_chars = i64::try_from(max_chars_per_message)
        .unwrap_or(i64::MAX)
        .max(1);
    let rows = stmt.query_map(params![session_id, max_messages, max_chars], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    rows.collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mutation_test_chunk(chunk_id: &str, session_id: &str, content: &str) -> ActivityChunk {
        let mut chunk = ActivityChunk::new(session_id, "tool_result", "run_command_line");
        chunk.chunk_id = chunk_id.to_string();
        chunk.args = serde_json::json!({"command":"printf payload"});
        chunk.result = serde_json::json!({"output":content});
        chunk.created_at = "2026-07-23T00:00:00Z".to_string();
        chunk
    }

    fn history_epoch(session_id: &str) -> Option<i64> {
        get_connection()
            .expect("history epoch DB")
            .query_row(
                "SELECT epoch FROM code_session_history_mutations WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .expect("history epoch")
    }

    #[test]
    fn chunk_replace_bumps_only_affected_history_epochs_atomically() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("test database");
        crate::agent_sessions::cli::init_cli_agent_tables(&conn).expect("CLI schema");
        for session_id in ["cliagent-old", "cliagent-new"] {
            conn.execute(
                "INSERT INTO code_sessions(session_id,created_at,updated_at)
                 VALUES(?1,'2026-07-23T00:00:00Z','2026-07-23T00:00:00Z')",
                [session_id],
            )
            .expect("chunk test session");
        }
        drop(conn);

        let original = mutation_test_chunk("mutable-chunk", "cliagent-old", "AAAA");
        insert_chunk(&original, 7).expect("pure append");
        assert_eq!(history_epoch("cliagent-old"), None, "append is a delta");

        insert_chunk(&original, 7).expect("idempotent replace");
        assert_eq!(
            history_epoch("cliagent-old"),
            None,
            "byte-identical replace must not reset replay"
        );

        let changed = mutation_test_chunk("mutable-chunk", "cliagent-old", "BBBB");
        assert_eq!(
            serde_json::to_string(&original.result)
                .expect("old result")
                .len(),
            serde_json::to_string(&changed.result)
                .expect("changed result")
                .len()
        );
        insert_chunk(&changed, 7).expect("same-length content replacement");
        assert_eq!(history_epoch("cliagent-old"), Some(1));

        let append = mutation_test_chunk("append-chunk", "cliagent-old", "CCCC");
        insert_chunk(&append, 8).expect("append after replacement");
        assert_eq!(
            history_epoch("cliagent-old"),
            Some(1),
            "later append keeps the current generation"
        );

        let moved = mutation_test_chunk("mutable-chunk", "cliagent-new", "BBBB");
        insert_chunk(&moved, 7).expect("cross-session replacement");
        assert_eq!(history_epoch("cliagent-old"), Some(2));
        assert_eq!(history_epoch("cliagent-new"), Some(1));
        let stored_session = get_connection()
            .expect("stored chunk DB")
            .query_row(
                "SELECT session_id FROM code_session_chunks WHERE chunk_id='mutable-chunk'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("moved chunk row");
        assert_eq!(stored_session, "cliagent-new");
    }

    #[test]
    fn recent_context_query_is_row_and_text_bounded_before_rust() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("test database");
        crate::agent_sessions::cli::init_cli_agent_tables(&conn).expect("CLI schema");
        conn.execute_batch("PRAGMA foreign_keys=OFF")
            .expect("standalone chunk fixture");

        for sequence in 0..30_i64 {
            let function = if sequence % 2 == 0 {
                "user_message"
            } else {
                "assistant_message"
            };
            let action = if sequence % 2 == 0 {
                "message"
            } else {
                "assistant"
            };
            let content = format!("{}:{sequence}", "x".repeat(20_000));
            conn.execute(
                "INSERT INTO code_session_chunks(
                    chunk_id,session_id,action_type,function,args_json,result_json,
                    sequence,created_at
                 ) VALUES(?1,'bounded-context',?2,?3,'{}',?4,?5,'2026-07-22T00:00:00Z')",
                params![
                    format!("context-{sequence}"),
                    action,
                    function,
                    serde_json::json!({"content": content}).to_string(),
                    sequence,
                ],
            )
            .expect("context row");
        }
        // A tool payload is outside the projection and must never be parsed.
        conn.execute(
            "INSERT INTO code_session_chunks(
                chunk_id,session_id,action_type,function,args_json,result_json,
                sequence,created_at
             ) VALUES('irrelevant-tool','bounded-context','tool_result','Bash','{}',
                      'not-json',31,'2026-07-22T00:00:00Z')",
            [],
        )
        .expect("irrelevant malformed payload");
        drop(conn);

        let rows = load_recent_context_messages("bounded-context", 24, 12_000)
            .expect("bounded context rows");
        assert_eq!(rows.len(), 24);
        assert!(rows[0].1.ends_with(":29"));
        assert!(rows[23].1.ends_with(":6"));
        assert!(rows.iter().all(|(_, text)| text.chars().count() <= 12_000));
    }
}
