//! Incremental per-round index over a Codex rollout JSONL.
//!
//! The index answers "what rounds exist, when did each run, what did the user
//! ask, what did the agent last say" WITHOUT materializing a single
//! `ActivityChunk`: one bounded streaming scan extracts per-round header
//! fields (bounded previews, timestamps, approximate event counts, modified
//! files) and remembers how far it parsed. A later call on a grown file
//! resumes from `parsed_through` and only reads the appended bytes, so
//! refreshing a live session costs O(appended), not O(file) (#443).
//!
//! Turn ids use the lazy byte-offset scheme (`codex-user-<offset>`) shared
//! with the transcript loader, so any round in the index can be hydrated by
//! the existing turn-window path. The recorded offset prefers an immediately
//! preceding `task_started` line, matching the transcript collector, so
//! hydration replays the lifecycle marker too.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::sources::imported_history;

use super::transcript::{
    codex_lazy_turn_id, codex_line_is_transcript_inert, codex_transcript_file_signature,
    content_text_from_payload, strip_ignored_embedded_images, user_message_from_payload,
    CodexTranscriptSignature,
};

/// Bounded preview length for user messages and last agent messages carried
/// by the skeleton. Full text arrives when the round is hydrated.
pub const CODEX_ROUND_PREVIEW_MAX_BYTES: usize = 8 * 1024;
const CODEX_ROUND_INDEX_CACHE_CAPACITY: usize = 8;
const CODEX_ROUND_INDEX_MAX_ROUNDS: usize = 4_096;
const CODEX_ROUND_MODIFIED_FILES_MAX: usize = 64;
/// Bytes remembered from just before `parsed_through`; on resume they are
/// re-read and compared so truncation/replacement forces a full rebuild.
const CODEX_ROUND_TAIL_PROBE_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct CodexRoundSummary {
    /// `codex-user-<turn_start_offset>` — hydratable via the turn window.
    pub turn_id: String,
    pub turn_start_offset: u64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    /// `completed`, `interrupted`, or `active` (only ever the last round).
    pub status: String,
    pub user_preview: String,
    pub last_agent_message: Option<String>,
    pub last_agent_message_at: Option<String>,
    /// Approximate: counts transcript-contributing lines, which tracks (but
    /// does not exactly equal) the hydrated chunk count.
    pub event_count: usize,
    pub body_event_count: usize,
    pub modified_files: Vec<String>,
}

/// Observability for each index request (#443 acceptance: refresh cost must
/// be visible and proportional to appended bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexRoundIndexStats {
    pub bytes_scanned: u64,
    pub scan_start_offset: u64,
    pub rebuilt: bool,
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Default)]
struct OpenRound {
    turn_start_offset: u64,
    started_at: String,
    user_preview: String,
    last_agent_message: Option<String>,
    last_agent_message_at: Option<String>,
    last_event_at: Option<String>,
    event_count: usize,
    saw_task_complete: bool,
    saw_turn_aborted: bool,
    modified_files: Vec<String>,
}

#[derive(Debug, Clone)]
struct CodexRoundIndexState {
    signature: CodexTranscriptSignature,
    parsed_through: u64,
    tail_probe: Vec<u8>,
    rounds: VecDeque<CodexRoundSummary>,
    open_round: Option<OpenRound>,
    /// (byte offset, created_at) of a `task_started` line waiting for its
    /// `user_message`, mirroring the transcript collector's pairing.
    pending_task_started: Option<(u64, String)>,
}

struct CacheEntry {
    path: PathBuf,
    state: CodexRoundIndexState,
}

fn codex_round_index_cache() -> &'static Mutex<VecDeque<CacheEntry>> {
    static CACHE: OnceLock<Mutex<VecDeque<CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

#[derive(serde::Deserialize)]
struct RoundIndexLineProbe<'a> {
    #[serde(default, borrow)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    payload: Option<&'a serde_json::value::RawValue>,
}

#[derive(serde::Deserialize)]
struct RoundIndexPayloadProbe<'a> {
    #[serde(default, rename = "type", borrow)]
    payload_type: Option<Cow<'a, str>>,
}

