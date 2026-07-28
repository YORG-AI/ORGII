//! The `session_step_explain` Tauri command and its prompt/response helpers.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::key_store::ModelKey;

use super::client::{
    chat_completions_url, content_value_to_string, key_base_url, minicpm_no_think_kwargs,
    provider_error_message, select_prompt_polish_account, with_optional_bearer,
    ChatCompletionMessage, ChatCompletionRequest, ChatCompletionResponse,
};
use super::text::{strip_reasoning_artifacts, text_excerpt};
use super::POLISH_REQUEST_TIMEOUT_SECONDS;

const STEP_EXPLAIN_MAX_TOKENS: u32 = 256;
const STEP_EXPLAIN_FIELD_MAX_CHARS: usize = 500;
const HOUSEKEEPER_STEP_EXPLAIN_SYSTEM_PROMPT: &str = r#"You are ORG2's local MiniCPM resident housekeeper.
Your only job is to explain the current session replay step in Chinese.
Rules:
1. Explain only what this current step did and why it matters to the current task.
2. Do not predict the next step, propose a fix, or invent file contents or command results.
3. Return one or two short Chinese sentences, within 120 Chinese characters.
4. Do not output <think>, analysis, reasoning, headings, Markdown, or extra labels.
"#;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepExplainRequest {
    pub event_id: String,
    pub function_name: Option<String>,
    pub action_type: Option<String>,
    pub display_text: Option<String>,
    pub display_status: Option<String>,
    pub display_variant: Option<String>,
    pub source: Option<String>,
    pub file_path: Option<String>,
    pub command: Option<String>,
    pub args: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub account_id: Option<String>,
    pub model: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepExplainResponse {
    pub explanation: String,
    pub model: String,
    pub account_id: String,
}
fn option_text_excerpt(value: Option<&str>, max_chars: usize) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| text_excerpt(value, max_chars))
        .unwrap_or_else(|| "无".to_string())
}
fn json_excerpt(value: Option<&serde_json::Value>, max_chars: usize) -> String {
    let Some(value) = value else {
        return "无".to_string();
    };

    if value.is_null() {
        return "无".to_string();
    }

    if let Some(text) = value.as_str() {
        return text_excerpt(text, max_chars);
    }

    serde_json::to_string(value)
        .map(|text| text_excerpt(&text, max_chars))
        .unwrap_or_else(|_| "无法序列化".to_string())
}
fn build_step_explain_user_prompt(request: &SessionStepExplainRequest) -> String {
    format!(
        r#"请解释下面这个 session replay 当前步骤。

事件 ID：{event_id}
事件来源：{source}
展示类型：{display_variant}
状态：{display_status}
工具/函数：{function_name}
动作类型：{action_type}
文件路径：{file_path}
命令：{command}
展示文本：{display_text}
参数摘要：{args}
结果摘要：{result}

请只输出 1 到 2 句中文解释，说明这一步做了什么，以及它为什么对当前任务有意义："#,
        event_id = option_text_excerpt(Some(&request.event_id), 160),
        source = option_text_excerpt(request.source.as_deref(), 80),
        display_variant = option_text_excerpt(request.display_variant.as_deref(), 80),
        display_status = option_text_excerpt(request.display_status.as_deref(), 80),
        function_name = option_text_excerpt(request.function_name.as_deref(), 120),
        action_type = option_text_excerpt(request.action_type.as_deref(), 120),
        file_path = option_text_excerpt(request.file_path.as_deref(), 240),
        command = option_text_excerpt(request.command.as_deref(), 360),
        display_text = option_text_excerpt(
            request.display_text.as_deref(),
            STEP_EXPLAIN_FIELD_MAX_CHARS
        ),
        args = json_excerpt(request.args.as_ref(), STEP_EXPLAIN_FIELD_MAX_CHARS),
        result = json_excerpt(request.result.as_ref(), STEP_EXPLAIN_FIELD_MAX_CHARS),
    )
}
fn sanitize_step_explanation(explanation: &str) -> Result<String, String> {
    let cleaned = strip_reasoning_artifacts(explanation);
    let cleaned = cleaned
        .trim()
        .trim_start_matches("解释：")
        .trim_start_matches("说明：")
        .trim_start_matches("当前步骤：")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return Err("MiniCPM returned only reasoning text".to_string());
    }

    Ok(text_excerpt(&cleaned, 220))
}
fn extract_step_explanation(response: ChatCompletionResponse) -> Result<String, String> {
    let content = response
        .choices
        .into_iter()
        .find_map(|choice| {
            choice
                .message
                .and_then(|message| message.content)
                .and_then(content_value_to_string)
                .or(choice.text)
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "MiniCPM returned an empty step explanation".to_string())?;

    sanitize_step_explanation(&content)
}
async fn request_session_step_explain(
    key: &ModelKey,
    model: &str,
    explain_request: &SessionStepExplainRequest,
) -> Result<String, String> {
    let base_url = key_base_url(key)?;
    let endpoint = chat_completions_url(base_url)?;

    let user_prompt = build_step_explain_user_prompt(explain_request);
    let body = ChatCompletionRequest {
        model,
        messages: vec![
            ChatCompletionMessage {
                role: "system",
                content: HOUSEKEEPER_STEP_EXPLAIN_SYSTEM_PROMPT,
            },
            ChatCompletionMessage {
                role: "user",
                content: &user_prompt,
            },
        ],
        temperature: 0.15,
        max_tokens: STEP_EXPLAIN_MAX_TOKENS,
        stream: false,
        chat_template_kwargs: minicpm_no_think_kwargs(),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(POLISH_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|err| format!("Failed to create MiniCPM HTTP client: {err}"))?;

    let request = with_optional_bearer(client.post(endpoint).json(&body), key);

    let response = request
        .send()
        .await
        .map_err(|err| format!("MiniCPM request failed: {err}"))?;
    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read MiniCPM response: {err}"))?;

    if !status.is_success() {
        return Err(provider_error_message(status, &response_body));
    }

    let parsed = serde_json::from_str::<ChatCompletionResponse>(&response_body)
        .map_err(|err| format!("Failed to parse MiniCPM response: {err}"))?;
    extract_step_explanation(parsed)
}
#[tauri::command]
pub async fn session_step_explain(
    request: SessionStepExplainRequest,
) -> Result<SessionStepExplainResponse, String> {
    if request.event_id.trim().is_empty() {
        return Err("No session event to explain".to_string());
    }

    let account_id = request.account_id.clone();
    let model = request.model.clone();
    let selection = tokio::task::spawn_blocking(move || {
        select_prompt_polish_account(account_id.as_deref(), model.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;

    let explanation =
        request_session_step_explain(&selection.key, &selection.model, &request).await?;
    Ok(SessionStepExplainResponse {
        explanation,
        model: selection.model,
        account_id: selection.key.id,
    })
}

#[cfg(test)]
mod tests {
    use super::super::client::{ChatCompletionChoice, ChatCompletionResponseMessage};
    use super::*;

    #[test]
    fn strips_think_blocks_from_step_explanation() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "<think>这里是模型推理</think>\n当前步骤正在读取后端配置文件，用于确认服务启动参数。"
                            .to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let explanation = extract_step_explanation(response).unwrap();

        assert_eq!(
            explanation,
            "当前步骤正在读取后端配置文件，用于确认服务启动参数。"
        );
    }

    #[test]
    fn truncates_large_step_explain_fields() {
        let request = SessionStepExplainRequest {
            event_id: "event-1".to_string(),
            function_name: Some("read_file".to_string()),
            action_type: Some("tool_call".to_string()),
            display_text: Some("读取文件".to_string()),
            display_status: Some("completed".to_string()),
            display_variant: Some("tool_call".to_string()),
            source: Some("assistant".to_string()),
            file_path: Some("src/main.rs".to_string()),
            command: None,
            args: Some(serde_json::json!({
                "content": "x".repeat(STEP_EXPLAIN_FIELD_MAX_CHARS + 50)
            })),
            result: None,
            account_id: None,
            model: None,
        };

        let prompt = build_step_explain_user_prompt(&request);

        assert!(prompt.contains("src/main.rs"));
        assert!(prompt.contains("xxx"));
        assert!(prompt.contains("..."));
        assert!(prompt.len() < STEP_EXPLAIN_FIELD_MAX_CHARS + 1_500);
    }
}
