pub mod cache;
pub mod managed_mirror;
pub mod managed_roots;
pub mod metadata;
pub mod paths;

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use chrono::TimeZone;
use core_types::activity::ActivityChunk;
use serde::Serialize;
use serde_json::{json, Value};

use self::metadata::ImportedHistoryImpactStats;

pub const IMPORTED_HISTORY_CATEGORY: &str = "external_history";
pub const IMPORTED_STATUS_COMPLETED: &str = "completed";
pub const ACTION_TYPE_RAW: &str = "raw";
pub const ACTION_TYPE_ASSISTANT: &str = "assistant";
pub const ACTION_TYPE_THINKING: &str = "thinking";
pub const ACTION_TYPE_TOOL_CALL: &str = "tool_call";
pub const FUNCTION_USER_MESSAGE: &str = "user_message";
pub const FUNCTION_ASSISTANT: &str = "assistant";
pub const FUNCTION_THINKING: &str = "thinking";
pub const FUNCTION_READ_FILE: &str = "read_file";
pub const FUNCTION_RUN_COMMAND_LINE: &str = "run_command_line";
pub const FUNCTION_EDIT_FILE: &str = "edit_file_by_replace";
pub const FUNCTION_CODE_SEARCH: &str = "grep";
pub const FUNCTION_GLOB_FILE_SEARCH: &str = "glob_file_search";
pub const DEFAULT_LIST_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportedHistoryLoader {
    ClaudeCode,
    Codex,
    Cursor,
    CursorCli,
    OpenCode,
    Windsurf,
    WorkBuddy,
    Trae,
    Cline,
    Warp,
    ZCode,
    Qoder,
}

fn imported_history_loader(session_id: &str) -> Option<ImportedHistoryLoader> {
    if session_id.starts_with(super::claude_code::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::ClaudeCode)
    } else if session_id.starts_with(super::codex::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Codex)
    } else if session_id.starts_with(super::cursor_ide::CURSORIDE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Cursor)
    } else if session_id.starts_with(super::cursor_cli::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::CursorCli)
    } else if session_id.starts_with(super::opencode::history::OPENCODE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::OpenCode)
    } else if session_id.starts_with(super::windsurf::history::WINDSURF_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Windsurf)
    } else if session_id.starts_with(super::workbuddy::WORKBUDDY_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::WorkBuddy)
    } else if session_id.starts_with(super::trae::history::TRAE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Trae)
    } else if session_id.starts_with(super::cline::history::CLINE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Cline)
    } else if session_id.starts_with(super::warp::history::WARP_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Warp)
    } else if session_id.starts_with(super::zcode::history::ZCODE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::ZCode)
    } else if session_id.starts_with(super::qoder::history::QODER_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Qoder)
    } else {
        None
    }
}

