use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use core_types::activity::ActivityChunk;
use serde::Serialize;
use serde_json::Value;

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};
use crate::sources::imported_history;

use super::super::CodexJsonlLine;
use super::cache::{
    codex_transcript_file_signature, codex_turn_offset_cache, remember_codex_turn_offsets,
    CodexTurnCatalogEntry, CodexTurnOffset, CODEX_INITIAL_TURN_LIMIT,
    CODEX_REVERSE_SCAN_MAX_LINE_BYTES,
};
use super::catalog::{
    codex_lazy_turn_id, codex_lazy_turn_offset, codex_lazy_turn_sequence,
    find_recent_codex_user_offsets, load_codex_turn_catalog,
};
use super::collector::{build_unloaded_turn_placeholder_chunk, CodexTranscriptCollectionMode};
use super::messages::user_message_chunk_from_line;
use super::parser::parse_codex_app_from_path_with_mode;
use super::CODEX_PROVIDER_SLUG;

const CODEX_TURN_HEADER_PROBE_BYTES: u64 = 8 * 1024 * 1024;

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

pub fn load_codex_app_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let signature_before = codex_transcript_file_signature(path)?;
    let (chunks, _, offsets) = parse_codex_app_from_path_with_mode(
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
    let (chunks, turns, offsets) = parse_codex_app_from_path_with_mode(
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
    let (selected_chunks, _, _) = parse_codex_app_from_path_with_mode(
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
    let (chunks, _, _) = parse_codex_app_from_path_with_mode(
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
        let (turn_chunks, _, _) = parse_codex_app_from_path_with_mode(
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
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let sequence = codex_lazy_turn_sequence(byte_offset);
        let Some(user_chunk) =
            user_message_chunk_from_line(session_id, sequence, &created_at, &parsed)
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
