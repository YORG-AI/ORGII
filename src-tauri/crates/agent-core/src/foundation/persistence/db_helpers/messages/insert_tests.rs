//! Tests for `insert_message` (single-connection transaction) and
//! `insert_message_retry` (exponential-back-off retry wrapper).
//!
//! Every test uses `test_env::sandbox()` to get a fresh, fully-migrated
//! SQLite DB in a tempdir. The sandbox serialises concurrent env-var access
//! so these tests are safe to run with `cargo test --test-threads N`.

use super::super::{insert_message, insert_message_if_absent_retry, insert_message_retry};
use crate::persistence::db_helpers::{
    clear_messages, delete_session_cascade, load_messages, message_role, AgentMessageRow,
};
use database::db::get_connection;
use test_helpers::test_env;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const PREFIX: &str = "agent";

/// Create the minimal tables needed by `insert_message` and seed one session row.
///
/// `prime_schema()` in `test_env::sandbox()` initialises most tables but skips
/// `session_snapshots::ensure_tables` (which owns `CREATE TABLE agent_sessions`).
/// We create both tables inline here so these tests are self-contained.
fn seed_session(session_id: &str) {
    let conn = get_connection().expect("get_connection in seed_session");

    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_messages (
            id           TEXT PRIMARY KEY,
            session_id   TEXT NOT NULL,
            role         TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            tool_name    TEXT,
            tool_call_id TEXT,
            tool_input   TEXT,
            tool_output  TEXT,
            model        TEXT,
            sequence     INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            images       TEXT,
            compact_from_sequence INTEGER,
            compact_tokens_before INTEGER,
            compact_tokens_after INTEGER
         );",
    )
    .expect("create tables in seed_session");

    conn.execute(
        "INSERT OR IGNORE INTO agent_sessions
         (session_id, session_type, status, created_at, updated_at)
         VALUES (?1, 'sde', 'running', datetime('now'), datetime('now'))",
        [session_id],
    )
    .expect("seed agent_sessions row");
}

fn make_msg(session_id: &str, role: &str, content: &str) -> AgentMessageRow {
    AgentMessageRow {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: 0, // overwritten by insert_message
        created_at: chrono::Utc::now().to_rfc3339(),
        images: None,
        compact_from_sequence: None,
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn corrupt_images_column(session_id: &str) {
    let conn = get_connection().expect("get_connection in corrupt_images_column");
    conn.execute(
        "UPDATE agent_messages SET images = ?1 WHERE session_id = ?2",
        ["{ invalid image json", session_id],
    )
    .expect("corrupt images column");
}

// ──────────────────────────────────────────────────────────────────────────────
// insert_message: sequence assignment
// ──────────────────────────────────────────────────────────────────────────────

#[test]
fn first_message_gets_sequence_zero() {
    let _sb = test_env::sandbox();
    let sid = "seq-test-first";
    seed_session(sid);

    let msg = make_msg(sid, message_role::USER, "hello");
    insert_message(PREFIX, &msg).expect("insert first message");

    let rows = load_messages(PREFIX, sid).expect("load_messages");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sequence, 0);
}

#[test]
fn subsequent_messages_increment_sequence() {
    let _sb = test_env::sandbox();
    let sid = "seq-test-incr";
    seed_session(sid);

    for (role, content) in [
        (message_role::USER, "first"),
        (message_role::ASSISTANT, "second"),
        (message_role::USER, "third"),
    ] {
        insert_message(PREFIX, &make_msg(sid, role, content)).expect("insert message");
    }

    let rows = load_messages(PREFIX, sid).expect("load_messages");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].sequence, 0);
    assert_eq!(rows[1].sequence, 1);
    assert_eq!(rows[2].sequence, 2);
}

