//! Mode-switch manager — blocks the `suggest_mode_switch` tool until
//! the user confirms (switch) or dismisses (skip) in the frontend.
//!
//! Uses the shared [`super::finalize`] primitives so:
//!   * Stop interrupts a pending wait via the session cancel flag.
//!   * The UI flips out of "awaiting mode switch" at the moment the user
//!     clicks, without waiting for the tool's `execute()` to return.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use tracing::{info, warn};

use super::finalize::{finalize_interaction_event, FinalizedStatus};
use crate::session::AgentExecMode;

/// User's mode-switch decision.
#[derive(Debug, Clone)]
pub enum ModeSwitchChoice {
    /// User accepted the switch. Carries the target mode string (e.g. "plan").
    Switch(String),
    /// User chose to stay in the current mode.
    Skip,
}

impl ModeSwitchChoice {
    /// Wire format strings used by the frontend Tauri commands.
    pub const SWITCH_STR: &'static str = "switch";
    pub const SKIP_STR: &'static str = "skip";

    /// Parse from the wire string sent by the frontend.
    ///
    /// Falls back to `AgentExecMode::Plan` when the FE sends a switch
    /// without an explicit `target_mode` — historically the only suggester
    /// is the in-Build "switch to Plan?" prompt.
    pub fn from_wire(value: &str, target_mode: Option<String>) -> Option<Self> {
        match value {
            Self::SWITCH_STR => Some(Self::Switch(
                target_mode.unwrap_or_else(|| AgentExecMode::Plan.as_str().to_string()),
            )),
            Self::SKIP_STR => Some(Self::Skip),
            _ => None,
        }
    }
}

/// Pending-request bookkeeping so `respond` / `cancel` can emit a structured
/// finalized event with the right correlation ids.
struct PendingModeSwitch {
    sender: oneshot::Sender<ModeSwitchChoice>,
    session_id: String,
    tool_call_id: Option<String>,
    target_mode: String,
}

pub struct ModeSwitchManager {
    pending: Arc<Mutex<Option<PendingModeSwitch>>>,
    /// Session cancel flag — shared with `AgentSession::cancel_flag`.
    /// Optional in the default constructor (kept for call sites that don't
    /// own a session); use [`Self::with_cancel_flag`] to wire the Stop button.
    cancel_flag: Arc<AtomicBool>,
}

impl ModeSwitchManager {
    pub fn new() -> Self {
        Self::with_cancel_flag(Arc::new(AtomicBool::new(false)))
    }

    pub fn with_cancel_flag(cancel_flag: Arc<AtomicBool>) -> Self {
        Self {
            pending: Arc::new(Mutex::new(None)),
            cancel_flag,
        }
    }

