//! Shared ACP (Agent Client Protocol) logic for agents using JSON-RPC over stdin/stdout.
//!
//! Both Copilot and Kiro use ACP. This module contains the generic protocol handling;
//! agent-specific behavior is provided via the `AcpAgentAdapter` trait.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};

use core_types::activity::ActivityChunk;

/// Pending approval response: approved (true) or denied (false).
pub struct ApprovalResponse {
    pub approved: bool,
    pub always_allow: bool,
}

type PendingApprovalsMap = HashMap<String, oneshot::Sender<ApprovalResponse>>;

/// Global registry of pending approval requests (session_id → oneshot sender).
/// When the frontend approves/denies, the Tauri command resolves the channel.
pub static PENDING_APPROVALS: std::sync::LazyLock<Arc<Mutex<PendingApprovalsMap>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Resolve a pending approval request for a session.
/// Called by the Tauri command when the user approves or denies.
pub async fn resolve_approval(
    session_id: &str,
    approved: bool,
    always_allow: bool,
) -> Result<(), String> {
    let tx = PENDING_APPROVALS
        .lock()
        .await
        .remove(session_id)
        .ok_or_else(|| format!("No pending approval for session {}", session_id))?;
    tx.send(ApprovalResponse {
        approved,
        always_allow,
    })
    .map_err(|_| "Approval channel closed".to_string())
}

/// ACP major protocol version.
const ACP_PROTOCOL_VERSION: u32 = 1;

