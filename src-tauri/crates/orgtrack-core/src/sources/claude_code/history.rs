//! Claude Code imported history reader
//!
//! Reads Claude Code JSONL transcripts from `~/.claude/projects/*/*.jsonl` and
//! converts them into ORGII's canonical `ActivityChunk` shape for read-only
//! replay.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};
use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        RoundUsage, StoredRoundUsage, SOURCE_CLAUDE_CODE,
    },
    paths as imported_paths, scan_snapshot,
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedHistorySessionRow,
    ImportedToolCall,
};

use super::SESSION_PREFIX as CLAUDE_CODE_SESSION_PREFIX;
const CLAUDE_CODE_PROVIDER_SLUG: &str = "claudecode";
// v4: read ai-title/custom-title records for the name, and derive diff stats
// from tool_use_result.structuredPatch instead of the old_string/new_string heuristic.
// v6: capture first-user-message uuid as the continuation dedupe group key.
// v7: capture cache_read/cache_write tokens separately (input stays cache-inclusive).
// v8: emit per-round usage rows (imported_history_round_usage).
// v9: dedup usage by message.id (one API response spans repeated JSONL lines).
// v10: harness-injected user lines (isMeta, task-notification origin) no
// longer open rounds or feed the first-prompt title; user image blocks
// surface as data-URL attachments on the user bubble.
// v11: capture compact-boundary ancestry markers so continuation families
// survive Claude Code rewriting the first user message during compaction.
// v12: name subagent rows from their small `.meta.json` sidecar instead of
// the shared beginning of each child prompt.
const CLAUDE_CODE_METADATA_PARSER_VERSION: i64 = 12;
const MAX_COMPACT_BOUNDARY_MARKERS: usize = imported_cache::MAX_CONTINUATION_MARKERS - 1;

pub type ClaudeCodeHistorySessionRow = ImportedHistorySessionRow;
pub type ClaudeCodeHistorySessionPage = ImportedHistorySessionPage;
pub type ClaudeCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct ClaudeCodeHistoryMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rounds: Vec<RoundUsage>,
    impact: ImportedHistoryImpactStats,
    /// Set for Task-tool subagent transcripts: the parent session's frontend
    /// id (`claudecodeapp-<parent-uuid>`). `None` for ordinary top-level
    /// sessions. Non-empty values are subsumed out of the sidebar/kanban.
    parent_session_id: Option<String>,
    /// `uuid` of the first `type == "user"` line. Context-window continuation
    /// rewrites copy the conversation into a NEW session file with no link
    /// field, but message uuids are preserved — so this is a stable group key
    /// uniting a conversation's continuation siblings for dedupe.
    first_user_uuid: Option<String>,
    /// Compact-boundary uuids retained by continuation rewrites. Together
    /// with `first_user_uuid` these form a bounded ancestry marker set.
    continuation_markers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlLine {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    subtype: String,
    #[serde(default)]
    summary: String,
    /// `ai-title` records: the auto-generated title shown in the Claude Code app.
    #[serde(default)]
    ai_title: String,
    /// `custom-title` records: a user-set title that overrides the AI title.
    #[serde(default)]
    custom_title: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    git_branch: String,
    #[serde(default)]
    message: Option<ClaudeMessage>,
    /// Sidecar payload on tool-result lines. For edit tools it carries a
    /// `structuredPatch` with exact `+`/`-` diff lines.
    #[serde(default)]
    tool_use_result: Option<Value>,
    /// `true` on every line of a Task-tool subagent transcript
    /// (`<parent-uuid>/subagents/agent-*.jsonl`). Marks the whole file as a
    /// child session that must be subsumed under its parent.
    #[serde(default)]
    is_sidechain: bool,
    /// The parent session's UUID. On a subagent transcript every line carries
    /// the spawning session's id here (not the subagent's own `agent-*` stem),
    /// which is exactly the parent linkage we need.
    #[serde(default)]
    session_id: String,
    /// Per-message uuid, preserved verbatim across continuation rewrites.
    #[serde(default)]
    uuid: String,
    /// `true` on harness-injected user lines (command caveats, hook feedback,
    /// loop ticks) that Claude Code's own UI hides from the conversation.
    #[serde(default)]
    is_meta: bool,
    /// Provenance of a user line. Observed kinds: `human` (typed prompt) and
    /// `task-notification` (background-task completion wake).
    #[serde(default)]
    origin: Option<ClaudeLineOrigin>,
}

#[derive(Debug, Deserialize)]
struct ClaudeLineOrigin {
    #[serde(default)]
    kind: String,
}

fn is_harness_injected_user_line(parsed: &ClaudeJsonlLine) -> bool {
    imported_history::is_harness_injected_user_marker(
        parsed.is_meta,
        parsed.origin.as_ref().map(|origin| origin.kind.as_str()),
    )
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    /// Assistant API-response id (`msg_…`). One response is written across
    /// several JSONL lines that each repeat the cumulative `usage`, so tokens
    /// are counted once per unique id.
    #[serde(default)]
    id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    content: Value,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
struct ClaudeSessionTitle {
    name: String,
    name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionMetadataFile {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeSubagentMetadataFile {
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone)]
struct ClaudeCodeSessionFile {
    file_stem: String,
    path: PathBuf,
}

pub fn list_claude_code_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ClaudeCodeHistorySessionPage, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CLAUDE_CODE, limit, offset)
}

pub fn list_claude_code_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ClaudeCodeRecentPath>, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CLAUDE_CODE, limit)
}

pub fn load_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_history_from_path(session_id, &path)
}

