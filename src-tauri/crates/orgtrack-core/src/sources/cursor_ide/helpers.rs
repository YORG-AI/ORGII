//! Pure utility functions and the bubble→ActivityChunk pipeline.
//!
//! All items are `pub(super)` — internal to `cursor_db_history` and its
//! sibling submodules only.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

use core_types::activity::ActivityChunk;

use super::history::{CursorIdeSessionRow, CURSORIDE_SESSION_PREFIX, CURSOR_IDE_CATEGORY};
use super::io::{load_composer_for_order, load_content_blob};
use super::models::{
    CursorComposerContext, CursorWorkspaceMetadata, OrderedBubble, RawBubble, RawComposerForOrder,
    RawComposerHeader, RawCursorSubagentInfo, RawToolFormerData,
};

// ============================================================================
// Constants
// ============================================================================

const CURSOR_BUBBLE_TYPE_USER: i64 = 1;
const CURSOR_BUBBLE_TYPE_ASSISTANT: i64 = 2;

// ============================================================================
// Session helper: list filter & cache-row conversion
// ============================================================================

pub(super) fn is_listable_cursor_session(
    row: &super::db::CursorSession,
    cursor_conn: Option<&Connection>,
) -> Result<bool, String> {
    let Some(conn) = cursor_conn else {
        return Ok(false);
    };
    if row.name.trim().is_empty() {
        return Ok(false);
    }
    use super::io::{load_bubble_order, load_bubbles_by_id};
    let order = load_bubble_order(conn, &row.id)?;
    if order.is_empty() {
        return Ok(false);
    }
    let bubbles = load_bubbles_by_id(conn, &row.id, &order)?;
    Ok(!bubbles_to_chunks(
        conn,
        &format!("{}{}", CURSORIDE_SESSION_PREFIX, row.id),
        &bubbles,
        &CursorComposerContext::default(),
    )
    .is_empty())
}

pub(super) fn cache_row_to_session_row(
    row: super::db::CursorSession,
    cursor_conn: Option<&Connection>,
) -> Result<CursorIdeSessionRow, String> {
    let session_id = format!("{}{}", CURSORIDE_SESSION_PREFIX, row.id);
    let created_iso = epoch_ms_to_iso(row.created_at);
    let updated_iso = if row.last_active_at > 0 {
        epoch_ms_to_iso(row.last_active_at)
    } else {
        created_iso.clone()
    };
    let model = if row.model.is_empty() {
        None
    } else {
        Some(row.model)
    };
    let composer = match cursor_conn {
        Some(conn) => Some(load_composer_for_order(conn, &row.id)?),
        None => None,
    };
    let metadata = composer
        .as_ref()
        .map(cursor_workspace_metadata_from_composer)
        .unwrap_or_default();
    let repo_name = metadata.repo_path.as_deref().and_then(repo_name_from_path);
    let touched_files = composer
        .as_ref()
        .map(cursor_touched_files_from_composer)
        .unwrap_or_default();
    Ok(CursorIdeSessionRow {
        session_id,
        name: if row.name.is_empty() {
            "Untitled Cursor session".to_string()
        } else {
            row.name
        },
        status: if row.status.is_empty() {
            "completed".to_string()
        } else {
            row.status
        },
        created_at: created_iso,
        updated_at: updated_iso,
        category: CURSOR_IDE_CATEGORY,
        read_only: true,
        model,
        total_tokens: row.tokens_used,
        lines_added: row.lines_added,
        lines_removed: row.lines_removed,
        files_changed: row.files_changed,
        touched_files,
        background: false,
        is_active: false,
        repo_path: metadata.repo_path,
        repo_name,
        branch: metadata.branch,
    })
}

fn cursor_touched_files_from_composer(composer: &RawComposerForOrder) -> Vec<String> {
    composer
        .original_file_states
        .iter()
        .filter_map(|(uri, state)| {
            let has_edit_marker = state.is_newly_created || !state.content_key.trim().is_empty();
            if !has_edit_marker {
                return None;
            }
            Some(cursor_file_uri_to_path(uri))
        })
        .collect()
}

