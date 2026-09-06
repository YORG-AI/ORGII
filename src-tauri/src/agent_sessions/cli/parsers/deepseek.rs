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

/// The `configId` DSH publishes for its provider/model route.
const MODEL_CONFIG_ID: &str = "model";

/// Walk the two-level `options` tree the agent published for one config
/// option, calling `visit` with every leaf `value` string.
fn for_each_option_value(option: &Value, mut visit: impl FnMut(&str)) {
    let Some(entries) = option.get("options").and_then(|v| v.as_array()) else {
        return;
    };
    for entry in entries {
        if let Some(value) = entry.get("value").and_then(|v| v.as_str()) {
            visit(value);
        }
        // Grouped entries (`{group, name, options: [...]}`) nest one level.
        if let Some(nested) = entry.get("options").and_then(|v| v.as_array()) {
            for leaf in nested {
                if let Some(value) = leaf.get("value").and_then(|v| v.as_str()) {
                    visit(value);
                }
            }
        }
    }
}

/// Find the advertised `model` value that names `requested`.
///
/// DSH encodes each choice as a JSON `["<provider>","<model>"]` pair, so the
/// requested id is matched against the encoded pair itself, the bare model
/// segment, and the `provider/model` shorthand. Returns `None` when the
/// harness does not offer the model — sending an unadvertised value earns a
/// `-32602 unknown model option` and no session config at all.
fn select_model_value(advertised: &Value, requested: &str) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    let option = advertised
        .as_array()?
        .iter()
        .find(|o| o.get("id").and_then(|v| v.as_str()) == Some(MODEL_CONFIG_ID))?;

    let mut matched: Option<String> = None;
    for_each_option_value(option, |value| {
        if matched.is_some() {
            return;
        }
        if value == requested {
            matched = Some(value.to_string());
            return;
        }
        let Ok(Value::Array(pair)) = serde_json::from_str::<Value>(value) else {
            return;
        };
        let provider = pair.first().and_then(|v| v.as_str()).unwrap_or_default();
        let model = pair.get(1).and_then(|v| v.as_str()).unwrap_or_default();
        if model.eq_ignore_ascii_case(requested)
            || format!("{}/{}", provider, model).eq_ignore_ascii_case(requested)
        {
            matched = Some(value.to_string());
        }
    });
    matched
}

/// DeepSeek Harness adapter — resolves the tool name from the ACP `title`.
struct DeepseekHarnessAdapter {
    /// The model ORGII selected for this session, if any.
    requested_model: Option<String>,
}

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

    fn session_config_updates(&self, advertised: &Value) -> Vec<(String, Value)> {
        let Some(requested) = self.requested_model.as_deref() else {
            return vec![];
        };
        match select_model_value(advertised, requested) {
            Some(value) => vec![(MODEL_CONFIG_ID.to_string(), Value::String(value))],
            None => {
                tracing::warn!(
                    "[ACP] DeepSeek Harness does not offer model {} — keeping its default route",
                    requested
                );
                vec![]
            }
        }
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
    model: Option<String>,
) -> Result<AcpSessionResult, String> {
    acp_common::run_acp_protocol(
        DeepseekHarnessAdapter {
            requested_model: model,
        },
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

    fn adapter() -> DeepseekHarnessAdapter {
        DeepseekHarnessAdapter {
            requested_model: None,
        }
    }

    fn map(title: &str) -> String {
        adapter().map_tool_kind("other", title, &Value::Null)
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
        let mut parser =
            super::acp_common::AcpNotificationParser::new_with_task(adapter(), "s1", "t");

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
        let mut parser =
            super::acp_common::AcpNotificationParser::new_with_task(adapter(), "s1", "t");

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

    /// The exact `configOptions` shape `dsh --profile acp` returns from
    /// `session/new`, captured from `@deepseek-ai/dsh@0.1.2-rc.1`.
    fn advertised() -> Value {
        serde_json::json!([
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
                "options": [{
                    "group": "deepseek-official",
                    "name": "DeepSeek",
                    "options": [
                        { "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]", "name": "DeepSeek-V4-Flash" },
                        { "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]", "name": "DeepSeek-V4-Pro" },
                        { "value": "[\"deepseek-official\",\"deepseek-v4-flash-vision-exp\"]", "name": "DeepSeek-V4-Flash-Vision-Exp" }
                    ]
                }]
            },
            {
                "id": "reasoning_effort",
                "name": "Reasoning effort",
                "category": "thought_level",
                "type": "select",
                "currentValue": "high",
                "options": [
                    { "value": "off", "name": "Off" },
                    { "value": "low", "name": "Low" },
                    { "value": "high", "name": "High" },
                    { "value": "max", "name": "Max" }
                ]
            }
        ])
    }

    #[test]
    fn model_is_matched_against_the_advertised_provider_pairs() {
        let expected = "[\"deepseek-official\",\"deepseek-v4-pro\"]";
        // Bare model id — what the model palette stores.
        assert_eq!(
            select_model_value(&advertised(), "deepseek-v4-pro").as_deref(),
            Some(expected)
        );
        // `provider/model` shorthand.
        assert_eq!(
            select_model_value(&advertised(), "deepseek-official/deepseek-v4-pro").as_deref(),
            Some(expected)
        );
        // The encoded pair itself.
        assert_eq!(
            select_model_value(&advertised(), expected).as_deref(),
            Some(expected)
        );
    }

    #[test]
    fn an_unadvertised_model_selects_nothing() {
        // dsh answers an unknown value with `-32602 unknown model option`, so
        // a miss must stay off the wire.
        assert_eq!(select_model_value(&advertised(), "gpt-5.6-sol"), None);
        assert_eq!(select_model_value(&advertised(), ""), None);
        assert_eq!(select_model_value(&Value::Null, "deepseek-v4-pro"), None);
    }

    #[test]
    fn session_config_carries_only_a_model_the_harness_offers() {
        let selected = DeepseekHarnessAdapter {
            requested_model: Some("deepseek-v4-pro".to_string()),
        };
        assert_eq!(
            selected.session_config_updates(&advertised()),
            vec![(
                "model".to_string(),
                Value::String("[\"deepseek-official\",\"deepseek-v4-pro\"]".to_string())
            )]
        );

        let unknown = DeepseekHarnessAdapter {
            requested_model: Some("deepseek-v9-imaginary".to_string()),
        };
        assert!(unknown.session_config_updates(&advertised()).is_empty());

        // No model selected: the harness keeps its own default route.
        assert!(adapter().session_config_updates(&advertised()).is_empty());
    }

    #[test]
    fn missing_title_falls_back_to_the_standard_acp_kind() {
        let adapter = adapter();
        assert_eq!(adapter.map_tool_kind("execute", "", &Value::Null), "Shell");
        assert_eq!(adapter.map_tool_kind("other", "", &Value::Null), "Task");
    }
}