const CLAUDE_WINDOW_TURN_ID_PREFIX: &str = "claude-window-turn-";

#[derive(Debug, Clone)]
struct ClaudeIndexedTurn {
    start_offset: u64,
    user_chunk: ActivityChunk,
    /// Non-empty transcript lines between this user row and the next one —
    /// the same cheap body-size surrogate Codex's catalog keeps. Placeholder
    /// rounds surface it as `bodyEventCount`; without it the flat-view
    /// collapse bar (the only expand affordance when turn pagination is off)
    /// never renders and unloaded bodies become unreachable.
    following_line_count: usize,
    /// Byte range `(offset, length)` of the newest following line that
    /// raw-scans as an assistant message carrying a text item. Unloaded
    /// rounds parse only this one line so their placeholder can carry the
    /// final-reply preview and a real end timestamp — the metadata every
    /// full-stream provider derives in `build_initial_window_from_turns` —
    /// without materializing the whole round body.
    last_assistant_text_line: Option<(u64, usize)>,
}

fn claude_window_turn_id(start_offset: u64) -> String {
    format!("{CLAUDE_WINDOW_TURN_ID_PREFIX}{start_offset}")
}

fn claude_window_turn_offset(turn_id: &str) -> Option<u64> {
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
fn index_claude_user_turns(
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
fn overlay_indexed_body_counts(
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

fn load_claude_turn_range(
    file: &mut fs::File,
    session_id: &str,
    start_offset: u64,
    end_offset: u64,
    turn_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    load_claude_turn_range_with_sequence(
        file,
        session_id,
        start_offset,
        end_offset,
        usize::try_from(start_offset).unwrap_or(usize::MAX),
        Some(turn_id),
    )
}

fn load_claude_turn_range_with_sequence(
    file: &mut fs::File,
    session_id: &str,
    start_offset: u64,
    end_offset: u64,
    start_sequence: usize,
    forced_first_user_id: Option<&str>,
) -> Result<Vec<ActivityChunk>, String> {
    file.seek(SeekFrom::Start(start_offset))
        .map_err(|err| format!("Failed to seek Claude history: {err}"))?;
    let take = file.take(end_offset.saturating_sub(start_offset));
    load_claude_code_history_from_reader(
        session_id,
        BufReader::new(take),
        start_sequence,
        forced_first_user_id,
    )
}

/// Parse only the indexed final assistant-text line of an unloaded round.
/// The returned chunk is fed to `build_initial_window_from_turns`, which
/// consumes it into the round placeholder's last-reply preview and (via
/// projection) its real end timestamp — the same metadata providers that
/// stream full bodies get for free. Best-effort: any read/parse miss leaves
/// the round preview-less rather than failing the whole window.
fn load_claude_turn_preview_chunk(
    file: &mut fs::File,
    session_id: &str,
    turn: &ClaudeIndexedTurn,
) -> Option<ActivityChunk> {
    let (offset, length) = turn.last_assistant_text_line?;
    let end_offset = offset.checked_add(length as u64)?;
    load_claude_turn_range_with_sequence(
        file,
        session_id,
        offset,
        end_offset,
        usize::try_from(offset).unwrap_or(usize::MAX),
        None,
    )
    .ok()?
    .into_iter()
    .rfind(|chunk| chunk.function == imported_history::FUNCTION_ASSISTANT)
}

pub fn load_claude_code_initial_window_for_session(
    conn: &Connection,
    session_id: &str,
    recent_turn_count: usize,
) -> Result<imported_history::window::ImportedHistoryInitialWindow, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_initial_window_from_path(session_id, &path, recent_turn_count)
}

fn load_claude_code_initial_window_from_path(
    session_id: &str,
    path: &Path,
    recent_turn_count: usize,
) -> Result<imported_history::window::ImportedHistoryInitialWindow, String> {
    let indexed = index_claude_user_turns(session_id, path)?;
    if indexed.is_empty() {
        return load_claude_code_history_from_path(session_id, path).map(|chunks| {
            imported_history::window::build_initial_window(session_id, chunks, recent_turn_count)
        });
    }

    let file_len = fs::metadata(path)
        .map_err(|err| format!("Failed to stat Claude history {}: {err}", path.display()))?
        .len();
    let first_loaded_turn = indexed
        .len()
        .saturating_sub(recent_turn_count.max(1).min(indexed.len()));
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    let mut chunks = Vec::with_capacity(indexed.len().saturating_mul(2));
    for (index, turn) in indexed.iter().enumerate() {
        if index < first_loaded_turn {
            chunks.push(turn.user_chunk.clone());
            if let Some(preview) = load_claude_turn_preview_chunk(&mut file, session_id, turn) {
                chunks.push(preview);
            }
            continue;
        }
        let end_offset = indexed
            .get(index + 1)
            .map(|next| next.start_offset)
            .unwrap_or(file_len);
        let mut body = load_claude_turn_range(
            &mut file,
            session_id,
            turn.start_offset,
            end_offset,
            &turn.user_chunk.chunk_id,
        )?;
        if body.is_empty() {
            body.push(turn.user_chunk.clone());
        }
        chunks.append(&mut body);
    }
    let mut projected = project_activity_chunks(&chunks);
    overlay_indexed_body_counts(&mut projected, &indexed, first_loaded_turn);
    Ok(imported_history::window::build_initial_window_from_turns(
        session_id,
        chunks,
        recent_turn_count,
        projected,
    ))
}

pub fn load_claude_code_turn_windows_for_session(
    conn: &Connection,
    session_id: &str,
    turn_ids: &[String],
) -> Result<Vec<imported_history::window::ImportedHistoryTurnWindow>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    let indexed = index_claude_user_turns(session_id, &path)?;
    let file_len = fs::metadata(path.as_path())
        .map_err(|err| format!("Failed to stat Claude history {}: {err}", path.display()))?
        .len();
    let positions = indexed
        .iter()
        .enumerate()
        .map(|(index, turn)| (turn.start_offset, index))
        .collect::<HashMap<_, _>>();
    let mut file = fs::File::open(path.as_path())
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;

    turn_ids
        .iter()
        .map(|turn_id| {
            let Some(offset) = claude_window_turn_offset(turn_id) else {
                return Ok(imported_history::window::ImportedHistoryTurnWindow {
                    chunks: Vec::new(),
                    turn_id: turn_id.clone(),
                    loaded_event_count: 0,
                });
            };
            let Some(index) = positions.get(&offset).copied() else {
                return Ok(imported_history::window::ImportedHistoryTurnWindow {
                    chunks: Vec::new(),
                    turn_id: turn_id.clone(),
                    loaded_event_count: 0,
                });
            };
            let end_offset = indexed
                .get(index + 1)
                .map(|next| next.start_offset)
                .unwrap_or(file_len);
            let chunks =
                load_claude_turn_range(&mut file, session_id, offset, end_offset, turn_id)?;
            Ok(imported_history::window::ImportedHistoryTurnWindow {
                loaded_event_count: chunks.len(),
                chunks,
                turn_id: turn_id.clone(),
            })
        })
        .collect()
}

pub fn load_claude_code_cloud_turn_windows_for_session(
    conn: &Connection,
    session_id: &str,
    turn_ids: &[String],
    start_sequence: usize,
) -> Result<Vec<imported_history::window::ImportedHistoryTurnWindow>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_cloud_turn_windows_from_path(session_id, &path, turn_ids, start_sequence)
}