/// Load one imported provider session through its existing canonical history
/// reader. `None` means the id is not owned by an imported-history provider;
/// `Some(empty)` is a known provider session whose source currently has no
/// readable chunks.
///
/// This is the single provider router for cross-provider projections such as
/// per-round Orgtrack metadata. It deliberately delegates parsing to the
/// established source modules instead of introducing another transcript
/// reader.
pub fn load_activity_chunks_for_session(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<Vec<ActivityChunk>>, String> {
    let chunks = match imported_history_loader(session_id) {
        Some(ImportedHistoryLoader::ClaudeCode) => {
            super::claude_code::history::load_claude_code_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Codex) => {
            super::codex::app::load_codex_app_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Cursor) => {
            super::cursor_ide::history::load_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::CursorCli) => {
            super::cursor_cli::history::load_cursor_cli_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::OpenCode) => {
            super::opencode::history::load_opencode_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::Windsurf) => {
            super::windsurf::history::load_windsurf_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::WorkBuddy) => {
            super::workbuddy::load_workbuddy_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Trae) => {
            super::trae::history::load_trae_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Cline) => {
            super::cline::history::load_cline_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Warp) => {
            super::warp::history::load_warp_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::ZCode) => {
            super::zcode::history::load_zcode_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::Qoder) => {
            super::qoder::history::load_qoder_history_for_session(conn, session_id)?
        }
        None => return Ok(None),
    };
    Ok(Some(chunks))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionRow {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub category: &'static str,
    pub read_only: bool,
    pub model: Option<String>,
    pub total_tokens: i64,
    pub background: bool,
    pub is_active: bool,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySessionPage {
    pub sessions: Vec<ImportedHistorySessionRow>,
    pub has_more: bool,
}

/// Lightweight cached row for list-only surfaces such as the session sidebar.
/// Carries the impact/model fields that card surfaces (e.g. the Kanban board)
/// render inline; the heavier source metadata stays in SQLite until requested.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySidebarRow {
    pub session_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// Live status override (`running`, `waiting_for_user`, `failed`)
    /// decorated by the desktop layer from lifecycle-hook signals or the
    /// transcript-mtime fallback. Absent means the frontend's historical
    /// default ("completed") applies. The core query never sets these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// The source app's own transcript file — the store of record for an
    /// imported session, which never has a `sessions.db` copy. Absent for
    /// rows cached before the path was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub total_tokens: i64,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistorySidebarPage {
    pub sessions: Vec<ImportedHistorySidebarRow>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryRecentPath {
    pub path: String,
    pub name: Option<String>,
    pub last_used_at: String,
    pub session_count: usize,
}

pub struct ImportedHistoryRowInput {
    pub session_id: String,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub repo_path: Option<String>,
    pub storage_path: Option<String>,
    pub branch: Option<String>,
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImportedToolCall {
    pub call_id: String,
    pub raw_name: String,
    pub canonical_name: String,
    pub args: Value,
    pub created_at: String,
}

pub fn effective_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_LIST_LIMIT
    } else {
        limit
    }
}

pub fn page_from_rows(
    mut rows: Vec<ImportedHistorySessionRow>,
    limit: usize,
    offset: usize,
) -> ImportedHistorySessionPage {
    rows.sort_by(|session_a, session_b| session_b.updated_at.cmp(&session_a.updated_at));
    let limit = effective_limit(limit);
    let has_more = rows.len() > offset.saturating_add(limit);
    let sessions = rows.into_iter().skip(offset).take(limit).collect();
    ImportedHistorySessionPage { sessions, has_more }
}

pub fn row_from_input(input: ImportedHistoryRowInput) -> ImportedHistorySessionRow {
    let repo_name = input.repo_path.as_deref().and_then(repo_name_from_path);
    ImportedHistorySessionRow {
        session_id: input.session_id,
        name: input.name,
        status: IMPORTED_STATUS_COMPLETED.to_string(),
        created_at: epoch_ms_to_iso(input.created_at_ms),
        updated_at: epoch_ms_to_iso(input.updated_at_ms),
        category: IMPORTED_HISTORY_CATEGORY,
        read_only: true,
        model: input.model,
        total_tokens: input.input_tokens + input.output_tokens,
        background: false,
        is_active: false,
        repo_path: input.repo_path,
        storage_path: input.storage_path,
        repo_name,
        branch: input.branch,
        files_changed: input.files_changed,
        lines_added: input.lines_added,
        lines_removed: input.lines_removed,
        touched_files: input.touched_files,
        parent_session_id: input.parent_session_id,
    }
}

pub fn recent_paths_from_rows(
    rows: &[ImportedHistorySessionRow],
) -> Vec<ImportedHistoryRecentPath> {
    let paths = rows
        .iter()
        .filter_map(|row| {
            let path = row.repo_path.as_deref()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(ImportedHistoryRecentPath {
                path: path.to_string(),
                name: repo_name_from_path(path),
                last_used_at: row.updated_at.clone(),
                session_count: 1,
            })
        })
        .collect::<Vec<_>>();
    recent_paths_from_paths(&paths)
}

pub fn recent_paths_from_paths(
    paths: &[ImportedHistoryRecentPath],
) -> Vec<ImportedHistoryRecentPath> {
    let mut path_stats: HashMap<String, (Option<String>, String, usize)> = HashMap::new();

    for recent_path in paths {
        let path = recent_path.path.trim();
        if path.is_empty() {
            continue;
        }

        let entry = path_stats.entry(path.to_string()).or_insert_with(|| {
            (
                recent_path
                    .name
                    .clone()
                    .or_else(|| repo_name_from_path(path)),
                recent_path.last_used_at.clone(),
                0,
            )
        });
        if recent_path.last_used_at > entry.1 {
            entry.1 = recent_path.last_used_at.clone();
        }
        entry.2 += recent_path.session_count;
    }

    let mut recent_paths = path_stats
        .into_iter()
        .map(
            |(path, (name, last_used_at, session_count))| ImportedHistoryRecentPath {
                name,
                path,
                last_used_at,
                session_count,
            },
        )
        .collect::<Vec<_>>();
    recent_paths.sort_by(|path_a, path_b| path_b.last_used_at.cmp(&path_a.last_used_at));
    recent_paths
}

/// Internal wrapper blocks ORGII prepends to the prompt it hands the CLI:
/// the GUI exec-mode briefing and the IDE-context injection
/// (`inject_ide_context_into_prompt`). The CLI's native transcript stores
/// the full prompt verbatim, so replay readers must strip these to recover
/// what the user actually typed.
const INTERNAL_CONTEXT_BLOCKS: &[(&str, &str)] = &[
    ("<orgii_cli_exec_mode_bridge>", "</orgii_cli_exec_mode_bridge>"),
    ("<ide_context>", "</ide_context>"),
];

/// Repeatedly strip LEADING internal wrapper blocks (exec-mode briefing,
/// IDE context) from `text`, in any order.
///
/// If a known tag opens but never closes (e.g. a truncated title), the whole
/// remainder is treated as internal and `""` is returned — an unclosed
/// internal block never carries user-authored text after it.
pub fn strip_internal_context_blocks(text: &str) -> &str {
    let mut remaining = text;
    let mut stripped = false;
    'outer: loop {
        let candidate = remaining.trim_start();
        for (open, close) in INTERNAL_CONTEXT_BLOCKS {
            if let Some(rest) = candidate.strip_prefix(open) {
                match rest.find(close) {
                    Some(end) => {
                        remaining = &rest[end + close.len()..];
                        stripped = true;
                        continue 'outer;
                    }
                    None => return "",
                }
            }
        }
        break;
    }
    if stripped {
        remaining.trim_start()
    } else {
        text
    }
}

/// GUI-launched runs prefix the task with an internal exec-mode briefing;
/// strip it so titles/replay show only what the user typed.
///
/// Back-compat name: now also strips the `<ide_context>` injection via
/// [`strip_internal_context_blocks`].
pub fn strip_orgii_exec_mode_bridge(text: &str) -> &str {
    strip_internal_context_blocks(text)
}

pub fn user_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    // Single funnel for every imported reader's user bubbles: strip the
    // GUI exec-mode briefing and IDE-context injection here so no source
    // can leak them into replay.
    let message = strip_internal_context_blocks(message);
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_RAW, FUNCTION_USER_MESSAGE);
    chunk.chunk_id = format!("{provider_slug}-user-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "type": "user",
        "message": { "content": message, "role": "user" },
    });
    chunk
}

