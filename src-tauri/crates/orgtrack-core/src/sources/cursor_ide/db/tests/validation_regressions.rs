use super::*;
use std::collections::HashSet;

#[test]
fn no_index_validation_is_bounded_and_visible_v7_rows_ignore_wal_churn() {
    let mut cache = cursor_cache_conn();
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");

    let mut legacy = Vec::new();
    for ordinal in 0..(NO_INDEX_VALIDATION_BATCH_SIZE + 6) {
        let id = format!("bounded-{ordinal:03}");
        legacy.push(legacy_cursor_cache_input(&id, "", false));
        cursor
            .execute(
                "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
                params![
                    format!("{COMPOSER_KEY_PREFIX}{id}"),
                    serde_json::json!({
                        "composerId": id,
                        "name": "",
                        "createdAt": 100,
                        "lastUpdatedAt": 200,
                        "fullConversationHeadersOnly": []
                    })
                    .to_string()
                ],
            )
            .expect("insert bounded composer");
    }
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &legacy)
        .expect("seed bounded migration batch");

    let initial = storage_snapshot("state-db-1", "main:100:10|wal:-");
    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&initial),
    )
    .expect("run first bounded migration batch");
    assert_eq!(
        cursor_content_probe_count(),
        NO_INDEX_VALIDATION_BATCH_SIZE,
        "one refresh may point-read at most one hard-bounded migration batch"
    );

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&initial),
    )
    .expect("run remaining migration batch");
    assert_eq!(cursor_content_probe_count(), 6);

    // A visible v7 row has already been validated. Ordinary main/WAL activity
    // must not make the no-index fallback reparse every visible root.
    cache
        .execute(
            "DELETE FROM imported_history_session_cache WHERE source=?1",
            [SOURCE_CURSOR_IDE],
        )
        .expect("clear bounded hidden-row fixture");
    let visible_id = "visible-v7";
    let mut visible = legacy_cursor_cache_input(visible_id, "Visible history", true);
    visible.parser_version = CURSOR_IDE_METADATA_PARSER_VERSION;
    visible.source_metadata_json = Some(
        serde_json::json!({
            "noIndexDatabaseIdentity": "state-db-1",
            "noIndexActivitySignature": "main:100:10|wal:-"
        })
        .to_string(),
    );
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &[visible])
        .expect("seed validated visible row");

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:4096:200")),
    )
    .expect("ignore ordinary WAL churn for visible rows");
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "WAL activity may retry hidden rows, never the full visible catalog"
    );
}

#[test]
fn indeterminate_no_index_reads_rotate_so_later_hidden_rows_are_not_starved() {
    let mut cache = cursor_cache_conn();
    let mut hidden = Vec::new();
    for ordinal in 0..(NO_INDEX_VALIDATION_BATCH_SIZE + 6) {
        let id = format!("retry-fairness-{ordinal:03}");
        let mut input = legacy_cursor_cache_input(&id, "Hidden history", false);
        input.parser_version = CURSOR_IDE_METADATA_PARSER_VERSION;
        input.source_metadata_json = Some(
            serde_json::json!({
                "noIndexDatabaseIdentity": "state-db-1",
                "noIndexActivitySignature": "old-activity"
            })
            .to_string(),
        );
        hidden.push(input);
    }
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &hidden)
        .expect("seed hidden retry candidates");

    // No cursorDiskKV table: every point-read is indeterminate and therefore
    // must remain retryable without being stamped as missing.
    let unreadable_cursor = Connection::open_in_memory().expect("open unreadable Cursor DB");
    let changed = storage_snapshot("state-db-1", "new-activity");

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&unreadable_cursor),
        "/cursor/state.vscdb",
        Some(&changed),
    )
    .expect("run first retry batch");
    assert_eq!(cursor_content_probe_count(), NO_INDEX_VALIDATION_BATCH_SIZE);
    let first_batch = cursor_content_probed_ids();
    assert_eq!(
        first_batch.iter().collect::<HashSet<_>>().len(),
        NO_INDEX_VALIDATION_BATCH_SIZE
    );

    let probes_after_first_batch = cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&unreadable_cursor),
        "/cursor/state.vscdb",
        Some(&changed),
    )
    .expect("run second retry batch");
    assert_eq!(
        cursor_content_probe_count() - probes_after_first_batch,
        NO_INDEX_VALIDATION_BATCH_SIZE,
        "each retry pass must retain the hard batch limit"
    );
    let all_probed = cursor_content_probed_ids()
        .into_iter()
        .collect::<HashSet<_>>();
    assert_eq!(
        all_probed.len(),
        NO_INDEX_VALIDATION_BATCH_SIZE + 6,
        "oldest-first retry bookkeeping must cover all 70 rows in two bounded passes"
    );
    for input in &hidden {
        assert!(
            all_probed.contains(&input.source_session_id),
            "hidden row {} was starved by earlier read errors",
            input.source_session_id
        );
        assert_eq!(
            cached_cursor_projection(&cache, &input.source_session_id).0,
            0,
            "an indeterminate read must not promote or otherwise mutate projection state"
        );
        assert_eq!(
            cached_cursor_metadata_string(
                &cache,
                &input.source_session_id,
                NO_INDEX_ACTIVITY_SIGNATURE_FIELD,
            )
            .as_deref(),
            Some("old-activity"),
            "retry rotation must not stamp validation success"
        );
    }
}

