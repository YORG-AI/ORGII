//! Core aggregation logic for combining sessions from multiple backends.
//!
//! This module provides the main `list_all_sessions` function that loads sessions
//! from CLI, Coding, and OS Agent backends and applies filters, sorting, and
//! pagination. It is a pure read: orgtrack mirroring happens on the session
//! write paths (see `orgtrack_adapter`), never during listing.
//!
//! # Submodules
//!
//! - `external_history` — Per-provider imported-history page loaders + registry
//! - `imported_history` — Imported rows for the merge path + live-status decoration
//! - `native_page`      — SQL-paginated fast paths (per-category and flat directory)
//! - `merge`            — Full merge across every backend
//! - `filtering`        — `SessionFilter` predicates
//! - `sorting`          — Row ordering
//! - `pagination`       — Offset/limit slicing
//! - `agent_org`        — Agent Org root-row decoration
//! - `native_sidebar`   — Cursor-paginated native sidebar streams

mod agent_org;
mod external_history;
mod filtering;
mod imported_history;
mod merge;
mod native_page;
mod native_sidebar;
mod pagination;
mod sorting;
#[cfg(test)]
mod test_support;

pub use external_history::resync_external_history_source;
pub use merge::list_all_sessions;
pub use native_sidebar::{list_native_sidebar_sessions, NATIVE_SIDEBAR_PAGE_MAX_LIMIT};
