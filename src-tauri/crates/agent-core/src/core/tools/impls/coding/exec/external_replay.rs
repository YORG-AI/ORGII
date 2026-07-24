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
use sha2::{Digest, Sha256};

use super::shell_replay::{
    complete_terminal_prefix_len, load_complete_replay_state_if_matches, load_replay_state,
    resolve_replay_root, ShellReplayStream, ShellReplayTarget, ShellReplayWriter,
    SHELL_REPLAY_FORMAT_VERSION, SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PREVIEW_BYTES,
    SHELL_REPLAY_RANGE_MAX_BYTES,
};

#[derive(Clone, Copy)]
pub struct ExternalShellInlineSegment<'a> {
    pub stream: ShellReplayStream,
    pub text: &'a str,
}

/// One externally-addressable stdout/stderr payload that belongs in a shell
/// replay. `locator` is deliberately opaque to `agent-core`: JSONL byte spans,
/// SQLite row keys and replay-artifact references remain owned by their source
/// adapters.
#[derive(Debug, Clone)]
pub struct ExternalShellReplaySegment<L> {
    pub stream: ShellReplayStream,
    pub locator: L,
    pub expected_bytes: u64,
    /// A bounded source-provided tail used only when range hydration fails
    /// before the durable replay can be completed.
    pub preview: String,
}

impl<L> ExternalShellReplaySegment<L> {
    pub fn new(
        stream: ShellReplayStream,
        locator: L,
        expected_bytes: u64,
        preview: impl Into<String>,
    ) -> Self {
        Self {
            stream,
            locator,
            expected_bytes,
            preview: preview.into(),
        }
    }
}

/// Persist completed, replay-less shell events produced by external provider
/// parsers. Events that already own a replay are left untouched.
pub fn persist_external_shell_replays(events: &mut [SessionEvent]) {
    for event in events {
        let base = event.call_id.as_deref().unwrap_or(&event.id);
        let call_id = external_shell_inline_identity(event)
            .map(|identity| format!("{base}-external-{identity}"))
            .unwrap_or_else(|| base.to_string());
        persist_external_shell_replay_inline(event, &call_id);
    }
}

/// Inline counterpart with an explicit durable artifact key. Imported replay
/// callers provide a content-addressed key. Length alone is never accepted as
/// identity, so a same-sized output update cannot reuse a stale `.slog`.
pub fn persist_external_shell_replay_inline(event: &mut SessionEvent, artifact_call_id: &str) {
    if event.ui_canonical != core_types::tool_names::RUN_SHELL
        || event.shell_replay.is_some()
        || event.display_status == EventDisplayStatus::Running
    {
        return;
    }
    let parts = external_shell_inline_segments(event);
    if parts.is_empty() {
        return;
    }
    let expected_bytes = parts.iter().fold(0u64, |total, part| {
        total.saturating_add(part.text.len() as u64)
    });
    let replay_root = resolve_replay_root();
    match persist_one(
        event,
        artifact_call_id,
        &replay_root,
        &parts,
        expected_bytes,
    ) {
        Ok(state) => event.shell_replay = Some(state),
        Err(error) => {
            // The source transcript remains authoritative, but EventStore
            // still needs a bounded visible result instead of an empty card
            // when durable import fails.
            event.shell_replay = Some(incomplete_preview_state(
                event,
                artifact_call_id,
                &parts,
                format!("外部 CLI 完整输出保存失败：{error}"),
            ));
        }
    }
}

/// Persist one external shell event from storage-specific payload locators.
///
/// The callback is never asked for more than
/// [`SHELL_REPLAY_RANGE_MAX_BYTES`] and each returned buffer is immediately
/// split into `.slog` frames. No complete stdout/stderr `String` is assembled.
/// A callback may return fewer bytes than requested, but returning an empty
/// buffer before the segment's declared length or returning more than the
/// requested range makes the event explicitly incomplete.
pub fn persist_external_shell_replay_segments<L, ReadRange>(
    event: &mut SessionEvent,
    segments: &[ExternalShellReplaySegment<L>],
    read_range: ReadRange,
) where
    ReadRange: FnMut(&L, u64, usize) -> Result<Vec<u8>, String>,
{
    let call_id = event.call_id.clone().unwrap_or_else(|| event.id.clone());
    persist_external_shell_replay_segments_with_call_id(event, &call_id, segments, read_range);
}

