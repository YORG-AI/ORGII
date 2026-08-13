//! Transcript loading and tool-call chunk assembly.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use core_types::activity::ActivityChunk;
use memchr::{memchr_iter, memmem};
use serde::Serialize;
use serde_json::{json, Value};

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};
use crate::sources::imported_history::{self, strip_orgii_exec_mode_bridge, ImportedToolCall};

use super::desktop_exec::{
    codex_tool_exit_code, codex_tool_output_failed, codex_tool_output_text,
    normalize_codex_exec_tool_calls,
};
use super::normalize::{
    normalize_codex_tool_calls, normalize_tool_name_key, normalize_web_search_args,
};
use super::CodexJsonlLine;

const CODEX_PROVIDER_SLUG: &str = "codex";
const CODEX_EMBEDDED_IMAGE_MARKER: &str = "\"image_url\":\"data:image/";
const CODEX_OMITTED_IMAGE_VALUE: &str = "[embedded image omitted]";
const CODEX_TURN_OFFSET_CACHE_CAPACITY: usize = 8;
const CODEX_TURN_OFFSET_LIMIT_PER_SESSION: usize = 4_096;
const CODEX_INITIAL_TURN_LIMIT: usize = 4_096;
const CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES: usize = 512;
const CODEX_REVERSE_SCAN_BLOCK_BYTES: usize = 1024 * 1024;
const CODEX_REVERSE_SCAN_MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const CODEX_TURN_HEADER_PROBE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CodexTranscriptSignature {
    modified_ns: u128,
    size_bytes: u64,
}

#[derive(Debug, Clone)]
struct CodexTurnOffset {
    turn_id: String,
    byte_offset: u64,
    sequence: usize,
}

#[derive(Debug, Clone)]
struct CodexTurnCatalogEntry {
    byte_offset: u64,
    started_at: String,
    user_preview: String,
    last_agent_preview: Option<String>,
    following_line_count: usize,
}

#[derive(Debug)]
struct CodexTurnOffsetCacheEntry {
    path: PathBuf,
    signature: CodexTranscriptSignature,
    turns: HashMap<String, (u64, usize)>,
}

#[derive(Debug, Default)]
struct CodexTurnOffsetCache {
    entries: VecDeque<CodexTurnOffsetCacheEntry>,
}

impl CodexTurnOffsetCache {
    fn get(
        &mut self,
        path: &Path,
        signature: CodexTranscriptSignature,
        turn_id: &str,
    ) -> Option<(u64, usize)> {
        let index = self.entries.iter().position(|entry| entry.path == path)?;
        let entry = self.entries.remove(index)?;
        if entry.signature != signature {
            return None;
        }
        let offset = entry.turns.get(turn_id).copied();
        self.entries.push_back(entry);
        offset
    }

    fn insert(
        &mut self,
        path: PathBuf,
        signature: CodexTranscriptSignature,
        offsets: Vec<CodexTurnOffset>,
    ) {
        if let Some(index) = self.entries.iter().position(|entry| entry.path == path) {
            self.entries.remove(index);
        }
        let turns = offsets
            .into_iter()
            .rev()
            .take(CODEX_TURN_OFFSET_LIMIT_PER_SESSION)
            .map(|offset| (offset.turn_id, (offset.byte_offset, offset.sequence)))
            .collect();
        self.entries.push_back(CodexTurnOffsetCacheEntry {
            path,
            signature,
            turns,
        });
        while self.entries.len() > CODEX_TURN_OFFSET_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

fn codex_turn_offset_cache() -> &'static Mutex<CodexTurnOffsetCache> {
    static CACHE: OnceLock<Mutex<CodexTurnOffsetCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CodexTurnOffsetCache::default()))
}

#[derive(Debug)]
struct CodexTurnCatalogCacheEntry {
    path: PathBuf,
    signature: CodexTranscriptSignature,
    entries: Vec<CodexTurnCatalogEntry>,
}

#[derive(Debug, Default)]
struct CodexTurnCatalogCache {
    entries: VecDeque<CodexTurnCatalogCacheEntry>,
}

impl CodexTurnCatalogCache {
    fn exact(
        &mut self,
        path: &Path,
        signature: CodexTranscriptSignature,
    ) -> Option<Vec<CodexTurnCatalogEntry>> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.path == path && entry.signature == signature)?;
        let entry = self.entries.remove(index)?;
        let catalog = entry.entries.clone();
        self.entries.push_back(entry);
        Some(catalog)
    }

    fn latest_for_path(
        &self,
        path: &Path,
    ) -> Option<(CodexTranscriptSignature, Vec<CodexTurnCatalogEntry>)> {
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.path == path)
            .map(|entry| (entry.signature, entry.entries.clone()))
    }

    fn insert(
        &mut self,
        path: PathBuf,
        signature: CodexTranscriptSignature,
        entries: Vec<CodexTurnCatalogEntry>,
    ) {
        if let Some(index) = self.entries.iter().position(|entry| entry.path == path) {
            self.entries.remove(index);
        }
        self.entries.push_back(CodexTurnCatalogCacheEntry {
            path,
            signature,
            entries,
        });
        while self.entries.len() > CODEX_TURN_OFFSET_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

fn codex_turn_catalog_cache() -> &'static Mutex<CodexTurnCatalogCache> {
    static CACHE: OnceLock<Mutex<CodexTurnCatalogCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CodexTurnCatalogCache::default()))
}

fn codex_transcript_file_signature(path: &Path) -> Result<CodexTranscriptSignature, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("Failed to stat Codex history {}: {err}", path.display()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Ok(CodexTranscriptSignature {
        modified_ns,
        size_bytes: metadata.len(),
    })
}

fn bounded_codex_turn_preview(message: &str) -> String {
    if message.len() <= CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES {
        return message.to_string();
    }
    let mut cut = CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES;
    while !message.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &message[..cut])
}

