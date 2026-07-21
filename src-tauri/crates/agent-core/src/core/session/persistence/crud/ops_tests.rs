//! Tests for `list_sessions` filtering invariants.
//!
//! Two narrow contracts are pinned here so they survive future refactors:
//!
//! 1. `SessionListFilter::status` is a raw wire string after the Phase 2
//!    move into `core_types`. Without the typed `SessionStatus` to gate
//!    callers, the only thing standing between us and a casing bug
//!    (`"Running"` vs `"running"`) is that everyone funnels through
//!    `SessionStatus::as_str()`. Test 1 freezes that as the single source
//!    of truth.
//!
//! 2. `list_sessions(default)` silently appends `s.status != 'archived'`
//!    so the sidebar / picker don't surface idle-reset rows. Test 2
//!    seeds one running and one archived row in an isolated sandbox and
//!    asserts the visibility split both ways.
//!
//! The sandbox helper (`test_helpers::test_env::sandbox`) already
//! migrates a fresh `agent_sessions` schema under a tempdir-scoped
//! `ORGII_HOME`, so we can drive the real `upsert_session` /
//! `list_sessions` pair without inventing a parallel test fixture.

use super::ops::{
    delete_session, finalize_terminal_turn_status, list_sessions,
    reconcile_sessions_with_terminal_turn_markers, upsert_session,
};
use super::record::UnifiedSessionRecord;
use crate::session::persistence;
use crate::session::types::{SessionListFilter, SessionStatus};
use core_types::key_source::KeySource;
use test_helpers::test_env;

// ── Test 1: filter status string ↔ SessionStatus round trip ──────────

/// Every `SessionStatus` variant must round-trip cleanly through the
/// wire-string shape that `SessionListFilter::status` now stores. If
/// `as_str()` ever drifts (e.g. someone PRs a casing change) the
/// in-flight cleanup in `mark_stale_running_sessions_abandoned` and the
/// archived-exclusion in `list_sessions` would silently stop matching
/// real rows; this test catches that at the type-vs-string boundary.
#[test]
fn filter_status_round_trips_through_session_status_as_str() {
    // Enumerate every variant by hand so adding a new `SessionStatus`
    // value forces a compile-time visit here. The `parse` round-trip on
    // top of `as_str` keeps the table in lock-step with the enum's
    // `parse` arms — both directions, one assertion site.
    let variants = [
        SessionStatus::Pending,
        SessionStatus::Idle,
        SessionStatus::Running,
        SessionStatus::WaitingForUser,
        SessionStatus::WaitingForFunds,
        SessionStatus::Paused,
        SessionStatus::Completed,
        SessionStatus::Failed,
        SessionStatus::Cancelled,
        SessionStatus::Abandoned,
        SessionStatus::Timeout,
        SessionStatus::Archived,
    ];

    for status in variants {
        let wire = status.as_str();
        let filter = SessionListFilter {
            status: Some(wire.to_string()),
            ..Default::default()
        };
        assert_eq!(
            filter.status.as_deref(),
            Some(wire),
            "filter.status must preserve the canonical wire string for {:?}",
            status,
        );
        assert_eq!(
            SessionStatus::parse(wire),
            Some(status),
            "{:?}.as_str() must parse back to itself; otherwise list \
             callers and DB writers disagree on the wire form",
            status,
        );
    }
}

// ── Test 2: list_sessions default hides archived rows ────────────────

fn ensure_test_schema() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    persistence::init(&conn).expect("session persistence migrations");
}

fn seed_session(session_id: &str, status: SessionStatus) {
    ensure_test_schema();
    // Status is the only column under test; everything else is filler
    // matching the NOT NULL constraints in the schema. `session_type`
    // is forced to a concrete value (`"sde"`) because the default
    // `list_sessions` filter already excludes the `gateway` type.
    let now = "2024-01-01T00:00:00Z".to_string();
    let record = UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: format!("seed-{session_id}"),
        status: status.as_str().to_string(),
        created_at: now.clone(),
        updated_at: now,
        session_type: "sde".to_string(),
        key_source: KeySource::OwnKey,
        ..Default::default()
    };
    upsert_session(&record).expect("seed upsert");
}