fn cursor_file_uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file://")
        .unwrap_or(uri)
        .trim()
        .to_string()
}

// ============================================================================
// Workspace metadata helpers
// ============================================================================

fn cursor_workspace_metadata_from_composer(
    composer: &RawComposerForOrder,
) -> CursorWorkspaceMetadata {
    cursor_workspace_metadata_from_parts(
        &composer.tracked_git_repos,
        composer.workspace_identifier.as_ref(),
    )
}

fn cursor_workspace_metadata_from_parts(
    tracked_git_repos: &[super::models::RawTrackedGitRepo],
    workspace_identifier: Option<&super::models::RawWorkspaceIdentifier>,
) -> CursorWorkspaceMetadata {
    let tracked_repo = tracked_git_repos.first();
    let repo_path = tracked_repo
        .map(|repo| repo.repo_path.trim())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            workspace_identifier
                .and_then(|workspace| workspace.uri.as_ref())
                .and_then(|uri| {
                    let fs_path = uri.fs_path.trim();
                    if !fs_path.is_empty() {
                        Some(fs_path.to_string())
                    } else {
                        let path = uri.path.trim();
                        (!path.is_empty()).then(|| path.to_string())
                    }
                })
        });
    let branch = tracked_repo
        .and_then(|repo| repo.branches.first())
        .map(|branch| branch.branch_name.trim())
        .filter(|branch| !branch.is_empty())
        .map(str::to_string);

    CursorWorkspaceMetadata { repo_path, branch }
}

