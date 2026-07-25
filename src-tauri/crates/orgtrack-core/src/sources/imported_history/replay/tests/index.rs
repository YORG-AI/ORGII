use super::*;
use super::{source_identity::*, sync::*};

#[test]
fn every_registered_source_has_one_matching_exhaustive_storage_driver() {
    use super::super::ReplayStorageFamily;

    for source in ImportedHistorySourceId::ALL {
        let family = source.descriptor().storage_family;
        let compatible = match replay_driver_kind(source) {
            ReplayDriverKind::CodexJsonl | ReplayDriverKind::SharedJsonl => {
                family == ReplayStorageFamily::JsonLines
            }
            ReplayDriverKind::Sqlite => matches!(
                family,
                ReplayStorageFamily::SqliteWal | ReplayStorageFamily::SqliteKeyValue
            ),
            ReplayDriverKind::StructuredSqlite => matches!(
                family,
                ReplayStorageFamily::SqliteManifestBlob | ReplayStorageFamily::SqliteTaskBlob
            ),
            ReplayDriverKind::WholeJson => family == ReplayStorageFamily::WholeJson,
        };
        assert!(
            compatible,
            "{} declares {family:?} but routes through {:?}",
            source.as_str(),
            replay_driver_kind(source)
        );
    }
}

fn replay_schema() -> Connection {
    use crate::store::sqlite::SqliteRecordStore;

    let conn = Connection::open_in_memory().expect("replay schema");
    SqliteRecordStore::init_tables(&conn).expect("initialize replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("initialize replay source-cache schema");
    conn
}

#[test]
fn source_resolution_treats_percent_and_underscore_as_literal_suffix_bytes() {
    let conn = replay_schema();
    let source = ImportedHistorySourceId::CodexApp;
    let requested_key = "thread_%";
    let display_session_id = format!("{}{}", source.descriptor().session_prefix, requested_key);
    conn.execute(
        "INSERT INTO imported_history_session_cache(
             source,source_session_id,session_id,source_path,updated_at_ms
         ) VALUES(?1,'rollout-thread-xy','wrong','/tmp/wrong.jsonl',2)",
        [source.as_str()],
    )
    .expect("seed wildcard-shaped near match");

    let error = resolve_source(&conn, source, &display_session_id)
        .expect_err("LIKE wildcard bytes must not match a different source session");
    assert!(error.contains("not indexed yet"));

    conn.execute(
        "INSERT INTO imported_history_session_cache(
             source,source_session_id,session_id,source_path,updated_at_ms
         ) VALUES(?1,?2,'exact','/tmp/exact.jsonl',1)",
        params![source.as_str(), format!("rollout-{requested_key}")],
    )
    .expect("seed literal suffix match");
    let resolved =
        resolve_source(&conn, source, &display_session_id).expect("resolve literal suffix");
    assert_eq!(
        resolved.source_session_id,
        format!("rollout-{requested_key}")
    );
    assert_eq!(resolved.path, PathBuf::from("/tmp/exact.jsonl"));
}