fn load_claude_code_cloud_turn_windows_from_path(
    session_id: &str,
    path: &Path,
    turn_ids: &[String],
    start_sequence: usize,
) -> Result<Vec<imported_history::window::ImportedHistoryTurnWindow>, String> {
    let file_len = fs::metadata(path)
        .map_err(|err| format!("Failed to stat Claude history {}: {err}", path.display()))?
        .len();
    let offsets = turn_ids
        .iter()
        .map(|turn_id| {
            claude_window_turn_offset(turn_id)
                .ok_or_else(|| format!("Invalid Claude cloud turn id: {turn_id}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if offsets
        .windows(2)
        .any(|pair| pair[0] >= pair[1] || pair[1] >= file_len)
        || offsets.first().is_some_and(|offset| *offset >= file_len)
    {
        return Err("Claude cloud turn offsets are out of order or out of bounds".to_string());
    }
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    let mut next_sequence = start_sequence;

    turn_ids
        .iter()
        .enumerate()
        .map(|(index, turn_id)| {
            let offset = offsets[index];
            let end_offset = offsets.get(index + 1).copied().unwrap_or(file_len);
            let chunks = load_claude_turn_range_with_sequence(
                &mut file,
                session_id,
                offset,
                end_offset,
                next_sequence,
                None,
            )?;
            next_sequence = next_sequence.saturating_add(chunks.len());
            Ok(imported_history::window::ImportedHistoryTurnWindow {
                loaded_event_count: chunks.len(),
                chunks,
                turn_id: turn_id.clone(),
            })
        })
        .collect()
}

pub fn load_claude_code_turn_index_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ProjectedTurnMetadata>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    let indexed = index_claude_user_turns(session_id, &path)?;
    let chunks = indexed
        .iter()
        .map(|turn| turn.user_chunk.clone())
        .collect::<Vec<_>>();
    let mut projected = project_activity_chunks(&chunks);
    // Every round here is reduced (header-only), so the surrogate always wins.
    overlay_indexed_body_counts(&mut projected, &indexed, indexed.len());
    Ok(projected)
}

pub fn load_claude_code_turn_ids_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    Ok(index_claude_user_turns(session_id, &path)?
        .into_iter()
        .map(|turn| turn.user_chunk.chunk_id)
        .collect())
}

/// Cheap freshness probe for one session's transcript: `(mtime_ms, size_bytes)`.
/// Auto-refresh callers compare it against the previous probe and skip the
/// full read/parse/merge pipeline when the source file has not changed —
/// which is every tick for a finished session. Returns `Ok(None)` when the
/// transcript file is missing (caller falls back to a full refresh attempt).
pub fn stat_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    match fs::metadata(&path) {
        Ok(metadata) => {
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            Ok(Some((mtime_ms, metadata.len())))
        }
        Err(_) => Ok(None),
    }
}

fn sync_claude_code_history_cache(conn: &mut Connection) -> Result<(), String> {
    let previous_snapshots = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_CLAUDE_CODE);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous_snapshots, "jsonl", "Claude");
    let discovery = discover_claude_code_history_records(&claude_projects_dirs()?, &mut walker)?;
    let next_snapshots = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(
        conn,
        SOURCE_CLAUDE_CODE,
        &previous_snapshots,
        &next_snapshots,
    )?;
    let ClaudeCodeDiscovery {
        records: mut discovered,
        external_titles,
    } = discovery;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        SOURCE_CLAUDE_CODE,
    )?;
    for record in &mut discovered {
        managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            managed_ids.contains(&record.source_session_id),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        &discovered,
        |record| record.signature(),
    )?;
    let mut inputs = Vec::new();
    let mut rounds = Vec::new();
    let mut reparsed_ids = Vec::new();
    for record in changed {
        let stored_watermark = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
        )?;
        let external_title = external_titles
            .get(&record.source_session_id)
            .cloned()
            .unwrap_or_default();
        let Some(parse) = imported_history::skip_unparsable_record(
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
            parse_claude_session_meta_with_title(record, stored_watermark.as_ref(), external_title),
        ) else {
            continue;
        };
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
            &parse.watermark,
        )?;
        if let Some(mut meta) = parse.meta {
            let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
            reparsed_ids.push(meta.session_id.clone());
            rounds.append(&mut meta.rounds);
            let mut input = session_meta_to_cache_input(meta);
            input.listable = input.listable && !is_managed_history_mirror;
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )?;
    imported_cache::write_session_rounds_from_conn(conn, &reparsed_ids, &rounds)?;
    // Context-window continuations rewrite the conversation into a new
    // session file with the same first-user-message uuid; keep only the
    // newest sibling of each family listable.
    imported_cache::demote_superseded_continuations_from_conn(conn, SOURCE_CLAUDE_CODE)?;
    Ok(())
}

