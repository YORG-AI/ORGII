//! `session/update` notification parsing into `ActivityChunk`s.

use std::collections::HashMap;

use serde_json::Value;

use core_types::activity::ActivityChunk;

use super::content::{
    extract_edit_content, extract_tool_call_content, normalize_tool_result, parse_markdown_todos,
};
use super::AcpAgentAdapter;

/// Data stored from a tool_call start event, used when the tool_call_update arrives.
pub(crate) struct PendingToolCall {
    pub(crate) cursor_name: String,
    pub(crate) file_path: String,
    pub(crate) raw_input: Value,
    pub(crate) title: String,
}

// ============================================
// ACP Notification Parser
// ============================================

/// Parses ACP `session/update` notifications into ActivityChunks.
/// Generic over `A: AcpAgentAdapter` for agent-specific behavior.
pub(crate) struct AcpNotificationParser<A: AcpAgentAdapter> {
    pub adapter: A,
    session_id: String,
    task: String,
    pending_tools: HashMap<String, PendingToolCall>,
    thought_json_buf: String,
    buffering_thought_json: bool,
}

impl<A: AcpAgentAdapter> AcpNotificationParser<A> {
    pub fn new_with_task(adapter: A, session_id: &str, task: &str) -> Self {
        Self {
            adapter,
            session_id: session_id.to_string(),
            task: task.to_string(),
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
            title.clone()
        } else {
            file_path
        };
        self.pending_tools.insert(
            tool_call_id.clone(),
            PendingToolCall {
                cursor_name: cursor_name.clone(),
                file_path: effective_path,
                raw_input,
                title,
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
        if let Some(obj) = result.as_object_mut() {
            obj.insert("call_id".to_string(), Value::String(tool_call_id.clone()));
        }

        if is_terminal {
            let mapped_chunk = self.adapter.map_tool_result_chunk(
                &self.session_id,
                &cursor_name,
                &result_text,
                &detailed_text,
                pending.map(|pt| &pt.raw_input),
                pending.map(|pt| pt.title.as_str()),
                Some(self.task.as_str()),
                is_error,
            );
            self.pending_tools.remove(&tool_call_id);
            if let Some(chunk) = mapped_chunk {
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
