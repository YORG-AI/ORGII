//! DeepSeek Harness (`dsh`) ACP (Agent Client Protocol) integration.
//!
//! Thin wrapper over `acp_common` with DeepSeek-specific tool-name mapping.
//!
//! `dsh --profile acp` speaks a standard ACP v1 surface, but its
//! `tool_call` updates are deliberately *generic*: every call arrives as
//! `kind: "other"` with the real DSH tool name in `title` and the model's
//! arguments in `rawInput` (see `@deepseek-ai/dsh-acp`'s `toolCallUpdate`).
//! Without a title-aware mapping every DSH tool would collapse into the
//! default `other` → `Task` bucket and lose its command / path / diff
//! rendering.

use serde_json::Value;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::acp_common::{self, AcpAgentAdapter, AcpSessionResult};
use core_types::activity::ActivityChunk;

/// Map one DSH tool name onto the Cursor-normalized vocabulary the ACP
/// parser uses to shape args and results.
///
/// Only the tools whose arguments the parser actually reshapes are
/// translated. Every other DSH tool (`skill`, `subagent`, `ralph`,
/// `job_list`, …) keeps its own name: the shared CLI alias map already
/// routes those to a UI component, and renaming them to `Task` would
/// erase which tool actually ran.
fn cursor_name_for_dsh_tool(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "bash" | "pwsh" => "Shell",
        "read" | "read_image" => "Read",
        "write" | "edit" | "str_replace_editor" => "Edit",
        "grep" => "Grep",
        "glob" => "Glob",
        "todo_write" => "UpdateTodos",
        "web_fetch" => "WebFetch",
        "web_search" => "WebSearch",
        _ => return None,
    })
}

/// DeepSeek Harness adapter — resolves the tool name from the ACP `title`.
struct DeepseekHarnessAdapter;

impl AcpAgentAdapter for DeepseekHarnessAdapter {
    fn map_tool_kind(&self, kind: &str, title: &str, _raw_input: &Value) -> String {
        if let Some(mapped) = cursor_name_for_dsh_tool(title) {
            return mapped.to_string();
        }
        if !title.is_empty() {
            return title.to_string();
        }

        // No title at all: fall back to the standard ACP kind mapping.
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
}

/// Run the ACP protocol with `dsh --profile acp`.
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
        DeepseekHarnessAdapter,
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
mod tests {
    use super::*;

    fn map(title: &str) -> String {
        DeepseekHarnessAdapter.map_tool_kind("other", title, &Value::Null)
    }

    #[test]
    fn generic_other_kind_is_resolved_from_the_dsh_tool_title() {
        // Every dsh-acp tool_call arrives as kind="other"; without the title
        // these would all render as a bare Task card.
        assert_eq!(map("bash"), "Shell");
        assert_eq!(map("read"), "Read");
        assert_eq!(map("write"), "Edit");
        assert_eq!(map("edit"), "Edit");
        assert_eq!(map("str_replace_editor"), "Edit");
        assert_eq!(map("grep"), "Grep");
        assert_eq!(map("glob"), "Glob");
        assert_eq!(map("todo_write"), "UpdateTodos");
        assert_eq!(map("web_fetch"), "WebFetch");
        assert_eq!(map("web_search"), "WebSearch");
    }

    #[test]
    fn unmapped_dsh_tools_keep_their_own_name() {
        // The shared CLI alias map routes these; collapsing them to "Task"
        // would hide which tool ran.
        assert_eq!(map("skill"), "skill");
        assert_eq!(map("subagent"), "subagent");
        assert_eq!(map("job_list"), "job_list");
    }

    /// Replays the exact frame shape `@deepseek-ai/dsh-acp` emits — generic
    /// `kind: "other"`, DSH tool name in `title`, arguments in `rawInput` —
    /// through the shared notification parser.
    #[test]
    fn dsh_bash_tool_call_reaches_the_ui_as_a_shell_chunk() {
        let mut parser = super::acp_common::AcpNotificationParser::new_with_task(
            DeepseekHarnessAdapter,
            "s1",
            "t",
        );

        let start = parser.parse_update(&serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "bash",
            "kind": "other",
            "status": "in_progress",
            "rawInput": { "command": "echo probe-ok" },
        }));
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].function, "Shell");
        assert_eq!(start[0].args["command"], "echo probe-ok");

        let done = parser.parse_update(&serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "completed",
            "content": [
                { "type": "content", "content": { "type": "text", "text": "probe-ok\n" } }
            ],
        }));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].function, "Shell");
        assert_eq!(done[0].result["success"]["stdout"], "probe-ok\n");
    }

    /// `str_replace_editor` uses `old_str`/`new_str`, which the shared parser
    /// did not recognize before DSH was routed through ACP.
    #[test]
    fn dsh_str_replace_editor_call_carries_the_edit_strings() {
        let mut parser = super::acp_common::AcpNotificationParser::new_with_task(
            DeepseekHarnessAdapter,
            "s1",
            "t",
        );

        let start = parser.parse_update(&serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_2",
            "title": "str_replace_editor",
            "kind": "other",
            "status": "in_progress",
            "rawInput": {
                "path": "/repo/main.rs",
                "old_str": "let a = 1;",
                "new_str": "let a = 2;",
            },
        }));
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].function, "Edit");
        assert_eq!(start[0].args["path"], "/repo/main.rs");
        assert_eq!(start[0].args["old_string"], "let a = 1;");
        assert_eq!(start[0].args["new_string"], "let a = 2;");
    }

    #[test]
    fn missing_title_falls_back_to_the_standard_acp_kind() {
        let adapter = DeepseekHarnessAdapter;
        assert_eq!(adapter.map_tool_kind("execute", "", &Value::Null), "Shell");
        assert_eq!(adapter.map_tool_kind("other", "", &Value::Null), "Task");
    }
}
