//! `JobCompletionWakeHook` trait + process-wide `OnceLock` install slot.
//!
//! # Problem this solves
//!
//! When a session launches a **background** job — a subagent worker or a
//! backgrounded shell process — and its own turn ends before the job does,
//! the job finishes with no active turn to surface its result. Until the
//! owner takes another turn, the completed job's output sits unread — and
//! the registry grace period can delete it first. The result: the owner
//! never learns the job finished and silently does not continue. For shells
//! this used to be a hard protocol gap: the model's only alternative was to
//! poll `await_output` every 30s, which the turn executor's repeat guard
//! could misread as an infinite loop.
//!
//! # How the wake works
//!
//! This mirrors Claude Code's `task-notification` → idle-queue-processor
//! design (`tasks/LocalAgentTask.tsx` enqueues a notification; `useQueueProcessor`
//! auto-starts a turn when the parent loop is idle). ORGII already has the
//! equivalent restart primitive in `send_message_impl_for_job_wake(session_id)`
//! (a sibling of the Agent Org `InboxWakeHook`'s `send_message_impl_for_org_wake`).
//! This hook lets the job completion paths reach it without `background.rs` /
//! `subprocess.rs` (which live below the Tauri layer) needing an `AppHandle`.
//!
//! # Single coordinator, two triggers, exactly-once
//!
//! Two triggers can observe a completed background job:
//!   1. the completion push from the job's own monitor task (`background.rs`
//!      for subagents, `subprocess.rs` for shells — fires the moment the job
//!      terminates), and
//!   2. the turn-end re-check in `lifecycle::finalize_session` (fires when the
//!      owner's own turn ends, covering the case where the job finished
//!      while the owner was still mid-turn).
//!
//! Both call the SAME coordinator (`wake_owner` → `wake_owner_session`),
//! which owns the entire decision. It does not carry per-trigger gates; instead
//! it atomically *claims* the result via
//! `registry::claim_completion_wake_for_session` (which marks the job
//! `wake_dispatched` in the same locked pass). Whichever trigger claims first
//! delivers it; the other sees nothing. This makes "a result wakes the owner
//! at most once" an invariant of the registry rather than of caller ordering,
//! and removes the earlier ad-hoc retry-storm / empty-wake guards.
//!
//! The production implementation (installed at app boot in `lib.rs`) resolves
//! the owner session's status after claiming: if the owner is idle/terminal
//! it dispatches a resume turn; if it is still running it RELEASES the claim
//! (so the turn-end re-check can re-claim once the owner goes idle), because a
//! running owner will otherwise pick the result up via its current turn's
//! Background Jobs reminder. The status gate is `should_wake_owner`.

use std::sync::{Arc, OnceLock};

/// Hook invoked when a background job (subagent or backgrounded shell)
/// reaches a terminal state, so the (possibly idle) owning session can be
/// woken to consume the result.
pub trait JobCompletionWakeHook: Send + Sync {
    /// Wake `owner_session_id` if it is idle/terminal. Implementations must
    /// be safe to call unconditionally: an owner that is still running, or a
    /// missing/headless app handle, is a silent no-op (the result remains in
    /// the registry for the next turn's reminder).
    fn wake_owner(&self, owner_session_id: &str);
}

/// No-op hook for early boot / headless / unit-test contexts where there is
/// no real session runtime to wake.
pub struct NoopJobCompletionWakeHook;

impl JobCompletionWakeHook for NoopJobCompletionWakeHook {
    fn wake_owner(&self, _owner_session_id: &str) {}
}

/// Process-wide hook installed by the boot path (`lib.rs`). Looked up at
/// job-completion time. Idempotent after the first install.
static JOB_WAKE_HOOK: OnceLock<Arc<dyn JobCompletionWakeHook>> = OnceLock::new();

/// Install the production [`JobCompletionWakeHook`] at app boot.
/// Idempotent after the first install (subsequent calls are a no-op).
pub fn install_job_completion_wake_hook(hook: Arc<dyn JobCompletionWakeHook>) {
    let _ = JOB_WAKE_HOOK.set(hook);
}

/// Resolve the active hook, falling back to the no-op hook if nothing has
/// been installed yet (early boot, headless / unit-test contexts).
pub fn current_job_completion_wake_hook() -> Arc<dyn JobCompletionWakeHook> {
    JOB_WAKE_HOOK
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopJobCompletionWakeHook) as Arc<dyn JobCompletionWakeHook>)
}

/// Statuses for which waking the owner is useful. A `Running` owner will
/// pick the completed job up via its next turn's Background Jobs
/// reminder, so re-dispatching a turn would be redundant (and `send_message`
/// would reject a second in-flight turn anyway). Mirrors
/// `inbox_wake::should_dispatch_wake`.
fn should_wake_owner(status: crate::core::session::SessionStatus) -> bool {
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

/// Production [`JobCompletionWakeHook`] backed by [`AgentAppState`].
///
/// On `wake_owner`, resolves the owner session's persisted status and, when
/// it is idle/terminal, fires `send_message_impl_for_job_wake(owner_session_id)`
/// on a detached Tokio task. The resumed turn opens with the Background Jobs
/// reminder carrying the completed job's "unread output" entry, so the
/// owner agent reads the result and continues.
///
/// Safe to call unconditionally: a running owner, a missing app state, or a
/// status lookup failure is logged and swallowed — the job result stays
/// in the registry for the next organic turn's reminder.
pub struct AppHandleJobCompletionWakeHook {
    app_handle: tauri::AppHandle,
}

impl AppHandleJobCompletionWakeHook {
    pub fn new(app_handle: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app_handle })
    }
}

