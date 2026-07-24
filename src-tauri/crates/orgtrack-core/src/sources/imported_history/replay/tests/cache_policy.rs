use std::path::Path;

use rusqlite::Connection;
use serde_json::json;

use super::*;
use crate::sources::imported_history::replay::{
    open_window, ImportedHistorySourceId, ReplayLimits,
};
use crate::store::sqlite::SqliteRecordStore;

fn cache() -> Connection {
    let conn = Connection::open_in_memory().expect("replay cache");
    SqliteRecordStore::init_tables(&conn).expect("core schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("replay schema");
    conn
}

fn cache_at(path: &Path) -> Connection {
    let conn = Connection::open(path).expect("file-backed replay cache");
    SqliteRecordStore::init_tables(&conn).expect("core schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("replay schema");
    conn
}

fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .expect("test timestamp")
        .to_rfc3339()
}

fn bind_catalog(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
    session_id: &str,
    path: &str,
) {
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,source_record_key,
                 source_mtime_ms,source_size_bytes,source_fingerprint,parser_version,
                 name,created_at_ms,updated_at_ms,model,input_tokens,output_tokens,
                 cache_read_tokens,cache_write_tokens,repo_path,branch,files_changed,
                 lines_added,lines_removed,touched_files_json,listable,
                 source_metadata_json,parent_session_id,updated_at
             ) VALUES(?1,?2,?3,?4,?2,123,456,'provider-fingerprint',1,
                      'replay title',111,222,'model',10,20,3,4,'/repo','branch',1,
                      2,3,'[\"src/lib.rs\"]',1,'{\"continuationGroupKey\":\"g\"}',
                      'parent',?5)",
        params![
            source,
            source_session_id,
            session_id,
            path,
            Utc::now().to_rfc3339()
        ],
    )
    .expect("catalog binding");
}

