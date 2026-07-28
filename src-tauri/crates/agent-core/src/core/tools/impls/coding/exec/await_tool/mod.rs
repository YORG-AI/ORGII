//! Await tool — monitor background jobs via subcommands.
//!
//! Supports both shell processes and background subagents via a unified string
//! handle. Accepts one or many handles per call so agents can wait for / check
//! a batch of jobs in a single round-trip.
//!
//! ## Subcommands
//!
//! | command    | blocking? | multi-handle | description                                          |
//! |------------|-----------|--------------|------------------------------------------------------|
//! | `wait_for` | yes       | yes          | Block until pattern matches, job(s) end, or timeout. |
//! | `monitor`  | no        | yes          | Non-blocking status snapshot(s).                     |
//! | `list`     | no        | n/a          | List background jobs for the current session.        |
//!
//! ### `wait_mode` (wait_for only)
//!
//! - `any` (default) — return as soon as any handle terminates (or, for
//!   single-handle + pattern, as soon as the pattern matches).
//! - `all` — return only when every handle has terminated (or timeout).
//!
//! `pattern` is only supported with a single handle. Passing pattern with
//! multiple handles is rejected as `InvalidParams`.
//!
//! ## Output protocol
//!
//! Every successful `wait_for` / `monitor` response has three parts:
//! 1. Human-readable header block — one `[<handle>: <label>]` line per job.
//! 2. Machine-readable metadata line: `awaitMeta::{count, items: [...]}`.
//! 3. Tail block per handle, each introduced by `--- [<handle>] last N lines ---`.
//!
//! The shape is uniform — a single-handle call still emits `items: [one]` so
//! the frontend parses one code path.
//!
//! ## Module layout
//!
//! - [`snapshot`] — `HandleSnapshot` + status resolution
//! - [`response`] — response body / list table builders
//! - [`body`]     — read job output (shell log / subagent buffer) + tail / regex helpers
//! - [`params`]   — param parsing (handles / wait_mode / tail_lines) + lookup
//! - [`commands`] — `run_wait_for` / `run_monitor` / `run_list` (impl AwaitTool)
//!
//! `mod.rs` itself only owns the type and the `Tool` trait surface.

mod body;
mod commands;
mod params;
mod response;
mod snapshot;

use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

pub struct AwaitTool {
    pub(super) session_key: TokioMutex<Option<String>>,
    pub(super) cancel_flag: TokioMutex<Option<Arc<AtomicBool>>>,
}

impl Default for AwaitTool {
    fn default() -> Self {
        Self {
            session_key: TokioMutex::new(None),
            cancel_flag: TokioMutex::new(None),
        }
    }
}

impl AwaitTool {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl Tool for AwaitTool {
    fn name(&self) -> &str {
        tool_names::AWAIT_OUTPUT
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn search_hint(&self) -> &str {
        "await wait monitor background job process subagent handle poll output"
    }

    fn description(&self) -> &str {
        "Monitor background jobs (shell processes and subagents).\n\n\
        Subcommands (set via `command` param, default: \"monitor\"):\n\
        - `wait_for` — Block until job(s) terminate or a regex pattern matches. Accepts one or many handles.\n\
        - `monitor`  — Non-blocking snapshot for one or many handles (current status + last N lines each).\n\
        - `list`     — List all background jobs for this session.\n\n\
        `wait_for` with multiple handles supports `wait_mode: any` (return when the first one finishes, default) or \
        `wait_mode: all` (return when every handle finishes). `pattern` only works with a single handle.\n\n\
        Return format includes an awaitMeta:: JSON line:\n\
        - { count, items: [{ handle, jobKind, status, waitedMs, patternMatched, exitCode, killed }] }\n\n\
        Single-handle calls still emit items: [one] so the response shape is uniform. \
        The body includes one `--- [<handle>] last N lines ---` block per handle.\n\n\
        For `list`, returns a table of handles with kind, status, age, and label.\n\n\
        IMPORTANT: Do NOT call this tool repeatedly to poll a running subagent. \
        The system injects a background-jobs reminder into every turn automatically. \
        If a subagent is still running after wait_for returns, proceed with other tasks."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["wait_for", "monitor", "list"],
                    "description": "Subcommand to execute. Default: 'monitor'."
                },
                "handles": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Handles of the background jobs (PIDs for shells, session IDs for subagents). Required for wait_for/monitor. Pass a single-element array for one job."
                },
                "wait_mode": {
                    "type": "string",
                    "enum": ["any", "all"],
                    "description": "wait_for only. 'any' (default) returns when any handle terminates; 'all' waits for every handle."
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to wait for in output (wait_for only, single handle)."
                },
                "block_until_ms": {
                    "type": "integer",
                    "description": "Max milliseconds to block (wait_for only). Default: 30000."
                },
                "tail_lines": {
                    "type": "integer",
                    "description": "Number of output lines to return per handle. Default: 50."
                },
                "scope": {
                    "type": "string",
                    "enum": ["session", "global"],
                    "description": "Scope for 'list' command. Default: 'session' (current session only). 'global' lists all sessions."
                }
            }
        })
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.session_key.lock().await = Some(session_key.to_string());
    }

    async fn set_cancel_flag(&self, cancel_flag: Arc<AtomicBool>) {
        *self.cancel_flag.lock().await = Some(cancel_flag);
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        // `command` is optional — defaults to "monitor" (the safe, non-blocking
        // snapshot). But if the caller passed params that ONLY make sense on
        // `wait_for` (pattern / wait_mode — both strictly blocking-intent
        // signals), treat the missing `command` as a malformed call rather
        // than silently ignoring the blocking intent. `block_until_ms` is NOT
        // in this list because `block_until_ms: 0` is semantically equivalent
        // to a monitor snapshot and is widely used that way.
        //
        // Treat `null` and missing the same way — only a non-null present
        // value counts as "wait_for intent". Some LLMs serialize unset
        // optionals as explicit `null`.
        let command_raw = params.get("command").and_then(|v| v.as_str());
        let has_pattern = params.get("pattern").map(|v| !v.is_null()).unwrap_or(false);
        let has_wait_mode = params
            .get("wait_mode")
            .map(|v| !v.is_null())
            .unwrap_or(false);
        let has_wait_only_param = has_pattern || has_wait_mode;

        let command = match command_raw {
            Some(c) => c,
            None if has_wait_only_param => {
                return Err(ToolError::InvalidParams(
                    "`command` is required when `pattern` or `wait_mode` is set. \
                     These params only apply to `command=\"wait_for\"`; set \
                     command explicitly to block on output, or drop these params \
                     to take a non-blocking monitor snapshot."
                        .into(),
                ));
            }
            None => "monitor",
        };

        match command {
            "wait_for" => self.run_wait_for(&params).await,
            "monitor" => self.run_monitor(&params).await,
            "list" => self.run_list(&params).await,
            other => Err(ToolError::InvalidParams(format!(
                "Unknown await_output command: \"{}\". Valid commands: wait_for, monitor, list.",
                other
            ))),
        }
    }
}
