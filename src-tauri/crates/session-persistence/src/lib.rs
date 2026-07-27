//! Session-specific SQLite persistence (event cache, file
//! changes, token usage) on top of the shared `database::db` connection.
//!
//! ## Surface
//! - `agent_core_bridge::register()` — install concrete impls into
//!   `agent_core::foundation::{db_bridge, session_bridge}` so memory,
//!   consolidation, reflection, and token-usage paths can persist state
//!   without taking a back-edge on this crate.
//! - `commands::*` — ~23 `#[tauri::command]`s, re-registered from
//!   `app::commands::handler_list.inc` via the bare `session_persistence::…`
//!   path.
//!
//! ## Database location
//! `~/.orgii/sessions.db` (managed by `database::db`). Event search runs
//! LIKE scans over `events` (the FTS5 index was dropped — see
//! `schema::drop_events_fts`); sequence numbers gate edit / truncate flows.
//!
//! ## Layering
//! Pure host adapter — no back-edges into `app`. Provider-neutral provenance
//! projection lives in `orgtrack_core`; this crate only materializes that
//! projection in ORG2's local session cache.

pub mod agent_core_bridge;
pub mod commands;
mod connection;
mod crud;
mod editing;
pub(crate) mod schema;
mod sequence;
pub mod token_usage;
pub mod tool_usage;
mod turn_index;
mod turn_index_debounce;
pub mod turn_intents;
mod turn_window;
mod types;

pub use orgtrack_core::projectors::turn_metadata::{TurnModifiedFile, TurnResourceInteraction};
pub use turn_index::{
    ensure_turn_index_fresh, load_turn_index, load_turn_summaries, rebuild_turn_index,
    CachedTurnSummary,
};
pub use turn_window::{
    load_initial_turn_window, load_turn_body_window, CachedInitialTurnWindow, CachedTurnBodyWindow,
};
pub use types::{
    CacheStats, CachedEvent, CachedSession, CrossSessionSearchHit, SearchResult, SessionMetadata,
    TruncateResult,
};

// Re-export connection for legacy callers in this crate; new code should
// use `database::db::get_connection` directly.
pub use connection::get_connection;

// Re-export schema init for `database::db` boot-time table setup.
pub use schema::init_session_tables;

pub use crud::{
    clear_old_sessions, delete_session, finalize_deferred_event_import,
    find_awaiting_user_events_by_function, get_all_sessions, get_cache_stats, get_event,
    get_session_metadata, load_events, load_session, save_events, save_events_deferred,
    save_session, search_all_sessions, search_events, update_session_specs,
};
pub use editing::{clear_session_history, delete_event, truncate_after_event, update_event};

// Tauri commands — registered in `app::commands::handler_list.inc` as
// `session_persistence::cache_*` (formerly `session::cache::cache_*`).
pub use commands::{
    cache_clear_old_sessions, cache_clear_session_history, cache_delete_event,
    cache_delete_session, cache_get_all_sessions, cache_get_event, cache_get_session_diff,
    cache_get_session_metadata, cache_get_stats, cache_load_events, cache_load_session,
    cache_load_turn_index, cache_save_events, cache_save_session, cache_search_all_sessions,
    cache_search_events, cache_truncate_after_event, cache_update_event,
    cache_update_session_specs, get_session_llm_usage_spans, get_session_token_usage_records,
    get_session_tool_usage_attributions, get_session_tool_usage_attributions_for_call,
};

/// Tests in several modules temporarily redirect the process-wide
/// `ORGII_HOME`. One crate-wide lock is required: module-local locks still let
/// those tests race and point unrelated connections at each other's databases.
#[cfg(test)]
pub(crate) static ORGII_HOME_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