fn seed_entry(
    conn: &mut Connection,
    source: &str,
    source_session_id: &str,
    updated_at_ms: i64,
    payload_bytes: usize,
    provider_size: i64,
) {
    let session_id = format!("{source}-{source_session_id}");
    bind_catalog(
        conn,
        source,
        source_session_id,
        &session_id,
        "/provider/truth",
    );
    let generation = format!("generation-{source_session_id}");
    conn.execute(
        "INSERT INTO imported_replay_state(
                 source,source_session_id,generation,revision,parser_version,
                 source_identity,driver_cursor_json,indexed_size_bytes,indexed_mtime_ns,
                 total_events,total_turns,valid,updated_at
             ) VALUES(?1,?2,?3,1,1,'identity','{\"cursor\":1}',?4,10,1,1,1,?5)",
        params![
            source,
            source_session_id,
            generation,
            provider_size,
            iso(updated_at_ms)
        ],
    )
    .expect("replay state");
    conn.execute(
        "INSERT INTO imported_replay_turns(
                 source,source_session_id,generation,turn_index,turn_id,
                 start_sequence,end_sequence,started_at,ended_at,event_count
             ) VALUES(?1,?2,?3,0,'turn',0,0,'start','end',1)",
        params![source, source_session_id, generation],
    )
    .expect("replay turn");
    conn.execute(
        "INSERT INTO imported_replay_events(
                 source,source_session_id,generation,sequence,event_id,turn_index,
                 action_type,function_name,created_at,args_preview_json,result_preview_json,
                 args_size_bytes,result_size_bytes,source_start,source_end,payloads_json,
                 content_hash,event_revision
             ) VALUES(?1,?2,?3,0,'event',0,'tool_call','Shell','now',
                      '{\"command\":\"echo\"}','{\"output\":\"preview\"}',10,20,0,10,
                      '[{\"fieldPath\":\"result.output\"}]','hash',1)",
        params![source, source_session_id, generation],
    )
    .expect("replay event");
    conn.execute(
        "INSERT INTO imported_replay_source_rows(
                 source,source_session_id,generation,source_key,content_hash,
                 event_id,sequence,source_order,seen_revision
             ) VALUES(?1,?2,?3,'source-key','hash','event',0,0,1)",
        params![source, source_session_id, generation],
    )
    .expect("replay source row");
    conn.execute(
        "INSERT INTO imported_replay_structured_rows(
                 source,source_session_id,generation,source_key,content_hash,seen_revision
             ) VALUES(?1,?2,?3,'structured-key','hash',1)",
        params![source, source_session_id, generation],
    )
    .expect("structured row");
    conn.execute(
        "INSERT INTO imported_replay_structured_events(
                 source,source_session_id,generation,source_key,local_key,event_id,sequence
             ) VALUES(?1,?2,?3,'structured-key','local','event',0)",
        params![source, source_session_id, generation],
    )
    .expect("structured event");
    conn.execute(
        "INSERT INTO imported_replay_changes(
                 source,source_session_id,generation,change_revision,event_id,change_kind,sequence
             ) VALUES(?1,?2,?3,1,'event','upsert',0)",
        params![source, source_session_id, generation],
    )
    .expect("replay change");
    conn.execute(
        "INSERT INTO imported_replay_payload_artifacts(
                 source,source_session_id,generation,content_hash,payload
             ) VALUES(?1,?2,?3,'hash',?4)",
        params![
            source,
            source_session_id,
            generation,
            vec![b'x'; payload_bytes]
        ],
    )
    .expect("payload artifact");
    conn.execute(
        "INSERT INTO imported_replay_payload_artifact_refs(
                 source,source_session_id,generation,event_id,field_path,content_hash
             ) VALUES(?1,?2,?3,'event','result.output','hash')",
        params![source, source_session_id, generation],
    )
    .expect("payload artifact ref");
    conn.execute(
        "INSERT INTO imported_replay_shell_manifests(
                 session_id,logical_call_id,call_id,identity_hash,total_bytes,
                 last_sequence,terminal_preview,completed_at,accessed_at
             ) VALUES(?1,'logical-shell','shell-call','identity',?2,0,
                      'preview','now',?3)",
        params![session_id, provider_size, iso(updated_at_ms)],
    )
    .expect("replay Shell manifest");
    conn.execute(
        "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES(?1,'shell-call',0,'stdout',?2,?3,?4,'hash',0,?5,0,1)",
        params![
            session_id,
            source,
            source_session_id,
            generation,
            provider_size
        ],
    )
    .expect("replay Shell segment");
    conn.execute(
        "INSERT INTO imported_replay_rejected_snapshots(
                 source,source_session_id,parser_version,source_identity,
                 source_size_bytes,source_mtime_ns,sample_fingerprint,
                 rejection_kind,rejected_at
             ) VALUES(?1,?2,1,'identity',99,100,'sample','test',?3)",
        params![source, source_session_id, iso(updated_at_ms)],
    )
    .expect("rejected watermark");

    // Replay overlays only its compact projection onto the mixed-ownership
    // catalog row. Prune must later restore this adapter-owned baseline.
    let cursor = json!({
        "catalog": {
            "model": "replay-model",
            "inputTokens": 100,
            "outputTokens": 20,
            "tokensObserved": true,
            "continuationGroupKey": "replay-group",
            "continuationObserved": true
        }
    })
    .to_string();
    let tx = conn.transaction().expect("catalog projection transaction");
    crate::sources::imported_history::catalog::publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::parse(source).expect("registered replay source"),
        source_session_id,
        &generation,
        1,
        true,
        10_000_000,
        &cursor,
    )
    .expect("publish replay catalog projection");
    tx.commit().expect("commit replay catalog projection");
}

