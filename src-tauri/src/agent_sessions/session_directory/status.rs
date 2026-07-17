//! Status classification utilities for session aggregation.
//!
//! Provides helper functions to categorize session statuses into
//! active, completed, and failed groups.

use agent_core::session::SessionStatus;

// ============================================================================
// Status Classification
// ============================================================================

/// Status sets for grouping (matches frontend ACTIVE_STATUSES, FAILED_STATUSES)
pub const ACTIVE_STATUSES: &[&str] = &[
    SessionStatus::Idle.as_str(),
    SessionStatus::Pending.as_str(),
    SessionStatus::Running.as_str(),
    SessionStatus::WaitingForUser.as_str(),
    SessionStatus::WaitingForFunds.as_str(),
    SessionStatus::Paused.as_str(),
];

// Mirror of `SessionStatus::is_terminal()` minus `Completed`. Keep in
// lockstep with the frontend `TERMINAL_STATUSES` set in
// `src/types/session/session.ts` and with `SessionStatus::is_terminal()`
// in `agent_core/core/session/types/enums.rs`. Missing a terminal variant
// here mis-buckets that status as still-active in session_directory
// aggregations (overall counters, recent failure counts, etc.).
pub const FAILED_STATUSES: &[&str] = &[
    SessionStatus::Failed.as_str(),
    SessionStatus::Cancelled.as_str(),
    SessionStatus::Abandoned.as_str(),
    SessionStatus::Timeout.as_str(),
    SessionStatus::Archived.as_str(),
];

/// Check if a status is considered active (session in progress).
pub fn is_active_status(status: &str) -> bool {
    ACTIVE_STATUSES.contains(&status)
}

/// Check if a status is considered failed.
pub fn is_failed_status(status: &str) -> bool {
    FAILED_STATUSES.contains(&status)
}

/// Check if a status is considered completed.
pub fn is_completed_status(status: &str) -> bool {
    status == SessionStatus::Completed.as_str()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_active_status() {
        // Active statuses
        assert!(is_active_status("running"));
        assert!(is_active_status("pending"));
        assert!(is_active_status("idle"));
        assert!(is_active_status("waiting_for_user"));
        assert!(is_active_status("waiting_for_funds"));
        assert!(is_active_status("paused"));

        // Non-active statuses
        assert!(!is_active_status("completed"));
        assert!(!is_active_status("failed"));
        assert!(!is_active_status("cancelled"));
        assert!(!is_active_status("abandoned"));
        assert!(!is_active_status("timeout"));
        assert!(!is_active_status("unknown"));
    }

    #[test]
    fn test_is_failed_status() {
        // Failed statuses
        assert!(is_failed_status("failed"));
        assert!(is_failed_status("cancelled"));
        assert!(is_failed_status("abandoned"));
        assert!(is_failed_status("timeout"));
        assert!(is_failed_status("archived"));

        // Non-failed statuses
        assert!(!is_failed_status("completed"));
        assert!(!is_failed_status("running"));
        assert!(!is_failed_status("pending"));
        assert!(!is_failed_status("idle"));
    }

    #[test]
    fn test_is_completed_status() {
        assert!(is_completed_status("completed"));
        assert!(!is_completed_status("failed"));
        assert!(!is_completed_status("running"));
        assert!(!is_completed_status("Completed")); // Case sensitive
    }
}
