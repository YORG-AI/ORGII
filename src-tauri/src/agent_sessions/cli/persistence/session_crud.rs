//! CRUD for the `code_sessions` table, split by write responsibility.
//!
//! This file is a facade: the implementations live in the sibling
//! `session_crud/` submodules and every path callers used before the split
//! still resolves through the re-exports below.

mod create;
mod delete;
mod field_updates;
mod lifecycle;
mod read;
mod resume_state;
mod shared;
mod transcript_source;

pub use create::create_session;
pub use delete::delete_session;
pub use field_updates::{
    link_bootstrap_work_item, update_agent_exec_mode, update_draft_text, update_mode_axes,
    update_model_and_account, update_name, update_pinned, update_product_mode,
    update_proxy_credentials, update_reply_target_event_id,
};
pub use lifecycle::{
    accept_cli_resume_turn, accept_cli_turn, clear_pid, sweep_stale_sessions,
    update_cli_turn_lifecycle, update_pid, update_status, update_status_with_error,
};
pub use read::{
    get_session, list_sessions, list_sessions_page, list_unpinned_root_sessions_page,
    status_snapshots,
};
pub use resume_state::{
    clear_cli_resume_state, get_cli_session_id_for_account, get_history_mutation,
    update_cli_session_id, update_cli_session_id_for_account,
};
pub use transcript_source::{
    latest_native_transcript_id, native_transcript_ids_newest_first, session_persists_chunks,
};

pub(super) use resume_state::clear_cli_resume_state_with_tx;
pub(super) use shared::now_iso;
