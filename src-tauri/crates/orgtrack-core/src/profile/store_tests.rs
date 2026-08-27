use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("memory db");
    init_tables(&conn).expect("schema");
    conn
}

fn sample(id: &str) -> SessionSignals {
    SessionSignals {
        session_id: id.into(),
        source: "claude_code".into(),
        signals_version: SIGNALS_VERSION,
        started_at_ms: 1_700_000_000_000,
        active_secs: 120.0,
        active_spans: vec![(1_700_000_000_000, 1_700_000_120_000)],
        has_edit: true,
        postedit_turns: 2,
        tools_per_user: 14.0,
        ..Default::default()
    }
}

#[test]
fn round_trips_through_sqlite() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("upsert");
    let out = load_signals(&conn, &[], None, 10).expect("load");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].session_id, "a");
    assert_eq!(out[0].tools_per_user, 14.0);
    assert_eq!(out[0].active_spans.len(), 1);
}

#[test]
fn upsert_replaces_rather_than_duplicates() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("first");
    let mut second = sample("a");
    second.tools_per_user = 99.0;
    upsert(&conn, &second).expect("second");
    let out = load_signals(&conn, &[], None, 10).expect("load");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].tools_per_user, 99.0);
}

#[test]
fn a_version_bump_invalidates_cached_rows() {
    let conn = db();
    let mut old = sample("a");
    old.signals_version = SIGNALS_VERSION - 1;
    upsert(&conn, &old).expect("upsert");
    assert!(
        load_signals(&conn, &[], None, 10).expect("load").is_empty(),
        "stale rows must not be served"
    );
    assert_eq!(coverage(&conn).expect("coverage").stale, 1);
}

#[test]
fn source_filter_and_time_filter_apply() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("a");
    let mut b = sample("b");
    b.source = "cursor_ide".into();
    b.started_at_ms = 1_600_000_000_000;
    upsert(&conn, &b).expect("b");

    let only_cursor = load_signals(&conn, &["cursor_ide".into()], None, 10).expect("load");
    assert_eq!(only_cursor.len(), 1);
    assert_eq!(only_cursor[0].session_id, "b");

    let recent = load_signals(&conn, &[], Some(1_650_000_000_000), 10).expect("load");
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].session_id, "a");
}

#[test]
fn a_cached_payload_is_served_only_for_the_corpus_that_produced_it() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("seed");
    let fp1 = corpus_fingerprint(&conn).expect("fingerprint");
    put_payload(&conn, "overview|", &fp1, "{\"cached\":true}").expect("put");
    assert_eq!(
        cached_payload(&conn, "overview|", &fp1)
            .expect("get")
            .as_deref(),
        Some("{\"cached\":true}")
    );

    // A new session changes the corpus, so the old payload must not be served.
    upsert(&conn, &sample("b")).expect("second session");
    let fp2 = corpus_fingerprint(&conn).expect("fingerprint");
    assert_ne!(fp1, fp2, "adding a session must change the fingerprint");
    assert!(cached_payload(&conn, "overview|", &fp2)
        .expect("get")
        .is_none());
}

#[test]
fn each_scope_caches_separately() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("seed");
    let fp = corpus_fingerprint(&conn).expect("fingerprint");
    put_payload(&conn, "overview|all", &fp, "A").expect("put");
    put_payload(&conn, "overview|cursor_ide", &fp, "B").expect("put");
    assert_eq!(
        cached_payload(&conn, "overview|all", &fp)
            .expect("get")
            .as_deref(),
        Some("A")
    );
    assert_eq!(
        cached_payload(&conn, "overview|cursor_ide", &fp)
            .expect("get")
            .as_deref(),
        Some("B")
    );
}

#[test]
fn a_signals_version_bump_invalidates_the_payload_cache_too() {
    let conn = db();
    upsert(&conn, &sample("a")).expect("seed");
    let fp = corpus_fingerprint(&conn).expect("fingerprint");
    assert!(
        fp.starts_with(&format!("{SIGNALS_VERSION}:")),
        "fingerprint must carry the extractor version, got {fp}"
    );
}

#[test]
fn an_older_table_gains_columns_added_after_it_shipped() {
    // A database created before `unreadable` existed. CREATE TABLE IF NOT
    // EXISTS will not touch it, so without the additive migration every
    // read fails with "no such column".
    let conn = Connection::open_in_memory().expect("memory db");
    conn.execute_batch(
        "CREATE TABLE orgtrack_core_session_signals (
                 session_id TEXT PRIMARY KEY,
                 source TEXT NOT NULL,
                 signals_version INTEGER NOT NULL,
                 started_at_ms INTEGER NOT NULL DEFAULT 0,
                 active_secs REAL NOT NULL DEFAULT 0,
                 active_spans_json TEXT NOT NULL DEFAULT '[]',
                 has_edit INTEGER NOT NULL DEFAULT 0,
                 postedit_turns INTEGER NOT NULL DEFAULT 0,
                 signals_json TEXT NOT NULL,
                 computed_at TEXT NOT NULL
             );",
    )
    .expect("legacy schema");

    init_tables(&conn).expect("migrate");
    upsert(&conn, &sample("a")).expect("upsert");
    let out = load_signals(&conn, &[], None, 10).expect("read must not fail");
    assert_eq!(out.len(), 1);
    assert_eq!(coverage(&conn).expect("coverage").unreadable, 0);
}

#[test]
fn migrating_twice_is_harmless() {
    let conn = db();
    init_tables(&conn).expect("second init");
    init_tables(&conn).expect("third init");
    upsert(&conn, &sample("a")).expect("upsert");
    assert_eq!(load_signals(&conn, &[], None, 10).expect("read").len(), 1);
}

#[test]
fn backfill_is_a_no_op_without_the_imported_cache() {
    let conn = db();
    assert_eq!(backfill_session_signals(&conn, 10).expect("backfill"), 0);
}

#[test]
fn a_tombstone_is_excluded_from_readers_but_completes_coverage() {
    let conn = db();
    upsert(&conn, &sample("good")).expect("good row");
    mark_unreadable(&conn, "broken").expect("tombstone");

    let served = load_signals(&conn, &[], None, 10).expect("load");
    assert_eq!(served.len(), 1, "tombstones must never be scored");
    assert_eq!(served[0].session_id, "good");

    let cov = coverage(&conn).expect("coverage");
    assert_eq!(cov.extracted, 2, "a tombstone still counts as processed");
    assert_eq!(cov.unreadable, 1);
}

#[test]
fn unreadable_sessions_do_not_stall_the_backfill() {
    let conn = db();
    // A minimal imported cache with sessions that have no transcript at
    // all: every one of them is unreadable by construction.
    conn.execute_batch(
        "CREATE TABLE imported_history_session_cache (
                 session_id TEXT PRIMARY KEY,
                 source TEXT NOT NULL,
                 created_at_ms INTEGER NOT NULL
             );
             INSERT INTO imported_history_session_cache VALUES
                 ('u1', 'cursor_ide', 3), ('u2', 'cursor_ide', 2), ('u3', 'cursor_ide', 1);",
    )
    .expect("seed imported cache");

    let first = backfill_session_signals(&conn, 10).expect("first pass");
    assert_eq!(
            first, 3,
            "unreadable sessions must still count as processed, or the drain loop stops with a stranded backlog"
        );
    let second = backfill_session_signals(&conn, 10).expect("second pass");
    assert_eq!(
        second, 0,
        "tombstoned sessions must leave the candidate set"
    );
    assert_eq!(coverage(&conn).expect("coverage").unreadable, 3);
}
