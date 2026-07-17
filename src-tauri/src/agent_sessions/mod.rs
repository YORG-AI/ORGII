//! Agent Sessions Domain
//!
//! Session management for AI agents (CLI agents, SDE agent, OS agent).
//!
//! ## Structure
//! - `cli`            — CLI agent session lifecycle (parsers, runner, persistence)
//! - `event_pipeline` — Event ingestion, buffering, filtering, streaming, history, statistics
//! - `session_directory`  — Cross-backend session listing, filtering, and per-row patches
//! - `health`         — Session health checks and stale detection
//!
//! Session-specific SQLite persistence (event cache + token usage) lives
//! in the `session_persistence` workspace crate; consumers should import
//! from there directly. The `KeySource` enum lives in `core_types::key_source`,
//! and builtin session-id prefix constants live in `core_types::session`
//! (with the lookup helpers in `agent_core::core::definitions::prefix_lookup`).

pub mod cli;
pub mod event_pipeline;
pub mod external_cli_adapter;
pub mod session_directory;
