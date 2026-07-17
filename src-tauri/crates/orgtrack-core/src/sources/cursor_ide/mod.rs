//! Cursor IDE session data — DB scanner, bubble history reader, and support modules.

pub const CURSORIDE_SESSION_PREFIX: &str = "cursoride-";

pub fn canonical_session_id(source_session_id: &str) -> String {
    format!("{CURSORIDE_SESSION_PREFIX}{source_session_id}")
}

pub mod db;
pub mod disk_reads;
pub mod history;

mod helpers;
mod io;
mod models;
mod summaries;