#[derive(Debug)]
struct ClaudeCodeDiscovery {
    records: Vec<ImportedHistoryDiscoveredRecord>,
    external_titles: HashMap<String, String>,
}

fn discover_claude_code_history_records(
    projects_dirs: &[PathBuf],
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
) -> Result<ClaudeCodeDiscovery, String> {
    let mut records = Vec::new();
    let mut external_titles = HashMap::new();
    for projects_dir in projects_dirs {
        if !projects_dir.is_dir() {
            continue;
        }
        let title_index = load_claude_session_titles_for_projects_dir(projects_dir)?;
        let mut paths = Vec::new();
        walker.collect_files(projects_dir, &mut paths)?;
        for path in paths {
            if is_claude_workflow_journal_path(&path) {
                continue;
            }
            let Some(file_stem) = path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&path, "Claude")?;
            let subagent_title = claude_subagent_metadata_title(&path);
            if let Some(title) = subagent_title.as_ref() {
                external_titles.insert(file_stem.clone(), title.clone());
            } else if let Some(title) = title_index.get(&file_stem) {
                external_titles.insert(
                    file_stem.clone(),
                    imported_history::truncate_name(&title.name, 200),
                );
            }
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: file_stem.clone(),
                source_path: path,
                source_record_key: file_stem.clone(),
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: claude_source_fingerprint(
                    &file_stem,
                    &title_index,
                    subagent_title.as_deref(),
                ),
                parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
            });
        }
    }
    Ok(ClaudeCodeDiscovery {
        records,
        external_titles,
    })
}

/// `<uuid>/subagents/workflows/wf_*/journal.jsonl` files are workflow event
/// journals, not session transcripts. Their shared `journal` stem collides
/// into one cache row that every sync pass re-upserts, so they are excluded
/// at discovery. Workflow `agent-*.jsonl` files in the same tree ARE real
/// sidechain transcripts and stay included.
fn is_claude_workflow_journal_path(path: &Path) -> bool {
    if path.file_stem().and_then(|value| value.to_str()) != Some("journal") {
        return false;
    }
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components
        .windows(2)
        .any(|pair| pair == ["subagents", "workflows"])
}

fn claude_subagent_metadata_title(path: &Path) -> Option<String> {
    if !path
        .ancestors()
        .any(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("subagents"))
    {
        return None;
    }
    // This file is optional Claude Code metadata. A missing, unreadable, or
    // malformed sidecar must not prevent the transcript itself from loading.
    let metadata_path = path.with_extension("meta.json");
    let contents = fs::read_to_string(metadata_path).ok()?;
    let metadata = serde_json::from_str::<ClaudeSubagentMetadataFile>(&contents).ok()?;
    let description = metadata.description.trim();
    (!description.is_empty()).then(|| imported_history::truncate_name(description, 200))
}

fn collect_claude_session_files(
    dir: &Path,
    out: &mut Vec<ClaudeCodeSessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Claude dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Claude dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_claude_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            if is_claude_workflow_journal_path(&path) {
                continue;
            }
            let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            out.push(ClaudeCodeSessionFile {
                file_stem: file_stem.to_string(),
                path,
            });
        }
    }
    Ok(())
}

fn load_claude_session_titles_for_projects_dir(
    projects_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let Some(root) = projects_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_claude_session_titles(&root.join("sessions"))
}

fn load_claude_session_titles(
    sessions_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let mut entries = HashMap::new();
    if !sessions_dir.is_dir() {
        return Ok(entries);
    }

    for entry in fs::read_dir(sessions_dir)
        .map_err(|err| format!("Failed to read Claude sessions dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Failed to read Claude session entry: {err}"))?;
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let contents = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read Claude session metadata {}: {err}",
                path.display()
            )
        })?;
        let parsed: ClaudeSessionMetadataFile = match serde_json::from_str(&contents) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let session_id = parsed.session_id.trim();
        let name = parsed.name.trim();
        if session_id.is_empty() || name.is_empty() {
            continue;
        }
        entries.insert(
            session_id.to_string(),
            ClaudeSessionTitle {
                name: name.to_string(),
                name_source: parsed.name_source,
            },
        );
    }

    Ok(entries)
}