pub(super) fn repo_name_from_path(path: &str) -> Option<String> {
    PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

// ============================================================================
// Timestamp / text pure utilities
// ============================================================================

pub(super) fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

pub(super) fn composer_source_updated_at(
    conn: &Connection,
    composer_id: &str,
    composer: &super::models::RawComposerForOrder,
    order: &[RawComposerHeader],
) -> Result<i64, String> {
    use rusqlite::OptionalExtension;

    let mut source_updated_at = composer.created_at.max(composer.last_updated_at);
    if let Some(last_header) = order.last().filter(|header| !header.bubble_id.is_empty()) {
        let key = format!("bubbleId:{}:{}", composer_id, last_header.bubble_id);
        let bubble_json: Option<String> = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                [key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| format!("Failed to read Cursor latest bubble timestamp: {}", err))?
            .flatten();
        if let Some(value) = bubble_json {
            if let Ok(raw) = serde_json::from_str::<RawBubble>(&value) {
                let bubble_updated_at = parse_iso_to_epoch_ms(&raw.created_at);
                if bubble_updated_at > 0 {
                    source_updated_at = source_updated_at.max(bubble_updated_at);
                }
            }
        }
    }
    Ok(source_updated_at)
}

pub(super) fn parse_iso_to_epoch_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

pub(super) fn duration_between_iso_ms(started_at: &str, ended_at: &str) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(ended_at).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

pub(super) fn preview_text(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 160;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(MAX_PREVIEW_CHARS).collect()
}

/// Cursor stores `createdAt` as ISO-8601. Pass through if it parses; otherwise
/// fall back to "now" so downstream code that orders by timestamp doesn't
/// crash. The canonical order is the composer header order, not timestamps,
/// so this fallback only affects display formatting.
pub(super) fn normalize_created_at(raw: &str) -> String {
    if !raw.is_empty() && chrono::DateTime::parse_from_rfc3339(raw).is_ok() {
        return raw.to_string();
    }
    chrono::Utc::now().to_rfc3339()
}

// ============================================================================
// Placeholder chunk builders
// ============================================================================

pub(super) fn fallback_turn_created_at(
    order: &[RawComposerHeader],
    bubbles_by_id: &HashMap<String, OrderedBubble>,
    index: usize,
) -> String {
    let next_user_index = order
        .iter()
        .enumerate()
        .skip(index + 1)
        .find(|(_, candidate)| candidate.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .map(|(candidate_index, _)| candidate_index)
        .unwrap_or(order.len());
    order[index..next_user_index]
        .iter()
        .find_map(|header| bubbles_by_id.get(&header.bubble_id))
        .map(|bubble| normalize_created_at(&bubble.raw.created_at))
        .unwrap_or_default()
}

pub(super) fn build_fallback_user_chunk(
    session_id: &str,
    user_bubble_id: &str,
    created_at: String,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, "raw", "user_message");
    chunk.chunk_id = format!("cursoride-user-{}", user_bubble_id);
    chunk.created_at = created_at;
    chunk.result = json!({
        "type": "user",
        "message": { "content": "User message not loaded.", "role": "user" },
    });
    chunk
}

pub(super) fn build_unloaded_turn_placeholder_chunk(
    session_id: &str,
    order: &[RawComposerHeader],
    recent_ids: &HashSet<&str>,
    bubbles_by_id: &HashMap<String, OrderedBubble>,
    summaries_by_turn_id: &HashMap<String, super::models::CursorIdeTurnSummary>,
    index: usize,
) -> Option<ActivityChunk> {
    let header = order.get(index)?;
    if header.bubble_type != CURSOR_BUBBLE_TYPE_USER {
        return None;
    }

    let next_user_index = order
        .iter()
        .enumerate()
        .skip(index + 1)
        .find(|(_, candidate)| candidate.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .map(|(candidate_index, _)| candidate_index)
        .unwrap_or(order.len());
    let turn_headers = &order[index..next_user_index];
    let has_unloaded_body = turn_headers
        .iter()
        .skip(1)
        .any(|candidate| !recent_ids.contains(candidate.bubble_id.as_str()));

    if !has_unloaded_body {
        return None;
    }

    let next_user_bubble_id = if next_user_index < order.len() {
        order
            .get(next_user_index)
            .map(|candidate| candidate.bubble_id.clone())
    } else {
        None
    };
    let end_header = turn_headers.last()?;
    let end_bubble = bubbles_by_id
        .get(&end_header.bubble_id)
        .or_else(|| bubbles_by_id.get(&header.bubble_id))?;

    let summary = summaries_by_turn_id.get(&header.bubble_id);
    let body_event_count = summary
        .map(|cached_summary| cached_summary.body_event_count)
        .unwrap_or_else(|| turn_headers.len().saturating_sub(1));
    let event_count = summary
        .map(|cached_summary| cached_summary.event_count)
        .unwrap_or(turn_headers.len());
    let started_at = summary
        .map(|cached_summary| cached_summary.started_at.clone())
        .unwrap_or_else(|| normalize_created_at(&end_bubble.raw.created_at));
    let ended_at = summary
        .and_then(|cached_summary| cached_summary.ended_at.clone())
        .unwrap_or_else(|| normalize_created_at(&end_bubble.raw.created_at));
    let duration_ms = summary.and_then(|cached_summary| cached_summary.duration_ms);
    let content = format!("Cursor IDE turn {} is not loaded yet.", header.bubble_id);
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("cursoride-unloaded-turn-{}", header.bubble_id);
    chunk.created_at = ended_at.clone();
    chunk.result = json!({
        "observation": content,
        "content": content,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
        "unloadedTurn": {
            "turnId": header.bubble_id,
            "nextTurnId": summary
                .and_then(|cached_summary| cached_summary.next_turn_id.clone())
                .or(next_user_bubble_id),
            "startedAt": started_at,
            "endedAt": ended_at,
            "durationMs": duration_ms,
            "eventCount": event_count,
            "bodyEventCount": body_event_count,
        },
    });
    Some(chunk)
}

// ============================================================================
// Bubble → ActivityChunk normalization
// ============================================================================

pub(super) fn bubbles_to_chunks(
    conn: &Connection,
    session_id: &str,
    bubbles: &[OrderedBubble],
    composer_context: &CursorComposerContext,
) -> Vec<ActivityChunk> {
    let mut chunks = Vec::with_capacity(bubbles.len());

    for ob in bubbles {
        // Prefer the bubble's own `type`, fall back to the header's `type`
        // (the header is what `composerData.fullConversationHeadersOnly`
        // exposes — used as a backstop when the bubble blob is malformed).
        let bubble_type = if ob.raw.bubble_type != 0 {
            ob.raw.bubble_type
        } else {
            ob.bubble_type
        };

        match bubble_type {
            CURSOR_BUBBLE_TYPE_USER => {
                if let Some(subagent_info) = composer_context.subagent_info.as_ref() {
                    if let Some(chunk) =
                        cursor_subagent_prompt_bubble_to_chunk(session_id, ob, subagent_info)
                    {
                        chunks.push(chunk);
                    }
                } else if let Some(chunk) = user_bubble_to_chunk(session_id, ob) {
                    chunks.push(chunk);
                }
            }
            CURSOR_BUBBLE_TYPE_ASSISTANT => {
                if let Some(tool_chunk) = assistant_tool_bubble_to_chunk(conn, session_id, ob) {
                    chunks.push(tool_chunk);
                } else if let Some(text_chunk) = assistant_text_bubble_to_chunk(session_id, ob) {
                    chunks.push(text_chunk);
                }
                // Empty assistant bookkeeping bubbles are silently dropped.
            }
            _ => {
                // Unknown bubble type — skip rather than guess.
            }
        }
    }

    chunks
}

pub(super) fn cursor_subagent_prompt_bubble_to_chunk(
    session_id: &str,
    ob: &OrderedBubble,
    subagent_info: &RawCursorSubagentInfo,
) -> Option<ActivityChunk> {
    let prompt = ob.raw.text.trim();
    if prompt.is_empty() {
        return None;
    }

    let description = prompt.lines().next().unwrap_or("Cursor subagent").trim();
    let mut chunk = ActivityChunk::new(session_id, "tool_call", "subagent");
    chunk.chunk_id = format!("cursoride-subagent-prompt-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.args = json!({
        "description": description,
        "prompt": prompt,
        "subagent_type": subagent_info.subagent_type_name.as_str(),
        "parentComposerId": subagent_info.parent_composer_id.as_str(),
        "cursorToolCallId": subagent_info.tool_call_id.as_str(),
    });
    chunk.result = json!({
        "success": true,
        "status": "completed",
        "call_id": subagent_info.tool_call_id.as_str(),
    });
    Some(chunk)
}

pub(super) fn user_bubble_to_chunk(session_id: &str, ob: &OrderedBubble) -> Option<ActivityChunk> {
    let text = ob.raw.text.trim();
    let content = if text.is_empty() {
        "User message not loaded."
    } else {
        text
    };
    let mut chunk = ActivityChunk::new(session_id, "raw", "user_message");
    chunk.chunk_id = format!("cursoride-user-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.result = json!({
        "type": "user",
        "message": { "content": content, "role": "user" },
    });
    Some(chunk)
}