impl JobCompletionWakeHook for AppHandleJobCompletionWakeHook {
    fn wake_owner(&self, owner_session_id: &str) {
        let owner = owner_session_id.to_string();
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            wake_owner_session(app_handle, owner).await;
        });
    }
}

async fn wake_owner_session(app_handle: tauri::AppHandle, owner_session_id: String) {
    use tauri::Manager;

    // Exactly-once claim: mark any completed-unconsumed job result for
    // this owner as wake-dispatched, in one atomic registry pass. If nothing
    // was claimed, another trigger already delivered it (or there is nothing
    // to deliver) — return without dispatching. This is what makes the two
    // wake triggers (completion push + turn-end re-check) collapse to a single
    // coordinator with one shared decision, instead of each carrying its own
    // ad-hoc gate.
    let claimed = tokio::task::spawn_blocking({
        let sid = owner_session_id.clone();
        move || crate::tools::impls::coding::exec::registry::claim_completion_wake_for_session(&sid)
    })
    .await
    .unwrap_or(false);

    if !claimed {
        return;
    }

    // Resolve the owner's persisted status off the async runtime thread.
    let lookup = {
        let sid = owner_session_id.clone();
        tokio::task::spawn_blocking(move || crate::core::session::persistence::get_session(&sid))
            .await
    };

    let status = match lookup {
        Ok(Ok(Some(record))) => crate::core::session::SessionStatus::parse(&record.status),
        Ok(Ok(None)) => {
            tracing::info!(
                owner_session_id = %owner_session_id,
                "[job_wake] owner session not found; skipping wake"
            );
            return;
        }
        Ok(Err(err)) => {
            tracing::warn!(
                owner_session_id = %owner_session_id,
                error = %err,
                "[job_wake] owner status lookup failed; skipping wake"
            );
            return;
        }
        Err(join_err) => {
            tracing::warn!(
                owner_session_id = %owner_session_id,
                error = %join_err,
                "[job_wake] owner status lookup task panicked; skipping wake"
            );
            return;
        }
    };

    let Some(status) = status else {
        tracing::warn!(
            owner_session_id = %owner_session_id,
            "[job_wake] owner has an unrecognized status string; skipping wake"
        );
        return;
    };

    if !should_wake_owner(status) {
        // Owner is still running: it will see the result via its current
        // turn's Background Jobs reminder, OR — if the job finished after
        // the reminder was already built — via the turn-end re-check, which
        // calls back into this coordinator once the turn goes idle. The claim
        // above is NOT a problem here: a running owner that ends without
        // reading the result re-claims nothing (still unacknowledged) only if
        // we DON'T mark dispatched. So we must release the claim so the
        // turn-end re-check can pick it up.
        tracing::info!(
            owner_session_id = %owner_session_id,
            status = status.as_str(),
            "[job_wake] owner still running; releasing claim for turn-end re-check"
        );
        let _ = tokio::task::spawn_blocking({
            let sid = owner_session_id.clone();
            move || {
                crate::tools::impls::coding::exec::registry::release_completion_wake_for_session(
                    &sid,
                )
            }
        })
        .await;
        return;
    }

    let state = match app_handle.try_state::<crate::state::AgentAppState>() {
        Some(s) => s,
        None => {
            tracing::warn!(
                owner_session_id = %owner_session_id,
                "[job_wake] AgentAppState not registered; cannot wake owner"
            );
            return;
        }
    };

    match crate::state::commands::session::message::send_message_impl_for_job_wake(
        &state,
        owner_session_id.clone(),
    )
    .await
    {
        Ok(_) => tracing::info!(
            owner_session_id = %owner_session_id,
            "[job_wake] queued resume turn for idle owner after job completion"
        ),
        Err(err) => tracing::warn!(
            owner_session_id = %owner_session_id,
            error = %err,
            "[job_wake] resume turn dispatch failed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::SessionStatus;

    #[test]
    fn wakes_idle_and_terminal_owners() {
        for status in [
            SessionStatus::Idle,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
            SessionStatus::Abandoned,
            SessionStatus::Timeout,
        ] {
            assert!(should_wake_owner(status), "status={}", status.as_str());
        }
    }

    #[test]
    fn does_not_wake_running_or_blocked_owners() {
        for status in [
            SessionStatus::Running,
            SessionStatus::Pending,
            SessionStatus::Paused,
            SessionStatus::WaitingForUser,
            SessionStatus::WaitingForFunds,
            SessionStatus::Archived,
        ] {
            assert!(!should_wake_owner(status), "status={}", status.as_str());
        }
    }
}
