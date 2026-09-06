//! Codex `app-server` JSON-RPC transport.
//!
//! Native alternative to the per-turn `codex exec --json` shell-out: spawns
//! `codex app-server` (a JSON-RPC-over-stdio server) and drives one turn per
//! managed-session message. It is the default Codex transport; a launch
//! profile may explicitly select `"transport": "exec"` as a recovery hatch.
//!
//! ## Verified protocol (codex-cli 0.143.0)
//!
//! Discovered empirically via `codex app-server generate-json-schema` plus a
//! live stdio smoke run — the legacy camelCase API (`newConversation` /
//! `sendUserTurn` / `interruptConversation`) no longer exists in this
//! version; the thread/turn API replaced it.
//!
//! Client → server requests:
//! - `initialize` `{clientInfo: {name, title?, version}}` → `{userAgent, codexHome, ...}`;
//!   then the client sends the `initialized` notification.
//! - `thread/start` `{cwd?, model?, developerInstructions?, approvalPolicy?, sandbox?, ...}` →
//!   `{thread: {id, ...}, model, ...}`. `thread.id` (UUIDv7) is the rollout
//!   file stem suffix (`CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`)
//!   — verified live: a non-ephemeral thread materializes the rollout on
//!   disk, so native-transcript replay and managed-mirror suffix dedup keep
//!   working unchanged.
//! - `thread/resume` `{threadId, cwd?, model?, developerInstructions?, approvalPolicy?, sandbox?}` →
//!   same response shape. Resume failures are terminal: silently starting a
//!   fresh thread would discard native conversation history.
//! - `turn/start` `{threadId, input: [{type:"text",text} | {type:"localImage",path}]}`
//!   → `{turn: {id, status: "inProgress"}}`.
//! - A user-only context-overflow turn is recovered once with native
//!   `thread/rollback` → `thread/compact/start` → the same `turn/start`.
//! - `turn/interrupt` `{threadId, turnId}` → `{}`.
//!
//! Server → client notifications (subset we map):
//! - `thread/started` `{thread}` / `turn/started` `{threadId, turn}`
//! - `item/started` / `item/completed` `{threadId, turnId, item}` where
//!   `item.type` ∈ userMessage | agentMessage | reasoning | commandExecution
//!   (`{command, cwd, aggregatedOutput?, exitCode?, status}`) | fileChange
//!   (`{changes: [{path, kind, diff}], status}`) | mcpToolCall | webSearch | …
//! - `item/agentMessage/delta` `{delta, itemId, ...}`,
//!   `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta`
//! - `turn/plan/updated` `{plan: [{step, status: pending|inProgress|completed}]}`
//! - `thread/tokenUsage/updated` `{tokenUsage: {last, total: {inputTokens,
//!   cachedInputTokens, outputTokens, totalTokens, reasoningOutputTokens}}}`
//! - `turn/completed` `{turn: {status: completed|interrupted|failed, error?}}`
//! - `error` `{error: {message}, willRetry}`
//!
//! Server → client requests (approvals; must be answered):
//! - `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
//!   → respond `{decision: "accept" | "decline"}`
//! - legacy `execCommandApproval` / `applyPatchApproval`
//!   → respond `{decision: "approved" | "denied"}`
//!
//! Interactive approval is out of scope for this transport (the approval
//! bridge is a separate feature): requests are auto-answered from the launch
//! profile's permission mode and surfaced as `approval_response` chunks.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use core_types::activity::ActivityChunk;

use super::canonicalize_cli_error_message;
use super::normalizer::{normalize_tool_name, unwrap_codex_command};
use super::types::{CliAgentType, TokenUsage};
use crate::agent_sessions::cli::session_runner::launch_profiles::CliPermissionMode;

mod catalog;
pub(crate) use catalog::{archive_thread, register_thread, synchronize_thread};

/// How long to keep draining after `turn/interrupt` before giving up on a
/// graceful `turn/completed`.
const INTERRUPT_DRAIN_SECS: u64 = 10;

/// Keep provider-native context recovery bounded. Real large transcripts can
/// take well over a minute to compact even after the provider has accepted the
/// request, so this budget must not race Codex's own successful compactor. The
/// owning conversation turn still has its stricter end-to-end deadline.
const CONTEXT_RECOVERY_TIMEOUT_SECS: u64 = 180;

// ============================================
// Interrupt registry (session_id → signal)
// ============================================

static INTERRUPTS: LazyLock<StdMutex<HashMap<String, mpsc::Sender<()>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// RAII registration of an interrupt channel for a running app-server turn.
struct InterruptRegistration {
    session_id: String,
}

impl InterruptRegistration {
    fn register(session_id: &str) -> (Self, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel(1);
        INTERRUPTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_id.to_string(), tx);
        (
            Self {
                session_id: session_id.to_string(),
            },
            rx,
        )
    }
}

impl Drop for InterruptRegistration {
    fn drop(&mut self) {
        INTERRUPTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.session_id);
    }
}

fn interrupt_sender(session_id: &str) -> Option<mpsc::Sender<()>> {
    INTERRUPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .cloned()
}