fn remember_codex_turn_offsets(
    path: &Path,
    signature_before: CodexTranscriptSignature,
    offsets: Vec<CodexTurnOffset>,
) -> Result<(), String> {
    let signature_after = codex_transcript_file_signature(path)?;
    if signature_before == signature_after {
        codex_turn_offset_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path.to_path_buf(), signature_after, offsets);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppInitialWindow {
    pub chunks: Vec<ActivityChunk>,
    #[serde(skip_serializing)]
    pub turns: Vec<ProjectedTurnMetadata>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTurnWindow {
    pub chunks: Vec<ActivityChunk>,
    pub turn_id: String,
    pub loaded_event_count: usize,
}

enum CodexTranscriptCollectionMode<'a> {
    Full,
    Initial { recent_turn_count: usize },
    Turn { turn_id: &'a str },
    FirstTurn,
}

struct CompletedCodexTurn {
    chunks: Vec<ActivityChunk>,
    summary: ProjectedTurnMetadata,
    next_turn_id: Option<String>,
}

struct CodexTranscriptCollector<'a> {
    session_id: &'a str,
    mode: CodexTranscriptCollectionMode<'a>,
    output: Vec<ActivityChunk>,
    current: Vec<ActivityChunk>,
    compacted: VecDeque<Vec<ActivityChunk>>,
    recent: VecDeque<CompletedCodexTurn>,
    turns: VecDeque<ProjectedTurnMetadata>,
    turn_offsets: VecDeque<CodexTurnOffset>,
    selected_turn_found: bool,
}

impl<'a> CodexTranscriptCollector<'a> {
    fn new(session_id: &'a str, mode: CodexTranscriptCollectionMode<'a>) -> Self {
        Self {
            session_id,
            mode,
            output: Vec::new(),
            current: Vec::new(),
            compacted: VecDeque::new(),
            recent: VecDeque::new(),
            turns: VecDeque::new(),
            turn_offsets: VecDeque::new(),
            selected_turn_found: false,
        }
    }

    fn record_turn_offset(&mut self, turn_id: String, byte_offset: u64, sequence: usize) {
        if self.turn_offsets.len() >= CODEX_TURN_OFFSET_LIMIT_PER_SESSION {
            self.turn_offsets.pop_front();
        }
        self.turn_offsets.push_back(CodexTurnOffset {
            turn_id,
            byte_offset,
            sequence,
        });
    }

    fn start_turn(&mut self, user_chunk: ActivityChunk) -> bool {
        if self.current.iter().any(is_codex_user_chunk) {
            self.finish_current(Some(user_chunk.chunk_id.clone()));
            if self.selected_turn_found {
                return true;
            }
        }
        self.current.push(user_chunk);
        false
    }

    fn finish_current(&mut self, next_turn_id: Option<String>) {
        let Some(user_chunk) = self.current.iter().find(|chunk| is_codex_user_chunk(chunk)) else {
            if matches!(self.mode, CodexTranscriptCollectionMode::Full) {
                self.output.append(&mut self.current);
            }
            return;
        };
        let turn_id = user_chunk.chunk_id.clone();
        match &self.mode {
            CodexTranscriptCollectionMode::Full => {
                self.output.append(&mut self.current);
                return;
            }
            CodexTranscriptCollectionMode::Turn {
                turn_id: requested_turn_id,
            } => {
                if turn_id == *requested_turn_id {
                    self.output.append(&mut self.current);
                    self.selected_turn_found = true;
                } else {
                    self.current.clear();
                }
                return;
            }
            CodexTranscriptCollectionMode::FirstTurn => {
                self.output.append(&mut self.current);
                self.selected_turn_found = true;
                return;
            }
            CodexTranscriptCollectionMode::Initial { .. } => {}
        }

        let mut summary = project_activity_chunks(&self.current)
            .into_iter()
            .next()
            .unwrap_or_else(|| ProjectedTurnMetadata {
                turn_id: turn_id.clone(),
                start_sequence: codex_sequence_from_chunk_id(&turn_id).unwrap_or_default(),
                started_at: user_chunk.created_at.clone(),
                ended_at: Some(user_chunk.created_at.clone()),
                status: "completed".to_string(),
                user_preview: String::new(),
                event_count: 1,
                body_event_count: 0,
                modified_files: Vec::new(),
                resource_interactions: Vec::new(),
                git_artifacts: Vec::new(),
            });
        if let Some(sequence) = codex_sequence_from_chunk_id(&turn_id) {
            summary.start_sequence = sequence;
        }

        let CodexTranscriptCollectionMode::Initial { recent_turn_count } = &self.mode else {
            unreachable!("full and selected-turn modes returned above");
        };
        let recent_turn_count = (*recent_turn_count).clamp(1, CODEX_INITIAL_TURN_LIMIT);
        if self.turns.len() >= CODEX_INITIAL_TURN_LIMIT {
            self.turns.pop_front();
        }
        self.turns.push_back(summary.clone());
        self.recent.push_back(CompletedCodexTurn {
            chunks: std::mem::take(&mut self.current),
            summary,
            next_turn_id,
        });
        while self.recent.len() > recent_turn_count {
            if let Some(completed) = self.recent.pop_front() {
                self.compact_completed_turn(completed);
            }
        }
    }

    fn compact_completed_turn(&mut self, completed: CompletedCodexTurn) {
        let last_agent_preview = last_assistant_preview_from_chunks(&completed.chunks);
        if let Some(user_chunk) = completed.chunks.into_iter().find(is_codex_user_chunk) {
            let compacted_limit = match &self.mode {
                CodexTranscriptCollectionMode::Initial { recent_turn_count } => {
                    CODEX_INITIAL_TURN_LIMIT
                        .saturating_sub((*recent_turn_count).clamp(1, CODEX_INITIAL_TURN_LIMIT))
                }
                _ => 0,
            };
            if compacted_limit == 0 {
                return;
            }
            if self.compacted.len() >= compacted_limit {
                self.compacted.pop_front();
            }
            self.compacted.push_back(vec![
                user_chunk,
                build_unloaded_turn_placeholder_chunk(
                    self.session_id,
                    &completed.summary,
                    completed.next_turn_id,
                    last_agent_preview.as_deref(),
                ),
            ]);
        }
    }

    fn finish(
        mut self,
    ) -> (
        Vec<ActivityChunk>,
        Vec<ProjectedTurnMetadata>,
        Vec<CodexTurnOffset>,
    ) {
        self.finish_current(None);
        while let Some(compacted) = self.compacted.pop_front() {
            self.output.extend(compacted);
        }
        while let Some(completed) = self.recent.pop_front() {
            self.output.extend(completed.chunks);
        }
        (
            self.output,
            self.turns.into_iter().collect(),
            self.turn_offsets.into_iter().collect(),
        )
    }
}

fn is_codex_user_chunk(chunk: &ActivityChunk) -> bool {
    chunk.function == imported_history::FUNCTION_USER_MESSAGE
}

fn last_assistant_preview_from_chunks(chunks: &[ActivityChunk]) -> Option<String> {
    chunks.iter().rev().find_map(|chunk| {
        if chunk.function != imported_history::FUNCTION_ASSISTANT {
            return None;
        }
        chunk
            .result
            .get("observation")
            .or_else(|| chunk.result.get("content"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(bounded_codex_turn_preview)
    })
}

fn codex_sequence_from_chunk_id(chunk_id: &str) -> Option<i64> {
    chunk_id.rsplit('-').next()?.parse().ok()
}

fn build_unloaded_turn_placeholder_chunk(
    session_id: &str,
    turn: &ProjectedTurnMetadata,
    next_turn_id: Option<String>,
    last_agent_preview: Option<&str>,
) -> ActivityChunk {
    let internal_placeholder = format!("Codex turn {} is not loaded yet.", turn.turn_id);
    let display_content = last_agent_preview.unwrap_or(&internal_placeholder);
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("codex-unloaded-turn-{}", turn.turn_id);
    chunk.created_at = turn
        .ended_at
        .clone()
        .unwrap_or_else(|| turn.started_at.clone());
    if last_agent_preview.is_some() {
        chunk.args = json!({ "turnPreviewOnly": true });
    }
    chunk.result = json!({
        "observation": display_content,
        "content": display_content,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
        "unloadedTurn": {
            "turnId": turn.turn_id,
            "nextTurnId": next_turn_id,
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "durationMs": Value::Null,
            "eventCount": turn.event_count,
            "bodyEventCount": turn.body_event_count,
        },
    });
    chunk
}

/// Codex can repeat a screenshot's base64 payload in thousands of tool-output
/// rows. The replay projection only consumes each output part's text field, so
/// deserializing the image bytes into `serde_json::Value` is pure allocation
/// churn. Remove the ignored payload in-place before JSON parsing while
/// preserving the surrounding output array and text parts.
pub(crate) fn strip_ignored_embedded_images(line: &mut String) {
    let mut search_from = 0usize;
    while let Some(relative_marker) = line[search_from..].find(CODEX_EMBEDDED_IMAGE_MARKER) {
        let marker_start = search_from + relative_marker;
        let value_start = marker_start + "\"image_url\":\"".len();
        let Some(relative_end) = line[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + relative_end;
        line.replace_range(value_start..value_end, CODEX_OMITTED_IMAGE_VALUE);
        search_from = value_start + CODEX_OMITTED_IMAGE_VALUE.len();
    }
}

struct PendingBackgroundToolCall {
    calls: Vec<ImportedToolCall>,
    latest_output: String,
}

#[derive(Debug)]
struct CodexExecResult {
    output: String,
    session_id: Option<String>,
    exit_code: Option<i64>,
}

pub fn load_codex_app_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let signature_before = codex_transcript_file_signature(path)?;
    let (chunks, _, offsets) = load_codex_app_from_path_with_mode(
        session_id,
        path,
        CodexTranscriptCollectionMode::Full,
        0,
        0,
    )?;
    remember_codex_turn_offsets(path, signature_before, offsets)?;
    Ok(chunks)
}

pub(crate) fn load_codex_app_turn_ids_from_path(path: &Path) -> Result<Vec<String>, String> {
    let signature = codex_transcript_file_signature(path)?;
    let mut catalog = load_codex_turn_catalog(path, signature)?;
    catalog.sort_unstable_by_key(|entry| entry.byte_offset);
    Ok(catalog
        .into_iter()
        .map(|entry| codex_lazy_turn_id(entry.byte_offset))
        .collect())
}

pub fn load_codex_app_initial_window_from_path(
    session_id: &str,
    path: &Path,
    recent_turn_count: usize,
) -> Result<CodexAppInitialWindow, String> {
    let signature_before = codex_transcript_file_signature(path)?;
    let recent_turn_count = recent_turn_count.clamp(1, CODEX_INITIAL_TURN_LIMIT);
    let turn_catalog = load_codex_turn_catalog(path, signature_before)?;
    if !turn_catalog.is_empty() {
        let window =
            load_codex_app_initial_tail_window(session_id, path, recent_turn_count, &turn_catalog)?;
        let offsets = turn_catalog
            .iter()
            .map(|entry| CodexTurnOffset {
                turn_id: codex_lazy_turn_id(entry.byte_offset),
                byte_offset: entry.byte_offset,
                sequence: codex_lazy_turn_sequence(entry.byte_offset),
            })
            .collect();
        remember_codex_turn_offsets(path, signature_before, offsets)?;
        return Ok(window);
    }

    // Metadata-only or partially written rollouts may not contain any user
    // messages. Preserve the compatibility parser for those files; normal
    // rollouts take the tail-window path above and never scan old turn bodies.
    let (chunks, turns, offsets) = load_codex_app_from_path_with_mode(
        session_id,
        path,
        CodexTranscriptCollectionMode::Initial { recent_turn_count },
        0,
        0,
    )?;
    remember_codex_turn_offsets(path, signature_before, offsets)?;
    Ok(CodexAppInitialWindow { chunks, turns })
}

pub fn load_codex_app_turn_from_path(
    session_id: &str,
    path: &Path,
    turn_id: &str,
) -> Result<CodexAppTurnWindow, String> {
    let signature = codex_transcript_file_signature(path)?;
    let (start_offset, initial_sequence) = codex_turn_offset_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path, signature, turn_id)
        .or_else(|| {
            codex_lazy_turn_offset(turn_id).map(|offset| (offset, codex_lazy_turn_sequence(offset)))
        })
        .unwrap_or((0, 0));
    let (selected_chunks, _, _) = load_codex_app_from_path_with_mode(
        session_id,
        path,
        CodexTranscriptCollectionMode::Turn { turn_id },
        start_offset,
        initial_sequence,
    )?;
    let loaded_event_count = selected_chunks.len();
    let mut chunks = Vec::new();
    let mut remembered_offsets = vec![CodexTurnOffset {
        turn_id: turn_id.to_string(),
        byte_offset: start_offset,
        sequence: initial_sequence,
    }];
    if start_offset > 0 {
        if let Some(previous_entry) = find_recent_codex_user_offsets(path, start_offset, 1)?
            .into_iter()
            .next()
        {
            let previous_offset = previous_entry.byte_offset;
            if let Some((previous_user, mut previous_summary)) =
                load_codex_turn_header(session_id, path, previous_offset)?
            {
                // The context placeholder spans up to the loaded turn's
                // start. The header-only summary carries ended_at ==
                // started_at, and that created_at tie flips the placeholder
                // before its own header in chat sorting.
                if let Some(loaded_turn_start) = selected_chunks
                    .first()
                    .map(|chunk| chunk.created_at.clone())
                {
                    previous_summary.ended_at = Some(loaded_turn_start);
                }
                chunks.push(previous_user);
                chunks.push(build_unloaded_turn_placeholder_chunk(
                    session_id,
                    &previous_summary,
                    Some(turn_id.to_string()),
                    previous_entry.last_agent_preview.as_deref(),
                ));
                remembered_offsets.push(CodexTurnOffset {
                    turn_id: previous_summary.turn_id,
                    byte_offset: previous_offset,
                    sequence: codex_lazy_turn_sequence(previous_offset),
                });
            }
        }
    }
    chunks.extend(selected_chunks);
    remember_codex_turn_offsets(path, signature, remembered_offsets)?;
    Ok(CodexAppTurnWindow {
        chunks,
        turn_id: turn_id.to_string(),
        loaded_event_count,
    })
}

pub(crate) fn load_codex_app_cloud_turn_from_path(
    session_id: &str,
    path: &Path,
    turn_id: &str,
    start_sequence: usize,
) -> Result<Vec<ActivityChunk>, String> {
    // Error like the Claude reader does: an unparseable id means the caller's
    // checkpoint is stale or corrupt, and the frontend maps a reader error to
    // the authoritative full path. A silent empty window would instead be
    // indistinguishable from a legitimately empty turn.
    let Some(user_offset) = codex_lazy_turn_offset(turn_id) else {
        return Err(format!("Invalid Codex cloud turn id: {turn_id}"));
    };
    let start_offset = codex_cloud_turn_start_offset(path, user_offset)?;
    let (chunks, _, _) = load_codex_app_from_path_with_mode(
        session_id,
        path,
        CodexTranscriptCollectionMode::FirstTurn,
        start_offset,
        start_sequence,
    )?;
    Ok(chunks)
}

fn codex_cloud_turn_start_offset(path: &Path, user_offset: u64) -> Result<u64, String> {
    if user_offset == 0 {
        return Ok(0);
    }
    let read_start = user_offset.saturating_sub(CODEX_REVERSE_SCAN_MAX_LINE_BYTES as u64);
    let read_len = usize::try_from(user_offset - read_start).unwrap_or_default();
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(read_start)).map_err(|err| {
        format!(
            "Failed to seek Codex history {} to {read_start}: {err}",
            path.display()
        )
    })?;
    let mut prefix = vec![0u8; read_len];
    file.read_exact(&mut prefix)
        .map_err(|err| format!("Failed to read Codex turn prefix: {err}"))?;
    let mut line_end = prefix.len();
    while line_end > 0 && matches!(prefix[line_end - 1], b'\n' | b'\r') {
        line_end -= 1;
    }
    let line_start = prefix[..line_end]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let Ok(previous) = serde_json::from_slice::<CodexJsonlLine>(&prefix[line_start..line_end])
    else {
        return Ok(user_offset);
    };
    if previous.payload.get("type").and_then(Value::as_str) == Some("task_started") {
        return Ok(read_start.saturating_add(line_start as u64));
    }
    Ok(user_offset)
}

fn codex_lazy_turn_sequence(byte_offset: u64) -> usize {
    usize::try_from(byte_offset).unwrap_or(usize::MAX)
}

fn codex_lazy_turn_id(byte_offset: u64) -> String {
    format!("codex-user-{}", codex_lazy_turn_sequence(byte_offset))
}

fn codex_lazy_turn_offset(turn_id: &str) -> Option<u64> {
    turn_id.strip_prefix("codex-user-")?.parse().ok()
}

fn load_codex_app_initial_tail_window(
    session_id: &str,
    path: &Path,
    recent_turn_count: usize,
    newest_first_catalog: &[CodexTurnCatalogEntry],
) -> Result<CodexAppInitialWindow, String> {
    let mut ascending_catalog = newest_first_catalog.to_vec();
    ascending_catalog.sort_unstable_by_key(|entry| entry.byte_offset);
    let body_start = ascending_catalog.len().saturating_sub(recent_turn_count);
    let mut chunks = Vec::new();
    let mut turns = Vec::new();

    for index in 0..body_start {
        let entry = &ascending_catalog[index];
        let next_turn_id = ascending_catalog
            .get(index + 1)
            .map(|next| codex_lazy_turn_id(next.byte_offset));
        let ended_at = ascending_catalog
            .get(index + 1)
            .map(|next| next.started_at.clone());
        let (user_chunk, summary) = codex_catalog_turn_header(session_id, entry, ended_at);
        chunks.push(user_chunk);
        chunks.push(build_unloaded_turn_placeholder_chunk(
            session_id,
            &summary,
            next_turn_id,
            entry.last_agent_preview.as_deref(),
        ));
        turns.push(summary);
    }

    for entry in ascending_catalog.into_iter().skip(body_start) {
        let turn_id = codex_lazy_turn_id(entry.byte_offset);
        let (turn_chunks, _, _) = load_codex_app_from_path_with_mode(
            session_id,
            path,
            CodexTranscriptCollectionMode::Turn { turn_id: &turn_id },
            entry.byte_offset,
            codex_lazy_turn_sequence(entry.byte_offset),
        )?;
        turns.extend(project_activity_chunks(&turn_chunks));
        chunks.extend(turn_chunks);
    }

    Ok(CodexAppInitialWindow { chunks, turns })
}

fn codex_catalog_turn_header(
    session_id: &str,
    entry: &CodexTurnCatalogEntry,
    ended_at: Option<String>,
) -> (ActivityChunk, ProjectedTurnMetadata) {
    let sequence = codex_lazy_turn_sequence(entry.byte_offset);
    let user_chunk = imported_history::user_message_chunk(
        session_id,
        CODEX_PROVIDER_SLUG,
        sequence,
        &entry.started_at,
        &entry.user_preview,
    );
    let body_event_count = i64::try_from(entry.following_line_count.max(1)).unwrap_or(i64::MAX);
    let summary = ProjectedTurnMetadata {
        turn_id: user_chunk.chunk_id.clone(),
        start_sequence: i64::try_from(sequence).unwrap_or(i64::MAX),
        started_at: entry.started_at.clone(),
        ended_at,
        status: "completed".to_string(),
        user_preview: entry.user_preview.clone(),
        event_count: body_event_count.saturating_add(1),
        body_event_count,
        modified_files: Vec::new(),
        resource_interactions: Vec::new(),
        git_artifacts: Vec::new(),
    };
    (user_chunk, summary)
}

fn load_codex_turn_header(
    session_id: &str,
    path: &Path,
    byte_offset: u64,
) -> Result<Option<(ActivityChunk, ProjectedTurnMetadata)>, String> {
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(byte_offset)).map_err(|err| {
        format!(
            "Failed to seek Codex history {} to {byte_offset}: {err}",
            path.display()
        )
    })?;
    let mut reader = BufReader::new(file);
    let mut scanned_bytes = 0u64;
    let mut line = String::new();
    while scanned_bytes < CODEX_TURN_HEADER_PROBE_BYTES {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|err| format!("Failed to read Codex turn header: {err}"))?;
        if bytes_read == 0 {
            break;
        }
        scanned_bytes = scanned_bytes.saturating_add(bytes_read as u64);
        let parsed: CodexJsonlLine = match serde_json::from_str(line.trim()) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if parsed.payload.get("type").and_then(Value::as_str) != Some("user_message") {
            continue;
        }
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let sequence = codex_lazy_turn_sequence(byte_offset);
        let Some(user_chunk) =
            user_message_chunk_from_payload(session_id, sequence, &created_at, &parsed.payload)
        else {
            continue;
        };
        let user_preview = user_chunk
            .result
            .pointer("/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut summary = project_activity_chunks(std::slice::from_ref(&user_chunk))
            .into_iter()
            .next()
            .unwrap_or_else(|| ProjectedTurnMetadata {
                turn_id: user_chunk.chunk_id.clone(),
                start_sequence: sequence as i64,
                started_at: created_at.clone(),
                ended_at: Some(created_at.clone()),
                status: "completed".to_string(),
                user_preview,
                event_count: 1,
                body_event_count: 0,
                modified_files: Vec::new(),
                resource_interactions: Vec::new(),
                git_artifacts: Vec::new(),
            });
        summary.start_sequence = i64::try_from(sequence).unwrap_or(i64::MAX);
        summary.status = "completed".to_string();
        return Ok(Some((user_chunk, summary)));
    }
    Ok(None)
}

