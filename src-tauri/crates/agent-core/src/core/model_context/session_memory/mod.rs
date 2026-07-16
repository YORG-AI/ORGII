//! Session Memory: incremental LLM-extracted conversation summaries.
//!
//! Session Memory (SM) sits between microcompact (Tier 1) and full LLM
//! compaction (Tier 3) in the context-management hierarchy. After each LLM
//! turn it incrementally extracts a structured markdown summary of the
//! conversation. When compaction is needed, the pre-built summary can replace
//! older messages with **zero additional API calls** — the "SM-compact" path.
//!
//! Reference: `claude_code/services/SessionMemory/sessionMemory.ts`,
//!            `claude_code/services/compact/sessionMemoryCompact.ts`
//!
//! ## Submodules
//! - [`config`]   — [`SessionMemoryConfig`] + [`SessionMemoryCompactConfig`] tunables
//! - [`state`]    — per-session [`SessionMemoryState`]
//! - [`sections`] — section parsing, oversized-section reminders, per-section truncation
//! - [`extract`]  — should-extract heuristic + LLM extraction call (1 side-call per update)
//! - [`compact`]  — zero-API SM-compact path: pick which tail to keep, inject summary

#[cfg(test)]
#[path = "../tests/session_memory_tests.rs"]
mod tests;

pub mod compact;
pub mod config;
pub mod extract;
pub mod sections;
pub mod state;

// Items kept at the `session_memory::` surface — checked one by one
// against real call sites (`session::turn::post_turn`,
// `session::turn::processor`, the test module). The
// `is_compact_boundary_message` helper is reached only through the deeper
// `compact::` segment (sibling + the test module), and the section helpers
// (`analyze_section_sizes`, `generate_section_reminders`,
// `truncate_for_compact`, `SmSection`) live entirely inside the module —
// `extract.rs` calls them via `super::sections::*` and the tests reach for
// `super::super::session_memory::*` directly. So we do not flatten them.

pub use compact::{
    last_turn_has_tool_calls, parse_compact_boundary_content, try_sm_compact,
    ParsedCompactBoundary,
};
pub use config::{SessionMemoryCompactConfig, SessionMemoryConfig};
pub use extract::{extract_session_memory, should_extract};
pub use state::SessionMemoryState;