fn interrupt_registered(session_id: &str) -> bool {
    INTERRUPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(session_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GracefulInterruptOutcome {
    NotRunning,
    Completed,
    TimedOut,
}

/// Ask a running app-server turn to interrupt gracefully and wait (bounded)
/// for it to finish so codex can finalize the rollout before the caller
/// kills the process tree. A timeout is deliberately distinct from success:
/// the runner JSONL may be syntactically valid while its current turn is only
/// partially flushed, so callers must not publish it over the native App copy.
pub async fn interrupt_session_gracefully(session_id: &str) -> GracefulInterruptOutcome {
    let Some(tx) = interrupt_sender(session_id) else {
        return GracefulInterruptOutcome::NotRunning;
    };
    if tx.try_send(()).is_err() {
        // Full (already signalled) or closed — either way just wait below.
        tracing::debug!(
            "[CodexAppServer] Interrupt already pending for {}",
            session_id
        );
    }
    // The transport itself drains for INTERRUPT_DRAIN_SECS. Give its task one
    // extra second to unregister after receiving turn/completed.
    let deadline =
        tokio::time::Instant::now() + tokio::time::Duration::from_secs(INTERRUPT_DRAIN_SECS + 1);
    while tokio::time::Instant::now() < deadline {
        if !interrupt_registered(session_id) {
            return GracefulInterruptOutcome::Completed;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tracing::info!(
        "[CodexAppServer] Graceful interrupt window elapsed for {}; caller will kill",
        session_id
    );
    GracefulInterruptOutcome::TimedOut
}

// ============================================
// Types
// ============================================

/// Per-turn configuration for the app-server transport.
pub struct CodexAppServerTurn {
    pub session_id: String,
    /// Literal user-authored text rendered in the native Codex transcript.
    pub user_input: String,
    /// ORGII execution/workspace/IDE context carried on Codex's native
    /// developer channel. Never copied into `turn/start.input`.
    pub developer_instructions: Option<String>,
    pub working_dir: String,
    /// Stored codex thread id to resume; `None` starts a fresh thread.
    pub resume_thread_id: Option<String>,
    /// Base model name for `thread/start` (already variant-mapped).
    pub model: Option<String>,
    pub permission_mode: CliPermissionMode,
    /// Secret-bearing MCP/session overrides sent only over JSON-RPC.
    pub config: Option<Value>,
    pub image_paths: Vec<String>,
    /// Enabled only on a fresh episode rebuilt from canonical SessionEvents.
    pub allow_native_context_recovery: bool,
}

/// Result of a completed app-server turn.
pub struct CodexAppServerResult {
    /// The codex thread id — rollout-compatible (rollout file stem suffix).
    pub thread_id: String,
    /// Final `turn.status`: completed | interrupted | failed.
    pub turn_status: String,
    pub usage: Option<TokenUsage>,
}

/// approvalPolicy / sandbox params for `thread/start` matching the exec-mode
/// launch-profile table (`launch_profiles::CLI_LAUNCH_PROFILE_DEFAULTS`):
/// Plan = read-only + on-request, Manual = workspace-write + on-request,
/// AutoEdit = workspace-write + never, FullPermission =
/// danger-full-access + never (`--dangerously-bypass-approvals-and-sandbox`).
pub(crate) fn thread_permission_params(mode: CliPermissionMode) -> (&'static str, &'static str) {
    match mode {
        CliPermissionMode::Plan => ("on-request", "read-only"),
        CliPermissionMode::Manual => ("on-request", "workspace-write"),
        CliPermissionMode::AutoEdit => ("never", "workspace-write"),
        CliPermissionMode::FullPermission => ("never", "danger-full-access"),
    }
}

/// Build the strict fresh/resume request for one app-server launch.
///
/// `developerInstructions` is deliberately separate from `baseInstructions`:
/// Codex appends/overrides the caller-owned developer layer while retaining
/// its provider base prompt. The complete current context is sent on every
/// launch, including resume, so a per-launch replacement cannot drop prior
/// ORGII workspace instructions.
pub(crate) fn build_thread_launch_request(turn: &CodexAppServerTurn) -> (&'static str, Value) {
    let (approval_policy, sandbox) = thread_permission_params(turn.permission_mode);
    let mut params = serde_json::json!({
        "cwd": &turn.working_dir,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
    });
    if let Some(ref model) = turn.model {
        params["model"] = Value::String(model.clone());
    }
    if let Some(ref config) = turn.config {
        params["config"] = config.clone();
    }
    if let Some(instructions) = turn
        .developer_instructions
        .as_deref()
        .filter(|instructions| !instructions.trim().is_empty())
    {
        params["developerInstructions"] = Value::String(instructions.to_string());
    }
    if let Some(ref resume_id) = turn.resume_thread_id {
        params["threadId"] = Value::String(resume_id.clone());
        ("thread/resume", params)
    } else {
        ("thread/start", params)
    }
}

/// Build only the native user turn items. Provider context belongs on the
/// thread's developer channel and must never become a `userMessage` item.
pub(crate) fn build_turn_input(turn: &CodexAppServerTurn) -> Vec<Value> {
    let mut input = vec![serde_json::json!({
        "type": "text",
        "text": &turn.user_input,
    })];
    input.extend(
        turn.image_paths
            .iter()
            .map(|path| serde_json::json!({"type": "localImage", "path": path})),
    );
    input
}

/// Whether an approval request is auto-accepted for this permission mode.
/// Only FullPermission auto-accepts (mirroring exec's bypass flag). Manual
/// and Plan follow codex default-deny semantics — the denial is surfaced as
/// an `approval_response` chunk so the user sees why the command didn't run.
/// AutoEdit maps to approvalPolicy=never, so requests should not occur; if
/// one does, deny to mirror exec (never = never escalate).
pub(crate) fn approval_auto_accept(mode: CliPermissionMode) -> bool {
    matches!(mode, CliPermissionMode::FullPermission)
}

// ============================================
// Event → ActivityChunk parser (pure, testable)
// ============================================

pub(crate) struct CodexAppServerEventParser {
    session_id: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    usage: Option<TokenUsage>,
    /// Final turn status once `turn/completed` arrives.
    turn_status: Option<String>,
    turn_error: Option<String>,
    session_start_emitted: bool,
    error_deduper: super::BoundedCliErrorDeduper,
    /// Held until `turn/completed`, whose error body is authoritative.
    pending_error_message: Option<String>,
    /// Last `willRetry` error, kept only as a body of last resort. Codex
    /// retries past these, so it must never be rendered on its own — but a
    /// `turn/completed` that reports failure without an error body leaves the
    /// turn with no message at all, and this is the only thing left to say.
    last_retry_notice: Option<String>,
    /// `thread/rollback` removes history, not filesystem changes. Automatic
    /// replay is therefore allowed only before output or tools have started.
    replay_unsafe_output_seen: bool,
    compaction_marker_emitted: bool,
}

impl CodexAppServerEventParser {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            thread_id: None,
            turn_id: None,
            usage: None,
            turn_status: None,
            turn_error: None,
            session_start_emitted: false,
            error_deduper: super::BoundedCliErrorDeduper::default(),
            pending_error_message: None,
            last_retry_notice: None,
            replay_unsafe_output_seen: false,
            compaction_marker_emitted: false,
        }
    }

    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    pub fn turn_id(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }

    pub fn usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }

    pub fn turn_status(&self) -> Option<&str> {
        self.turn_status.as_deref()
    }

    pub fn turn_error(&self) -> Option<&str> {
        self.turn_error.as_deref()
    }

    fn completed_turn_error<'a>(&'a self, params: &'a Value) -> Option<&'a str> {
        params
            .get("turn")
            .and_then(|turn| turn.get("error"))
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or(self.pending_error_message.as_deref())
            .or(self.last_retry_notice.as_deref())
    }

    fn should_recover_context_exhaustion(&self, params: &Value) -> bool {
        params
            .get("turn")
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            == Some("failed")
            // A provider-observed compaction already advanced this logical
            // turn's native history. Never issue ORG2's recovery compact on
            // the same turn as well: that would roll twice and can discard
            // the first compacted episode's resume boundary.
            && !self.compaction_marker_emitted
            && !self.replay_unsafe_output_seen
            && self
                .completed_turn_error(params)
                .is_some_and(app_utils::runtime_errors::is_context_exhausted_message)
    }

    fn reset_turn_state(&mut self) {
        self.turn_id = None;
        self.usage = None;
        self.turn_status = None;
        self.turn_error = None;
        self.pending_error_message = None;
        self.last_retry_notice = None;
        self.error_deduper = super::BoundedCliErrorDeduper::default();
        self.replay_unsafe_output_seen = false;
    }

    fn native_compaction_marker(&mut self) -> Vec<ActivityChunk> {
        if self.compaction_marker_emitted {
            return vec![];
        }
        self.compaction_marker_emitted = true;
        let mut chunk =
            ActivityChunk::new(&self.session_id, "context_compacted", "context_compacted");
        chunk.result = serde_json::json!({
            "success": true,
            "native": true,
            "provider": "codex",
        });
        vec![chunk]
    }

    /// Record the thread id from a `thread/start` / `thread/resume` response
    /// and emit the `session_start` chunk (carrying `thread_id` so the
    /// runner can early-bind the rollout-compatible id).
    pub fn on_thread_response(&mut self, result: &Value) -> Vec<ActivityChunk> {
        let tid = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str());
        if let Some(tid) = tid {
            self.thread_id = Some(tid.to_string());
        }
        self.emit_session_start()
    }

    /// Publish a provider-native UUID rollover immediately.
    ///
    /// A context-recovery fork happens inside one app-server transport turn,
    /// after the ordinary `session_start` was already emitted. Waiting for
    /// finalization to persist the fork id leaves a short but real window in
    /// which an immediate follow-up resumes the overflowing source UUID and
    /// compacts again. A lifecycle-only session_start chunk reuses the normal
    /// CLI binding channel without adding a chat-visible transcript row.
    fn on_thread_rebound(&mut self, result: &Value) -> Vec<ActivityChunk> {
        let tid = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str);
        let Some(tid) = tid else {
            return vec![];
        };
        self.thread_id = Some(tid.to_string());
        let mut chunk = ActivityChunk::new(&self.session_id, "session_start", "session_start");
        chunk.result = serde_json::json!({
            "success": true,
            "native_rollover": true,
        });
        chunk.thread_id = Some(tid.to_string());
        vec![chunk]
    }

    fn emit_session_start(&mut self) -> Vec<ActivityChunk> {
        if self.session_start_emitted {
            return vec![];
        }
        self.session_start_emitted = true;
        let mut chunk = ActivityChunk::new(&self.session_id, "session_start", "session_start");
        chunk.result = serde_json::json!({"success": true});
        chunk.thread_id = self.thread_id.clone();
        vec![chunk]
    }

    /// Map a server notification to chunks.
    pub fn handle_notification(&mut self, method: &str, params: &Value) -> Vec<ActivityChunk> {
        match method {
            "thread/started" => {
                if self.thread_id.is_none() {
                    if let Some(tid) = params
                        .get("thread")
                        .and_then(|t| t.get("id"))
                        .and_then(|v| v.as_str())
                    {
                        self.thread_id = Some(tid.to_string());
                    }
                }
                self.emit_session_start()
            }
            "turn/started" => {
                if let Some(turn_id) = params
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(|v| v.as_str())
                {
                    self.turn_id = Some(turn_id.to_string());
                }
                vec![]
            }
            "item/started" => self.parse_item(params, false),
            "item/completed" => self.parse_item(params, true),
            "item/agentMessage/delta" => {
                self.replay_unsafe_output_seen = true;
                let text = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
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
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                self.replay_unsafe_output_seen = true;
                let text = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                let mut chunk =
                    ActivityChunk::new(&self.session_id, "llm_thinking_delta", "thinking");
                chunk.result = serde_json::json!({
                    "thought": text, "content": text, "is_delta": true,
                });
                chunk.broadcast_only = true;
                vec![chunk]
            }
            "turn/plan/updated" => {
                self.replay_unsafe_output_seen = true;
                let todos: Vec<Value> = params
                    .get("plan")
                    .and_then(|v| v.as_array())
                    .map(|steps| {
                        steps
                            .iter()
                            .enumerate()
                            .map(|(idx, step)| {
                                let status =
                                    match step.get("status").and_then(|v| v.as_str()).unwrap_or("")
                                    {
                                        "inProgress" => "in_progress",
                                        "completed" => "completed",
                                        _ => "pending",
                                    };
                                serde_json::json!({
                                    "id": (idx + 1).to_string(),
                                    "content": step.get("step").and_then(|v| v.as_str()).unwrap_or(""),
                                    "status": status,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if todos.is_empty() {
                    return vec![];
                }
                let todos = Value::Array(todos);
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", "UpdateTodos");
                chunk.args = serde_json::json!({ "todos": &todos, "merge": false });
                chunk.result = serde_json::json!({ "success": true, "todos": &todos });
                vec![chunk]
            }
            "thread/tokenUsage/updated" => {
                if let Some(last) = params.get("tokenUsage").and_then(|u| u.get("last")) {
                    let read = |key: &str| last.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
                    let input_tokens = read("inputTokens");
                    let output_tokens = read("outputTokens");
                    let reported_total = read("totalTokens");
                    self.usage = Some(TokenUsage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens: read("cachedInputTokens"),
                        cache_write_tokens: 0,
                        total_tokens: if reported_total > 0 {
                            reported_total
                        } else {
                            input_tokens.saturating_add(output_tokens)
                        },
                        model: None,
                    });
                }
                vec![]
            }
            "thread/compacted" => self.native_compaction_marker(),
            "turn/completed" => {
                let status = params
                    .get("turn")
                    .and_then(|t| t.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed")
                    .to_string();
                let terminal_error_message = params
                    .get("turn")
                    .and_then(|t| t.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .map(canonicalize_cli_error_message)
                    .filter(|message| !message.is_empty());
                let success = status == "completed";
                // The retry notice is the weakest signal there is: only a turn
                // that actually failed may borrow it, an interrupted one has a
                // better reason of its own — and it never outlives the turn.
                let retry_fallback = self.last_retry_notice.take().filter(|_| status == "failed");
                let error_message = if success {
                    self.pending_error_message = None;
                    None
                } else {
                    terminal_error_message
                        .or_else(|| self.pending_error_message.take())
                        .or(retry_fallback)
                };
                let mut chunk = ActivityChunk::new(&self.session_id, "session_end", "session_end");
                let mut result = serde_json::json!({
                    "success": success,
                    "stop_reason": &status,
                });
                if let Some(ref msg) = error_message {
                    result["error_message"] = Value::String(msg.clone());
                }
                chunk.result = result;
                self.turn_status = Some(status);
                self.turn_error = error_message;
                vec![chunk]
            }
            "error" => {
                let message = params
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                let will_retry = params
                    .get("willRetry")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if will_retry {
                    tracing::warn!("[CodexAppServer] Retryable error: {}", message);
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
            other => {
                tracing::debug!("[CodexAppServer] Ignoring notification: {}", other);
                vec![]
            }
        }
    }

    /// Map v2 camelCase item types onto the exec-JSONL snake_case vocabulary
    /// so `normalize_tool_name(CliAgentType::Codex, …)` and the frontend see
    /// the same names the shell-out parser produces.
    fn exec_item_type(v2_type: &str) -> &str {
        match v2_type {
            "commandExecution" => "command_execution",
            "fileChange" => "file_change",
            "mcpToolCall" => "mcp_tool_call",
            "agentMessage" => "agent_message",
            "webSearch" => "web_search",
            other => other,
        }
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

    fn parse_item(&mut self, params: &Value, completed: bool) -> Vec<ActivityChunk> {
        let item = params.get("item").unwrap_or(&Value::Null);
        let v2_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_type = Self::exec_item_type(v2_type);
        let call_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty());

        if !matches!(v2_type, "userMessage" | "hookPrompt" | "contextCompaction") {
            self.replay_unsafe_output_seen = true;
        }

        match item_type {
            // The runner already emits the user bubble; codex echoes it back.
            "userMessage" | "hookPrompt" => vec![],
            // Deltas stream the text; `plan` item text is the experimental
            // proposed-plan prose (turn/plan/updated carries the todo list).
            "plan" | "reasoning" if !completed => vec![],
            "agent_message" => {
                if !completed {
                    return vec![]; // deltas stream the text
                }
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                let mut chunk = ActivityChunk::new(&self.session_id, "assistant", "message");
                chunk.result = serde_json::json!({
                    "observation": text, "content": text, "role": "assistant",
                    "is_delta": false, "is_full_content": true,
                });
                vec![chunk]
            }
            "reasoning" => {
                let parts: Vec<&str> = item
                    .get("summary")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
                    .unwrap_or_default();
                let thought = parts.join("\n");
                if thought.is_empty() {
                    return vec![];
                }
                let mut chunk = ActivityChunk::new(&self.session_id, "llm_thinking", "thinking");
                chunk.result = serde_json::json!({
                    "thought": thought, "observation": thought, "content": thought,
                });
                vec![chunk]
            }
            "command_execution" => {
                let cursor_name = normalize_tool_name(CliAgentType::Codex, item_type);
                let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let actual_cmd = unwrap_codex_command(command);
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                if completed {
                    let output = item
                        .get("aggregatedOutput")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let exit_code = item.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(-1);
                    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    let is_error = status == "failed" || status == "declined" || exit_code != 0;
                    chunk.args = serde_json::json!({"command": actual_cmd});
                    chunk.result = if is_error {
                        serde_json::json!({"error": {"exitCode": exit_code, "stdout": output, "stderr": ""}})
                    } else {
                        serde_json::json!({"success": {"exitCode": exit_code, "stdout": output, "stderr": ""}})
                    };
                } else {
                    chunk.args = serde_json::json!({
                        "command": actual_cmd,
                        "workingDirectory": item.get("cwd").and_then(|v| v.as_str()),
                    });
                    chunk.result = serde_json::json!({"status": "running"});
                }
                Self::stamp_tool_call_identity(&mut chunk, call_id);
                vec![chunk]
            }
            "file_change" => {
                let cursor_name = normalize_tool_name(CliAgentType::Codex, item_type);
                let changes = item.get("changes").and_then(|v| v.as_array());
                let path = changes
                    .and_then(|arr| arr.first())
                    .and_then(|c| c.get("path").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", &cursor_name);
                chunk.args = serde_json::json!({"path": path});
                if completed {
                    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    let is_error = status == "failed" || status == "declined";
                    let files: Vec<&str> = changes
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|c| c.get("path").and_then(|v| v.as_str()))
                                .collect()
                        })
                        .unwrap_or_default();
                    chunk.result = if is_error {
                        serde_json::json!({"error": {"path": path, "message": format!("File change {status}.")}})
                    } else {
                        serde_json::json!({
                            "success": {"path": path, "files": files, "message": "File updated."}
                        })
                    };
                } else {
                    chunk.result = serde_json::json!({"status": "running"});
                }
                Self::stamp_tool_call_identity(&mut chunk, call_id);
                vec![chunk]
            }
            "mcp_tool_call" => {
                if !completed {
                    return vec![];
                }
                let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("mcp");
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", tool);
                chunk.args = item
                    .get("arguments")
                    .cloned()
                    .unwrap_or(Value::Object(Default::default()));
                chunk.result = item
                    .get("error")
                    .filter(|e| !e.is_null())
                    .map(|e| serde_json::json!({"error": e}))
                    .or_else(|| item.get("result").filter(|r| !r.is_null()).cloned())
                    .unwrap_or(serde_json::json!({}));
                Self::stamp_tool_call_identity(&mut chunk, call_id);
                vec![chunk]
            }
            "web_search" => {
                if !completed {
                    return vec![];
                }
                let query = item.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let mut chunk = ActivityChunk::new(&self.session_id, "tool_call", "web_search");
                chunk.args = serde_json::json!({"query": query});
                chunk.result = serde_json::json!({"success": true});
                Self::stamp_tool_call_identity(&mut chunk, call_id);
                vec![chunk]
            }
            "contextCompaction" => {
                if !completed {
                    return vec![];
                }
                self.native_compaction_marker()
            }
            other => {
                tracing::debug!("[CodexAppServer] Ignoring item type: {}", other);
                vec![]
            }
        }
    }
}

// ============================================
// JSON-RPC helpers
// ============================================

async fn rpc_send(
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
    write_line(stdin, &msg).await
}

async fn rpc_notify(stdin: &mut ChildStdin, method: &str) -> Result<(), String> {
    let msg = serde_json::json!({"jsonrpc": "2.0", "method": method});
    write_line(stdin, &msg).await
}

async fn rpc_respond(stdin: &mut ChildStdin, request_id: &Value, result: Value) {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    });
    if let Err(err) = write_line(stdin, &msg).await {
        tracing::warn!("[CodexAppServer] Failed to send response: {}", err);
    }
}

async fn rpc_respond_error(stdin: &mut ChildStdin, request_id: &Value, message: &str) {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": message},
    });
    if let Err(err) = write_line(stdin, &msg).await {
        tracing::warn!("[CodexAppServer] Failed to send error response: {}", err);
    }
}

async fn write_line(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("app-server write error: {}", err))?;
    stdin
        .flush()
        .await
        .map_err(|err| format!("app-server flush error: {}", err))
}

async fn read_message(
    reader: &mut BufReader<ChildStdout>,
    buf: &mut String,
) -> Result<Value, String> {
    loop {
        buf.clear();
        match reader.read_line(buf).await {
            Ok(0) => return Err("app-server: unexpected EOF".into()),
            Ok(_) => {
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = serde_json::from_str(trimmed)
                    .map_err(|err| format!("app-server JSON parse error: {}", err))?;
                if val.get("error").is_some() {
                    tracing::warn!("[CodexAppServer] ← {}", trimmed);
                } else {
                    let preview: String = trimmed.chars().take(300).collect();
                    tracing::debug!("[CodexAppServer] ← {}", preview);
                }
                return Ok(val);
            }
            Err(err) => return Err(format!("app-server read error: {}", err)),
        }
    }
}

/// Reusable app-server RPC owner for non-turn operations such as native
/// thread registration. It shares the exact JSON-RPC codec used by managed
/// turns; callers no longer spawn a second blocking protocol client.
pub(crate) struct CodexAppServerRpcClient {
    _child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    buffer: String,
    next_id: u64,
}

impl CodexAppServerRpcClient {
    pub(crate) async fn launch(
        command_path: &Path,
        codex_home: &Path,
        cwd: &Path,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(codex_home).map_err(|error| {
            format!(
                "create Codex native profile {}: {error}",
                codex_home.display()
            )
        })?;
        // This client publishes the *Codex App* catalog. It is intentionally
        // independent from the CLI runner launch profile: that profile may
        // select an older shell-installed binary or inject a session-scoped
        // provider environment that the native App cannot read later.
        let mut command = Command::new(command_path);
        command
            .arg("app-server")
            .env("CODEX_HOME", codex_home)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "start Codex app-server {} for native profile {}: {error}",
                command_path.display(),
                codex_home.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin was not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout was not piped".to_string())?;
        let mut client = Self {
            _child: child,
            stdin,
            reader: BufReader::new(stdout),
            buffer: String::new(),
            next_id: 0,
        };
        client
            .request(
                "initialize",
                serde_json::json!({
                    "clientInfo": {
                        "name": "orgii",
                        "title": "ORGII",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {"experimentalApi": true}
                }),
                Duration::from_secs(20),
            )
            .await?;
        client.notify("initialized").await?;
        Ok(client)
    }

    pub(crate) async fn notify(&mut self, method: &str) -> Result<(), String> {
        rpc_notify(&mut self.stdin, method).await
    }

    pub(crate) async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let request_id = self.next_id;
        rpc_send(&mut self.stdin, request_id, method, params).await?;
        tokio::time::timeout(timeout, async {
            loop {
                let response = read_message(&mut self.reader, &mut self.buffer).await?;
                if response.get("id").and_then(Value::as_u64) != Some(request_id)
                    || response.get("method").is_some()
                {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    return Err(format!("Codex app-server {method} failed: {error}"));
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| format!("Codex app-server {method} returned no result"));
            }
        })
        .await
        .map_err(|_| format!("Codex app-server {method} reached its request deadline"))?
    }
}

/// Await the response for `request_id`, feeding any interleaved
/// notifications / server requests through the parser.
async fn await_response(
    reader: &mut BufReader<ChildStdout>,
    stdin: &mut ChildStdin,
    buf: &mut String,
    request_id: u64,
    parser: &mut CodexAppServerEventParser,
    chunk_tx: &mpsc::Sender<ActivityChunk>,
    mode: CliPermissionMode,
) -> Result<Result<Value, Value>, String> {
    loop {
        let msg = read_message(reader, buf).await?;
        if msg.get("id").and_then(|v| v.as_u64()) == Some(request_id) && msg.get("method").is_none()
        {
            if let Some(err) = msg.get("error") {
                return Ok(Err(err.clone()));
            }
            return Ok(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
        }
        dispatch_server_message(&msg, stdin, parser, chunk_tx, mode).await;
    }
}

/// Handle one server-initiated message (notification or approval request).
async fn dispatch_server_message(
    msg: &Value,
    stdin: &mut ChildStdin,
    parser: &mut CodexAppServerEventParser,
    chunk_tx: &mpsc::Sender<ActivityChunk>,
    mode: CliPermissionMode,
) {
    let Some(method) = msg.get("method").and_then(|v| v.as_str()) else {
        return; // Response to a request we are not awaiting — ignore.
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // Server request (has an id) — must be answered.
    if let Some(req_id) = msg.get("id") {
        let accept = approval_auto_accept(mode);
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let decision = if accept { "accept" } else { "decline" };
                rpc_respond(stdin, req_id, serde_json::json!({"decision": decision})).await;
                emit_approval_chunk(parser, chunk_tx, method, &params, accept, mode).await;
            }
            "execCommandApproval" | "applyPatchApproval" => {
                let decision = if accept { "approved" } else { "denied" };
                rpc_respond(stdin, req_id, serde_json::json!({"decision": decision})).await;
                emit_approval_chunk(parser, chunk_tx, method, &params, accept, mode).await;
            }
            other => {
                tracing::info!(
                    "[CodexAppServer] Declining unsupported server request: {}",
                    other
                );
                rpc_respond_error(
                    stdin,
                    req_id,
                    "ORGII app-server transport does not support this request",
                )
                .await;
            }
        }
        return;
    }

    // Notification.
    for chunk in parser.handle_notification(method, &params) {
        let _ = chunk_tx.send(chunk).await;
    }
}

/// Surface an auto-answered approval as an `approval_response` chunk so the
/// user sees what was allowed/denied (interactive approval is a separate
/// feature — see module docs).
async fn emit_approval_chunk(
    parser: &CodexAppServerEventParser,
    chunk_tx: &mpsc::Sender<ActivityChunk>,
    method: &str,
    params: &Value,
    approved: bool,
    mode: CliPermissionMode,
) {
    let description = params
        .get("command")
        .and_then(|v| v.as_str())
        .map(|cmd| format!("Command: {}", unwrap_codex_command(cmd)))
        .or_else(|| {
            params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|r| r.to_string())
        })
        .unwrap_or_default();
    let tool_name = if method.contains("ommandExec") {
        "Shell"
    } else if method.contains("ileChange") || method.contains("applyPatch") {
        "Edit"
    } else {
        "unknown_tool"
    };
    let mut chunk =
        ActivityChunk::new(&parser.session_id, "approval_response", "approval_response");
    chunk.result = serde_json::json!({
        "approved": approved,
        "always_allow": false,
        "tool_name": tool_name,
        "description": description,
        "auto": true,
        "permission_mode": format!("{:?}", mode),
    });
    let _ = chunk_tx.send(chunk).await;
}