pub(super) fn assistant_text_bubble_to_chunk(
    session_id: &str,
    ob: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = ob.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("cursoride-asst-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.result = json!({
        "observation": text,
        "content": text,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
    });
    Some(chunk)
}

pub(super) fn assistant_tool_bubble_to_chunk(
    conn: &Connection,
    session_id: &str,
    ob: &OrderedBubble,
) -> Option<ActivityChunk> {
    let tfd = ob.raw.tool_former_data.as_ref()?;
    if tfd.name.is_empty() {
        return None;
    }

    let canonical = cursor_tool_name_to_canonical(&tfd.name);

    let mut args = parse_inner_json(&tfd.params);
    let mut result_payload = parse_inner_json(&tfd.result);
    merge_cursor_additional_data(&mut result_payload, &tfd.additional_data);

    // Translate Cursor's per-tool field names into the canonical names our
    // frontend extractors expect so existing chat blocks render Cursor history
    // identically to CLI agent output.
    normalize_args_for_canonical(canonical, &tfd.name, &mut args);
    normalize_result_for_canonical(conn, canonical, &tfd.name, &mut result_payload);
    // Cross-field rewrites that need both args and result in scope.
    link_subagent_session(canonical, &mut args, &mut result_payload);
    resolve_ask_question_answers(canonical, &args, &mut result_payload);

    let mut chunk = ActivityChunk::new(session_id, "tool_call", canonical);
    chunk.chunk_id = format!("cursoride-tool-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.args = args;
    chunk.result = enrich_tool_result(result_payload, tfd);

    Some(chunk)
}

// ============================================================================
// Per-canonical field normalization
//
// Cursor IDE keeps each tool's own field names (`targetFile`, `globPattern`,
// `relativeWorkspacePath`, `finalTodos`, …). Our frontend extractors expect
// canonical names (`target_file`, `pattern`, `file_path`, `todos`, …). We
// translate at parse time — once, here — instead of in every extractor.
// ============================================================================

fn normalize_args_for_canonical(canonical: &str, cursor_name: &str, args: &mut Value) {
    let obj = match args.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    match canonical {
        // read_file_v2 → read_file: `targetFile` is the absolute path; copy
        // it onto `target_file` so `extractFileData` finds it.
        "read_file" => {
            move_string_field(obj, "targetFile", "target_file");
            move_string_field(obj, "effectiveUri", "file_path");
        }
        // edit_file_v2 / delete_file: Cursor ships only the path here; the
        // diff lives in the result. Copy the path onto `file_path`.
        "edit_file_by_replace" | "delete_file" => {
            move_string_field(obj, "relativeWorkspacePath", "file_path");
        }
        // glob_file_search: Cursor uses `globPattern`; GlobAdapter reads
        // `pattern` / `glob`.
        "glob_file_search" => {
            move_string_field(obj, "globPattern", "pattern");
            move_string_field(obj, "targetDirectory", "path");
        }
        "run_command_line" => {
            move_string_field(obj, "commandDescription", "description");
        }
        // web_fetch is renamed to web_search but keeps Cursor's `url` field.
        // `WebSearchAdapter` reads `query` only — surface the URL there too
        // so the card shows something meaningful.
        "web_search" => {
            if cursor_name == "web_fetch" {
                if let Some(Value::String(url)) = obj.get("url").cloned() {
                    obj.entry("query".to_string()).or_insert(Value::String(url));
                }
            }
        }
        _ => {}
    }
}

fn normalize_result_for_canonical(
    conn: &Connection,
    canonical: &str,
    _cursor_name: &str,
    result: &mut Value,
) {
    let obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    match canonical {
        // Cursor returns the whole file body under `contents`; our file
        // extractor reads `result.content` / `output`.
        "read_file" => {
            move_string_field(obj, "contents", "content");
        }
        // edit_file_v2 result is `{beforeContentId, afterContentId}` where
        // each id is a `composer.content.{hash}` SQLite key holding the raw
        // file body. Resolve both blobs and derive the actual touched lines.
        "edit_file_by_replace" => {
            let old_content = obj
                .get("beforeContentId")
                .and_then(|v| v.as_str())
                .and_then(|before_id| load_content_blob(conn, before_id));
            let new_content = obj
                .get("afterContentId")
                .and_then(|v| v.as_str())
                .and_then(|after_id| load_content_blob(conn, after_id));

            if let Some(text) = old_content.as_ref() {
                obj.insert("old_content".to_string(), Value::String(text.clone()));
            }
            if let Some(text) = new_content.as_ref() {
                obj.insert("new_content".to_string(), Value::String(text.clone()));
            }
            if let (Some(old_text), Some(new_text)) = (old_content.as_ref(), new_content.as_ref()) {
                let diff = build_cursor_edit_diff(old_text, new_text);
                obj.insert("linesAdded".to_string(), json!(diff.lines_added));
                obj.insert("linesRemoved".to_string(), json!(diff.lines_removed));
                if !diff.diff_string.is_empty() {
                    obj.insert("diffString".to_string(), Value::String(diff.diff_string));
                }
            }
        }
        // todo_write result puts the list under `finalTodos`; our extractor
        // reads `result.todos` (or `success.todos`).
        "manage_todo" => {
            if let Some(todos) = obj.remove("finalTodos") {
                obj.insert("todos".to_string(), todos);
            }
        }
        // task_v2 result is `{agentId: "<uuid>"}`. The `agentId` itself is
        // lifted onto `args.subagentSessionId` by `link_subagent_session`
        // so the Rust subagent extractor and the frontend `SubagentBlock` can
        // replay the child composer's events.
        "subagent" => {
            obj.entry("success".to_string())
                .or_insert(Value::Bool(true));
        }
        _ => {}
    }
}

/// Cross-field linkage step that runs after both args and result have been
/// normalized for the canonical tool. The only consumer today is `subagent`:
/// Cursor returns the spawned child composer's id under `result.agentId`,
/// but our subagent extractor reads `args.subagentSessionId`. We move-and-rename
/// the field here, prefixing it with `cursoride-` so the id is usable as a
/// top-level session id by the frontend EventStore lazy loader.
fn link_subagent_session(canonical: &str, args: &mut Value, result: &mut Value) {
    if canonical != "subagent" {
        return;
    }
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    let agent_id = match result_obj.remove("agentId") {
        Some(Value::String(value)) if !value.is_empty() => value,
        Some(other) => {
            // Not a string we can prefix — keep the original value on the
            // result so we don't silently drop data we don't understand.
            result_obj.insert("agentId".to_string(), other);
            return;
        }
        None => return,
    };
    let prefixed = format!("{}{}", CURSORIDE_SESSION_PREFIX, agent_id);
    if let Some(args_obj) = args.as_object_mut() {
        args_obj
            .entry("subagentSessionId".to_string())
            .or_insert(Value::String(prefixed));
    }
}

/// Translate Cursor's `ask_question` result payload into the shape our
/// `AskQuestionEvent` / `extractAnsweredData` expects.
fn resolve_ask_question_answers(canonical: &str, args: &Value, result: &mut Value) {
    if canonical != "ask_user_questions" {
        return;
    }
    let questions = args.get("questions").and_then(|v| v.as_array());
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };

    let raw_answers = match result_obj.remove("answers") {
        Some(Value::Array(arr)) => arr,
        Some(other) => {
            // Unknown shape — put it back and bail so we don't drop data.
            result_obj.insert("answers".to_string(), other);
            return;
        }
        None => return,
    };

    let mut converted: Vec<Value> = Vec::with_capacity(raw_answers.len());
    for (idx, answer) in raw_answers.into_iter().enumerate() {
        let option_id = match &answer {
            Value::Object(map) => map
                .get("questionId")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            Value::String(s) => Some(s.clone()),
            _ => None,
        };

        let label = option_id.as_ref().and_then(|id| {
            questions
                .and_then(|qs| qs.get(idx))
                .and_then(|q| q.get("options"))
                .and_then(|opts| opts.as_array())
                .and_then(|opts| {
                    opts.iter().find_map(|opt| {
                        let opt_id = opt.get("id").and_then(|v| v.as_str())?;
                        if opt_id == id {
                            opt.get("label")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                        } else {
                            None
                        }
                    })
                })
        });

        let final_text = label.or(option_id).unwrap_or_default();
        converted.push(Value::Array(vec![Value::String(final_text)]));
    }

    result_obj.insert("answers".to_string(), Value::Array(converted));
    result_obj
        .entry("status".to_string())
        .or_insert_with(|| Value::String("answered".to_string()));
}