fn seed_shell_only_scope(
    conn: &Connection,
    source_session_id: &str,
    accessed_at_ms: i64,
    payload_bytes: usize,
) {
    let source = "managed_readerless";
    let session_id = format!("managed-{source_session_id}");
    let call_id = format!("call-{source_session_id}");
    let generation = format!("generation-{source_session_id}");
    let content_hash = format!("hash-{source_session_id}");
    conn.execute(
        "INSERT INTO imported_replay_payload_artifacts(
                 source,source_session_id,generation,content_hash,payload
             ) VALUES(?1,?2,?3,?4,?5)",
        params![
            source,
            source_session_id,
            generation,
            content_hash,
            vec![b'x'; payload_bytes]
        ],
    )
    .expect("readerless payload artifact");
    conn.execute(
        "INSERT INTO imported_replay_shell_manifests(
                 session_id,logical_call_id,call_id,identity_hash,total_bytes,
                 last_sequence,terminal_preview,completed_at,accessed_at
             ) VALUES(?1,?2,?3,'identity',?4,1,'preview',
                      '2000-01-01T00:00:00Z',?5)",
        params![
            session_id,
            format!("logical-{source_session_id}"),
            call_id,
            payload_bytes as i64,
            iso(accessed_at_ms)
        ],
    )
    .expect("readerless Shell manifest");
    conn.execute(
        "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES(?1,?2,0,'stdout',?3,?4,?5,?6,0,?7,1,1)",
        params![
            session_id,
            call_id,
            source,
            source_session_id,
            generation,
            content_hash,
            payload_bytes as i64
        ],
    )
    .expect("readerless Shell segment");
}

fn count(conn: &Connection, table: &str, source_session_id: &str) -> i64 {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE source_session_id=?1"),
        [source_session_id],
        |row| row.get(0),
    )
    .expect("count replay rows")
}

fn no_protection_policy(max_bytes: u64, target_bytes: u64) -> ReplayCachePolicy {
    ReplayCachePolicy {
        max_bytes,
        target_bytes,
        ttl: Duration::from_secs(365 * 24 * 60 * 60),
        protect_recent: Duration::ZERO,
    }
}

fn candidate_entry(source_session_id: &str, last_accessed_ms: i64, bytes: u64) -> CacheEntry {
    CacheEntry {
        source: "cline".to_string(),
        source_session_id: source_session_id.to_string(),
        last_accessed_at: iso(last_accessed_ms),
        last_accessed_ms,
        approx_bytes: bytes,
        protected: false,
    }
}

#[test]
fn cache_table_registry_is_exhaustive() {
    let conn = cache();
    let mut statement = conn
        .prepare(
            "SELECT name FROM sqlite_master
                 WHERE type='table' AND name LIKE 'imported_replay_%'
                 ORDER BY name",
        )
        .expect("prepare replay cache table registry");
    let mut actual = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query replay cache table registry")
        .collect::<Result<Vec<_>, _>>()
        .expect("read replay cache table registry");
    let mut expected = REPLAY_CACHE_TABLES
        .iter()
        .map(|table| table.name.to_string())
        .collect::<Vec<_>>();
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected, "new replay tables need prune coverage");

    let mut accounted = REPLAY_CACHE_BYTE_AGGREGATIONS
        .iter()
        .map(|aggregation| aggregation.table.to_string())
        .collect::<Vec<_>>();
    accounted.sort();
    assert_eq!(
        actual, accounted,
        "new replay tables need set-based byte accounting"
    );
}

#[test]
fn maintenance_selection_is_bounded_by_scope_count_and_approximate_bytes() {
    let now = 1_800_000_000_000_i64;
    let ten_small = (0..10)
        .map(|index| candidate_entry(&format!("scope-{index}"), now + index, 1024))
        .collect::<Vec<_>>();
    let selected = select_eviction_candidates(&ten_small, no_protection_policy(0, 0), 0, now);
    assert_eq!(selected.len(), MAX_EVICTION_SCOPES_PER_RUN);

    let seventy_mib = 70 * 1024 * 1024;
    let two_large = vec![
        candidate_entry("oldest", now, seventy_mib),
        candidate_entry("newer", now + 1, seventy_mib),
    ];
    let selected = select_eviction_candidates(&two_large, no_protection_policy(0, 0), 0, now);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].0, 0);

    let oversized = vec![
        candidate_entry("oversized", now, MAX_EVICTION_BYTES_PER_RUN + 1),
        candidate_entry("later", now + 1, 1),
    ];
    let selected = select_eviction_candidates(&oversized, no_protection_policy(0, 0), 0, now);
    assert_eq!(selected.len(), 1, "oversized oldest scope runs alone");
    assert_eq!(selected[0].0, 0);
}

