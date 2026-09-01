//! Provider message-list shaping helpers.
//!
//! Small, side-effect-free transforms applied to the in-memory `messages`
//! vector while `process()` assembles the provider request: the scoped system
//! block, inbox-transcript replay reconciliation, and the transient job-wake
//! nudge that keeps a resumed turn from ending on an assistant message.

use serde_json::Value;
use tracing::info;

use crate::core::session::prompt::cache::{RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY};

use super::UnifiedMessageProcessor;

pub(super) fn scoped_system_message(text: String, scope: RenderedSystemBlockScope) -> Value {
    serde_json::json!({
        "role": "system",
        "content": [{
            "type": "text",
            "text": text,
            (ORGII_SYSTEM_CACHE_SCOPE_KEY): scope.as_str(),
        }],
    })
}

pub(super) fn reconcile_inbox_transcript_replay(
    messages: &mut Vec<Value>,
    message_count_before_inbox: usize,
    transcript_inserted: bool,
) {
    if !transcript_inserted {
        messages.truncate(message_count_before_inbox);
    }
}

impl UnifiedMessageProcessor {
    /// Append a transient, in-memory-only trailing user message when a resumed
    /// turn's assembled message list still ends on an assistant turn.
    ///
    /// Background-job wakes (subagent or backgrounded shell completions)
    /// resume the owner with empty content (so no user row is persisted and
    /// no new round is created), but a plain SDE session has no inbox_drain
    /// to supply the trailing user message that providers require
    /// ("conversation must end with a user message"). This closes that gap
    /// without persisting anything: the nudge lives only in the provider
    /// request, never in the DB or the UI, so the owner continues in the
    /// SAME round with no synthetic bubble.
    ///
    /// No-op unless the last non-system message is an assistant message —
    /// normal resumes (e.g. mode-switch) that already end on a user or tool
    /// message are left untouched.
    pub(super) fn inject_job_wake_nudge_if_needed(messages: &mut Vec<Value>, session_id: &str) {
        let last_non_system_role = messages
            .iter()
            .rev()
            .find_map(|m| m.get("role").and_then(|v| v.as_str()))
            .filter(|role| *role != "system");

        if last_non_system_role != Some("assistant") {
            return;
        }

        const WAKE_NUDGE: &str = "<system-reminder>A background job you launched (shell \
            process or subagent) has finished or needs attention. Its status and output are \
            in the Background Jobs list above. Act on it and continue the task you were \
            doing — do not re-launch finished jobs.</system-reminder>";

        messages.push(serde_json::json!({
            "role": "user",
            "content": WAKE_NUDGE,
        }));

        info!(
            "[unified_processor] Injected transient job-wake nudge to satisfy prefill (session={})",
            session_id
        );
    }
}

#[cfg(test)]
mod message_shaping_tests {
    use super::*;

    #[test]
    fn persisted_unread_inbox_replay_keeps_one_prompt_copy() {
        let durable_transcript = serde_json::json!({
            "role": "user",
            "content": "<agent-org-inbox>durable transcript</agent-org-inbox>",
        });
        let mut messages = vec![durable_transcript.clone()];
        let before_inbox = messages.len();

        // `drain_and_render_deferred` re-renders the still-unread source row,
        // but the stable transcript insert reports that this exact delivery
        // was already persisted during the crashed attempt.
        messages.push(durable_transcript.clone());
        reconcile_inbox_transcript_replay(&mut messages, before_inbox, false);

        assert_eq!(messages, vec![durable_transcript]);
    }
}
