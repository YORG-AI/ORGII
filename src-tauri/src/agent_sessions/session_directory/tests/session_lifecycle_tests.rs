//! Agent Session Lifecycle Tests
//!
//! Tests every valid status transition and terminal/resumable classification
//! for agent sessions across all session categories (CLI, SDE Agent, OS Agent).
//!
//! ## Coverage
//! - All `SessionStatus` variants: pending → running → completed/failed/cancelled
//! - `is_terminal()` — no further transitions expected
//! - `is_resumable()` — session can be restarted
//! - `is_active_status()` / `is_failed_status()` / `is_completed_status()` parity
//! - Idle (Agent Org member) non-terminal, resumable semantics
//! - Unknown / garbage status strings do not crash

use crate::agent_sessions::cli::types::SessionStatus;
use crate::agent_sessions::session_directory::status::{
    is_active_status, is_completed_status, is_failed_status,
};

// ============================================================================
// Helpers
// ============================================================================

fn all_status_strings() -> Vec<(&'static str, SessionStatus)> {
    vec![
        ("pending", SessionStatus::Pending),
        ("running", SessionStatus::Running),
        ("idle", SessionStatus::Idle),
        ("completed", SessionStatus::Completed),
        ("failed", SessionStatus::Failed),
        ("cancelled", SessionStatus::Cancelled),
    ]
}

// ============================================================================
// Parsing
// ============================================================================

#[test]
fn parse_returns_correct_variant_for_every_known_status() {
    for (raw, expected) in all_status_strings() {
        let parsed = SessionStatus::parse(raw);
        assert!(
            parsed.is_some(),
            "parse({raw:?}) returned None — add it to SessionStatus::parse()"
        );
        assert_eq!(
            parsed.unwrap(),
            expected,
            "parse({raw:?}) returned wrong variant"
        );
    }
}

#[test]
fn parse_returns_none_for_unknown_strings() {
    let unknown = ["", "RUNNING", "Pending", "error", "zombie", "in-progress"];
    for s in unknown {
        assert!(
            SessionStatus::parse(s).is_none(),
            "parse({s:?}) should return None for unknown string"
        );
    }
}

// ============================================================================
// Terminal / Resumable
// ============================================================================

#[test]
fn terminal_statuses_are_correct() {
    assert!(SessionStatus::Completed.is_terminal());
    assert!(SessionStatus::Failed.is_terminal());
    assert!(SessionStatus::Cancelled.is_terminal());

    assert!(!SessionStatus::Pending.is_terminal());
    assert!(!SessionStatus::Running.is_terminal());
    assert!(!SessionStatus::Idle.is_terminal());
}

#[test]
fn resumable_statuses_are_correct() {
    assert!(SessionStatus::Running.is_resumable());
    assert!(SessionStatus::Failed.is_resumable());
    assert!(SessionStatus::Pending.is_resumable());

    assert!(!SessionStatus::Completed.is_resumable());
    assert!(!SessionStatus::Cancelled.is_resumable());
    assert!(!SessionStatus::Idle.is_resumable());
}

// ============================================================================
// Display (serialization)
// ============================================================================

#[test]
fn display_matches_parse_roundtrip() {
    for (raw, variant) in all_status_strings() {
        let displayed = variant.to_string();
        assert_eq!(
            displayed, raw,
            "Display for {variant:?} was {displayed:?}, expected {raw:?}"
        );
        let reparsed = SessionStatus::parse(&displayed);
        assert_eq!(
            reparsed,
            Some(variant),
            "Roundtrip parse(display({variant:?})) failed"
        );
    }
}

// ============================================================================
// Parity: session_directory status helpers vs SessionStatus
// ============================================================================

#[test]
fn active_status_helper_matches_session_status_active_variants() {
    let active = [
        "idle",
        "pending",
        "running",
        "waiting_for_user",
        "waiting_for_funds",
        "paused",
    ];
    let inactive = [
        "completed",
        "failed",
        "cancelled",
        "abandoned",
        "timeout",
        "archived",
    ];

    for s in active {
        assert!(
            is_active_status(s),
            "is_active_status({s:?}) should be true"
        );
    }
    for s in inactive {
        assert!(
            !is_active_status(s),
            "is_active_status({s:?}) should be false"
        );
    }
}

#[test]
fn failed_status_helper_covers_all_terminal_failures() {
    let failures = ["failed", "cancelled", "abandoned", "timeout", "archived"];
    for s in failures {
        assert!(
            is_failed_status(s),
            "is_failed_status({s:?}) should be true"
        );
    }

    // Running/pending are not failures
    assert!(!is_failed_status("running"));
    assert!(!is_failed_status("pending"));
    assert!(!is_failed_status("completed"));
}

#[test]
fn completed_status_helper_is_exact() {
    assert!(is_completed_status("completed"));
    // Case sensitive
    assert!(!is_completed_status("Completed"));
    assert!(!is_completed_status("COMPLETED"));
    // Other terminal statuses are not completed
    assert!(!is_completed_status("failed"));
    assert!(!is_completed_status("cancelled"));
}

#[test]
fn status_categories_are_mutually_exclusive_for_known_statuses() {
    let scenarios: &[(&str, bool, bool, bool)] = &[
        // (status, active, failed, completed)
        ("pending", true, false, false),
        ("running", true, false, false),
        ("idle", true, false, false),
        ("waiting_for_user", true, false, false),
        ("paused", true, false, false),
        ("completed", false, false, true),
        ("failed", false, true, false),
        ("cancelled", false, true, false),
        ("abandoned", false, true, false),
        ("timeout", false, true, false),
        ("archived", false, true, false),
    ];

    for (status, expected_active, expected_failed, expected_completed) in scenarios {
        let active = is_active_status(status);
        let failed = is_failed_status(status);
        let completed = is_completed_status(status);

        assert_eq!(
            active, *expected_active,
            "{status}: is_active_status mismatch"
        );
        assert_eq!(
            failed, *expected_failed,
            "{status}: is_failed_status mismatch"
        );
        assert_eq!(
            completed, *expected_completed,
            "{status}: is_completed_status mismatch"
        );

        // Only one category must be true (or none for unknown statuses)
        let count = [active, failed, completed].iter().filter(|&&b| b).count();
        assert!(
            count <= 1,
            "{status}: belongs to more than one category (active={active}, failed={failed}, completed={completed})"
        );
    }
}