#[test]
fn byte_accounting_runs_one_query_per_table_independent_of_scope_count() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_entry(&mut conn, "cline", "one", now, 32, 1);
    CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.set(0));
    let one_scope = load_cache_entries(&conn).expect("measure one replay scope");
    assert_eq!(one_scope.len(), 1);
    let one_scope_queries = CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.get());

    for index in 2..=12 {
        seed_entry(
            &mut conn,
            "cline",
            &format!("scope-{index}"),
            now + index,
            32,
            1,
        );
    }
    CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.set(0));
    let many_scopes = load_cache_entries(&conn).expect("measure many replay scopes");
    let many_scope_queries = CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.get());

    assert_eq!(many_scopes.len(), 12);
    assert_eq!(one_scope_queries, REPLAY_CACHE_BYTE_AGGREGATIONS.len());
    assert_eq!(many_scope_queries, one_scope_queries);
}

#[test]
fn default_policy_matches_the_global_cache_contract() {
    assert_eq!(
        ReplayCachePolicy::default(),
        ReplayCachePolicy {
            max_bytes: 512 * 1024 * 1024,
            target_bytes: 384 * 1024 * 1024,
            ttl: Duration::from_secs(7 * 24 * 60 * 60),
            protect_recent: Duration::from_secs(3 * 60),
        }
    );
}

#[test]
fn ttl_prune_deletes_every_rebuildable_table_but_keeps_provider_binding() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_entry(
        &mut conn,
        "cline",
        "expired",
        now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
        4096,
        10 * 1024 * 1024 * 1024,
    );
    seed_entry(&mut conn, "cline", "fresh", now - 60_000, 64, 1);

    let report =
        prune_cache_at(&mut conn, ReplayCachePolicy::default(), now).expect("TTL replay prune");
    assert_eq!(report.ttl_evictions, 1);
    assert_eq!(report.budget_evictions, 0);
    assert_eq!(report.evictions[0].source_session_id, "expired");
    assert!(
        report.evictions[0].approx_bytes < 1024 * 1024,
        "provider indexed_size_bytes must not count as cache bytes"
    );
    for table in [
        "imported_replay_state",
        "imported_replay_turns",
        "imported_replay_events",
        "imported_replay_source_rows",
        "imported_replay_structured_rows",
        "imported_replay_structured_events",
        "imported_replay_changes",
        "imported_replay_payload_artifact_refs",
        "imported_replay_payload_artifacts",
        "imported_replay_rejected_snapshots",
        "imported_replay_catalog_derivations",
        "imported_replay_shell_segments",
    ] {
        assert_eq!(count(&conn, table, "expired"), 0, "{table}");
        assert_eq!(count(&conn, table, "fresh"), 1, "{table}");
    }
    let manifest_count = |session_id: &str| {
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_manifests
                 WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("count replay Shell manifests")
    };
    assert_eq!(manifest_count("cline-expired"), 0);
    assert_eq!(manifest_count("cline-fresh"), 1);
    let catalog = conn
        .query_row(
            "SELECT source_path,name,model,files_changed,touched_files_json,
                        source_metadata_json,parent_session_id
                 FROM imported_history_session_cache
                 WHERE source='cline' AND source_session_id='expired'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .expect("pruned catalog binding");
    assert_eq!(catalog.0, "/provider/truth");
    assert_eq!(catalog.1, "replay title");
    assert_eq!(catalog.2, "model");
    assert_eq!(catalog.3, 1);
    assert_eq!(catalog.4, r#"["src/lib.rs"]"#);
    assert_eq!(catalog.5, r#"{"continuationGroupKey":"g"}"#);
    assert_eq!(catalog.6, "parent");
}

#[test]
fn ttl_prunes_rejected_snapshot_without_valid_generation() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    conn.execute(
        "INSERT INTO imported_replay_rejected_snapshots(
                 source,source_session_id,parser_version,source_identity,
                 source_size_bytes,source_mtime_ns,sample_fingerprint,
                 rejection_kind,rejected_at
             ) VALUES('cline','never-valid',1,'identity',99,100,'sample','json',?1)",
        [iso(now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1)],
    )
    .expect("standalone rejected snapshot");

    let report = prune_cache_at(&mut conn, ReplayCachePolicy::default(), now)
        .expect("prune standalone rejected snapshot");

    assert_eq!(report.ttl_evictions, 1);
    assert_eq!(report.evictions[0].source_session_id, "never-valid");
    assert_eq!(
        count(&conn, "imported_replay_rejected_snapshots", "never-valid"),
        0
    );
}

