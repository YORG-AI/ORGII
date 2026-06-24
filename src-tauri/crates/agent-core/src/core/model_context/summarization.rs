//! Summarization prompt and message formatting helpers for context compaction.

use serde_json::Value;

use super::compaction::ContextCompactor;
use crate::core::side_query::{self, SideQueryConfig, StructuredOutput};

/// Truncate text for inclusion in the summary prompt.
pub(crate) fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        text.to_string()
    } else {
        format!(
            "{}... [truncated]",
            crate::utils::safe_truncate_utf8(text, max_chars)
        )
    }
}

// ============================================
// Summarization Prompt
// ============================================

pub(crate) const SUMMARIZATION_SYSTEM_PROMPT: &str = r#"你是会话压缩器（grill-me 式脉络梳理）。你的唯一任务是读取上面的完整对话历史，输出一份结构化压缩摘要——不是流水账，而是把任务树、决策树、尝试过但被否定/废弃的路线、当前仍有效路线全部梳理清楚。

## 硬性保真要求（违反即视为压缩失败）

1. 保留所有文件路径、IP、端口、命令、配置项、错误信息原文。
2. 保留所有数值结果（行数、大小、百分比、时间戳、金额、PID、进度等）。
3. 保留关键决策、用户偏好、项目进展、技术事实。
4. 保留用户暂未被回答的问题（如果有）。
5. 必须完整覆盖到对话结尾，不能中途停下；最后的「当前待办 / 下一步 / 未完成事项 / 错误教训」必须保留到末尾。
6. 对「不再做 / 曾尝试但失败 / 曾被用户否定 / 禁止 fallback / 不应重复的路线」必须单独标记为【否定路线】或【废弃路线】并写明原因。
7. 对仍在跑的后台任务，写清 PID、log 路径、进度口径、如何复查。
8. 对用户纠正过的点，原样保留进【用户纠正】，避免压缩后复犯——尤其「不是这样 / 不对 / 其实 / 我没让你 / 不要 / 只用 / 回归 / 固化」这类纠正或范围约束，必须原话保真，不能只留最终结论。

## 必须包含的结构化章节

- **全局硬约束**
- **当前主线任务树**：每个任务写「目标 → 当前状态 → 有效路线 → 分支/决策树 → 已完成 → 待办 → 【否定路线/废弃路线】 → 关键证据/日志/路径」
- **关键决策账本（Critical Decision Ledger）**：按时间顺序列出每个仍影响后续动作的规则/算法/口径决策，每条含：decision_id、状态（accepted/rejected/superseded/candidate）、用户原话或纠正摘要、当前应执行规则、禁止重复的旧规则、证据路径/消息片段。
- **当前有效规则（Active Rules）** 与 **已废弃/禁止规则（Rejected Rules）**：若某条算法规则反复过，写清最终有效版本。
- **用户纠正与踩坑**
- **下一轮开始时必须主动同步的进度分支树**

## 格式

用 Markdown 结构化输出。中文。不要 preamble、不要思考过程、不要客套。
优先保留具体信息（精确路径、错误原文、配置值）而非泛泛描述。
目标长度尽量 ≤12k tokens，但宁可完整也不要截断。"#;

// ============================================
// Message Formatting
// ============================================

/// Format messages (references) into a readable representation for the summarizer.
pub(crate) fn format_messages_for_summary_refs(messages: &[&Value]) -> String {
    let mut parts = Vec::new();

    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap_or("unknown");
        let content = msg
            .get("content")
            .and_then(|val| val.as_str())
            .unwrap_or("");

        match role {
            "user" => {
                parts.push(format!("**User:** {}", truncate_for_summary(content, 500)));
            }
            "assistant" => {
                let tool_calls = format_tool_calls(msg);
                if content.is_empty() && !tool_calls.is_empty() {
                    parts.push(format!("**Assistant:**\n{}", tool_calls));
                } else if !content.is_empty() {
                    let mut entry =
                        format!("**Assistant:** {}", truncate_for_summary(content, 500));
                    if !tool_calls.is_empty() {
                        entry.push_str(&format!("\n{}", tool_calls));
                    }
                    parts.push(entry);
                }
            }
            "tool" => {
                let tool_name = msg
                    .get("name")
                    .and_then(|val| val.as_str())
                    .unwrap_or("unknown");
                parts.push(format!(
                    "**Tool result ({}):** {}",
                    tool_name,
                    truncate_for_summary(content, 300)
                ));
            }
            "system" => {}
            _ => {
                parts.push(format!(
                    "**{}:** {}",
                    role,
                    truncate_for_summary(content, 200)
                ));
            }
        }
    }

    parts.join("\n\n")
}

