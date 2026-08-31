use serde_json::Value;

use crate::model_context::microcompact;

use super::super::context_accounting::ContextUsageSnapshot;
use super::super::file_tracker;
use super::super::repeat_guard::RepeatGuard;
use super::super::stream_error_recovery::RetryBudgets;
use super::super::types::{TurnConfig, TurnResult};
use super::super::usage_accumulator::UsageTotals;
use super::super::usage_telemetry::UsageTelemetryCollector;

/// Mutable state owned by one `execute_turn` invocation.
///
/// Keeping every retry counter and one-shot flag together makes the loop's
/// transition inputs explicit without changing their lifetime or reset rules.
pub(super) struct TurnLoopState {
    pub(super) iteration: u32,
    pub(super) final_content: Option<String>,
    pub(super) final_is_stream_error: bool,
    pub(super) usage: UsageTotals,
    pub(super) usage_telemetry: UsageTelemetryCollector,
    pub(super) context_usage_snapshot: Option<ContextUsageSnapshot>,
    pub(super) repeat_guard: RepeatGuard,
    pub(super) consecutive_errors: u32,
    pub(super) output_recovery_count: u32,
    pub(super) tier1_escalated: bool,
    pub(super) effective_max_tokens: u32,
    pub(super) retry_budgets: RetryBudgets,
    pub(super) context_rescue_attempts: u32,
    pub(super) max_tokens_lowered: bool,
    pub(super) media_stripped: bool,
    pub(super) stop_hook_blocks: u32,
    pub(super) auto_continuations: u32,
    pub(super) auto_continue_completion_baseline: Option<i64>,
    pub(super) budget_nudge_sent: bool,
    pub(super) pending_budget_nudge: Option<String>,
    pub(super) anti_rush_sent: bool,
    pub(super) iterations_since_todo_use: u32,
    pub(super) iterations_since_todo_reminder: u32,
    pub(super) file_tracker: file_tracker::FileTimeTracker,
    pub(super) microcompact_config: microcompact::MicrocompactConfig,
}

impl TurnLoopState {
    pub(super) fn new(config: &TurnConfig, messages: &[Value]) -> Self {
        let mut file_tracker = file_tracker::FileTimeTracker::new();
        // Read-before-edit is session-scoped: seed the fresh per-turn tracker
        // with every file the transcript already read/wrote so cross-turn edits
        // aren't false-rejected.
        file_tracker.seed_from_history(messages);

        Self {
            iteration: 0,
            final_content: None,
            final_is_stream_error: false,
            usage: UsageTotals::default(),
            usage_telemetry: UsageTelemetryCollector::default(),
            context_usage_snapshot: None,
            repeat_guard: RepeatGuard::default(),
            consecutive_errors: 0,
            output_recovery_count: 0,
            tier1_escalated: false,
            effective_max_tokens: config.max_tokens,
            retry_budgets: RetryBudgets::default(),
            context_rescue_attempts: 0,
            max_tokens_lowered: false,
            media_stripped: false,
            stop_hook_blocks: 0,
            auto_continuations: 0,
            auto_continue_completion_baseline: None,
            budget_nudge_sent: false,
            pending_budget_nudge: None,
            anti_rush_sent: false,
            iterations_since_todo_use: 0,
            iterations_since_todo_reminder: 0,
            file_tracker,
            microcompact_config: microcompact::MicrocompactConfig::default(),
        }
    }
}

/// Coordinator decision produced by one execution phase.
pub(super) enum LoopControl {
    Proceed,
    Continue,
    Break,
}

pub(super) fn finish_turn(
    mut state: TurnLoopState,
    messages: &[Value],
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn super::super::types::TurnEventHandler,
) -> TurnResult {
    let mut hit_max_iterations = false;
    if let Some(max) = config.max_iterations {
        if state.final_content.is_none() && state.iteration >= max {
            hit_max_iterations = true;
            tracing::warn!(
                "[agent-core] Hit max iterations ({}) for session {}",
                max,
                session_id
            );
            state.final_content = Some(format!(
                "I reached the maximum number of iterations ({}) for this turn. \
                 The task may not be fully complete — you can send a follow-up message to continue.",
                max
            ));
        }
    }

    state.usage.finalize();

    // Persist terminal assistant content exactly once. Stream-error notices
    // are user-facing transport errors and must not enter LLM history.
    if let Some(ref text) = state.final_content {
        if !text.is_empty() && !state.final_is_stream_error {
            handler.on_assistant_iteration_complete(
                session_id,
                Some(text.as_str()),
                false,
                &config.model,
            );
        }
    }

    TurnResult {
        content: state.final_content,
        messages: messages.to_vec(),
        is_stream_error: state.final_is_stream_error,
        hit_max_iterations,
        prompt_tokens: state.usage.prompt,
        completion_tokens: state.usage.completion,
        total_tokens: state.usage.total,
        context_tokens: state.usage.last_prompt,
        context_usage_snapshot: state.context_usage_snapshot,
        cache_read_tokens: state.usage.cache_read,
        cache_write_tokens: state.usage.cache_write,
        usage_telemetry: state.usage_telemetry.finish(),
    }
}