/// Truncate on a char boundary; appends nothing (previews are raw prefixes).
fn bounded_preview(text: &str) -> String {
    if text.len() <= CODEX_ROUND_PREVIEW_MAX_BYTES {
        return text.to_string();
    }
    let mut end = CODEX_ROUND_PREVIEW_MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn close_round(open: OpenRound, forced_status: Option<&str>) -> CodexRoundSummary {
    let ended_at = open
        .last_event_at
        .clone()
        .or_else(|| Some(open.started_at.clone()));
    let duration_ms = match (
        timestamp_ms(&open.started_at),
        ended_at.as_deref().and_then(timestamp_ms),
    ) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    };
    let status = forced_status
        .map(str::to_string)
        .unwrap_or_else(|| {
            if open.saw_turn_aborted {
                "interrupted".to_string()
            } else {
                "completed".to_string()
            }
        });
    CodexRoundSummary {
        turn_id: codex_lazy_turn_id(open.turn_start_offset),
        turn_start_offset: open.turn_start_offset,
        started_at: open.started_at,
        ended_at,
        duration_ms,
        status,
        user_preview: open.user_preview,
        last_agent_message: open.last_agent_message,
        last_agent_message_at: open.last_agent_message_at,
        event_count: open.event_count,
        body_event_count: open.event_count.saturating_sub(1),
        modified_files: open.modified_files,
    }
}

/// The open round rendered as a summary without consuming the scan state.
fn open_round_summary(open: &OpenRound) -> CodexRoundSummary {
    let status = if open.saw_turn_aborted {
        "interrupted"
    } else if open.saw_task_complete {
        "completed"
    } else {
        "active"
    };
    close_round(open.clone(), Some(status))
}

fn record_modified_files(open: &mut OpenRound, payload: &Value) {
    let Some(changes) = payload.get("changes").and_then(Value::as_object) else {
        return;
    };
    for path in changes.keys() {
        if open.modified_files.len() >= CODEX_ROUND_MODIFIED_FILES_MAX {
            return;
        }
        if !open.modified_files.iter().any(|known| known == path) {
            open.modified_files.push(path.clone());
        }
    }
}

/// Payload types that materialize roughly one chunk each in the hydrated
/// transcript. Tool *calls* are excluded — their chunks appear at output
/// resolution time, so outputs are what we count.
fn payload_type_counts_as_event(payload_type: &str) -> bool {
    matches!(
        payload_type,
        "agent_message"
            | "message"
            | "reasoning"
            | "agent_reasoning"
            | "function_call_output"
            | "custom_tool_call_output"
            | "task_complete"
            | "turn_aborted"
    )
}

/// Types whose payload must be fully parsed (text or file extraction).
fn payload_type_needs_value(payload_type: &str) -> bool {
    matches!(
        payload_type,
        "user_message" | "agent_message" | "message" | "patch_apply_end"
    )
}