fn claude_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, ClaudeSessionTitle>,
    subagent_title: Option<&str>,
) -> String {
    if let Some(title) = subagent_title {
        return format!("subagent-meta:{title}");
    }
    title_index
        .get(file_stem)
        .map(|title| {
            format!(
                "session-meta:{}:{}",
                title.name_source.as_deref().unwrap_or_default(),
                title.name
            )
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn claude_session_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(sessions_dir) = claude_sessions_dir_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_claude_session_titles(&sessions_dir)?;
    Ok(title_index
        .get(&record.source_record_key)
        .map(|title| imported_history::truncate_name(&title.name, 200))
        .unwrap_or_default())
}

#[cfg(test)]
fn claude_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path.ancestors().find_map(|ancestor| {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("projects") {
            return ancestor.parent().map(|root| root.join("sessions"));
        }
        None
    })
}

/// Resumable accumulator for one transcript's meta scan. Every field is
/// exactly the per-file state the old single-pass loop kept in locals, so it
/// can be frozen into a parse watermark's `state_json` at a complete-line
/// boundary and resumed against only the appended suffix.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ClaudeSessionMetaState {
    created_at_ms: i64,
    updated_at_ms: i64,
    /// First transcript `summary` title; the fresh sessions-dir title
    /// (external, re-read each parse) still wins.
    summary_title: String,
    ai_title: String,
    custom_title: String,
    first_prompt: String,
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rounds: Vec<StoredRoundUsage>,
    // One API response spans several assistant lines that repeat the same
    // `usage`; count each `message.id` once.
    seen_message_ids: HashSet<String>,
    // Primary impact source: exact counts from tool_use_result.structuredPatch.
    impact: ImportedHistoryImpactStats,
    touched_files: BTreeSet<String>,
    // Fallback for transcripts old enough to lack structuredPatch: the coarse
    // old_string/new_string line count. Only used when no patch data is found.
    fallback_impact: ImportedHistoryImpactStats,
    fallback_touched: BTreeSet<String>,
    // Subagent transcripts (`<parent-uuid>/subagents/agent-*.jsonl`) tag every
    // line `isSidechain: true` and carry the spawning session's UUID in
    // `sessionId`. Capturing it lets us subsume the child under its parent the
    // same way Codex does, instead of listing it as a top-level session.
    parent_source_session_id: Option<String>,
    first_user_uuid: Option<String>,
    /// Keep the newest compact boundaries; the first-user marker consumes the
    /// remaining slot in the 64-marker cache metadata budget.
    compact_boundary_uuids: VecDeque<String>,
}

