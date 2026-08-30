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

/// Wake-only entry point for the **background-job** completion hook
/// (subagent workers and backgrounded shell processes).
///
/// Resumes the owner with **empty content** (`is_resume = true`), exactly
/// like the Agent Org inbox auto-resume — so NO new user message is persisted
/// and NO new chat round is created. The owner continues inside the same
/// round it was already in.
///
/// A plain SDE session has no inbox to drain, so unlike the Agent Org path
/// nothing converts to a trailing user message on its own. That would leave
/// the conversation ending on the owner's last *assistant* message
/// ("已在后台启动。"), which providers reject with `HTTP 400: ... conversation
/// must end with a user message`. The unified processor closes that gap: on a
/// resume whose assembled message list still ends with an assistant turn, it
/// appends a **transient** (in-memory only, never persisted) user nudge so the
/// prefill invariant holds — see `inject_job_wake_nudge_if_needed` in
/// `turn/processor/mod.rs`. The actual job result still arrives via the
/// background-jobs system reminder.
pub async fn send_message_impl_for_job_wake(
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
        None,
        false,
        None,
        None,
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
        None,
        false,
        Some(format!("agent-org-wake:{org_run_id}:{member_id}")),
        None,
        Some(org_run_id.to_string()),
        Some(member_id.to_string()),
        Some(org_run_id.to_string()),
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Re-enqueue one already-admitted DirectMember Turn after restart. The
/// original EventStore source, Turn id, and client id are reused; admission
/// returns the existing receipt and never mints a second user fact.
pub(crate) async fn send_message_impl_for_direct_recovery(
    state: &AgentAppState,
    work: crate::coordination::agent_member_interventions::RecoverableUserDirectedWork,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        work.session_id,
        work.dispatch_content,
        Some(work.display_content),
        IdentityOverrides::default(),
        None,
        work.images,
        None,
        false,
        Some(work.source_event_id),
        true,
        work.client_message_id,
        Some(work.turn_intent_id),
        None,
        None,
        Some(work.org_run_id),
        TurnIntentBridgeSource::UserSubmit,
    )
    .await
}

pub(crate) async fn send_message_impl_for_user_directed_wake(
    state: &AgentAppState,
    wake: crate::tools::impls::orchestration::org_send_message::UserDirectedWake,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        wake.recipient_session_id,
        wake.content,
        Some(wake.display_text),
        IdentityOverrides::default(),
        None,
        wake.images,
        None,
        false,
        None,
        false,
        Some(wake.turn_intent_id.clone()),
        Some(wake.turn_intent_id),
        None,
        None,
        Some(wake.org_run_id),
        TurnIntentBridgeSource::AgentOrg,
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
        None,
        false,
        None,
        None,
        None,
        None,
        None,
        TurnIntentBridgeSource::UserSubmit,
    )
    .await
}