fn scan_rounds(
    state: &mut CodexRoundIndexState,
    path: &Path,
    start_offset: u64,
) -> Result<u64, String> {
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset)).map_err(|err| {
            format!(
                "Failed to seek Codex history {} to {start_offset}: {err}",
                path.display()
            )
        })?;
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut next_offset = start_offset;
    let mut bytes_scanned = 0u64;

    loop {
        line.clear();
        let line_start = next_offset;
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        if bytes_read == 0 {
            break;
        }
        // A partially written trailing line (no newline yet) is left for the
        // next refresh: parsed_through stays at the line start so the line is
        // re-read once complete.
        if !line.ends_with('\n') {
            break;
        }
        next_offset = next_offset.saturating_add(bytes_read as u64);
        bytes_scanned = bytes_scanned.saturating_add(bytes_read as u64);
        update_tail_probe(&mut state.tail_probe, line.as_bytes());

        let trimmed = line.trim();
        if trimmed.is_empty() || codex_line_is_transcript_inert(trimmed) {
            continue;
        }

        // Borrowed probe: outer timestamp plus payload span, then payload
        // type, without materializing payload trees for the common case.
        let Ok(probe) = serde_json::from_str::<RoundIndexLineProbe>(trimmed) else {
            continue;
        };
        let created_at = probe
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at);
        let Some(payload_raw) = probe.payload else {
            continue;
        };
        let Ok(payload_probe) = serde_json::from_str::<RoundIndexPayloadProbe>(payload_raw.get())
        else {
            continue;
        };
        let Some(payload_type) = payload_probe.payload_type.as_deref().map(str::to_string) else {
            continue;
        };
        let created_at =
            created_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        if payload_type == "task_started" {
            state.pending_task_started = Some((line_start, created_at));
            continue;
        }

        // Payload parse only where field extraction is required.
        let payload_value: Option<Value> = if payload_type_needs_value(&payload_type) {
            let mut owned_line = trimmed.to_string();
            strip_ignored_embedded_images(&mut owned_line);
            serde_json::from_str::<Value>(&owned_line)
                .ok()
                .and_then(|outer| outer.get("payload").cloned())
        } else {
            None
        };

        if payload_type == "user_message" {
            let message = payload_value
                .as_ref()
                .and_then(user_message_from_payload)
                .unwrap_or_default();
            if message.is_empty() {
                state.pending_task_started = None;
                continue;
            }
            if let Some(open) = state.open_round.take() {
                push_round(&mut state.rounds, close_round(open, None));
            }
            let (turn_start_offset, lifecycle_events) = match state.pending_task_started.take() {
                Some((offset, _)) => (offset, 1usize),
                None => (line_start, 0usize),
            };
            let stripped = imported_history::strip_internal_context_blocks(&message);
            state.open_round = Some(OpenRound {
                turn_start_offset,
                started_at: created_at.clone(),
                user_preview: bounded_preview(stripped),
                last_agent_message: None,
                last_agent_message_at: None,
                last_event_at: Some(created_at),
                event_count: 1 + lifecycle_events,
                saw_task_complete: false,
                saw_turn_aborted: false,
                modified_files: Vec::new(),
            });
            continue;
        }

        let Some(open) = state.open_round.as_mut() else {
            continue;
        };

        // `contributes` decides both the event count and the round-end
        // timestamp. A `turn_context`/settings line written when the user
        // reopens the session days later — or the next prompt's
        // `response_item message role=user` replay echo — must not stretch
        // the previous round's duration.
        let mut contributes = payload_type_counts_as_event(&payload_type);
        match payload_type.as_str() {
            "agent_message" => {
                if let Some(message) = payload_value
                    .as_ref()
                    .and_then(|payload| payload.get("message"))
                    .and_then(Value::as_str)
                {
                    open.last_agent_message = Some(bounded_preview(message));
                    open.last_agent_message_at = Some(created_at.clone());
                }
            }
            "message" => {
                let is_assistant = payload_value
                    .as_ref()
                    .and_then(|payload| payload.get("role"))
                    .and_then(Value::as_str)
                    == Some("assistant");
                if is_assistant {
                    if let Some(text) = payload_value.as_ref().and_then(content_text_from_payload)
                    {
                        open.last_agent_message = Some(bounded_preview(&text));
                        open.last_agent_message_at = Some(created_at.clone());
                    }
                } else {
                    // Non-assistant `message` lines (user prompt echoes) do
                    // not produce chunks and do not extend the round.
                    contributes = false;
                }
            }
            "patch_apply_end" => {
                if let Some(payload) = payload_value.as_ref() {
                    record_modified_files(open, payload);
                }
                // Agent work: moves the end time, but materializes no chunk.
                open.last_event_at = Some(created_at.clone());
            }
            "task_complete" => {
                open.saw_task_complete = true;
            }
            "turn_aborted" => {
                open.saw_turn_aborted = true;
            }
            _ => {}
        }

        if contributes {
            open.event_count = open.event_count.saturating_add(1);
            open.last_event_at = Some(created_at.clone());
        }
    }

    state.parsed_through = next_offset;
    Ok(bytes_scanned)
}

fn push_round(rounds: &mut VecDeque<CodexRoundSummary>, round: CodexRoundSummary) {
    if rounds.len() >= CODEX_ROUND_INDEX_MAX_ROUNDS {
        rounds.pop_front();
    }
    rounds.push_back(round);
}