impl ClaudeSessionMetaState {
    fn feed(&mut self, trimmed: &str, record: &ImportedHistoryDiscoveredRecord) {
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };
        let line_ms = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
            .unwrap_or(0);
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if self.created_at_ms == 0 || timestamp < self.created_at_ms {
                self.created_at_ms = timestamp;
            }
            if timestamp > self.updated_at_ms {
                self.updated_at_ms = timestamp;
            }
        }
        if self.repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            self.repo_path = Some(parsed.cwd.clone());
        }
        if self.branch.is_none() && !parsed.git_branch.trim().is_empty() {
            self.branch = Some(parsed.git_branch.clone());
        }
        // A sidechain line whose `sessionId` differs from this file's own stem
        // is a subagent pointing at its spawning session. Guard against a self
        // reference so a malformed line can never make a session its own parent.
        if self.parent_source_session_id.is_none() && parsed.is_sidechain {
            let candidate = parsed.session_id.trim();
            if !candidate.is_empty() && candidate != record.source_session_id {
                self.parent_source_session_id = Some(candidate.to_string());
            }
        }
        // Claude Code persists the session title inside the transcript. Titles are
        // re-emitted as the conversation evolves, so the last write wins.
        match parsed.r#type.as_str() {
            "summary" if self.summary_title.is_empty() => {
                let summary = parsed.summary.trim();
                if !summary.is_empty() {
                    self.summary_title = imported_history::truncate_name(summary, 200);
                }
            }
            "ai-title" => {
                let title = parsed.ai_title.trim();
                if !title.is_empty() {
                    self.ai_title = imported_history::truncate_name(title, 200);
                }
            }
            "custom-title" => {
                let title = parsed.custom_title.trim();
                if !title.is_empty() {
                    self.custom_title = imported_history::truncate_name(title, 200);
                }
            }
            _ => {}
        }
        // Exact diff stats come from the tool-result's structuredPatch.
        if let Some(result) = parsed.tool_use_result.as_ref() {
            collect_claude_impact_from_tool_result(
                result,
                &mut self.impact,
                &mut self.touched_files,
            );
        }
        if self.first_user_uuid.is_none()
            && parsed.r#type == "user"
            && !parsed.uuid.trim().is_empty()
        {
            self.first_user_uuid = Some(parsed.uuid.trim().to_string());
        }
        if parsed.r#type == "system"
            && parsed.subtype == "compact_boundary"
            && !parsed.uuid.trim().is_empty()
        {
            let marker = parsed.uuid.trim();
            if !self
                .compact_boundary_uuids
                .iter()
                .any(|existing| existing == marker)
            {
                if self.compact_boundary_uuids.len() >= MAX_COMPACT_BOUNDARY_MARKERS {
                    self.compact_boundary_uuids.pop_front();
                }
                self.compact_boundary_uuids.push_back(marker.to_string());
            }
        }
        let harness_injected = is_harness_injected_user_line(&parsed);
        if let Some(message) = parsed.message {
            if self.first_prompt.is_empty() && parsed.r#type == "user" && !harness_injected {
                if let Some(text) = claude_content_text(&message.content) {
                    // GUI-launched runs prefix the first prompt with the
                    // exec-mode briefing; bridge-only text is no title
                    // candidate at all.
                    let text = imported_history::strip_orgii_exec_mode_bridge(&text);
                    if !text.trim().is_empty() {
                        self.first_prompt = imported_history::truncate_name(text, 200);
                    }
                }
            }
            if self.model.is_none()
                && !message.model.trim().is_empty()
                && !message.model.starts_with('<')
            {
                self.model = Some(message.model.clone());
            }
            if parsed.r#type == "assistant" {
                for item in claude_content_items(&message.content) {
                    collect_claude_impact_from_item(
                        item,
                        &mut self.fallback_impact,
                        &mut self.fallback_touched,
                    );
                }
            }
            // Skip repeated lines of the same API response (same message.id),
            // which would otherwise triple both totals and rounds.
            let usage_is_new =
                message.id.is_empty() || self.seen_message_ids.insert(message.id.clone());
            if let Some(usage) = message.usage.filter(|_| usage_is_new) {
                // input_tokens stays cache-inclusive (fresh + both cache kinds);
                // the cache portion is tracked separately for the cost split.
                self.input_tokens += usage.input_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                self.output_tokens += usage.output_tokens;
                self.cache_read_tokens += usage.cache_read_input_tokens;
                self.cache_write_tokens += usage.cache_creation_input_tokens;
                // One round per assistant message that reports usage. `input`
                // here is FRESH (round convention), cache tracked separately.
                if usage.input_tokens > 0
                    || usage.output_tokens > 0
                    || usage.cache_read_input_tokens > 0
                    || usage.cache_creation_input_tokens > 0
                {
                    self.rounds.push(StoredRoundUsage {
                        seq: self.rounds.len() as i64,
                        model: self.model.clone(),
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_read_tokens: usage.cache_read_input_tokens,
                        cache_write_tokens: usage.cache_creation_input_tokens,
                        created_at_ms: line_ms,
                    });
                }
            }
        }
    }

    fn finish(
        mut self,
        record: &ImportedHistoryDiscoveredRecord,
        external_title: String,
    ) -> Option<ClaudeCodeHistoryMeta> {
        // Prefer the precise structuredPatch counts; fall back to the coarse
        // old_string/new_string heuristic only when no patch data was present.
        if self.touched_files.is_empty()
            && self.impact.lines_added == 0
            && self.impact.lines_removed == 0
        {
            self.impact = self.fallback_impact;
            self.touched_files = self.fallback_touched;
        }
        self.impact.touched_files = self.touched_files.into_iter().collect();
        self.impact.files_changed = self.impact.touched_files.len() as i64;

        if self.created_at_ms == 0 && record.source_mtime_ms == 0 {
            return None;
        }

        let derived_title = if external_title.is_empty() {
            self.summary_title
        } else {
            external_title
        };
        let session_id = super::canonical_session_id(&record.source_session_id);
        let rounds = self
            .rounds
            .into_iter()
            .map(|round| {
                round.into_round_usage(SOURCE_CLAUDE_CODE, &record.source_session_id, &session_id)
            })
            .collect();
        Some(ClaudeCodeHistoryMeta {
            source_session_id: record.source_session_id.clone(),
            session_id,
            source_path: record.source_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            source_fingerprint: record.source_fingerprint.clone(),
            // Mirror the Claude Code app's own precedence: a user-set custom title
            // wins, then the AI-generated title, then the derived/summary title,
            // then the first prompt, and finally the raw session id.
            name: if !self.custom_title.is_empty() {
                self.custom_title
            } else if !self.ai_title.is_empty() {
                self.ai_title
            } else if !derived_title.is_empty() {
                derived_title
            } else if !self.first_prompt.is_empty() {
                self.first_prompt
            } else {
                record.source_record_key.clone()
            },
            created_at_ms: if self.created_at_ms > 0 {
                self.created_at_ms
            } else {
                record.source_mtime_ms
            },
            updated_at_ms: if self.updated_at_ms > 0 {
                self.updated_at_ms
            } else {
                record.source_mtime_ms
            },
            model: self.model,
            repo_path: self.repo_path,
            branch: self.branch,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            rounds,
            impact: self.impact,
            parent_session_id: self
                .parent_source_session_id
                .map(|uuid| format!("{CLAUDE_CODE_SESSION_PREFIX}{uuid}")),
            first_user_uuid: self.first_user_uuid,
            continuation_markers: self.compact_boundary_uuids.into_iter().collect(),
        })
    }
}

struct ClaudeSessionMetaParse {
    meta: Option<ClaudeCodeHistoryMeta>,
    watermark: ImportedParseWatermark,
    #[cfg_attr(not(test), allow(dead_code))]
    resumed: bool,
}

fn parse_claude_session_meta_with_title(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
    external_title: String,
) -> Result<ClaudeSessionMetaParse, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        "Claude",
        watermark,
        CLAUDE_CODE_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = ClaudeSessionMetaState::default();
    let mut resumed = false;
    if let Some(state_json) = reader.resume_state_json() {
        match serde_json::from_str::<ClaudeSessionMetaState>(state_json) {
            Ok(parsed) => {
                state = parsed;
                resumed = true;
            }
            Err(_) => {
                reader = WatermarkedTranscriptReader::open(
                    &record.source_path,
                    "Claude",
                    None,
                    CLAUDE_CODE_METADATA_PARSER_VERSION,
                    record.source_mtime_ms,
                    record.source_size_bytes,
                )?;
            }
        }
    }
    let mut tail_state: Option<ClaudeSessionMetaState> = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed, record);
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed, record);
            tail_state = Some(snapshot);
        }
    }
    let state_json = serde_json::to_string(&state)
        .map_err(|err| format!("Failed to serialize Claude parse state: {err}"))?;
    let next_watermark = reader.into_watermark(
        CLAUDE_CODE_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let meta = tail_state.unwrap_or(state).finish(record, external_title);
    Ok(ClaudeSessionMetaParse {
        meta,
        watermark: next_watermark,
        resumed,
    })
}

