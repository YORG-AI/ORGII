//! Session messaging logic (`agent_send_message` implementation).
//!
//! This module owns the one path that turns an inbound message into a
//! scheduled turn. The `agent_send_message` Tauri command in the parent
//! `session` module is a thin wrapper over it, and every other turn source
//! (background wakes, plan-approval re-entry, debug routes) reaches the same
//! implementation through a named entry point. The pieces:
//!
//! - [`send`] — [`send_message_impl`], the single turn-submission path:
//!   identity resolution, lazy runtime init, identity/user-input persistence,
//!   mid-turn steering divert, and the scheduler closure that runs the turn.
//! - [`entry_points`] — the wake/debug wrappers that pin the argument
//!   combination each non-composer caller needs.
//! - [`exec_mode`] — wire-value exec-mode resolution and the Plan-mode
//!   pre-mode bookkeeping.
//! - [`org_wake`] — durable Agent Org wake claiming and control-row mode
//!   resolution, both re-read at the moment the turn actually starts.
//!
//! The stable surface is re-exported at this module root so every caller
//! continues to resolve items at their historical
//! `…::session::message::<name>` path.

mod entry_points;
mod exec_mode;
mod org_wake;
pub(crate) mod project_bootstrap;
mod send;

/// Kept under its historical module name so the `resolve_agent_mode` invariant
/// probe in `app::api::agent::test::workspace` still cites a live test path.
#[cfg(test)]
#[path = "tests.rs"]
mod resolve_agent_mode_tests;

pub use entry_points::*;
pub use exec_mode::*;
// `send_message_impl` is `pub(crate)`, so the re-export matches its visibility
// rather than widening the module root's public surface.
pub(crate) use send::*;
