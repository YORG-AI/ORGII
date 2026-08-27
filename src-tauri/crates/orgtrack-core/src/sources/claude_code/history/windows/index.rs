use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use core_types::activity::ActivityChunk;

use crate::projectors::turn_metadata::ProjectedTurnMetadata;
use crate::sources::imported_history;

use super::super::replay::{claude_content_text, claude_tool_result_text};
use super::super::types::{is_harness_injected_user_line, ClaudeJsonlLine};
use super::super::CLAUDE_CODE_PROVIDER_SLUG;

pub(in crate::sources::claude_code::history) const CLAUDE_WINDOW_TURN_ID_PREFIX: &str =
    "claude-window-turn-";

#[derive(Debug, Clone)]
pub(in crate::sources::claude_code::history) struct ClaudeIndexedTurn {
    pub(in crate::sources::claude_code::history) start_offset: u64,
    pub(in crate::sources::claude_code::history) user_chunk: ActivityChunk,
    /// Non-empty transcript lines between this user row and the next one —
    /// the same cheap body-size surrogate Codex's catalog keeps. Placeholder
    /// rounds surface it as `bodyEventCount`; without it the flat-view
    /// collapse bar (the only expand affordance when turn pagination is off)
    /// never renders and unloaded bodies become unreachable.
    pub(in crate::sources::claude_code::history) following_line_count: usize,
    /// Byte range `(offset, length)` of the newest following line that
    /// raw-scans as an assistant message carrying a text item. Unloaded
    /// rounds parse only this one line so their placeholder can carry the
    /// final-reply preview and a real end timestamp — the metadata every
    /// full-stream provider derives in `build_initial_window_from_turns` —
    /// without materializing the whole round body.
    pub(in crate::sources::claude_code::history) last_assistant_text_line: Option<(u64, usize)>,
}

pub(in crate::sources::claude_code::history) fn claude_window_turn_id(start_offset: u64) -> String {
    format!("{CLAUDE_WINDOW_TURN_ID_PREFIX}{start_offset}")
}

pub(super) fn claude_window_turn_offset(turn_id: &str) -> Option<u64> {
    turn_id
        .strip_prefix(CLAUDE_WINDOW_TURN_ID_PREFIX)?
        .parse()
        .ok()
}

fn line_might_contain_json_string_field(line: &[u8], field: &[u8], value: &[u8]) -> bool {
    let mut key = Vec::with_capacity(field.len() + 2);
    key.push(b'"');
    key.extend_from_slice(field);
    key.push(b'"');
    let mut cursor = 0usize;
    while let Some(relative) = line[cursor..]
        .windows(key.len())
        .position(|window| window == key)
    {
        let mut index = cursor + relative + key.len();
        while line.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if line.get(index) != Some(&b':') {
            cursor = index;
            continue;
        }
        index += 1;
        while line.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if line.get(index) == Some(&b'"')
            && line.get(index + 1..index + 1 + value.len()) == Some(value)
            && line.get(index + 1 + value.len()) == Some(&b'"')
        {
            return true;
        }
        cursor = index;
    }
    false
}

fn line_might_be_claude_user(line: &[u8]) -> bool {
    line_might_contain_json_string_field(line, b"type", b"user")
}

fn line_is_obvious_tool_result(line: &[u8]) -> bool {
    line_might_contain_json_string_field(line, b"type", b"tool_result")
        && line
            .windows(b"\"tool_use_id\"".len())
            .any(|window| window == b"\"tool_use_id\"")
}

/// Raw prefilter for assistant lines that carry at least one text item
/// (`content: [{"type":"text", ...}]`). Thinking-only and tool_use-only lines
/// fail the second check, matching the preview policy of the full-stream
/// window builder (only `FUNCTION_ASSISTANT` chunks become round previews).
/// False positives (e.g. `"type":"text"` inside a tool input) are filtered by
/// the canonical parser when the line is actually loaded.
fn line_might_be_claude_assistant_text(line: &[u8]) -> bool {
    line_might_contain_json_string_field(line, b"type", b"assistant")
        && line_might_contain_json_string_field(line, b"type", b"text")
}