#[cfg(test)]
fn parse_claude_session_meta_incremental(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<ClaudeSessionMetaParse, String> {
    let external_title = claude_session_title_for_record(record)?;
    parse_claude_session_meta_with_title(record, watermark, external_title)
}

#[cfg(test)]
fn parse_claude_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ClaudeCodeHistoryMeta>, String> {
    Ok(parse_claude_session_meta_incremental(record, None)?.meta)
}

fn session_meta_to_cache_input(meta: ClaudeCodeHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CLAUDE_CODE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: imported_cache::continuation_metadata_json(
            meta.first_user_uuid.as_deref(),
            &meta.continuation_markers,
        ),
        parent_session_id: meta.parent_session_id,
    }
}

/// Accumulate exact diff stats from a tool result's `structuredPatch`.
///
/// Claude Code attaches a `toolUseResult` sidecar to Edit/MultiEdit/Write tool
/// results containing a unified-diff-style `structuredPatch`. Each hunk's `lines`
/// are prefixed with `+` (added), `-` (removed), or ` ` (context), so this yields
/// the same counts a `git diff` would — unlike the old_string/new_string heuristic.
fn collect_claude_impact_from_tool_result(
    result: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let Some(hunks) = result.get("structuredPatch").and_then(Value::as_array) else {
        return;
    };
    if let Some(file_path) = result
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        touched_files.insert(file_path.to_string());
    }
    for hunk in hunks {
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            match line.as_str().and_then(|text| text.as_bytes().first()) {
                Some(b'+') => impact.lines_added += 1,
                Some(b'-') => impact.lines_removed += 1,
                _ => {}
            }
        }
    }
}

fn collect_claude_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let Some(tool_name) = item.get("name").and_then(Value::as_str) else {
        return;
    };
    if !matches!(tool_name, "Edit" | "MultiEdit" | "Write") {
        return;
    }
    let Some(input) = item.get("input") else {
        return;
    };
    let Some(file_path) = input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    touched_files.insert(file_path.to_string());
    match tool_name {
        "Write" => {
            if let Some(content) = input.get("content").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(content);
            }
        }
        "Edit" => {
            accumulate_claude_edit_input(input, impact);
        }
        "MultiEdit" => {
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for edit in edits {
                    accumulate_claude_edit_input(edit, impact);
                }
            }
        }
        _ => {}
    }
}

fn accumulate_claude_edit_input(input: &Value, impact: &mut ImportedHistoryImpactStats) {
    if let Some(old_string) = input.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = input.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
}

fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

fn load_claude_code_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    load_claude_code_history_from_reader(session_id, BufReader::new(file), 0, None)
}