pub fn assistant_message_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    message: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_ASSISTANT, FUNCTION_ASSISTANT);
    chunk.chunk_id = format!("{provider_slug}-asst-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "observation": message,
        "content": message,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
    });
    chunk
}

pub fn thinking_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    created_at: &str,
    thought: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_THINKING, FUNCTION_THINKING);
    chunk.chunk_id = format!("{provider_slug}-thinking-{sequence}");
    chunk.created_at = created_at.to_string();
    chunk.result = json!({
        "thought": thought,
        "content": thought,
        "observation": thought,
        "is_delta": false,
    });
    chunk
}

pub fn tool_call_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
) -> ActivityChunk {
    let mut chunk = ActivityChunk::new(session_id, ACTION_TYPE_TOOL_CALL, &call.canonical_name);
    chunk.chunk_id = format!("{provider_slug}-tool-{sequence}-{}", call.call_id);
    chunk.created_at = call.created_at.clone();
    chunk.args = call.args.clone();
    chunk.result = json!({
        "success": true,
        "status": IMPORTED_STATUS_COMPLETED,
        "call_id": call.call_id,
        "output": output,
        "observation": output,
        "raw_tool_name": call.raw_name,
    });
    chunk
}

/// Derive conservative file-impact metadata from normalized edit tool calls.
///
/// Source loaders remain responsible for recognizing their native tool names and
/// reshaping them to [`FUNCTION_EDIT_FILE`]. This collector intentionally ignores
/// failed edits and only counts line changes when the source exposes a diff or
/// before/after text.
pub fn impact_from_edit_chunks(chunks: &[ActivityChunk]) -> ImportedHistoryImpactStats {
    let mut touched_files = BTreeSet::new();
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;

    for chunk in chunks {
        if chunk.action_type != ACTION_TYPE_TOOL_CALL
            || chunk.function != FUNCTION_EDIT_FILE
            || edit_chunk_failed(chunk)
        {
            continue;
        }

        collect_edit_paths(&chunk.args, &mut touched_files);

        if let Some(patch) = find_string(&chunk.args, &["patch", "diff"]) {
            collect_patch_paths(patch, &mut touched_files);
            let (added, removed) = count_patch_lines(patch);
            lines_added += added;
            lines_removed += removed;
            continue;
        }

        let old = find_string(
            &chunk.args,
            &[
                "old_string",
                "oldString",
                "old_text",
                "oldText",
                "old_content",
                "oldContent",
            ],
        )
        .or_else(|| {
            find_string(
                &chunk.result,
                &[
                    "old_content",
                    "oldContent",
                    "before_content",
                    "beforeContent",
                ],
            )
        });
        let new = find_string(
            &chunk.args,
            &[
                "new_string",
                "newString",
                "new_text",
                "newText",
                "new_content",
                "newContent",
                "content",
            ],
        )
        .or_else(|| {
            find_string(
                &chunk.result,
                &["new_content", "newContent", "after_content", "afterContent"],
            )
        });

        if old.is_some() || new.is_some() {
            lines_removed += old.map(nonempty_line_count).unwrap_or_default();
            lines_added += new.map(nonempty_line_count).unwrap_or_default();
        }
    }

    let touched_files = touched_files.into_iter().collect::<Vec<_>>();
    ImportedHistoryImpactStats {
        files_changed: touched_files.len() as i64,
        lines_added,
        lines_removed,
        touched_files,
    }
}

