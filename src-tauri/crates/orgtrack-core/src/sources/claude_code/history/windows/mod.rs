use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};
use crate::sources::imported_history;

use super::discovery::{claude_file_stem_from_session_id, resolve_claude_session_path};
use super::replay::{load_claude_code_history_from_path, load_claude_code_history_from_reader};
use index::{claude_window_turn_offset, ClaudeIndexedTurn};
pub(super) use index::{index_claude_user_turns, overlay_indexed_body_counts};

mod index;

#[cfg(test)]
pub(super) use index::{claude_window_turn_id, CLAUDE_WINDOW_TURN_ID_PREFIX};

pub(super) fn load_claude_turn_range(
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

pub(super) fn load_claude_code_initial_window_from_path(
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

pub(super) fn load_claude_code_cloud_turn_windows_from_path(
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