fn load_claude_code_history_from_reader<R: BufRead>(
    session_id: &str,
    reader: R,
    start_sequence: usize,
    forced_first_user_id: Option<&str>,
) -> Result<Vec<ActivityChunk>, String> {
    let mut chunks = Vec::new();
    let mut pending_tool_calls: imported_history::PendingCallMap<ImportedToolCall> =
        imported_history::PendingCallMap::new();
    let mut sequence = start_sequence;
    let mut forced_first_user_id = forced_first_user_id;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let harness_injected = is_harness_injected_user_line(&parsed);
        let Some(message) = parsed.message else {
            continue;
        };

        match parsed.r#type.as_str() {
            "user" => {
                if let Some(tool_result_output) = claude_tool_result_text(&message.content) {
                    if let Some((call_id, output)) = tool_result_output {
                        if let Some(call) = pending_tool_calls.remove(&call_id) {
                            let mut chunk = imported_history::tool_call_chunk(
                                session_id,
                                CLAUDE_CODE_PROVIDER_SLUG,
                                sequence,
                                &call,
                                &output,
                            );
                            // Edit/MultiEdit/Write results carry a
                            // `structuredPatch`; attach it as the exact diff so
                            // the edit card renders the real change.
                            apply_claude_edit_diff(&mut chunk, parsed.tool_use_result.as_ref());
                            chunks.push(chunk);
                            sequence += 1;
                        }
                    }
                } else {
                    // Strip the GUI exec-mode briefing; a bridge-only message
                    // carries no user-authored text, so emit no bubble.
                    let text = claude_content_text(&message.content)
                        .map(|text| {
                            imported_history::strip_orgii_exec_mode_bridge(&text).to_string()
                        })
                        .unwrap_or_default();
                    let images = claude_content_image_data_urls(&message.content);
                    if !harness_injected && (!text.trim().is_empty() || !images.is_empty()) {
                        let mut chunk = imported_history::user_message_chunk(
                            session_id,
                            CLAUDE_CODE_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        );
                        if let Some(turn_id) = forced_first_user_id.take() {
                            chunk.chunk_id = turn_id.to_string();
                        }
                        if !images.is_empty() {
                            chunk.result["images"] = json!(images);
                        }
                        chunks.push(chunk);
                        sequence += 1;
                    }
                }
            }
            "assistant" => {
                for item in claude_content_items(&message.content) {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    match item_type {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "thinking" => {
                            if let Some(text) = item.get("thinking").and_then(Value::as_str) {
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "tool_use" => {
                            if let Some(call) = claude_tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    for call in pending_tool_calls.drain_in_file_order() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            CLAUDE_CODE_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

fn claude_tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("id")?.as_str()?.to_string();
    let raw_name = item.get("name")?.as_str()?.to_string();
    let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_claude_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn normalize_claude_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "command": command,
        "cmd": command,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    // `create` for new-file Writes (so the diff card can tag it as new), `edit`
    // otherwise. Old/new text is intentionally NOT carried on the args: the exact
    // diff is threaded onto the result from the tool's `structuredPatch` at
    // result-pairing time (see `apply_claude_edit_diff`), and keeping old/new off
    // the args lets the frontend render that context-rich diff rather than a bare
    // old_string→new_string snippet.
    let action = if raw_name == "Write" {
        "create"
    } else {
        "edit"
    };
    json!({
        "action": action,
        "file_path": file_path,
    })
}

/// Attach the exact edit diff to a tool-result chunk.
///
/// Edit/MultiEdit/Write results carry a `toolUseResult.structuredPatch`; convert
/// it to a unified diff (with surrounding context) and store it on the chunk
/// result as `diff` plus exact `linesAdded`/`linesRemoved`, so the frontend diff
/// card renders the real change. When no patch is present (rare/older
/// transcripts) fall back to the authoritative `oldString`/`newString` (or a
/// Write's `content`) so at least a snippet still renders.
fn apply_claude_edit_diff(chunk: &mut ActivityChunk, tool_use_result: Option<&Value>) {
    let Some(result) = tool_use_result else {
        return;
    };

    if let Some((diff, added, removed)) = claude_unified_diff_from_patch(result) {
        if let Some(obj) = chunk.result.as_object_mut() {
            obj.insert("diff".to_string(), Value::String(diff));
            obj.insert("linesAdded".to_string(), json!(added));
            obj.insert("linesRemoved".to_string(), json!(removed));
        }
        return;
    }

    let old_string = result
        .get("oldString")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new_string = result
        .get("newString")
        .or_else(|| result.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if old_string.is_empty() && new_string.is_empty() {
        return;
    }
    if let Some(obj) = chunk.args.as_object_mut() {
        obj.insert("old_string".to_string(), json!(old_string));
        obj.insert("new_string".to_string(), json!(new_string));
    }
}

/// Convert a `toolUseResult.structuredPatch` into a unified diff string plus its
/// added/removed line counts. Returns `None` when no (non-empty) patch is present.
///
/// Each hunk's `lines` are already prefixed with `+`/`-`/` `, so this yields a
/// standard unified diff that the frontend diff extractor parses directly.
fn claude_unified_diff_from_patch(result: &Value) -> Option<(String, i64, i64)> {
    let hunks = result.get("structuredPatch").and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result.get("filePath").and_then(Value::as_str).unwrap_or("");
    let mut diff = format!("--- {path}\n+++ {path}\n");
    let mut added = 0i64;
    let mut removed = 0i64;
    for hunk in hunks {
        let old_start = hunk.get("oldStart").and_then(Value::as_i64).unwrap_or(0);
        let old_lines = hunk.get("oldLines").and_then(Value::as_i64).unwrap_or(0);
        let new_start = hunk.get("newStart").and_then(Value::as_i64).unwrap_or(0);
        let new_lines = hunk.get("newLines").and_then(Value::as_i64).unwrap_or(0);
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            let Some(text) = line.as_str() else {
                continue;
            };
            match text.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
            diff.push_str(text);
            diff.push('\n');
        }
    }
    Some((diff, added, removed))
}

fn claude_content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn claude_content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

fn claude_content_image_data_urls(content: &Value) -> Vec<String> {
    let Value::Array(items) = content else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            let source = item.get("source")?;
            if source.get("type").and_then(Value::as_str) != Some("base64") {
                return None;
            }
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let data = source.get("data").and_then(Value::as_str)?;
            if data.is_empty() {
                return None;
            }
            Some(format!("data:{media_type};base64,{data}"))
        })
        .collect()
}

fn claude_tool_result_text(content: &Value) -> Option<Option<(String, String)>> {
    let Value::Array(items) = content else {
        return None;
    };
    let result_item = items
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))?;
    let call_id = result_item.get("tool_use_id")?.as_str()?.to_string();
    let output = match result_item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    Some(Some((call_id, output)))
}

fn claude_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CLAUDE_CODE_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid Claude Code history session id: {session_id}"
        ));
    };
    if file_stem.is_empty() {
        return Err("Claude Code history session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_claude_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLAUDE_CODE, file_stem)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            collect_claude_session_files(&projects_dir, &mut files)?;
        }
    }
    files
        .into_iter()
        .find(|file| file.file_stem == file_stem)
        .map(|file| file.path)
        .ok_or_else(|| format!("Claude Code history file not found for session: {file_stem}"))
}

fn claude_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    let mut dirs = claude_projects_dir_candidates(&home);
    // ORGII-managed sessions run with CLAUDE_CONFIG_DIR redirected into
    // per-account (own-key) or per-session (hosted-key) profile dirs; in
    // native-transcript mode those stores are the transcript of record.
    dirs.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::claude_code_cli_profile_root(),
            &["projects"],
        ),
    );
    Ok(dirs)
}

fn claude_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".claude"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude Code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("claude-code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Claude Code"));
        roots.push(home.join("AppData").join("Roaming").join("claude-code"));
        roots.push(home.join("AppData").join("Roaming").join("Claude"));
        roots.push(home.join("AppData").join("Local").join("Claude Code"));
        roots.push(home.join("AppData").join("Local").join("claude-code"));
        roots.push(home.join("AppData").join("Local").join("Claude"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("claude-code"));
        roots.push(home.join(".local").join("share").join("claude-code"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("projects"))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
