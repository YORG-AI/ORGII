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