#[test]
fn legacy_v7_no_index_stamp_is_revalidated_instead_of_blessing_current_database() {
    let id = "legacy-v7-watermark";
    let mut cache = cursor_cache_conn();
    let mut cached = legacy_cursor_cache_input(id, "Possibly stale card", true);
    cached.parser_version = CURSOR_IDE_METADATA_PARSER_VERSION;
    cached.source_metadata_json = Some(
        serde_json::json!({
            "noIndexValidationSignature": "old-main-and-wal-signature"
        })
        .to_string(),
    );
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &[cached])
        .expect("seed legacy v7 validation watermark");
    let cursor = Connection::open_in_memory().expect("open replacement Cursor DB");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-new", "main:20:30|wal:-")),
    )
    .expect("revalidate legacy v7 watermark");
    assert_eq!(cursor_content_probe_count(), 1);
    assert_eq!(
        cached_cursor_projection(&cache, id),
        (
            0,
            "Possibly stale card".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION
        ),
        "a legacy activity-only marker cannot prove the card belongs to the current DB"
    );
    assert_eq!(
        cached_cursor_metadata_string(&cache, id, NO_INDEX_DATABASE_IDENTITY_FIELD).as_deref(),
        Some("state-db-new")
    );
}

#[test]
fn new_index_row_with_missing_blob_is_memoized_then_recovers_on_activity_change() {
    let id = "new-index-missing";
    let mut cache = cursor_cache_conn();
    let index = Connection::open_in_memory().expect("open Cursor index");
    index
        .execute(
            "CREATE TABLE conversations (
                id TEXT, title TEXT, updated_at INTEGER, is_archived INTEGER,
                root_fingerprint TEXT, source TEXT
             )",
            [],
        )
        .expect("create Cursor conversation index");
    index
        .execute(
            "INSERT INTO conversations VALUES (?1,'New indexed title',300,0,'fp','local')",
            [id],
        )
        .expect("insert indexed conversation");
    let cursor = Connection::open_in_memory().expect("open Cursor state DB");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    let stable = storage_snapshot("state-db-1", "main:300:30|wal:-");

    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&stable),
    )
    .expect("memoize missing new index row");
    assert_eq!(
        cached_cursor_projection(&cache, id),
        (
            0,
            "New indexed title".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION
        )
    );
    let validation =
        cached_cursor_index_blob_validation(&cache, id).expect("missing-row validation marker");
    assert_eq!(validation.misses, 2);
    assert_eq!(validation.database_identity, "state-db-1");

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&stable),
    )
    .expect("skip unchanged missing new index row");
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "a compact tombstone prevents an unchanged index row from being re-probed"
    );

    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
            params![
                format!("{COMPOSER_KEY_PREFIX}{id}"),
                serde_json::json!({
                    "composerId": id,
                    "name": "",
                    "createdAt": 100,
                    "lastUpdatedAt": 400,
                    "fullConversationHeadersOnly": [{"bubbleId": "u1", "type": 1}]
                })
                .to_string()
            ],
        )
        .expect("restore composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
            params![
                format!("{BUBBLE_KEY_PREFIX}{id}:u1"),
                serde_json::json!({
                    "bubbleId": "u1",
                    "type": 1,
                    "text": "Recovered new index row",
                    "createdAt": "2026-07-26T04:00:00Z"
                })
                .to_string()
            ],
        )
        .expect("restore user bubble");
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:300:30|wal:4096:400")),
    )
    .expect("promote new index row after source activity");
    assert_eq!(cached_cursor_projection(&cache, id).0, 1);
}

