//! Debug-only Tauri commands for session introspection.
//!
//! Every command in this module is gated on `#[cfg(debug_assertions)]`.
//! Release builds never compile or expose these endpoints.
//!
//! Submodule per concern:
//! - `general`     — soul content, max_iterations, exec_timeout
//! - `model`       — active model, account, fallback chain
//! - `tools`       — tool selection, resolved allowlist, registry
//! - `security`    — security policy snapshot + command validation
//! - `skills`      — skills config, resolved blacklist, effective listing
//! - `subagent`    — sub-agent allowlist, LLM-visible agent ids
//! - `prompt`      — assembled system prompt + per-section trace
//! - `org_runtime` — Agent Org context, org-only tool registration

pub mod context_cache;
pub mod general;
pub mod model;
pub mod org_runtime;
pub mod prompt;
pub mod security;
pub mod skills;
pub mod subagent;
pub mod tools;

pub use context_cache::*;
pub use general::*;
pub use model::*;
pub use org_runtime::*;
pub use prompt::*;
pub use security::*;
pub use skills::*;
pub use subagent::*;
pub use tools::*;
