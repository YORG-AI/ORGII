use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tracing::info;

use super::super::continuation::should_inject_todo_reminder;
use super::super::tool_execution::is_cancelled;
use super::super::types::{TurnConfig, TurnEventHandler};
use super::loop_state::{LoopControl, TurnLoopState};

/// Apply all start-of-iteration gates and inject pending user/system input in
/// the same order as the monolithic loop.
pub(super) async fn prepare_iteration_input(
    state: &mut TurnLoopState,
    messages: &mut Vec<Value>,
    config: &TurnConfig,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> LoopControl {
    if let Some(max) = config.max_iterations {
        if state.iteration >= max {
            return LoopControl::Break;
        }
    }
    if is_cancelled(cancel_flag) {
        info!("[agent-core] Cancelled by user (session={})", session_id);
        if config.persist_cancel_marker {
            crate::core::session::persistence::mark_turn_cancelled(session_id);
        }
        state.final_content = None;
        return LoopControl::Break;
    }
    state.iteration += 1;
    if let Some(hook) = config.iteration_hook.as_deref() {
        hook.before_llm_iteration(session_id, state.iteration, messages)
            .await;
    }

    // Mid-turn steering arrives before every other reminder so user intent
    // can redirect the next provider call immediately.
    drain_steering_queue(&config.steering_queue, session_id, messages, handler).await;

    // Deferred context-budget nudge from the previous iteration.
    if let Some(nudge) = state.pending_budget_nudge.take() {
        messages.push(serde_json::json!({
            "role": "user",
            "content": nudge,
        }));
    }

    // Changed-files injector: tell the model when files it read this turn
    // were modified externally instead of letting the next edit fail the
    // stale-content guard.
    let externally_changed = state.file_tracker.drain_externally_changed();
    if !externally_changed.is_empty() {
        info!(
            "[agent-core] {} externally changed file(s) detected mid-turn (session={})",
            externally_changed.len(),
            session_id
        );
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!(
                "<system-reminder>\nThe following file(s) were modified externally (by the user or another process) since you read them:\n{}\nRe-read any of these files before editing them — your remembered content is stale. Treat the external changes as intentional: take them into account and do NOT revert them unless the user asks you to.\n</system-reminder>",
                externally_changed
                    .iter()
                    .map(|path| format!("- {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        }));
    }

    // Mid-turn background-job updates are skipped on the first iteration;
    // the turn-start reminder owns turn-boundary delivery.
    if state.iteration > 1
        && crate::tools::impls::coding::exec::registry::claim_completion_wake_for_session(
            session_id,
        )
    {
        use crate::core::session::turn::background_reminder;
        let jobs: Vec<_> =
            crate::tools::impls::coding::exec::registry::list_jobs_for_reminder(session_id)
                .into_iter()
                .filter(|job| job.has_unread_output || job.stalled_waiting_input)
                .collect();
        if !jobs.is_empty() {
            info!(
                "[agent-core] mid-turn background-job note injected ({} job(s), session={})",
                jobs.len(),
                session_id
            );
            let note = background_reminder::build_completion_notification(&jobs);
            crate::tools::impls::coding::exec::registry::acknowledge_outputs(
                &background_reminder::inlined_result_handles(&jobs),
            );
            messages.push(serde_json::json!({
                "role": "user",
                "content": note,
            }));
        }
    }

    // Stale-todo reminder uses the same injection point so it never lands
    // between an assistant tool_use and its tool_result rows.
    state.iterations_since_todo_use = state.iterations_since_todo_use.saturating_add(1);
    state.iterations_since_todo_reminder = state.iterations_since_todo_reminder.saturating_add(1);
    if should_inject_todo_reminder(
        state.iterations_since_todo_use,
        state.iterations_since_todo_reminder,
    ) {
        // Throttle even when the list is empty/completed; rechecking every
        // following iteration buys nothing.
        state.iterations_since_todo_reminder = 0;
        let todos = tokio::task::block_in_place(|| {
            crate::persistence::db_helpers::todos::get_todos(session_id).unwrap_or_default()
        });
        let has_open_todos = todos
            .iter()
            .any(|todo| todo.status != "completed" && todo.status != "cancelled");
        if has_open_todos {
            info!(
                "[agent-core] stale-todo reminder injected mid-turn ({} iterations since last manage_todo, session={})",
                state.iterations_since_todo_use, session_id
            );
            messages.push(serde_json::json!({
                "role": "user",
                "content": crate::tools::impls::coding::manage_todo::stale_todo_reminder(&todos),
            }));
        }
    }

    let limit_display = config
        .max_iterations
        .map_or("∞".to_string(), |max| max.to_string());
    info!(
        "[agent-core] iteration {}/{} (session={})",
        state.iteration, limit_display, session_id
    );

    LoopControl::Proceed
}

/// Drain the mid-turn steering buffer into one reminder-wrapped user message.
/// Returns `true` when anything was injected.
pub(super) async fn drain_steering_queue(
    steering_queue: &Option<crate::turn_executor::SteeringQueue>,
    session_id: &str,
    messages: &mut Vec<Value>,
    handler: &dyn TurnEventHandler,
) -> bool {
    let Some(queue) = steering_queue else {
        return false;
    };
    let drained: Vec<crate::turn_executor::SteeringInjection> = {
        let mut guard = queue.lock().await;
        std::mem::take(&mut *guard)
    };
    if drained.is_empty() {
        return false;
    }

    info!(
        "[agent-core] Injecting {} steering message(s) mid-turn (session={})",
        drained.len(),
        session_id
    );
    let mut bodies = Vec::with_capacity(drained.len());
    for injection in &drained {
        handler.on_steering_consumed(session_id, injection);
        bodies.push(injection.content.clone());
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": format!(
            "<system-reminder>\nThe user sent the following message(s) while you were working. Adjust course accordingly — this may change or refine the current task:\n\n{}\n\nIMPORTANT: After completing your current step, you MUST address the user's message(s) above. Do not ignore them.\n</system-reminder>",
            bodies.join("\n\n---\n\n")
        ),
    }));
    true
}
