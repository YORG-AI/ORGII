use super::*;
use rusqlite::types::Value as SqlValue;

fn row(id: &str, function_name: Option<&str>, result_json: &str, sequence: i64) -> IndexEventRow {
    IndexEventRow {
        id: id.to_string(),
        function_name: function_name.map(str::to_string),
        args_json: "{}".to_string(),
        result_json: result_json.to_string(),
        content: id.to_string(),
        created_at: "2026-05-27T00:00:00Z".to_string(),
        order_sequence: sequence,
    }
}

fn create_backfill_test_tables(conn: &Connection) {
    crate::schema::init_session_tables(conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                images TEXT
            );",
    )
    .unwrap();
}

fn insert_index_test_event(
    conn: &Connection,
    id: &str,
    function_name: &str,
    args_json: SqlValue,
    result_json: SqlValue,
    content: SqlValue,
    sequence: i64,
) {
    conn.execute(
        "INSERT INTO events
             (id, session_id, event_type, function_name, thread_id, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, 'session-1', 'raw', ?2, NULL, ?3, ?4, ?5, ?6, '{}', ?7)",
        params![
            id,
            function_name,
            args_json,
            result_json,
            content,
            format!("2026-07-20T00:00:{sequence:02}Z"),
            sequence,
        ],
    )
    .unwrap();
}

#[test]
fn backfill_missing_user_events_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    create_backfill_test_tables(&conn);
    conn.execute(
        "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL)",
        params![
            "message-1",
            "session-1",
            "hello from persisted user",
            1_i64,
            "2026-05-27T00:00:00Z",
        ],
    )
    .unwrap();

    assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 1);
    assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 0);

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1 AND id = ?2",
            params!["session-1", "user-message-message-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn backfill_dedups_long_messages_against_truncated_event_previews() {
    // After a transcript rewrite (compaction) agent_messages rows get
    // fresh ids, so id-based dedup misses and we fall back to content
    // matching. Event rows store content truncated to 500 bytes; the
    // full agent_messages content must still match instead of
    // re-inserting a duplicate "[Plan approved] …" user bubble.
    let conn = Connection::open_in_memory().unwrap();
    create_backfill_test_tables(&conn);

    let long_content = format!(
        "[Plan approved] Implement the approved plan now. 计划正文 {}",
        "非常长的计划内容 plan body ".repeat(200)
    );
    assert!(long_content.len() > 1_000);

    conn.execute(
        "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL)",
        params![
            "rewritten-id",
            "session-1",
            &long_content,
            1_i64,
            "2026-05-27T00:00:00Z",
        ],
    )
    .unwrap();

    // Pre-existing event row from the original submit (different
    // message id, content truncated like build_searchable_content).
    let truncated = user_content_dedup_key(&long_content);
    conn.execute(
        "INSERT INTO events
             (id, session_id, event_type, function_name, thread_id, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, ?2, 'raw', 'user_message', NULL, '{}', ?3, ?4, ?5, '{}', 1)",
        params![
            "user-message-original-id",
            "session-1",
            r#"{"backendPersisted":true}"#,
            format!("user_message {truncated}"),
            "2026-05-27T00:00:00Z",
        ],
    )
    .unwrap();

    assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 0);
}