    /// Expose the cancel flag so the tool's `execute()` can wait on it.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel_flag)
    }

    /// Broadcast the mode-switch request and return a receiver.
    ///
    /// If there is already a pending request (agent called suggest_mode_switch
    /// twice in one turn), the previous entry is finalized as cancelled before
    /// the new one takes its place. Without this the first tool_call event
    /// would stay in `awaiting_user` forever — `agent:interaction_finalized`
    /// is never broadcast for it and the UI card remains stuck.
    pub async fn ask(
        &self,
        session_id: &str,
        target_mode: &str,
        reason: &str,
        tool_call_id: Option<&str>,
    ) -> oneshot::Receiver<ModeSwitchChoice> {
        let (sender, receiver) = oneshot::channel();

        // Finalize any pre-existing pending request before overwriting it.
        if let Some(prev) = self.pending.lock().await.take() {
            warn!(
                "[mode_switch] Overwriting existing pending request (session={}). \
                 Finalizing previous as cancelled.",
                prev.session_id
            );
            finalize_interaction_event(
                &prev.session_id,
                prev.tool_call_id.as_deref(),
                crate::tools::names::SUGGEST_MODE_SWITCH,
                FinalizedStatus::Cancelled,
                "Superseded by a new suggest_mode_switch call in the same turn.",
                serde_json::json!({ "choice": "skip", "targetMode": prev.target_mode }),
            );
            // Drop sender so the tool's wait unblocks with Dropped outcome.
            drop(prev.sender);
        }

        *self.pending.lock().await = Some(PendingModeSwitch {
            sender,
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.map(str::to_string),
            target_mode: target_mode.to_string(),
        });

        let payload = serde_json::json!({
            "sessionId": session_id,
            "targetMode": target_mode,
            "reason": reason,
            "toolCallId": tool_call_id,
        });

        crate::bus::broadcast_event("agent:mode_switch_request", payload);

        info!(
            "[mode_switch] Waiting for user decision (session={}, target={})",
            session_id, target_mode
        );

        receiver
    }

    /// Resolve the pending request with the user's choice.
    ///
    /// Emits `agent:interaction_finalized` so the UI flips immediately.
    pub async fn respond(&self, choice: ModeSwitchChoice) {
        let Some(entry) = self.pending.lock().await.take() else {
            warn!("[mode_switch] No pending mode-switch request");
            return;
        };

        let (status, content, choice_label) = match &choice {
            ModeSwitchChoice::Switch(mode) => (
                FinalizedStatus::Answered,
                format!("User accepted the mode switch to {mode}."),
                "switch",
            ),
            ModeSwitchChoice::Skip => (
                FinalizedStatus::Answered,
                "User chose to stay in the current mode.".to_string(),
                "skip",
            ),
        };

        finalize_interaction_event(
            &entry.session_id,
            entry.tool_call_id.as_deref(),
            crate::tools::names::SUGGEST_MODE_SWITCH,
            status,
            &content,
            serde_json::json!({
                "choice": choice_label,
                "targetMode": entry.target_mode,
            }),
        );

        info!("[mode_switch] User chose: {:?}", choice);
        if entry.sender.send(choice).is_err() {
            warn!("[mode_switch] Pending request was dropped before response arrived");
        }
    }

    /// Check if there is a pending mode-switch request waiting for a response.
    pub async fn is_pending(&self) -> bool {
        self.pending.lock().await.is_some()
    }

    /// Auto-resolve a pending request after the user-visible timeout elapses.
    ///
    /// By default mode switching follows timeout-as-continue semantics: if the
    /// user does not respond, continue in the current mode. Presence policy can
    /// opt into treating the same timeout as accepting the suggested Plan mode.
    pub async fn auto_resolve_after_timeout(&self, choice: &ModeSwitchChoice) {
        let Some(entry) = self.pending.lock().await.take() else {
            return;
        };

        let (content, choice_label) = match choice {
            ModeSwitchChoice::Switch(mode) => (
                format!("Mode-switch suggestion timed out; auto-switching to {mode} mode."),
                "switch",
            ),
            ModeSwitchChoice::Skip => (
                "Mode-switch suggestion timed out; continuing in the current mode.".to_string(),
                "skip",
            ),
        };

        finalize_interaction_event(
            &entry.session_id,
            entry.tool_call_id.as_deref(),
            crate::tools::names::SUGGEST_MODE_SWITCH,
            FinalizedStatus::Answered,
            &content,
            serde_json::json!({
                "choice": choice_label,
                "targetMode": entry.target_mode,
                "auto": "timeout",
            }),
        );

        drop(entry.sender);
    }

    /// Backward-compatible helper for callers/tests that expect timeout-as-skip.
    pub async fn auto_skip_after_timeout(&self) {
        self.auto_resolve_after_timeout(&ModeSwitchChoice::Skip)
            .await;
    }

    /// Cancel any pending request (Stop button / timeout). Finalizes the event
    /// and drops the sender so the tool's wait unblocks.
    pub async fn cancel_pending(&self, status: FinalizedStatus) {
        let Some(entry) = self.pending.lock().await.take() else {
            return;
        };

        let content = match status {
            FinalizedStatus::Cancelled => "User stopped the session before deciding.",
            FinalizedStatus::TimedOut => "Mode-switch suggestion timed out.",
            FinalizedStatus::Answered | FinalizedStatus::Rejected => {
                warn!(
                    "[mode_switch] cancel called with unexpected status {:?}",
                    status
                );
                "Mode-switch suggestion terminated."
            }
        };

        finalize_interaction_event(
            &entry.session_id,
            entry.tool_call_id.as_deref(),
            crate::tools::names::SUGGEST_MODE_SWITCH,
            status,
            content,
            serde_json::json!({
                "choice": "skip",
                "targetMode": entry.target_mode,
            }),
        );

        drop(entry.sender);
    }
}

#[cfg(test)]
mod tests {
    use super::ModeSwitchManager;

    #[tokio::test]
    async fn auto_skip_after_timeout_clears_pending_request() {
        let manager = ModeSwitchManager::new();
        let receiver = manager
            .ask(
                "session-mode-timeout",
                "plan",
                "Large change should be planned first.",
                Some("tool-call-mode-timeout"),
            )
            .await;
        assert!(manager.is_pending().await);

        manager.auto_skip_after_timeout().await;

        assert!(!manager.is_pending().await);
        assert!(receiver.await.is_err());
    }
}

impl Default for ModeSwitchManager {
    fn default() -> Self {
        Self::new()
    }
}