/// Build a byte-offset index by deserializing only likely human-user lines.
///
/// Claude transcripts are dominated by assistant/tool-result payloads. A
/// large real session can have thousands of tool-result lines but fewer than
/// one hundred conversational rounds, so parsing every JSON value just to
/// discover the round headers makes first open scale with the entire replay
/// body. The raw prefilter is conservative: false positives are validated by
/// the canonical parser below, while structurally obvious tool-result records
/// never allocate their potentially huge payloads.
pub(in crate::sources::claude_code::history) fn index_claude_user_turns(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ClaudeIndexedTurn>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut start_offset = 0u64;
    let mut turns = Vec::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut line)
            .map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        if bytes_read == 0 {
            break;
        }
        let current_offset = start_offset;
        start_offset = start_offset.saturating_add(bytes_read as u64);
        // Any line that does not become a turn header counts toward the
        // previous turn's body-size surrogate.
        let count_toward_previous_turn = |turns: &mut Vec<ClaudeIndexedTurn>| {
            if line.iter().any(|byte| !byte.is_ascii_whitespace()) {
                if let Some(previous) = turns.last_mut() {
                    previous.following_line_count += 1;
                    if line_might_be_claude_assistant_text(&line) {
                        previous.last_assistant_text_line = Some((current_offset, bytes_read));
                    }
                }
            }
        };
        if !line_might_be_claude_user(&line) || line_is_obvious_tool_result(&line) {
            count_toward_previous_turn(&mut turns);
            continue;
        }
        let Ok(parsed) = serde_json::from_slice::<ClaudeJsonlLine>(&line) else {
            count_toward_previous_turn(&mut turns);
            continue;
        };
        if parsed.r#type != "user" || is_harness_injected_user_line(&parsed) {
            count_toward_previous_turn(&mut turns);
            continue;
        }
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(message) = parsed.message else {
            count_toward_previous_turn(&mut turns);
            continue;
        };
        if claude_tool_result_text(&message.content).is_some() {
            count_toward_previous_turn(&mut turns);
            continue;
        }
        let Some(text) = claude_content_text(&message.content) else {
            count_toward_previous_turn(&mut turns);
            continue;
        };
        let text = imported_history::strip_orgii_exec_mode_bridge(&text);
        if text.trim().is_empty() {
            count_toward_previous_turn(&mut turns);
            continue;
        }
        let sequence = usize::try_from(current_offset).unwrap_or(usize::MAX);
        let mut user_chunk = imported_history::user_message_chunk(
            session_id,
            CLAUDE_CODE_PROVIDER_SLUG,
            sequence,
            &created_at,
            text,
        );
        user_chunk.chunk_id = claude_window_turn_id(current_offset);
        turns.push(ClaudeIndexedTurn {
            start_offset: current_offset,
            user_chunk,
            following_line_count: 0,
            last_assistant_text_line: None,
        });
    }
    Ok(turns)
}

/// Overlay the index's cheap body-size surrogate onto reduced-stream
/// projections. `projected[i]` must correspond to `indexed[i]` (both are
/// emitted in transcript order). Rounds before `first_loaded_turn` only
/// contributed their header (plus at most the single parsed preview line), so
/// the index surrogate is always the honest count there; rounds at or past it
/// projected real bodies and keep their exact counts unless the parse came
/// back empty. `.max(1)` mirrors Codex: a placeholder must always advertise
/// a fetchable body, or the flat view renders no expand affordance for it.
pub(in crate::sources::claude_code::history) fn overlay_indexed_body_counts(
    projected: &mut [ProjectedTurnMetadata],
    indexed: &[ClaudeIndexedTurn],
    first_loaded_turn: usize,
) {
    for (turn_index, (turn, index_entry)) in projected.iter_mut().zip(indexed).enumerate() {
        if turn_index >= first_loaded_turn && turn.body_event_count > 0 {
            continue;
        }
        let body_event_count =
            i64::try_from(index_entry.following_line_count.max(1)).unwrap_or(i64::MAX);
        turn.body_event_count = body_event_count;
        turn.event_count = body_event_count.saturating_add(1);
    }
}
