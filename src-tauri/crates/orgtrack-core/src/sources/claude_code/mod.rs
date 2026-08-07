//! Claude Code session data — DB scanner and JSONL history reader.

pub mod db;
pub mod history;

pub const SESSION_PREFIX: &str = "claudecodeapp-";

pub fn canonical_session_id(source_session_id: &str) -> String {
    format!("{SESSION_PREFIX}{source_session_id}")
}
