//! Bounded Kimi CLI / Kimi Code history and usage importer.
//!
//! The two products share a public source id but not an on-disk protocol:
//!
//! - `~/.kimi/sessions/<group>/<session>/wire.jsonl` stores legacy
//!   `StatusUpdate.payload.token_usage` records.
//! - `<Kimi Code home>/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`
//!   stores incremental `usage.record` records.
//!
//! Discovery is demand-driven. It follows neither symlinks nor ambient paths
//! outside the current external-history identity, and metadata parsing resumes
//! from the shared fixed-size append seam.

mod config;
mod discovery;
mod identity;
mod meta_state;
mod parse;
mod paths;
mod replay;
mod replay_code;
mod sync;
mod wire;

pub use identity::{KimiRecentPath, KIMI_SESSION_PREFIX};
pub use paths::kimi_history_candidate_paths;
pub use replay::load_kimi_history_for_session;
pub use sync::{list_kimi_history_sessions_paginated, list_kimi_recent_paths};

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
