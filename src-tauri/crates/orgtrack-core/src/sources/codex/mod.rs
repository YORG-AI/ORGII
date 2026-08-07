//! Codex app session data — JSONL history reader.

pub mod app;

pub const SESSION_PREFIX: &str = "codexapp-";

pub fn canonical_session_id(source_session_id: &str) -> String {
    format!("{SESSION_PREFIX}{source_session_id}")
}