fn load_codex_turn_catalog(
    path: &Path,
    signature: CodexTranscriptSignature,
) -> Result<Vec<CodexTurnCatalogEntry>, String> {
    let previous = {
        let mut cache = codex_turn_catalog_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entries) = cache.exact(path, signature) {
            return Ok(entries);
        }
        cache.latest_for_path(path)
    };

    let entries = if let Some((previous_signature, previous_entries)) = previous {
        if signature.size_bytes > previous_signature.size_bytes {
            // The active Codex writer appends to its rollout. Re-read a bounded
            // overlap so a line that straddled the previous EOF can be
            // completed, then merge by byte offset. This keeps a live 1+ GiB
            // session from rescanning its entire transcript on every refresh.
            let overlap_start = previous_signature
                .size_bytes
                .saturating_sub(CODEX_REVERSE_SCAN_MAX_LINE_BYTES as u64);
            let appended = find_codex_user_offsets_in_range(
                path,
                signature.size_bytes,
                overlap_start,
                CODEX_INITIAL_TURN_LIMIT,
            )?;
            merge_codex_turn_catalog(previous_entries, appended)
        } else {
            // Truncation or an in-place rewrite invalidates byte offsets.
            find_codex_user_offsets_in_range(
                path,
                signature.size_bytes,
                0,
                CODEX_INITIAL_TURN_LIMIT,
            )?
        }
    } else {
        find_codex_user_offsets_in_range(path, signature.size_bytes, 0, CODEX_INITIAL_TURN_LIMIT)?
    };

    codex_turn_catalog_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.to_path_buf(), signature, entries.clone());
    Ok(entries)
}

