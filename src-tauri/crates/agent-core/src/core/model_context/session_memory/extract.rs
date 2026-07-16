//! Session memory extraction:
//!
//! - [`should_extract`] — pure trigger heuristic
//! - [`extract_session_memory`] — runs a single side-call to (re)build SM markdown
//! - [`find_last_safe_boundary`] — picks the highest message index safe to mark
//!   as the SM boundary (avoids splitting a tool_use → tool_result pair)

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::config::SessionMemoryConfig;
use super::sections::{analyze_section_sizes, generate_section_reminders};
use super::state::SessionMemoryState;
use crate::core::model_context::tokenizer;
use crate::core::side_query::{self, SideQueryConfig, StructuredOutput};
use crate::providers::traits::LLMProvider;

/// SM extraction system prompt — 9-section template.
const SM_EXTRACTION_SYSTEM_PROMPT: &str = r#"You are a session memory extractor. Your job is to maintain a structured summary of an ongoing conversation between a user and an AI coding assistant.

## Instructions

Read the conversation and update the session memory document below. Each section has a specific purpose — update only sections with new information, preserve existing content that is still relevant, and remove content that is outdated or superseded.

Keep each section concise (~200 words max). Use bullet points. Preserve exact file paths, variable names, error messages, and config values.
Keep each section under ~2000 tokens — if a section is approaching this limit, condense it by cycling out less important details while preserving the most critical information.
Focus on actionable, specific information that would help someone understand or recreate the work discussed in the conversation.
IMPORTANT: Always update "Current State" to reflect the most recent work — this is critical for continuity after compaction.

## Sections

### Session Title
One-line title describing the overall task.

### Current State
What is happening right now? What was the last action taken? This section must ALWAYS be updated.

### Task Specification
What is the user trying to accomplish? Requirements, constraints, preferences stated.

### Files and Functions
Key files created, edited, or referenced. Include paths and brief descriptions of changes.

### Workflow
Steps taken so far, in order. Include both successful and failed attempts.

### Errors and Corrections
Errors encountered, their causes, and how they were resolved. Include exact error messages.

### Codebase and System Documentation
Architecture patterns, conventions, or system details discovered during the session.

### Learnings
Key decisions made and their rationale. User preferences or style choices.

### Key Results
Concrete outputs: files created, tests passing, features completed.

## Output Format

Return the COMPLETE updated session memory document in markdown, with all section headers preserved.
Do NOT include any text outside the document.
Do NOT wrap in code fences."#;

/// Check whether session memory extraction should run.
pub fn should_extract(
    state: &SessionMemoryState,
    config: &SessionMemoryConfig,
    current_tokens: usize,
    last_turn_has_tool_calls: bool,
) -> bool {
    if !config.enabled || state.extraction_in_progress {
        return false;
    }

    if !state.initialized && current_tokens < config.min_tokens_to_init {
        return false;
    }

    let token_growth = current_tokens.saturating_sub(state.tokens_at_last_extraction);
    if token_growth < config.min_tokens_between_update {
        return false;
    }

    let tool_threshold_met = state.tool_calls_since_extraction >= config.tool_calls_between_updates;
    let natural_break = !last_turn_has_tool_calls;

    tool_threshold_met || natural_break
}