#[test]
fn rebuild_skips_large_columns_for_known_no_metadata_rows() {
    let conn = Connection::open_in_memory().unwrap();
    create_backfill_test_tables(&conn);
    insert_index_test_event(
        &conn,
        "user-1",
        USER_MESSAGE_FUNCTION,
        SqlValue::Text("{}".to_string()),
        SqlValue::Text(r#"{"backendPersisted":true}"#.to_string()),
        SqlValue::Text("user_message inspect memory".to_string()),
        1,
    );

    // SQLite's dynamic typing lets this fixture use BLOBs in TEXT
    // columns. `Row::get::<String>` would fail, so a successful rebuild
    // proves these large columns were not materialized by Rust.
    let large_blob = vec![b'x'; 2 * 1024 * 1024];
    for (sequence, id, function_name) in [
        (2, "assistant-1", "assistant"),
        (3, "thinking-1", "thinking"),
        (4, "node-1", "node_repl"),
    ] {
        insert_index_test_event(
            &conn,
            id,
            function_name,
            SqlValue::Blob(large_blob.clone()),
            SqlValue::Blob(large_blob.clone()),
            SqlValue::Blob(large_blob.clone()),
            sequence,
        );
    }
    insert_index_test_event(
        &conn,
        "grep-1",
        "Grep",
        SqlValue::Text(r#"{"path":"src"}"#.to_string()),
        SqlValue::Blob(large_blob),
        SqlValue::Blob(vec![b'y'; 1024 * 1024]),
        5,
    );

    rebuild_turn_index_on_connection(
        &conn,
        "session-1",
        &StaleIntentIds::new(),
        &IntentStatusOverlay::new(),
    )
    .unwrap();

    let (event_count, body_event_count): (i64, i64) = conn
        .query_row(
            "SELECT event_count, body_event_count FROM session_turns
                 WHERE session_id = 'session-1' AND turn_id = 'user-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(event_count, 5);
    assert_eq!(body_event_count, 4);
}

#[test]
fn rebuild_rolls_back_old_index_when_conservative_payload_read_fails() {
    let conn = Connection::open_in_memory().unwrap();
    create_backfill_test_tables(&conn);
    conn.execute(
        "INSERT INTO session_turns
             (session_id, turn_id, start_sequence, started_at, status, updated_at)
             VALUES ('session-1', 'old-turn', 0, '2026-07-19T00:00:00Z', 'completed',
                     '2026-07-19T00:00:01Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turn_index_state
             (session_id, indexed_event_count, indexed_max_sequence, rebuilt_at, index_version)
             VALUES ('session-1', 99, 98, '2026-07-19T00:00:01Z', 11)",
        [],
    )
    .unwrap();
    insert_index_test_event(
        &conn,
        "user-1",
        USER_MESSAGE_FUNCTION,
        SqlValue::Text("{}".to_string()),
        SqlValue::Text(r#"{"backendPersisted":true}"#.to_string()),
        SqlValue::Text("user_message trigger rebuild".to_string()),
        1,
    );
    insert_index_test_event(
        &conn,
        "future-1",
        "future_provider_tool",
        SqlValue::Blob(vec![b'x'; 1024]),
        SqlValue::Text("{}".to_string()),
        SqlValue::Text(String::new()),
        2,
    );

    let error = rebuild_turn_index_on_connection(
        &conn,
        "session-1",
        &StaleIntentIds::new(),
        &IntentStatusOverlay::new(),
    )
    .unwrap_err();
    assert!(matches!(error, rusqlite::Error::InvalidColumnType(..)));

    let turn_ids: Vec<String> = conn
        .prepare(
            "SELECT turn_id FROM session_turns WHERE session_id = 'session-1'
                 ORDER BY turn_id",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<SqliteResult<Vec<_>>>()
        .unwrap();
    assert_eq!(turn_ids, vec!["old-turn"]);
    let index_version: i64 = conn
        .query_row(
            "SELECT index_version FROM session_turn_index_state
                 WHERE session_id = 'session-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(index_version, 11);
}

#[test]
fn synthetic_user_input_does_not_start_turn() {
    let rows = vec![
        row(
            "user-input-optimistic",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"syntheticUserInput":true}"#,
            1,
        ),
        row("assistant-event", Some("assistant_message"), "{}", 2),
        row(
            "user-message-authoritative",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"backendPersisted":true}"#,
            3,
        ),
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].turn_id, "user-message-authoritative");
    assert_eq!(drafts[0].start_sequence, 3);
}

#[test]
fn imported_user_alias_starts_turn() {
    let rows = vec![
        row(
            "imported-user",
            Some(IMPORTED_USER_MESSAGE_FUNCTION),
            "{}",
            1,
        ),
        row("assistant-event", Some("assistant"), "{}", 2),
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].turn_id, "imported-user");
    assert_eq!(drafts[0].body_event_count, 1);
}

#[test]
fn consecutive_user_messages_do_not_materialize_ghost_pending_turns() {
    let rows = vec![
        row(
            "user-message-queued-ghost",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"backendPersisted":true}"#,
            1,
        ),
        row(
            "user-message-authoritative",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"backendPersisted":true}"#,
            2,
        ),
        row("assistant-event", Some("assistant_message"), "{}", 3),
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].turn_id, "user-message-authoritative");
    assert_eq!(drafts[0].start_sequence, 2);
    assert_eq!(drafts[0].body_event_count, 1);
}

#[test]
fn latest_user_only_turn_still_materializes_as_pending() {
    let rows = vec![row(
        "user-message-latest",
        Some(USER_MESSAGE_FUNCTION),
        r#"{"backendPersisted":true}"#,
        1,
    )];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].turn_id, "user-message-latest");
    assert_eq!(drafts[0].body_event_count, 0);
}

