//! GitHub Copilot CLI session data — per-session `events.jsonl` reader.
//!
//! Copilot CLI (1.x) writes one `~/.copilot/session-state/<uuid>/` directory
//! per session: `events.jsonl` is the full event stream (messages, tool
//! calls, lifecycle), `workspace.yaml` the metadata sidecar. A sibling
//! `~/.copilot/session-store.db` (SQLite) carries repository/branch and
//! per-request token usage; it is enrichment only — the reader degrades
//! gracefully when the db is locked or absent.

pub mod history;

pub const SESSION_PREFIX: &str = "copilotapp-";

pub fn canonical_session_id(source_session_id: &str) -> String {
    format!("{SESSION_PREFIX}{source_session_id}")
}
