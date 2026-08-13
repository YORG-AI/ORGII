//! Codex CLI stdout parser.
//!
//! Codex uses `--json` flag. Supports two JSONL formats:
//! - NEW: `item.started`, `item.completed`, `turn.completed`, `thread.started`
//! - OLD: `params.msg.type` (ExecCommandBegin/End, PatchApplyBegin/End, etc.)

use serde_json::Value;

use super::{
    canonicalize_cli_error_message, is_codex_retry_notice, BoundedCliErrorDeduper, CliAgentParser,
};
use crate::agent_sessions::cli::parsers::normalizer::{normalize_tool_name, unwrap_codex_command};
use crate::agent_sessions::cli::parsers::types::{CliAgentType, TokenUsage};
use core_types::activity::ActivityChunk;

pub struct CodexParser {
    session_id: String,
    thread_id: Option<String>,
    usage: Option<TokenUsage>,
    got_turn_completed: bool,
    error_deduper: BoundedCliErrorDeduper,
    /// A non-retryable `error` is provisional until Codex emits the matching
    /// terminal event. Keeping it here prevents one failed turn from becoming
    /// both an error card and a failed session-end card.
    pending_error_message: Option<String>,
    /// Last retry notice, kept only as a body of last resort. Codex recovers
    /// from these, so it must never be rendered on its own — but when the
    /// terminal event carries no message it is the only description of what
    /// went wrong, and `Turn failed` tells the user nothing.
    last_retry_notice: Option<String>,
}

