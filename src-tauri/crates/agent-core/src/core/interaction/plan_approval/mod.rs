//! Plan-approval manager — tracks the session's currently pending plan and
//! exposes it to the frontend for the inline "Build" button on the plan card.
//!
//! This is intentionally NOT a blocking interaction:
//!
//!   * `create_plan` writes the plan file, records a pending snapshot via
//!     `mark_ready`, and broadcasts `agent:plan_ready_for_approval`. The
//!     tool result carries a sentinel prefix so the agent turn
//!     hard-terminates immediately; the session returns to idle.
//!   * The FE shows explicit plan-card actions. Build approves the pending
//!     snapshot and re-enters Build mode through `agent_plan_approval_response`;
//!     Skip rejects the snapshot and returns the session to idle without
//!     starting another turn. Both paths broadcast `agent:exit_plan_mode` so
//!     the FE UI syncs instantly.
//!   * If the LLM produces a new plan before the user acts, the old pending
//!     entry is archived (the FE grays out the prior Build/Skip buttons).
//!   * Session cancel simply drops the pending entry silently — no error or
//!     skipped-plan lifecycle card is emitted.
//!
//! The plan flow is non-blocking: the LLM keeps streaming after
//! emitting the plan, and the user clicks Build at their own pace.
//! Restart-persistence is provided by the `persistence` sub-module
//! below.
//!
//! The pending snapshot is mirrored into `pending_plan_approvals` in the
//! shared SQLite DB so that restarting the app rehydrates the Build button
//! on the plan card. Every mutation point (`mark_ready`, `take_pending`,
//! `clear_silently`) performs its DB write inside the same `pending` mutex
//! guard that gates the in-memory mutation, so memory and DB cannot split.

pub mod persistence;

mod events;
mod gc;
mod manager;
mod repair;
mod resolution;
mod snapshot;
mod watcher;

pub use gc::{gc_orphaned_pending_plans, load_snapshot_for_session};
pub use manager::PlanApprovalManager;
pub use repair::{pending_revision_ids, repair_orphaned_create_plan_submissions};
pub use resolution::{resolve_pending, PlanResolution};
pub use snapshot::{auto_approve_deadline_for_snapshot, PendingPlanApproval};

/// Process-wide AppHandle for event pushes that happen outside a live
/// per-session `PlanApprovalManager` (CLI bridge resolutions, startup GC,
/// chokepoint abandons). Set once at app boot; `resolve_pending` falls back
/// to it when the manager has no handle of its own.
static GLOBAL_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Install the process-wide AppHandle. Called once from app setup.
pub fn install_app_handle(handle: tauri::AppHandle) {
    let _ = GLOBAL_APP_HANDLE.set(handle);
}

/// Read the process-wide AppHandle (None before app setup / in unit tests).
/// Shared by other out-of-session event emitters (e.g. the CLI
/// account-switch path) that have no per-session handle of their own.
pub fn global_app_handle() -> Option<&'static tauri::AppHandle> {
    GLOBAL_APP_HANDLE.get()
}

#[cfg(test)]
mod tests;
