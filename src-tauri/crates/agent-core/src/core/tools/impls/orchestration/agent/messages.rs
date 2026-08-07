//! Build the subagent's initial message list — three paths:
//!
//! - **Resume** (`resume_session_id` set): load persisted history, append the
//!   follow-up prompt as a new user turn. The prompt may be `None` for
//!   inbox-driven wakes where the inbox-drain hook in
//!   [`crate::session::turn::processor::inbox_drain`] injects
//!   the user message at turn-loop entry instead.
//! - **Fork** (`fork: true`): inherit the parent's conversation so the subagent
//!   shares Anthropic's prompt-cache prefix; subagent's own system prompt
//!   becomes a second system block.
//! - **Standard**: fresh single-system + single-user message pair.

use serde_json::Value;
use tracing::info;

use super::AgentTool;
use crate::tools::traits::ToolError;
use crate::turn_executor;

pub enum InitialMessageMode {
    /// Resume — caller validated the session ID shape upstream.
    Resume(String),
    Fork,
    Fresh,
}

impl AgentTool {
    pub(super) async fn build_initial_messages(
        &self,
        full_system_prompt: &str,
        prompt: &str,
        mode: InitialMessageMode,
    ) -> Result<Vec<Value>, ToolError> {
        match mode {
            InitialMessageMode::Resume(resume_id) => {
                build_resume_messages(&resume_id, full_system_prompt, Some(prompt))
            }
            InitialMessageMode::Fork => {
                Ok(self.build_fork_messages(full_system_prompt, prompt).await)
            }
            InitialMessageMode::Fresh => Ok(build_fresh_messages(full_system_prompt, prompt)),
        }
    }

    async fn build_fork_messages(&self, full_system_prompt: &str, prompt: &str) -> Vec<Value> {
        // Fork path: inherit parent conversation with prompt cache sharing.
        //
        // Strategy: reuse the parent's first system message (stable prefix) as-is,
        // then add the subagent's own prompt as a second system message.
        // When Anthropic's extract_system() processes these, it creates two
        // content blocks — the first gets cache_control for prompt caching.
        // This means the subagent request shares the same cached prefix as the parent.
        let parent_msgs = self.parent_messages.lock().await;
        let mut msgs = Vec::with_capacity(parent_msgs.len() + 3);

        // Copy parent's system messages (stable prefix) first
        let mut has_parent_system = false;
        for msg in parent_msgs.iter() {
            if turn_executor::msg_role(msg) == "system" {
                msgs.push(msg.clone());
                has_parent_system = true;
            }
        }

        // Add subagent's own system prompt as a separate system message
        // (becomes a non-cached content block, after the cached parent prefix)
        if !has_parent_system {
            msgs.push(serde_json::json!({
                "role": "system",
                "content": full_system_prompt,
            }));
        } else {
            msgs.push(serde_json::json!({
                "role": "system",
                "content": format!("# Subagent Override\n\n{}", full_system_prompt),
            }));
        }

        // Copy non-system parent messages (conversation history)
        for msg in parent_msgs.iter() {
            if turn_executor::msg_role(msg) != "system" {
                msgs.push(msg.clone());
            }
        }
        msgs.push(serde_json::json!({
            "role": "user",
            "content": prompt,
        }));
        info!(
            "[agent] Fork path with cache sharing: {} parent messages + {} system blocks",
            parent_msgs.len(),
            if has_parent_system {
                "shared prefix +"
            } else {
                "fresh"
            }
        );
        msgs
    }
}

/// Build the resume-path message list.
///
/// `prompt = Some(text)` — append `{role: user, content: text}` as the final
/// turn. This is the LLM-driven `agent(resume_session_id=...)` path.
///
/// `prompt = None` — return `[system, ...history]` with no trailing user
/// message. This is the inbox-driven wake path: the inbox-drain hook
/// in `inbox_drain.rs` synthesizes the user message from unread inbox
/// rows once the turn loop starts. Letting this function append a
/// hardcoded prompt (e.g. `""` or a sentinel) would either pollute
/// the transcript with junk or duplicate the inbox contents.
pub(crate) fn build_resume_messages(
    resume_id: &str,
    full_system_prompt: &str,
    prompt: Option<&str>,
) -> Result<Vec<Value>, ToolError> {
    let history = tokio::task::block_in_place(|| {
        crate::session::persistence::load_llm_history_for_active_journey(resume_id)
    })
    .map_err(|err| {
        ToolError::ExecutionFailed(format!(
            "Failed to load persisted history for session '{}': {}",
            resume_id, err
        ))
    })?;
    if history.is_empty() {
        return Err(ToolError::ExecutionFailed(format!(
            "No persisted history found for session '{}'",
            resume_id
        )));
    }
    let history = shrink_oversized_resume_history(history, resume_id);
    let mut msgs = Vec::with_capacity(history.len() + 2);
    msgs.push(serde_json::json!({
        "role": "system",
        "content": full_system_prompt,
    }));
    msgs.extend(history);
    if let Some(text) = prompt {
        msgs.push(serde_json::json!({
            "role": "user",
            "content": text,
        }));
    }
    info!(
        "[agent] Resume path: loaded {} messages from session '{}' (prompt_appended={})",
        if prompt.is_some() {
            msgs.len() - 2
        } else {
            msgs.len() - 1
        },
        resume_id,
        prompt.is_some()
    );
    Ok(msgs)
}

fn build_fresh_messages(full_system_prompt: &str, prompt: &str) -> Vec<Value> {
    vec![
        serde_json::json!({
            "role": "system",
            "content": full_system_prompt,
        }),
        serde_json::json!({
            "role": "user",
            "content": prompt,
        }),
    ]
}

/// Token threshold above which a resumed history is compressed before the
/// turn starts. Conservative: below every supported model's context window
/// (smallest hint is 128K), with headroom for the system prompt, tool
/// definitions, and the new turn's output.
const RESUME_HISTORY_TOKEN_BUDGET: usize = 100_000;

/// Guard against the "resume a context-exploded session → instantly explode
/// again" failure mode. A subagent that died with `ContextTooLong` persists
/// its oversized transcript; reloading it verbatim makes resume useless.
/// Force-clear old tool results first (cheap, lossless for narration), then
/// hard-truncate head-preservingly if still over budget.
fn shrink_oversized_resume_history(mut history: Vec<Value>, resume_id: &str) -> Vec<Value> {
    use crate::model_context::{compaction::ContextCompactor, microcompact};

    let tokens = ContextCompactor::estimate_messages_tokens(&history);
    if tokens <= RESUME_HISTORY_TOKEN_BUDGET {
        return history;
    }
    info!(
        "[agent] Resume history for '{}' is ~{} tokens (> {} budget); compacting before resume",
        resume_id, tokens, RESUME_HISTORY_TOKEN_BUDGET
    );
    let mc_config = microcompact::MicrocompactConfig::default();
    microcompact::force_microcompact_messages(&mut history, &mc_config);

    let tokens_after = ContextCompactor::estimate_messages_tokens(&history);
    if tokens_after > RESUME_HISTORY_TOKEN_BUDGET {
        let truncated = ContextCompactor::simple_truncate(&history, RESUME_HISTORY_TOKEN_BUDGET);
        info!(
            "[agent] Resume history for '{}' still ~{} tokens after microcompact; truncated {} -> {} messages",
            resume_id,
            tokens_after,
            history.len(),
            truncated.len()
        );
        return truncated;
    }
    history
}
