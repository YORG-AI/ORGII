//! Session CRUD operations — create, read, update, delete, list.
//!
//! Split into per-concern submodules so the file no longer mixes
//! schema migration, DTO definitions, query helpers, and workspace
//! round-trip logic in a single 700-line dump:
//!
//! - [`migration`] — idempotent column / index migrations
//! - [`record`]    — `UnifiedSessionRecord` DTO + `session_type` constants
//!   plus the shared `SELECT` column list and row mapper
//! - [`ops`]       — upsert / list / status / model / parent / delete
//! - [`workspace`] — `SessionWorkspace` <-> JSON column round-trip
//!
//! The public re-exports here keep the original API surface (`crud::*`)
//! intact for the parent `persistence` module.

#[cfg(test)]
mod ops_tests;

mod migration;
mod ops;
mod record;
mod workspace;

pub use migration::ensure_unified_schema;
pub use ops::{
    backfill_agent_definition_id, delete_session, finalize_terminal_turn_status,
    get_child_sessions, get_parent_session, get_session, list_sessions,
    mark_stale_running_sessions_abandoned, reconcile_sessions_with_terminal_turn_markers,
    register_session_delete_mirror_hook, register_session_mirror_hook, update_account_id, update_agent_exec_mode, update_draft_text,
    update_model, update_model_and_account, update_name, update_org_member_id, update_pinned,
    update_reply_target_event_id, update_status, update_work_item_link, upsert_session,
};
pub use record::{session_type, UnifiedSessionRecord};
pub use workspace::{
    clear_worktree_metadata, load_workspace, save_workspace, save_worktree_metadata,
    update_worktree_merge_status,
};
