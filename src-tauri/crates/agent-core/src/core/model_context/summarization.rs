//! Summarization prompt and message formatting helpers for context compaction.

use serde_json::Value;

use super::compaction::ContextCompactor;
use crate::core::side_query::{self, SideQueryConfig};

/// Relaxed cap for tool results fed to the summarizer. Large enough to keep
/// exact error messages / paths intact; the per-message oversized guard in
/// `summarize_messages` still protects the summarizer's context window.
const TOOL_RESULT_SUMMARY_MAX_CHARS: usize = 4_000;
/// Cap for tool-call argument echoes in the summarizer input.
const TOOL_ARGS_SUMMARY_MAX_CHARS: usize = 1_000;

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

/// Flatten message content to plain text for the summarizer.
///
/// Strings pass through unchanged. Block arrays (multimodal messages)
/// have their text blocks joined and image blocks reduced to an
/// `[image]` placeholder — the user's words in a text+image message must
/// reach the summary. Ref: claude_code compact.ts stripImagesFromMessages.
pub(crate) fn flatten_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<&str> = Vec::new();
            for block in blocks {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text);
                } else {
                    let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                    if block_type == "image" || block_type == "image_url" {
                        parts.push("[image]");
                    }
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// Format messages (references) into a readable representation for the summarizer.
///
/// User and assistant text is passed through in full; multimodal block
/// arrays are flattened (text preserved, images become `[image]`).
/// Tool results and tool-call args keep a relaxed cap so one noisy command
/// dump cannot crowd out the rest of the history.
pub(crate) fn format_messages_for_summary_refs(messages: &[&Value]) -> String {
    let mut parts = Vec::new();

    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap_or("unknown");
        let content = flatten_content_text(msg.get("content"));

        match role {
            "user" => {
                parts.push(format!("**User:** {}", content));
            }
            "assistant" => {
                let tool_calls = format_tool_calls(msg);
                if content.is_empty() && !tool_calls.is_empty() {
                    parts.push(format!("**Assistant:**\n{}", tool_calls));
                } else if !content.is_empty() {
                    let mut entry = format!("**Assistant:** {}", content);
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
                    truncate_for_summary(&content, TOOL_RESULT_SUMMARY_MAX_CHARS)
                ));
            }
            "system" => {}
            _ => {
                parts.push(format!("**{}:** {}", role, content));
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
                        truncate_for_summary(args, TOOL_ARGS_SUMMARY_MAX_CHARS)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Build the summarization instruction prompt (system prompt for the
/// side-query path, user-message text for the fork path).
///
/// `include_prior_summary` is false on the fork path: the prior compact
/// summary is already present in the forked message list as the boundary
/// user message, so repeating it would only bloat the request.
fn build_summary_prompt(
    state: &super::compaction::CompactionState,
    custom_instructions: Option<&str>,
    include_prior_summary: bool,
) -> String {
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

    if include_prior_summary {
        if let Some(ref prior_summary) = state.summary {
            prompt.push_str(&format!(
                "\n\n## Prior Context Summary\n\n{}\n\n## New Messages to Incorporate\n\n",
                prior_summary
            ));
        }
    }

    if let Some(instructions) = custom_instructions
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty())
    {
        prompt.push_str(&format!(
            "\n\n## Additional Instructions\n\nThe user provided extra focus instructions for this \
             summary. Honor them on top of the required section structure — they refine emphasis, \
             they do not replace any section:\n{}",
            instructions
        ));
    }

    prompt
}

/// Validate a summarizer response shared by both paths: reject output cut
/// off at the cap and empty summaries.
///
/// NOTE: these messages must NOT contain any keyword matched by
/// `ContextCompactor::is_prompt_too_long_error` (e.g. "max_tokens",
/// "token limit"), or `try_compact` would misroute an OUTPUT-side failure
/// into the input-shrinking PTL retry loop.
fn validate_summary(
    summary: String,
    finish_reason: &str,
    output_cap: u32,
) -> Result<String, String> {
    // A response cut off at the output cap is a mid-sentence summary;
    // persisting it would durably hide the compacted messages behind an
    // incomplete replacement.
    if finish_reason == crate::providers::finish_reason::LENGTH {
        return Err(format!(
            "summary output hit the summarizer cap ({}) — refusing incomplete summary",
            output_cap
        ));
    }
    // An empty summary must never replace real history: the compacted view
    // would render `[Conversation summary — N messages compacted]` followed
    // by nothing, silently destroying context.
    if summary.trim().is_empty() {
        return Err("summarizer returned an empty summary".to_string());
    }
    Ok(summary)
}

// ============================================
// Fork-form summarization (prompt-cache sharing)
// ============================================

/// Inputs for the fork-form summarization call.
///
/// The summary request is appended to the main turn's EXACT request prefix
/// (runtime system prefix + full history, same tools / model / max_tokens /
/// temperature) so the provider prompt cache written by the previous turn is
/// read instead of paying a cold full-prompt cost. Ref: claude_code
/// runForkedAgent + CacheSafeParams (compact.ts streamCompactSummary,
/// forkedAgent.ts): system prompt, tools, model, message prefix and thinking
/// config must be identical to share the parent's cache — disabling cache
/// sharing measured ~98% cache miss.
pub struct ForkSummaryInputs<'a> {
    /// Wire-identical main-turn message list (runtime system prefix +
    /// history, screenshots resolved, timestamp metadata stripped).
    pub messages: &'a [Value],
    /// Main turn's tool definitions. Affects both the cache key and the
    /// thinking directive the request builder picks (no tools → PlainText,
    /// which would diverge from the main turn's Auto).
    pub tools: &'a [Value],
    /// Main turn's model — NOT the compaction summary-model override.
    pub model: &'a str,
    /// Main turn's max_tokens. Legacy models derive the thinking budget
    /// from it; a different value changes the thinking config and breaks
    /// the cache prefix.
    pub max_tokens: u32,
    pub temperature: f32,
}

/// Fork-form summarization: main-turn prefix + a volatile-marked summary
/// request, plain-text response.
///
/// `skip_cache_write` stays FALSE: on Anthropic, suppressing breakpoints
/// removes the cache LOOKUP points too — no breakpoints means zero cache
/// reads, not "read without writing". The prefix breakpoints land at the
/// same positions as the main turn's request (the summary-request block is
/// scope-marked `volatile`, so the trailing breakpoint skips it), making
/// the call almost entirely cache reads.
pub(crate) async fn summarize_messages_forked(
    provider: &dyn crate::providers::traits::LLMProvider,
    inputs: &ForkSummaryInputs<'_>,
    state: &super::compaction::CompactionState,
    custom_instructions: Option<&str>,
) -> Result<String, String> {
    use crate::session::prompt::cache::{RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY};

    let prompt = build_summary_prompt(state, custom_instructions, false);
    let mut messages: Vec<Value> = inputs.messages.to_vec();
    messages.push(serde_json::json!({
        "role": "user",
        "content": [{
            "type": "text",
            "text": prompt,
            (ORGII_SYSTEM_CACHE_SCOPE_KEY): RenderedSystemBlockScope::Volatile.as_str(),
        }],
    }));

    tracing::info!(
        "[compaction] fork summary request: {} prefix messages, {} tools, model={}",
        inputs.messages.len(),
        inputs.tools.len(),
        inputs.model,
    );

    let response = provider
        .chat_with_options(
            &messages,
            Some(inputs.tools),
            inputs.model,
            inputs.max_tokens,
            inputs.temperature,
            crate::providers::traits::ChatOptions::default(),
        )
        .await
        .map_err(|err| err.to_string())?;

    // Tools are present with tool_choice auto — a model that answers with
    // a tool call instead of prose yields no primary text; treat as failure
    // so the caller falls back to the side-query path.
    let summary = response
        .primary_text()
        .map(str::to_string)
        .unwrap_or_default();
    validate_summary(summary, &response.finish_reason, inputs.max_tokens)
}

/// Generate a summary of messages using the LLM.
///
/// Oversized messages (>50% of context window) are excluded from
/// summarization and noted separately to avoid exceeding the
/// summarization model's context window.
///
/// `custom_instructions` (manual compaction only) is appended to the
/// summarization prompt as an additional-focus section; the required
/// section structure still applies.
pub(crate) async fn summarize_messages(
    messages: &[Value],
    state: &super::compaction::CompactionState,
    provider: &dyn crate::providers::traits::LLMProvider,
    model: &str,
    config: &super::compaction::CompactionConfig,
    budget_tokens: usize,
    custom_instructions: Option<&str>,
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

    let prompt = build_summary_prompt(state, custom_instructions, true);

    let user_message = vec![serde_json::json!({
        "role": "user",
        "content": formatted,
    })];

    // Plain-text output, NOT a forced tool call. Ref: claude_code
    // streamCompactSummary sends the compact prompt as a normal user
    // message and reads back the assistant's text. Forcing the 9-section
    // summary into a single tool-call string argument made models answer
    // huge prompts (233K observed) with an empty `{}` — long-form markdown
    // prose is what they are actually good at.
    let sq_config = SideQueryConfig {
        model: None,
        max_tokens: config.summary_max_tokens,
        temperature: 0.0,
        // Compaction prompts approach the full context window; stream the
        // response so gateway/proxy read timeouts don't kill the call.
        stream: true,
        system_prompt: Some(prompt),
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Structured compaction summary (Markdown). Preserve hard constraints, active task tree, decisions, valid rules, superseded rules, user corrections, pitfalls, exact paths/IPs/ports/commands/config/errors/numbers, and the next-turn progress plan."
                    }
                },
                "required": ["summary"]
            }),
        }),
        // One-shot request over a prefix that is never sent again — writing
        // it to the provider prompt cache is pure cost.
        skip_cache_write: true,
        ..Default::default()
    };

    let result = side_query::side_query(provider, &user_message, &sq_config, model).await?;

    let mut summary = validate_summary(
        result.content,
        &result.finish_reason,
        config.summary_max_tokens,
    )?;

    if !oversized_notes.is_empty() {
        summary.push_str("\n\n");
        summary.push_str(&oversized_notes.join("\n"));
    }

    Ok(summary)
}
