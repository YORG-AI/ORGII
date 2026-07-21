//! Durable replay import for provider/CLI shell events.
//!
//! External providers are normalized to the same `run_shell` UI canonical as
//! the integrated executor, but they do not pass through its stdout/stderr
//! pipe writer. Before EventStore is allowed to remove their large inline
//! result, this adapter writes the completed provider payload into the same
//! bounded, range-readable `.slog` format.

use std::path::{Path, PathBuf};

use core_types::extracted::ExtractedData;
use core_types::session_event::{
    EventDisplayStatus, SessionEvent, ShellReplayBookmark, ShellReplayRef, ShellReplayState,
    ShellReplayStatus,
};

use super::shell_replay::{
    load_complete_replay_state_if_matches, load_replay_state, resolve_replay_root,
    ShellReplayStream, ShellReplayTarget, ShellReplayWriter, SHELL_REPLAY_FORMAT_VERSION,
    SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PREVIEW_BYTES,
};

#[derive(Clone, Copy)]
struct OutputPart<'a> {
    stream: ShellReplayStream,
    text: &'a str,
}

/// Persist completed, replay-less shell events produced by external provider
/// parsers. Events that already own a replay are left untouched.
pub fn persist_external_shell_replays(events: &mut [SessionEvent]) {
    for event in events {
        if event.ui_canonical != core_types::tool_names::RUN_SHELL
            || event.shell_replay.is_some()
            || event.display_status == EventDisplayStatus::Running
        {
            continue;
        }
        let parts = output_parts(event);
        if parts.is_empty() {
            continue;
        }
        let expected_bytes = parts.iter().fold(0u64, |total, part| {
            total.saturating_add(part.text.len() as u64)
        });
        let call_id = event.call_id.clone().unwrap_or_else(|| event.id.clone());
        let replay_root = resolve_replay_root();
        match persist_one(event, &call_id, &replay_root, &parts, expected_bytes) {
            Ok(state) => event.shell_replay = Some(state),
            Err(error) => {
                // The source transcript remains authoritative, but EventStore
                // still needs a bounded visible result instead of an empty
                // card when durable import fails.
                event.shell_replay = Some(incomplete_preview_state(
                    event,
                    &call_id,
                    &parts,
                    format!("外部 CLI 完整输出保存失败：{error}"),
                ));
            }
        }
    }
}

fn persist_one(
    event: &SessionEvent,
    call_id: &str,
    replay_root: &Path,
    parts: &[OutputPart<'_>],
    expected_bytes: u64,
) -> Result<ShellReplayState, String> {
    if let Some(state) = load_complete_replay_state_if_matches(
        replay_root,
        &event.session_id,
        call_id,
        expected_bytes,
    )? {
        return Ok(state);
    }

    let command = event
        .command
        .as_deref()
        .or_else(|| event.args.get("command").and_then(|value| value.as_str()))
        .unwrap_or("external shell command");
    let cwd = event
        .args
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let target = ShellReplayTarget::new(&event.session_id, call_id);
    let mut writer = ShellReplayWriter::create_detached(replay_root, target, command, &cwd)?;
    for part in parts {
        append_text_bounded(&mut writer, part.stream, part.text)?;
    }
    writer.finalize_at(ShellReplayStatus::Complete, None, event.created_at.clone())?;
    load_replay_state(&event.session_id, call_id)?
        .ok_or_else(|| "external shell replay manifest missing after finalize".to_string())
}

fn append_text_bounded(
    writer: &mut ShellReplayWriter,
    stream: ShellReplayStream,
    text: &str,
) -> Result<(), String> {
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + SHELL_REPLAY_FRAME_MAX_BYTES).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            return Err("external shell output contains an oversized UTF-8 scalar".to_string());
        }
        writer.append(stream, &text.as_bytes()[start..end])?;
        start = end;
    }
    Ok(())
}

