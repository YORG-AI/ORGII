#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use serde_json::Value;
use tokio::time::{sleep, Duration};

use super::traits::{
    finish_reason, usage_key, LLMProvider, LLMResponse, ProviderError, StreamDelta, ToolCallRequest,
};

const ADDRESS_COMMENTS_MARKER: &str =
    "Teammates left review comments on this session. Address every comment below";
const ADDRESS_COMMENT_ID_MARKER: &str = " — id: ";
const REPLY_SESSION_COMMENT_TOOL: &str = "reply_session_comment";
const AGENT_ORG_TASK_FSM_MARKER: &str = "E2E_AGENT_ORG_TASK_FSM:";
const CONTROL_WAIT_MARKER: &str = "Create a stoppable window by waiting for about ";
const TASK_GRAPH_CREATE_TOOL: &str = "task_graph_create";
const TASK_UPDATE_TOOL: &str = "task_update";

fn task_update_arguments_with_empty_placeholders(arguments: Value) -> Value {
    let Value::Object(mut arguments) = arguments else {
        return arguments;
    };
    let Value::Object(placeholders) = serde_json::json!({
        "subject": null,
        "description": "",
        "active_form": " \t",
        "clear_active_form": false,
        "owner_member_id": "",
        "clear_owner": false,
        "execution_mode": "",
        "blocked_by": [],
        "metadata": {},
        "eligible_member_ids": [],
        "required_role": "\n",
        "body": "",
        "output": {"summary": "", "content": "", "artifact_ids": []},
        "reason": {"code": "", "message": ""},
        "replacement": {
            "id": "",
            "subject": "",
            "description": null,
            "active_form": "",
            "owner_member_id": "",
            "execution_mode": "",
            "blocked_by": [],
            "metadata": {},
            "eligible_member_ids": [],
            "required_role": ""
        }
    }) else {
        unreachable!("task_update placeholder fixture must be an object");
    };
    for (key, value) in placeholders {
        arguments.entry(key).or_insert(value);
    }
    Value::Object(arguments)
}

pub const E2E_FAKE_PROVIDER_MODEL_PREFIX: &str = "e2e-fake-provider";

pub fn is_e2e_fake_provider_model(model: &str) -> bool {
    model.starts_with(E2E_FAKE_PROVIDER_MODEL_PREFIX)
}

#[derive(Debug, Default)]
pub struct E2eFakeProvider;

impl E2eFakeProvider {
    fn response_for(messages: &[Value]) -> String {
        let system_text = messages
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let latest_user = latest_model_user(messages).unwrap_or_default();

        if system_text.contains("You are a context compactor")
            || latest_user.contains("You are a context compactor")
            || (latest_user.contains("<current_session_memory>")
                && latest_user.contains("<new_messages>"))
        {
            return "E2E_FAKE_COMPACT_SUMMARY: older history was compacted without carrying old full markers forward.".to_string();
        }

        format!("E2E_FAKE_PROVIDER_REPLY: {latest_user}")
    }

