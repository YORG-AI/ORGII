//! Bounded replay of a single Kimi session into activity chunks.

use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde_json::Value;

use crate::sources::imported_history::{
    self, cache as imported_cache, metadata::SOURCE_KIMI, paths as imported_paths,
    watermark::WatermarkedTranscriptReader,
};

use super::identity::{
    layout_from_source_id, KimiLayout, KIMI_METADATA_PARSER_VERSION, KIMI_SESSION_PREFIX,
    MAX_REPLAY_CHUNKS, MAX_REPLAY_MESSAGE_CHARS, MAX_REPLAY_TEXT_BYTES, MAX_WIRE_FILE_BYTES,
};
use super::paths::{ensure_exact_safe_history_file, kimi_code_home_for};
use super::replay_code::read_code_replay;
use super::wire::{first_string, legacy_timestamp_ms};

pub fn load_kimi_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let home = app_paths::external_history_home_dir();
    load_kimi_history_for_session_in(
        conn,
        session_id,
        &home,
        std::env::var_os("KIMI_CODE_HOME").as_deref(),
    )
}

pub(super) fn load_kimi_history_for_session_in(
    conn: &Connection,
    session_id: &str,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<Vec<ActivityChunk>, String> {
    if !session_id.starts_with(KIMI_SESSION_PREFIX) {
        return Err(format!("Invalid Kimi session id: {session_id}"));
    }
    let (_, cached) =
        imported_cache::query_cached_session_by_session_id_from_conn(conn, session_id)?
            .filter(|(source, _)| source == SOURCE_KIMI)
            .ok_or_else(|| format!("Kimi session not found: {session_id}"))?;
    let layout = layout_from_source_id(&cached.source_session_id)?;
    let root = match layout {
        KimiLayout::Legacy => home.join(".kimi").join("sessions"),
        KimiLayout::Code => kimi_code_home_for(home, kimi_code_home).join("sessions"),
    };
    read_replay(
        Path::new(&cached.source_path),
        &root,
        home,
        session_id,
        layout,
    )
}

fn read_replay(
    path: &Path,
    root: &Path,
    identity_home: &Path,
    session_id: &str,
    layout: KimiLayout,
) -> Result<Vec<ActivityChunk>, String> {
    ensure_exact_safe_history_file(path, root, identity_home, layout)?;
    let (mtime, size) = imported_paths::file_metadata_signature(path, "Kimi")?;
    if size > MAX_WIRE_FILE_BYTES {
        return Err("Kimi history exceeds the replay safety limit".to_string());
    }
    if layout == KimiLayout::Code {
        return read_code_replay(path, session_id, mtime, size);
    }
    read_legacy_replay(path, session_id, mtime, size)
}

fn read_legacy_replay(
    path: &Path,
    session_id: &str,
    mtime: i64,
    size: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Kimi",
        None,
        KIMI_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut chunks = Vec::new();
    let mut retained_text_bytes = 0usize;
    let mut pending_assistant: Option<(String, String, usize)> = None;
    while let Some(line) = reader.next_line()? {
        let Ok(value) = serde_json::from_str::<Value>(line.text.trim()) else {
            continue;
        };
        let timestamp = legacy_timestamp_ms(&value).unwrap_or(mtime / 1_000_000);
        let created_at = imported_history::epoch_ms_to_iso(timestamp);
        let Some(message) = value.get("message") else {
            continue;
        };
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = message.get("payload").unwrap_or(&Value::Null);
        match kind {
            "TurnBegin" => {
                flush_pending_assistant(
                    &mut chunks,
                    &mut retained_text_bytes,
                    &mut pending_assistant,
                    session_id,
                )?;
                let Some(text) = first_string(payload, &["user_input", "userInput", "input"])
                else {
                    continue;
                };
                push_replay_message(
                    &mut chunks,
                    &mut retained_text_bytes,
                    session_id,
                    "user",
                    &created_at,
                    imported_history::truncate_name(text, MAX_REPLAY_MESSAGE_CHARS),
                )?;
            }
            "ContentPart" => {
                let Some(text) = ["text", "content"]
                    .into_iter()
                    .find_map(|key| payload.get(key).and_then(Value::as_str))
                    .filter(|text| !text.is_empty())
                else {
                    continue;
                };
                let pending =
                    pending_assistant.get_or_insert_with(|| (created_at.clone(), String::new(), 0));
                let remaining_chars = MAX_REPLAY_MESSAGE_CHARS.saturating_sub(pending.2);
                let reserved_bytes = retained_text_bytes.saturating_add(pending.1.len());
                let remaining_bytes = MAX_REPLAY_TEXT_BYTES.saturating_sub(reserved_bytes);
                if remaining_bytes == 0 && !text.is_empty() {
                    return Err(
                        "Kimi replay exceeds the bounded in-memory safety limit".to_string()
                    );
                }
                let fragment = bounded_replay_fragment(text, remaining_chars, remaining_bytes);
                pending.2 = pending.2.saturating_add(fragment.chars().count());
                pending.1.push_str(&fragment);
            }
            _ => {}
        }
    }
    flush_pending_assistant(
        &mut chunks,
        &mut retained_text_bytes,
        &mut pending_assistant,
        session_id,
    )?;
    Ok(chunks)
}

pub(super) fn bounded_replay_fragment(value: &str, max_chars: usize, max_bytes: usize) -> String {
    let mut result = String::new();
    for character in value.chars().take(max_chars) {
        if result.len().saturating_add(character.len_utf8()) > max_bytes {
            break;
        }
        result.push(character);
    }
    result
}

fn flush_pending_assistant(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    pending: &mut Option<(String, String, usize)>,
    session_id: &str,
) -> Result<(), String> {
    let Some((created_at, text, _)) = pending.take() else {
        return Ok(());
    };
    if text.is_empty() {
        return Ok(());
    }
    push_replay_message(
        chunks,
        retained_text_bytes,
        session_id,
        "assistant",
        &created_at,
        text,
    )
}

pub(super) fn push_replay_message(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    session_id: &str,
    role: &str,
    created_at: &str,
    text: String,
) -> Result<(), String> {
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_text_bytes.saturating_add(text.len()) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Kimi replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_text_bytes = (*retained_text_bytes).saturating_add(text.len());
    let sequence = chunks.len();
    chunks.push(if role == "user" {
        imported_history::user_message_chunk(session_id, "kimi", sequence, created_at, &text)
    } else {
        imported_history::assistant_message_chunk(session_id, "kimi", sequence, created_at, &text)
    });
    Ok(())
}

pub(super) fn push_replay_thinking(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    session_id: &str,
    created_at: &str,
    text: String,
) -> Result<(), String> {
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_text_bytes.saturating_add(text.len()) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Kimi replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_text_bytes = (*retained_text_bytes).saturating_add(text.len());
    let sequence = chunks.len();
    chunks.push(imported_history::thinking_chunk(
        session_id, "kimi", sequence, created_at, &text,
    ));
    Ok(())
}