/// Range-backed counterpart with an explicit generation-scoped artifact key.
pub fn persist_external_shell_replay_segments_with_call_id<L, ReadRange>(
    event: &mut SessionEvent,
    artifact_call_id: &str,
    segments: &[ExternalShellReplaySegment<L>],
    mut read_range: ReadRange,
) where
    ReadRange: FnMut(&L, u64, usize) -> Result<Vec<u8>, String>,
{
    if event.ui_canonical != core_types::tool_names::RUN_SHELL
        || event.shell_replay.is_some()
        || event.display_status == EventDisplayStatus::Running
        || segments.is_empty()
    {
        return;
    }

    let replay_root = resolve_replay_root();
    let expected_bytes = segments.iter().try_fold(0u64, |total, segment| {
        total.checked_add(segment.expected_bytes)
    });
    let result = match expected_bytes {
        Some(_) => persist_one_from_segments(
            event,
            artifact_call_id,
            &replay_root,
            segments,
            &mut read_range,
        ),
        None => Err("external shell replay byte count overflow".to_string()),
    };
    match result {
        Ok(state) => event.shell_replay = Some(state),
        Err(error) => {
            event.shell_replay = Some(incomplete_segment_preview_state(
                event,
                artifact_call_id,
                segments,
                format!("外部 CLI Shell 完整输出保存失败：{error}"),
            ));
        }
    }
}

