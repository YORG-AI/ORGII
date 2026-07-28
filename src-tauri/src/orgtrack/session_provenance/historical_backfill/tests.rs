use super::*;
use orgtrack_core::sources::imported_history::metadata::ImportedHistoryImpactStats;
use orgtrack_core::store::sqlite::SqliteRecordStore;

#[test]
fn historical_backfill_uses_every_registered_imported_source() {
    assert_eq!(
        historical_imported_sources().collect::<Vec<_>>(),
        ImportedHistorySourceId::ALL
    );
}

fn imported_session_with_touched_files(touched_files: Vec<String>) -> ImportedHistoryCachedSession {
    ImportedHistoryCachedSession {
        source_session_id: "source-session".to_string(),
        session_id: "codexapp-source-session".to_string(),
        source_path: "/tmp/rollout.jsonl".to_string(),
        source_record_key: "source-session".to_string(),
        source_mtime_ms: 1,
        source_size_bytes: 1,
        source_fingerprint: "fingerprint".to_string(),
        parser_version: 1,
        name: "Imported session".to_string(),
        created_at_ms: 1,
        updated_at_ms: 1,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        repo_path: Some("/repo".to_string()),
        repo_root_path: None,
        repo_remote_urls: Vec::new(),
        branch: None,
        impact: ImportedHistoryImpactStats {
            files_changed: touched_files.len() as i64,
            touched_files,
            ..ImportedHistoryImpactStats::default()
        },
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

#[test]
fn quiescence_normalizes_current_nanoseconds_and_legacy_milliseconds() {
    let now_ms = 1_800_000_000_000_i64;
    let quiet_ms = now_ms - SESSION_QUIESCENCE_MS - 1;
    let active_ms = now_ms - SESSION_QUIESCENCE_MS + 1;
    let mut session = imported_session_with_touched_files(Vec::new());

    session.source_mtime_ms = quiet_ms;
    assert!(session_is_quiescent(&session, now_ms));
    session.source_mtime_ms = quiet_ms * 1_000_000;
    assert!(session_is_quiescent(&session, now_ms));

    session.source_mtime_ms = active_ms;
    assert!(!session_is_quiescent(&session, now_ms));
    session.source_mtime_ms = active_ms * 1_000_000;
    assert!(!session_is_quiescent(&session, now_ms));
}

#[test]
fn periodic_codex_recovery_skips_hooked_and_completed_sessions() {
    let now_ms = 1_800_000_000_000_i64;
    let mut session = imported_session_with_touched_files(Vec::new());
    session.source_mtime_ms = (now_ms - 60_000) * 1_000_000;

    assert!(periodic_codex_reconciliation_needed(
        &session, false, now_ms
    ));
    assert!(!periodic_codex_reconciliation_needed(
        &session, true, now_ms
    ));

    session.source_mtime_ms = (now_ms - SESSION_QUIESCENCE_MS - 1) * 1_000_000;
    assert!(!periodic_codex_reconciliation_needed(
        &session, false, now_ms
    ));
}

#[test]
fn priority_file_matching_requires_the_catalog_to_preserve_relative_paths() {
    let repo = Path::new("/repo");
    let relative = imported_session_with_touched_files(vec!["src/new.rs".to_string()]);
    let absolute = imported_session_with_touched_files(vec!["/repo/src/new.rs".to_string()]);
    let basename_only = imported_session_with_touched_files(vec!["new.rs".to_string()]);

    assert!(session_touches_priority_file(&relative, repo, "src/new.rs"));
    assert!(session_touches_priority_file(&absolute, repo, "src/new.rs"));
    assert!(!session_touches_priority_file(
        &basename_only,
        repo,
        "src/new.rs"
    ));
}

#[test]
fn historical_backfill_prepares_three_lazy_kv_turns_before_publish() {
    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let directory = tempfile::tempdir().expect("lazy backfill fixture");
        let source_path = directory.path().join(format!("{}.db", source.as_str()));
        let source_conn = Connection::open(&source_path).expect("KV source DB");
        source_conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                     CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("KV source schema");
        let headers = (0..6)
            .map(|index| {
                serde_json::json!({
                    "bubbleId":format!("b{index}"),
                    "type":if index % 2 == 0 { 1 } else { 2 },
                })
            })
            .collect::<Vec<_>>();
        source_conn
            .execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES('composerData:c1',?1)",
                [serde_json::json!({
                    "composerId":"c1",
                    "createdAt":1,
                    "lastUpdatedAt":6,
                    "fullConversationHeadersOnly":headers,
                })
                .to_string()],
            )
            .expect("composer row");
        for index in 0..6 {
            source_conn
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                    rusqlite::params![
                        format!("bubbleId:c1:b{index}"),
                        serde_json::json!({
                            "bubbleId":format!("b{index}"),
                            "type":if index % 2 == 0 { 1 } else { 2 },
                            "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                            "text":format!("message {index}"),
                        })
                        .to_string(),
                    ],
                )
                .expect("bubble row");
        }

        let mut cache = Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&cache).expect("Orgtrack tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        let session_id = format!("{}c1", source.descriptor().session_prefix);
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                         source,source_session_id,session_id,source_path
                     ) VALUES(?1,'c1',?2,?3)",
                rusqlite::params![source.as_str(), session_id, source_path.to_string_lossy()],
            )
            .expect("cache source path");
        let session = ImportedHistoryCachedSession {
            source_session_id: "c1".to_string(),
            session_id: session_id.clone(),
            source_path: source_path.to_string_lossy().into_owned(),
            source_record_key: "c1".to_string(),
            source_mtime_ms: 1,
            source_size_bytes: std::fs::metadata(&source_path)
                .expect("source metadata")
                .len() as i64,
            source_fingerprint: "lazy-three-turns".to_string(),
            parser_version: source.descriptor().parser_version as i64,
            name: "Lazy KV session".to_string(),
            created_at_ms: 1,
            updated_at_ms: 6,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            repo_path: Some(directory.path().to_string_lossy().into_owned()),
            repo_root_path: None,
            repo_remote_urls: Vec::new(),
            branch: None,
            impact: ImportedHistoryImpactStats::default(),
            listable: true,
            source_metadata_json: None,
            parent_session_id: None,
        };

        assert!(reconcile_imported_session(
            &mut cache,
            source.as_str(),
            directory.path(),
            &session,
            ActiveSessionPolicy::AllowActive,
        )
        .expect("publish strict lazy provenance snapshot"));
        let replay_events = cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_events
                     WHERE source=?1 AND source_session_id='c1'",
                [source.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count prepared replay events");
        assert_eq!(replay_events, 6, "{}", source.as_str());
        assert!(SqliteRecordStore::new(&cache)
            .interaction_import_is_current(
                source.as_str(),
                &session_id,
                &imported_session_fingerprint(&session),
                HISTORICAL_INTERACTION_PARSER_VERSION,
            )
            .expect("backfill checkpoint"));
    }
}