#[test]
fn two_rows_with_same_turn_intent_id_collapse_into_one_round() {
    // The optimistic synthetic event is normally filtered out by
    // `is_synthetic_user_input`, but a backend can also legitimately
    // persist two user_message rows under the same intent (inbox
    // transcript followed by main submit). The indexer must collapse
    // them into a single round so the user sees one bubble, not two.
    let intent = r#"{"backendPersisted":true,"turnIntentId":"intent-A"}"#;
    let rows = vec![
        row("user-message-1", Some(USER_MESSAGE_FUNCTION), intent, 1),
        row("user-message-2", Some(USER_MESSAGE_FUNCTION), intent, 2),
        row("assistant-event", Some("assistant_message"), "{}", 3),
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    // The first user_message that opened the round wins as turn_id;
    // both user event ids are tracked.
    assert_eq!(drafts[0].turn_id, "user-message-1");
    assert_eq!(
        drafts[0].user_event_ids,
        vec!["user-message-1".to_string(), "user-message-2".to_string()]
    );
    assert_eq!(drafts[0].event_count, 3);
    assert_eq!(drafts[0].body_event_count, 1);
}

#[test]
fn rows_with_stale_intent_are_dropped() {
    // Reproduces the Stop + model switch + Send Now path: the first
    // submit's intent was retired (stale) before its user_message
    // row was even persisted. The indexer must not paint a phantom
    // round for it.
    let stale = r#"{"backendPersisted":true,"turnIntentId":"intent-stale"}"#;
    let fresh = r#"{"backendPersisted":true,"turnIntentId":"intent-fresh"}"#;
    let rows = vec![
        row("user-message-stale", Some(USER_MESSAGE_FUNCTION), stale, 1),
        row("user-message-fresh", Some(USER_MESSAGE_FUNCTION), fresh, 2),
        row("assistant-event", Some("assistant_message"), "{}", 3),
    ];

    let mut stale_ids = StaleIntentIds::new();
    stale_ids.insert("intent-stale".to_string());
    let drafts = build_turn_drafts(&rows, &stale_ids);

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].turn_id, "user-message-fresh");
}

#[test]
fn rows_with_distinct_turn_intent_ids_stay_separate() {
    let intent_a = r#"{"backendPersisted":true,"turnIntentId":"intent-A"}"#;
    let intent_b = r#"{"backendPersisted":true,"turnIntentId":"intent-B"}"#;
    let rows = vec![
        row("user-message-a", Some(USER_MESSAGE_FUNCTION), intent_a, 1),
        row("assistant-1", Some("assistant_message"), "{}", 2),
        row("user-message-b", Some(USER_MESSAGE_FUNCTION), intent_b, 3),
        row("assistant-2", Some("assistant_message"), "{}", 4),
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 2);
    assert_eq!(drafts[0].turn_id, "user-message-a");
    assert_eq!(drafts[1].turn_id, "user-message-b");
}

#[test]
fn round_metadata_is_projected_by_orgtrack_from_normalized_provider_events() {
    let mut read = row("read-1", Some("Read"), "{}", 2);
    read.args_json = r#"{"file_path":"src/lib.rs"}"#.to_string();
    let mut search = row(
        "search-1",
        Some("Grep"),
        r#"{"matches":[{"file":"src/lib.rs"},{"file":"src/main.rs"}]}"#,
        3,
    );
    search.args_json = r#"{"path":"src"}"#.to_string();
    let rows = vec![
        row(
            "user-message-1",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"backendPersisted":true}"#,
            1,
        ),
        read,
        search,
    ];

    let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

    assert_eq!(drafts.len(), 1);
    assert!(drafts[0]
        .metadata_accumulator
        .resource_interactions()
        .iter()
        .any(|item| item.path == "src/lib.rs" && item.action.as_str() == "read"));
    // search-rows: the Grep is projected away entirely, so `src/main.rs` —
    // named only by that search's matches — never reaches the index.
    assert!(!drafts[0]
        .metadata_accumulator
        .resource_interactions()
        .iter()
        .any(|item| item.action.as_str() == "search"));
    assert!(!drafts[0]
        .metadata_accumulator
        .resource_interactions()
        .iter()
        .any(|item| item.path == "src/main.rs"));
}