/// Extract or update session memory from the conversation.
///
/// Makes a single LLM side-call with the SM system prompt, current SM
/// content, and recent messages. Returns the updated SM markdown.
pub async fn extract_session_memory(
    messages: &[Value],
    sm_state: Arc<Mutex<SessionMemoryState>>,
    config: &SessionMemoryConfig,
    provider: &dyn LLMProvider,
    model: &str,
) -> Result<String, String> {
    use crate::core::model_context::summarization;

    // ── Prepare: brief lock to snapshot the read-side state + flag the
    // extraction as in-progress. The mutex is NOT held across the LLM call
    // below — otherwise the next turn's brief `sm_state` reads (pre-turn
    // compaction, the gate pre-check) would block for the whole extraction.
    let (start_idx, existing_content, consumed_tool_calls) = {
        let mut state = sm_state.lock().await;
        state.extraction_in_progress = true;
        let start_idx = state
            .last_summarized_msg_idx
            .map(|idx| idx + 1)
            .unwrap_or(0);
        (
            start_idx,
            state.content.clone(),
            state.tool_calls_since_extraction,
        )
    };

    let new_messages = if start_idx < messages.len() {
        &messages[start_idx..]
    } else {
        messages
    };

    let mut user_content = String::new();

    let section_reminders = if let Some(ref existing) = existing_content {
        user_content.push_str("<current_session_memory>\n");
        user_content.push_str(existing);
        user_content.push_str("\n</current_session_memory>\n\n");

        let sections = analyze_section_sizes(existing);
        // Use the same rough estimate the sections module uses internally.
        let total_tokens = existing.len() / 4;
        generate_section_reminders(
            &sections,
            total_tokens,
            config.max_section_tokens,
            config.max_total_tokens,
        )
    } else {
        String::new()
    };

    user_content.push_str("<new_messages>\n");
    for msg in new_messages {
        let role = msg
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap_or("unknown");
        let content = msg
            .get("content")
            .and_then(|val| val.as_str())
            .unwrap_or("");
        let truncated = summarization::truncate_for_summary(content, 500);

        match role {
            "user" => {
                user_content.push_str(&format!("**User:** {}\n\n", truncated));
            }
            "assistant" => {
                let tool_calls = summarization::format_tool_calls(msg);
                if content.is_empty() && !tool_calls.is_empty() {
                    user_content.push_str(&format!("**Assistant:**\n{}\n\n", tool_calls));
                } else if !content.is_empty() {
                    user_content.push_str(&format!("**Assistant:** {}\n\n", truncated));
                    if !tool_calls.is_empty() {
                        user_content.push_str(&format!("{}\n\n", tool_calls));
                    }
                }
            }
            "tool" => {
                let name = msg
                    .get("name")
                    .and_then(|val| val.as_str())
                    .unwrap_or("tool");
                user_content.push_str(&format!(
                    "**Tool ({}):** {}\n\n",
                    name,
                    summarization::truncate_for_summary(content, 300)
                ));
            }
            _ => {}
        }
    }
    user_content.push_str("</new_messages>");

    if !section_reminders.is_empty() {
        user_content.push_str(&section_reminders);
    }

    let sq_config = SideQueryConfig {
        // Session-memory extraction only reads the truncated <new_messages>
        // digest (not the full conversation prefix), so it gains nothing
        // from the parent prompt cache. Route it to the fast sibling of the
        // session model (same provider family/protocol) instead of burning
        // the primary channel model on a summarization side query.
        model: Some(crate::providers::model_hints::fast_model_hint(model)),
        max_tokens: config.extraction_max_tokens,
        temperature: 0.0,
        system_prompt: Some(SM_EXTRACTION_SYSTEM_PROMPT.to_string()),
        structured: Some(StructuredOutput {
            tool_name: "emit_session_memory".to_string(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The structured session memory document"
                    }
                },
                "required": ["content"]
            }),
        }),
        ..Default::default()
    };

    let user_messages = vec![serde_json::json!({
        "role": "user",
        "content": user_content,
    })];

    let result = side_query::side_query(provider, &user_messages, &sq_config, model).await;

    // ── Finalize: brief lock to merge the result back. Concurrent
    // `record_tool_calls` increments that arrived while the LLM was running
    // are preserved by subtracting only what we consumed at prepare time,
    // rather than blindly resetting the counter to 0.
    let mut state = sm_state.lock().await;
    state.extraction_in_progress = false;

    match result {
        Ok(sq_result) => {
            // Extract from structured output (forced tool call) if available,
            // fall back to text content for providers that don't support tool_choice.
            let sm_content = if let Some(structured) = sq_result.structured {
                structured
                    .get("content")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                sq_result.content
            };
            state.content = Some(sm_content.clone());
            state.tokens_at_last_extraction = tokenizer::count_messages_tokens(messages);
            state.tool_calls_since_extraction = state
                .tool_calls_since_extraction
                .saturating_sub(consumed_tool_calls);
            state.initialized = true;

            if let Some(last_safe_idx) = find_last_safe_boundary(messages) {
                state.last_summarized_msg_idx = Some(last_safe_idx);
            }

            info!(
                "[session_memory] Extraction complete ({} chars, boundary={})",
                sm_content.len(),
                state.last_summarized_msg_idx.unwrap_or(0),
            );

            Ok(sm_content)
        }
        Err(err) => {
            warn!("[session_memory] Extraction failed: {}", err);
            Err(err)
        }
    }
}

/// Find the last message index that is safe to use as an SM boundary.
///
/// We avoid setting the boundary at an assistant message with tool_calls
/// because that would orphan the tool_result messages that follow it
/// during SM-compact.
fn find_last_safe_boundary(messages: &[Value]) -> Option<usize> {
    for idx in (0..messages.len()).rev() {
        let role = messages[idx]
            .get("role")
            .and_then(|val| val.as_str())
            .unwrap_or("");

        if role == "assistant" {
            let has_tool_calls = messages[idx]
                .get("tool_calls")
                .and_then(|tc| tc.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);

            if has_tool_calls {
                continue;
            }
            return Some(idx);
        }

        if role == "user" {
            return Some(idx);
        }
    }
    None
}