fn persist_one_from_segments<L, ReadRange>(
    event: &SessionEvent,
    call_id: &str,
    replay_root: &Path,
    segments: &[ExternalShellReplaySegment<L>],
    read_range: &mut ReadRange,
) -> Result<ShellReplayState, String>
where
    ReadRange: FnMut(&L, u64, usize) -> Result<Vec<u8>, String>,
{
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

    let write_result = (|| {
        for segment in segments {
            let mut offset = 0u64;
            let mut frame_buffer = ExternalFrameBuffer::default();
            while offset < segment.expected_bytes {
                let remaining = segment.expected_bytes - offset;
                let requested = remaining.min(SHELL_REPLAY_RANGE_MAX_BYTES as u64) as usize;
                let bytes = read_range(&segment.locator, offset, requested)?;
                if bytes.is_empty() {
                    return Err(format!(
                        "{} payload ended at byte {offset}, expected {} bytes",
                        segment.stream.as_wire_str(),
                        segment.expected_bytes
                    ));
                }
                if bytes.len() > requested {
                    return Err(format!(
                        "{} payload range returned {} bytes for a {requested}-byte request",
                        segment.stream.as_wire_str(),
                        bytes.len()
                    ));
                }
                frame_buffer.push(&mut writer, segment.stream, &bytes)?;
                offset = offset.saturating_add(bytes.len() as u64);
            }
            frame_buffer.finish(&mut writer, segment.stream)?;
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        writer.mark_incomplete(error.clone());
        return Err(error);
    }

    writer.finalize_at(ShellReplayStatus::Complete, None, event.created_at.clone())?;
    load_replay_state(&event.session_id, call_id)?
        .ok_or_else(|| "external shell replay manifest missing after finalize".to_string())
}

fn persist_one(
    event: &SessionEvent,
    call_id: &str,
    replay_root: &Path,
    parts: &[ExternalShellInlineSegment<'_>],
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

#[derive(Default)]
struct ExternalFrameBuffer {
    pending: Vec<u8>,
}

impl ExternalFrameBuffer {
    fn push(
        &mut self,
        writer: &mut ShellReplayWriter,
        stream: ShellReplayStream,
        mut bytes: &[u8],
    ) -> Result<(), String> {
        while !bytes.is_empty() {
            let available = SHELL_REPLAY_FRAME_MAX_BYTES.saturating_sub(self.pending.len());
            let take = available.min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < SHELL_REPLAY_FRAME_MAX_BYTES {
                continue;
            }

            // Source adapters range over decoded strings, so a range or frame
            // boundary may bisect a UTF-8 scalar/ANSI sequence. Keep only that
            // tiny suffix for the next frame; never retain the payload body.
            let ready = complete_terminal_prefix_len(&self.pending);
            if ready == 0 {
                return Err("external shell output has no complete terminal prefix".to_string());
            }
            writer.append(stream, &self.pending[..ready])?;
            self.pending.drain(..ready);
        }
        Ok(())
    }

    fn finish(
        mut self,
        writer: &mut ShellReplayWriter,
        stream: ShellReplayStream,
    ) -> Result<(), String> {
        if !self.pending.is_empty() {
            writer.append(stream, &self.pending)?;
            self.pending.clear();
        }
        Ok(())
    }
}

pub fn external_shell_inline_segments(event: &SessionEvent) -> Vec<ExternalShellInlineSegment<'_>> {
    for path in [
        &["interleavedOutput"][..],
        &["aggregated_output"][..],
        &["output", "success", "interleavedOutput"][..],
    ] {
        if let Some(text) = string_at_path(&event.result, path) {
            if !text.is_empty() {
                return vec![ExternalShellInlineSegment {
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
            parts.push(ExternalShellInlineSegment {
                stream: ShellReplayStream::Stdout,
                text,
            });
        }
        if let Some(text) = stderr.filter(|text| !text.is_empty()) {
            parts.push(ExternalShellInlineSegment {
                stream: ShellReplayStream::Stderr,
                text,
            });
        }
        return parts;
    }

    if let Some(ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if let Some(text) = shell.stream_output.as_deref().or(shell.output.as_deref()) {
            if !text.is_empty() {
                return vec![ExternalShellInlineSegment {
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
                return vec![ExternalShellInlineSegment {
                    stream: ShellReplayStream::Stdout,
                    text,
                }];
            }
        }
    }
    Vec::new()
}

/// SHA-256 over ordered `(stream, byte-length, bytes)` tuples. Stream tags and
/// tuple boundaries are part of the digest, so `stdout=A, stderr=B` cannot
/// alias `stdout=AB` or the reversed stream order.
pub fn external_shell_inline_identity(event: &SessionEvent) -> Option<String> {
    let parts = external_shell_inline_segments(event);
    if parts.is_empty() {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(b"orgii-external-shell-inline-v1\0");
    for part in parts {
        hash.update([match part.stream {
            ShellReplayStream::Stdout => 1,
            ShellReplayStream::Stderr => 2,
        }]);
        hash.update((part.text.len() as u64).to_le_bytes());
        hash.update(part.text.as_bytes());
    }
    Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
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
    parts: &[ExternalShellInlineSegment<'_>],
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

fn incomplete_segment_preview_state<L>(
    event: &SessionEvent,
    call_id: &str,
    segments: &[ExternalShellReplaySegment<L>],
    error: String,
) -> ShellReplayState {
    const MARKER: &str = "[external CLI shell replay incomplete]\n";
    let content_budget = SHELL_REPLAY_PREVIEW_BYTES.saturating_sub(MARKER.len());
    let mut content = String::new();
    for segment in segments {
        if segment.stream == ShellReplayStream::Stderr {
            append_string_tail_bounded(&mut content, "[stderr] ", content_budget);
        }
        append_string_tail_bounded(&mut content, &segment.preview, content_budget);
    }
    let mut preview = String::with_capacity(MARKER.len() + content.len());
    preview.push_str(MARKER);
    preview.push_str(&content);
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

fn append_string_tail_bounded(target: &mut String, value: &str, max_bytes: usize) {
    if max_bytes == 0 {
        target.clear();
        return;
    }
    let mut value_start = value.len().saturating_sub(max_bytes);
    while value_start < value.len() && !value.is_char_boundary(value_start) {
        value_start += 1;
    }
    let value = &value[value_start..];
    let overflow = target
        .len()
        .saturating_add(value.len())
        .saturating_sub(max_bytes);
    if overflow > 0 {
        let mut remove_through = overflow.min(target.len());
        while remove_through < target.len() && !target.is_char_boundary(remove_through) {
            remove_through += 1;
        }
        target.drain(..remove_through);
    }
    target.push_str(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_types::session_event::{ActivityStatus, EventDisplayVariant, EventSource};

    #[derive(Debug, Clone)]
    struct GeneratedPayload {
        seed: u8,
    }

    fn generated_payload_range(locator: &GeneratedPayload, offset: u64, length: usize) -> Vec<u8> {
        (0..length)
            .map(|index| b'a' + ((offset + index as u64 + locator.seed as u64) % 26) as u8)
            .collect()
    }

    fn hash_generated_segments(
        segments: &[ExternalShellReplaySegment<GeneratedPayload>],
    ) -> blake3::Hash {
        let mut hasher = blake3::Hasher::new();
        let mut buffer = Vec::with_capacity(64 * 1024);
        for segment in segments {
            let mut offset = 0u64;
            while offset < segment.expected_bytes {
                let length = (segment.expected_bytes - offset).min(64 * 1024) as usize;
                buffer.clear();
                buffer.extend((0..length).map(|index| {
                    b'a' + ((offset + index as u64 + segment.locator.seed as u64) % 26) as u8
                }));
                hasher.update(&buffer);
                offset += length as u64;
            }
        }
        hasher.finalize()
    }

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

    #[test]
    #[serial_test::serial]
    fn ten_mib_locator_segments_stream_into_one_bounded_replay() {
        const SIX_MIB: u64 = 6 * 1024 * 1024;
        const FOUR_MIB: u64 = 4 * 1024 * 1024;
        const TEN_MIB: u64 = SIX_MIB + FOUR_MIB;

        let _sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().unwrap();
        database::init_shell_replay_tables(&conn).unwrap();
        let segments = vec![
            ExternalShellReplaySegment::new(
                ShellReplayStream::Stdout,
                GeneratedPayload { seed: 3 },
                SIX_MIB,
                "stdout tail",
            ),
            ExternalShellReplaySegment::new(
                ShellReplayStream::Stderr,
                GeneratedPayload { seed: 19 },
                FOUR_MIB,
                "stderr tail",
            ),
        ];
        let expected_hash = hash_generated_segments(&segments);
        let mut max_requested = 0usize;
        let mut max_returned = 0usize;
        let mut event = external_shell_event(String::new());

        persist_external_shell_replay_segments(
            &mut event,
            &segments,
            |locator, offset, requested| {
                assert!(requested <= SHELL_REPLAY_RANGE_MAX_BYTES);
                max_requested = max_requested.max(requested);
                let bytes = generated_payload_range(locator, offset, requested);
                max_returned = max_returned.max(bytes.len());
                Ok(bytes)
            },
        );

        let state = event.shell_replay.as_ref().expect("streamed replay state");
        assert_eq!(state.status, ShellReplayStatus::Complete);
        assert_eq!(state.bookmark.visible_bytes, TEN_MIB);
        assert_eq!(max_requested, SHELL_REPLAY_RANGE_MAX_BYTES);
        assert!(max_returned <= SHELL_REPLAY_RANGE_MAX_BYTES);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut actual_hash = blake3::Hasher::new();
        let mut offset = 0u64;
        while offset < TEN_MIB {
            let range = runtime
                .block_on(super::super::shell_replay::shell_replay_read_range(
                    event.session_id.clone(),
                    event.call_id.clone().unwrap(),
                    state.bookmark.visible_through_sequence,
                    state.bookmark.visible_bytes,
                    offset,
                    SHELL_REPLAY_RANGE_MAX_BYTES as u64,
                ))
                .unwrap();
            assert!(range.next_offset_bytes > offset);
            for frame in range.frames {
                actual_hash.update(frame.text.as_bytes());
            }
            offset = range.next_offset_bytes;
            if range.eof {
                break;
            }
        }
        assert_eq!(offset, TEN_MIB);
        assert_eq!(actual_hash.finalize(), expected_hash);

        // Same call id and byte length are not content identity. A provider
        // update must read the source again and replace the stale `.slog`.
        let changed_segments = vec![
            ExternalShellReplaySegment::new(
                ShellReplayStream::Stdout,
                GeneratedPayload { seed: 29 },
                SIX_MIB,
                "changed stdout tail",
            ),
            ExternalShellReplaySegment::new(
                ShellReplayStream::Stderr,
                GeneratedPayload { seed: 47 },
                FOUR_MIB,
                "changed stderr tail",
            ),
        ];
        let changed_expected_hash = hash_generated_segments(&changed_segments);
        assert_ne!(changed_expected_hash, expected_hash);
        let mut reopened = external_shell_event(String::new());
        let mut changed_source_reads = 0_usize;
        persist_external_shell_replay_segments(
            &mut reopened,
            &changed_segments,
            |locator, offset, requested| {
                changed_source_reads += 1;
                Ok(generated_payload_range(locator, offset, requested))
            },
        );
        let changed_state = reopened
            .shell_replay
            .as_ref()
            .expect("updated replay state");
        assert_eq!(changed_state.status, ShellReplayStatus::Complete);
        assert!(changed_source_reads > 1);

        let mut changed_actual_hash = blake3::Hasher::new();
        let mut changed_offset = 0_u64;
        while changed_offset < TEN_MIB {
            let range = runtime
                .block_on(super::super::shell_replay::shell_replay_read_range(
                    reopened.session_id.clone(),
                    reopened.call_id.clone().unwrap(),
                    changed_state.bookmark.visible_through_sequence,
                    changed_state.bookmark.visible_bytes,
                    changed_offset,
                    SHELL_REPLAY_RANGE_MAX_BYTES as u64,
                ))
                .unwrap();
            assert!(range.next_offset_bytes > changed_offset);
            for frame in range.frames {
                changed_actual_hash.update(frame.text.as_bytes());
            }
            changed_offset = range.next_offset_bytes;
            if range.eof {
                break;
            }
        }
        assert_eq!(changed_offset, TEN_MIB);
        assert_eq!(changed_actual_hash.finalize(), changed_expected_hash);
    }

    #[test]
    fn inline_identity_includes_content_stream_and_segment_boundaries() {
        let mut split = external_shell_event(String::new());
        split.result = serde_json::json!({"stdout":"ab","stderr":"c","exit_code":0});
        let split_identity = external_shell_inline_identity(&split).expect("split identity");

        let mut moved_boundary = external_shell_event(String::new());
        moved_boundary.result = serde_json::json!({"stdout":"a","stderr":"bc","exit_code":0});
        let moved_identity =
            external_shell_inline_identity(&moved_boundary).expect("moved boundary identity");

        let combined = external_shell_event("abc".to_string());
        let combined_identity =
            external_shell_inline_identity(&combined).expect("combined identity");
        assert_ne!(split_identity, moved_identity);
        assert_ne!(split_identity, combined_identity);
        assert_ne!(moved_identity, combined_identity);

        let mut same_length_update = external_shell_event(String::new());
        same_length_update.result = serde_json::json!({"stdout":"ax","stderr":"c","exit_code":0});
        assert_eq!(
            external_shell_inline_segments(&same_length_update)
                .iter()
                .map(|part| part.text.len())
                .sum::<usize>(),
            3
        );
        assert_ne!(
            split_identity,
            external_shell_inline_identity(&same_length_update).expect("updated identity")
        );
    }

    #[test]
    #[serial_test::serial]
    fn truncated_locator_sets_an_explicit_incomplete_preview() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().unwrap();
        database::init_shell_replay_tables(&conn).unwrap();
        let segments = vec![ExternalShellReplaySegment::new(
            ShellReplayStream::Stdout,
            "stdout-locator",
            10,
            "source-provided tail",
        )];
        let mut event = external_shell_event(String::new());

        persist_external_shell_replay_segments(
            &mut event,
            &segments,
            |_locator, offset, _requested| {
                if offset == 0 {
                    Ok(b"abc".to_vec())
                } else {
                    Ok(Vec::new())
                }
            },
        );

        let state = event.shell_replay.expect("incomplete replay state");
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
        assert!(state
            .terminal_preview
            .starts_with("[external CLI shell replay incomplete]"));
        assert!(state.terminal_preview.contains("source-provided tail"));
        assert!(state.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
        assert!(state.error.unwrap().contains("ended at byte 3"));
    }
}
