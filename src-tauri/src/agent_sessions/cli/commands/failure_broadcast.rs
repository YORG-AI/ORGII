//! Shared terminal-failure broadcast for asynchronous CLI runner failures.
//!
//! `cli_agent_run` / `cli_agent_message` and `cli_agent_resume` both return to
//! the frontend *before* the background runner finishes, so a `run_session`
//! error after the command returned is the only signal the frontend gets: there
//! is no command error to reject on. Without a `code_session.status_changed`
//! broadcast the panel stays stuck in its optimistic `running` state and the
//! failure notification never fires.
//!
//! Both paths therefore go through [`broadcast_async_run_failure`] so the
//! payload — including the `background` / `session_name` fields the
//! notification policy needs to label and route the alert — stays identical.

use super::super::persistence;

/// Session fields the failure payload carries for notification routing.
pub(super) struct AsyncFailureSession {
    pub background: bool,
    pub name: String,
}

/// Build the `code_session.status_changed` failure payload.
///
/// Split out from the broadcast so create/resume payload parity is testable
/// without a database or an active websocket.
pub(super) fn async_failure_payload(
    session_id: &str,
    error_message: &str,
    turn_intent_id: Option<&str>,
    session: Option<AsyncFailureSession>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": "failed",
        "error_message": error_message,
        "background": session.as_ref().is_some_and(|session| session.background),
        "session_name": session.as_ref().map(|session| session.name.clone()),
    });
    if let Some(turn_intent_id) = turn_intent_id {
        payload["turn_intent_id"] = serde_json::Value::String(turn_intent_id.to_string());
    }
    payload
}

/// Broadcast the terminal failure for a runner that failed after its command
/// already returned. Best-effort: a missing session row still broadcasts, so the
/// frontend leaves its optimistic running state either way.
pub(super) async fn broadcast_async_run_failure(
    session_id: &str,
    error_message: &str,
    turn_intent_id: Option<&str>,
) {
    let lookup_id = session_id.to_string();
    let session =
        match tokio::task::spawn_blocking(move || persistence::get_session(&lookup_id)).await {
            Ok(Ok(session)) => session.map(|session| AsyncFailureSession {
                background: session.background,
                name: session.name,
            }),
            Ok(Err(error)) => {
                tracing::warn!(
                    "[CodeSession] Failed to reload notification context for {}: {}",
                    session_id,
                    error
                );
                None
            }
            Err(error) => {
                tracing::warn!(
                    "[CodeSession] Notification context task failed for {}: {}",
                    session_id,
                    error
                );
                None
            }
        };

    crate::api::websocket_handler::broadcast(
        async_failure_payload(session_id, error_message, turn_intent_id, session).to_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> AsyncFailureSession {
        AsyncFailureSession {
            background: true,
            name: "Nightly refactor".to_string(),
        }
    }

    #[test]
    fn create_and_resume_failures_share_one_payload_shape() {
        // The create path carries a turn intent; resume has none. Everything the
        // frontend lifecycle + notification policy reads must otherwise match,
        // or one path leaves the session stuck in `running` (issue in PR #540).
        let created = async_failure_payload("sess-1", "boom", Some("intent-1"), Some(session()));
        let resumed = async_failure_payload("sess-1", "boom", None, Some(session()));

        for key in [
            "type",
            "session_id",
            "status",
            "error_message",
            "background",
            "session_name",
        ] {
            assert_eq!(created[key], resumed[key], "payload key `{key}` diverged");
        }
        assert_eq!(created["type"], "code_session.status_changed");
        assert_eq!(created["status"], "failed");
        assert_eq!(created["background"], true);
        assert_eq!(created["session_name"], "Nightly refactor");
        assert_eq!(created["turn_intent_id"], "intent-1");
        assert!(resumed.get("turn_intent_id").is_none());
    }

    #[test]
    fn missing_session_row_still_yields_a_terminal_payload() {
        let payload = async_failure_payload("sess-2", "boom", None, None);

        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["session_id"], "sess-2");
        assert_eq!(payload["error_message"], "boom");
        assert_eq!(payload["background"], false);
        assert!(payload["session_name"].is_null());
    }
}