fn output_parts(event: &SessionEvent) -> Vec<OutputPart<'_>> {
    for path in [
        &["interleavedOutput"][..],
        &["aggregated_output"][..],
        &["output", "success", "interleavedOutput"][..],
    ] {
        if let Some(text) = string_at_path(&event.result, path) {
            if !text.is_empty() {
                return vec![OutputPart {
                    stream: ShellReplayStream::Stdout,
                    text,
                }];
            }
        }
    }

    let stdout = first_string_at_paths(
        &event.result,
        &[&["stdout"][..], &["output", "success", "stdout"][..]],
    );
    let stderr = first_string_at_paths(
        &event.result,
        &[
            &["stderr"][..],
            &["output", "success", "stderr"][..],
            &["failure", "stderr"][..],
        ],
    );
    if stdout.is_some() || stderr.is_some() {
        let mut parts = Vec::with_capacity(2);
        if let Some(text) = stdout.filter(|text| !text.is_empty()) {
            parts.push(OutputPart {
                stream: ShellReplayStream::Stdout,
                text,
            });
        }
        if let Some(text) = stderr.filter(|text| !text.is_empty()) {
            parts.push(OutputPart {
                stream: ShellReplayStream::Stderr,
                text,
            });
        }
        return parts;
    }

    if let Some(ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if let Some(text) = shell.stream_output.as_deref().or(shell.output.as_deref()) {
            if !text.is_empty() {
                return vec![OutputPart {
                    stream: ShellReplayStream::Stdout,
                    text,
                }];
            }
        }
    }
    for path in [
        &["content"][..],
        &["observation"][..],
        &["output"][..],
        &["output", "success", "output"][..],
    ] {
        if let Some(text) = string_at_path(&event.result, path) {
            if !text.is_empty() {
                return vec![OutputPart {
                    stream: ShellReplayStream::Stdout,
                    text,
                }];
            }
        }
    }
    Vec::new()
}

fn first_string_at_paths<'a>(value: &'a serde_json::Value, paths: &[&[&str]]) -> Option<&'a str> {
    paths.iter().find_map(|path| string_at_path(value, path))
}

fn string_at_path<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn incomplete_preview_state(
    event: &SessionEvent,
    call_id: &str,
    parts: &[OutputPart<'_>],
    error: String,
) -> ShellReplayState {
    let mut preview = String::new();
    for part in parts {
        if part.stream == ShellReplayStream::Stderr {
            preview.push_str("[stderr] ");
        }
        preview.push_str(part.text);
    }
    if preview.len() > SHELL_REPLAY_PREVIEW_BYTES {
        let mut start = preview.len() - SHELL_REPLAY_PREVIEW_BYTES;
        while start < preview.len() && !preview.is_char_boundary(start) {
            start += 1;
        }
        preview = preview[start..].to_string();
    }
    ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: event.session_id.clone(),
            call_id: call_id.to_string(),
            format_version: SHELL_REPLAY_FORMAT_VERSION,
        },
        bookmark: ShellReplayBookmark::default(),
        terminal_preview: preview,
        status: ShellReplayStatus::Incomplete,
        error: Some(error),
        completed_at: Some(event.created_at.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_types::session_event::{ActivityStatus, EventDisplayVariant, EventSource};

    fn external_shell_event(output: String) -> SessionEvent {
        SessionEvent {
            id: "external-shell-event".to_string(),
            chunk_id: Some("external-shell-event".to_string()),
            session_id: "external-shell-session".to_string(),
            created_at: "2026-07-19T12:00:00Z".to_string(),
            function_name: "run_command_line".to_string(),
            ui_canonical: core_types::tool_names::RUN_SHELL.to_string(),
            action_type: "tool_result".to_string(),
            args: serde_json::json!({"command": "emit external"}),
            result: serde_json::json!({"stdout": output, "exit_code": 0}),
            source: EventSource::Assistant,
            display_text: "emit external".to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::ToolCall,
            activity_status: ActivityStatus::Processed,
            thread_id: None,
            process_id: None,
            call_id: Some("external-shell-call".to_string()),
            file_path: None,
            command: Some("emit external".to_string()),
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    #[test]
    #[serial_test::serial]
    fn completed_external_shell_is_imported_before_eventstore_compaction() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().unwrap();
        database::init_shell_replay_tables(&conn).unwrap();
        let output = format!("HEAD\n{}\nTAIL", "x".repeat(96 * 1024));
        let expected_bytes = output.len() as u64;
        let mut event = external_shell_event(output);

        persist_external_shell_replays(std::slice::from_mut(&mut event));

        let state = event.shell_replay.as_ref().expect("durable replay state");
        assert_eq!(state.status, ShellReplayStatus::Complete);
        assert_eq!(state.bookmark.visible_bytes, expected_bytes);
        assert!(state.terminal_preview.ends_with("TAIL"));
        assert!(state.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
    }
}
