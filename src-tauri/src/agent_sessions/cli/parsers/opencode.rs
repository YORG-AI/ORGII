//! OpenCode CLI ACP (Agent Client Protocol) integration.
//!
//! Thin wrapper over `acp_common` with OpenCode-specific tool mapping.
//! OpenCode's `opencode acp` command speaks standard ACP over stdin/stdout.

use serde_json::Value;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::acp_common::{self, AcpAgentAdapter, AcpSessionResult};
use core_types::activity::ActivityChunk;

fn extract_task_result(content: &str) -> Option<String> {
    let start = content.find("<task_result>")? + "<task_result>".len();
    let tail = &content[start..];
    let end = tail.find("</task_result>").unwrap_or(tail.len());
    let result = tail[..end].trim();
    if result.is_empty() {
        None
    } else {
        Some(result.to_string())
    }
}

/// OpenCode adapter — maps OpenCode tool names to Cursor-normalized names.
pub(crate) struct OpenCodeAdapter;

impl AcpAgentAdapter for OpenCodeAdapter {
    fn map_tool_kind(&self, kind: &str, raw_input: &Value) -> String {
        let name = raw_input
            .get("name")
            .or(raw_input.get("tool"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match name {
            "write" | "Write" => return "Edit".to_string(),
            "read" | "Read" => return "Read".to_string(),
            "bash" | "Bash" | "execute" => return "Shell".to_string(),
            "grep" | "Grep" => return "Grep".to_string(),
            "glob" | "Glob" => return "Glob".to_string(),
            "fetch" | "Fetch" | "WebFetch" => return "WebFetch".to_string(),
            "TodoWrite" => return "UpdateTodos".to_string(),
            _ => {}
        }

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
    fn map_tool_result_chunk(
        &self,
        session_id: &str,
        cursor_name: &str,
        result_text: &str,
        is_error: bool,
    ) -> Option<ActivityChunk> {
        if is_error || cursor_name != "think" {
            return None;
        }

        let task_result = extract_task_result(result_text)?;
        let mut chunk = ActivityChunk::new(session_id, "assistant", "message");
        chunk.result = serde_json::json!({
            "content": task_result,
            "observation": task_result,
            "role": "assistant",
        });
        Some(chunk)
    }

    fn should_emit_tool_start(&self, cursor_name: &str) -> bool {
        cursor_name != "think"
    }

    fn should_emit_tool_result(
        &self,
        cursor_name: &str,
        result_text: &str,
        is_error: bool,
    ) -> bool {
        is_error || cursor_name != "think" || !result_text.trim().is_empty()
    }
}

/// Run the ACP protocol with OpenCode CLI.
#[allow(clippy::too_many_arguments)]
pub async fn run_acp_protocol(
    stdin: ChildStdin,
    stdout: ChildStdout,
    session_id: &str,
    task: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    chunk_tx: mpsc::Sender<ActivityChunk>,
    image_paths: Vec<String>,
) -> Result<AcpSessionResult, String> {
    acp_common::run_acp_protocol(
        OpenCodeAdapter,
        stdin,
        stdout,
        session_id,
        task,
        working_dir,
        resume_session_id,
        chunk_tx,
        image_paths,
    )
    .await
}

#[cfg(test)]
#[path = "tests/opencode_tests.rs"]
mod tests;
