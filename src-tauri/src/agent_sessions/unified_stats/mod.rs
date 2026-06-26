//! Unified session statistics across all agent backends.
//!
//! Merges CLI agent, SDE agent, and OS agent sessions into a single
//! row shape with shared filtering, sorting, pagination, and statistics.
//!
//! Health checks live in `crate::agent_sessions::health`.
//!
//! # Submodules
//!
//! - `types`      — Record, filter, response, and stats types
//! - `status`     — Status classification (active / failed / completed)
//! - `display`    — Display label generation and text search
//! - `conversion` — Backend record → unified record conversion
//! - `aggregation`— Core merge + filter + sort + paginate logic
//! - `stats`      — Aggregate statistics (tokens, cost estimation)
//! - `history`    — History-page–specific record shape and metrics
//! - `commands`   — Tauri command handlers

pub mod accounting;
pub mod aggregation;
pub mod commands;
pub mod conversion;
pub mod display;
pub mod history;
pub mod orgtrack_adapter;
pub mod patch;
pub mod stats;
pub mod status;
pub mod types;
pub mod usage;

#[cfg(test)]
mod tests;