    fn address_comment_ids(messages: &[Value]) -> Vec<String> {
        let Some(latest_user_index) = messages
            .iter()
            .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        else {
            return Vec::new();
        };
        if messages[latest_user_index + 1..]
            .iter()
            .any(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        {
            return Vec::new();
        }
        let Some(text) = messages[latest_user_index]
            .get("content")
            .and_then(content_text)
        else {
            return Vec::new();
        };
        if !text.contains(ADDRESS_COMMENTS_MARKER) {
            return Vec::new();
        }

        let mut ids = Vec::new();
        for line in text.lines() {
            let Some((_, id)) = line.split_once(ADDRESS_COMMENT_ID_MARKER) else {
                continue;
            };
            let id = id.trim();
            if !id.is_empty() && !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }
        ids
    }

    fn has_tool(tools: Option<&[Value]>, name: &str) -> bool {
        tools.is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some(name)
                    || tool
                        .get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                        == Some(name)
            })
        })
    }

    fn address_comment_tool_calls(
        messages: &[Value],
        tools: Option<&[Value]>,
    ) -> Vec<ToolCallRequest> {
        if !Self::has_tool(tools, REPLY_SESSION_COMMENT_TOOL) {
            return Vec::new();
        }
        Self::address_comment_ids(messages)
            .into_iter()
            .enumerate()
            .map(|(index, comment_id)| ToolCallRequest {
                id: format!("e2e-reply-session-comment-{index}"),
                name: REPLY_SESSION_COMMENT_TOOL.to_string(),
                arguments: serde_json::json!({
                    "commentId": comment_id,
                    "body": format!("E2E addressed comment {comment_id}"),
                }),
                thought_signature: None,
            })
            .collect()
    }

    fn agent_org_task_fsm_tool_calls(
        messages: &[Value],
        tools: Option<&[Value]>,
    ) -> Vec<ToolCallRequest> {
        let Some((latest_user_index, latest_user)) = latest_task_fsm_user(messages) else {
            return Vec::new();
        };
        let Some(scenario_id) = task_fsm_scenario_id(latest_user.as_str()) else {
            return Vec::new();
        };
        let tool_results = messages[latest_user_index + 1..]
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .collect::<Vec<_>>();

        if is_task_assignment(latest_user.as_str()) {
            if !Self::has_tool(tools, TASK_UPDATE_TOOL) {
                return Vec::new();
            }
            let Some(task_id) = task_assignment_value(&latest_user, "Task ID:", "task_id") else {
                return Vec::new();
            };
            let subject = task_assignment_value(&latest_user, "Task assigned by", "subject")
                .unwrap_or_default();
            let stage = tool_results.len();
            let arguments = if stage == 0 {
                serde_json::json!({ "operation": "start", "id": task_id })
            } else if subject.contains("E2E_TASK_FSM_HISTORY:") && stage == 1 {
                serde_json::json!({
                    "operation": "complete",
                    "id": task_id,
                    "output": {
                        "summary": format!("E2E paged history result for {scenario_id}"),
                    },
                })
            } else if subject.contains("E2E_TASK_FSM_COMPLETE:") && stage == 1 {
                serde_json::json!({
                    "operation": "append_evidence",
                    "id": task_id,
                    "body": format!("E2E production-path evidence for {scenario_id}"),
                })
            } else if subject.contains("E2E_TASK_FSM_COMPLETE:") && stage == 2 {
                serde_json::json!({
                    "operation": "complete",
                    "id": task_id,
                    "output": {
                        "summary": format!("E2E completed {scenario_id}"),
                        "content": "Completed through Provider -> Tool dispatcher -> Task Store.",
                        "artifact_ids": [format!("e2e-artifact-{scenario_id}")],
                    },
                })
            } else if subject.contains("E2E_TASK_FSM_FAIL:") && stage == 1 {
                serde_json::json!({
                    "operation": "append_progress",
                    "id": task_id,
                    "body": format!("E2E progress before failure for {scenario_id}"),
                })
            } else if subject.contains("E2E_TASK_FSM_FAIL:") && stage == 2 {
                serde_json::json!({
                    "operation": "fail",
                    "id": task_id,
                    "reason": {
                        "code": "e2e.expected_failure",
                        "message": format!("Deterministic E2E failure for {scenario_id}"),
                    },
                })
            } else if subject.contains("E2E_TASK_FSM_LATE:") && stage == 1 {
                // The coordinator cancels and replaces this Task while this
                // owner callback is delayed. The Store must reject the late
                // completion against the original persisted Turn binding.
                serde_json::json!({
                    "operation": "complete",
                    "id": task_id,
                    "output": { "summary": format!("Late output for {scenario_id}") },
                })
            } else {
                return Vec::new();
            };
            return vec![ToolCallRequest {
                id: format!("e2e-task-fsm-owner-{scenario_id}-{task_id}-{stage}"),
                name: TASK_UPDATE_TOOL.to_string(),
                arguments: task_update_arguments_with_empty_placeholders(arguments),
                thought_signature: None,
            }];
        }

        if !Self::has_tool(tools, TASK_GRAPH_CREATE_TOOL)
            || !Self::has_tool(tools, TASK_UPDATE_TOOL)
        {
            return Vec::new();
        }
        match tool_results.len() {
            0 => {
                let mut tasks = vec![
                    serde_json::json!({
                        "key": "pending",
                        "subject": format!("E2E_TASK_FSM_PENDING:{scenario_id}"),
                        "description": format!("{AGENT_ORG_TASK_FSM_MARKER}{scenario_id}"),
                        "execution_mode": "build",
                        "eligible_member_ids": ["sde-implementer"]
                    }),
                    serde_json::json!({
                        "key": "complete",
                        "subject": format!("E2E_TASK_FSM_COMPLETE:{scenario_id}"),
                        "description": format!("{AGENT_ORG_TASK_FSM_MARKER}{scenario_id}"),
                        "owner_member_id": "sde-reviewer",
                        "execution_mode": "build"
                    }),
                    serde_json::json!({
                        "key": "fail",
                        "subject": format!("E2E_TASK_FSM_FAIL:{scenario_id}"),
                        "description": format!("{AGENT_ORG_TASK_FSM_MARKER}{scenario_id}"),
                        "owner_member_id": "sde-tester",
                        "execution_mode": "build"
                    }),
                    serde_json::json!({
                        "key": "late",
                        "subject": format!("E2E_TASK_FSM_LATE:{scenario_id}"),
                        "description": format!("{AGENT_ORG_TASK_FSM_MARKER}{scenario_id}"),
                        "owner_member_id": "sde-planner",
                        "execution_mode": "build"
                    }),
                ];
                if scenario_id.starts_with("page") {
                    let owners = [
                        "sde-implementer",
                        "sde-reviewer",
                        "sde-tester",
                        "sde-planner",
                    ];
                    tasks.extend((0..20).map(|index| {
                        serde_json::json!({
                            "key": format!("history-{index:02}"),
                            "subject": format!("E2E_TASK_FSM_HISTORY:{scenario_id}:{index:02}"),
                            "description": format!("{AGENT_ORG_TASK_FSM_MARKER}{scenario_id}"),
                            "owner_member_id": owners[index % owners.len()],
                            "execution_mode": "build"
                        })
                    }));
                }
                vec![ToolCallRequest {
                    id: format!("e2e-task-fsm-graph-{scenario_id}"),
                    name: TASK_GRAPH_CREATE_TOOL.to_string(),
                    arguments: serde_json::json!({
                        "allow_parallel_with_existing_open_tasks": true,
                        "tasks": tasks,
                    }),
                    thought_signature: None,
                }]
            }
            1 => {
                let Some(late_task_id) = tool_results
                    .iter()
                    .filter_map(|message| message.get("content"))
                    .filter_map(tool_result_json)
                    .find_map(|result| {
                        result
                            .get("task_id_by_key")
                            .and_then(|value| value.get("late"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                else {
                    return Vec::new();
                };
                vec![ToolCallRequest {
                    id: format!("e2e-task-fsm-replace-{scenario_id}"),
                    name: TASK_UPDATE_TOOL.to_string(),
                    arguments: task_update_arguments_with_empty_placeholders(serde_json::json!({
                        "operation": "cancel_and_replace",
                        "id": late_task_id,
                        "reason": {
                            "code": "e2e.replaced",
                            "message": format!("Deterministic E2E replacement for {scenario_id}")
                        },
                        "replacement": {
                            "subject": format!("E2E_TASK_FSM_REPLACEMENT:{scenario_id}"),
                            "description": "Ownerless replacement remains in Current Work.",
                            "execution_mode": "build",
                            "eligible_member_ids": ["sde-planner"]
                        }
                    })),
                    thought_signature: None,
                }]
            }
            _ => Vec::new(),
        }
    }

    async fn delay_task_fsm_race_stage(messages: &[Value]) {
        let Some((latest_user_index, latest_user)) = latest_task_fsm_user(messages) else {
            return;
        };
        let stage = messages[latest_user_index + 1..]
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .count();
        let task_assignment = is_task_assignment(latest_user.as_str());
        let delay_ms =
            if task_assignment && latest_user.contains("E2E_TASK_FSM_LATE:") && stage == 1 {
                4_000
            } else if task_assignment
                && (latest_user.contains("E2E_TASK_FSM_COMPLETE:")
                    || latest_user.contains("E2E_TASK_FSM_FAIL:"))
                && stage == 2
            {
                3_000
            } else if !task_assignment && stage == 1 {
                1_500
            } else {
                0
            };
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
    }
}

fn latest_model_user(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|message| message.get("content").and_then(content_text))
        .find(|content| !content.trim_start().starts_with("<system-reminder>"))
}

fn control_wait_duration(messages: &[Value]) -> Option<Duration> {
    let latest_user = latest_model_user(messages)?;
    let wait_seconds = latest_user
        .split_once(CONTROL_WAIT_MARKER)?
        .1
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_secs(wait_seconds.clamp(1, 60)))
}

fn latest_task_fsm_user(messages: &[Value]) -> Option<(usize, String)> {
    messages
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, message)| message.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|(index, message)| {
            message
                .get("content")
                .and_then(content_text)
                .map(|content| (index, content))
        })
        .find(|(_, content)| {
            content.contains(AGENT_ORG_TASK_FSM_MARKER)
                && !content.trim_start().starts_with("<system-reminder>")
        })
}