#[test]
fn shell_only_managed_scopes_are_counted_and_evicted_by_orgii_access_time() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_shell_only_scope(
        &conn,
        "expired",
        now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
        8192,
    );
    seed_shell_only_scope(&conn, "fresh", now - 60_000, 4096);
    assert_eq!(count(&conn, "imported_replay_state", "expired"), 0);
    assert_eq!(count(&conn, "imported_replay_state", "fresh"), 0);

    let report = prune_cache_at(&mut conn, ReplayCachePolicy::default(), now)
        .expect("prune readerless Shell cache");

    assert!(report.before_bytes >= 8192 + 4096);
    assert_eq!(report.ttl_evictions, 1);
    assert_eq!(report.protected_entries, 1);
    assert_eq!(report.evictions[0].source_id, "managed_readerless");
    assert_eq!(report.evictions[0].source_session_id, "expired");
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "expired"),
        0
    );
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "fresh"),
        1
    );
    assert_eq!(count(&conn, "imported_replay_shell_segments", "expired"), 0);
    assert_eq!(count(&conn, "imported_replay_shell_segments", "fresh"), 1);
    let manifest_count = |session_id: &str| {
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_manifests
                 WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("count readerless Shell manifest")
    };
    assert_eq!(manifest_count("managed-expired"), 0);
    assert_eq!(manifest_count("managed-fresh"), 1);
}

#[test]
fn selected_shell_scope_touched_before_writer_lock_is_not_evicted() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_shell_only_scope(
        &conn,
        "became-active",
        now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
        4096,
    );
    let touched_at = iso(now - 60_000);

    let report = prune_cache_at_with_hook(&mut conn, ReplayCachePolicy::default(), now, |conn| {
        conn.execute(
            "UPDATE imported_replay_shell_manifests SET accessed_at=?1
                     WHERE session_id='managed-became-active'",
            [&touched_at],
        )
        .map(|_| ())
        .map_err(|err| format!("simulate manifest delivery touch: {err}"))
    })
    .expect("revalidate touched Shell scope");

    assert_eq!(report.evicted_entries, 0);
    assert_eq!(report.ttl_evictions, 0);
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "became-active"),
        1
    );
    assert_eq!(
        count(&conn, "imported_replay_shell_segments", "became-active"),
        1
    );
}

#[test]
fn shell_only_managed_scopes_participate_in_byte_lru() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_shell_only_scope(&conn, "older", now - 30_000, 8192);
    seed_shell_only_scope(&conn, "newer", now - 10_000, 4096);
    let entries = load_cache_entries(&conn).expect("measure readerless Shell scopes");
    let total = entries.iter().map(|entry| entry.approx_bytes).sum::<u64>();
    let older_bytes = entries
        .iter()
        .find(|entry| entry.source_session_id == "older")
        .expect("older readerless scope")
        .approx_bytes;

    let report = prune_cache_at(
        &mut conn,
        no_protection_policy(total - 1, total.saturating_sub(older_bytes)),
        now,
    )
    .expect("byte-LRU readerless Shell cache");

    assert_eq!(report.ttl_evictions, 0);
    assert_eq!(report.budget_evictions, 1);
    assert_eq!(report.evictions[0].source_session_id, "older");
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "older"),
        0
    );
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "newer"),
        1
    );
}

#[test]
fn manifest_accounting_deduplicates_segment_scope_and_manifest_key() {
    let now = 1_800_000_000_000_i64;
    let conn = cache();
    seed_shell_only_scope(&conn, "dedup", now, 64);
    let before = load_cache_entries(&conn)
        .expect("measure one Shell segment")
        .into_iter()
        .find(|entry| entry.source_session_id == "dedup")
        .expect("readerless scope")
        .approx_bytes;

    conn.execute(
        "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES('managed-dedup','call-dedup',1,'stdout','managed_readerless',
                      'dedup','generation-dedup','hash-dedup',64,64,2,1)",
        [],
    )
    .expect("second segment for the same Shell manifest");
    let after = load_cache_entries(&conn)
        .expect("measure two Shell segments")
        .into_iter()
        .find(|entry| entry.source_session_id == "dedup")
        .expect("readerless scope")
        .approx_bytes;

    let second_segment_bytes = APPROX_ROW_OVERHEAD_BYTES as u64
        + 48
        + "managed-dedup".len() as u64
        + "call-dedup".len() as u64
        + "stdout".len() as u64
        + "managed_readerless".len() as u64
        + "dedup".len() as u64
        + "generation-dedup".len() as u64
        + "hash-dedup".len() as u64;
    assert_eq!(
        after - before,
        second_segment_bytes,
        "adding a locator must not count the shared manifest a second time"
    );
}

