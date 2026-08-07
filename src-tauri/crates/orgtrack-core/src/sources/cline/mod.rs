//! Cline CLI imported history reader.
//!
//! The standalone Cline CLI stores each session under
//! `~/.cline/data/sessions/<id>/`:
//!   - `<id>.json`           — session metadata (title, provider, model, cwd, …)
//!   - `<id>.messages.json`  — the verbatim transcript, an Anthropic-style
//!     `messages` array of `{role, content:[{type:text|tool_use|tool_result}], ts}`
//!
//! A sibling `~/.cline/data/db/sessions.db` holds the same rows as a registry,
//! but the per-session JSON files carry everything we need and avoid contending
//! with Cline's live SQLite handle, so we read those directly.
pub mod history;