fn task_fsm_scenario_id(text: &str) -> Option<String> {
    let suffix = text.split(AGENT_ORG_TASK_FSM_MARKER).nth(1)?;
    let id = suffix
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(48)
        .collect::<String>();
    (!id.is_empty()).then_some(id)
}

fn line_value<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::trim))
        .filter(|value| !value.is_empty())
}

fn is_task_assignment(text: &str) -> bool {
    text.contains("Task assigned by") || text.contains("<task_assigned ")
}

fn task_assignment_value(text: &str, line_prefix: &str, attribute: &str) -> Option<String> {
    line_value(text, line_prefix)
        .map(str::to_string)
        .or_else(|| xml_attribute_value(text, "task_assigned", attribute))
}

fn xml_attribute_value(text: &str, element: &str, attribute: &str) -> Option<String> {
    let element_start = text.find(&format!("<{element} "))?;
    let element_tail = &text[element_start..];
    let tag_end = element_tail.find('>')?;
    let opening_tag = &element_tail[..tag_end];
    let attribute_prefix = format!("{attribute}=\"");
    let value_start = opening_tag.find(&attribute_prefix)? + attribute_prefix.len();
    let value_tail = &opening_tag[value_start..];
    let value_end = value_tail.find('"')?;
    let value = &value_tail[..value_end];
    (!value.is_empty()).then(|| value.to_string())
}

