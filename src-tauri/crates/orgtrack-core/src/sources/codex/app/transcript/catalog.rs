use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use memchr::{memchr_iter, memmem};
use serde_json::Value;

use crate::sources::imported_history;

use super::super::CodexJsonlLine;
use super::cache::{
    bounded_codex_turn_preview, codex_turn_catalog_cache, CodexTranscriptSignature,
    CodexTurnCatalogEntry, CODEX_INITIAL_TURN_LIMIT, CODEX_REVERSE_SCAN_MAX_LINE_BYTES,
};
use super::messages::{content_text_from_payload, user_message_from_line};

const CODEX_LEGACY_USER_MESSAGE_NEEDLE: &[u8] = b"\"user_message\"";
const CODEX_PAGINATED_USER_MESSAGE_NEEDLE: &[u8] = b"\"UserMessage\"";
const CODEX_REVERSE_SCAN_BLOCK_BYTES: usize = 1024 * 1024;

pub(super) fn codex_lazy_turn_sequence(byte_offset: u64) -> usize {
    usize::try_from(byte_offset).unwrap_or(usize::MAX)
}

pub(super) fn codex_lazy_turn_id(byte_offset: u64) -> String {
    format!("codex-user-{}", codex_lazy_turn_sequence(byte_offset))
}

pub(super) fn codex_lazy_turn_offset(turn_id: &str) -> Option<u64> {
    turn_id.strip_prefix("codex-user-")?.parse().ok()
}

pub(super) fn load_codex_turn_catalog(
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

pub(super) fn find_recent_codex_user_offsets(
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
    const AGENT_MESSAGE_NEEDLE: &[u8] = b"\"agent_message\"";
    const ASSISTANT_ROLE_NEEDLE: &[u8] = b"\"assistant\"";
    if line.is_empty() {
        return;
    }
    if entries.len() >= limit {
        return;
    }
    let may_contain_user = memmem::find(line, CODEX_LEGACY_USER_MESSAGE_NEEDLE).is_some()
        || memmem::find(line, CODEX_PAGINATED_USER_MESSAGE_NEEDLE).is_some();
    let may_contain_assistant = last_agent_preview.is_none()
        && (memmem::find(line, AGENT_MESSAGE_NEEDLE).is_some()
            || memmem::find(line, ASSISTANT_ROLE_NEEDLE).is_some());
    if !may_contain_user && !may_contain_assistant {
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    }
    let Ok(parsed) = serde_json::from_slice::<CodexJsonlLine>(line) else {
        *lines_since_boundary = lines_since_boundary.saturating_add(1);
        return;
    };
    if may_contain_user {
        if let Some(message) = user_message_from_line(&parsed) {
            let started_at = parsed
                .timestamp
                .as_deref()
                .map(imported_history::normalize_created_at)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            entries.push(CodexTurnCatalogEntry {
                byte_offset,
                started_at,
                user_preview: bounded_codex_turn_preview(&message.text),
                last_agent_preview: last_agent_preview.take(),
                following_line_count: *lines_since_boundary,
            });
            *lines_since_boundary = 0;
            return;
        }
    }
    if may_contain_assistant {
        let payload_type = parsed.payload.get("type").and_then(Value::as_str);
        let message = match payload_type {
            Some("agent_message") => parsed
                .payload
                .get("message")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            Some("message")
                if parsed.payload.get("role").and_then(Value::as_str) == Some("assistant") =>
            {
                content_text_from_payload(&parsed.payload)
            }
            _ => None,
        };
        *last_agent_preview = message
            .filter(|message| !message.trim().is_empty())
            .map(|message| bounded_codex_turn_preview(&message));
    }
    *lines_since_boundary = lines_since_boundary.saturating_add(1);
}
