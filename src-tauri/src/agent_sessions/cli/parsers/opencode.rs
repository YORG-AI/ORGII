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

fn quoted_attr(head: &str, attr: &str) -> Option<String> {
    let idx = head.find(attr)?;
    let rest = &head[idx + attr.len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let quoted = &rest[quote.len_utf8()..];
    let close = quoted.find(quote)?;
    let value = quoted[..close].trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn is_generic_task_label(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "task" | "todo")
}

fn is_paste_placeholder(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.contains("paste://") || value.contains("[paste:") || value.starts_with("pasted.txt")
}

fn is_result_like_report(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("now i have all the data")
        || value.starts_with("here is the comprehensive report")
        || value.starts_with("# comprehensive `")
        || value.starts_with("# comprehensive .rs")
}

fn strip_known_prompt_prelude(value: &str) -> &str {
    let mut rest = value.trim();
    loop {
        let tag = if rest.starts_with("<skills>") {
            "skills"
        } else if rest.starts_with("<orgii_cli_exec_mode_bridge>") {
            "orgii_cli_exec_mode_bridge"
        } else {
            break;
        };
        let close_tag = format!("</{tag}>");
        let Some(close_idx) = rest.find(&close_tag) else {
            break;
        };
        rest = rest[close_idx + close_tag.len()..].trim_start();
    }
    rest.trim()
}

fn non_generic_string(value: &str) -> Option<String> {
    let value = strip_known_prompt_prelude(value);
    (!value.is_empty()
        && !is_generic_task_label(value)
        && !is_paste_placeholder(value)
        && !is_result_like_report(value))
    .then(|| value.to_string())
}

fn first_raw_input_string(raw_input: Option<&Value>, keys: &[&str]) -> Option<String> {
    let raw_input = raw_input?;
    for key in keys {
        if let Some(value) = raw_input.get(*key).and_then(|v| v.as_str()) {
            if let Some(value) = non_generic_string(value) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_task_prompt(
    detailed: &str,
    result_text: &str,
    raw_input: Option<&Value>,
    title: Option<&str>,
) -> Option<String> {
    if let Some(prompt) = first_raw_input_string(
        raw_input,
        &[
            "prompt",
            "description",
            "task",
            "instructions",
            "instruction",
        ],
    ) {
        return Some(prompt);
    }

    if let Some(title) = title.and_then(non_generic_string) {
        return Some(title);
    }

    for source in [detailed, result_text] {
        if source.is_empty() {
            continue;
        }
        let Some(start) = source.find("<task") else {
            continue;
        };
        let body = &source[start..];
        let Some(end) = body.find('>') else {
            continue;
        };
        let head = &body[..=end];
        if let Some(prompt) =
            quoted_attr(head, "prompt=").and_then(|prompt| non_generic_string(&prompt))
        {
            return Some(prompt);
        }
        let after_head = &body[end + 1..];
        let prompt_end = after_head
            .find("<task_result>")
            .or_else(|| after_head.find("</task>"))
            .unwrap_or(after_head.len());
        let prompt = after_head[..prompt_end].trim();
        if let Some(prompt) = non_generic_string(prompt) {
            return Some(prompt);
        }
    }
    None
}

fn opencode_app_session_id(raw: &str) -> String {
    if raw.starts_with("opencodeapp-") {
        raw.to_string()
    } else {
        format!("opencodeapp-{raw}")
    }
}

fn extract_task_session_id(content: &str) -> Option<String> {
    let start = content.find("<task")?;
    let body = &content[start..];
    let end = body.find('>')?;
    let head = &body[..=end];
    for attr in ["id=", "session_id=", "sessionId="] {
        if let Some(value) = quoted_attr(head, attr) {
            return Some(opencode_app_session_id(&value));
        }
    }
    None
}

fn is_completed_task_result(content: &str) -> bool {
    content.contains("<task_result>")
        && (content.contains("state=\"completed\"")
            || content.contains("state='completed'")
            || !content.contains("state=\""))
}

/// OpenCode adapter — maps OpenCode tool names to Cursor-normalized names.
pub(crate) struct OpenCodeAdapter;

impl AcpAgentAdapter for OpenCodeAdapter {
    fn map_tool_kind(&self, kind: &str, _title: &str, raw_input: &Value) -> String {
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
        detailed_text: &str,
        raw_input: Option<&Value>,
        title: Option<&str>,
        _parent_task: Option<&str>,
        is_error: bool,
    ) -> Option<ActivityChunk> {
        if is_error || cursor_name != "think" {
            return None;
        }

        if !is_completed_task_result(result_text) {
            return None;
        }

        let task_result = extract_task_result(result_text)?;
        let prompt = extract_task_prompt(detailed_text, result_text, raw_input, title);
        let description = prompt
            .as_deref()
            .unwrap_or("Assigned task to subagent")
            .to_string();
        let subagent_session_id =
            extract_task_session_id(result_text).or_else(|| extract_task_session_id(detailed_text));

        let mut chunk = ActivityChunk::new(session_id, "tool_call", "subagent");
        chunk.args = serde_json::json!({
            "action": "delegate",
            "description": description,
            "subagent_type": "opencode",
            "subagentSessionId": subagent_session_id,
            "prompt": prompt,
        });
        chunk.result = serde_json::json!({
            "success": true,
            "status": "completed",
            "content": task_result,
            "output": task_result,
            "subagentSessionId": subagent_session_id,
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
