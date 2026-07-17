//! Shared helpers for the code session runner.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::super::persistence;
use crate::agent_sessions::event_pipeline::commands::{
    save_events_retry, session_event_to_cached_event,
};
use crate::agent_sessions::event_pipeline::streaming::CLI_STREAMING_BUFFER;
use crate::api::websocket_handler;
use agent_core::bus::broadcast_event;

type RunningSessionsMap = HashMap<String, tokio::task::JoinHandle<()>>;

/// Global registry of running sessions (session_id → abort handle).
pub static RUNNING_SESSIONS: std::sync::LazyLock<Arc<Mutex<RunningSessionsMap>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Strip the `<ide_context>...</ide_context>` block from user input.
/// IDE context is prepended by `inject_ide_context_into_prompt` for the CLI agent,
/// but should not be stored in the DB or shown to the user in chat history.
pub(super) fn strip_ide_context(input: &str) -> String {
    const OPEN: &str = "<ide_context>";
    const CLOSE: &str = "</ide_context>";

    let Some(start) = input.find(OPEN) else {
        return input.to_string();
    };
    let Some(close_start) = input.find(CLOSE) else {
        return input.to_string();
    };
    let mut after = close_start + CLOSE.len();
    while after < input.len() && input.as_bytes()[after].is_ascii_whitespace() {
        after += 1;
    }
    let mut result = input[..start].to_string();
    result.push_str(&input[after..]);
    result
}

