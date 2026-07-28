//! Best-effort tool-trajectory enrichment from Qoder's per-launch logs.
//!
//! Qoder's durable transcript (`conversation-history/*.jsonl`) carries only
//! user/assistant text — tool calls stream live over ACP and are never written
//! to a unified store. What survives on disk, per app launch:
//!
//!   - `questWindow/agent.log` — ACP `tool_call` events (id + timestamp, no
//!     payload), `SubAgentService` registrations (subagent type, prompt,
//!     parent session id), and `ToolInvokeHandlerContribution` lines carrying
//!     tool name + args for locally-dispatched tools (`read_file`, …).
//!   - `questWindow/exthost/output_logging_*/1-Qoder.log` — `ToolInvoke :
//!     <name>` lines followed by the args JSON on the next line (terminal
//!     commands with their `cwd`, …).
//!   - `cache/projects/<proj>/agent-tools/<hash>/<hash>.txt` — spill files
//!     holding oversized tool outputs; the agent reads them back via
//!     `read_file`, which is how their content re-enters the trajectory.
//!
//! Only events that carry real payload are emitted (subagent spawns and tool
//! invocations with args) — bare ACP `tool_call` ids alone render as empty
//! cards and are used here solely for activity windows and call-id pairing.
//!
//! Invoke lines carry no session id, so attribution is by **content first**
//! (args paths inside the session's workspace or project cache dir), falling
//! back to the session's activity window when the paths say nothing — and
//! dropped when several sessions' windows overlap the timestamp. Logs rotate
//! per launch, so old sessions simply get no enrichment. Any failure degrades
//! to the unenriched transcript, never an error.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDateTime, TimeZone};
use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, metadata::ImportedHistoryImpactStats, ImportedToolCall,
};

use super::history::MAX_TOOL_OUTPUT_CHARS;

const ACP_PROGRESS_MARKER: &str = "[ChatSessionService] ACP progress: ";
const SUBAGENT_MARKER: &str = "[SubAgentService] Registered SubAgent: ";
const TOOL_INVOKE_MARKER: &str = "[ToolInvokeHandlerContribution] Tool invoke request: ";
const EXTHOST_INVOKE_MARKER: &str = " ToolInvoke : ";
const FILE_CHANGE_MARKER: &str = "[FileChangeTracking] ";
const SESSION_ID_SUFFIX: &str = ".session.execution";
/// Pad around a session's first/last ACP event when window-attributing
/// invoke lines with no content signal.
const WINDOW_PAD_MS: i64 = 2_000;
/// An invoke usually trails its ACP `tool_call` event by well under a second;
/// pair them within this window to recover the call id.
const CALL_ID_PAIR_MS: i64 = 2_500;

#[derive(Debug, Clone)]
enum LogEvent {
    /// Any ACP progress line; `tool_call_id` set only for `type=tool_call`.
    Acp {
        ts_ms: i64,
        session_task_id: String,
        tool_call_id: Option<String>,
    },
    /// `Registered SubAgent: {parentToolCallId, parentSessionId, agentType, …}`
    Subagent {
        ts_ms: i64,
        session_task_id: String,
        tool_call_id: String,
        agent_type: String,
        description: String,
        prompt: String,
    },
    /// A tool invocation with name + args — carries NO session id.
    ToolInvoke {
        ts_ms: i64,
        name: String,
        args: Value,
    },
    /// `[FileChangeTracking] <path> | source=agent | session=<taskDir>, … | Agent <op>` —
    /// an agent file edit, carrying the session as the truncated dir name.
    FileEdit {
        ts_ms: i64,
        session_dir_name: String,
        path: String,
        operation: String,
    },
}

/// Which session an invoke's args point at, judged purely by its paths.
#[derive(Debug, PartialEq)]
enum ContentSignal {
    Ours,
    Theirs,
    Silent,
}

type EditSnapshotMap = HashMap<String, (String, String)>;