fn update_tail_probe(probe: &mut Vec<u8>, line: &[u8]) {
    if line.len() >= CODEX_ROUND_TAIL_PROBE_BYTES {
        probe.clear();
        probe.extend_from_slice(&line[line.len() - CODEX_ROUND_TAIL_PROBE_BYTES..]);
        return;
    }
    let keep = CODEX_ROUND_TAIL_PROBE_BYTES.saturating_sub(line.len());
    if probe.len() > keep {
        probe.drain(..probe.len() - keep);
    }
    probe.extend_from_slice(line);
}

/// Verify the remembered tail bytes still sit right before `parsed_through`.
/// A mismatch means truncation or replacement — rebuild from scratch.
fn tail_probe_matches(path: &Path, parsed_through: u64, probe: &[u8]) -> bool {
    if probe.is_empty() || parsed_through == 0 {
        return parsed_through == 0;
    }
    let probe_len = probe.len().min(usize::try_from(parsed_through).unwrap_or(usize::MAX));
    let start = parsed_through - probe_len as u64;
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut current = vec![0u8; probe_len];
    if file.read_exact(&mut current).is_err() {
        return false;
    }
    current == probe[probe.len() - probe_len..]
}

fn fresh_state(signature: CodexTranscriptSignature) -> CodexRoundIndexState {
    CodexRoundIndexState {
        signature,
        parsed_through: 0,
        tail_probe: Vec::new(),
        rounds: VecDeque::new(),
        open_round: None,
        pending_task_started: None,
    }
}

fn state_to_rounds(state: &CodexRoundIndexState) -> Vec<CodexRoundSummary> {
    let mut rounds: Vec<CodexRoundSummary> = state.rounds.iter().cloned().collect();
    if let Some(open) = state.open_round.as_ref() {
        rounds.push(open_round_summary(open));
    }
    rounds
}

/// Build or incrementally extend the round index for a rollout file.
///
/// Fast paths: unchanged signature returns the cached rounds without touching
/// the file body; a grown file whose tail probe matches is scanned only from
/// `parsed_through`. Anything else (shrunk, replaced, first sight) is a full
/// rebuild — still one bounded streaming pass with no chunk materialization.
pub fn load_codex_round_index(
    path: &Path,
) -> Result<(Vec<CodexRoundSummary>, CodexRoundIndexStats), String> {
    let signature_now = codex_transcript_file_signature(path)?;

    let cached_state = {
        let mut cache = codex_round_index_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let position = cache.iter().position(|entry| entry.path == path);
        position.and_then(|index| cache.remove(index)).map(|entry| entry.state)
    };

    let (mut state, scan_start, rebuilt, cache_hit) = match cached_state {
        Some(state) if state.signature == signature_now => {
            let rounds = state_to_rounds(&state);
            let stats = CodexRoundIndexStats {
                bytes_scanned: 0,
                scan_start_offset: state.parsed_through,
                rebuilt: false,
                cache_hit: true,
            };
            remember_state(path, state);
            return Ok((rounds, stats));
        }
        Some(state)
            if signature_now.size_bytes >= state.parsed_through
                && tail_probe_matches(path, state.parsed_through, &state.tail_probe) =>
        {
            let start = state.parsed_through;
            (state, start, false, true)
        }
        _ => (fresh_state(signature_now), 0, true, false),
    };

    let bytes_scanned = scan_rounds(&mut state, path, scan_start)?;
    // Stat after the scan: if the file grew while we read, the next call
    // extends again from the recorded parsed_through.
    state.signature = codex_transcript_file_signature(path)?;
    let stats = CodexRoundIndexStats {
        bytes_scanned,
        scan_start_offset: scan_start,
        rebuilt,
        cache_hit,
    };
    let rounds = state_to_rounds(&state);
    remember_state(path, state);
    Ok((rounds, stats))
}

fn remember_state(path: &Path, state: CodexRoundIndexState) {
    let mut cache = codex_round_index_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = cache.iter().position(|entry| entry.path == path) {
        cache.remove(index);
    }
    cache.push_back(CacheEntry {
        path: path.to_path_buf(),
        state,
    });
    while cache.len() > CODEX_ROUND_INDEX_CACHE_CAPACITY {
        cache.pop_front();
    }
}
