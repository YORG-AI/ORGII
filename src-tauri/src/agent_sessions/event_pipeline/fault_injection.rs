//! Debug-build-only EventStore fault fixtures.
//!
//! The fixture is scoped to one Session and consumed exactly once by the
//! production persistence adapter. It never manufactures a summary receipt
//! or terminal state; rendered E2E still drives the real Provider,
//! EventStore, failure projection, and Retry command paths.

use std::sync::{Mutex, OnceLock};

static NEXT_FINAL_SUMMARY_FAILURE_SESSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<String>> {
    NEXT_FINAL_SUMMARY_FAILURE_SESSION.get_or_init(|| Mutex::new(None))
}

pub(crate) fn arm_next_final_summary_persist_failure(session_id: &str) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("final_summary_fault_session_id_required".to_string());
    }
    let mut guard = slot()
        .lock()
        .map_err(|_| "final_summary_fault_fixture_poisoned".to_string())?;
    if guard.is_some() {
        return Err("final_summary_fault_fixture_already_armed".to_string());
    }
    *guard = Some(session_id.to_string());
    Ok(())
}

pub(crate) fn take_final_summary_persist_failure(
    label: &str,
    session_id: &str,
) -> Result<bool, String> {
    if label != "agent-org-assistant-final" {
        return Ok(false);
    }
    let mut guard = slot()
        .lock()
        .map_err(|_| "final_summary_fault_fixture_poisoned".to_string())?;
    if guard.as_deref() != Some(session_id) {
        return Ok(false);
    }
    guard.take();
    Ok(true)
}

pub(crate) fn clear_final_summary_persist_failure(session_id: &str) -> Result<bool, String> {
    let mut guard = slot()
        .lock()
        .map_err(|_| "final_summary_fault_fixture_poisoned".to_string())?;
    if guard.as_deref() != Some(session_id.trim()) {
        return Ok(false);
    }
    guard.take();
    Ok(true)
}