#[cfg(unix)]
fn peak_rss_bytes() -> usize {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    assert_eq!(result, 0, "getrusage failed");
    let peak = unsafe { usage.assume_init() }.ru_maxrss as usize;
    #[cfg(target_os = "macos")]
    {
        peak
    }
    #[cfg(not(target_os = "macos"))]
    {
        peak.saturating_mul(1024)
    }
}

/// Real-machine acceptance harness for the v10/v11 -> current turn-index
/// migration that originally exposed #443's multi-gigabyte peak. The
/// caller must point `ORGII_HOME` at a disposable copy under the operating
/// system temp directory; the safety assertion runs before opening SQLite.
#[cfg(unix)]
#[test]
#[ignore = "#443 real DB migration/RSS acceptance; requires a disposable ORGII_HOME copy"]
fn real_db_turn_index_migrates_and_reopens_with_bounded_rss() {
    let session_id = std::env::var("ORGII_ISSUE_443_REAL_SESSION_ID")
        .expect("set ORGII_ISSUE_443_REAL_SESSION_ID to the large copied session");
    let orgii_home = std::env::var_os("ORGII_HOME")
        .map(std::path::PathBuf::from)
        .expect("set ORGII_HOME to a disposable real-DB copy");
    let canonical_home =
        std::fs::canonicalize(&orgii_home).expect("canonicalize disposable real-DB copy home");
    let canonical_temp = std::fs::canonicalize(std::env::temp_dir())
        .expect("canonicalize operating system temp directory");
    #[cfg(target_os = "macos")]
    let is_macos_private_tmp = canonical_home.starts_with("/private/tmp");
    #[cfg(not(target_os = "macos"))]
    let is_macos_private_tmp = false;
    assert!(
        canonical_home.starts_with(&canonical_temp) || is_macos_private_tmp,
        "refusing to mutate a real DB outside the temp directory: {}",
        canonical_home.display()
    );
    let db_path = canonical_home.join("sessions.db");
    assert!(
        db_path.is_file(),
        "missing copied DB: {}",
        db_path.display()
    );

    let read_only = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("open copied DB read-only for the pre-migration state");
    let before_version: i64 = read_only
        .query_row(
            "SELECT index_version FROM session_turn_index_state WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .expect("read pre-migration turn-index version");
    let event_count: i64 = read_only
        .query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .expect("count copied session events");
    drop(read_only);

    let baseline_peak = peak_rss_bytes();
    let first_started = std::time::Instant::now();
    let first = load_turn_index(&session_id).expect("migrate and load copied turn index");
    let first_elapsed = first_started.elapsed();
    let first_peak = peak_rss_bytes();
    let first_growth = first_peak.saturating_sub(baseline_peak);
    assert!(!first.is_empty(), "copied large session must contain turns");

    let conn = get_connection().expect("reopen copied sessions DB after migration");
    let (indexed_event_count, after_version): (i64, i64) = conn
        .query_row(
            "SELECT indexed_event_count, index_version
                   FROM session_turn_index_state
                  WHERE session_id = ?1",
            [&session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read migrated turn-index state");
    drop(conn);
    assert_eq!(indexed_event_count, event_count);
    assert_eq!(after_version, TURN_INDEX_VERSION);

    let reopen_started = std::time::Instant::now();
    let reopened = load_turn_index(&session_id).expect("reopen current copied turn index");
    let reopen_elapsed = reopen_started.elapsed();
    let reopened_peak = peak_rss_bytes();
    assert_eq!(reopened.len(), first.len());
    assert_eq!(
        reopened.first().map(|turn| &turn.turn_id),
        first.first().map(|turn| &turn.turn_id)
    );
    assert_eq!(
        reopened.last().map(|turn| &turn.turn_id),
        first.last().map(|turn| &turn.turn_id)
    );
    assert!(
        first_growth <= 400 * 1024 * 1024,
        "real DB first open grew peak RSS by {first_growth} bytes"
    );

    eprintln!(
            "#443 real DB: session={session_id}, events={event_count}, turns={}, index v{before_version}->v{after_version}, first_open={first_elapsed:?}, reopen={reopen_elapsed:?}, baseline_peak={:.1} MiB, first_peak={:.1} MiB, reopened_peak={:.1} MiB, first_growth={:.1} MiB",
            first.len(),
            baseline_peak as f64 / (1024.0 * 1024.0),
            first_peak as f64 / (1024.0 * 1024.0),
            reopened_peak as f64 / (1024.0 * 1024.0),
            first_growth as f64 / (1024.0 * 1024.0),
        );
}