/// Enrich a session's text-only chunks with the tool trajectory recovered
/// from Qoder's launch logs. `task_dir_name`/`project_dir_name` are the
/// conversation-history composite id halves; `workspace_path` is the
/// session's workspace when known (used for exact cwd attribution).
pub(super) fn enrich_with_agent_log(
    session_id: &str,
    task_dir_name: &str,
    project_dir_name: &str,
    workspace_path: Option<&str>,
    chunks: Vec<ActivityChunk>,
) -> Vec<ActivityChunk> {
    let mut events = Vec::new();
    for log_path in qoder_launch_log_paths() {
        if let Ok(content) = fs::read_to_string(&log_path) {
            parse_launch_log(&content, &mut events);
        }
    }
    enrich_chunks_with_events(
        session_id,
        task_dir_name,
        project_dir_name,
        workspace_path,
        chunks,
        &events,
        &edit_snapshots_for_task,
    )
}

fn enrich_chunks_with_events(
    session_id: &str,
    task_dir_name: &str,
    project_dir_name: &str,
    workspace_path: Option<&str>,
    chunks: Vec<ActivityChunk>,
    events: &[LogEvent],
    edit_snapshots: &dyn Fn(&str) -> EditSnapshotMap,
) -> Vec<ActivityChunk> {
    // Resolve the truncated dir name to the full task id seen in the logs.
    // Two distinct matches would mean we cannot tell the sessions apart —
    // back off rather than guess.
    let mut matched_task_id: Option<&str> = None;
    for event in events {
        let candidate = match event {
            LogEvent::Acp {
                session_task_id, ..
            }
            | LogEvent::Subagent {
                session_task_id, ..
            } => session_task_id,
            // Invoke lines carry no id; FileEdit lines carry only the
            // truncated dir name, which cannot disambiguate a prefix clash.
            LogEvent::ToolInvoke { .. } | LogEvent::FileEdit { .. } => continue,
        };
        if !candidate.starts_with(task_dir_name) {
            continue;
        }
        match matched_task_id {
            None => matched_task_id = Some(candidate),
            Some(existing) if existing == candidate => {}
            Some(_) => return chunks,
        }
    }
    let Some(task_id) = matched_task_id else {
        return chunks;
    };

    // Activity window per session, for invoke lines whose paths say nothing.
    let mut windows: HashMap<&str, (i64, i64)> = HashMap::new();
    for event in events {
        if let LogEvent::Acp {
            ts_ms,
            session_task_id,
            ..
        } = event
        {
            windows
                .entry(session_task_id.as_str())
                .and_modify(|(lo, hi)| {
                    *lo = (*lo).min(*ts_ms);
                    *hi = (*hi).max(*ts_ms);
                })
                .or_insert((*ts_ms, *ts_ms));
        }
    }
    let our_window = windows
        .get(task_id)
        .map(|(lo, hi)| (lo - WINDOW_PAD_MS, hi + WINDOW_PAD_MS));
    let other_windows: Vec<(i64, i64)> = windows
        .iter()
        .filter(|(sid, _)| **sid != task_id)
        .map(|(_, (lo, hi))| (lo - WINDOW_PAD_MS, hi + WINDOW_PAD_MS))
        .collect();

    // Our ACP tool_call ids, kept only to pair invokes back to a call id and
    // to anchor subagent cards — never emitted bare (an id alone renders as an
    // empty card).
    let mut our_acp_calls: Vec<(i64, &str)> = events
        .iter()
        .filter_map(|event| match event {
            LogEvent::Acp {
                ts_ms,
                session_task_id,
                tool_call_id: Some(id),
            } if session_task_id == task_id => Some((*ts_ms, id.as_str())),
            _ => None,
        })
        .collect();
    our_acp_calls.sort_by_key(|(ts, _)| *ts);

    #[derive(Debug)]
    struct PendingTool {
        ts_ms: i64,
        call_id: String,
        name: String,
        args: Value,
        output: String,
    }
    let mut pending: Vec<PendingTool> = Vec::new();

    for event in events {
        match event {
            LogEvent::Subagent {
                ts_ms,
                session_task_id,
                tool_call_id,
                agent_type,
                description,
                prompt,
            } if session_task_id == task_id => {
                pending.push(PendingTool {
                    ts_ms: *ts_ms,
                    call_id: tool_call_id.clone(),
                    name: "subagent".to_string(),
                    args: json!({
                        "agentType": agent_type,
                        "description": description,
                        "prompt": prompt,
                    }),
                    output: String::new(),
                });
            }
            LogEvent::ToolInvoke { ts_ms, name, args } => {
                let owned = match invoke_content_signal(args, project_dir_name, workspace_path) {
                    ContentSignal::Ours => true,
                    ContentSignal::Theirs => false,
                    ContentSignal::Silent => {
                        // No path signal: fall back to the activity window,
                        // requiring it to be unambiguous.
                        our_window.is_some_and(|(lo, hi)| *ts_ms >= lo && *ts_ms <= hi)
                            && !other_windows
                                .iter()
                                .any(|(lo, hi)| *ts_ms >= *lo && *ts_ms <= *hi)
                    }
                };
                if !owned {
                    continue;
                }
                let call_id = paired_call_id(&our_acp_calls, *ts_ms)
                    .unwrap_or_else(|| format!("invoke-{ts_ms}"));
                pending.push(PendingTool {
                    ts_ms: *ts_ms,
                    call_id,
                    name: name.clone(),
                    args: args.clone(),
                    output: spill_file_output(args),
                });
            }
            LogEvent::FileEdit {
                ts_ms,
                session_dir_name,
                path,
                operation,
            } if session_dir_name == task_dir_name => {
                // The tracking line carries the session directly, but no
                // content — the card still renders as a typed edit of the
                // file. The diff body is not recoverable from any local store.
                let call_id = paired_call_id(&our_acp_calls, *ts_ms)
                    .unwrap_or_else(|| format!("edit-{ts_ms}"));
                pending.push(PendingTool {
                    ts_ms: *ts_ms,
                    call_id,
                    name: format!("file_{operation}"),
                    args: json!({ "file_path": path, "operation": operation }),
                    output: String::new(),
                });
            }
            _ => {}
        }
    }

    if pending.is_empty() {
        return chunks;
    }
    pending.sort_by_key(|tool| tool.ts_ms);
    // The same invocation can be logged by both the workbench and the exthost;
    // collapse near-simultaneous duplicates.
    pending.dedup_by(|a, b| {
        a.name == b.name && a.args == b.args && (a.ts_ms - b.ts_ms).abs() <= 2_000
    });

    // Attach real diff bodies from the chat-editing snapshot store. The store
    // keeps one original→current pair per file spanning the whole session, so
    // it lands on the file's LAST edit card; earlier edits of the same file
    // stay operation markers.
    if pending.iter().any(|tool| tool.name.starts_with("file_")) {
        let snapshots = edit_snapshots(task_id);
        let mut attached: std::collections::HashSet<String> = std::collections::HashSet::new();
        for tool in pending.iter_mut().rev() {
            if !tool.name.starts_with("file_") {
                continue;
            }
            let Some(path) = tool.args.get("file_path").and_then(Value::as_str) else {
                continue;
            };
            if attached.contains(path) {
                continue;
            }
            if let Some((old_content, new_content)) = snapshots.get(path) {
                attached.insert(path.to_string());
                if let Some(map) = tool.args.as_object_mut() {
                    map.insert("old_string".to_string(), json!(old_content));
                    map.insert("new_string".to_string(), json!(new_content));
                }
            }
        }
    }

    let mut tool_chunks = Vec::with_capacity(pending.len());
    for (index, tool) in pending.iter().enumerate() {
        let call = ImportedToolCall {
            call_id: tool.call_id.clone(),
            raw_name: tool.name.clone(),
            canonical_name: canonical_tool_name(&tool.name),
            args: normalized_args(&tool.name, &tool.args),
            created_at: imported_history::epoch_ms_to_iso(tool.ts_ms),
        };
        let mut chunk =
            imported_history::tool_call_chunk(session_id, "qoder-log", index, &call, &tool.output);
        if let Some(result) = chunk.result.as_object_mut() {
            // Flag the provenance so consumers can tell recovered trajectory
            // from the durable transcript.
            result.insert("recovered_from".to_string(), json!("agent_log"));
        }
        tool_chunks.push(chunk);
    }

    // Insert after the last user message: quests are single-user-turn in the
    // normal case, and the recovered activity belongs to the agent's work
    // phase that follows it. Multi-turn sessions get the whole trajectory in
    // the final turn — a documented best-effort placement.
    let insert_at = chunks
        .iter()
        .rposition(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .map(|position| position + 1)
        .unwrap_or(0);
    let mut enriched = chunks;
    enriched.splice(insert_at..insert_at, tool_chunks);
    enriched
}

/// Judge which session an invoke belongs to from the paths in its args.
/// `file_path` under a project cache dir or `cwd` inside the workspace are
/// decisive; paths that name a *different* project cache dir disown it.
fn invoke_content_signal(
    args: &Value,
    project_dir_name: &str,
    workspace_path: Option<&str>,
) -> ContentSignal {
    let candidates = ["file_path", "cwd", "path"]
        .iter()
        .filter_map(|key| args.get(*key).and_then(Value::as_str));
    let our_cache_dir =
        normalize_path_for_matching(&format!("/cache/projects/{project_dir_name}/"));
    let mut signal = ContentSignal::Silent;
    for path in candidates {
        let normalized_path = normalize_path_for_matching(path);
        if normalized_path.contains(&our_cache_dir) {
            return ContentSignal::Ours;
        }
        if let Some(workspace) = workspace_path {
            let workspace = normalize_path_for_matching(workspace);
            let workspace = workspace.trim_end_matches('/');
            if !workspace.is_empty()
                && (normalized_path == workspace
                    || normalized_path.starts_with(&format!("{workspace}/")))
            {
                return ContentSignal::Ours;
            }
        }
        if normalized_path.contains("/cache/projects/") {
            signal = ContentSignal::Theirs;
        }
    }
    signal
}

fn normalize_path_for_matching(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

/// Most recent ACP `tool_call` id preceding `ts_ms` within the pairing window.
fn paired_call_id(our_acp_calls: &[(i64, &str)], ts_ms: i64) -> Option<String> {
    our_acp_calls
        .iter()
        .rev()
        .find(|(acp_ts, _)| *acp_ts <= ts_ms && ts_ms - acp_ts <= CALL_ID_PAIR_MS)
        .map(|(_, id)| (*id).to_string())
}

/// Map Qoder tool names onto the canonical functions the replay UI has typed
/// cards for; unknown names pass through as generic cards.
fn canonical_tool_name(name: &str) -> String {
    match name {
        "read_file" => imported_history::FUNCTION_READ_FILE.to_string(),
        "run_in_terminal" => imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
        // Qoder's diagnostics probe ↔ ORGII's LSP query card.
        "get_problems" => "query_lsp".to_string(),
        // Our own synthesis of FileChangeTracking ops (file_create, file_edit, …).
        name if name.starts_with("file_") => imported_history::FUNCTION_EDIT_FILE.to_string(),
        other => other.to_string(),
    }
}

/// Reshape args into the keys the frontend extractors read.
fn normalized_args(name: &str, args: &Value) -> Value {
    if name == "run_in_terminal" {
        if let Some(command) = args.get("command") {
            let mut merged = args.clone();
            if let Some(map) = merged.as_object_mut() {
                map.insert("cmd".to_string(), command.clone());
            }
            return merged;
        }
    }
    if name == "get_problems" {
        // `{"filePaths": [...], "file_paths": [...]}` → surface the first
        // path under the key the file extractors read.
        let first_path = ["filePaths", "file_paths"]
            .iter()
            .filter_map(|key| args.get(*key).and_then(Value::as_array))
            .flat_map(|paths| paths.iter())
            .find_map(Value::as_str);
        if let Some(path) = first_path {
            let mut merged = args.clone();
            if let Some(map) = merged.as_object_mut() {
                map.insert("file_path".to_string(), json!(path));
            }
            return merged;
        }
    }
    args.clone()
}

/// When a `read_file` targets an `agent-tools` spill file, its content is the
/// missing tool OUTPUT — attach it (capped). Other paths are live workspace
/// files that may have changed since; leave those empty.
fn spill_file_output(args: &Value) -> String {
    let Some(path) = args.get("file_path").and_then(Value::as_str) else {
        return String::new();
    };
    if !normalize_path_for_matching(path).contains("/agent-tools/") {
        return String::new();
    }
    let Ok(content) = fs::read_to_string(Path::new(path)) else {
        return String::new();
    };
    if content.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        let truncated: String = content.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        format!("{truncated}\n… (truncated)")
    } else {
        content.trim_end().to_string()
    }
}

/// Parse one launch log (agent.log or an exthost output log — the markers are
/// disjoint, so one parser handles both).
fn parse_launch_log(content: &str, events: &mut Vec<LogEvent>) {
    let mut lines = content.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(ts_ms) = parse_line_timestamp_ms(line) else {
            continue;
        };
        if let Some(rest) = substring_after(line, ACP_PROGRESS_MARKER) {
            // `<sessionId>, rid=<rid>, type=<type>[, toolCallId=<id>]`
            let mut session_task_id = String::new();
            let mut event_type = "";
            let mut tool_call_id = "";
            for (index, part) in rest.split(", ").enumerate() {
                if index == 0 {
                    session_task_id = part.trim().trim_end_matches(SESSION_ID_SUFFIX).to_string();
                } else if let Some(value) = part.trim().strip_prefix("type=") {
                    event_type = value;
                } else if let Some(value) = part.trim().strip_prefix("toolCallId=") {
                    tool_call_id = value;
                }
            }
            if session_task_id.is_empty() {
                continue;
            }
            let tool_call_id = (event_type == "tool_call" && !tool_call_id.is_empty())
                .then(|| tool_call_id.to_string());
            events.push(LogEvent::Acp {
                ts_ms,
                session_task_id,
                tool_call_id,
            });
        } else if let Some(rest) = substring_after(line, SUBAGENT_MARKER) {
            let Ok(payload) = serde_json::from_str::<Value>(rest.trim()) else {
                continue;
            };
            let field = |key: &str| {
                payload
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            let session_task_id = field("parentSessionId")
                .trim_end_matches(SESSION_ID_SUFFIX)
                .to_string();
            let tool_call_id = field("parentToolCallId");
            if session_task_id.is_empty() || tool_call_id.is_empty() {
                continue;
            }
            events.push(LogEvent::Subagent {
                ts_ms,
                session_task_id,
                tool_call_id,
                agent_type: field("agentType"),
                description: field("rawInputDescription"),
                prompt: field("prompt"),
            });
        } else if let Some(rest) = substring_after(line, TOOL_INVOKE_MARKER) {
            // agent.log: `<rid>, <name>, {args json}` — args may contain
            // ", " so split only the first two fields.
            let Some((_rid, rest)) = rest.split_once(", ") else {
                continue;
            };
            let Some((name, args_raw)) = rest.split_once(", ") else {
                continue;
            };
            push_invoke(events, ts_ms, name, args_raw);
        } else if let Some(rest) = substring_after(line, FILE_CHANGE_MARKER) {
            // `<path> | source=agent | session=<taskDir>, request=<rid> | Agent <op>`
            // (the marker also logs a pipe-less "Agent file tracked:" shape —
            // the parts count filters that out).
            let parts: Vec<&str> = rest.split(" | ").collect();
            if parts.len() < 4 || !parts.contains(&"source=agent") {
                continue;
            }
            let path = parts[0].trim();
            let session_dir_name = parts
                .iter()
                .flat_map(|part| part.split(", "))
                .find_map(|field| field.trim().strip_prefix("session="));
            let operation = parts
                .last()
                .and_then(|part| part.trim().strip_prefix("Agent "))
                .map(str::trim)
                .filter(|op| !op.is_empty());
            let (Some(session_dir_name), Some(operation)) = (session_dir_name, operation) else {
                continue;
            };
            if path.is_empty() {
                continue;
            }
            events.push(LogEvent::FileEdit {
                ts_ms,
                session_dir_name: session_dir_name.to_string(),
                path: path.to_string(),
                operation: operation.to_string(),
            });
        } else if let Some(name) = substring_after(line, EXTHOST_INVOKE_MARKER) {
            // exthost log: `<ts> [info] ToolInvoke : <name>` with the args
            // JSON on the following line.
            let Some(args_line) = lines.peek() else {
                continue;
            };
            if args_line.trim_start().starts_with('{') {
                let args_raw = lines.next().unwrap_or_default();
                push_invoke(events, ts_ms, name, args_raw);
            }
        }
    }
}

fn push_invoke(events: &mut Vec<LogEvent>, ts_ms: i64, name: &str, args_raw: &str) {
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    let args = serde_json::from_str(args_raw.trim()).unwrap_or(Value::Null);
    events.push(LogEvent::ToolInvoke {
        ts_ms,
        name: name.to_string(),
        args,
    });
}

/// Real before/after contents for the files a session edited, from VS Code's
/// chat-editing snapshot store:
/// `workspaceStorage/<ws>/chatEditingSessions/<taskId>.session.execution/`
/// holds a `state.json` mapping each resource to `originalHash`/`currentHash`,
/// with the content-addressed snapshot bodies under `contents/<hash>`.
/// Returns `path → (old_content, new_content)`.
fn edit_snapshots_for_task(task_id: &str) -> HashMap<String, (String, String)> {
    edit_snapshots(task_id, Some(task_id))
}

fn edit_snapshots(
    task_dir_name: &str,
    full_task_id: Option<&str>,
) -> HashMap<String, (String, String)> {
    let mut snapshots = HashMap::new();
    for dir in edit_store_paths(&qoder_workspace_storage_dirs(), task_dir_name, full_task_id) {
        for (path, contents) in edit_snapshots_from_session_dir(&dir) {
            snapshots.entry(path).or_insert(contents);
        }
    }
    snapshots
}

/// Per-session file impact (`files changed / +lines / -lines`) derived from
/// the chat-editing snapshot store — the durable transcript carries no edit
/// data, so the sidebar/kanban counts come from here. Zeroed when no store
/// survives for the session.
pub(super) fn session_edit_impact(
    task_dir_name: &str,
    full_task_id: Option<&str>,
) -> ImportedHistoryImpactStats {
    impact_from_snapshots(&edit_snapshots(task_dir_name, full_task_id))
}

fn impact_from_snapshots(
    snapshots: &HashMap<String, (String, String)>,
) -> ImportedHistoryImpactStats {
    let mut touched_files: Vec<String> = snapshots.keys().cloned().collect();
    touched_files.sort();
    let (mut lines_added, mut lines_removed) = (0_i64, 0_i64);
    for (old_content, new_content) in snapshots.values() {
        let (added, removed) = numstat_between(old_content, new_content);
        lines_added += added;
        lines_removed += removed;
    }
    ImportedHistoryImpactStats {
        files_changed: touched_files.len() as i64,
        lines_added,
        lines_removed,
        touched_files,
    }
}

/// Real line-level numstat between two full file bodies.
fn numstat_between(old_content: &str, new_content: &str) -> (i64, i64) {
    similar::TextDiff::from_lines(old_content, new_content)
        .iter_all_changes()
        .fold((0, 0), |(added, removed), change| match change.tag() {
            similar::ChangeTag::Insert => (added + 1, removed),
            similar::ChangeTag::Delete => (added, removed + 1),
            similar::ChangeTag::Equal => (added, removed),
        })
}

/// Change-signature of the session's edit store (`state.json` mtime+size per
/// workspace). Folded into the discovery fingerprint so edits that land after
/// a sync re-parse the session even when the transcript itself is unchanged.
pub(super) fn edit_store_signature(task_dir_name: &str, full_task_id: Option<&str>) -> String {
    edit_store_paths(&qoder_workspace_storage_dirs(), task_dir_name, full_task_id)
        .iter()
        .filter_map(|dir| {
            let metadata = fs::metadata(dir.join("state.json")).ok()?;
            let mtime_ns = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_nanos() as i64)
                .unwrap_or_default();
            Some(format!("{mtime_ns}:{}", metadata.len()))
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// The session's chat-editing store dirs across every workspace. With only a
/// truncated dir name, a prefix that matches two DISTINCT task ids is
/// ambiguous and resolves to nothing.
fn edit_store_paths(
    storage_dirs: &[PathBuf],
    task_dir_name: &str,
    full_task_id: Option<&str>,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut distinct_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for storage in storage_dirs {
        let Ok(workspace_entries) = fs::read_dir(storage) else {
            continue;
        };
        for workspace in workspace_entries.flatten() {
            let base = workspace.path().join("chatEditingSessions");
            if let Some(task_id) = full_task_id {
                let dir = base.join(format!("{task_id}{SESSION_ID_SUFFIX}"));
                if dir.join("state.json").is_file() {
                    found.push(dir);
                }
                continue;
            }
            let Ok(session_entries) = fs::read_dir(&base) else {
                continue;
            };
            for session_entry in session_entries.flatten() {
                let name = session_entry.file_name().to_string_lossy().to_string();
                let Some(task_id) = name.strip_suffix(SESSION_ID_SUFFIX) else {
                    continue;
                };
                if task_id.starts_with(task_dir_name) {
                    distinct_ids.insert(task_id.to_string());
                    found.push(session_entry.path());
                }
            }
        }
    }
    if full_task_id.is_none() && distinct_ids.len() > 1 {
        return Vec::new();
    }
    found
}

/// `<data root>/Qoder/User/workspaceStorage` candidates.
fn qoder_workspace_storage_dirs() -> Vec<PathBuf> {
    let mut roots = vec![
        app_paths::external_history_data_dir(),
        app_paths::external_history_config_dir(),
    ];
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .map(|root| root.join("Qoder").join("User").join("workspaceStorage"))
        .collect()
}

fn edit_snapshots_from_session_dir(session_dir: &Path) -> HashMap<String, (String, String)> {
    let mut snapshots = HashMap::new();
    let Ok(raw) = fs::read_to_string(session_dir.join("state.json")) else {
        return snapshots;
    };
    let Ok(state) = serde_json::from_str::<Value>(&raw) else {
        return snapshots;
    };
    let Some(entries) = state
        .get("recentSnapshot")
        .and_then(|snapshot| snapshot.get("entries"))
        .and_then(Value::as_array)
    else {
        return snapshots;
    };
    for entry in entries {
        let Some(resource) = entry.get("resource").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = file_uri_to_path(resource) else {
            continue;
        };
        let content_for = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .map(|hash| read_snapshot_content(session_dir, hash))
                .unwrap_or_default()
        };
        let old_content = content_for("originalHash");
        let new_content = content_for("currentHash");
        if old_content.is_empty() && new_content.is_empty() {
            continue;
        }
        snapshots.insert(path, (old_content, new_content));
    }
    snapshots
}

fn read_snapshot_content(session_dir: &Path, hash: &str) -> String {
    if hash.is_empty() {
        return String::new();
    }
    let Ok(content) = fs::read_to_string(session_dir.join("contents").join(hash)) else {
        return String::new();
    };
    if content.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        content.chars().take(MAX_TOOL_OUTPUT_CHARS).collect()
    } else {
        content
    }
}

/// `file:///a/b%20c.py` → `/a/b c.py`.
fn file_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    Some(percent_decode(rest))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            // Both hex digits are ASCII, so this byte-range slice is safe.
            if let Ok(byte) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Log lines open with `YYYY-MM-DD HH:MM:SS.mmm` in local time.
fn parse_line_timestamp_ms(line: &str) -> Option<i64> {
    let raw = line.get(..23)?;
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.3f").ok()?;
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp_millis())
}

