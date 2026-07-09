//! Summarization prompt and message formatting helpers for context compaction.

use serde_json::Value;

use super::compaction::ContextCompactor;
use crate::core::side_query::{self, SideQueryConfig, StructuredOutput};

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

pub(crate) const SUMMARIZATION_SYSTEM_PROMPT: &str = r#"You are a context compactor. Your task is to create a detailed summary of a conversation between a user and an AI coding assistant, paying close attention to the user's explicit requests and the assistant's previous actions. The summary will REPLACE the older conversation history — anything you omit is lost, and the assistant must be able to resume work from your summary alone.

Before writing, silently review the entire conversation and verify: every user request captured? every touched file listed? the most recent work identified? Then output the summary.

## Required structure

Use exactly these sections:

1. **Primary Request and Intent** — all of the user's explicit requests and intents, in detail
2. **Key Technical Concepts** — technologies, frameworks, and conventions involved
3. **Files and Code Sections** — files created/edited/read that matter, with exact paths; include the important code snippets or signatures and why each matters
4. **Errors and Fixes** — every error encountered, its cause, and how it was fixed (or that it remains open); include exact error messages. Pay special attention to explicit user feedback or corrections
5. **Problem Solving** — problems solved so far and any ongoing troubleshooting
6. **All User Messages** — a list of ALL non-tool-result user messages, condensed but preserving intent and constraints; these are critical for understanding what the user actually asked
7. **Pending Tasks** — tasks explicitly requested but not yet done
8. **Current Work** — precisely what was being worked on immediately before this summary, with file paths and code where relevant
9. **Next Step** — the immediate next step, ONLY if it is a direct continuation of explicitly requested work; include a verbatim quote of the most recent instruction that justifies it. If there is no explicit next task, omit the step rather than inventing one

Preserve specifics: exact file paths, function names, error messages, config values, branch names, IDs.
Do NOT include pleasantries or conversational filler."#;

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
                        "description": "The complete, detailed multi-section summary of the conversation in markdown, following the required section structure"
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

    // A response cut off at the output cap is a mid-sentence summary;
    // persisting it would durably hide the compacted messages behind an
    // incomplete replacement. Treat as failure so the caller can fall back /
    // surface it.
    //
    // NOTE: this message must NOT contain any keyword matched by
    // `ContextCompactor::is_prompt_too_long_error` (e.g. "max_tokens",
    // "token limit"), or `try_compact` would misroute this OUTPUT-side
    // failure into the input-shrinking PTL retry loop.
    if result.finish_reason == crate::providers::finish_reason::LENGTH {
        return Err(format!(
            "summary output hit the summarizer cap ({}) — refusing incomplete summary",
            config.summary_max_tokens
        ));
    }

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

    // An empty summary must never replace real history: the compacted view
    // would render `[Conversation summary — N messages compacted]` followed
    // by nothing, silently destroying context.
    if summary.trim().is_empty() {
        return Err("summarizer returned an empty summary".to_string());
    }

    if !oversized_notes.is_empty() {
        summary.push_str("\n\n");
        summary.push_str(&oversized_notes.join("\n"));
    }

    Ok(summary)
}