struct ContextRecovery<'a> {
    stdin: &'a mut ChildStdin,
    reader: &'a mut BufReader<ChildStdout>,
    buf: &'a mut String,
    request_id: &'a mut u64,
    parser: &'a mut CodexAppServerEventParser,
    chunk_tx: &'a mpsc::Sender<ActivityChunk>,
    mode: CliPermissionMode,
}

impl ContextRecovery<'_> {
    async fn rollback_failed_turn(&mut self, thread_id: &str) -> Result<(), String> {
        *self.request_id += 1;
        rpc_send(
            self.stdin,
            *self.request_id,
            "thread/rollback",
            serde_json::json!({"threadId": thread_id, "numTurns": 1}),
        )
        .await?;
        match await_response(
            self.reader,
            self.stdin,
            self.buf,
            *self.request_id,
            self.parser,
            self.chunk_tx,
            self.mode,
        )
        .await?
        {
            Ok(_) => Ok(()),
            Err(error) => Err(format!("app-server thread/rollback error: {error}")),
        }
    }

    /// Run Codex's provider-native compactor and drain its internal turn
    /// without exposing that turn as the user's terminal `session_end`.
    async fn compact_native_thread(&mut self, thread_id: &str) -> Result<(), String> {
        *self.request_id += 1;
        let compact_request_id = *self.request_id;
        rpc_send(
            self.stdin,
            compact_request_id,
            "thread/compact/start",
            serde_json::json!({"threadId": thread_id}),
        )
        .await?;

        let mut response_received = false;
        let mut turn_completed = false;
        while !response_received || !turn_completed {
            let message = read_message(self.reader, self.buf).await?;
            if message.get("id").and_then(Value::as_u64) == Some(compact_request_id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(format!("app-server thread/compact/start error: {error}"));
                }
                response_received = true;
                continue;
            }

            if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                // Record the compactor's terminal state, but suppress its
                // session_end: the original user turn is still running.
                let _ = self.parser.handle_notification("turn/completed", &params);
                if self.parser.turn_status() != Some("completed") {
                    return Err(format!(
                        "Codex native compaction ended with status {}: {}",
                        self.parser.turn_status().unwrap_or("unknown"),
                        self.parser.turn_error().unwrap_or("no error details")
                    ));
                }
                turn_completed = true;
                continue;
            }

            dispatch_server_message(&message, self.stdin, self.parser, self.chunk_tx, self.mode)
                .await;
        }
        Ok(())
    }

    /// Fork the compacted provider thread before replaying the user's turn.
    ///
    /// Codex keeps cumulative window accounting on the source UUID. Resuming
    /// that UUID after a successful compact can therefore auto-compact again
    /// at the beginning of every later turn even though the replacement
    /// history is small. `thread/fork` is Codex's native rollover primitive:
    /// it carries the structured compacted history (including encrypted
    /// provider state) into a fresh UUID without rendering it into a prompt.
    async fn fork_compacted_thread(&mut self, thread_id: &str) -> Result<String, String> {
        *self.request_id += 1;
        rpc_send(
            self.stdin,
            *self.request_id,
            "thread/fork",
            serde_json::json!({"threadId": thread_id}),
        )
        .await?;
        let result = match await_response(
            self.reader,
            self.stdin,
            self.buf,
            *self.request_id,
            self.parser,
            self.chunk_tx,
            self.mode,
        )
        .await?
        {
            Ok(result) => result,
            Err(error) => return Err(format!("app-server thread/fork error: {error}")),
        };
        for chunk in self.parser.on_thread_rebound(&result) {
            let _ = self.chunk_tx.send(chunk).await;
        }
        self.parser
            .thread_id()
            .filter(|forked| *forked != thread_id)
            .map(str::to_string)
            .ok_or_else(|| "app-server thread/fork returned no fresh thread id".to_string())
    }

    async fn run(&mut self, thread_id: &str) -> Result<String, String> {
        self.rollback_failed_turn(thread_id).await?;
        self.parser.reset_turn_state();
        self.compact_native_thread(thread_id).await?;
        self.parser.reset_turn_state();
        self.fork_compacted_thread(thread_id).await
    }
}

