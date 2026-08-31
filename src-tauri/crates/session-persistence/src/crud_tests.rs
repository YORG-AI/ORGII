use super::*;
use rusqlite::params;

fn with_temp_orgii_home<R>(run: impl FnOnce() -> R) -> R {
    // Tolerate poison so that one panicking test doesn't take down
    // every other test that shares the ORGII_HOME env var.
    let _guard = match crate::ORGII_HOME_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let previous = std::env::var("ORGII_HOME").ok();
    let root = std::env::temp_dir().join(format!(
        "orgii-session-persistence-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create temp ORGII_HOME");
    std::env::set_var("ORGII_HOME", &root);
    let result = run();
    match previous {
        Some(value) => std::env::set_var("ORGII_HOME", value),
        None => std::env::remove_var("ORGII_HOME"),
    }
    let _ = std::fs::remove_dir_all(&root);
    result
}

fn cached_event(session_id: &str, id: &str, created_at: &str) -> CachedEvent {
    CachedEvent {
        id: id.to_string(),
        session_id: session_id.to_string(),
        event_type: "raw".to_string(),
        function_name: Some("user_message".to_string()),
        thread_id: None,
        args_json: "{}".to_string(),
        result_json: "{}".to_string(),
        content: id.to_string(),
        created_at: created_at.to_string(),
        meta_json: None,
        history_sequence: None,
    }
}

#[test]
fn save_events_incremental_batch_does_not_shrink_cached_time_range() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        drop(conn);

        let session_id = "incremental-range-session";
        let t1 = "2026-07-17T00:00:01.000Z";
        let t2 = "2026-07-17T00:00:02.000Z";
        let t3 = "2026-07-17T00:00:03.000Z";

        save_events(
            session_id,
            &[
                cached_event(session_id, "event-1", t1),
                cached_event(session_id, "event-3", t3),
            ],
        )
        .expect("seed oldest and newest events");
        save_events(session_id, &[cached_event(session_id, "event-2", t2)])
            .expect("save an incremental middle event");

        let metadata = get_session_metadata(session_id)
            .expect("load session metadata")
            .expect("session metadata exists");
        assert_eq!(metadata.event_count, 3);
        assert_eq!(metadata.time_range_start.as_deref(), Some(t1));
        assert_eq!(metadata.time_range_end.as_deref(), Some(t3));
    });
}

#[test]
fn content_revision_advances_only_when_transcript_content_changes() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        drop(conn);

        let session_id = "durable-content-revision-session";
        let event = cached_event(session_id, "event-1", "2026-07-17T00:00:01.000Z");
        save_events(session_id, std::slice::from_ref(&event)).expect("seed event");
        let first = get_session_metadata(session_id)
            .expect("read first revision")
            .expect("metadata exists")
            .content_revision;

        save_events(session_id, std::slice::from_ref(&event)).expect("resubmit unchanged event");
        let unchanged = get_session_metadata(session_id)
            .expect("read unchanged revision")
            .expect("metadata exists")
            .content_revision;
        assert_eq!(unchanged, first);

        let mut changed = event;
        changed.content = "changed".to_string();
        save_events(session_id, &[changed]).expect("update event content");
        let updated = get_session_metadata(session_id)
            .expect("read updated revision")
            .expect("metadata exists")
            .content_revision;
        assert!(updated > unchanged);
    });
}

#[test]
fn deferred_import_publishes_metadata_only_when_finalized() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        drop(conn);

        let session_id = "deferred-import-session";
        let t1 = "2026-07-17T00:00:01.000Z";
        let t2 = "2026-07-17T00:00:02.000Z";
        let t3 = "2026-07-17T00:00:03.000Z";

        save_events_deferred(
            session_id,
            &[
                cached_event(session_id, "event-1", t1),
                cached_event(session_id, "event-2", t2),
            ],
        )
        .expect("append first import page");
        save_events_deferred(session_id, &[cached_event(session_id, "event-3", t3)])
            .expect("append second import page");

        assert!(
            get_session_metadata(session_id)
                .expect("read unpublished metadata")
                .is_none(),
            "partial imports must not become visible as complete sessions"
        );

        let finalized =
            finalize_deferred_event_import(session_id).expect("finalize deferred import");
        assert_eq!(finalized, 3);
        let metadata = get_session_metadata(session_id)
            .expect("load finalized metadata")
            .expect("finalized metadata exists");
        assert_eq!(metadata.event_count, 3);
        assert_eq!(metadata.time_range_start.as_deref(), Some(t1));
        assert_eq!(metadata.time_range_end.as_deref(), Some(t3));
        assert_eq!(
            load_events(session_id)
                .expect("load finalized events")
                .into_iter()
                .map(|event| event.id)
                .collect::<Vec<_>>(),
            ["event-1", "event-2", "event-3"]
        );
    });
}