fn substring_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|at| &line[at + marker.len()..])
}

/// Every trajectory-bearing log across launch folders:
/// `<data>/Qoder/logs/<ts>/questWindow/agent.log` and
/// `<data>/Qoder/logs/<ts>/questWindow/exthost/output_logging_*/1-Qoder.log`.
fn qoder_launch_log_paths() -> Vec<PathBuf> {
    let mut roots = vec![
        app_paths::external_history_data_dir(),
        app_paths::external_history_config_dir(),
    ];
    roots.sort();
    roots.dedup();

    let mut logs = Vec::new();
    for root in roots {
        let logs_dir = root.join("Qoder").join("logs");
        let Ok(entries) = fs::read_dir(&logs_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let quest_window = entry.path().join("questWindow");
            let agent_log = quest_window.join("agent.log");
            if agent_log.is_file() {
                logs.push(agent_log);
            }
            let exthost = quest_window.join("exthost");
            let Ok(exthost_entries) = fs::read_dir(&exthost) else {
                continue;
            };
            for exthost_entry in exthost_entries.flatten() {
                if !exthost_entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("output_logging")
                {
                    continue;
                }
                let candidate = exthost_entry.path().join("1-Qoder.log");
                if candidate.is_file() {
                    logs.push(candidate);
                }
            }
        }
    }
    logs
}

#[cfg(test)]
#[path = "log_enrichment_tests.rs"]
mod tests;