struct CursorEditDiff {
    diff_string: String,
    lines_added: usize,
    lines_removed: usize,
}

fn build_cursor_edit_diff(old_content: &str, new_content: &str) -> CursorEditDiff {
    let text_diff = similar::TextDiff::from_lines(old_content, new_content);
    let diff_string = text_diff
        .unified_diff()
        .context_radius(3)
        .header("before", "after")
        .to_string();
    let mut lines_added = 0;
    let mut lines_removed = 0;
    for change in text_diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => lines_added += 1,
            similar::ChangeTag::Delete => lines_removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    CursorEditDiff {
        diff_string,
        lines_added,
        lines_removed,
    }
}

fn move_string_field(obj: &mut serde_json::Map<String, Value>, from: &str, to: &str) {
    if obj.contains_key(to) {
        return;
    }
    if let Some(Value::String(value)) = obj.get(from).cloned() {
        if !value.is_empty() {
            obj.insert(to.to_string(), Value::String(value));
        }
    }
}

/// Map a Cursor IDE tool's string id to our canonical tool name.
///
/// Unknown names pass through unchanged — the alias map and registry will
/// fall back to `tool_call` (`Fallback` block) for them.
pub(super) fn cursor_tool_name_to_canonical(name: &str) -> &str {
    match name {
        "read_file_v2" => "read_file",
        "edit_file_v2" => "edit_file_by_replace",
        "delete_file" => "delete_file",
        "run_terminal_command_v2" => "run_command_line",
        "glob_file_search" => "glob_file_search",
        "read_lints" => "query_lsp",
        "ripgrep_raw_search" => "grep",
        "semantic_search_full" => "codebase_search",
        "todo_write" => "manage_todo",
        "web_fetch" => "web_search",
        "task_v2" => "subagent",
        "ask_question" => "ask_user_questions",
        other => other,
    }
}

