//! Terminal inspection and control tool.
//!
//! Provides Rust agents with bounded access to ORGII-managed PTY sessions.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use terminal::agent_tool::{close_session, write_to_session};
use terminal::pty_commands::pty::{PtyInfo, PtySession};

use crate::tools::names as tool_names;
use crate::tools::registration::PtySessions;
use crate::tools::traits::{params_schema, parse_params_described, Tool, ToolError};

const DEFAULT_READ_CHARS: usize = 20_000;
const MAX_READ_CHARS: usize = 80_000;

/// Flat params: tagged-enum schemas (top-level `oneOf`) get flattened to an
/// empty schema by LLM providers, so the model never sees the fields. Keep
/// this a plain object with scalar properties; per-action requiredness is
/// enforced in `execute_text` with self-correcting error messages.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InspectTerminalsParams {
    /// Operation to perform. One of: `list` (enumerate live terminal
    /// sessions), `read_output` (read a bounded snapshot of recent output),
    /// `write_input` (write raw input into a terminal), `close` (drop the
    /// PTY).
    pub action: String,
    /// Terminal session ID returned by `list`. Required for `read_output`,
    /// `write_input`, and `close`.
    #[serde(default)]
    pub session_id: Option<String>,
    /// `read_output` only: maximum number of trailing characters to return.
    /// Defaults to 20,000 and is capped at 80,000.
    #[serde(default)]
    pub max_chars: Option<usize>,
    /// `write_input` only: text or control characters to write to the PTY.
    /// Use `\r` to press Enter.
    #[serde(default)]
    pub input: Option<String>,
}

fn require_session_id(params: &InspectTerminalsParams, action: &str) -> Result<String, ToolError> {
    params.session_id.clone().ok_or_else(|| {
        ToolError::InvalidParams(format!(
            "`{action}` requires `session_id`; call `{{\"action\": \"list\"}}` first to get session IDs"
        ))
    })
}

#[derive(Debug, Serialize)]
struct TerminalOutputSnapshot {
    session_id: String,
    redacted: bool,
    truncated: bool,
    chars_returned: usize,
    output: String,
}

#[derive(Debug, Serialize)]
struct TerminalActionResult {
    session_id: String,
    status: &'static str,
}

pub struct InspectTerminalsTool {
    sessions: PtySessions,
}

impl InspectTerminalsTool {
    pub fn new(sessions: PtySessions) -> Self {
        Self { sessions }
    }

    fn info_from_session(session_id: &str, session: &PtySession) -> PtyInfo {
        PtyInfo {
            session_id: session_id.to_string(),
            pid: session.pid,
            shell: session.shell.clone(),
            shell_kind: session.shell_kind.clone(),
            cwd: session.cwd.clone(),
            name: session.name.clone(),
            created_at: session.created_at,
            last_output_at: *session
                .last_output_at
                .lock()
                .expect("last_output_at mutex poisoned"),
            has_output_tap: session.output_tap.is_some(),
            unacked_bytes: session
                .unacked_bytes
                .load(std::sync::atomic::Ordering::Relaxed),
            redacted_output_chars: session
                .redacted_output
                .lock()
                .expect("redacted_output mutex poisoned")
                .chars()
                .count(),
        }
    }

    fn trailing_chars(text: &str, max_chars: usize) -> (String, bool) {
        let char_count = text.chars().count();
        if char_count <= max_chars {
            return (text.to_string(), false);
        }
        (text.chars().skip(char_count - max_chars).collect(), true)
    }
}

#[async_trait]
impl Tool for InspectTerminalsTool {
    fn name(&self) -> &str {
        tool_names::INSPECT_TERMINALS
    }

    fn description(&self) -> &str {
        "Inspect and control live ORGII-managed terminal sessions: list sessions, read recent output, write input, or close a session."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        params_schema::<InspectTerminalsParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let params: InspectTerminalsParams = parse_params_described(params)?;

        match params.action.as_str() {
            "list" => {
                let sessions = self.sessions.lock().await;
                let mut terminal_infos = sessions
                    .iter()
                    .map(|(session_id, session)| Self::info_from_session(session_id, session))
                    .collect::<Vec<_>>();
                terminal_infos.sort_by(|left, right| left.session_id.cmp(&right.session_id));

                serde_json::to_string_pretty(&terminal_infos).map_err(|err| {
                    ToolError::ExecutionFailed(format!("Failed to serialize terminals: {err}"))
                })
            }
            "read_output" => {
                let session_id = require_session_id(&params, "read_output")?;
                let max_chars = params
                    .max_chars
                    .unwrap_or(DEFAULT_READ_CHARS)
                    .min(MAX_READ_CHARS);
                let sessions = self.sessions.lock().await;
                let session = sessions.get(&session_id).ok_or_else(|| {
                    ToolError::ExecutionFailed(format!("Terminal session not found: {session_id}"))
                })?;
                let redacted_output = session
                    .redacted_output
                    .lock()
                    .expect("redacted_output mutex poisoned")
                    .clone();
                drop(sessions);

                let (output, truncated) = Self::trailing_chars(&redacted_output, max_chars);
                let snapshot = TerminalOutputSnapshot {
                    session_id,
                    redacted: true,
                    truncated,
                    chars_returned: output.chars().count(),
                    output,
                };

                serde_json::to_string_pretty(&snapshot).map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "Failed to serialize terminal output: {err}"
                    ))
                })
            }
            "write_input" => {
                let session_id = require_session_id(&params, "write_input")?;
                let input = params.input.clone().ok_or_else(|| {
                    ToolError::InvalidParams(
                        "`write_input` requires `input` — the text to write to the PTY"
                            .to_string(),
                    )
                })?;
                write_to_session(&session_id, &input, self.sessions.clone())
                    .await
                    .map_err(ToolError::ExecutionFailed)?;
                serde_json::to_string_pretty(&TerminalActionResult {
                    session_id,
                    status: "input_written",
                })
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("Failed to serialize write result: {err}"))
                })
            }
            "close" => {
                let session_id = require_session_id(&params, "close")?;
                close_session(&session_id, self.sessions.clone())
                    .await
                    .map_err(ToolError::ExecutionFailed)?;
                serde_json::to_string_pretty(&TerminalActionResult {
                    session_id,
                    status: "closed",
                })
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("Failed to serialize close result: {err}"))
                })
            }
            other => Err(ToolError::InvalidParams(format!(
                "unknown action \"{other}\"; valid actions: `list`, `read_output`, `write_input`, `close`"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_chars_reports_truncation() {
        let (output, truncated) = InspectTerminalsTool::trailing_chars("abcdef", 3);
        assert_eq!(output, "def");
        assert!(truncated);
    }

    #[test]
    fn trailing_chars_keeps_short_output() {
        let (output, truncated) = InspectTerminalsTool::trailing_chars("abc", 3);
        assert_eq!(output, "abc");
        assert!(!truncated);
    }
}