fn edit_chunk_failed(chunk: &ActivityChunk) -> bool {
    if chunk.result.get("success").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    chunk
        .result
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| {
            matches!(
                status.trim().to_ascii_lowercase().as_str(),
                "failed" | "error" | "cancelled" | "canceled" | "rejected"
            )
        })
}

fn collect_edit_paths(value: &Value, paths: &mut BTreeSet<String>) {
    const PATH_KEYS: &[&str] = &[
        "file_path",
        "filePath",
        "path",
        "targetFile",
        "relativeWorkspacePath",
    ];
    let Some(object) = value.as_object() else {
        return;
    };
    for key in PATH_KEYS {
        if let Some(path) = object.get(*key).and_then(Value::as_str) {
            insert_touched_path(path, paths);
        }
    }
    if let Some(payload) = object.get("payload") {
        collect_edit_paths(payload, paths);
    }
}

fn find_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(text) = object.get(*key).and_then(Value::as_str) {
            return Some(text);
        }
    }
    object
        .get("payload")
        .and_then(|payload| find_string(payload, keys))
}

fn collect_patch_paths(patch: &str, paths: &mut BTreeSet<String>) {
    for line in patch.lines() {
        let candidate = line
            .strip_prefix("*** Add File: ")
            .or_else(|| line.strip_prefix("*** Update File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
            .or_else(|| line.strip_prefix("*** Move to: "))
            .or_else(|| line.strip_prefix("rename from "))
            .or_else(|| line.strip_prefix("rename to "))
            .or_else(|| line.strip_prefix("+++ "))
            .or_else(|| line.strip_prefix("--- "));
        if let Some(candidate) = candidate {
            insert_touched_path(candidate, paths);
        }
    }
}

fn insert_touched_path(path: &str, paths: &mut BTreeSet<String>) {
    let path = path.trim().trim_matches('"');
    let path = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    if !path.is_empty() && path != "/dev/null" {
        paths.insert(path.to_string());
    }
}

fn count_patch_lines(patch: &str) -> (i64, i64) {
    patch.lines().fold((0, 0), |(added, removed), line| {
        if line.starts_with("+++") || line.starts_with("---") {
            (added, removed)
        } else if line.starts_with('+') {
            (added + 1, removed)
        } else if line.starts_with('-') {
            (added, removed + 1)
        } else {
            (added, removed)
        }
    })
}

fn nonempty_line_count(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

pub fn parse_inner_json(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "input": raw }))
}