/// Cursor stores tool args/result as JSON-encoded strings. Parse them, and
/// fall back to a string-valued payload if parsing fails — never silently
/// drop the data.
pub(super) fn parse_inner_json(raw: &str) -> Value {
    if raw.is_empty() {
        return Value::Object(Default::default());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(_) => json!({ "raw": raw }),
    }
}

fn merge_cursor_additional_data(result: &mut Value, additional_data: &Value) {
    let additional = match additional_data.as_object() {
        Some(map) if !map.is_empty() => map,
        _ => return,
    };
    if !result.is_object() {
        *result = json!({ "value": result.clone() });
    }
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    for (key, value) in additional {
        result_obj.entry(key.clone()).or_insert(value.clone());
    }
}

/// Attach `call_id` and `status` to the tool result so the existing extractors
/// and chat blocks recognize it the same way they would a `cursor-agent` CLI
/// chunk. Never overwrites fields the inner JSON already provides.
fn enrich_tool_result(mut payload: Value, tfd: &RawToolFormerData) -> Value {
    if !payload.is_object() {
        payload = json!({ "value": payload });
    }
    if let Some(obj) = payload.as_object_mut() {
        if let Some(additional) = tfd.additional_data.as_object() {
            if !additional.is_empty() {
                obj.entry("cursorAdditionalData".to_string())
                    .or_insert_with(|| tfd.additional_data.clone());
            }
        }
        if !tfd.tool_call_id.is_empty() {
            obj.entry("call_id".to_string())
                .or_insert_with(|| Value::String(tfd.tool_call_id.clone()));
        }
        if !tfd.status.is_empty() {
            obj.entry("status".to_string())
                .or_insert_with(|| Value::String(tfd.status.clone()));
        }
    }
    payload
}
