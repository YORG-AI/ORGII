//! Cross-backend session directory.
//!
//! Merges CLI agent, SDE agent, OS agent, and imported external-history
//! sessions into a single row shape with shared filtering, sorting, and
//! pagination, and routes per-row field patches (`session_patch`).
//!
//! # Submodules
//!
//! - `types`           — Record, filter, and response types
//! - `status`          — Status classification (active / failed / completed)
//! - `display`         — Display label generation and text search
//! - `conversion`      — Backend record → directory record conversion
//! - `aggregation`     — Core merge + filter + sort + paginate logic
//! - `orgtrack_adapter`— Write-path mirror of session rows into orgtrack
//! - `patch`           — Per-session field mutations
//! - `commands`        — Tauri command handlers

pub mod aggregation;
pub mod commands;
pub mod conversion;
pub mod display;
pub mod orgtrack_adapter;
pub mod patch;
pub mod status;
pub mod types;

#[cfg(test)]
mod tests;
