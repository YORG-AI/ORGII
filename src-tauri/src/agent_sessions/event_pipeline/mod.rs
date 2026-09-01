//! Agent Session Event Pipeline
//!
//! High-performance event processing for agent sessions. Handles the full lifecycle
//! from raw chunk ingestion to filtered views for the UI.
//!
//! ## Pipeline Stages
//!
//! ```text
//! Raw Chunks → Ingestion → Store → Derived Views → Streaming
//! ```
//!
//! ## Architecture
//!
//! - `types`   — `SessionEvent`, enums, snapshot structs (shared with frontend via serde)
//! - `ingestion` — Raw chunk → SessionEvent normalization, consolidation, tool call merging
//! - `store`   — Core `EventStore` (Vec + HashMap, O(1) lookup, capped at 8000 events)
//! - `session_manager` — Multi-session LRU cache with pin/unpin for running sessions
//! - `derived` — Visibility filters + `compute_derived()` single-pass
//! - `extractors` — Pre-computed rendering data extraction (file, shell, edit, search, etc.)
//! - `streaming` — Delta accumulation buffer (message, thinking) for real-time events
//! - `commands/` — Tauri commands exposed to the frontend (split by domain)

pub mod agent_core_bridge;
pub mod commands;
pub mod derived;
pub mod extractors;
pub mod ingestion;
pub mod payload_compaction;
pub mod search;
pub mod session_manager;
pub(crate) mod session_providers;
pub mod store;
pub mod streaming;
pub mod types;