impl CodexParser {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            thread_id: None,
            usage: None,
            got_turn_completed: false,
            error_deduper: BoundedCliErrorDeduper::default(),
            pending_error_message: None,
            last_retry_notice: None,
        }
    }

    fn item_call_id(item: &Value) -> Option<&str> {
        item.get("id")
            .or_else(|| item.get("call_id"))
            .or_else(|| item.get("tool_call_id"))
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty())
    }

    fn stamp_tool_call_identity(chunk: &mut ActivityChunk, call_id: Option<&str>) {
        let Some(call_id) = call_id else {
            return;
        };
        chunk.chunk_id = format!("tool-call-{call_id}");
        if let Some(obj) = chunk.result.as_object_mut() {
            obj.insert("call_id".to_string(), Value::String(call_id.to_string()));
        }
    }

    /// Extract reasoning text from a Codex reasoning item.
    ///
    /// Codex reasoning items use the OpenAI Responses API format:
    /// `{ "type": "reasoning", "summary": [{ "type": "summary_text", "text": "..." }, ...] }`
    /// Also handles a flat `text` field as fallback.
    fn extract_reasoning_text(item: &Value) -> String {
        // Primary: summary array of { type: "summary_text", text: "..." }
        if let Some(summary) = item.get("summary").and_then(|v| v.as_array()) {
            let parts: Vec<&str> = summary
                .iter()
                .filter_map(|entry| entry.get("text").and_then(|v| v.as_str()))
                .collect();
            if !parts.is_empty() {
                return parts.join("\n");
            }
        }
        // Fallback: flat text field
        item.get("text")
            .or(item.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// Parse new-format events (item.started, item.completed, etc.)
    fn parse_new_format(&mut self, data: &Value, top_type: &str) -> Vec<ActivityChunk> {
        match top_type {
            "thread.started" => {
                if let Some(tid) = data.get("thread_id").and_then(|v| v.as_str()) {
                    self.thread_id = Some(tid.to_string());
                }
                let mut chunk =
                    ActivityChunk::new(&self.session_id, "session_start", "session_start");
                chunk.result = serde_json::json!({"success": true});
                if let Some(ref tid) = self.thread_id {
                    chunk.thread_id = Some(tid.clone());
                }
                vec![chunk]
            }

            "item.started" => {
                let item = data.get("item").unwrap_or(&Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let cursor_name = normalize_tool_name(CliAgentType::Codex, item_type);

                if cursor_name == "message" {
                    return vec![];
                } // Messages handled in completed

                // Reasoning items are handled in item.completed where summary text is available
                if item_type == "reasoning" {
                    return vec![];
                }

                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);

                match item_type {
                    "command_execution" => {
                        let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                        let actual_cmd = unwrap_codex_command(command);
                        chunk.args = serde_json::json!({
                            "command": actual_cmd,
                            "workingDirectory": item.get("working_directory").and_then(|v| v.as_str()),
                        });
                    }
                    "file_change" | "file_edit" => {
                        let path = item
                            .get("filepath")
                            .or_else(|| {
                                item.get("changes")
                                    .and_then(|c| c.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|c| c.get("path"))
                            })
                            .and_then(|v| v.as_str());
                        chunk.args = serde_json::json!({"path": path});
                    }
                    "todo_list" => {
                        chunk.args = serde_json::json!({"todos": item.get("items")});
                    }
                    _ => {}
                }

                chunk.result = serde_json::json!({"status": "running"});
                Self::stamp_tool_call_identity(&mut chunk, Self::item_call_id(item));
                vec![chunk]
            }

            "item.completed" | "item.updated" => {
                let item = data.get("item").unwrap_or(&Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let cursor_name = normalize_tool_name(CliAgentType::Codex, item_type);

                // Rendering the fallback-metadata notice as an error card is
                // misleading; Codex keeps running after it.
                if item_type == "error"
                    && item
                        .get("message")
                        .and_then(|value| value.as_str())
                        .is_some_and(super::is_codex_fallback_metadata_notice)
                {
                    return vec![];
                }

                // Reasoning items: extract summary text and emit as thinking
                if item_type == "reasoning" {
                    let thought = Self::extract_reasoning_text(item);
                    if thought.is_empty() {
                        return vec![];
                    }
                    let mut chunk =
                        ActivityChunk::new(&self.session_id, "llm_thinking", "thinking");
                    chunk.result = serde_json::json!({
                        "thought": thought,
                        "observation": thought,
                        "content": thought,
                    });
                    return vec![chunk];
                }

                // Agent messages are emitted as assistant messages, not tool calls
                if item_type == "agent_message" || item_type == "message" {
                    let text = item
                        .get("text")
                        .or_else(|| {
                            item.get("message")
                                .and_then(|m| m.get("content"))
                                .and_then(|c| c.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|i| i.get("text"))
                        })
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if text.is_empty() {
                        return vec![];
                    }

                    let mut chunk = ActivityChunk::new(&self.session_id, "assistant", "message");
                    chunk.result = serde_json::json!({
                        "observation": text, "content": text, "role": "assistant",
                        "is_delta": false, "is_full_content": true,
                    });
                    return vec![chunk];
                }

                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);

                match item_type {
                    "command_execution" => {
                        let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                        let actual_cmd = unwrap_codex_command(command);
                        let output = item
                            .get("aggregated_output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let exit_code =
                            item.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(-1);
                        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                        let is_error = status == "failed" || exit_code != 0;

                        chunk.args = serde_json::json!({"command": actual_cmd});
                        chunk.result = if is_error {
                            serde_json::json!({"error": {"exitCode": exit_code, "stdout": output, "stderr": ""}})
                        } else {
                            serde_json::json!({"success": {"exitCode": exit_code, "stdout": output, "stderr": ""}})
                        };
                    }
                    "file_change" | "file_edit" => {
                        let changes = item.get("changes").and_then(|v| v.as_array());
                        let path = changes
                            .and_then(|arr| arr.first())
                            .and_then(|c| c.get("path").and_then(|v| v.as_str()))
                            .or_else(|| item.get("filepath").and_then(|v| v.as_str()))
                            .unwrap_or("");

                        chunk.args = serde_json::json!({"path": path});
                        chunk.result = serde_json::json!({
                            "success": {"path": path, "files": [path], "message": "File updated."}
                        });
                    }
                    "todo_list" => {
                        let items = item.get("items").cloned().unwrap_or(Value::Array(vec![]));
                        chunk.args = serde_json::json!({"todos": items});
                        chunk.result = serde_json::json!({"success": true});
                    }
                    "mcp_tool_call" => {
                        let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("mcp");
                        chunk.function = tool.to_string();
                        chunk.args = item
                            .get("arguments")
                            .cloned()
                            .unwrap_or(Value::Object(Default::default()));
                        chunk.result = item.get("result").cloned().unwrap_or(serde_json::json!({}));
                    }
                    _ => {}
                }

                Self::stamp_tool_call_identity(&mut chunk, Self::item_call_id(item));
                vec![chunk]
            }

            "turn.completed" => {
                self.got_turn_completed = true;
                self.pending_error_message = None;
                self.last_retry_notice = None;

                // Extract usage
                if let Some(usage) = data.get("usage") {
                    let input_tokens = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let output_tokens = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    self.usage = Some(TokenUsage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens: usage
                            .get("cached_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_write_tokens: 0,
                        total_tokens: usage
                            .get("total_tokens")
                            .and_then(|v| v.as_u64())
                            .filter(|value| *value > 0)
                            .unwrap_or_else(|| input_tokens.saturating_add(output_tokens)),
                        model: data
                            .get("model")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                }

                let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
                chunk.result = serde_json::json!({"success": true});
                vec![chunk]
            }

            "error" => {
                let message = data
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                if is_codex_retry_notice(message) {
                    self.last_retry_notice = Some(canonicalize_cli_error_message(message));
                    return vec![];
                }
                let message = canonicalize_cli_error_message(message);
                let Some(message) = self.error_deduper.admit(message) else {
                    return vec![];
                };
                self.pending_error_message = Some(message);
                vec![]
            }

            "turn.started" => vec![], // Informational, no chunk needed

            "turn.failed" => {
                self.got_turn_completed = true; // Prevent duplicate session_end
                let terminal_error = data
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .map(canonicalize_cli_error_message)
                    .filter(|message| !message.is_empty());
                let error_msg = terminal_error
                    .or_else(|| self.pending_error_message.take())
                    .or_else(|| self.last_retry_notice.take())
                    .unwrap_or_else(|| "Turn failed".to_string());
                self.pending_error_message = None;
                self.last_retry_notice = None;
                let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
                chunk.result = serde_json::json!({
                    "success": false,
                    "error_message": error_msg,
                });
                vec![chunk]
            }

            _ => vec![],
        }
    }
}

impl CliAgentParser for CodexParser {
    fn parse_line(&mut self, line: &str) -> Vec<ActivityChunk> {
        let data: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![],
        };

        // Detect format: NEW format has top-level type starting with item/turn/thread/error
        let top_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if top_type.starts_with("item.")
            || top_type.starts_with("turn.")
            || top_type.starts_with("thread.")
            || top_type == "error"
        {
            return self.parse_new_format(&data, top_type);
        }

        // Check wrapped format: data.result.type
        if let Some(result) = data.get("result") {
            let result_type = result.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if result_type.starts_with("item.")
                || result_type.starts_with("turn.")
                || result_type.starts_with("thread.")
            {
                return self.parse_new_format(result, result_type);
            }
        }

        // OLD format: data.params.msg.type (legacy, basic support)
        let msg_type = data
            .get("params")
            .and_then(|p| p.get("msg"))
            .and_then(|m| m.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match msg_type {
            "AgentMessage" | "AgentMessageDelta" => {
                let content = data
                    .get("params")
                    .and_then(|p| p.get("msg"))
                    .and_then(|m| m.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if content.is_empty() {
                    return vec![];
                }
                let mut chunk = ActivityChunk::new(&self.session_id, "assistant", "message");
                chunk.result = serde_json::json!({
                    "observation": content, "content": content, "role": "assistant",
                    "is_delta": msg_type == "AgentMessageDelta",
                });
                vec![chunk]
            }
            _ => vec![],
        }
    }

    fn on_exit(&mut self, exit_code: i32) -> Vec<ActivityChunk> {
        if self.got_turn_completed {
            return vec![];
        }
        let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
        // A retry notice only describes a failure if the process actually died;
        // on a clean exit Codex recovered and there is nothing to report.
        let failure_message = self
            .pending_error_message
            .take()
            .or_else(|| self.last_retry_notice.take().filter(|_| exit_code != 0));
        if let Some(message) = failure_message {
            chunk.result = serde_json::json!({
                "success": false,
                "exit_code": exit_code,
                "error_message": message,
            });
        } else {
            chunk.result = serde_json::json!({
                "success": exit_code == 0,
                "exit_code": exit_code,
            });
        }
        vec![chunk]
    }

    fn token_usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }

    fn cli_session_id(&self) -> Option<String> {
        self.thread_id.clone()
    }
}