fn tool_result_json(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => serde_json::from_str(text).ok(),
        Value::Object(_) => Some(value.clone()),
        _ => None,
    }
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

#[async_trait]
impl LLMProvider for E2eFakeProvider {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        if let Some(duration) = control_wait_duration(messages) {
            sleep(duration).await;
        }
        Self::delay_task_fsm_race_stage(messages).await;
        let mut tool_calls = Self::address_comment_tool_calls(messages, tools);
        if tool_calls.is_empty() {
            tool_calls = Self::agent_org_task_fsm_tool_calls(messages, tools);
        }
        let content = if tool_calls.is_empty() {
            Some(Self::response_for(messages))
        } else {
            None
        };
        let prompt_tokens = messages
            .iter()
            .map(|message| message.to_string().len() as i64 / 4)
            .sum::<i64>();
        let completion_tokens = content
            .as_deref()
            .map_or(tool_calls.len() as i64 * 12, |text| text.len() as i64 / 4)
            .max(1);
        let mut usage = HashMap::new();
        usage.insert(usage_key::PROMPT_TOKENS.to_string(), prompt_tokens);
        usage.insert(usage_key::COMPLETION_TOKENS.to_string(), completion_tokens);
        usage.insert(
            usage_key::TOTAL_TOKENS.to_string(),
            prompt_tokens + completion_tokens,
        );

