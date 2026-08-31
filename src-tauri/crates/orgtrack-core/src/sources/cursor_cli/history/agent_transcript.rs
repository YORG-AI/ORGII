//! Cursor's provider-owned full transcript sidecar.
//!
//! `cursor-agent --resume` can compact the content-addressed `store.db` root
//! down to the active branch tail while preserving the full conversation in
//! `~/.cursor/projects/<workspace>/agent-transcripts/<session>/<session>.jsonl`.
//! Replay therefore compares the two artifacts by real user-turn count and
//! uses the sidecar only when it is strictly more complete. The store remains
//! the fallback for older Cursor builds and keeps its richer tool results when
//! both artifacts cover the same turns.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

use super::*;

const MAX_AGENT_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_AGENT_TRANSCRIPT_LINES: usize = 100_000;
const MAX_CURSOR_PROJECT_DIRS_TO_SCAN: usize = 4_096;

pub(super) fn load_complete_history_from_store_conn(
    store_conn: &Connection,
    session_id: &str,
    source_session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let store_chunks = load_history_from_store_conn(store_conn, session_id)?;
    let Some(store_meta) = read_store_meta(store_conn)? else {
        return Ok(store_chunks);
    };
    let manifest = read_store_manifest(store_conn, &store_meta.latest_root_blob_id)?;
    let workspace_path = manifest
        .as_ref()
        .and_then(|manifest| manifest.workspace_path.as_deref());
    let Some(path) = resolve_agent_transcript_path(workspace_path, source_session_id) else {
        return Ok(store_chunks);
    };
    let sidecar_chunks =
        match load_history_from_agent_transcript_path(&path, session_id, store_meta.created_at) {
            Ok(chunks) => chunks,
            Err(_) => return Ok(store_chunks),
        };
    Ok(prefer_more_complete_history(store_chunks, sidecar_chunks))
}

pub(super) fn prefer_more_complete_history(
    store_chunks: Vec<ActivityChunk>,
    sidecar_chunks: Vec<ActivityChunk>,
) -> Vec<ActivityChunk> {
    if user_turn_count(&sidecar_chunks) > user_turn_count(&store_chunks) {
        sidecar_chunks
    } else {
        store_chunks
    }
}

pub(super) fn user_turn_count(chunks: &[ActivityChunk]) -> usize {
    chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .count()
}

fn resolve_agent_transcript_path(
    workspace_path: Option<&str>,
    source_session_id: &str,
) -> Option<PathBuf> {
    if !safe_path_component(source_session_id) {
        return None;
    }
    let projects_root = app_paths::external_history_home_dir()
        .join(".cursor")
        .join("projects");
    let filename = format!("{source_session_id}.jsonl");

    if let Some(project_slug) = workspace_path.and_then(cursor_project_slug) {
        let direct = projects_root
            .join(project_slug)
            .join("agent-transcripts")
            .join(source_session_id)
            .join(&filename);
        if direct.is_file() {
            return Some(direct);
        }
    }

    // Older/migrated Cursor projects can use a slug that no longer matches
    // the current workspace spelling. Fall back to a bounded one-level scan;
    // the session UUID still makes the candidate identity exact.
    let projects = std::fs::read_dir(&projects_root).ok()?;
    for project in projects.flatten().take(MAX_CURSOR_PROJECT_DIRS_TO_SCAN) {
        let candidate = project
            .path()
            .join("agent-transcripts")
            .join(source_session_id)
            .join(&filename);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub(super) fn safe_path_component(value: &str) -> bool {
    !value.trim().is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && Path::new(value).components().count() == 1
}

pub(super) fn cursor_project_slug(workspace_path: &str) -> Option<String> {
    let components = Path::new(workspace_path)
        .components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_string()),
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            Component::RootDir | Component::CurDir | Component::ParentDir => None,
        })
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    (!components.is_empty()).then(|| components.join("-"))
}