fn merge_codex_turn_catalog(
    previous: Vec<CodexTurnCatalogEntry>,
    appended: Vec<CodexTurnCatalogEntry>,
) -> Vec<CodexTurnCatalogEntry> {
    let mut by_offset = previous
        .into_iter()
        .map(|entry| (entry.byte_offset, entry))
        .collect::<HashMap<_, _>>();
    for entry in appended {
        by_offset.insert(entry.byte_offset, entry);
    }
    let mut entries = by_offset.into_values().collect::<Vec<_>>();
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.byte_offset));
    entries.truncate(CODEX_INITIAL_TURN_LIMIT);
    entries
}

fn find_recent_codex_user_offsets(
    path: &Path,
    before_exclusive: u64,
    limit: usize,
) -> Result<Vec<CodexTurnCatalogEntry>, String> {
    find_codex_user_offsets_in_range(path, before_exclusive, 0, limit)
}

fn find_codex_user_offsets_in_range(
    path: &Path,
    before_exclusive: u64,
    after_inclusive: u64,
    limit: usize,
) -> Result<Vec<CodexTurnCatalogEntry>, String> {
    if limit == 0 || before_exclusive <= after_inclusive {
        return Ok(Vec::new());
    }
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|err| format!("Failed to stat Codex history {}: {err}", path.display()))?
        .len();
    let mut cursor = before_exclusive.min(file_len);
    let mut suffix = Vec::<u8>::new();
    let mut discarding_oversized_line = false;
    let mut entries = Vec::with_capacity(limit.min(CODEX_INITIAL_TURN_LIMIT));
    let mut lines_since_boundary = 0usize;
    let mut last_agent_preview = None;

    while cursor > after_inclusive && entries.len() < limit {
        let block_start = cursor
            .saturating_sub(CODEX_REVERSE_SCAN_BLOCK_BYTES as u64)
            .max(after_inclusive);
        let block_len = usize::try_from(cursor - block_start).unwrap_or_default();
        file.seek(SeekFrom::Start(block_start)).map_err(|err| {
            format!(
                "Failed to seek Codex history {} to {block_start}: {err}",
                path.display()
            )
        })?;
        let mut combined = vec![0u8; block_len];
        file.read_exact(&mut combined)
            .map_err(|err| format!("Failed to reverse-read Codex history: {err}"))?;
        combined.extend_from_slice(&suffix);
        suffix.clear();

        let mut line_end = combined.len();
        let mut skipped_boundary_fragment = !discarding_oversized_line;
        // Keep the byte-heavy scan in memchr's optimized implementation.
        // The catalog parser itself only visits complete JSONL records.
        for newline_index in memchr_iter(b'\n', &combined).rev() {
            let line_start = newline_index + 1;
            if skipped_boundary_fragment {
                observe_codex_catalog_line(
                    &combined[line_start..line_end],
                    block_start.saturating_add(line_start as u64),
                    &mut entries,
                    limit,
                    &mut lines_since_boundary,
                    &mut last_agent_preview,
                );
            } else {
                skipped_boundary_fragment = true;
                discarding_oversized_line = false;
            }
            if entries.len() >= limit {
                break;
            }
            line_end = newline_index;
        }
        if entries.len() >= limit {
            break;
        }

        let leading_fragment = &combined[..line_end];
        if block_start == after_inclusive {
            if !discarding_oversized_line {
                observe_codex_catalog_line(
                    leading_fragment,
                    block_start,
                    &mut entries,
                    limit,
                    &mut lines_since_boundary,
                    &mut last_agent_preview,
                );
            }
        } else if discarding_oversized_line {
            suffix.clear();
        } else if leading_fragment.len() <= CODEX_REVERSE_SCAN_MAX_LINE_BYTES {
            suffix.extend_from_slice(leading_fragment);
        } else {
            suffix.clear();
            discarding_oversized_line = true;
        }
        cursor = block_start;
    }

    Ok(entries)
}

