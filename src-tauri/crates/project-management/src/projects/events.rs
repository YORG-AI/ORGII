//! Frontend-visible event names emitted by the projects subsystem.
//!
//! Hosts the `DATA_CHANGED_EVENT` Tauri event name. Callers depend on this
//! module so that emitting a "project data changed" notification has no coupling
//! to file system watchers.

/// Tauri event name emitted whenever any project / work item / orchestrator
/// state has been mutated and the frontend should re-fetch.
pub const DATA_CHANGED_EVENT: &str = "orgii-data-changed";

/// Tauri event name emitted when a routine or one of its fires changes
/// (fired, started, succeeded, failed, …). Payload:
/// `{ routineId, fireId?, status }`.
pub const ROUTINE_CHANGED_EVENT: &str = "orgii-routine-changed";

use std::sync::OnceLock;

static DATA_CHANGED_NOTIFIER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static WORK_ITEM_SCHEDULE_CHANGED_NOTIFIER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static WORK_ITEM_DISPATCH_READY_NOTIFIER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// App-level registration of the frontend notifier (Tauri emit). First call wins.
pub fn register_data_changed_notifier(notifier: Box<dyn Fn() + Send + Sync>) {
    let _ = DATA_CHANGED_NOTIFIER.set(notifier);
}

/// Notify the frontend that project/work-item state changed. No-op before registration.
pub fn notify_data_changed() {
    if let Some(notifier) = DATA_CHANGED_NOTIFIER.get() {
        notifier();
    }
}

/// A work item that just crossed into a terminal portable state
/// (completed/failed/cancelled families) through the atomic RMW kernel.
/// Carries enough scope to re-read the item without another query shape.
#[derive(Debug, Clone)]
pub struct WorkItemTerminalEvent {
    pub org_id: String,
    pub project_slug: Option<String>,
    pub short_id: String,
    pub parent: Option<String>,
    pub status: String,
}

static WORK_ITEM_TERMINAL_NOTIFIER: OnceLock<Box<dyn Fn(WorkItemTerminalEvent) + Send + Sync>> =
    OnceLock::new();

/// App-level registration for terminal-transition observers (the
/// child-done parent wake). First call wins.
pub fn register_work_item_terminal_notifier(
    notifier: Box<dyn Fn(WorkItemTerminalEvent) + Send + Sync>,
) {
    let _ = WORK_ITEM_TERMINAL_NOTIFIER.set(notifier);
}

/// Fire after the mutation transaction commits. No-op before registration.
pub(crate) fn notify_work_item_terminal(event: WorkItemTerminalEvent) {
    if let Some(notifier) = WORK_ITEM_TERMINAL_NOTIFIER.get() {
        notifier(event);
    }
}

/// Register the in-process wake-up used by the work-item schedule executor.
///
/// This is deliberately separate from [`DATA_CHANGED_NOTIFIER`]: frontend
/// invalidation and scheduler lifecycle have different consumers and must not
/// make every UI refresh wake a background task. First call wins.
pub fn register_work_item_schedule_changed_notifier(notifier: Box<dyn Fn() + Send + Sync>) {
    let _ = WORK_ITEM_SCHEDULE_CHANGED_NOTIFIER.set(notifier);
}

/// Wake the work-item schedule executor after a committed work-item mutation.
///
/// The callback is a no-op before scheduler startup. Callers must invoke this
/// only after their transaction commits so the awakened reader observes the
/// new state.
pub(crate) fn notify_work_item_schedule_changed() {
    if let Some(notifier) = WORK_ITEM_SCHEDULE_CHANGED_NOTIFIER.get() {
        notifier();
    }
}

/// Register the process-local wake-up used by the durable Run dispatcher.
///
/// Cross-process writers are still discovered by the persisted
/// `pm_change_seq` watermark. This callback removes the idle polling delay for
/// producers in the current process without coupling the PM crate to Tauri or
/// the agent runtime. First call wins.
pub fn register_work_item_dispatch_ready_notifier(notifier: Box<dyn Fn() + Send + Sync>) {
    let _ = WORK_ITEM_DISPATCH_READY_NOTIFIER.set(notifier);
}

/// Wake the durable Run dispatcher after an outbox transaction commits.
///
/// Calling before runtime startup is intentionally a no-op: the dispatcher's
/// immediate recovery probe observes the durable row when it starts.
pub(crate) fn notify_work_item_dispatch_ready() {
    if let Some(notifier) = WORK_ITEM_DISPATCH_READY_NOTIFIER.get() {
        notifier();
    }
}