fn load_history_from_agent_transcript_path(
    path: &Path,
    session_id: &str,
    created_at_ms: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let metadata = std::fs::metadata(path).map_err(|err| {
        format!(
            "Failed to stat Cursor agent transcript {}: {err}",
            path.display()
        )
    })?;
    if metadata.len() > MAX_AGENT_TRANSCRIPT_BYTES {
        return Err(format!(
            "Cursor agent transcript exceeds {} bytes: {}",
            MAX_AGENT_TRANSCRIPT_BYTES,
            path.display()
        ));
    }
    let file = File::open(path).map_err(|err| {
        format!(
            "Failed to open Cursor agent transcript {}: {err}",
            path.display()
        )
    })?;
    load_history_from_agent_transcript_reader(BufReader::new(file), session_id, created_at_ms)
}

pub(super) fn load_history_from_agent_transcript_reader<R: BufRead>(
    reader: R,
    session_id: &str,
    created_at_ms: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let mut chunks = Vec::new();
    let mut sequence = 0usize;

    for (line_index, line) in reader
        .lines()
        .take(MAX_AGENT_TRANSCRIPT_LINES.saturating_add(1))
        .enumerate()
    {
        if line_index == MAX_AGENT_TRANSCRIPT_LINES {
            return Err(format!(
                "Cursor agent transcript exceeds {MAX_AGENT_TRANSCRIPT_LINES} lines"
            ));
        }
        let line = line.map_err(|err| format!("Failed to read Cursor agent transcript: {err}"))?;
        let envelope = serde_json::from_str::<Value>(&line).map_err(|err| {
            format!(
                "Failed to parse Cursor agent transcript line {}: {err}",
                line_index + 1
            )
        })?;
        let Some(role) = envelope.get("role").and_then(Value::as_str) else {
            continue;
        };
        let Some(message) = envelope.get("message") else {
            continue;
        };
        match role {
            "user" => {
                let text = message_content_text(message.get("content"));
                let Some(text) = clean_user_text(&text) else {
                    continue;
                };
                // Unlike store.db's content-addressed DAG, the provider sidecar
                // writes one user envelope per explicit send. Repeated text is
                // therefore a real additional round and must not be collapsed.
                let created_at = timestamp_for_sequence(created_at_ms, sequence);
                chunks.push(imported_history::user_message_chunk(
                    session_id,
                    CURSOR_CLI_PROVIDER_SLUG,
                    sequence,
                    &created_at,
                    &text,
                ));
                sequence += 1;
            }
            "assistant" => {
                for (item_index, item) in message_content_items(message.get("content"))
                    .into_iter()
                    .enumerate()
                {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                            let (thoughts, visible) = split_think_blocks(text);
                            for thought in thoughts {
                                let created_at = timestamp_for_sequence(created_at_ms, sequence);
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    &thought,
                                ));
                                sequence += 1;
                            }
                            let visible = visible.trim();
                            if !visible.is_empty() {
                                let created_at = timestamp_for_sequence(created_at_ms, sequence);
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    visible,
                                ));
                                sequence += 1;
                            }
                        }
                        Some("tool_use") => {
                            let created_at = timestamp_for_sequence(created_at_ms, sequence);
                            if let Some(call) = agent_transcript_tool_call_from_item(
                                item,
                                line_index,
                                item_index,
                                &created_at,
                            ) {
                                chunks.push(imported_history::tool_call_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &call,
                                    "",
                                ));
                                sequence += 1;
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(chunks)
}

fn timestamp_for_sequence(created_at_ms: i64, sequence: usize) -> String {
    imported_history::epoch_ms_to_iso(
        created_at_ms.saturating_add(i64::try_from(sequence).unwrap_or(i64::MAX)),
    )
}

fn agent_transcript_tool_call_from_item(
    item: &Value,
    line_index: usize,
    item_index: usize,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let raw_name = item.get("name")?.as_str()?.to_string();
    let call_id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("agent-transcript-{line_index}-{item_index}"));
    let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_cursor_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}