#[test]
fn count_events_counts_without_loading() {
    with_temp_orgii_home(|| {
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema");
        }
        let session_id = "count-events-session";
        assert_eq!(count_events(session_id).expect("count empty"), 0);
        save_events(
            session_id,
            &[
                cached_event(session_id, "event-1", "2026-07-17T00:00:01.000Z"),
                cached_event(session_id, "event-2", "2026-07-17T00:00:02.000Z"),
            ],
        )
        .expect("seed events");
        assert_eq!(count_events(session_id).expect("count seeded"), 2);
        assert_eq!(
            count_events("some-other-session").expect("count unrelated"),
            0
        );
    });
}

#[test]
fn save_events_replacement_recomputes_cached_time_range_from_all_events() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        drop(conn);

        let session_id = "replacement-range-session";
        let t1 = "2026-07-17T00:00:01.000Z";
        let t2 = "2026-07-17T00:00:02.000Z";
        let t3 = "2026-07-17T00:00:03.000Z";
        let t4 = "2026-07-17T00:00:04.000Z";

        save_events(
            session_id,
            &[
                cached_event(session_id, "event-1", t1),
                cached_event(session_id, "event-2", t2),
                cached_event(session_id, "event-3", t3),
            ],
        )
        .expect("seed three events");

        save_events(session_id, &[cached_event(session_id, "event-1", t4)])
            .expect("replace the oldest event with a newer timestamp");

        let metadata = get_session_metadata(session_id)
            .expect("load session metadata")
            .expect("session metadata exists");
        assert_eq!(metadata.event_count, 3);
        assert_eq!(metadata.time_range_start.as_deref(), Some(t2));
        assert_eq!(metadata.time_range_end.as_deref(), Some(t4));
    });
}

#[test]
fn load_events_normalizes_legacy_writer_order_sequences() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        // `load_turn_index` runs `backfill_missing_user_events`, which
        // reads from `agent_messages`. That table is owned by the
        // `agent-core` schema layer in production, but this crate's
        // test fixture has to mirror it locally so the query
        // resolves.
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
        .expect("create agent_messages fixture table");
        let session_id = "legacy-sequence-session";

        conn.execute(
            "INSERT INTO events
                 (id, session_id, event_type, function_name, thread_id,
                  args_json, result_json, content, created_at, meta_json, history_sequence)
                 VALUES (?1, ?2, 'raw', ?3, NULL, '{}', '{}', ?4, ?5, NULL, ?6)",
            params![
                "tool-1",
                session_id,
                "tool_call",
                "tool first by writer order",
                "2026-05-20T00:00:01.000Z",
                0_i64,
            ],
        )
        .expect("insert tool event");
        conn.execute(
            "INSERT INTO events
                 (id, session_id, event_type, function_name, thread_id,
                  args_json, result_json, content, created_at, meta_json, history_sequence)
                 VALUES (?1, ?2, 'raw', ?3, NULL, '{}', '{}', ?4, ?5, NULL, ?6)",
            params![
                "user-1",
                session_id,
                "user_message",
                "user started earlier",
                "2026-05-20T00:00:00.000Z",
                3_i64,
            ],
        )
        .expect("insert user event");
        drop(conn);

        let events = load_events(session_id).expect("load events");
        assert_eq!(events[0].id, "user-1");
        assert_eq!(events[0].history_sequence, Some(0));
        assert_eq!(events[1].id, "tool-1");
        assert_eq!(events[1].history_sequence, Some(1));

        let turns = super::super::turn_index::load_turn_index(session_id)
            .expect("load normalized turn index");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].turn_id, "user-1");
        assert_eq!(turns[0].start_sequence, 0);
    });
}

