//! Named entry points that adapt callers onto [`send_message_impl`].
//!
//! [`send_message_impl`] takes a wide argument list because it is the single
//! turn-submission path for every source (composer submit, plan-approval
//! re-entry, mobile remote, background wakes). The wrappers here pin the
//! argument combination each non-composer caller needs, so the wake hooks and
//! debug routes cannot drift from the contract by passing the wrong flag.

use crate::foundation::session_bridge::TurnIntentBridgeSource;
use crate::persistence::AgentResponse;
use crate::state::commands::session::identity::IdentityOverrides;
use crate::state::AgentAppState;

use super::send::send_message_impl;

/// Wake-only entry point for the **background-subagent** completion hook.
///
/// Resumes the parent with **empty content** (`is_resume = true`), exactly
/// like the Agent Org inbox auto-resume — so NO new user message is persisted
/// and NO new chat round is created. The parent continues inside the same
/// round it was already in.
///
/// A plain SDE session has no inbox to drain, so unlike the Agent Org path
/// nothing converts to a trailing user message on its own. That would leave
/// the conversation ending on the parent's last *assistant* message
/// ("已在后台启动。"), which providers reject with `HTTP 400: ... conversation
/// must end with a user message`. The unified processor closes that gap: on a
/// resume whose assembled message list still ends with an assistant turn, it
/// appends a **transient** (in-memory only, never persisted) user nudge so the
/// prefill invariant holds — see `inject_subagent_wake_nudge_if_needed` in
/// `turn/processor/mod.rs`. The actual subagent result still arrives via the
/// background-jobs system reminder.
pub async fn send_message_impl_for_subagent_wake(
    state: &AgentAppState,
    session_id: String,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        String::new(),
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        true,
        false,
        None,
        None,
        None,
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Agent Org wake entry point with a stable scheduler idempotency key.
///
/// The scheduler holds this key while the turn is queued or running, so
/// concurrent watchdog, inbox, and task wake sources coalesce into one turn.
pub async fn send_message_impl_for_org_wake(
    state: &AgentAppState,
    session_id: String,
    org_run_id: &str,
    member_id: &str,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        String::new(),
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        true,
        false,
        Some(format!("agent-org-wake:{org_run_id}:{member_id}")),
        None,
        Some(org_run_id.to_string()),
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Debug-only entry point for E2E follow-up turns.
///
/// The production `agent_send_message` Tauri command is `pub` but
/// requires `tauri::State<'_, AgentAppState>` (only constructible
/// inside a Tauri command handler), and `send_message_impl` is
/// `pub(super)`. This thin wrapper exposes the same call shape to
/// debug HTTP endpoints without widening visibility on the prod
/// implementation. Used by `/test/agent-org/follow-up-message` to
/// drive a second turn on an existing org session.
#[cfg(debug_assertions)]
pub async fn send_message_impl_for_test(
    state: &AgentAppState,
    session_id: String,
    content: String,
    model: Option<String>,
    account_id: Option<String>,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        content,
        None,
        IdentityOverrides {
            model,
            account_id,
            workspace_root: None,
            native_harness_type: None,
        },
        None,
        None,
        None,
        false,
        false,
        None,
        None,
        None,
        TurnIntentBridgeSource::UserSubmit,
    )
    .await
}
