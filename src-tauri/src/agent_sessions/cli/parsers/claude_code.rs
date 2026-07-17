//! Claude Code CLI stdout parser.
//!
//! Claude Code uses `--output-format stream-json`. Events arrive as:
//! - `system` (init)
//! - `assistant` with `message.content[]` containing `text` and `tool_use` blocks
//! - `user` with `message.content[]` containing `tool_result` blocks
//! - `result` (session end with usage)
//!
//! Tool calls are paired: `tool_use` in assistant → `tool_result` in user.

use serde_json::Value;
use std::collections::HashMap;

use super::CliAgentParser;
use crate::agent_sessions::cli::parsers::normalizer::normalize_tool_name;
use crate::agent_sessions::cli::parsers::types::{CliAgentType, TokenUsage};
use core_types::activity::ActivityChunk;

pub struct ClaudeCodeParser {
    session_id: String,
    thread_id: Option<String>,
    usage: Option<TokenUsage>,
    /// Pending tool calls: tool_use_id → (cursor_name, raw_claude_args, normalized_args)
    pending_tools: HashMap<String, (String, Value, Value)>,
    /// Streaming tool blocks: content block index → (tool_use_id, cursor_name)
    streaming_tool_blocks: HashMap<usize, (String, String)>,
}

impl ClaudeCodeParser {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            thread_id: None,
            usage: None,
            pending_tools: HashMap::new(),
            streaming_tool_blocks: HashMap::new(),
        }
    }

    /// Normalize Claude tool name + args to Cursor format.
    fn normalize_args(_cursor_name: &str, claude_name: &str, args: &Value) -> Value {
        match claude_name {
            "Bash" => {
                // Bash → Shell: wrap command in Cursor shell format
                serde_json::json!({
                    "command": args.get("command").and_then(|v| v.as_str()).unwrap_or(""),
                    "workingDirectory": args.get("working_directory").or(args.get("cwd")).and_then(|v| v.as_str()),
                    "timeout": args.get("timeout"),
                })
            }
            "Write" => {
                // Write → Edit: creation as edit with empty old_string
                serde_json::json!({
                    "path": args.get("file_path").or(args.get("path")).and_then(|v| v.as_str()),
                    "old_string": "",
                    "new_string": args.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                })
            }
            "Edit" => {
                serde_json::json!({
                    "path": args.get("file_path").or(args.get("path")).and_then(|v| v.as_str()),
                    "old_string": args.get("old_string").and_then(|v| v.as_str()).unwrap_or(""),
                    "new_string": args.get("new_string").and_then(|v| v.as_str()).unwrap_or(""),
                })
            }
            "Read" => {
                serde_json::json!({
                    "path": args.get("file_path").or(args.get("path")).and_then(|v| v.as_str()),
                })
            }
            _ => args.clone(), // Pass through for Grep, Glob, ManageTodo, etc.
        }
    }

    fn tool_call_delta_chunk(
        &self,
        index: usize,
        tool_call_id: Option<&str>,
        tool_name: Option<&str>,
        arguments_delta: Option<&str>,
    ) -> ActivityChunk {
        let mut chunk = ActivityChunk::new(&self.session_id, "tool_call_delta", "tool_call_delta");
        chunk.result = serde_json::json!({
            "is_delta": true,
            "index": index,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments_delta": arguments_delta,
        });
        chunk.broadcast_only = true;
        chunk
    }

    /// Count non-empty lines in a string.
    fn count_lines(text: &str) -> u64 {
        if text.is_empty() {
            return 0;
        }
        text.lines().count() as u64
    }

    /// Normalize tool result to Cursor format.
    /// `raw_args` provides the raw Claude Code args for extracting metadata (e.g. file path, old/new content).
    fn normalize_result(
        cursor_name: &str,
        result_content: &str,
        is_error: bool,
        raw_args: &Value,
    ) -> Value {
        match cursor_name {
            "Shell" => {
                if is_error {
                    serde_json::json!({"error": {"stdout": result_content, "stderr": ""}})
                } else {
                    serde_json::json!({"success": {"exitCode": 0, "stdout": result_content, "stderr": ""}})
                }
            }
            "Edit" => {
                let path = raw_args
                    .get("file_path")
                    .or(raw_args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // Claude Code result is NOT a unified diff — it's a verbose message
                // like "The file has been updated. Here's the result of running cat -n..."
                // Count lines from the original old_string/new_string args instead.
                let old_str = raw_args
                    .get("old_string")
                    .or(raw_args.get("old_str"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_str = raw_args
                    .get("new_string")
                    .or(raw_args.get("new_str"))
                    .or(raw_args.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let lines_added = Self::count_lines(new_str);
                let lines_removed = Self::count_lines(old_str);
                serde_json::json!({"success": {"path": path, "linesAdded": lines_added, "linesRemoved": lines_removed}})
            }
            "Read" => {
                serde_json::json!({"success": {"content": result_content, "totalLines": 0, "fileSize": 0}})
            }
            _ => {
                if is_error {
                    serde_json::json!({"error": {"message": result_content}})
                } else {
                    serde_json::json!({"success": true, "content": result_content})
                }
            }
        }
    }
}

impl CliAgentParser for ClaudeCodeParser {
    fn parse_line(&mut self, line: &str) -> Vec<ActivityChunk> {
        let data: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![],
        };

        let event_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            // ── system (init) ────────────────────────────────────
            "system" => {
                // The init event carries the conversation's session_id up
                // front; capturing it here (not only at the terminal
                // "result" event) lets the runner bind the native
                // transcript mid-turn and shrinks the crash window where a
                // failed run leaves no resume/replay id at all.
                if let Some(sid) = data.get("session_id").and_then(|v| v.as_str()) {
                    if !sid.is_empty() {
                        self.thread_id = Some(sid.to_string());
                    }
                }
                let mut chunk =
                    ActivityChunk::new(&self.session_id, "session_start", "session_start");
                chunk.args = serde_json::json!({
                    "model": data.get("model").and_then(|v| v.as_str()),
                    "cwd": data.get("cwd").and_then(|v| v.as_str()),
                });
                chunk.result = serde_json::json!({"success": true});
                vec![chunk]
            }

            // ── assistant (text + tool_use blocks) ───────────────
            "assistant" => {
                let content_list = data
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());

                let mut chunks = vec![];

                if let Some(items) = content_list {
                    for item in items {
                        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                        match item_type {
                            "text" => {
                                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                if !text.is_empty() {
                                    let mut chunk = ActivityChunk::new(
                                        &self.session_id,
                                        "assistant",
                                        "message",
                                    );
                                    chunk.result = serde_json::json!({
                                        "observation": text,
                                        "content": text,
                                        "role": "assistant",
                                        "is_delta": false,
                                        "is_full_content": true,
                                    });
                                    chunks.push(chunk);
                                }
                            }
                            "thinking" => {
                                let thought =
                                    item.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                                if !thought.is_empty() {
                                    let mut chunk = ActivityChunk::new(
                                        &self.session_id,
                                        "llm_thinking",
                                        "thinking",
                                    );
                                    chunk.result = serde_json::json!({
                                        "thought": thought,
                                        "observation": thought,
                                        "content": thought,
                                    });
                                    chunks.push(chunk);
                                }
                            }
                            "tool_use" => {
                                let tool_id = item
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let claude_name = item
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string();
                                let args = item
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Object(Default::default()));

                                let cursor_name =
                                    normalize_tool_name(CliAgentType::ClaudeCode, &claude_name);
                                let normalized_args =
                                    Self::normalize_args(&cursor_name, &claude_name, &args);

                                // Emit tool_call start
                                let mut chunk =
                                    ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                                if !tool_id.is_empty() {
                                    chunk.chunk_id = format!("tool-call-{tool_id}");
                                }
                                chunk.args = normalized_args.clone();
                                chunk.result = serde_json::json!({
                                    "call_id": tool_id,
                                    "status": "running",
                                });
                                chunks.push(chunk);

                                // Store pending for result matching (raw args + normalized args)
                                self.pending_tools
                                    .insert(tool_id, (cursor_name, args, normalized_args));
                            }
                            _ => {}
                        }
                    }
                }

                chunks
            }

            // ── user (tool_result blocks) ────────────────────────
            "user" => {
                let content_list = data
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());

                let mut chunks = vec![];

                if let Some(items) = content_list {
                    for item in items {
                        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                        if item_type == "tool_result" {
                            let tool_id = item
                                .get("tool_use_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let is_error = item
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);

                            // Get result content
                            let result_content =
                                item.get("content").and_then(|v| v.as_str()).unwrap_or("");

                            // Also check tool_use_result for richer data
                            let tool_use_result = data.get("tool_use_result");

                            // Look up the pending tool call (raw_args for metadata, normalized_args for chunk)
                            let (cursor_name, raw_args, normalized_args) = self
                                .pending_tools
                                .remove(&tool_id)
                                .unwrap_or(("unknown".to_string(), Value::Null, Value::Null));

                            let result = if let Some(tur) = tool_use_result {
                                // Use the richer tool_use_result if available
                                let stdout = tur
                                    .get("stdout")
                                    .or(tur.get("output"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(result_content);
                                let stderr =
                                    tur.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
                                let mut result = Self::normalize_result(
                                    &cursor_name,
                                    stdout,
                                    is_error,
                                    &raw_args,
                                );
                                if !stderr.is_empty() {
                                    if let Some(obj) = result.as_object_mut() {
                                        let key = if obj.contains_key("success") {
                                            "success"
                                        } else {
                                            "error"
                                        };
                                        if let Some(inner) = obj.get_mut(key) {
                                            if let Some(inner_obj) = inner.as_object_mut() {
                                                inner_obj.insert(
                                                    "stderr".to_string(),
                                                    Value::String(stderr.to_string()),
                                                );
                                            }
                                        }
                                    }
                                }
                                result
                            } else {
                                Self::normalize_result(
                                    &cursor_name,
                                    result_content,
                                    is_error,
                                    &raw_args,
                                )
                            };

                            let mut chunk =
                                ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                            if !tool_id.is_empty() {
                                chunk.chunk_id = format!("tool-call-{tool_id}");
                            }
                            // Carry the normalized args onto the result chunk so the frontend
                            // has old_string/new_string/path even without the "running" chunk
                            chunk.args = normalized_args;
                            chunk.result = result;
                            if let Some(obj) = chunk.result.as_object_mut() {
                                obj.insert("call_id".to_string(), Value::String(tool_id));
                            }
                            chunks.push(chunk);
                        }
                    }
                }

                chunks
            }

            // ── tool_use (standalone, Gemini-like format) ────────
            "tool_use" => {
                let tool_name = data
                    .get("tool_name")
                    .or(data.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let tool_id = data
                    .get("id")
                    .or(data.get("tool_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = data
                    .get("input")
                    .or(data.get("parameters"))
                    .cloned()
                    .unwrap_or(Value::Object(Default::default()));

                let cursor_name = normalize_tool_name(CliAgentType::ClaudeCode, tool_name);
                let normalized_args = Self::normalize_args(&cursor_name, tool_name, &args);

                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                if !tool_id.is_empty() {
                    chunk.chunk_id = format!("tool-call-{tool_id}");
                }
                chunk.args = normalized_args.clone();
                chunk.result = serde_json::json!({"call_id": tool_id, "status": "running"});

                self.pending_tools
                    .insert(tool_id, (cursor_name, args, normalized_args));
                vec![chunk]
            }

            // ── tool_result (standalone) ─────────────────────────
            "tool_result" => {
                let tool_id = data
                    .get("tool_use_id")
                    .or(data.get("tool_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = data
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || data.get("status").and_then(|v| v.as_str()) == Some("error");
                let content = data
                    .get("result")
                    .or(data.get("output"))
                    .or(data.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let (cursor_name, raw_args, normalized_args) = self
                    .pending_tools
                    .remove(&tool_id)
                    .unwrap_or(("unknown".to_string(), Value::Null, Value::Null));

                let result = Self::normalize_result(&cursor_name, content, is_error, &raw_args);
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                if !tool_id.is_empty() {
                    chunk.chunk_id = format!("tool-call-{tool_id}");
                }
                chunk.args = normalized_args;
                chunk.result = result;
                if let Some(obj) = chunk.result.as_object_mut() {
                    obj.insert("call_id".to_string(), Value::String(tool_id));
                }
                vec![chunk]
            }

            // ── content_block_start (streaming tool_use identity) ──
            "content_block_start" => {
                let index = data.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let block = data.get("content_block").unwrap_or(&Value::Null);
                let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if block_type != "tool_use" {
                    return vec![];
                }

                let tool_id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let claude_name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let cursor_name = normalize_tool_name(CliAgentType::ClaudeCode, claude_name);
                self.streaming_tool_blocks
                    .insert(index, (tool_id.clone(), cursor_name.clone()));
                vec![self.tool_call_delta_chunk(index, Some(&tool_id), Some(&cursor_name), None)]
            }

            // ── content_block_stop (streaming block lifecycle) ────
            "content_block_stop" => {
                if let Some(index) = data.get("index").and_then(|v| v.as_u64()) {
                    self.streaming_tool_blocks.remove(&(index as usize));
                }
                vec![]
            }

            // ── content_block_delta (streaming text/thinking/tool args) ────
            "content_block_delta" => {
                let delta = data.get("delta").unwrap_or(&Value::Null);
                let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");

                match delta_type {
                    "input_json_delta" => {
                        let index =
                            data.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        let partial_json = delta
                            .get("partial_json")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if partial_json.is_empty() {
                            return vec![];
                        }
                        let (tool_call_id, tool_name) = self
                            .streaming_tool_blocks
                            .get(&index)
                            .map(|(id, name)| (Some(id.as_str()), Some(name.as_str())))
                            .unwrap_or((None, None));
                        vec![self.tool_call_delta_chunk(
                            index,
                            tool_call_id,
                            tool_name,
                            Some(partial_json),
                        )]
                    }
                    "text_delta" => {
                        let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if text.is_empty() {
                            return vec![];
                        }
                        let mut chunk =
                            ActivityChunk::new(&self.session_id, "assistant_delta", "message");
                        chunk.result = serde_json::json!({
                            "observation": text, "content": text, "role": "assistant", "is_delta": true,
                        });
                        chunk.broadcast_only = true;
                        vec![chunk]
                    }
                    "thinking_delta" => {
                        let thought = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                        if thought.is_empty() {
                            return vec![];
                        }
                        let mut chunk =
                            ActivityChunk::new(&self.session_id, "llm_thinking_delta", "thinking");
                        chunk.result = serde_json::json!({
                            "thought": thought, "content": thought, "is_delta": true,
                        });
                        chunk.broadcast_only = true;
                        vec![chunk]
                    }
                    _ => vec![],
                }
            }

            // ── result (session end) ─────────────────────────────
            "result" => {
                // Capture thread ID
                if let Some(sid) = data.get("session_id").and_then(|v| v.as_str()) {
                    self.thread_id = Some(sid.to_string());
                }

                // Capture token usage
                if let Some(usage) = data.get("usage").or(data.get("modelUsage")) {
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
                            .get("cache_read_input_tokens")
                            .or(usage.get("cache_read_tokens"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_write_tokens: usage
                            .get("cache_creation_input_tokens")
                            .or(usage.get("cache_write_tokens"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        total_tokens: input_tokens + output_tokens,
                        model: data
                            .get("model")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                }

                let is_error = data
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let stop_reason = data
                    .get("stop_reason")
                    .or_else(|| data.get("stopReason"))
                    .or_else(|| data.get("subtype"))
                    .and_then(|v| v.as_str());
                let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
                chunk.result = serde_json::json!({
                    "success": !is_error,
                    "error_message": data.get("error").and_then(|v| v.as_str()),
                    "stop_reason": stop_reason,
                });
                vec![chunk]
            }

            _ => vec![],
        }
    }

    fn on_exit(&mut self, exit_code: i32) -> Vec<ActivityChunk> {
        // Only emit session_end if we haven't received a "result" event
        if self.usage.is_some() {
            return vec![]; // Already handled by "result" event
        }
        let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
        chunk.result = serde_json::json!({
            "success": exit_code == 0,
            "exit_code": exit_code,
        });
        vec![chunk]
    }

    fn token_usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }

    fn cli_session_id(&self) -> Option<String> {
        self.thread_id.clone()
    }
}
