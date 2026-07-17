//! Cursor CLI (cursor-agent) session data — per-session SQLite store reader.
//!
//! This is a DIFFERENT store than the Cursor IDE reader (`sources/cursor_ide`)
//! parses: the `cursor-agent` CLI writes one `store.db` per session under
//! `~/.cursor/chats/`, while the IDE keeps everything in `state.vscdb`.

pub mod history;

pub const SESSION_PREFIX: &str = "cursorcliapp-";

pub fn canonical_session_id(source_session_id: &str) -> String {
    format!("{SESSION_PREFIX}{source_session_id}")
}
