//! SQLite persistence for tool calls/results, child status updates, and
//! cache hydration of the child session's in-memory event store.

use super::UnifiedSubagentHandler;
use crate::bus::event_pipeline_bridge;
use tracing::warn;

impl UnifiedSubagentHandler {
    /// Persist a tool call to the database.
    pub(super) fn persist_tool_call(&self, tool_call_id: &str, tool_name: &str, args: &str) {
        if let Err(err) = crate::session::persistence::save_tool_call_msg(
            &self.config.subagent_session_id,
            tool_call_id,
            tool_name,
            args,
        ) {
            warn!(
                "[subagent:{}] Failed to persist tool call: {}",
                self.config.subagent_type, err
            );
        }
    }

    /// Persist a tool result to the database.
    pub(super) fn persist_tool_result(&self, tool_call_id: &str, tool_name: &str, result: &str) {
        if let Err(err) = crate::session::persistence::save_tool_result_msg(
            &self.config.subagent_session_id,
            tool_call_id,
            tool_name,
            result,
        ) {
            warn!(
                "[subagent:{}] Failed to persist tool result: {}",
                self.config.subagent_type, err
            );
        }
    }

    /// Update the child session's status in `agent_sessions`.
    pub(super) fn update_child_session_status(&self, status: crate::session::SessionStatus) {
        if let Err(err) =
            crate::session::persistence::update_status(&self.config.subagent_session_id, status)
        {
            warn!(
                "[subagent:{}] Failed to update child session status to '{}': {}",
                self.config.subagent_type,
                status.as_str(),
                err
            );
        }
    }

    /// Persist the child session's in-memory events to SQLite so they survive
    /// LRU eviction and can be loaded when the user expands the SubagentBlock.
    pub(super) fn persist_child_session_to_cache(&self) {
        let Some(ref handle) = self.app_handle else {
            return;
        };
        let events =
            event_pipeline_bridge::read_session_events(handle, &self.config.subagent_session_id);

        if events.is_empty() {
            return;
        }

        let sid = self.config.subagent_session_id.clone();
        let persistable: Vec<_> = events
            .into_iter()
            .filter(|e| {
                !e.id.starts_with("stream-msg-ts-") && !e.id.starts_with("stream-think-ts-")
            })
            .collect();

        let count = persistable.len();
        if let Err(error) =
            event_pipeline_bridge::persist_events("subagent-child-persist", &sid, &persistable, 5)
        {
            tracing::warn!(
                session_id = %sid,
                error = %error,
                "failed to persist subagent child events"
            );
        }
        tracing::info!(
            "[subagent:{}] Persisted {} child events for session {}",
            self.config.subagent_type,
            count,
            sid
        );
    }
}