#[test]
fn durable_backfill_claim_joins_current_process_and_reclaims_previous_process() {
    let mut conn = Connection::open_in_memory().expect("in-memory SQLite");
    SqliteRecordStore::init_tables(&conn).expect("initialize Orgtrack schema");

    let (first, first_token) =
        claim_backfill_job(&mut conn, "/repo").expect("claim first durable backfill");
    let first_token = first_token.expect("first request owns the job");
    assert_eq!(first.status, HistoricalBackfillStatus::Queued);

    let (joined, joined_token) =
        claim_backfill_job(&mut conn, "/repo").expect("join active durable backfill");
    assert!(joined.is_active());
    assert_eq!(joined.run_token, first_token);
    assert!(joined_token.is_none());

    conn.execute(
        "UPDATE orgtrack_core_interaction_backfill_jobs
             SET status = 'indexing', run_token = 'previous-process:run', updated_at_ms = ?1
             WHERE repo_key = '/repo'",
        [Utc::now().timestamp_millis()],
    )
    .expect("simulate previous process lease");
    let (reclaimed, reclaimed_token) =
        claim_backfill_job(&mut conn, "/repo").expect("reclaim previous process backfill");
    assert_eq!(reclaimed.status, HistoricalBackfillStatus::Queued);
    assert_ne!(reclaimed.run_token, "previous-process:run");
    assert_eq!(
        reclaimed_token.as_deref(),
        Some(reclaimed.run_token.as_str())
    );
}

