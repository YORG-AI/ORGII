//! `SubagentCompletionWakeHook` trait + process-wide `OnceLock` install slot.
//!
//! # Problem this solves
//!
//! When a parent agent launches a **background** subagent and then ends its
//! own turn (e.g. it asked the user a question and went idle), the subagent
//! finishes minutes later with no active parent turn to surface its result.
//! Until the parent takes another turn, the completed subagent's output sits
//! unread — and the 120s registry grace period can delete it first. The
//! result: the parent never learns the subagent finished and silently does
//! not continue.
//!
//! # How the wake works
//!
//! This mirrors Claude Code's `task-notification` → idle-queue-processor
//! design (`tasks/LocalAgentTask.tsx` enqueues a notification; `useQueueProcessor`
//! auto-starts a turn when the parent loop is idle). ORGII already has the
//! equivalent restart primitive in `send_message_impl_for_subagent_wake(session_id)`
//! (a sibling of the Agent Org `InboxWakeHook`'s `send_message_impl_for_org_wake`).
//! This hook lets the background-subagent completion path reach it without
//! `background.rs` (which lives below the Tauri layer) needing an `AppHandle`.
//!
//! # Single coordinator, two triggers, exactly-once
//!
//! Two triggers can observe a completed background subagent:
//!   1. the completion push from `background.rs` (fires the moment the worker
//!      terminates), and
//!   2. the turn-end re-check in `lifecycle::finalize_session` (fires when the
//!      parent's own turn ends, covering the case where the worker finished
//!      while the parent was still mid-turn).
//!
//! Both call the SAME coordinator (`wake_parent` → `wake_parent_session`),
//! which owns the entire decision. It does not carry per-trigger gates; instead
//! it atomically *claims* the result via
//! `registry::claim_subagent_wake_for_session` (which marks the job
//! `wake_dispatched` in the same locked pass). Whichever trigger claims first
//! delivers it; the other sees nothing. This makes "a result wakes the parent
//! at most once" an invariant of the registry rather than of caller ordering,
//! and removes the earlier ad-hoc retry-storm / empty-wake guards.
//!
//! The production implementation (installed at app boot in `lib.rs`) resolves
//! the parent session's status after claiming: if the parent is idle/terminal
//! it dispatches a resume turn; if it is still running it RELEASES the claim
//! (so the turn-end re-check can re-claim once the parent goes idle), because a
//! running parent will otherwise pick the result up via its current turn's
//! Background Jobs reminder. The status gate is `should_wake_parent`.

use std::sync::{Arc, OnceLock};

/// Hook invoked when a background subagent reaches a terminal state, so the
/// (possibly idle) parent session can be woken to consume the result.
pub trait SubagentCompletionWakeHook: Send + Sync {
    /// Wake `parent_session_id` if it is idle/terminal. Implementations must
    /// be safe to call unconditionally: a parent that is still running, or a
    /// missing/headless app handle, is a silent no-op (the result remains in
    /// the registry for the next turn's reminder).
    fn wake_parent(&self, parent_session_id: &str);
}

/// No-op hook for early boot / headless / unit-test contexts where there is
/// no real session runtime to wake.
pub struct NoopSubagentCompletionWakeHook;

impl SubagentCompletionWakeHook for NoopSubagentCompletionWakeHook {
    fn wake_parent(&self, _parent_session_id: &str) {}
}

/// Process-wide hook installed by the boot path (`lib.rs`). Looked up at
/// subagent-completion time. Idempotent after the first install.
static SUBAGENT_WAKE_HOOK: OnceLock<Arc<dyn SubagentCompletionWakeHook>> = OnceLock::new();

/// Install the production [`SubagentCompletionWakeHook`] at app boot.
/// Idempotent after the first install (subsequent calls are a no-op).
pub fn install_subagent_completion_wake_hook(hook: Arc<dyn SubagentCompletionWakeHook>) {
    let _ = SUBAGENT_WAKE_HOOK.set(hook);
}

/// Resolve the active hook, falling back to the no-op hook if nothing has
/// been installed yet (early boot, headless / unit-test contexts).
pub fn current_subagent_completion_wake_hook() -> Arc<dyn SubagentCompletionWakeHook> {
    SUBAGENT_WAKE_HOOK.get().cloned().unwrap_or_else(|| {
        Arc::new(NoopSubagentCompletionWakeHook) as Arc<dyn SubagentCompletionWakeHook>
    })
}

/// Statuses for which waking the parent is useful. A `Running` parent will
/// pick the completed subagent up via its next turn's Background Jobs
/// reminder, so re-dispatching a turn would be redundant (and `send_message`
/// would reject a second in-flight turn anyway). Mirrors
/// `inbox_wake::should_dispatch_wake`.
fn should_wake_parent(status: crate::core::session::SessionStatus) -> bool {
    use crate::core::session::SessionStatus;
    matches!(
        status,
        SessionStatus::Idle
            | SessionStatus::Completed
            | SessionStatus::Failed
            | SessionStatus::Cancelled
            | SessionStatus::Abandoned
            | SessionStatus::Timeout
    )
}