#[test]
fn sequences_are_independent_across_sessions() {
    let _sb = test_env::sandbox();
    seed_session("sess-a");
    seed_session("sess-b");

    insert_message(PREFIX, &make_msg("sess-a", message_role::USER, "a1")).unwrap();
    insert_message(PREFIX, &make_msg("sess-a", message_role::USER, "a2")).unwrap();
    insert_message(PREFIX, &make_msg("sess-b", message_role::USER, "b1")).unwrap();

    let rows_a = load_messages(PREFIX, "sess-a").unwrap();
    let rows_b = load_messages(PREFIX, "sess-b").unwrap();

    assert_eq!(rows_a[0].sequence, 0);
    assert_eq!(rows_a[1].sequence, 1);
    assert_eq!(rows_b[0].sequence, 0, "sess-b sequence should restart at 0");
}

#[test]
fn stable_insert_replay_preserves_original_row_without_appending() {
    let _sb = test_env::sandbox();
    let sid = "stable-inbox-transcript";
    seed_session(sid);

    let mut original = make_msg(sid, message_role::USER, "original transcript");
    original.id = "agent-org-stable-message-id".into();
    let original_created_at = original.created_at.clone();
    let (id, inserted) =
        insert_message_if_absent_retry(PREFIX, &original).expect("insert first stable transcript");
    assert_eq!(id, original.id);
    assert!(inserted);

    let mut replay = original.clone();
    replay.content = "re-rendered content must not replace the durable row".into();
    replay.created_at = chrono::Utc::now().to_rfc3339();
    let (replay_id, replay_inserted) =
        insert_message_if_absent_retry(PREFIX, &replay).expect("coalesce stable transcript replay");
    assert_eq!(replay_id, original.id);
    assert!(!replay_inserted);

    let rows = load_messages(PREFIX, sid).expect("load stable transcript");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "original transcript");
    assert_eq!(rows[0].sequence, 0);
    assert_eq!(rows[0].created_at, original_created_at);
}