/// Concurrent `save_events` on the same session from many threads
/// must not return `database is locked`.
///
/// Before the writer-mutex fix this regularly produced
/// `SQLITE_BUSY` once N (here 12) threads each issued ~25
/// back-to-back `save_events` calls against the same db file. With
/// the process-wide writer serializer + `BEGIN IMMEDIATE`, every
/// write queues in Rust and the file lock sees exactly one writer
/// at a time, so every call must succeed.
#[test]
fn save_events_under_contention_never_returns_database_locked() {
    with_temp_orgii_home(|| {
        // Initialise schema once; per-thread `get_connection()`
        // calls reuse the same db file.
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema");
        }

        const NUM_THREADS: usize = 12;
        const WRITES_PER_THREAD: usize = 25;
        let session_id = "contention-session";

        let mut handles = Vec::with_capacity(NUM_THREADS);
        for thread_idx in 0..NUM_THREADS {
            let sid = session_id.to_string();
            handles.push(std::thread::spawn(move || -> Result<(), String> {
                for write_idx in 0..WRITES_PER_THREAD {
                    let event_id = format!("evt-{thread_idx}-{write_idx}");
                    let created_at = format!(
                        "2026-06-05T00:00:{:02}.{:03}Z",
                        write_idx % 60,
                        thread_idx * 10
                    );
                    let event = CachedEvent {
                        id: event_id,
                        session_id: sid.clone(),
                        event_type: "raw".to_string(),
                        function_name: Some("user_message".to_string()),
                        thread_id: None,
                        args_json: "{}".to_string(),
                        result_json: "{}".to_string(),
                        content: format!("write {thread_idx}/{write_idx}"),
                        created_at,
                        meta_json: None,
                        history_sequence: None,
                    };
                    save_events(&sid, &[event])
                        .map_err(|err| format!("thread {thread_idx} write {write_idx}: {err}"))?;
                }
                Ok(())
            }));
        }

        for handle in handles {
            handle
                .join()
                .expect("worker thread panicked")
                .expect("save_events under contention");
        }

        // Sanity check: every write landed.
        let events = load_events(session_id).expect("load events");
        assert_eq!(
            events.len(),
            NUM_THREADS * WRITES_PER_THREAD,
            "expected every concurrent save to persist"
        );
    });
}

fn test_event(id: &str, session_id: &str, content: &str, created_at: &str) -> CachedEvent {
    CachedEvent {
        id: id.to_string(),
        session_id: session_id.to_string(),
        event_type: "raw".to_string(),
        function_name: Some("user_message".to_string()),
        thread_id: None,
        args_json: "{}".to_string(),
        result_json: "{}".to_string(),
        content: content.to_string(),
        created_at: created_at.to_string(),
        meta_json: None,
        history_sequence: None,
    }
}

fn event_rowids(conn: &Connection, session_id: &str) -> Vec<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT id, rowid FROM events WHERE session_id = ?1 ORDER BY id")
        .expect("prepare rowid query");
    stmt.query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query rowids")
        .collect::<SqliteResult<Vec<_>>>()
        .expect("collect rowids")
}