#[test]
fn active_codex_reconciliation_is_sparse_but_quiescence_flushes_immediately() {
    let mut throttle = ActiveCodexReconciliationThrottle::default();
    let now_ms = 1_000_000;

    assert!(throttle.should_attempt("active", false, now_ms));
    assert!(!throttle.should_attempt(
        "active",
        false,
        now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS - 1
    ));
    assert!(throttle.should_attempt(
        "active",
        false,
        now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
    ));

    // The final quiet transcript is never delayed by the active throttle.
    assert!(throttle.should_attempt("active", true, now_ms + 1));
    assert!(!throttle.attempted_at_ms.contains_key("active"));
}

#[test]
fn active_codex_reconciliation_throttle_is_bounded_to_recent_sessions() {
    let mut throttle = ActiveCodexReconciliationThrottle::default();
    assert!(throttle.should_attempt("old", false, 1));
    assert!(throttle.should_attempt("recent", false, 1 + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS));

    throttle.retain_recent(["recent"]);

    assert_eq!(throttle.attempted_at_ms.len(), 1);
    assert!(throttle.attempted_at_ms.contains_key("recent"));
}

#[test]
fn active_codex_reconciliation_is_globally_serialized() {
    let mut throttle = ActiveCodexReconciliationThrottle::default();
    let now_ms = 1_000_000;

    assert!(throttle.should_attempt("first", false, now_ms));
    assert!(!throttle.should_attempt(
        "second",
        false,
        now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS - 1
    ));
    assert!(throttle.should_attempt(
        "second",
        false,
        now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
    ));
}

#[test]
fn background_codex_reconciliation_rejects_giant_rollouts() {
    assert!(background_codex_reconciliation_source_is_bounded(
        MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES
    ));
    assert!(!background_codex_reconciliation_source_is_bounded(
        MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES + 1
    ));
}

#[test]
fn codex_discovery_refresh_is_low_frequency() {
    let mut throttle = ActiveCodexReconciliationThrottle::default();
    let now_ms = 1_000_000;

    assert!(throttle.should_refresh_discovery(now_ms));
    assert!(!throttle.should_refresh_discovery(now_ms + CODEX_DISCOVERY_REFRESH_INTERVAL_MS - 1));
    assert!(throttle.should_refresh_discovery(now_ms + CODEX_DISCOVERY_REFRESH_INTERVAL_MS));
}

#[test]
fn active_codex_recovery_waits_for_a_short_writer_quiet_window() {
    let now_ms = 1_000_000;

    assert!(!active_codex_recovery_is_quiet_enough(
        now_ms - ACTIVE_CODEX_MIN_QUIET_MS + 1,
        now_ms
    ));
    assert!(active_codex_recovery_is_quiet_enough(
        now_ms - ACTIVE_CODEX_MIN_QUIET_MS,
        now_ms
    ));
}

#[test]
fn imported_history_source_age_accepts_legacy_milliseconds_and_current_nanoseconds() {
    let now_ms = 1_750_000_000_000;
    let source_ms = now_ms - ACTIVE_CODEX_MIN_QUIET_MS;
    let source_ns = source_ms * 1_000_000;

    assert_eq!(source_age_ms(source_ms, now_ms), ACTIVE_CODEX_MIN_QUIET_MS);
    assert_eq!(source_age_ms(source_ns, now_ms), ACTIVE_CODEX_MIN_QUIET_MS);
    assert!(active_codex_recovery_is_quiet_enough(source_ms, now_ms));
    assert!(active_codex_recovery_is_quiet_enough(source_ns, now_ms));
}