/// Production [`SubagentCompletionWakeHook`] backed by [`AgentAppState`].
///
/// On `wake_parent`, resolves the parent session's persisted status and, when
/// it is idle/terminal, fires `send_message_impl_for_subagent_wake(parent_session_id)`
/// on a detached Tokio task. The resumed turn opens with the Background Jobs
/// reminder carrying the completed subagent's "unread output" entry, so the
/// parent agent reads the result and continues.
///
/// Safe to call unconditionally: a running parent, a missing app state, or a
/// status lookup failure is logged and swallowed — the subagent result stays
/// in the registry for the next organic turn's reminder.
pub struct AppHandleSubagentCompletionWakeHook {
    app_handle: tauri::AppHandle,
}

impl AppHandleSubagentCompletionWakeHook {
    pub fn new(app_handle: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app_handle })
    }
}

impl SubagentCompletionWakeHook for AppHandleSubagentCompletionWakeHook {
    fn wake_parent(&self, parent_session_id: &str) {
        let parent = parent_session_id.to_string();
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            wake_parent_session(app_handle, parent).await;
        });
    }
}

async fn wake_parent_session(app_handle: tauri::AppHandle, parent_session_id: String) {
    use tauri::Manager;

    // Exactly-once claim: mark any completed-unconsumed subagent result for
    // this parent as wake-dispatched, in one atomic registry pass. If nothing
    // was claimed, another trigger already delivered it (or there is nothing
    // to deliver) — return without dispatching. This is what makes the two
    // wake triggers (completion push + turn-end re-check) collapse to a single
    // coordinator with one shared decision, instead of each carrying its own
    // ad-hoc gate.
    let claimed = tokio::task::spawn_blocking({
        let sid = parent_session_id.clone();
        move || crate::tools::impls::coding::exec::registry::claim_subagent_wake_for_session(&sid)
    })
    .await
    .unwrap_or(false);

    if !claimed {
        return;
    }

    // Resolve the parent's persisted status off the async runtime thread.
    let lookup = {
        let sid = parent_session_id.clone();
        tokio::task::spawn_blocking(move || crate::core::session::persistence::get_session(&sid))
            .await
    };

    let status = match lookup {
        Ok(Ok(Some(record))) => crate::core::session::SessionStatus::parse(&record.status),
        Ok(Ok(None)) => {
            tracing::info!(
                parent_session_id = %parent_session_id,
                "[subagent_wake] parent session not found; skipping wake"
            );
            return;
        }
        Ok(Err(err)) => {
            tracing::warn!(
                parent_session_id = %parent_session_id,
                error = %err,
                "[subagent_wake] parent status lookup failed; skipping wake"
            );
            return;
        }
        Err(join_err) => {
            tracing::warn!(
                parent_session_id = %parent_session_id,
                error = %join_err,
                "[subagent_wake] parent status lookup task panicked; skipping wake"
            );
            return;
        }
    };

    let Some(status) = status else {
        tracing::warn!(
            parent_session_id = %parent_session_id,
            "[subagent_wake] parent has an unrecognized status string; skipping wake"
        );
        return;
    };

    if !should_wake_parent(status) {
        // Parent is still running: it will see the result via its current
        // turn's Background Jobs reminder, OR — if the worker finished after
        // the reminder was already built — via the turn-end re-check, which
        // calls back into this coordinator once the turn goes idle. The claim
        // above is NOT a problem here: a running parent that ends without
        // reading the result re-claims nothing (still unacknowledged) only if
        // we DON'T mark dispatched. So we must release the claim so the
        // turn-end re-check can pick it up.
        tracing::info!(
            parent_session_id = %parent_session_id,
            status = status.as_str(),
            "[subagent_wake] parent still running; releasing claim for turn-end re-check"
        );
        let _ = tokio::task::spawn_blocking({
            let sid = parent_session_id.clone();
            move || {
                crate::tools::impls::coding::exec::registry::release_subagent_wake_for_session(&sid)
            }
        })
        .await;
        return;
    }

    let state = match app_handle.try_state::<crate::state::AgentAppState>() {
        Some(s) => s,
        None => {
            tracing::warn!(
                parent_session_id = %parent_session_id,
                "[subagent_wake] AgentAppState not registered; cannot wake parent"
            );
            return;
        }
    };

    match crate::state::commands::session::message::send_message_impl_for_subagent_wake(
        &state,
        parent_session_id.clone(),
    )
    .await
    {
        Ok(_) => tracing::info!(
            parent_session_id = %parent_session_id,
            "[subagent_wake] queued resume turn for idle parent after subagent completion"
        ),
        Err(err) => tracing::warn!(
            parent_session_id = %parent_session_id,
            error = %err,
            "[subagent_wake] resume turn dispatch failed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::SessionStatus;

    #[test]
    fn wakes_idle_and_terminal_parents() {
        for status in [
            SessionStatus::Idle,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
            SessionStatus::Abandoned,
            SessionStatus::Timeout,
        ] {
            assert!(should_wake_parent(status), "status={}", status.as_str());
        }
    }

    #[test]
    fn does_not_wake_running_or_blocked_parents() {
        for status in [
            SessionStatus::Running,
            SessionStatus::Pending,
            SessionStatus::Paused,
            SessionStatus::WaitingForUser,
            SessionStatus::WaitingForFunds,
            SessionStatus::Archived,
        ] {
            assert!(!should_wake_parent(status), "status={}", status.as_str());
        }
    }
}
