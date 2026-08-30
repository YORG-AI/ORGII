//! Debug-only test endpoints for the `/agent/test/*` route tree.
//!
//! Split by theme so each file stays under the per-file budget and
//! owns one cohesive slice of the E2E surface. Public handlers live
//! in `api::agent::public`; everything here is **never** compiled into
//! release builds — the parent module gates `mod test` itself with
//! `#[cfg(debug_assertions)]`, so no inner gating is needed here.

pub mod agent_org;
pub mod agent_org_formal_convergence;
pub mod agent_org_user_directed;
pub mod cli;
pub mod core;
pub mod desktop;
pub mod file_history;
pub mod gateway;
pub mod housekeeping;
pub mod learning;
pub mod lsp;
pub mod mcp;
pub mod sde;
pub mod sync;
pub mod sync_oauth;
pub mod workspace;
