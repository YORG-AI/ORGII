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
