//! Shared type definitions used across the application's backend crates.
//!
//! This crate sits at the bottom of the workspace dependency graph: every
//! other crate (and the binary `app` crate) may depend on it, but it never
//! depends on any of them. The point is to give cycle-causing shared types
//! a neutral home so domain crates can stop importing from each other.
//!
//! ## Rules for what belongs here
//!
//! - Pure data types (structs, enums, type aliases) used by 2+ domain crates
//! - Newtype wrappers for primitive identifiers (e.g. `SessionId`)
//! - Error types whose variants are referenced by multiple modules
//!
//! ## Rules for what does NOT belong here
//!
//! - Functions with side effects (file I/O, network, spawning processes)
//! - Anything that imports `tauri`, `tokio` runtime utilities, `reqwest`,
//!   or any other behavior crate
//! - Database query builders or schema initialization
//! - Single-domain types (those stay inside the owning crate)
//!
//! When extending this crate, keep its `[dependencies]` minimal and
//! prefer `serde`-derive-style annotations over impl blocks where possible.

pub mod activity;
pub mod agent_org;
pub mod cli_alias;
pub mod extracted;
pub mod jsonrpc;
pub mod key_source;
pub mod providers;
pub mod proxy_env;
pub mod session;
pub mod session_event;
pub mod tool_names;
pub mod ui_metadata;
pub mod workflow;
pub mod worktree;