        Ok(LLMResponse {
            content,
            finish_reason: if tool_calls.is_empty() {
                finish_reason::STOP.to_string()
            } else {
                finish_reason::TOOL_CALLS.to_string()
            },
            tool_calls,
            usage,
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        if cancel_flag.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err(ProviderError::Cancelled);
        }

        let response = self
            .chat(messages, tools, model, max_tokens, temperature)
            .await?;
        if let Some(content) = response.content.clone() {
            on_delta(StreamDelta {
                content: Some(content),
                reasoning: None,
                tool_call_delta: None,
                finish_reason: None,
                usage: None,
            });
        }
        on_delta(StreamDelta {
            content: None,
            reasoning: None,
            tool_call_delta: None,
            finish_reason: Some(response.finish_reason.clone()),
            usage: Some(response.usage.clone()),
        });
        Ok(response)
    }

    fn default_model(&self) -> &str {
        E2E_FAKE_PROVIDER_MODEL_PREFIX
    }

    fn provider_name(&self) -> &str {
        "e2e_fake_provider"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply_tool() -> Value {
        json!({
            "type": "function",
            "function": { "name": REPLY_SESSION_COMMENT_TOOL }
        })
    }

    fn named_tool(name: &str) -> Value {
        json!({
            "type": "function",
            "function": { "name": name }
        })
    }

    #[test]
    fn address_comments_briefing_emits_one_tool_call_per_comment() {
        let messages = vec![json!({
            "role": "user",
            "content": format!(
                "{ADDRESS_COMMENTS_MARKER}.\n### Comment 1 — id: c-1\n### Comment 2 — id: c-2"
            )
        })];

        let calls = E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]));

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, REPLY_SESSION_COMMENT_TOOL);
        assert_eq!(calls[0].arguments["commentId"], "c-1");
        assert_eq!(calls[1].arguments["commentId"], "c-2");
    }

    #[test]
    fn tool_result_stops_the_fake_provider_from_repeating_replies() {
        let messages = vec![
            json!({
                "role": "user",
                "content": format!("{ADDRESS_COMMENTS_MARKER}.\n### Comment 1 — id: c-1")
            }),
            json!({
                "role": "tool",
                "tool_call_id": "e2e-reply-session-comment-0",
                "content": "ok"
            }),
        ];

        assert!(
            E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]))
                .is_empty()
        );
    }

    #[test]
    fn ordinary_fake_provider_prompts_never_gain_comment_tool_calls() {
        let messages = vec![json!({ "role": "user", "content": "fix the tests" })];

        assert!(
            E2eFakeProvider::address_comment_tool_calls(&messages, Some(&[reply_tool()]))
                .is_empty()
        );
    }

    #[test]
    fn ordinary_reply_ignores_trailing_system_reminder() {
        let messages = vec![
            json!({ "role": "user", "content": "actual user request" }),
            json!({
                "role": "user",
                "content": "<system-reminder>volatile context</system-reminder>"
            }),
        ];

        assert_eq!(
            E2eFakeProvider::response_for(&messages),
            "E2E_FAKE_PROVIDER_REPLY: actual user request"
        );
    }

    #[test]
    fn user_role_compactor_prompt_returns_compact_summary() {
        let messages = vec![json!({
            "role": "user",
            "content": "You are a context compactor. Summarize the older conversation."
        })];

        assert!(E2eFakeProvider::response_for(&messages).starts_with("E2E_FAKE_COMPACT_SUMMARY:"));
    }

    #[test]
    fn control_wait_uses_real_user_prompt_and_bounds_seconds() {
        let messages = vec![
            json!({
                "role": "user",
                "content": concat!(
                    "Start a harmless task. ",
                    "Create a stoppable window by waiting for about 45 seconds before the final answer."
                )
            }),
            json!({
                "role": "user",
                "content": "<system-reminder>volatile context</system-reminder>"
            }),
        ];

        assert_eq!(
            control_wait_duration(&messages),
            Some(Duration::from_secs(45))
        );
    }

    #[test]
    fn session_memory_compaction_does_not_replay_task_fsm_markers() {
        let messages = vec![json!({
            "role": "user",
            "content": concat!(
                "<current_session_memory>\n",
                "Run E2E_AGENT_ORG_TASK_FSM:stale_page\n",
                "</current_session_memory>\n",
                "<new_messages>settled task updates</new_messages>"
            )
        })];

        let response = E2eFakeProvider::response_for(&messages);

        assert!(response.starts_with("E2E_FAKE_COMPACT_SUMMARY:"));
        assert!(!response.contains(AGENT_ORG_TASK_FSM_MARKER));
    }

    #[test]
    fn task_fsm_marker_drives_graph_then_atomic_replacement() {
        let tools = [
            named_tool(TASK_GRAPH_CREATE_TOOL),
            named_tool(TASK_UPDATE_TOOL),
        ];
        let messages = vec![
            json!({
                "role": "user",
                "content": "Run E2E_AGENT_ORG_TASK_FSM:run_1"
            }),
            json!({
                "role": "user",
                "content": "<system-reminder>Per-turn context only.</system-reminder>"
            }),
        ];

        let graph = E2eFakeProvider::agent_org_task_fsm_tool_calls(&messages, Some(&tools));
        assert_eq!(graph.len(), 1);
        assert_eq!(graph[0].name, TASK_GRAPH_CREATE_TOOL);
        assert_eq!(graph[0].arguments["tasks"].as_array().unwrap().len(), 4);
        assert_eq!(
            graph[0].arguments["tasks"][0]["eligible_member_ids"][0],
            "sde-implementer"
        );

        let mut with_result = messages;
        with_result.push(json!({
            "role": "tool",
            "content": json!({
                "created": true,
                "task_id_by_key": { "late": "late-task-id" }
            }).to_string()
        }));
        with_result.push(json!({
            "role": "user",
            "content": "<system-reminder>Updated per-turn context.</system-reminder>"
        }));
        let replacement =
            E2eFakeProvider::agent_org_task_fsm_tool_calls(&with_result, Some(&tools));
        assert_eq!(replacement.len(), 1);
        assert_eq!(replacement[0].name, TASK_UPDATE_TOOL);
        assert_eq!(replacement[0].arguments["operation"], "cancel_and_replace");
        assert_eq!(replacement[0].arguments["id"], "late-task-id");
        assert_eq!(
            replacement[0].arguments["replacement"]["eligible_member_ids"][0],
            "sde-planner"
        );
    }

    #[test]
    fn task_owner_lifecycle_uses_only_task_update_operations() {
        let tools = [named_tool(TASK_UPDATE_TOOL)];
        let assigned = json!({
            "role": "user",
            "content": concat!(
                "Task assigned by coordinator: E2E_TASK_FSM_COMPLETE:run_2\n",
                "Task ID: task-complete\n",
                "Execution mode: build\n",
                "E2E_AGENT_ORG_TASK_FSM:run_2"
            )
        });

        let start = E2eFakeProvider::agent_org_task_fsm_tool_calls(
            std::slice::from_ref(&assigned),
            Some(&tools),
        );
        assert_eq!(
            start[0].arguments,
            task_update_arguments_with_empty_placeholders(
                json!({ "operation": "start", "id": "task-complete" })
            )
        );

        let context = json!({
            "role": "user",
            "content": "<system-reminder>Per-turn context only.</system-reminder>"
        });
        let evidence_messages = vec![
            assigned.clone(),
            context.clone(),
            json!({ "role": "tool", "content": "ok" }),
        ];
        let evidence =
            E2eFakeProvider::agent_org_task_fsm_tool_calls(&evidence_messages, Some(&tools));
        assert_eq!(evidence[0].arguments["operation"], "append_evidence");

        let complete_messages = vec![
            assigned,
            context,
            json!({ "role": "tool", "content": "ok" }),
            json!({ "role": "tool", "content": "ok" }),
        ];
        let complete =
            E2eFakeProvider::agent_org_task_fsm_tool_calls(&complete_messages, Some(&tools));
        assert_eq!(complete[0].arguments["operation"], "complete");
        assert!(complete[0].arguments["output"].get("produced_at").is_none());
        assert!(complete[0].arguments["output"]
            .get("produced_by_member_id")
            .is_none());
    }

    #[test]
    fn task_owner_ignores_state_projection_marker_in_trailing_system_reminder() {
        let tools = [named_tool(TASK_UPDATE_TOOL)];
        let messages = vec![
            json!({
                "role": "user",
                "content": concat!(
                    "Task assigned by coordinator: E2E_TASK_FSM_COMPLETE:run_3\n",
                    "Task ID: task-complete\n",
                    "Execution mode: build\n",
                    "E2E_AGENT_ORG_TASK_FSM:run_3"
                )
            }),
            json!({
                "role": "user",
                "content": concat!(
                    "<system-reminder>Current work includes ",
                    "E2E_AGENT_ORG_TASK_FSM:stale_projection.</system-reminder>"
                )
            }),
        ];

        let calls = E2eFakeProvider::agent_org_task_fsm_tool_calls(&messages, Some(&tools));

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, TASK_UPDATE_TOOL);
        assert_eq!(
            calls[0].arguments,
            task_update_arguments_with_empty_placeholders(
                json!({ "operation": "start", "id": "task-complete" })
            )
        );
    }

    #[test]
    fn task_owner_lifecycle_accepts_production_inbox_xml_attachment() {
        let tools = [named_tool(TASK_UPDATE_TOOL)];
        let messages = vec![
            json!({
                "role": "user",
                "content": concat!(
                    "<inbox-batch run_id=\"run\" org=\"Default Agent Org\">\n",
                    "  <inbox-message id=\"3\" from_member_id=\"coordinator\" kind=\"task_assigned\" created_at=\"now\">",
                    "<task_assigned task_id=\"task-complete\" subject=\"E2E_TASK_FSM_COMPLETE:run_4\" assigned_by=\"Coordinator\" execution_mode=\"build\">",
                    "<description>E2E_AGENT_ORG_TASK_FSM:run_4</description>",
                    "</task_assigned></inbox-message>\n",
                    "</inbox-batch>"
                )
            }),
            json!({
                "role": "user",
                "content": "<system-reminder>Current work also contains E2E_AGENT_ORG_TASK_FSM:run_4.</system-reminder>"
            }),
        ];

        let calls = E2eFakeProvider::agent_org_task_fsm_tool_calls(&messages, Some(&tools));

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, TASK_UPDATE_TOOL);
        assert_eq!(
            calls[0].arguments,
            task_update_arguments_with_empty_placeholders(
                json!({ "operation": "start", "id": "task-complete" })
            )
        );
    }

    #[test]
    fn task_owner_tool_call_ids_are_unique_across_same_scenario_tasks() {
        let tools = [named_tool(TASK_UPDATE_TOOL)];
        let assignment = |task_id: &str| {
            json!({
                "role": "user",
                "content": format!(
                    concat!(
                        "Task assigned by coordinator: E2E_TASK_FSM_HISTORY:run_5:00\n",
                        "Task ID: {}\n",
                        "Execution mode: build\n",
                        "E2E_AGENT_ORG_TASK_FSM:run_5"
                    ),
                    task_id
                )
            })
        };

        let first = E2eFakeProvider::agent_org_task_fsm_tool_calls(
            &[assignment("task-history-a")],
            Some(&tools),
        );
        let second = E2eFakeProvider::agent_org_task_fsm_tool_calls(
            &[assignment("task-history-b")],
            Some(&tools),
        );

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_ne!(first[0].id, second[0].id);
        assert!(first[0].id.contains("task-history-a"));
        assert!(second[0].id.contains("task-history-b"));
    }
}