fn observe_codex_catalog_line(
    line: &[u8],
    byte_offset: u64,
    entries: &mut Vec<CodexTurnCatalogEntry>,
    limit: usize,
    lines_since_boundary: &mut usize,
    last_agent_preview: &mut Option<String>,
) {
    const USER_MESSAGE_NEEDLE: &[u8] = b"\"user_message\"";
    const AGENT_MESSAGE_NEEDLE: &[u8] = b"\"agent_message\"";
    const ASSISTANT_ROLE_NEEDLE: &[u8] = b"\"assistant\"";
    if line.is_empty() {
        return;
    }
    if entries.len() >= limit {
        return;
    }
    if memmem::find(line, USER_MESSAGE_NEEDLE).is_none() {
        if last_agent_preview.is_none()
            && (memmem::find(line, AGENT_MESSAGE_NEEDLE).is_some()
                || memmem::find(line, ASSISTANT_ROLE_NEEDLE).is_some())
        {
            if let Ok(parsed) = serde_json::from_slice::<CodexJsonlLine>(line) {
                let payload_type = parsed.payload.get("type").and_then(Value::as_str);
                let message = match payload_type {
                    Some("agent_message") => parsed
                        .payload
                        .get("message")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    Some("message")
                        if parsed.payload.get("role").and_then(Value::as_str)
                            == Some("assistant") =>
                    {
                        content_text_from_payload(&parsed.payload)
                    }
                    _ => None,
                };
                *last_agent_preview = message
                    .filter(|message| !message.trim().is_empty())
                    .map(|message| bounded_codex_turn_preview(&message));
            }
        }
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    }
    let Ok(parsed) = serde_json::from_slice::<CodexJsonlLine>(line) else {
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    };
    if parsed.payload.get("type").and_then(Value::as_str) != Some("user_message") {
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    }
    let Some(message) = user_message_from_payload(&parsed.payload) else {
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    };
    let started_at = parsed
        .timestamp
        .as_deref()
        .map(imported_history::normalize_created_at)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    entries.push(CodexTurnCatalogEntry {
        byte_offset,
        started_at,
        user_preview: bounded_codex_turn_preview(&message),
        last_agent_preview: last_agent_preview.take(),
        following_line_count: *lines_since_boundary,
    });
    *lines_since_boundary = 0;
}

type CodexTranscriptLoad = (
    Vec<ActivityChunk>,
    Vec<ProjectedTurnMetadata>,
    Vec<CodexTurnOffset>,
);

