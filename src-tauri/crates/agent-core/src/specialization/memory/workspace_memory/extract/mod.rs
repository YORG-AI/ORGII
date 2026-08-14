//! Extract Memories — background post-turn hook that runs a forked agent to
//! extract durable workspace memories from the conversation transcript.
//!
//! # Internal layout
//!
//! - **`state`** — `ExtractMemoriesState` struct + read-only
//!   `ExtractMemoriesStateSnapshot` for debug/E2E endpoints. The mutable
//!   fields are `pub(super)` so only the gating helpers and the runner can
//!   mutate them.
//! - **`gating`** — `should_extract`, `skip_if_main_agent_wrote_memory`,
//!   `record_turn`, plus the cursor / memory-write inspection helpers.
//! - **`runner`** — `run_extraction` (the forked-agent invocation),
//!   prompt building, and the allow-list tool policy.
//!
//! `NoopEventHandler` lives here at the directory-module root because it is
//! shared with `auto_dream`, which imports it as
//! `super::extract::NoopEventHandler`.

mod gating;
mod runner;
mod state;

pub use gating::{record_turn, should_extract, skip_if_main_agent_wrote_memory};
pub use runner::run_extraction;
pub use state::ExtractMemoriesState;

/// Minimal event handler that discards all events.
/// Used for background forked agents (extract_memories, auto_dream) where
/// we don't need to stream events to the frontend.
pub(crate) struct NoopEventHandler;

impl crate::turn_executor::TurnEventHandler for NoopEventHandler {
    fn on_message_delta(&self, _session_id: &str, _content: &str) {}
    fn on_tool_call(
        &self,
        _session_id: &str,
        _tool_call_id: &str,
        _tool_name: &str,
        _display_name: &str,
        _args: &serde_json::Value,
    ) {
    }
    fn on_tool_result(
        &self,
        _session_id: &str,
        _tool_call_id: &str,
        _tool_name: &str,
        _display_name: &str,
        _result: &str,
    ) {
    }
}