#[test]
#[serial_test::serial]
fn delete_session_refuses_active_shell_before_removing_session_row() {
    let _sandbox = test_env::sandbox();
    let session_id = "sid-active-shell-delete";
    seed_session(session_id, SessionStatus::Running);
    let replay_root = crate::tools::impls::coding::exec::shell_replay::resolve_replay_root();
    let mut writer = crate::tools::impls::coding::exec::shell_replay::ShellReplayWriter::create(
        &replay_root,
        crate::tools::impls::coding::exec::shell_replay::ShellReplayTarget::new(
            session_id,
            "call-active-delete",
        ),
        "sleep",
        std::path::Path::new("/tmp"),
        None,
    )
    .unwrap();
    writer
        .append(
            crate::tools::impls::coding::exec::shell_replay::ShellReplayStream::Stdout,
            b"running",
        )
        .unwrap();

    let error = delete_session(session_id).unwrap_err().to_string();
    assert!(error.contains("cannot delete session"), "{error}");
    assert!(super::ops::get_session(session_id).unwrap().is_some());

    writer
        .finalize(core_types::session_event::ShellReplayStatus::Complete, None)
        .unwrap();
    crate::tools::impls::coding::exec::shell_replay::remove_session_replays(session_id).unwrap();
}

/// `list_sessions(&SessionListFilter::default())` must hide archived
/// rows from the default listing, but an explicit
/// `status = Some("archived")` filter must surface them. Both halves
/// matter: dropping the implicit hide turns the sidebar into an
/// idle-reset graveyard, and dropping the explicit override makes the
/// audit/debug path unable to recover archived sessions.
#[test]
fn list_sessions_default_filter_excludes_archived() {
    let _sandbox = test_env::sandbox();

    seed_session("sid-running", SessionStatus::Running);
    seed_session("sid-archived", SessionStatus::Archived);

    let default_listing = list_sessions(&SessionListFilter::default()).expect("list default");
    let default_ids: Vec<&str> = default_listing
        .iter()
        .map(|r| r.session_id.as_str())
        .collect();
    assert!(
        default_ids.contains(&"sid-running"),
        "default listing must include the running session (got {:?})",
        default_ids,
    );
    assert!(
        !default_ids.contains(&"sid-archived"),
        "default listing must hide archived sessions (got {:?})",
        default_ids,
    );

    let archived_filter = SessionListFilter {
        status: Some(SessionStatus::Archived.as_str().to_string()),
        ..Default::default()
    };
    let archived_listing = list_sessions(&archived_filter).expect("list archived");
    let archived_ids: Vec<&str> = archived_listing
        .iter()
        .map(|r| r.session_id.as_str())
        .collect();
    assert_eq!(
        archived_ids,
        vec!["sid-archived"],
        "explicit status=archived must return exactly the archived row",
    );
}

#[test]
fn terminal_turn_finalize_updates_session_status_and_marker() {
    let _sandbox = test_env::sandbox();

    seed_session("sid-terminal", SessionStatus::Running);

    let updated = finalize_terminal_turn_status(
        "sid-terminal",
        "turn-123",
        "completed",
        SessionStatus::Completed,
        "2026-06-05T12:00:00.000Z",
    )
    .expect("finalize terminal turn");

    assert!(updated, "existing session row should be updated");
    let row = super::ops::get_session("sid-terminal")
        .expect("get session")
        .expect("session exists");
    assert_eq!(row.status, SessionStatus::Completed.as_str());
    assert_eq!(row.updated_at, "2026-06-05T12:00:00.000Z");
}

#[test]
fn reconcile_repairs_all_in_flight_rows_with_terminal_turn_markers() {
    let _sandbox = test_env::sandbox();

    for (index, status) in SessionStatus::IN_FLIGHT.into_iter().enumerate() {
        let session_id = format!("sid-reconcile-{index}");
        seed_session(&session_id, status);
        finalize_terminal_turn_status(
            &session_id,
            &format!("turn-{index}"),
            "completed",
            status,
            "2026-06-05T12:30:00.000Z",
        )
        .expect("seed mismatched terminal marker");
    }

    let updated = reconcile_sessions_with_terminal_turn_markers().expect("reconcile markers");

    assert_eq!(updated, SessionStatus::IN_FLIGHT.len());
    for index in 0..SessionStatus::IN_FLIGHT.len() {
        let row = super::ops::get_session(&format!("sid-reconcile-{index}"))
            .expect("get session")
            .expect("session exists");
        assert_eq!(row.status, SessionStatus::Completed.as_str());
        assert_eq!(row.updated_at, "2026-06-05T12:30:00.000Z");
    }
}
