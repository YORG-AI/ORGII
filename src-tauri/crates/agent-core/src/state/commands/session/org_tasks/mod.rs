//! Agent Org session Tauri commands, DTOs, and supporting helpers.
//!
//! This module is the frontend-facing surface for a running Agent Org: it turns
//! a session id into a live operational view of the run and exposes the commands
//! that let the user steer it. The implementation is split into command families
//! that each own their DTOs, commands, and projection/persistence helpers:
//!
//! - [`context`] — shared session → run-context / member-id resolution used by
//!   every command family.
//! - [`run_view`] — the frequently-polled Run View assembly and its view DTOs.
//! - [`group_chat`] — Group Chat history paging and message send/persist.
//! - [`plan_approval`] — user plan-approval detail and decision handling.
//! - [`intervention`] — direct member intervention state and one-to-one
//!   messaging (including return-to-work).
//! - [`lifecycle`] — pause/resume/cancel and the resume progress-wake machinery.
//!
//! The stable command + DTO surface is re-exported at this module root so
//! registration and external callers continue to resolve every item at its
//! historical `…::session::org_tasks::<name>` path.

mod context;
mod group_chat;
mod intervention;
mod lifecycle;
mod plan_approval;
mod run_view;

#[cfg(test)]
mod tests;

pub use group_chat::*;
pub use intervention::*;
pub use lifecycle::*;
pub use plan_approval::*;
pub use run_view::*;