/// Format tool calls from an assistant message.
pub(crate) fn format_tool_calls(msg: &Value) -> String {
    msg.get("tool_calls")
        .and_then(|tc| tc.as_array())
        .map(|arr| {
            arr.iter()
                .map(|tc| {
                    let name = tc
                        .get("function")
                        .and_then(|func| func.get("name"))
                        .and_then(|val| val.as_str())
                        .unwrap_or("unknown");
                    let args = tc
                        .get("function")
                        .and_then(|func| func.get("arguments"))
                        .and_then(|val| val.as_str())
                        .unwrap_or("{}");
                    format!(
                        "  → tool_call: {}({})",
                        name,
                        truncate_for_summary(args, 200)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Generate a summary of messages using the LLM.
///
/// Oversized messages (>50% of context window) are excluded from
/// summarization and noted separately to avoid exceeding the
/// summarization model's context window.
pub(crate) async fn summarize_messages(
    messages: &[Value],
    state: &super::compaction::CompactionState,
    provider: &dyn crate::providers::traits::LLMProvider,
    model: &str,
    config: &super::compaction::CompactionConfig,
    budget_tokens: usize,
) -> Result<String, String> {
    let budget = budget_tokens;
    let mut summarizable: Vec<&Value> = Vec::new();
    let mut oversized_notes: Vec<String> = Vec::new();

    for msg in messages {
        if ContextCompactor::is_oversized(msg, budget) {
            let role = msg
                .get("role")
                .and_then(|val| val.as_str())
                .unwrap_or("message");
            let tokens = ContextCompactor::estimate_message_tokens(msg);
            oversized_notes.push(format!(
                "[Large {} (~{}K tokens) omitted from summary]",
                role,
                tokens / 1000
            ));
        } else {
            summarizable.push(msg);
        }
    }

    if !oversized_notes.is_empty() {
        tracing::info!(
            "[compaction] {} oversized messages excluded from summarization",
            oversized_notes.len()
        );
    }

    let formatted = format_messages_for_summary_refs(&summarizable);

    let mut prompt = String::from(SUMMARIZATION_SYSTEM_PROMPT);

    if state.recompaction_info.compaction_count > 0 {
        prompt.push_str(&format!(
            "\n\n## Re-compaction Context\n\nThis is compaction #{} for this session (last at turn {}). \
             Merge the prior summary with the new messages — preserve important details from both, \
             but prioritize recent information when there are conflicts or superseded decisions.",
            state.recompaction_info.compaction_count + 1,
            state.recompaction_info.last_compaction_turn,
        ));
    }

    if let Some(ref prior_summary) = state.summary {
        prompt.push_str(&format!(
            "\n\n## Prior Context Summary\n\n{}\n\n## New Messages to Incorporate\n\n",
            prior_summary
        ));
    }

    let user_message = vec![serde_json::json!({
        "role": "user",
        "content": formatted,
    })];

    let sq_config = SideQueryConfig {
        model: None,
        max_tokens: config.summary_max_tokens,
        temperature: 0.0,
        system_prompt: Some(prompt),
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "grill-me 式结构化压缩摘要（Markdown，中文）：全局硬约束 / 当前主线任务树 / 关键决策账本 / 当前有效规则 / 已废弃规则 / 用户纠正与踩坑 / 下一轮必须主动同步的进度分支树。保留所有路径/IP/端口/命令/配置/错误原文/数值/用户纠正原话。"
                    }
                },
                "required": ["summary"]
            }),
        }),
        ..Default::default()
    };

    let result = side_query::side_query(provider, &user_message, &sq_config, model).await?;

    // Extract from structured output (forced tool call) if available,
    // fall back to text content for providers that don't support tool_choice.
    let mut summary = if let Some(structured) = result.structured {
        structured
            .get("summary")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        result.content
    };

    if !oversized_notes.is_empty() {
        summary.push_str("\n\n");
        summary.push_str(&oversized_notes.join("\n"));
    }

    Ok(summary)
}