#[test]
fn byte_budget_uses_oldest_unprotected_entry_until_target() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_entry(&mut conn, "cline", "oldest", now - 30_000, 16_384, 1);
    seed_entry(&mut conn, "cline", "middle", now - 20_000, 8192, 1);
    seed_entry(&mut conn, "cline", "newest", now - 10_000, 4096, 1);
    let entries = load_cache_entries(&conn).expect("measure seeded replay entries");
    let total = entries.iter().map(|entry| entry.approx_bytes).sum::<u64>();
    let oldest_bytes = entries
        .iter()
        .find(|entry| entry.source_session_id == "oldest")
        .expect("oldest entry")
        .approx_bytes;
    let policy = no_protection_policy(total - 1, total.saturating_sub(oldest_bytes));

    let report = prune_cache_at(&mut conn, policy, now).expect("byte LRU prune");
    assert_eq!(report.ttl_evictions, 0);
    assert_eq!(report.budget_evictions, 1);
    assert_eq!(report.evictions[0].source_session_id, "oldest");
    assert!(report.after_bytes <= policy.target_bytes);
    assert_eq!(count(&conn, "imported_replay_state", "middle"), 1);
    assert_eq!(count(&conn, "imported_replay_state", "newest"), 1);
}

#[test]
fn recent_entries_are_protected_even_when_cache_stays_over_budget() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_entry(&mut conn, "cline", "old", now - 10 * 60_000, 4096, 1);
    seed_entry(&mut conn, "cline", "active", now - 60_000, 4096, 1);
    let policy = ReplayCachePolicy {
        max_bytes: 0,
        target_bytes: 0,
        ttl: Duration::ZERO,
        protect_recent: DEFAULT_REPLAY_CACHE_PROTECT_RECENT,
    };

    let report = prune_cache_at(&mut conn, policy, now).expect("protected replay prune");
    assert_eq!(report.evicted_entries, 1);
    assert_eq!(report.protected_entries, 1);
    assert!(report.over_budget);
    assert_eq!(count(&conn, "imported_replay_state", "old"), 0);
    assert_eq!(count(&conn, "imported_replay_state", "active"), 1);
}

#[test]
fn writer_lock_is_released_between_scope_transactions() {
    let now = 1_800_000_000_000_i64;
    let path = temp_path("writer-lock").with_extension("sqlite");
    let mut conn = cache_at(&path);
    conn.execute_batch(
        "CREATE TABLE cache_lock_probe(value INTEGER NOT NULL);
             INSERT INTO cache_lock_probe(value) VALUES(0);",
    )
    .expect("writer lock probe");
    seed_entry(&mut conn, "cline", "first", now - 20_000, 1024, 1);
    seed_entry(&mut conn, "cline", "second", now - 10_000, 1024, 1);

    let peer = Connection::open(&path).expect("peer cache writer");
    peer.busy_timeout(Duration::from_millis(50))
        .expect("short peer writer timeout");
    let report = prune_cache_at_with_hooks(
        &mut conn,
        no_protection_policy(0, 0),
        now,
        |_| Ok(()),
        |_| {
            peer.execute("UPDATE cache_lock_probe SET value=value+1", [])
                .map(|_| ())
                .map_err(|err| format!("peer writer remained blocked: {err}"))
        },
    )
    .expect("scope-local replay prune transactions");

    assert_eq!(report.evicted_entries, 2);
    let peer_writes: i64 = peer
        .query_row("SELECT value FROM cache_lock_probe", [], |row| row.get(0))
        .expect("peer writer count");
    assert_eq!(peer_writes, 2);
    drop(peer);
    drop(conn);
    let _ = std::fs::remove_file(path);
}