/// Re-saving an identical batch must be a write no-op (rowids survive —
/// `INSERT OR REPLACE` would have cycled delete + insert and minted new
/// ones), while a genuinely changed event updates in place.
#[test]
fn resaving_identical_batch_preserves_rowids_and_changed_rows_update_in_place() {
    with_temp_orgii_home(|| {
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema");
        }
        let session_id = "upsert-noop-session";
        let batch = vec![
            test_event(
                "evt-a",
                session_id,
                "first message",
                "2026-07-16T00:00:00.000Z",
            ),
            test_event(
                "evt-b",
                session_id,
                "second message",
                "2026-07-16T00:00:01.000Z",
            ),
        ];

        save_events(session_id, &batch).expect("initial save");
        let conn = get_connection().expect("open sessions DB");
        let rowids_before = event_rowids(&conn, session_id);
        assert_eq!(rowids_before.len(), 2);

        // Identical re-submission (history_sequence None, exactly what the
        // frontend sends after a reload) must not rewrite any row.
        save_events(session_id, &batch).expect("identical re-save");
        let rowids_after = event_rowids(&conn, session_id);
        assert_eq!(
            rowids_before, rowids_after,
            "identical re-save must preserve rowids"
        );

        // A real content change updates the row in place.
        let mut changed = batch.clone();
        changed[1].content = "second message, edited".to_string();
        save_events(session_id, &changed).expect("changed re-save");

        let rowids_final = event_rowids(&conn, session_id);
        assert_eq!(
            rowids_before, rowids_final,
            "in-place update must preserve rowids"
        );
        let events = load_events(session_id).expect("load events");
        assert_eq!(events[0].content, "first message");
        assert_eq!(events[1].content, "second message, edited");
        // Server-assigned sequences survive the None re-submission.
        assert_eq!(events[0].history_sequence, Some(0));
        assert_eq!(events[1].history_sequence, Some(1));
    });
}

/// LIKE fallback search: literal `%`/`_` in the query must not act as
/// wildcards, matching is ASCII-case-insensitive, and the snippet wraps
/// the hit in `<mark>` tags like the FTS-era `snippet()` output.
#[test]
fn like_search_escapes_wildcards_and_builds_marked_excerpts() {
    with_temp_orgii_home(|| {
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema");
        }
        let session_id = "like-search-session";
        let batch = vec![
            test_event(
                "evt-discount",
                session_id,
                "offering a 50% discount today",
                "2026-07-16T01:00:00.000Z",
            ),
            test_event(
                "evt-number",
                session_id,
                "the answer is 508 exactly",
                "2026-07-16T01:00:01.000Z",
            ),
        ];
        save_events(session_id, &batch).expect("save events");

        // "50%" must match only the literal occurrence, not "508".
        let hits = search_events(session_id, "50%", 10).expect("search literal percent");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event.id, "evt-discount");
        assert!(hits[0].snippet.contains("<mark>50%</mark>"));

        // ASCII-case-insensitive matching.
        let hits = search_events(session_id, "DISCOUNT", 10).expect("search case-folded");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event.id, "evt-discount");

        // Cross-session search returns one hit for the session.
        let all = search_all_sessions("discount", 10).expect("search all sessions");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].session_id, session_id);
        assert!(all[0].snippet.contains("<mark>discount</mark>"));
    });
}

#[test]
fn cross_session_search_includes_human_session_notes() {
    with_temp_orgii_home(|| {
        let conn = get_connection().expect("open sessions DB");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
                 CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);",
        )
        .expect("create canonical session parent");
        super::super::schema::init_session_tables(&conn).expect("init session schema");
        conn.execute(
            "INSERT INTO agent_sessions (session_id) VALUES (?1)",
            ["humansession-search-notes"],
        )
        .expect("insert Human session parent");
        conn.execute(
            "INSERT INTO human_session_entries
                 (id, session_id, body, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
            params![
                "humanentry-search-notes",
                "humansession-search-notes",
                "Remember to update index.ts before release",
                "2026-07-30T02:00:00.000Z"
            ],
        )
        .expect("insert Human session note");
        drop(conn);
        save_events(
            "humansession-search-notes",
            &[test_event(
                "event-search-notes",
                "humansession-search-notes",
                "An older index.ts mention",
                "2026-07-30T01:00:00.000Z",
            )],
        )
        .expect("insert older matching event");

        let hits = search_all_sessions("index.ts", 10).expect("search Human session notes");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "humansession-search-notes");
        assert!(
            hits[0]
                .snippet
                .contains("Remember to update <mark>index.ts</mark>"),
            "the newest matching Human note should win over an older event"
        );
    });
}

#[test]
fn cross_session_search_skips_empty_and_non_positive_requests() {
    with_temp_orgii_home(|| {
        assert!(search_all_sessions("   ", 30)
            .expect("skip blank search")
            .is_empty());
        assert!(search_all_sessions("content", 0)
            .expect("skip zero-limit search")
            .is_empty());
    });
}