/// Persist an ActivityChunk to the database and broadcast it via WebSocket.
///
/// Delta chunks (`action_type` contains "delta") are routed through the
/// `CLI_STREAMING_BUFFER` for Rust-side accumulation. They are still broadcast
/// as `code_session.activity` so the frontend can show the typewriter effect.
///
/// Completion chunks flush the streaming buffer and broadcast
/// `agent:streaming_complete` with the full accumulated `SessionEvent`.
///
/// Tool calls and other non-streaming chunks flush any pending stream first.
///
/// Shared helper used by both the ACP flow (Copilot) and the standard
/// CliAgentParser loop (all other agents).
pub(super) fn emit_chunk(
    chunk: &core_types::activity::ActivityChunk,
    session_id: &str,
    sequence: &mut i64,
) {
    let action_type = chunk.action_type.as_str();

    let is_delta = action_type.contains("delta")
        && chunk
            .result
            .get("is_delta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    let is_message_type = action_type == "assistant"
        || action_type == "assistant_delta"
        || action_type == "message"
        || action_type == "message_delta";

    let is_thinking_type = action_type == "llm_thinking" || action_type == "llm_thinking_delta";

    if is_delta {
        if action_type == "tool_call_delta" {
            let has_tool_identity = chunk
                .result
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .is_some()
                || chunk
                    .result
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .is_some();
            if has_tool_identity {
                flush_and_broadcast(session_id);
            }
        }

        // ── Delta: accumulate in Rust, broadcast raw for real-time UI ──
        let content = chunk
            .result
            .get("content")
            .or_else(|| chunk.result.get("observation"))
            .or_else(|| chunk.result.get("thought"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if is_message_type {
            CLI_STREAMING_BUFFER.append_message_delta(session_id, content);
        } else if is_thinking_type {
            CLI_STREAMING_BUFFER.append_thinking_delta(session_id, content);
        }

        // Still broadcast the raw delta for the frontend typewriter effect
        let ws_msg = serde_json::json!({
            "type": "code_session.activity",
            "session_id": session_id,
            "chunk": chunk,
        });
        websocket_handler::broadcast(ws_msg.to_string());
        return;
    }

    // ── Completion or non-delta: flush buffer, persist, broadcast ──

    if is_message_type || is_thinking_type {
        // Completion chunk: flush the matching stream from the buffer and
        // broadcast the Rust-accumulated SessionEvent.
        if is_message_type {
            if let Some(event) = CLI_STREAMING_BUFFER.complete_message(session_id) {
                persist_and_broadcast_streaming_complete(
                    session_id,
                    "message",
                    &event,
                    Some(sequence),
                );
            }
        } else if let Some(event) = CLI_STREAMING_BUFFER.complete_thinking(session_id) {
            persist_and_broadcast_streaming_complete(
                session_id,
                "thinking",
                &event,
                Some(sequence),
            );
        }
    } else {
        // Non-streaming chunk (tool_call, user_message, etc.): flush any
        // pending streams before appending, same as UnifiedEventHandler.
        flush_and_broadcast(session_id);
    }

    // Persist non-delta chunks to DB (legacy mode). Native-transcript
    // sessions skip the row — the CLI's own store is the transcript of
    // record — but keep the chunk side effects (lineage, subagent rows)
    // and the sequence bump so broadcast ordering stays stable.
    if !chunk.broadcast_only {
        if persistence::session_persists_chunks(session_id) {
            if let Err(err) = persistence::insert_chunk(chunk, *sequence) {
                tracing::warn!(
                    "[CodeSession] Failed to persist chunk seq={}: {}",
                    *sequence,
                    err
                );
            }
        } else {
            persistence::run_chunk_side_effects(chunk);
        }
        *sequence += 1;
    }

    // Broadcast the original chunk as well (non-delta chunks like tool_call
    // are still consumed by the frontend via code_session.activity)
    let ws_msg = serde_json::json!({
        "type": "code_session.activity",
        "session_id": session_id,
        "chunk": chunk,
    });
    websocket_handler::broadcast(ws_msg.to_string());
}

/// Broadcast `agent:streaming_complete` for a flushed stream.
fn broadcast_streaming_complete(
    session_id: &str,
    stream_type: &str,
    event: &crate::agent_sessions::event_pipeline::types::SessionEvent,
) {
    broadcast_event(
        "agent:streaming_complete",
        serde_json::json!({
            "sessionId": session_id,
            "streamType": stream_type,
            "event": event,
        }),
    );
}

fn persist_and_broadcast_streaming_complete(
    session_id: &str,
    stream_type: &str,
    event: &crate::agent_sessions::event_pipeline::types::SessionEvent,
    sequence: Option<&mut i64>,
) {
    // Native-transcript sessions broadcast only: neither the event cache
    // nor a chunk row is written, but the sequence still advances so
    // later persisted artifacts can't collide with broadcast ordering.
    let persists = persistence::session_persists_chunks(session_id);
    if persists {
        let cached = session_event_to_cached_event(event);
        let _ = save_events_retry("cli-stream-flush", session_id, &[cached], 5);
    }
    if let Some(sequence) = sequence {
        if persists {
            persist_streaming_complete_chunk(session_id, stream_type, event, sequence);
        } else {
            *sequence += 1;
        }
    }
    broadcast_streaming_complete(session_id, stream_type, event);
}

fn next_chunk_sequence(session_id: &str) -> i64 {
    persistence::max_chunk_sequence(session_id)
        .map(|sequence| sequence + 1)
        .unwrap_or(0)
}

fn persist_streaming_complete_chunk(
    session_id: &str,
    stream_type: &str,
    event: &crate::agent_sessions::event_pipeline::types::SessionEvent,
    sequence: &mut i64,
) {
    let (action_type, function) = if stream_type == "thinking" {
        ("llm_thinking", "thinking")
    } else {
        ("assistant", "assistant")
    };
    let mut chunk = core_types::activity::ActivityChunk::new(session_id, action_type, function);
    chunk.chunk_id = format!("{}-chunk", event.id);
    chunk.created_at = event.created_at.clone();
    chunk.args = event.args.clone();
    chunk.result = event.result.clone();
    chunk.thread_id = event.thread_id.clone();
    chunk.process_id = event.process_id.clone();
    if let Err(err) = persistence::insert_chunk(&chunk, *sequence) {
        tracing::warn!(
            "[CodeSession] Failed to persist streaming complete chunk seq={}: {}",
            *sequence,
            err
        );
        return;
    }
    *sequence += 1;
}

/// Flush all pending CLI streams and broadcast completion events.
pub(super) fn flush_and_broadcast(session_id: &str) {
    let mut sequence = next_chunk_sequence(session_id);
    for event in crate::agent_sessions::event_pipeline::streaming::cli_flush_session(session_id) {
        let stream_type = if event.action_type == "assistant" {
            "message"
        } else {
            "thinking"
        };
        persist_and_broadcast_streaming_complete(
            session_id,
            stream_type,
            &event,
            Some(&mut sequence),
        );
    }
}

pub fn flush_cli_streams_for_session(session_id: &str) {
    flush_and_broadcast(session_id);
}

/// Drop hook-derived live status for a finished managed session. The
/// runner's exit-code truth wins at terminal transitions; a lingering
/// hook `working`/`waiting` entry would otherwise ghost on the sidebar.
/// Clears both the ORGII session id and (when the CLI's native id is
/// known) the canonical imported-history id the hooks report under.
pub(super) fn clear_live_status(
    agent: &key_vault::key_store::ModelType,
    session_id: &str,
    cli_session_id: Option<&str>,
) {
    use key_vault::key_store::ModelType;
    // Terminal transition: drop the launch permission-mode record and wake
    // any parked PermissionRequest hook long-poll with a no-decision so it
    // never outlives the session it was asking about.
    super::super::hook_approvals::unregister_session(session_id);
    let canonical = cli_session_id.and_then(|cli_sid| match agent {
        ModelType::ClaudeCode => Some(
            orgtrack_core::sources::claude_code::canonical_session_id(cli_sid),
        ),
        ModelType::Codex => Some(orgtrack_core::sources::codex::canonical_session_id(cli_sid)),
        ModelType::CursorCli => Some(
            orgtrack_core::sources::cursor_ide::canonical_session_id(cli_sid),
        ),
        _ => None,
    });
    let mut ids = vec![session_id];
    if let Some(ref canonical) = canonical {
        ids.push(canonical.as_str());
    }
    crate::orgtrack::agent_live_status::clear(&ids);
}

fn is_cli_file_edit_function(function_name: &str) -> bool {
    agent_core::tools::names::CLI_DISPLAY_FILE_EDIT_FUNCTION_NAMES.contains(&function_name)
        || agent_core::tools::names::FILE_EDIT_EVENT_FUNCTION_NAMES.contains(&function_name)
}

/// Capture the pre-edit state of a file into the per-message file-history
/// snapshot just before a CLI agent's file-edit chunk is processed.
///
/// Because CLI agents run as external OS processes, Rust cannot hook them
/// before they write the file (unlike SDE Agent where `take_snapshot` fires
/// inside `on_tool_call_start`). Instead, this function is called when Rust
/// first *sees* the tool_call chunk, and recovers the pre-edit bytes via
/// `git show HEAD:<path>`. That gives us the committed version of the file,
/// which is the best available baseline for CLI sessions that operate on a
/// git repository.
///
/// Idempotent: if the file is already tracked in this snapshot (e.g. a multi-
/// edit sequence for the same file), the call is a no-op inside
/// `track_edit_from_bytes`.
///
/// Non-fatal: snapshot failures are logged at `warn` level and never block the
/// chunk from being persisted and broadcast.
pub(super) fn snapshot_cli_file_edit(
    session_id: &str,
    snapshot_id: &str,
    chunk: &core_types::activity::ActivityChunk,
    repo_path: &str,
) {
    if chunk.action_type != "tool_call" {
        return;
    }
    if !is_cli_file_edit_function(&chunk.function) {
        return;
    }

    let raw_path = chunk
        .args
        .get("path")
        .or_else(|| chunk.args.get("file_path"))
        .or_else(|| chunk.args.get("file_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if raw_path.is_empty() {
        return;
    }

    let raw_abs_path = if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        Path::new(repo_path).join(raw_path)
    };
    let repo_root = Path::new(repo_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(repo_path));
    let abs_path = raw_abs_path.canonicalize().unwrap_or_else(|_| {
        let raw_root = Path::new(repo_path);
        raw_abs_path
            .strip_prefix(raw_root)
            .map(|relative_path| repo_root.join(relative_path))
            .unwrap_or_else(|_| raw_abs_path.clone())
    });

    // Derive the path relative to repo root for `git show HEAD:<rel>`.
    // If the file is outside the repo root (edge case: agent editing a file
    // in a different directory) we skip the snapshot rather than risk calling
    // track_new_file on a file that actually exists in git elsewhere.
    let rel_for_git = match abs_path.strip_prefix(&repo_root) {
        Ok(rel) => rel.to_string_lossy().to_string(),
        Err(_) => return,
    };

    // Attempt to read the file's committed content from git HEAD.
    let git_bytes_opt = git::git_command()
        .ok()
        .and_then(|mut command| {
            command
                .args(["show", &format!("HEAD:{}", rel_for_git)])
                .current_dir(&repo_root)
                .output()
                .ok()
        })
        .filter(|o| o.status.success())
        .map(|o| o.stdout);

    match git_bytes_opt {
        Some(bytes) => {
            if let Err(err) = agent_core::tools::file_history::track_edit_from_bytes(
                session_id,
                snapshot_id,
                &abs_path,
                &bytes,
            ) {
                tracing::warn!(
                    "[cli_snapshot] track_edit_from_bytes failed for {}: {}",
                    abs_path.display(),
                    err
                );
            }
        }
        None => {
            // File not tracked in git HEAD (new file being created by the agent).
            // Record a "did not exist" entry so rewind deletes it.
            if let Err(err) =
                agent_core::tools::file_history::track_new_file(session_id, snapshot_id, &abs_path)
            {
                tracing::warn!(
                    "[cli_snapshot] track_new_file failed for {}: {}",
                    abs_path.display(),
                    err
                );
            }
        }
    }
}

/// Save base64 data-URL images to `~/.orgii/session-images/` and return file paths.
///
/// Delegates to `agent_core::images::persist_images` which uses content-hash
/// dedup and saves to the app data directory (within Tauri's fs scope so
/// `convertFileSrc` works for thumbnail display).
pub(super) async fn persist_attached_images(
    session_id: &str,
    images: Option<&[String]>,
) -> Vec<String> {
    let Some(imgs) = images else { return vec![] };
    if imgs.is_empty() {
        return vec![];
    }

    let paths = agent_core::persistence::images::persist_images(imgs);

    if !paths.is_empty() {
        tracing::info!(
            "[CodeSession] Saved {} image(s) for session {}",
            paths.len(),
            session_id
        );
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_file_edit_detection_covers_display_and_storage_names() {
        for function_name in [
            agent_core::tools::names::CLI_DISPLAY_EDIT,
            agent_core::tools::names::CLI_DISPLAY_WRITE,
            agent_core::tools::names::CLI_DISPLAY_CREATE,
            agent_core::tools::names::CLI_DISPLAY_PATCH,
            agent_core::tools::names::EDIT_FILE,
            agent_core::tools::names::APPLY_PATCH,
            agent_core::tools::names::STORAGE_WRITE_FILE,
            agent_core::tools::names::STORAGE_CREATE_FILE,
            agent_core::tools::names::STORAGE_EDIT_FILE_BY_REPLACE,
            agent_core::tools::names::STORAGE_APPEND_FILE,
            agent_core::tools::names::STORAGE_FILE_RANGE_EDIT,
            agent_core::tools::names::STORAGE_INSERT_CONTENT_AT_LINE,
        ] {
            assert!(
                is_cli_file_edit_function(function_name),
                "expected {function_name} to be snapshot-tracked"
            );
        }
    }

    #[test]
    fn cli_file_edit_detection_rejects_read_only_tools() {
        assert!(!is_cli_file_edit_function(
            agent_core::tools::names::READ_FILE
        ));
        assert!(!is_cli_file_edit_function("Bash"));
        assert!(!is_cli_file_edit_function("todo_write"));
    }
}