fn load_codex_app_from_path_with_mode<'a>(
    session_id: &'a str,
    path: &Path,
    mode: CodexTranscriptCollectionMode<'a>,
    start_offset: u64,
    initial_sequence: usize,
) -> Result<CodexTranscriptLoad, String> {
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

    let mut collector = CodexTranscriptCollector::new(session_id, mode);
    let mut pending_tool_calls: imported_history::PendingCallMap<Vec<ImportedToolCall>> =
        imported_history::PendingCallMap::new();
    let mut background_tool_calls: imported_history::PendingCallMap<PendingBackgroundToolCall> =
        imported_history::PendingCallMap::new();
    let mut pending_task_turn_id: Option<String> = None;
    let mut pending_task_turn_offset: Option<u64> = None;
    let mut active_task_turn_id: Option<String> = None;
    let mut sequence = initial_sequence;

    let mut line = String::new();
    let mut next_byte_offset = start_offset;
    loop {
        line.clear();
        let line_start_offset = next_byte_offset;
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        if bytes_read == 0 {
            break;
        }
        next_byte_offset = next_byte_offset.saturating_add(bytes_read as u64);
        strip_ignored_embedded_images(&mut line);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(payload_type) = parsed.payload.get("type").and_then(Value::as_str) else {
            continue;
        };

        match payload_type {
            // Codex writes task_started immediately before its user_message.
            // Hold it until the user chunk exists so the projector can attach
            // the lifecycle marker to the correct conversational turn.
            "task_started" => {
                pending_task_turn_id = parsed
                    .payload
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                pending_task_turn_offset = Some(line_start_offset);
            }
            "user_message" => {
                if let Some(user_chunk) = user_message_chunk_from_payload(
                    session_id,
                    sequence,
                    &created_at,
                    &parsed.payload,
                ) {
                    let user_sequence = sequence;
                    sequence += 1;
                    if collector.start_turn(user_chunk) {
                        break;
                    }
                    collector.record_turn_offset(
                        format!("codex-user-{user_sequence}"),
                        pending_task_turn_offset.take().unwrap_or(line_start_offset),
                        user_sequence,
                    );
                    if let Some(turn_id) = pending_task_turn_id.take() {
                        collector
                            .current
                            .push(imported_history::task_lifecycle_chunk(
                                session_id,
                                CODEX_PROVIDER_SLUG,
                                sequence,
                                &created_at,
                                imported_history::ACTION_TYPE_TASK_START,
                                &turn_id,
                            ));
                        sequence += 1;
                        active_task_turn_id = Some(turn_id);
                    }
                }
            }
            "agent_message" => {
                if let Some(message) = parsed.payload.get("message").and_then(Value::as_str) {
                    collector
                        .current
                        .push(imported_history::assistant_message_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            message,
                        ));
                    sequence += 1;
                }
            }
            "message" => {
                if parsed.payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(text) = content_text_from_payload(&parsed.payload) {
                        collector
                            .current
                            .push(imported_history::assistant_message_chunk(
                                session_id,
                                CODEX_PROVIDER_SLUG,
                                sequence,
                                &created_at,
                                &text,
                            ));
                        sequence += 1;
                    }
                }
            }
            "reasoning" | "agent_reasoning" => {
                if let Some(text) = reasoning_text_from_payload(&parsed.payload) {
                    collector.current.push(imported_history::thinking_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "function_call" => {
                if let Some((call_id, calls)) =
                    pending_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "custom_tool_call" => {
                if let Some((call_id, calls)) =
                    pending_custom_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "web_search_call" => {
                if let Some(call) = web_search_call_from_payload(&parsed.payload, &created_at) {
                    collector
                        .current
                        .push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
                    sequence += 1;
                }
            }
            "sub_agent_activity" => {
                attach_subagent_activity_to_pending_call(&parsed.payload, &mut pending_tool_calls);
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = parsed.payload.get("call_id").and_then(Value::as_str);
                if let Some(call_id) = call_id {
                    if let Some((file_order, calls)) = pending_tool_calls.take(call_id) {
                        let output_value = parsed.payload.get("output");
                        let output = codex_tool_output_text(output_value);
                        if let Some(cell_id) = wait_cell_id(&calls) {
                            let cell_key = background_cell_key(cell_id);
                            if let Some((background_order, mut background)) =
                                background_tool_calls.take(&cell_key)
                            {
                                if let Some(next_cell_id) = background_cell_id(&output) {
                                    background.latest_output = output;
                                    background_tool_calls.reinsert(
                                        background_cell_key(&next_cell_id),
                                        background_order,
                                        background,
                                    );
                                } else {
                                    let final_output = if output.trim().is_empty() {
                                        background.latest_output
                                    } else {
                                        output
                                    };
                                    resolve_codex_tool_outputs(
                                        session_id,
                                        background.calls,
                                        background_order,
                                        output_value,
                                        &final_output,
                                        &mut collector.current,
                                        &mut sequence,
                                        &mut background_tool_calls,
                                    );
                                }
                                continue;
                            }
                        }
                        if let Some(cell_id) = background_cell_id(&output) {
                            background_tool_calls.reinsert(
                                background_cell_key(&cell_id),
                                file_order,
                                PendingBackgroundToolCall {
                                    calls,
                                    latest_output: output,
                                },
                            );
                            continue;
                        }
                        resolve_codex_tool_outputs(
                            session_id,
                            calls,
                            file_order,
                            output_value,
                            &output,
                            &mut collector.current,
                            &mut sequence,
                            &mut background_tool_calls,
                        );
                    }
                }
            }
            "task_complete" => {
                let task_error_message = codex_task_error_message(&parsed.payload);
                if let Some(error_message) = task_error_message.as_deref() {
                    let mut error_chunk = ActivityChunk::new(session_id, "error", "error");
                    error_chunk.chunk_id = format!("codex-error-{sequence}");
                    error_chunk.created_at = created_at.clone();
                    error_chunk.result = json!({
                        "error": error_message,
                        "observation": error_message,
                        "success": false,
                    });
                    collector.current.push(error_chunk);
                    sequence += 1;
                }
                if let Some(turn_id) =
                    lifecycle_turn_id(&parsed.payload, active_task_turn_id.as_deref())
                {
                    let lifecycle_action = if task_error_message.is_some() {
                        imported_history::ACTION_TYPE_TASK_FAILED
                    } else {
                        imported_history::ACTION_TYPE_TASK_COMPLETED
                    };
                    collector
                        .current
                        .push(imported_history::task_lifecycle_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            lifecycle_action,
                            turn_id,
                        ));
                    sequence += 1;
                    active_task_turn_id = None;
                }
            }
            "turn_aborted" => {
                if let Some(turn_id) =
                    lifecycle_turn_id(&parsed.payload, active_task_turn_id.as_deref())
                {
                    collector
                        .current
                        .push(imported_history::task_lifecycle_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            imported_history::ACTION_TYPE_TASK_FAILED,
                            turn_id,
                        ));
                    sequence += 1;
                    active_task_turn_id = None;
                }
            }
            _ => {}
        }
    }

    for calls in pending_tool_calls.drain_in_file_order() {
        for call in calls {
            collector
                .current
                .push(codex_tool_call_chunk(session_id, sequence, &call, "", None));
            sequence += 1;
        }
    }
    for background in background_tool_calls.drain_in_file_order() {
        if background
            .calls
            .iter()
            .all(|call| call.canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT)
        {
            continue;
        }
        let outputs = output_parts_for_tool_calls(&background.calls, &background.latest_output);
        for (call, output) in background.calls.iter().zip(outputs.iter()) {
            collector.current.push(codex_tool_call_chunk(
                session_id, sequence, call, output, None,
            ));
            sequence += 1;
        }
    }

    Ok(collector.finish())
}

fn attach_subagent_activity_to_pending_call(
    payload: &Value,
    pending_tool_calls: &mut imported_history::PendingCallMap<Vec<ImportedToolCall>>,
) {
    if payload.get("kind").and_then(Value::as_str) != Some("started") {
        return;
    }
    let Some(call_id) = payload.get("event_id").and_then(Value::as_str) else {
        return;
    };
    let Some(calls) = pending_tool_calls.get_mut(call_id) else {
        return;
    };
    let Some(call) = calls
        .iter_mut()
        .find(|call| call.canonical_name == "subagent")
    else {
        return;
    };
    let Some(args) = call.args.as_object_mut() else {
        return;
    };
    if let Some(thread_id) = payload
        .get("agent_thread_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.insert(
            "codexAgentThreadId".to_string(),
            Value::String(thread_id.to_string()),
        );
    }
    if let Some(agent_path) = payload
        .get("agent_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.insert(
            "agent_path".to_string(),
            Value::String(agent_path.to_string()),
        );
    }
}

fn lifecycle_turn_id<'a>(payload: &'a Value, active_turn_id: Option<&'a str>) -> Option<&'a str> {
    payload
        .get("turn_id")
        .and_then(Value::as_str)
        .or(active_turn_id)
}

fn codex_task_error_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    if error.is_null() {
        return None;
    }

    let message = error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .map(str::trim)
        .filter(|message| !message.is_empty());
    Some(match message {
        Some(message) => message.to_string(),
        None if error.as_object().is_some_and(|object| object.is_empty()) => {
            "Codex task failed".to_string()
        }
        None => format!("Codex task failed: {error}"),
    })
}

#[allow(clippy::too_many_arguments)]
fn resolve_codex_tool_outputs(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    file_order: u64,
    output_value: Option<&Value>,
    fallback_output: &str,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
) {
    let mut results = codex_exec_results(output_value);
    if results.len() == calls.len() {
        for (call, result) in calls.into_iter().zip(results.drain(..)) {
            resolve_codex_call_group(
                transcript_session_id,
                vec![call],
                file_order,
                result,
                chunks,
                sequence,
                background_tool_calls,
            );
        }
        return;
    }
    if results.len() == 1 {
        resolve_codex_call_group(
            transcript_session_id,
            calls,
            file_order,
            results.remove(0),
            chunks,
            sequence,
            background_tool_calls,
        );
        return;
    }

    emit_codex_call_group(
        transcript_session_id,
        calls,
        fallback_output,
        None,
        chunks,
        sequence,
    );
}

fn resolve_codex_call_group(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    file_order: u64,
    result: CodexExecResult,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
) {
    if calls.len() == 1 && calls[0].canonical_name == imported_history::FUNCTION_AWAIT_OUTPUT {
        resolve_write_stdin_call(
            transcript_session_id,
            calls.into_iter().next().expect("single continuation call"),
            result,
            chunks,
            sequence,
            background_tool_calls,
        );
        return;
    }

    if result.exit_code.is_none() {
        if let Some(session_id) = result.session_id.as_deref() {
            background_tool_calls.reinsert(
                background_session_key(session_id),
                file_order,
                PendingBackgroundToolCall {
                    calls,
                    latest_output: result.output,
                },
            );
            return;
        }
    }

    emit_codex_call_group(
        transcript_session_id,
        calls,
        &result.output,
        result.exit_code,
        chunks,
        sequence,
    );
}