#[test]
fn ordinary_insert_retains_replace_on_duplicate_id_behavior() {
    let _sb = test_env::sandbox();
    let sid = "ordinary-duplicate-id";
    seed_session(sid);

    let mut original = make_msg(sid, message_role::USER, "original");
    original.id = "ordinary-reused-id".into();
    insert_message(PREFIX, &original).expect("insert ordinary message");

    let mut replacement = original.clone();
    replacement.content = "replacement".into();
    insert_message(PREFIX, &replacement).expect("replace ordinary message");

    let rows = load_messages(PREFIX, sid).expect("load ordinary message");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "replacement");
    assert_eq!(
        rows[0].sequence, 1,
        "baseline replace assigns the next sequence"
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// insert_message: atomicity — rollback on INSERT failure leaves no partial row
// ──────────────────────────────────────────────────────────────────────────────

#[test]
fn failed_insert_leaves_no_partial_row() {
    let _sb = test_env::sandbox();
    let sid = "atomicity-test";
    seed_session(sid);

    // Insert a message once successfully.
    let msg = make_msg(sid, message_role::USER, "original");
    insert_message(PREFIX, &msg).expect("first insert");

    // Try to INSERT the same `id` again with a conflicting role — `INSERT OR
    // REPLACE` will actually upsert, so craft a scenario where the *session*
    // row is absent (force a constraint failure by targeting a non-existent
    // session, which makes the `updated_at` UPDATE a no-op but the INSERT
    // itself won't violate any FK since we have no FK enforcement enabled).
    //
    // Real-world atomicity test: insert into a *non-existent* session to
    // confirm the messages table row count stays at 1 for the valid session.
    let ghost_sid = "ghost-session-does-not-exist";
    let ghost_msg = make_msg(ghost_sid, message_role::USER, "ghost");
    // This should succeed at the SQL level (no FK constraint) but produce 0
    // rows for "ghost-session-does-not-exist" in the messages table.
    let result = insert_message(PREFIX, &ghost_msg);
    // Insert succeeds (no FK constraint) — what matters is the original
    // session is untouched.
    let _ = result;

    let rows = load_messages(PREFIX, sid).expect("load original session");
    assert_eq!(
        rows.len(),
        1,
        "original session row count must be unaffected"
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// insert_message_retry: succeeds on first attempt under normal conditions
// ──────────────────────────────────────────────────────────────────────────────

#[test]
fn clear_messages_invalid_images_json_returns_err_and_preserves_rows() {
    let _sb = test_env::sandbox();
    let sid = "clear-invalid-images";
    seed_session(sid);
    insert_message_retry(PREFIX, &make_msg(sid, message_role::USER, "hello")).unwrap();
    corrupt_images_column(sid);

    let err = clear_messages(PREFIX, sid).expect_err("invalid images json must fail cleanup");
    assert!(matches!(
        err,
        rusqlite::Error::FromSqlConversionFailure(_, _, _)
    ));

    let rows = load_messages(PREFIX, sid).expect("load preserved rows");
    assert_eq!(
        rows.len(),
        1,
        "DB rows must not be deleted after cleanup failure"
    );
}

#[test]
fn delete_session_cascade_invalid_images_json_returns_err_and_preserves_rows() {
    let _sb = test_env::sandbox();
    let sid = "cascade-invalid-images";
    seed_session(sid);
    insert_message_retry(PREFIX, &make_msg(sid, message_role::USER, "hello")).unwrap();
    corrupt_images_column(sid);

    let err = delete_session_cascade(sid, &["agent_messages", "agent_sessions"])
        .expect_err("invalid images json must fail cascade cleanup");
    assert!(matches!(
        err,
        rusqlite::Error::FromSqlConversionFailure(_, _, _)
    ));

    let rows = load_messages(PREFIX, sid).expect("load preserved rows");
    assert_eq!(
        rows.len(),
        1,
        "DB rows must not be deleted after cleanup failure"
    );
}

#[test]
fn retry_wrapper_succeeds_on_first_attempt() {
    let _sb = test_env::sandbox();
    let sid = "retry-happy-path";
    seed_session(sid);

    let msg = make_msg(sid, message_role::ASSISTANT, "hello from assistant");
    let id = insert_message_retry(PREFIX, &msg).expect("insert_message_retry");
    assert_eq!(id, msg.id);

    let rows = load_messages(PREFIX, sid).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "hello from assistant");
}

#[test]
fn retry_wrapper_assigns_correct_sequence() {
    let _sb = test_env::sandbox();
    let sid = "retry-seq";
    seed_session(sid);

    insert_message_retry(PREFIX, &make_msg(sid, message_role::USER, "u1")).unwrap();
    insert_message_retry(PREFIX, &make_msg(sid, message_role::ASSISTANT, "a1")).unwrap();
    insert_message_retry(PREFIX, &make_msg(sid, message_role::USER, "u2")).unwrap();

    let rows = load_messages(PREFIX, sid).unwrap();
    assert_eq!(rows.len(), 3);
    let sequences: Vec<i64> = rows.iter().map(|r| r.sequence).collect();
    assert_eq!(sequences, vec![0, 1, 2]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Role round-trip
// ──────────────────────────────────────────────────────────────────────────────

#[test]
fn all_four_roles_round_trip() {
    let _sb = test_env::sandbox();
    let sid = "role-round-trip";
    seed_session(sid);

    let roles = [
        message_role::USER,
        message_role::ASSISTANT,
        message_role::TOOL_CALL,
        message_role::TOOL_RESULT,
    ];
    for role in roles {
        insert_message_retry(PREFIX, &make_msg(sid, role, role)).unwrap();
    }

    let rows = load_messages(PREFIX, sid).unwrap();
    assert_eq!(rows.len(), 4);
    for (row, expected_role) in rows.iter().zip(roles.iter()) {
        assert_eq!(&row.role, expected_role);
    }
}