async fn start_turn(
    stdin: &mut ChildStdin,
    request_id: &mut u64,
    thread_id: &str,
    input: &[Value],
) -> Result<u64, String> {
    *request_id += 1;
    let turn_request_id = *request_id;
    rpc_send(
        stdin,
        turn_request_id,
        "turn/start",
        serde_json::json!({"threadId": thread_id, "input": input}),
    )
    .await?;
    Ok(turn_request_id)
}

// ============================================
// Protocol flow
// ============================================

/// Run one managed-session turn over `codex app-server` stdio.
///
/// initialize → initialized → thread/resume | thread/start → turn/start →
/// notification loop (approvals auto-answered) → turn/completed.
/// An interrupt signal (see [`interrupt_session_gracefully`]) sends
/// `turn/interrupt` and drains until the turn completes.
pub async fn run_app_server_turn(
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    turn: CodexAppServerTurn,
    chunk_tx: mpsc::Sender<ActivityChunk>,
) -> Result<CodexAppServerResult, String> {
    let (_registration, mut interrupt_rx) = InterruptRegistration::register(&turn.session_id);
    let mut reader = BufReader::new(stdout);
    let mut parser = CodexAppServerEventParser::new(&turn.session_id);
    let mut buf = String::new();
    let mut request_id: u64 = 0;
    let mode = turn.permission_mode;

    // ── Step 1: initialize ──
    request_id += 1;
    rpc_send(
        &mut stdin,
        request_id,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "orgii",
                "title": "ORGII",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
    )
    .await?;
    match await_response(
        &mut reader,
        &mut stdin,
        &mut buf,
        request_id,
        &mut parser,
        &chunk_tx,
        mode,
    )
    .await?
    {
        Ok(result) => {
            tracing::info!(
                "[CodexAppServer] initialize ok: userAgent={}",
                result
                    .get("userAgent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
            );
        }
        Err(err) => return Err(format!("app-server initialize error: {}", err)),
    }
    rpc_notify(&mut stdin, "initialized").await?;

    // ── Step 2: strict thread/resume or explicit fresh thread/start ──
    let (thread_method, thread_params) = build_thread_launch_request(&turn);
    request_id += 1;
    rpc_send(&mut stdin, request_id, thread_method, thread_params).await?;
    let thread_result = match await_response(
        &mut reader,
        &mut stdin,
        &mut buf,
        request_id,
        &mut parser,
        &chunk_tx,
        mode,
    )
    .await?
    {
        Ok(result) => result,
        Err(err) => return Err(format!("app-server {thread_method} error: {err}")),
    };

    for chunk in parser.on_thread_response(&thread_result) {
        let _ = chunk_tx.send(chunk).await;
    }
    let mut thread_id = parser
        .thread_id()
        .ok_or_else(|| "app-server: thread response carried no thread id".to_string())?
        .to_string();
    let response_model = thread_result
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    tracing::info!(
        "[CodexAppServer] thread ready: id={} model={:?} (resume={})",
        thread_id,
        response_model,
        turn.resume_thread_id.is_some()
    );

    // ── Step 3: turn/start ──
    let input = build_turn_input(&turn);
    let mut turn_req_id = start_turn(&mut stdin, &mut request_id, &thread_id, &input).await?;

    // ── Step 4: notification loop until turn/completed ──
    let mut turn_started = false;
    let mut interrupt_sent = false;
    let mut interrupt_deadline: Option<tokio::time::Instant> = None;
    let mut context_recovery_attempted = false;

    loop {
        // After turn/interrupt is sent, drain with a bounded deadline so a
        // silent server can't hold the turn open past the interrupt.
        let msg = if let Some(deadline) = interrupt_deadline {
            match tokio::time::timeout_at(deadline, read_message(&mut reader, &mut buf)).await {
                Ok(msg) => msg?,
                Err(_) => {
                    tracing::warn!(
                        "[CodexAppServer] No turn/completed within {}s of turn/interrupt; giving up",
                        INTERRUPT_DRAIN_SECS
                    );
                    break;
                }
            }
        } else {
            tokio::select! {
                msg = read_message(&mut reader, &mut buf) => msg?,
                _ = interrupt_rx.recv(), if !interrupt_sent => {
                    interrupt_sent = true;
                    interrupt_deadline = Some(
                        tokio::time::Instant::now()
                            + tokio::time::Duration::from_secs(INTERRUPT_DRAIN_SECS),
                    );
                    if let Some(turn_id) = parser.turn_id() {
                        request_id += 1;
                        tracing::info!("[CodexAppServer] Sending turn/interrupt for {}", turn_id);
                        rpc_send(
                            &mut stdin,
                            request_id,
                            "turn/interrupt",
                            serde_json::json!({"threadId": &thread_id, "turnId": turn_id}),
                        )
                        .await?;
                    } else {
                        tracing::info!("[CodexAppServer] Interrupt before turn started; stopping");
                        break;
                    }
                    continue;
                }
            }
        };

        // turn/start response: contains the turn id (turn/started also carries it).
        if msg.get("id").and_then(|v| v.as_u64()) == Some(turn_req_id)
            && msg.get("method").is_none()
        {
            if let Some(err) = msg.get("error") {
                return Err(format!("app-server turn/start error: {}", err));
            }
            if let Some(result) = msg.get("result") {
                parser.handle_notification("turn/started", result);
            }
            turn_started = true;
            continue;
        }

        if msg.get("method").and_then(Value::as_str) == Some("turn/completed") {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let original_terminal_error = parser.completed_turn_error(&params).map(str::to_string);
            let should_recover = turn.allow_native_context_recovery
                && !context_recovery_attempted
                && parser.should_recover_context_exhaustion(&params);
            if should_recover {
                context_recovery_attempted = true;
                tracing::info!(
                    thread_id,
                    "Codex context exhausted before output; applying native compaction"
                );
                let recovery = {
                    let mut recovery = ContextRecovery {
                        stdin: &mut stdin,
                        reader: &mut reader,
                        buf: &mut buf,
                        request_id: &mut request_id,
                        parser: &mut parser,
                        chunk_tx: &chunk_tx,
                        mode,
                    };
                    tokio::time::timeout(
                        tokio::time::Duration::from_secs(CONTEXT_RECOVERY_TIMEOUT_SECS),
                        recovery.run(&thread_id),
                    )
                    .await
                };
                match recovery {
                    Ok(Ok(forked_thread_id)) => {
                        thread_id = forked_thread_id;
                        turn_req_id =
                            start_turn(&mut stdin, &mut request_id, &thread_id, &input).await?;
                        turn_started = false;
                        interrupt_deadline = None;
                        tracing::info!(
                            thread_id,
                            "Codex native compaction rolled to a fresh thread; retrying original turn"
                        );
                        continue;
                    }
                    Ok(Err(error)) => tracing::warn!(
                        thread_id,
                        error = %error,
                        "Codex native context recovery failed"
                    ),
                    Err(_) => tracing::warn!(
                        thread_id,
                        timeout_secs = CONTEXT_RECOVERY_TIMEOUT_SECS,
                        "Codex native context recovery timed out"
                    ),
                }
                // Recovery maintenance turns reset parser-local state. If the
                // authoritative failed completion carried its error through a
                // preceding `error` notification rather than `turn.error`,
                // restore it before parsing that original terminal event.
                parser.pending_error_message = original_terminal_error;
            }
            // Successful recovery deliberately suppresses the overflowing
            // attempt's terminal event. If rollback/compact/fork fails, parse
            // the original authoritative completion only now. Recovery resets
            // parser turn state while driving its maintenance turns; parsing
            // up front used to lose the failed status and leave this loop
            // waiting forever after a maintenance error.
            let terminal_chunks = parser.handle_notification("turn/completed", &params);
            for chunk in terminal_chunks {
                let _ = chunk_tx.send(chunk).await;
            }
        } else {
            dispatch_server_message(&msg, &mut stdin, &mut parser, &chunk_tx, mode).await;
        }

        if parser.turn_status().is_some() {
            break;
        }
    }

    let turn_status = parser
        .turn_status()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "interrupted".to_string());
    if !turn_started && turn_status == "interrupted" {
        // Interrupted before the turn even started — still emit session_end
        // so the transcript shows the turn boundary.
        let mut end_chunk = ActivityChunk::new(&turn.session_id, "session_end", "session_end");
        end_chunk.result = serde_json::json!({"success": false, "stop_reason": "interrupted"});
        let _ = chunk_tx.send(end_chunk).await;
    }

    if turn_status == "failed" {
        if let Some(err) = parser.turn_error() {
            tracing::warn!("[CodexAppServer] Turn failed: {}", err);
        }
    }

    let usage = parser.usage().map(|mut usage| {
        usage.model = response_model.clone().or_else(|| turn.model.clone());
        usage
    });

    Ok(CodexAppServerResult {
        thread_id,
        turn_status,
        usage,
    })
}

#[cfg(test)]
#[path = "tests/codex_app_server_tests.rs"]
mod tests;