#[test]
fn failed_later_scope_keeps_prior_commit_and_rolls_back_failing_scope() {
    let now = 1_800_000_000_000_i64;
    let mut conn = cache();
    seed_entry(&mut conn, "cline", "a-first", now - 20_000, 1024, 1);
    seed_entry(&mut conn, "cline", "z-broken", now - 10_000, 1024, 1);
    conn.execute(
        "UPDATE imported_replay_catalog_derivations SET baseline_json='{'
             WHERE source='cline' AND source_session_id='z-broken'",
        [],
    )
    .expect("corrupt second derivation guard");

    let error = prune_cache_at(&mut conn, no_protection_policy(0, 0), now)
        .expect_err("malformed guard must abort prune");

    assert!(error.contains("decode replay catalog prune baseline"));
    assert_eq!(count(&conn, "imported_replay_state", "a-first"), 0);
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "a-first"),
        0
    );
    assert_eq!(count(&conn, "imported_replay_state", "z-broken"), 1);
    assert_eq!(
        count(&conn, "imported_replay_payload_artifacts", "z-broken"),
        1
    );
    let manifest_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_manifests",
            [],
            |row| row.get(0),
        )
        .expect("count partially committed Shell manifests");
    assert_eq!(manifest_count, 1);
}

#[test]
fn pruning_one_database_identity_cannot_touch_another() {
    let now = 1_800_000_000_000_i64;
    let mut first = cache();
    let mut second = cache();
    seed_entry(&mut first, "cline", "shared-id", now - 10_000, 1024, 1);
    seed_entry(&mut second, "cline", "shared-id", now - 10_000, 1024, 1);

    prune_cache_at(&mut first, no_protection_policy(0, 0), now)
        .expect("prune first database identity");
    assert_eq!(count(&first, "imported_replay_state", "shared-id"), 0);
    assert_eq!(count(&second, "imported_replay_state", "shared-id"), 1);
}

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "orgii-replay-prune-{name}-{}-{}.json",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

#[test]
fn pruned_entry_rebuilds_from_untouched_provider_truth() {
    let path = temp_path("rebuild");
    let transcript = json!({
        "messages":[
            {"role":"user","content":[{"type":"text","text":"hello"}]},
            {"role":"assistant","content":[{"type":"text","text":"world"}]}
        ]
    });
    std::fs::write(&path, transcript.to_string()).expect("provider Cline transcript");
    let mut conn = cache();
    let session_id = "clineapp-rebuild";
    bind_catalog(
        &conn,
        "cline",
        "rebuild",
        session_id,
        &path.to_string_lossy(),
    );
    let first = open_window(
        &mut conn,
        ImportedHistorySourceId::Cline,
        session_id,
        ReplayLimits::default(),
    )
    .expect("build initial replay cache");
    assert_eq!(first.chunks.len(), 2);
    conn.execute(
        "UPDATE imported_replay_state SET updated_at='2000-01-01T00:00:00Z'
             WHERE source='cline' AND source_session_id='rebuild'",
        [],
    )
    .expect("age replay cache entry");

    let report = prune_cache_at(
        &mut conn,
        ReplayCachePolicy {
            max_bytes: 0,
            target_bytes: 0,
            ttl: Duration::ZERO,
            protect_recent: Duration::ZERO,
        },
        1_800_000_000_000,
    )
    .expect("prune replay entry");
    assert_eq!(report.evicted_entries, 1);
    assert!(Path::new(&path).is_file(), "provider truth is untouched");
    assert_eq!(count(&conn, "imported_replay_state", "rebuild"), 0);

    let rebuilt = open_window(
        &mut conn,
        ImportedHistorySourceId::Cline,
        session_id,
        ReplayLimits::default(),
    )
    .expect("rebuild replay from provider truth");
    assert_eq!(rebuilt.chunks.len(), 2);
    assert_eq!(rebuilt.total_event_count, first.total_event_count);
    assert_eq!(count(&conn, "imported_replay_state", "rebuild"), 1);
    let _ = std::fs::remove_file(path);
}
