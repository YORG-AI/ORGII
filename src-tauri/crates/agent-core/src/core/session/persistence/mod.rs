//! Unified Session Persistence Layer
//!
//! This module provides a unified persistence API for all agent sessions
//! (OS, SDE, Custom).
//!
//! ## Design Decisions
//!
//! - Uses the `agent_sessions` table with unified schema
//! - `session_type` column distinguishes OS/SDE/Custom
//! - `channel` column for OS sessions
//! - Message storage uses `agent_messages` (shared)

mod crud;
pub(crate) mod linked_work_item;
mod messages;
mod sidebar;

// Re-exports kept at the `session::persistence::` surface — these are
// the items that real call sites actually name through the
// `session_persistence::*` / `unified_persistence::*` aliases. The
// schema-init helper `ensure_unified_schema` is consumed only by the
// `init()` entry point in this file, so it stays module-private. The
// `PersistedSessionMemoryState` DTO is the return type of
// `load_session_memory_state` but no caller names it directly, so it
// doesn't need to be re-exported either.
pub use crud::{
    backfill_agent_definition_id, clear_worktree_metadata, delete_session,
    finalize_terminal_turn_status, get_child_sessions, get_parent_session, get_session,
    link_bootstrap_work_item, list_sessions, load_workspace, mark_stale_running_sessions_abandoned,
    reconcile_sessions_with_terminal_turn_markers, register_session_delete_mirror_hook,
    register_session_mirror_hook, save_workspace, save_worktree_metadata, session_type,
    update_account_id, update_agent_exec_mode, update_draft_text, update_mode_axes, update_model,
    update_model_and_account, update_name, update_org_member_id, update_pinned,
    update_product_mode, update_reply_target_event_id, update_status, update_work_item_link,
    update_worktree_merge_status, upsert_session, UnifiedSessionRecord,
};
pub(crate) use crud::{
    delete_session_with_connection, finish_session_delete, prepare_session_delete,
};
pub use sidebar::{
    list_agent_org_root_sessions_page, list_standalone_coding_sessions_page,
    list_unpinned_sessions_by_type_page,
};

pub use messages::{
    anchor_at_or_after_created_at, append_compact_boundary, clear_messages,
    clear_session_memory_state, compact_cutoff_sequence,
    load_agent_org_inbox_transcript_materializations, load_llm_history,
    load_llm_history_start_sequences, load_llm_history_text_only,
    load_llm_history_text_only_bounded, load_messages, load_session_memory_state,
    mark_turn_cancelled, materialize_agent_org_inbox_transcript, message_anchor,
    message_created_at, save_assistant_msg, save_compact_summary_msg, save_session_memory_state,
    save_snapshot, save_subagent_transcript, save_tool_call_msg, save_tool_result_msg,
    save_user_msg, save_user_msg_with_id, seed_session_with_messages, take_turn_cancelled,
    truncate_messages_from_sequence, update_compact_boundary_token_delta,
    AgentOrgInboxTranscriptMaterialization, MessageAnchor,
};

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize the unified persistence layer.
///
/// Call this at startup (from `SCHEMA_INIT.call_once()`) to ensure schema
/// is ready. Accepts a `&Connection` to avoid deadlock.
pub fn init(conn: &Connection) -> SqliteResult<()> {
    crud::ensure_unified_schema(conn)?;
    Ok(())
}