#[test]
fn replay_write_transaction_reserves_writer_before_streaming_reads() {
    let path = std::env::temp_dir().join(format!(
        "orgii-replay-immediate-{}-{}.sqlite",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let mut replay_conn = Connection::open(&path).expect("open replay writer");
    replay_conn
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE probe(value INTEGER);")
        .expect("initialize writer probe");
    replay_conn
        .busy_timeout(std::time::Duration::from_secs(1))
        .expect("configure replay busy timeout");
    let tx = begin_replay_write_transaction(&mut replay_conn, "test replay")
        .expect("reserve replay writer");
    tx.query_row("SELECT COUNT(*) FROM probe", [], |row| row.get::<_, i64>(0))
        .expect("streaming read before first replay write");

    let peer = Connection::open(&path).expect("open peer writer");
    peer.busy_timeout(std::time::Duration::from_millis(25))
        .expect("configure peer timeout");
    let error = peer
        .execute("INSERT INTO probe(value) VALUES (1)", [])
        .expect_err("IMMEDIATE replay transaction must already own the writer slot");
    assert!(
        matches!(
            error,
            rusqlite::Error::SqliteFailure(ref details, _)
                if matches!(
                    details.code,
                    rusqlite::ErrorCode::DatabaseBusy
                        | rusqlite::ErrorCode::DatabaseLocked
                )
        ),
        "unexpected peer error: {error}"
    );

    tx.execute("INSERT INTO probe(value) VALUES (2)", [])
        .expect("first replay write cannot hit a stale snapshot");
    tx.commit().expect("commit replay write");
    peer.busy_timeout(std::time::Duration::from_secs(1))
        .expect("extend peer timeout");
    peer.execute("INSERT INTO probe(value) VALUES (3)", [])
        .expect("writer slot released after replay commit");
    drop(peer);
    drop(replay_conn);
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn cursor_cli_lineage_rejection_watermark_matches_only_the_same_snapshot() {
    let mut conn = replay_schema();
    let source = ImportedHistorySourceId::CursorCli;
    let parser_version = source.descriptor().parser_version;
    let snapshot = SourcePhysicalSnapshot {
        identity: "/tmp/cursor-state.vscdb:1:2".to_string(),
        size_bytes: 42_000,
        mtime_ns: 1_700_000_000_000_000_000,
        sample_fingerprint: "db-and-wal-sample-a".to_string(),
    };
    conn.execute(
        "INSERT INTO imported_replay_state(
                 source,source_session_id,generation,revision,parser_version,
                 source_identity,driver_cursor_json,indexed_size_bytes,
                 indexed_mtime_ns,total_events,total_turns,valid,updated_at
             ) VALUES('cursor_cli','cursor-1','valid-generation',7,?1,
                      'old-identity','{}',10,20,3,1,1,?2)",
        params![i64::from(parser_version), Utc::now().to_rfc3339()],
    )
    .expect("seed last valid Cursor CLI generation");

    record_rejected_snapshot(
        &mut conn,
        source,
        "cursor-1",
        parser_version,
        &snapshot,
        RejectedSnapshotKind::CursorCliLineageChanged,
    )
    .expect("record Cursor CLI lineage rejection");

    for _ in 0..20 {
        assert!(rejected_snapshot_matches(
            &conn,
            source,
            "cursor-1",
            parser_version,
            &snapshot,
            RejectedSnapshotKind::CursorCliLineageChanged,
        )
        .expect("match unchanged Cursor CLI rejected snapshot"));
    }
    let valid = load_state(&conn, source, "cursor-1")
        .expect("load last valid Cursor CLI state")
        .expect("last valid Cursor CLI state remains visible");
    assert_eq!(valid.generation, "valid-generation");
    assert_eq!(valid.revision, 7);

    let mut changed = snapshot.clone();
    changed.sample_fingerprint = "db-and-wal-sample-b".to_string();
    assert!(!rejected_snapshot_matches(
        &conn,
        source,
        "cursor-1",
        parser_version,
        &changed,
        RejectedSnapshotKind::CursorCliLineageChanged,
    )
    .expect("changed Cursor CLI snapshot is retryable"));

    let tx = conn
        .transaction()
        .expect("start successful Cursor CLI publish transaction");
    clear_rejected_snapshot(&tx, source, "cursor-1")
        .expect("clear successful Cursor CLI rejection");
    tx.commit()
        .expect("commit successful Cursor CLI rejection clear");
    assert!(!rejected_snapshot_matches(
        &conn,
        source,
        "cursor-1",
        parser_version,
        &snapshot,
        RejectedSnapshotKind::CursorCliLineageChanged,
    )
    .expect("cleared Cursor CLI snapshot is retryable"));
}

#[test]
fn fingerprint_reads_a_bounded_sample() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "orgii-replay-fingerprint-{}.jsonl",
        std::process::id()
    ));
    std::fs::write(&path, vec![b'x'; 32 * 1024]).expect("fixture");
    let first = sampled_file_fingerprint(&path, 32 * 1024).expect("fingerprint");
    let mut bytes = std::fs::read(&path).expect("read fixture");
    bytes[16 * 1024] = b'y';
    std::fs::write(&path, bytes).expect("rewrite fixture");
    let second = sampled_file_fingerprint(&path, 32 * 1024).expect("fingerprint");
    let _ = std::fs::remove_file(path);
    assert_ne!(first, second);
}

#[test]
fn sqlite_logical_snapshot_ignores_shm_but_tracks_wal() {
    let path = std::env::temp_dir().join(format!(
        "orgii-replay-sqlite-snapshot-{}-{}.db",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
    std::fs::write(&path, b"database").expect("main fixture");
    std::fs::write(&wal, b"committed-wal").expect("WAL fixture");
    std::fs::write(&shm, b"reader-lock-a").expect("SHM fixture");

    let before = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
        .expect("snapshot before SHM churn");
    let before_fingerprint =
        sqlite_physical_fingerprint(&path).expect("fingerprint before SHM churn");
    std::fs::write(&shm, b"reader-lock-b-with-different-size").expect("simulate SHM lock churn");
    let after_shm = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
        .expect("snapshot after SHM churn");
    let after_shm_fingerprint =
        sqlite_physical_fingerprint(&path).expect("fingerprint after SHM churn");
    assert_eq!(before.identity, after_shm.identity);
    assert_eq!(before.size_bytes, after_shm.size_bytes);
    assert_eq!(before.mtime_ns, after_shm.mtime_ns);
    assert_eq!(before_fingerprint, after_shm_fingerprint);

    std::fs::write(&wal, b"committed-wal-with-new-logical-row")
        .expect("simulate committed WAL change");
    let after_wal = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
        .expect("snapshot after WAL change");
    let after_wal_fingerprint =
        sqlite_physical_fingerprint(&path).expect("fingerprint after WAL change");
    assert_ne!(after_shm.size_bytes, after_wal.size_bytes);
    assert_ne!(after_shm_fingerprint, after_wal_fingerprint);

    let _ = std::fs::remove_file(shm);
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(path);
}