#[test]
fn indexed_present_marker_revalidates_on_database_replacement_without_index_change() {
    let id = "replacement-indexed";
    let mut cache = cursor_cache_conn();
    let index = Connection::open_in_memory().expect("open Cursor index");
    index
        .execute(
            "CREATE TABLE conversations (
                id TEXT, title TEXT, updated_at INTEGER, is_archived INTEGER,
                root_fingerprint TEXT, source TEXT
             )",
            [],
        )
        .expect("create Cursor conversation index");
    index
        .execute(
            "INSERT INTO conversations VALUES (?1,'Replacement title',300,0,'fp','local')",
            [id],
        )
        .expect("insert indexed conversation");
    let original = Connection::open_in_memory().expect("open original state DB");
    original
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create original cursorDiskKV");
    for (key, value) in [
        (
            format!("{COMPOSER_KEY_PREFIX}{id}"),
            serde_json::json!({
                "composerId": id,
                "name": "",
                "createdAt": 100,
                "lastUpdatedAt": 300,
                "fullConversationHeadersOnly": [{"bubbleId": "u1", "type": 1}]
            })
            .to_string(),
        ),
        (
            format!("{BUBBLE_KEY_PREFIX}{id}:u1"),
            serde_json::json!({
                "bubbleId": "u1",
                "type": 1,
                "text": "Original DB history",
                "createdAt": "2026-07-26T04:00:00Z"
            })
            .to_string(),
        ),
    ] {
        original
            .execute(
                "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
                params![key, value],
            )
            .expect("seed original state DB");
    }

    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&original),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-old", "main:300:30|wal:-")),
    )
    .expect("validate original state DB");
    assert_eq!(cached_cursor_projection(&cache, id).0, 1);

    let replacement = Connection::open_in_memory().expect("open replacement state DB");
    replacement
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create replacement cursorDiskKV");
    let replacement_snapshot = storage_snapshot("state-db-new", "main:300:30|wal:-");
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&replacement),
        "/cursor/state.vscdb",
        Some(&replacement_snapshot),
    )
    .expect("revalidate same index against replaced state DB");
    assert_eq!(
        cached_cursor_projection(&cache, id).0,
        0,
        "a stable index cannot keep a card visible across physical DB replacement"
    );
    let validation =
        cached_cursor_index_blob_validation(&cache, id).expect("replacement validation marker");
    assert_eq!(validation.misses, 2);
    assert_eq!(validation.database_identity, "state-db-new");

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&replacement),
        "/cursor/state.vscdb",
        Some(&replacement_snapshot),
    )
    .expect("skip unchanged replacement miss");
    assert_eq!(cursor_content_probe_count(), 0);

    for (key, value) in [
        (
            format!("{COMPOSER_KEY_PREFIX}{id}"),
            serde_json::json!({
                "composerId": id,
                "name": "",
                "createdAt": 100,
                "lastUpdatedAt": 400,
                "fullConversationHeadersOnly": [{"bubbleId": "u2", "type": 1}]
            })
            .to_string(),
        ),
        (
            format!("{BUBBLE_KEY_PREFIX}{id}:u2"),
            serde_json::json!({
                "bubbleId": "u2",
                "type": 1,
                "text": "Replacement DB history",
                "createdAt": "2026-07-26T05:00:00Z"
            })
            .to_string(),
        ),
    ] {
        replacement
            .execute(
                "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
                params![key, value],
            )
            .expect("restore replacement state DB");
    }
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&replacement),
        "/cursor/state.vscdb",
        Some(&storage_snapshot(
            "state-db-new",
            "main:300:30|wal:4096:400",
        )),
    )
    .expect("promote replacement state DB after activity");
    assert_eq!(cached_cursor_projection(&cache, id).0, 1);
    let validation =
        cached_cursor_index_blob_validation(&cache, id).expect("recovered validation marker");
    assert_eq!(validation.misses, 0);
    assert_eq!(validation.database_identity, "state-db-new");
}

#[test]
fn index_open_or_query_failure_preserves_cached_projection_without_stamping() {
    let id = "index-query-failure";
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(id, "Last known card", true)],
    )
    .expect("seed last known card");
    let invalid_index = Connection::open_in_memory().expect("open invalid index");
    let cursor = Connection::open_in_memory().expect("open Cursor DB");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    let snapshot = storage_snapshot("state-db-1", "main:300:30|wal:-");

    delta_sync_from_connections(
        &mut cache,
        Some(&invalid_index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&snapshot),
    )
    .expect("tolerate index query failure");
    assert_eq!(
        cached_cursor_projection(&cache, id),
        (1, "Last known card".to_string(), 2)
    );
    assert!(cached_cursor_metadata_string(&cache, id, NO_INDEX_DATABASE_IDENTITY_FIELD).is_none());

    delta_sync_from_connections(
        &mut cache,
        Some(&invalid_index),
        None,
        "/cursor/state.vscdb",
        Some(&snapshot),
    )
    .expect("tolerate state DB open failure");
    assert_eq!(
        cached_cursor_projection(&cache, id),
        (1, "Last known card".to_string(), 2)
    );
}