pub fn parse_iso_to_epoch_ms_opt(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

pub fn normalize_created_at(raw: &str) -> String {
    if raw.is_empty() {
        return chrono::Utc::now().to_rfc3339();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        dt.with_timezone(&chrono::Utc).to_rfc3339()
    } else {
        raw.to_string()
    }
}

pub fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub fn repo_name_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
}

pub fn truncate_name(name: &str, max_len: usize) -> String {
    let trimmed = name.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

#[cfg(test)]
mod impact_tests {
    use super::*;

    #[test]
    fn routes_every_imported_provider_to_its_existing_history_loader() {
        let cases = [
            ("claudecodeapp-id", ImportedHistoryLoader::ClaudeCode),
            ("codexapp-id", ImportedHistoryLoader::Codex),
            ("cursoride-id", ImportedHistoryLoader::Cursor),
            ("cursorcliapp-id", ImportedHistoryLoader::CursorCli),
            ("opencodeapp-id", ImportedHistoryLoader::OpenCode),
            ("windsurfapp-id", ImportedHistoryLoader::Windsurf),
            ("workbuddyapp-id", ImportedHistoryLoader::WorkBuddy),
            ("traeapp-id", ImportedHistoryLoader::Trae),
            ("clineapp-id", ImportedHistoryLoader::Cline),
            ("warpapp-id", ImportedHistoryLoader::Warp),
            ("zcodeapp-id", ImportedHistoryLoader::ZCode),
            ("qoderapp-id", ImportedHistoryLoader::Qoder),
        ];

        for (session_id, expected) in cases {
            assert_eq!(imported_history_loader(session_id), Some(expected));
        }
        assert_eq!(imported_history_loader("org2-native-id"), None);
    }

    #[test]
    fn impact_collector_counts_normalized_edit_and_patch_paths() {
        let edit = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({
                "file_path": "src/main.rs",
                "old_string": "old\nline",
                "new_string": "new\nline\nadded"
            }))
            .with_result(json!({"success": true, "status": "completed"}));
        let patch = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({
                "payload": {"patch": "*** Update File: src/lib.rs\n*** Move to: src/moved.rs\n-old\n+new\n+extra"}
            }))
            .with_result(json!({"success": true}));

        let impact = impact_from_edit_chunks(&[edit, patch]);

        assert_eq!(
            impact.touched_files,
            vec!["src/lib.rs", "src/main.rs", "src/moved.rs"]
        );
        assert_eq!(impact.files_changed, 3);
        assert_eq!(impact.lines_added, 5);
        assert_eq!(impact.lines_removed, 3);
    }

    #[test]
    fn impact_collector_ignores_failed_edits() {
        let failed = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({"file_path": "src/failed.rs", "new_string": "new"}))
            .with_result(json!({"success": true, "status": "failed"}));

        assert_eq!(impact_from_edit_chunks(&[failed]).files_changed, 0);
    }
}