/// Truncate a string to at most `max_chars` characters (UTF-8 safe).
/// Appends "..." if truncated.
fn truncate_str_safe(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

// ============================================
// Trait: Agent-specific ACP behavior
// ============================================

/// Agent-specific behavior for ACP protocol.
/// Implement this trait to customize tool name mapping and handle custom notifications.
pub trait AcpAgentAdapter: Send {
    /// Map ACP tool_call `kind` to Cursor-normalized tool name.
    /// Default handles standard ACP kinds (execute, read, write, etc.).
    fn map_tool_kind(&self, kind: &str, _raw_input: &Value) -> String {
        match kind {
            "execute" => "Shell",
            "read" => "Read",
            "write" | "edit" => "Edit",
            "search" => "Grep",
            "delete" => "Delete",
            "fetch" => "WebFetch",
            "other" => "Task",
            _ => kind,
        }
        .to_string()
    }

    /// Handle agent-specific notifications (non-standard methods like `_kiro.dev/*`).
    /// Return chunks to emit, or empty vec to ignore.
    fn handle_custom_notification(&mut self, _method: &str, _params: &Value) -> Vec<ActivityChunk> {
        vec![]
    }

    fn map_tool_result_chunk(
        &self,
        _session_id: &str,
        _cursor_name: &str,
        _result_text: &str,
        _is_error: bool,
    ) -> Option<ActivityChunk> {
        None
    }

    fn should_emit_tool_start(&self, _cursor_name: &str) -> bool {
        true
    }

    fn should_emit_tool_result(
        &self,
        _cursor_name: &str,
        _result_text: &str,
        _is_error: bool,
    ) -> bool {
        true
    }
}

// ============================================
// Types
// ============================================

/// Result from a completed ACP session.
pub struct AcpSessionResult {
    /// The ACP session ID (for resume via `session/load`).
    pub acp_session_id: String,
    /// Why the prompt turn ended (e.g. "end_turn", "cancelled").
    pub stop_reason: String,
}

/// Data stored from a tool_call start event, used when the tool_call_update arrives.
struct PendingToolCall {
    cursor_name: String,
    file_path: String,
    raw_input: Value,
}

// ============================================
// Tool Result Helpers
// ============================================

fn count_diff_lines(diff: &str) -> (usize, usize) {
    let mut added: usize = 0;
    let mut removed: usize = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

fn extract_edit_content(raw_input: &Value) -> Option<String> {
    for key in &[
        "new_string",
        "newString",
        "newStr",
        "new_text",
        "newText",
        "content",
        "text",
        "file_text",
        "fileText",
        "fileContent",
        "file_content",
        "body",
    ] {
        if let Some(text) = raw_input.get(*key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

const SYNTHETIC_DIFF_CONTEXT_LINES: usize = 2;

fn synthesize_diff(path: &str, old_text: &str, new_text: &str) -> (String, usize, usize) {
    let result = perf_utils::diff_patch::compute_diff(
        old_text.to_string(),
        new_text.to_string(),
        Some(format!("a/{}", path)),
        Some(format!("b/{}", path)),
        Some(perf_utils::diff_patch::DiffOptions {
            algorithm: None,
            context_lines: Some(SYNTHETIC_DIFF_CONTEXT_LINES),
            format: None,
        }),
    )
    .expect("synthetic diff computation should not fail");

    (
        result.diff,
        result.stats.lines_added,
        result.stats.lines_removed,
    )
}

fn normalize_tool_result(
    cursor_name: &str,
    result_text: &str,
    detailed_text: &str,
    is_error: bool,
    pending: Option<&PendingToolCall>,
) -> Value {
    match cursor_name {
        "Shell" => {
            if is_error {
                serde_json::json!({"error": {"stdout": result_text, "stderr": ""}})
            } else {
                serde_json::json!({"success": {"exitCode": 0, "stdout": result_text, "stderr": ""}})
            }
        }
        "Edit" => {
            let file_path = pending.map(|pt| pt.file_path.as_str()).unwrap_or("");
            let diff_source = if !detailed_text.is_empty() {
                detailed_text
            } else {
                result_text
            };
            let (lines_added, lines_removed) = count_diff_lines(diff_source);

            if lines_added > 0 || lines_removed > 0 {
                serde_json::json!({
                    "success": {
                        "path": file_path,
                        "linesAdded": lines_added,
                        "linesRemoved": lines_removed,
                        "diffString": diff_source,
                    }
                })
            } else {
                let new_content = pending.and_then(|pt| extract_edit_content(&pt.raw_input));
                let old_content = pending.and_then(|pt| {
                    pt.raw_input
                        .get("old_string")
                        .or(pt.raw_input.get("oldString"))
                        .or(pt.raw_input.get("oldStr"))
                        .or(pt.raw_input.get("old_text"))
                        .or(pt.raw_input.get("oldText"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                });
                if let Some(new_text) = new_content {
                    let old_text = old_content.as_deref().unwrap_or("");
                    let (diff_string, synth_added, synth_removed) =
                        synthesize_diff(file_path, old_text, &new_text);
                    serde_json::json!({
                        "success": {
                            "path": file_path,
                            "linesAdded": synth_added,
                            "linesRemoved": synth_removed,
                            "diffString": diff_string,
                        }
                    })
                } else {
                    serde_json::json!({
                        "success": {
                            "path": file_path,
                            "linesAdded": 0,
                            "linesRemoved": 0,
                            "diffString": result_text,
                            "message": result_text,
                        }
                    })
                }
            }
        }
        "Read" => {
            let file_path = pending.map(|pt| pt.file_path.as_str()).unwrap_or("");
            serde_json::json!({"success": {"path": file_path, "content": result_text, "totalLines": 0, "fileSize": 0}})
        }
        _ => {
            if is_error {
                serde_json::json!({"error": {"message": result_text}})
            } else {
                serde_json::json!({"success": true, "content": result_text})
            }
        }
    }
}

// ============================================
// Markdown Todo Parser
// ============================================

fn parse_markdown_todos(markdown: &str) -> Value {
    let mut todos = Vec::new();
    let mut id_counter: u32 = 0;

    for line in markdown.lines() {
        let trimmed = line.trim();
        let (checked, rest) = if let Some(rest) = trimmed
            .strip_prefix("- [x] ")
            .or_else(|| trimmed.strip_prefix("- [X] "))
        {
            (true, rest)
        } else if let Some(rest) = trimmed.strip_prefix("- [ ] ") {
            (false, rest)
        } else {
            continue;
        };

        id_counter += 1;
        let content = if let Some(dot_pos) = rest.find(". ") {
            let prefix = &rest[..dot_pos];
            if prefix.chars().all(|ch| ch.is_ascii_digit()) {
                &rest[dot_pos + 2..]
            } else {
                rest
            }
        } else {
            rest
        };
        let status = if checked { "completed" } else { "pending" };
        todos.push(serde_json::json!({
            "id": id_counter.to_string(),
            "content": content.trim(),
            "status": status,
        }));
    }
    Value::Array(todos)
}

// ============================================
// Tool Call Content Extraction
// ============================================

fn extract_tool_call_content(update: &Value) -> (String, String) {
    let mut content = String::new();
    let mut detailed = String::new();

    if let Some(raw_output) = update.get("rawOutput") {
        if let Some(text) = raw_output.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                content = text.to_string();
            }
        }
        if let Some(text) = raw_output.get("detailedContent").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                detailed = text.to_string();
            }
        }
        // Kiro ACP format: rawOutput.items[] with {"Text": "..."} or {"Json": {...}}
        if content.is_empty() && detailed.is_empty() {
            if let Some(items) = raw_output.get("items").and_then(|v| v.as_array()) {
                let mut texts = Vec::new();
                for item in items {
                    if let Some(text) = item.get("Text").and_then(|v| v.as_str()) {
                        texts.push(text.to_string());
                    } else if let Some(json_val) = item.get("Json") {
                        if let Some(stdout) = json_val.get("stdout").and_then(|v| v.as_str()) {
                            texts.push(stdout.to_string());
                        } else {
                            // `json_val` is a `serde_json::Value`, so
                            // serialization is infallible (Rule 41).
                            texts.push(
                                serde_json::to_string(json_val)
                                    .expect("acp_common: serde_json::Value must serialize"),
                            );
                        }
                    }
                }
                if !texts.is_empty() {
                    content = texts.join("\n");
                }
            }
        }
    }
    if !content.is_empty() || !detailed.is_empty() {
        return (content, detailed);
    }

    if let Some(content_val) = update.get("content") {
        if let Some(text) = content_val.as_str() {
            return (text.to_string(), String::new());
        }
        if let Some(arr) = content_val.as_array() {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|item| {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match item_type {
                        "content" => item
                            .get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|v| v.as_str()),
                        "text" => item.get("text").and_then(|v| v.as_str()),
                        _ => None,
                    }
                })
                .collect();
            if !texts.is_empty() {
                return (texts.join("\n"), String::new());
            }
        }
    }
    (String::new(), String::new())
}

// ============================================
// ACP Notification Parser
// ============================================

/// Parses ACP `session/update` notifications into ActivityChunks.
/// Generic over `A: AcpAgentAdapter` for agent-specific behavior.
pub(crate) struct AcpNotificationParser<A: AcpAgentAdapter> {
    pub adapter: A,
    session_id: String,
    pending_tools: HashMap<String, PendingToolCall>,
    thought_json_buf: String,
    buffering_thought_json: bool,
}

impl<A: AcpAgentAdapter> AcpNotificationParser<A> {
    pub fn new(adapter: A, session_id: &str) -> Self {
        Self {
            adapter,
            session_id: session_id.to_string(),
            pending_tools: HashMap::new(),
            thought_json_buf: String::new(),
            buffering_thought_json: false,
        }
    }

    const MAX_THOUGHT_JSON_BUF: usize = 8192;

    pub fn parse_update(&mut self, update: &Value) -> Vec<ActivityChunk> {
        let session_update = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut chunks = if session_update != "agent_thought_chunk" {
            self.flush_thought_buffer()
        } else {
            vec![]
        };

        let parsed = match session_update {
            "agent_thought_chunk" => self.parse_thought_chunk(update),
            "agent_message_chunk" => self.parse_message_chunk(update),
            "tool_call" => self.parse_tool_call_start(update),
            "tool_call_update" => self.parse_tool_call_update(update),
            other => {
                if !other.is_empty() {
                    tracing::info!("[ACP] Unhandled sessionUpdate: {}", other);
                }
                vec![]
            }
        };
        chunks.extend(parsed);
        chunks
    }

    pub fn flush_thought_buffer(&mut self) -> Vec<ActivityChunk> {
        if !self.buffering_thought_json || self.thought_json_buf.is_empty() {
            self.buffering_thought_json = false;
            return vec![];
        }
        let buf = std::mem::take(&mut self.thought_json_buf);
        self.buffering_thought_json = false;
        self.emit_thinking_delta(&buf)
    }

    fn emit_thinking_delta(&self, text: &str) -> Vec<ActivityChunk> {
        if text.is_empty() {
            return vec![];
        }
        let mut chunk = ActivityChunk::new(&self.session_id, "llm_thinking_delta", "thinking");
        chunk.result = serde_json::json!({
            "thought": text, "content": text, "is_delta": true,
        });
        chunk.broadcast_only = true;
        vec![chunk]
    }

    fn emit_todo_from_thought_json(&self, parsed: &Value) -> Vec<ActivityChunk> {
        let todos_array = match parsed.get("todos") {
            Some(Value::Array(arr)) => Value::Array(arr.clone()),
            Some(Value::String(markdown)) => parse_markdown_todos(markdown),
            _ => Value::Array(vec![]),
        };
        let merge = parsed
            .get("merge")
            .or_else(|| parsed.get("wasMerge"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", "UpdateTodos");
        chunk.args = serde_json::json!({ "todos": &todos_array, "merge": merge });
        chunk.result = serde_json::json!({ "success": true, "todos": &todos_array });
        vec![chunk]
    }

    fn parse_thought_chunk(&mut self, update: &Value) -> Vec<ActivityChunk> {
        let text = update
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if text.is_empty() {
            return vec![];
        }

        if !self.buffering_thought_json {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    if parsed.get("todos").is_some() {
                        return self.emit_todo_from_thought_json(&parsed);
                    }
                    return self.emit_thinking_delta(text);
                }
                self.buffering_thought_json = true;
                self.thought_json_buf.clear();
                self.thought_json_buf.push_str(text);
                return vec![];
            }
            return self.emit_thinking_delta(text);
        }

        self.thought_json_buf.push_str(text);
        if self.thought_json_buf.len() > Self::MAX_THOUGHT_JSON_BUF {
            return self.flush_thought_buffer();
        }
        let buf_trimmed = self.thought_json_buf.trim().to_string();
        match serde_json::from_str::<Value>(&buf_trimmed) {
            Ok(parsed) => {
                self.buffering_thought_json = false;
                self.thought_json_buf.clear();
                if parsed.get("todos").is_some() {
                    return self.emit_todo_from_thought_json(&parsed);
                }
                self.emit_thinking_delta(&buf_trimmed)
            }
            Err(_) => vec![],
        }
    }

    fn parse_message_chunk(&self, update: &Value) -> Vec<ActivityChunk> {
        let text = update
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if text.is_empty() {
            return vec![];
        }
        let mut chunk = ActivityChunk::new(&self.session_id, "assistant_delta", "message");
        chunk.result = serde_json::json!({
            "observation": text, "content": text, "role": "assistant", "is_delta": true,
        });
        chunk.broadcast_only = true;
        vec![chunk]
    }

    fn parse_tool_call_start(&mut self, update: &Value) -> Vec<ActivityChunk> {
        let tool_call_id = update
            .get("toolCallId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let kind = update
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let title = update
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let raw_input = update
            .get("rawInput")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));

        let mut cursor_name = self.adapter.map_tool_kind(kind, &raw_input);

        if kind == "think" && raw_input.get("todos").is_some() {
            cursor_name = "UpdateTodos".to_string();
        }

        let file_path = raw_input
            .get("path")
            .or(raw_input.get("file_path"))
            .or(raw_input.get("filePath"))
            .and_then(|v| v.as_str())
            // Kiro read with ops[]: path is in ops[0].path
            .or_else(|| {
                raw_input
                    .get("ops")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|op| op.get("path"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("")
            .to_string();

        let args = match cursor_name.as_str() {
            "Shell" => serde_json::json!({
                "command": raw_input.get("command").and_then(|v| v.as_str()).unwrap_or(""),
            }),
            "Read" => {
                let display_path = if file_path.is_empty() && !title.is_empty() {
                    &title
                } else {
                    &file_path
                };
                serde_json::json!({ "path": display_path })
            }
            "Edit" => {
                let old_string = raw_input
                    .get("old_string")
                    .or(raw_input.get("oldString"))
                    .or(raw_input.get("oldStr"))
                    .or(raw_input.get("old_text"))
                    .or(raw_input.get("oldText"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_string = extract_edit_content(&raw_input).unwrap_or_default();
                serde_json::json!({
                    "path": &file_path,
                    "old_string": old_string,
                    "new_string": new_string,
                })
            }
            "Grep" => {
                let grep_query = raw_input
                    .get("query")
                    .or(raw_input.get("pattern"))
                    .or(raw_input.get("regex"))
                    .or(raw_input.get("search_term"))
                    .or(raw_input.get("searchTerm"))
                    .or(raw_input.get("text"))
                    .or(raw_input.get("input"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // Fallback: extract from title (e.g. "Search **/tsconfig.json" → "**/tsconfig.json")
                let grep_query = if grep_query.is_empty() && !title.is_empty() {
                    title
                        .strip_prefix("Search ")
                        .or(title.strip_prefix("search "))
                        .unwrap_or(&title)
                } else {
                    grep_query
                };
                serde_json::json!({
                    "query": grep_query,
                    "path": raw_input.get("path").and_then(|v| v.as_str()).unwrap_or(""),
                })
            }
            "UpdateTodos" => {
                let todos = match raw_input.get("todos") {
                    Some(Value::Array(arr)) => Value::Array(arr.clone()),
                    Some(Value::String(markdown)) => parse_markdown_todos(markdown),
                    _ => raw_input
                        .get("items")
                        .cloned()
                        .unwrap_or(Value::Array(vec![])),
                };
                let merge = raw_input
                    .get("merge")
                    .or(raw_input.get("wasMerge"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                serde_json::json!({ "todos": todos, "merge": merge })
            }
            "Glob" => {
                let glob_pattern = raw_input
                    .get("pattern")
                    .or(raw_input.get("glob_pattern"))
                    .or(raw_input.get("globPattern"))
                    .or(raw_input.get("query"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let glob_pattern = if glob_pattern.is_empty() && !title.is_empty() {
                    title
                        .strip_prefix("Search ")
                        .or(title.strip_prefix("search "))
                        .unwrap_or(&title)
                } else {
                    glob_pattern
                };
                serde_json::json!({
                    "pattern": glob_pattern,
                    "target_directory": raw_input.get("path")
                        .or(raw_input.get("dir_path"))
                        .or(raw_input.get("directory"))
                        .and_then(|v| v.as_str()),
                })
            }
            _ => raw_input.clone(),
        };

        let effective_path = if file_path.is_empty() && !title.is_empty() {
            title
        } else {
            file_path
        };
        self.pending_tools.insert(
            tool_call_id.clone(),
            PendingToolCall {
                cursor_name: cursor_name.clone(),
                file_path: effective_path,
                raw_input,
            },
        );

        if !self.adapter.should_emit_tool_start(&cursor_name) {
            return vec![];
        }

        let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
        chunk.args = args;
        chunk.result = serde_json::json!({ "call_id": tool_call_id, "status": "running" });
        vec![chunk]
    }

    fn parse_tool_call_update(&mut self, update: &Value) -> Vec<ActivityChunk> {
        let tool_call_id = update
            .get("toolCallId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = update
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed");
        let is_error = status == "failed" || status == "error";
        let is_terminal = status == "completed" || status == "failed" || status == "error";

        let pending = self.pending_tools.get(&tool_call_id);
        let cursor_name = pending
            .map(|pt| pt.cursor_name.as_str())
            .unwrap_or("unknown")
            .to_string();

        let (result_text, detailed_text) = extract_tool_call_content(update);

        let mut result = normalize_tool_result(
            &cursor_name,
            &result_text,
            &detailed_text,
            is_error,
            pending,
        );
        if is_terminal {
            self.pending_tools.remove(&tool_call_id);
        }
        if let Some(obj) = result.as_object_mut() {
            obj.insert("call_id".to_string(), Value::String(tool_call_id));
        }

        if is_terminal {
            if let Some(chunk) = self.adapter.map_tool_result_chunk(
                &self.session_id,
                &cursor_name,
                &result_text,
                is_error,
            ) {
                return vec![chunk];
            }
        }

        if !self
            .adapter
            .should_emit_tool_result(&cursor_name, &result_text, is_error)
        {
            return vec![];
        }

        let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
        chunk.result = result;
        vec![chunk]
    }
}

// ============================================
// JSON-RPC Helpers
// ============================================

async fn acp_send(
    stdin: &mut ChildStdin,
    request_id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    });
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("ACP write error: {}", err))?;
    stdin
        .flush()
        .await
        .map_err(|err| format!("ACP flush error: {}", err))?;
    Ok(())
}

async fn acp_respond(stdin: &mut ChildStdin, request_id: &Value, result: Value) {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    });
    let line = format!("{}\n", msg);
    let _ = stdin.write_all(line.as_bytes()).await;
    let _ = stdin.flush().await;
}

async fn acp_read(reader: &mut BufReader<ChildStdout>, buf: &mut String) -> Result<Value, String> {
    loop {
        buf.clear();
        match reader.read_line(buf).await {
            Ok(0) => return Err("ACP: unexpected EOF".into()),
            Ok(_) => {
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = serde_json::from_str(trimmed)
                    .map_err(|err| format!("ACP JSON parse error: {}", err))?;
                // Log JSON-RPC errors at warn level, others at debug
                if val.get("error").is_some() {
                    tracing::warn!("[ACP] ← {}", trimmed);
                } else if val.get("id").is_some() {
                    let preview = val
                        .get("result")
                        .map(|r| {
                            let s = r.to_string();
                            truncate_str_safe(&s, 200)
                        })
                        .unwrap_or_default();
                    tracing::debug!("[ACP] ← response id={} result={}", val["id"], preview);
                } else {
                    let preview = truncate_str_safe(trimmed, 300);
                    tracing::debug!("[ACP] ← notif: {}", preview);
                }
                return Ok(val);
            }
            Err(err) => return Err(format!("ACP read error: {}", err)),
        }
    }
}

// ============================================
// ACP Protocol Flow
// ============================================

/// Run the full ACP protocol lifecycle with an agent-specific adapter.
#[allow(clippy::too_many_arguments)]
pub async fn run_acp_protocol<A: AcpAgentAdapter>(
    adapter: A,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    session_id: &str,
    task: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    chunk_tx: mpsc::Sender<ActivityChunk>,
    image_paths: Vec<String>,
) -> Result<AcpSessionResult, String> {
    let mut reader = BufReader::new(stdout);
    let mut parser = AcpNotificationParser::new(adapter, session_id);
    let mut line_buf = String::new();
    let mut request_id: u64 = 0;

    // ── Step 1: Initialize ──
    request_id += 1;
    let init_id = request_id;
    acp_send(
        &mut stdin,
        init_id,
        "initialize",
        serde_json::json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": { "terminal": true },
        }),
    )
    .await?;

    let mut supports_load_session = false;
    loop {
        let msg = match acp_read(&mut reader, &mut line_buf).await {
            Ok(msg) => msg,
            Err(err) => {
                tracing::error!("[ACP] Read error during initialize: {}", err);
                return Err(err);
            }
        };
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        tracing::info!(
            "[ACP] init-loop msg id={:?} keys={:?}",
            msg_id,
            msg.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        if msg_id == Some(init_id) {
            if let Some(err) = msg.get("error") {
                tracing::warn!("[ACP] Initialize error (continuing): {}", err);
            }
            if let Some(result) = msg.get("result") {
                tracing::info!(
                    "[ACP] Initialize response: {}",
                    serde_json::to_string(result)
                        .expect("acp_common: serde_json::Value must serialize")
                );
                supports_load_session = result
                    .get("agentCapabilities")
                    .and_then(|c| c.get("loadSession"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
            tracing::info!(
                "[ACP] Agent capabilities — loadSession: {}",
                supports_load_session
            );
            break;
        }
    }

    // ── Step 2: Create or resume session ──
    request_id += 1;
    let session_req_id = request_id;
    let use_load = resume_session_id.is_some() && supports_load_session;

    if let (true, Some(resume_id)) = (use_load, resume_session_id) {
        tracing::info!("[ACP] Resuming session via session/load (id={})", resume_id);
        acp_send(
            &mut stdin,
            session_req_id,
            "session/load",
            serde_json::json!({
                "sessionId": resume_id, "cwd": working_dir, "mcpServers": [],
            }),
        )
        .await?;
    } else {
        if resume_session_id.is_some() && !supports_load_session {
            tracing::info!("[ACP] Agent does not support session/load — calling session/new");
        }
        acp_send(
            &mut stdin,
            session_req_id,
            "session/new",
            serde_json::json!({
                "cwd": working_dir, "mcpServers": [],
            }),
        )
        .await?;
    }

    let mut acp_session_id = resume_session_id.unwrap_or("").to_string();
    loop {
        let msg = match acp_read(&mut reader, &mut line_buf).await {
            Ok(msg) => msg,
            Err(err) => {
                tracing::error!("[ACP] Read error during session/new: {}", err);
                return Err(err);
            }
        };
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        tracing::info!(
            "[ACP] session-loop msg id={:?} keys={:?}",
            msg_id,
            msg.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        if msg_id == Some(session_req_id) {
            if let Some(err) = msg.get("error") {
                return Err(format!("ACP session error: {}", err));
            }
            if let Some(sid) = msg
                .get("result")
                .and_then(|r| r.get("sessionId"))
                .and_then(|v| v.as_str())
            {
                acp_session_id = sid.to_string();
                let current_model = msg
                    .get("result")
                    .and_then(|r| r.get("configOptions"))
                    .and_then(|opts| opts.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find(|o| o.get("id").and_then(|v| v.as_str()) == Some("model"))
                    })
                    .and_then(|o| o.get("currentValue"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                tracing::info!(
                    "[ACP] session/new succeeded, acp_session_id={}, model={}",
                    acp_session_id,
                    current_model
                );
            }
            break;
        }
        // Skip notifications during session/load — kiro replays conversation
        // history as notifications which we don't want to emit as new chunks.
        if !use_load {
            process_notification(&msg, &mut parser, &mut stdin, &chunk_tx, session_id).await;
        }
    }

    // Emit session_start
    let mut start_chunk = ActivityChunk::new(session_id, "session_start", "session_start");
    start_chunk.result = serde_json::json!({"success": true});
    let _ = chunk_tx.send(start_chunk).await;

    // ── Step 3: Send prompt (with optional image blocks) ──
    request_id += 1;
    let prompt_id = request_id;
    let mut prompt_blocks: Vec<serde_json::Value> =
        vec![serde_json::json!({"type": "text", "text": task})];
    for path in &image_paths {
        if let Ok(bytes) = std::fs::read(path) {
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let mime = if path.ends_with(".png") {
                "image/png"
            } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                "image/jpeg"
            } else if path.ends_with(".gif") {
                "image/gif"
            } else if path.ends_with(".webp") {
                "image/webp"
            } else {
                "image/png"
            };
            prompt_blocks.push(serde_json::json!({
                "type": "image",
                "mimeType": mime,
                "data": b64,
            }));
        }
    }
    tracing::info!(
        "[ACP] Sending session/prompt to acp_session_id={}",
        acp_session_id
    );
    acp_send(
        &mut stdin,
        prompt_id,
        "session/prompt",
        serde_json::json!({
            "sessionId": acp_session_id,
            "prompt": prompt_blocks,
        }),
    )
    .await?;

    // ── Step 4: Stream notifications until prompt response ──
    let stop_reason;
    loop {
        let msg = acp_read(&mut reader, &mut line_buf).await?;
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        if msg_id == Some(prompt_id) {
            if let Some(err) = msg.get("error") {
                return Err(format!("ACP prompt error: {}", err));
            }
            stop_reason = msg
                .get("result")
                .and_then(|r| r.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            break;
        }
        process_notification(&msg, &mut parser, &mut stdin, &chunk_tx, session_id).await;
    }

    for chunk in parser.flush_thought_buffer() {
        let _ = chunk_tx.send(chunk).await;
    }

    // Emit session_end
    let mut end_chunk = ActivityChunk::new(session_id, "session_end", "session_end");
    end_chunk.result = serde_json::json!({
        "success": stop_reason == "end_turn",
        "stop_reason": &stop_reason,
    });
    let _ = chunk_tx.send(end_chunk).await;

    Ok(AcpSessionResult {
        acp_session_id,
        stop_reason,
    })
}

/// Process a single NDJSON message that might be a notification.
async fn process_notification<A: AcpAgentAdapter>(
    msg: &Value,
    parser: &mut AcpNotificationParser<A>,
    stdin: &mut ChildStdin,
    chunk_tx: &mpsc::Sender<ActivityChunk>,
    session_id: &str,
) {
    let method = match msg.get("method").and_then(|v| v.as_str()) {
        Some(m) => m,
        None => return,
    };

    match method {
        "session/update" => {
            if let Some(update) = msg.get("params").and_then(|p| p.get("update")) {
                for chunk in parser.parse_update(update) {
                    let _ = chunk_tx.send(chunk).await;
                }
            }
        }
        "session/request_permission" => {
            if let Some(req_id) = msg.get("id") {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let tool_name = params
                    .get("permissions")
                    .and_then(|p| p.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|perm| perm.get("tool"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown_tool")
                    .to_string();
                let description = params
                    .get("permissions")
                    .and_then(|p| p.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|perm| perm.get("description"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Emit an ask_user_permissions chunk so the frontend shows an approval card
                let mut chunk =
                    ActivityChunk::new(session_id, "ask_user_permissions", "ask_user_permissions");
                chunk.args = serde_json::json!({
                    "tool_name": tool_name,
                    "description": description,
                });
                chunk.result = serde_json::json!({
                    "pending": true,
                });
                let _ = chunk_tx.send(chunk).await;

                // Register a oneshot channel and wait for the user's response
                let (tx, rx) = oneshot::channel::<ApprovalResponse>();
                PENDING_APPROVALS
                    .lock()
                    .await
                    .insert(session_id.to_string(), tx);

                // 5-minute timeout for user response; auto-approve on timeout
                let response =
                    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                        Ok(Ok(resp)) => resp,
                        _ => {
                            tracing::info!(
                                "[ACP] Approval timed out or channel closed — auto-approving"
                            );
                            PENDING_APPROVALS.lock().await.remove(session_id);
                            ApprovalResponse {
                                approved: true,
                                always_allow: false,
                            }
                        }
                    };

                let option_id = if response.always_allow {
                    "allow_always"
                } else if response.approved {
                    "allow_once"
                } else {
                    "deny"
                };

                acp_respond(
                    stdin,
                    req_id,
                    serde_json::json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
                )
                .await;

                // Emit the response as an approval_response chunk
                let mut resp_chunk =
                    ActivityChunk::new(session_id, "approval_response", "approval_response");
                resp_chunk.result = serde_json::json!({
                    "approved": response.approved,
                    "always_allow": response.always_allow,
                    "tool_name": tool_name,
                });
                let _ = chunk_tx.send(resp_chunk).await;
            }
        }
        _ => {
            // Delegate to agent-specific handler
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let chunks = parser.adapter.handle_custom_notification(method, &params);
            if chunks.is_empty() {
                tracing::debug!("[ACP] Ignoring notification: {}", method);
            }
            for chunk in chunks {
                let _ = chunk_tx.send(chunk).await;
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/acp_common_tests.rs"]
mod tests;