fn resolve_write_stdin_call(
    transcript_session_id: &str,
    continuation: ImportedToolCall,
    result: CodexExecResult,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    background_tool_calls: &mut imported_history::PendingCallMap<PendingBackgroundToolCall>,
) {
    let source_session_id = continuation
        .args
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some((background_order, mut background)) =
        background_tool_calls.take(&background_session_key(source_session_id))
    else {
        emit_codex_call_group(
            transcript_session_id,
            vec![continuation],
            &result.output,
            result.exit_code,
            chunks,
            sequence,
        );
        return;
    };

    record_stdin_event(&mut background.calls, &continuation);
    append_incremental_output(&mut background.latest_output, &result.output);

    if result.exit_code.is_none() {
        if let Some(next_session_id) = result.session_id.as_deref() {
            background_tool_calls.reinsert(
                background_session_key(next_session_id),
                background_order,
                background,
            );
            return;
        }
    }

    emit_codex_call_group(
        transcript_session_id,
        background.calls,
        &background.latest_output,
        result.exit_code,
        chunks,
        sequence,
    );
}

fn record_stdin_event(calls: &mut [ImportedToolCall], continuation: &ImportedToolCall) {
    let chars = continuation
        .args
        .get("chars")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if chars.is_empty() {
        return;
    }
    let kind = if chars == "\u{3}" {
        "interrupt"
    } else {
        "input"
    };
    let event = json!({
        "kind": kind,
        "chars": chars,
        "created_at": continuation.created_at,
    });
    for call in calls {
        let Some(args) = call.args.as_object_mut() else {
            continue;
        };
        let events = args
            .entry("stdin_events")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut();
        if let Some(events) = events {
            events.push(event.clone());
        }
    }
}

fn append_incremental_output(existing: &mut String, next: &str) {
    if !next.is_empty() {
        existing.push_str(next);
    }
}

fn emit_codex_call_group(
    transcript_session_id: &str,
    calls: Vec<ImportedToolCall>,
    output: &str,
    exit_code: Option<i64>,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
) {
    let outputs = output_parts_for_tool_calls(&calls, output);
    for (call, output) in calls.iter().zip(outputs.iter()) {
        chunks.push(codex_tool_call_chunk(
            transcript_session_id,
            *sequence,
            call,
            output,
            exit_code,
        ));
        *sequence += 1;
    }
}

fn codex_exec_results(output: Option<&Value>) -> Vec<CodexExecResult> {
    let parts = match output {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>(),
        Some(Value::String(text)) => vec![text.as_str()],
        _ => Vec::new(),
    };

    let mut results: Vec<CodexExecResult> = Vec::new();
    for part in parts {
        let parsed_results = codex_exec_results_from_text(part);
        if !parsed_results.is_empty() {
            results.extend(parsed_results);
        } else if !is_codex_script_wrapper_text(part) {
            if let Some(result) = results.last_mut() {
                append_incremental_output(&mut result.output, part);
            }
        }
    }
    results
}

fn codex_exec_results_from_text(text: &str) -> Vec<CodexExecResult> {
    // Desktop `exec` can return either one JSON object per text part or one
    // Script-completed envelope whose Output payload is an array of results.
    // Normalize both shapes here so callers only handle per-command results.
    let direct = serde_json::from_str::<Value>(text.trim())
        .ok()
        .map(codex_exec_results_from_value)
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct;
    }

    let Some(payload) = codex_script_output_payload(text) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(payload)
        .ok()
        .map(codex_exec_results_from_value)
        .unwrap_or_default()
}

fn codex_exec_results_from_value(value: Value) -> Vec<CodexExecResult> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .filter_map(codex_exec_result_from_value)
            .collect(),
        value => codex_exec_result_from_value(value).into_iter().collect(),
    }
}

fn codex_exec_result_from_value(value: Value) -> Option<CodexExecResult> {
    let object = value.as_object()?;
    if !object.contains_key("output")
        && !object.contains_key("session_id")
        && !object.contains_key("sessionId")
        && !object.contains_key("exit_code")
        && !object.contains_key("exitCode")
    {
        return None;
    }
    Some(CodexExecResult {
        output: object
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session_id: object
            .get("session_id")
            .or_else(|| object.get("sessionId"))
            .and_then(json_scalar_string),
        exit_code: object
            .get("exit_code")
            .or_else(|| object.get("exitCode"))
            .and_then(Value::as_i64),
    })
}

fn codex_script_output_payload(text: &str) -> Option<&str> {
    if !is_codex_script_wrapper_text(text) {
        return None;
    }
    ["\nOutput:\r\n", "\nOutput:\n"]
        .into_iter()
        .find_map(|marker| text.split_once(marker).map(|(_, payload)| payload.trim()))
        .filter(|payload| !payload.is_empty())
}

fn json_scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_codex_script_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Script completed")
        || trimmed.starts_with("Script running with cell ID")
        || trimmed.starts_with("Script failed")
        || trimmed.starts_with("Script error")
}

fn background_cell_key(cell_id: &str) -> String {
    format!("cell:{cell_id}")
}

fn background_session_key(session_id: &str) -> String {
    format!("session:{session_id}")
}

fn background_cell_id(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Script running with cell ID ")
            .map(str::trim)
            .filter(|cell_id| !cell_id.is_empty())
            .map(str::to_string)
    })
}

fn wait_cell_id(calls: &[ImportedToolCall]) -> Option<&str> {
    let [call] = calls else {
        return None;
    };
    if normalize_tool_name_key(&call.raw_name) != "wait" {
        return None;
    }
    call.args.get("cell_id").and_then(Value::as_str)
}

fn codex_tool_call_chunk(
    session_id: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
    structured_exit_code: Option<i64>,
) -> ActivityChunk {
    let mut chunk =
        imported_history::tool_call_chunk(session_id, CODEX_PROVIDER_SLUG, sequence, call, output);
    if call.canonical_name == imported_history::FUNCTION_CODE_SEARCH {
        if let Some(result) = chunk.result.as_object_mut() {
            result.insert("content".to_string(), Value::String(output.to_string()));
            let matches = parse_rg_output_matches(output)
                .into_iter()
                .map(|(file, line, content)| {
                    json!({
                        "file": file,
                        "line": line,
                        "content": content,
                    })
                })
                .collect::<Vec<_>>();
            result.insert("matches".to_string(), Value::Array(matches));
        }
    }
    let exit_code = structured_exit_code.or_else(|| codex_tool_exit_code(output));
    let failed = codex_tool_output_failed(output, exit_code);
    if let Some(result) = chunk.result.as_object_mut() {
        if let Some(exit_code) = exit_code {
            result.insert("exit_code".to_string(), json!(exit_code));
        }
        if failed {
            result.insert("success".to_string(), Value::Bool(false));
            result.insert("status".to_string(), Value::String("failed".to_string()));
            result.insert("is_error".to_string(), Value::Bool(true));
            result.insert(
                "failure".to_string(),
                json!({
                    "command": call.args.get("command").and_then(Value::as_str).unwrap_or_default(),
                    "stdout": "",
                    "stderr": output,
                    "exitCode": exit_code,
                }),
            );
        }
    }
    chunk
}

pub(crate) fn output_parts_for_tool_calls(calls: &[ImportedToolCall], output: &str) -> Vec<String> {
    if calls.len() <= 1 {
        return vec![output.to_string()];
    }

    // A multiline Desktop shell script may normalize to several reads followed
    // by a different final operation (for example three `sed` reads then
    // `rg`). Each bounded read consumes its known number of lines; the final
    // tool receives the remainder.
    let bounded_prefix_limits = calls[..calls.len() - 1]
        .iter()
        .map(read_line_limit_from_call)
        .collect::<Option<Vec<_>>>();
    let Some(limits) = bounded_prefix_limits else {
        return vec![output.to_string(); calls.len()];
    };

    let lines = output.split_inclusive('\n').collect::<Vec<_>>();
    let mut cursor = 0usize;
    calls
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let remaining = lines.len().saturating_sub(cursor);
            let take = if index + 1 == calls.len() {
                remaining
            } else {
                limits[index].min(remaining)
            };
            let part = lines[cursor..cursor.saturating_add(take)].concat();
            cursor = cursor.saturating_add(take);
            part
        })
        .collect()
}

