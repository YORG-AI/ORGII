//! Bridges live-status hook events onto TUI-hosted managed sessions.
//!
//! A `runner = 'tui'` session has no managed child process: the CLI runs
//! interactively inside an app terminal pane with `ORGII_SESSION_ID` in its
//! environment. Lifecycle hooks echo that id back
//! (`AgentStatusEventV1.orgii_session_id`), and this bridge is what turns
//! those events into durable session state:
//!
//! - **Identity**: the first event binds the CLI's native session id to
//!   `code_sessions.cli_session_id` (via the same `update_cli_session_id`
//!   path the headless runner uses, so the native-transcript ledger and
//!   imported-twin dedup fire identically).
//! - **Status**: hook states map onto the runner vocabulary
//!   (`working`→Running, `waiting`→Running with the waiting refinement left
//!   to the live-status overlay, `done`→Idle, `failed`→Failed).
//!
//! Headless (`runner = 'local'`) sessions are ignored here — their runner
//! owns both concerns.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use key_vault::key_store::ModelType;
use orgtrack_core::status_adapter::{AgentLiveState, AgentStatusEventV1};

use super::native_transcript::native_transcript_binding;
use super::persistence;
use super::types::{SessionRunner, SessionStatus};

/// Per-orgii-session memo of what we last applied, so tool-event spam does
/// not turn into a DB round-trip per hook. Entries are small and bounded by
/// the number of TUI sessions in one app run.
#[derive(Default, Clone, PartialEq, Eq)]
struct AppliedState {
    native_id: Option<String>,
    status: Option<SessionStatus>,
}

fn applied() -> &'static Mutex<HashMap<String, AppliedState>> {
    static APPLIED: OnceLock<Mutex<HashMap<String, AppliedState>>> = OnceLock::new();
    APPLIED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn status_for_state(state: AgentLiveState) -> SessionStatus {
    match state {
        AgentLiveState::Working => SessionStatus::Running,
        // The code_sessions vocabulary has no waiting state; the live-status
        // overlay renders `waiting_for_user`, the row just stays non-idle.
        AgentLiveState::Waiting => SessionStatus::Running,
        // A TUI session outlives each turn: Stop means "turn ended, still
        // open", which is exactly the Agent-Org Idle semantics.
        AgentLiveState::Done => SessionStatus::Idle,
        AgentLiveState::Failed => SessionStatus::Failed,
    }
}

/// Native id for binding: prefer stripping the canonical prefix (matches the
/// imported-history key exactly, including sources like Codex whose native
/// id is a transcript stem rather than the raw hook session id).
fn native_id_for_binding(event: &AgentStatusEventV1, agent: Option<&ModelType>) -> String {
    if let Some(binding) = agent.and_then(native_transcript_binding) {
        if let Some(stripped) = event.session_id.strip_prefix(binding.imported_prefix) {
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    event.source_session_id.clone()
}

/// Apply one live-status event to its TUI session, if any. Cheap no-op for
/// events without an `ORGII_SESSION_ID` attribution or with nothing new.
pub fn on_live_status_event(event: &AgentStatusEventV1) {
    let Some(orgii_session_id) = event
        .orgii_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return;
    };

    let event = event.clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_event(&orgii_session_id, &event);
    });
}

fn apply_event(orgii_session_id: &str, event: &AgentStatusEventV1) {
    let session = match persistence::get_session(orgii_session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return,
        Err(err) => {
            tracing::debug!(error = %err, "[TuiBridge] Session lookup failed");
            return;
        }
    };
    if SessionRunner::parse(&session.runner) != Some(SessionRunner::Tui) {
        return;
    }

    let agent = session.cli_agent_type.as_deref().and_then(ModelType::from_str);
    let native_id = native_id_for_binding(event, agent.as_ref());
    let next_status = status_for_state(event.state);

    // Memo gate: skip the write path when nothing changed.
    {
        let mut memo = applied().lock().unwrap_or_else(|p| p.into_inner());
        let entry = memo.entry(orgii_session_id.to_string()).or_default();
        let next = AppliedState {
            native_id: Some(native_id.clone()),
            status: Some(next_status),
        };
        if *entry == next {
            return;
        }
        *entry = next;
    }

    if session.cli_session_id.as_deref() != Some(native_id.as_str()) {
        // Same binding path as the headless runner: feeds the
        // native-transcript ledger and flips the imported twin unlistable.
        if let Err(err) = persistence::update_cli_session_id(orgii_session_id, &native_id) {
            tracing::warn!(error = %err, "[TuiBridge] Failed to bind cli_session_id");
        }
    }

    let current_status = session.status;
    if current_status != next_status {
        // A terminal Failed row must not be resurrected by a late Stop event,
        // but a fresh Working turn legitimately reopens an Idle session.
        let resurrecting_failed = matches!(
            current_status,
            SessionStatus::Failed | SessionStatus::Cancelled
        ) && next_status != SessionStatus::Running;
        if !resurrecting_failed {
            if let Err(err) = persistence::update_status(orgii_session_id, next_status) {
                tracing::warn!(error = %err, "[TuiBridge] Failed to update session status");
            }
        }
    }
}

/// Release a TUI session when its hosting terminal goes away (PTY exit or
/// tab close): a non-terminal row parks at Idle so the sidebar stops showing
/// activity, while preserving resumability from the chat view.
pub fn release_tui_session(session_id: &str) -> Result<bool, String> {
    let session = persistence::get_session(session_id)
        .map_err(|err| format!("DB error: {err}"))?
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    if SessionRunner::parse(&session.runner) != Some(SessionRunner::Tui) {
        return Ok(false);
    }
    if session.status.is_terminal() {
        return Ok(false);
    }
    {
        let mut memo = applied().lock().unwrap_or_else(|p| p.into_inner());
        memo.remove(session_id);
    }
    persistence::update_status(session_id, SessionStatus::Idle)
        .map_err(|err| format!("Failed to park TUI session: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_states_map_to_runner_vocabulary() {
        assert_eq!(
            status_for_state(AgentLiveState::Working),
            SessionStatus::Running
        );
        assert_eq!(
            status_for_state(AgentLiveState::Waiting),
            SessionStatus::Running
        );
        assert_eq!(status_for_state(AgentLiveState::Done), SessionStatus::Idle);
        assert_eq!(
            status_for_state(AgentLiveState::Failed),
            SessionStatus::Failed
        );
    }

    #[test]
    fn native_id_prefers_canonical_prefix_strip() {
        let event = AgentStatusEventV1 {
            schema_version: orgtrack_core::status_adapter::AGENT_STATUS_SCHEMA_VERSION,
            source: "claude_code".to_string(),
            source_session_id: "raw-id".to_string(),
            session_id: "claudecodeapp-raw-id".to_string(),
            state: AgentLiveState::Working,
            event_name: "PreToolUse".to_string(),
            tool_name: None,
            tool_input_preview: None,
            interactive_prompt: None,
            is_interrupt: false,
            cwd: None,
            orgii_session_id: Some("cli-1".to_string()),
            occurred_at: "2026-07-17T10:00:00.000Z".to_string(),
        };
        assert_eq!(
            native_id_for_binding(&event, Some(&ModelType::ClaudeCode)),
            "raw-id"
        );
        // Unknown agent → raw hook session id.
        assert_eq!(native_id_for_binding(&event, None), "raw-id");
    }
}
