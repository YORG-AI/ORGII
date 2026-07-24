//! Tauri commands for the Rust EventStore.
//!
//! The public command paths remain in this facade while implementation,
//! notification, persistence and bounded-replay concerns live in focused
//! submodules.

mod analytics;
mod batch_update;
mod cache_bridge;
pub mod collaboration_snapshot_ingest;
pub(crate) mod event_conversion;
pub mod external_replay;
mod external_replay_cache;
mod external_replay_watcher;
mod extractors;
mod history;
mod ingestion;
mod notify;
mod pagination;
mod push_events;
mod runtime_artifacts;
mod search;
mod session_manager;
mod snapshot;
mod state;
mod state_bounded_replay;
mod store_commands;
mod turn_window;
mod write_retry;

use crate::agent_sessions::event_pipeline::ingestion::prompt_backfill;
use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::SessionEvent;

fn backfill_provider_subagent_prompts(events: &mut [SessionEvent]) {
    prompt_backfill::backfill_subagent_prompts_with_resolver(
        events,
        session_providers::subagent_prompt,
    );
}

pub(crate) fn prepare_loaded_events(
    session_id: &str,
    events: Vec<SessionEvent>,
) -> Vec<SessionEvent> {
    let events = event_conversion::dedup_by_call_id(events);
    let mut events = event_conversion::dedup_stream_transcript_chunk_pairs(events);
    event_conversion::backfill_tool_inputs_from_messages(session_id, &mut events);
    event_conversion::backfill_subagent_links(session_id, &mut events);
    backfill_provider_subagent_prompts(&mut events);
    agent_core::tools::impls::coding::exec::legacy_replay::hydrate_legacy_shell_replays(
        &mut events,
    );
    event_conversion::merge_compact_boundary_events(session_id, &mut events);
    events
}

#[cfg(test)]
#[path = "tests/streaming_snapshot_delta.rs"]
mod streaming_snapshot_delta_tests;

#[cfg(test)]
#[path = "tests/runtime_artifact.rs"]
mod runtime_artifact_tests;

pub use state::EventStoreState;
const BOUNDED_REPLAY_STORE_MAX_BYTES: usize = state_bounded_replay::BOUNDED_REPLAY_STORE_MAX_BYTES;

pub(crate) use notify::schedule_notify;
pub(crate) use write_retry::save_events_retry;
use write_retry::CRITICAL_WRITE_MAX_RETRIES;
pub(super) use write_retry::{persist_events_with_retry, BULK_WRITE_MAX_RETRIES};

use runtime_artifacts::persist_runtime_orgtrack_records_async;
pub(crate) use runtime_artifacts::runtime_artifact_session_record;

pub use push_events::{
    push_events_to_session, update_spawning_tool_args_with_persist,
    update_tool_args_by_call_id_with_persist,
};

// Re-export command macros from every implementation module so existing
// `generate_handler!` paths and wire names remain unchanged.
pub use analytics::*;
pub use batch_update::*;
pub use cache_bridge::*;
pub use event_conversion::*;
pub use extractors::*;
pub use history::*;
pub use ingestion::*;
pub use pagination::*;
pub use search::*;
pub use session_manager::*;
pub use snapshot::*;
pub use store_commands::*;
pub use turn_window::*;