fn read_line_limit_from_call(call: &ImportedToolCall) -> Option<usize> {
    if call.canonical_name != imported_history::FUNCTION_READ_FILE {
        return None;
    }
    call.args
        .get("limit")
        .and_then(Value::as_i64)
        .and_then(|value| usize::try_from(value).ok())
}

fn pending_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .map(imported_history::parse_inner_json)
        .unwrap_or_else(|| json!({}));
    let normalized_calls = normalize_codex_tool_calls(&raw_name, arguments);
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

pub(crate) fn pending_custom_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized_calls = if normalize_tool_name_key(&raw_name) == "exec" {
        normalize_codex_exec_tool_calls(input)
    } else {
        let args = if raw_name == "apply_patch" {
            json!({ "patch": input })
        } else {
            json!({ "input": input })
        };
        normalize_codex_tool_calls(&raw_name, args)
    };
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

fn web_search_call_from_payload(payload: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = payload.get("id")?.as_str()?.to_string();
    let action = payload.get("action").cloned().unwrap_or_else(|| json!({}));
    Some(ImportedToolCall {
        call_id,
        raw_name: "web_search_call".to_string(),
        canonical_name: "web_search".to_string(),
        args: normalize_web_search_args(action),
        created_at: created_at.to_string(),
    })
}

fn split_call_id(call_id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        call_id.to_string()
    } else {
        format!("{call_id}:part-{index}")
    }
}

fn parse_rg_output_matches(output: &str) -> Vec<(String, i64, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let file = parts.next()?.trim();
            let line_number = parts.next()?.parse::<i64>().ok()?;
            let content = parts.next().unwrap_or_default();
            if file.is_empty() {
                return None;
            }
            Some((file.to_string(), line_number, content.to_string()))
        })
        .collect()
}

pub(crate) fn user_message_from_payload(payload: &Value) -> Option<String> {
    let raw = payload.get("message").and_then(Value::as_str)?;
    let stripped = strip_orgii_exec_mode_bridge(raw);
    // Bridge-only messages carry no user-authored text: skip them entirely
    // (no replay bubble, no title candidate).
    if stripped.trim().is_empty() {
        return None;
    }
    Some(stripped.to_string())
}

fn user_image_refs_from_payload(payload: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    for field in ["local_images", "images"] {
        let Some(values) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        for value in values {
            let Some(image_ref) = value.as_str().map(str::trim) else {
                continue;
            };
            if !image_ref.is_empty() && !refs.iter().any(|existing| existing == image_ref) {
                refs.push(image_ref.to_string());
            }
        }
    }
    refs
}

fn user_message_chunk_from_payload(
    session_id: &str,
    sequence: usize,
    created_at: &str,
    payload: &Value,
) -> Option<ActivityChunk> {
    let message = user_message_from_payload(payload)?;
    let mut chunk = imported_history::user_message_chunk(
        session_id,
        CODEX_PROVIDER_SLUG,
        sequence,
        created_at,
        &message,
    );
    let images = user_image_refs_from_payload(payload);
    if !images.is_empty() {
        chunk.result["images"] = json!(images);
    }
    Some(chunk)
}

fn content_text_from_payload(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(content_part_text)
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

fn content_part_text(part: &Value) -> Option<String> {
    part.get("text")
        .and_then(Value::as_str)
        .or_else(|| part.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn reasoning_text_from_payload(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let summary = payload.get("summary")?.as_array()?;
    let parts = summary
        .iter()
        .filter_map(content_part_text)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod window_cache_tests {
    use super::*;

    #[test]
    fn cloud_turn_ids_are_source_offsets_in_transcript_order() {
        let temp_dir = std::env::temp_dir().join(format!(
            "orgii-codex-cloud-turn-ids-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let path = temp_dir.join("rollout.jsonl");
        let first = r#"{"timestamp":"2026-08-05T10:00:00Z","payload":{"type":"user_message","message":"first"}}"#;
        let assistant = r#"{"timestamp":"2026-08-05T10:00:01Z","payload":{"type":"assistant_message","message":"reply"}}"#;
        let second = r#"{"timestamp":"2026-08-05T10:01:00Z","payload":{"type":"user_message","message":"second"}}"#;
        std::fs::write(&path, format!("{first}\n{assistant}\n{second}\n")).expect("write fixture");

        let ids = load_codex_app_turn_ids_from_path(&path).expect("load turn ids");
        let second_offset = first.len() + 1 + assistant.len() + 1;
        assert_eq!(
            ids,
            vec![
                "codex-user-0".to_string(),
                format!("codex-user-{second_offset}")
            ]
        );

        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::remove_dir(&temp_dir).expect("remove temp dir");
    }

    #[test]
    fn cloud_turn_windows_preserve_full_sequence_ids() {
        let temp_dir = std::env::temp_dir().join(format!(
            "orgii-codex-cloud-turn-window-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let path = temp_dir.join("rollout.jsonl");
        let content = r#"{"timestamp":"2026-08-05T10:00:00Z","payload":{"type":"task_started","turn_id":"provider-turn-1"}}
{"timestamp":"2026-08-05T10:00:01Z","payload":{"type":"user_message","message":"first"}}
{"timestamp":"2026-08-05T10:01:00Z","payload":{"type":"task_started","turn_id":"provider-turn-2"}}
{"timestamp":"2026-08-05T10:01:01Z","payload":{"type":"user_message","message":"second"}}
"#;
        std::fs::write(&path, content).expect("write fixture");

        let full =
            load_codex_app_from_path("codexapp-cloud-window", &path).expect("load full transcript");
        let ids = load_codex_app_turn_ids_from_path(&path).expect("load turn ids");
        let mut cloud = Vec::new();
        let mut next_sequence = 0usize;
        for turn_id in ids {
            let chunks = load_codex_app_cloud_turn_from_path(
                "codexapp-cloud-window",
                &path,
                &turn_id,
                next_sequence,
            )
            .expect("load cloud turn");
            next_sequence += chunks.len();
            cloud.extend(chunks);
        }
        assert_eq!(
            serde_json::to_value(cloud).expect("serialize cloud chunks"),
            serde_json::to_value(full).expect("serialize full chunks")
        );

        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::remove_dir(&temp_dir).expect("remove temp dir");
    }

    #[test]
    fn cloud_turn_rejects_an_unparseable_turn_id() {
        let error = load_codex_app_cloud_turn_from_path(
            "codexapp-cloud-window",
            Path::new("unused.jsonl"),
            "not-a-codex-turn-id",
            0,
        )
        .expect_err("invalid id must error, not read as empty");
        assert!(error.contains("Invalid Codex cloud turn id"));
    }

    #[test]
    fn codex_turn_offset_cache_bounds_sessions_and_turns() {
        let signature = CodexTranscriptSignature {
            modified_ns: 1,
            size_bytes: 2,
        };
        let mut cache = CodexTurnOffsetCache::default();
        for session in 0..=CODEX_TURN_OFFSET_CACHE_CAPACITY {
            let offsets = (0..=CODEX_TURN_OFFSET_LIMIT_PER_SESSION)
                .map(|turn| CodexTurnOffset {
                    turn_id: format!("turn-{turn}"),
                    byte_offset: turn as u64,
                    sequence: turn,
                })
                .collect();
            cache.insert(
                PathBuf::from(format!("session-{session}.jsonl")),
                signature,
                offsets,
            );
        }

        assert_eq!(cache.entries.len(), CODEX_TURN_OFFSET_CACHE_CAPACITY);
        assert!(cache
            .get(Path::new("session-0.jsonl"), signature, "turn-4096")
            .is_none());
        assert!(cache
            .get(Path::new("session-8.jsonl"), signature, "turn-0")
            .is_none());
        assert_eq!(
            cache.get(Path::new("session-8.jsonl"), signature, "turn-4096"),
            Some((4096, 4096))
        );
    }
}
