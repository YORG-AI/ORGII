use super::*;
use crate::store::sqlite::SqliteRecordStore;

fn catalog_fixture() -> Connection {
    let conn = Connection::open_in_memory().expect("catalog DB");
    SqliteRecordStore::init_tables(&conn).expect("core schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("catalog schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                source,source_session_id,session_id,source_record_key,name,
                model,repo_path,branch,input_tokens,files_changed,lines_added,
                lines_removed,touched_files_json,source_metadata_json,
                source_mtime_ms,source_size_bytes
             ) VALUES('codex_app','fixture','codexapp-fixture','fixture','fixture',
                'old-model','/old','old',7,9,9,9,'[\"old.rs\"]','{\"keep\":true}',
                999,999)",
        [],
    )
    .expect("cache row");
    for (sequence, function, args, result) in [
        (
            0_i64,
            imported_history::FUNCTION_USER_MESSAGE,
            "{}",
            r#"{"message":{"content":"bounded replay title"}}"#,
        ),
        (
            1_i64,
            imported_history::FUNCTION_EDIT_FILE,
            r#"{"file_path":"src/new.rs","old_content":"old","new_content":"new\nextra"}"#,
            r#"{"status":"completed","linesAdded":2,"linesRemoved":1}"#,
        ),
    ] {
        conn.execute(
            "INSERT INTO imported_replay_events(
                    source,source_session_id,generation,sequence,event_id,turn_index,
                    action_type,function_name,created_at,args_preview_json,
                    result_preview_json,content_hash
                 ) VALUES('codex_app','fixture','g1',?1,?2,0,'raw',?3,
                    '2026-07-22T00:00:00Z',?4,?5,?2)",
            params![
                sequence,
                format!("event-{sequence}"),
                function,
                args,
                result
            ],
        )
        .expect("replay event");
    }
    conn
}

fn current_catalog_snapshot(conn: &mut Connection) -> ReplayCatalogRowSnapshot {
    let tx = conn
        .transaction()
        .expect("read catalog snapshot transaction");
    let snapshot = read_replay_catalog_row(&tx, "codex_app", "fixture")
        .expect("read catalog snapshot")
        .expect("fixture catalog row");
    tx.commit().expect("finish catalog snapshot transaction");
    snapshot
}

fn derivation_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM imported_replay_catalog_derivations
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
        |row| row.get(0),
    )
    .expect("count catalog derivations")
}

fn publish_fixture_projection(conn: &mut Connection) {
    let cursor = serde_json::json!({
        "catalog": ReplayCatalogProjection {
            model: Some("gpt-5".to_string()),
            repo_path: Some("/work/orgii".to_string()),
            branch: Some("develop".to_string()),
            input_tokens: 100,
            output_tokens: 20,
            tokens_observed: true,
            continuation_group_key: Some("first-user".to_string()),
            continuation_observed: true,
            updated_at_ms: Some(1_774_137_600_000),
            ..ReplayCatalogProjection::default()
        }
    })
    .to_string();
    let tx = conn.transaction().expect("catalog transaction");
    publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        "g1",
        2,
        true,
        1_774_137_600_000_000_000,
        &cursor,
    )
    .expect("publish catalog projection");
    tx.commit().expect("commit catalog projection");
}

#[test]
fn catalog_registry_is_exhaustive_for_replay_sources() {
    // The exhaustive match in `refresh_source` is the compile-time guard;
    // this assertion also documents the external-history contract count.
    assert_eq!(ImportedHistorySourceId::ALL.len(), 15);
}

#[test]
fn codex_catalog_uses_only_session_metadata_or_the_first_user_message_for_titles() {
    let mut projection = ReplayCatalogProjection::default();
    projection.observe_codex(
        "event_msg",
        None,
        &serde_json::json!({
            "type": "user_message",
            "message": "First genuine request"
        }),
        "fixture",
    );
    for (payload_type, tool_name) in [
        ("function_call", "exec"),
        ("function_call", "exec_command"),
        ("custom_tool_call", "update_plan"),
        ("custom_tool_call", "js"),
    ] {
        projection.observe_codex(
            "response_item",
            None,
            &serde_json::json!({
                "type": payload_type,
                "name": tool_name
            }),
            "fixture",
        );
    }
    projection.observe_codex(
        "event_msg",
        None,
        &serde_json::json!({
            "type": "user_message",
            "message": "Later request must not replace the first"
        }),
        "fixture",
    );

    assert_eq!(projection.title.as_deref(), Some("First genuine request"));
    assert_eq!(projection.title_priority, 1);

    projection.observe_codex(
        "session_meta",
        None,
        &serde_json::json!({
            "title": "Transcript session title",
            "name": "not selected because title is explicit"
        }),
        "fixture",
    );
    projection.observe_codex(
        "response_item",
        None,
        &serde_json::json!({
            "type": "function_call",
            "name": "exec"
        }),
        "fixture",
    );
    assert_eq!(
        projection.title.as_deref(),
        Some("Transcript session title")
    );
    assert_eq!(projection.title_priority, 3);
}

#[test]
fn replay_catalog_preserves_authoritative_source_title() {
    let mut conn = catalog_fixture();
    conn.execute(
        "UPDATE imported_history_session_cache
             SET name='Session index title'
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
    )
    .expect("set authoritative source title");
    let cursor = serde_json::json!({
        "catalog": ReplayCatalogProjection {
            title: Some("Replay-derived title".to_string()),
            title_priority: 3,
            ..ReplayCatalogProjection::default()
        }
    })
    .to_string();
    let tx = conn.transaction().expect("catalog transaction");
    publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        "g1",
        2,
        true,
        1_774_137_600_000_000_000,
        &cursor,
    )
    .expect("publish catalog");
    tx.commit().expect("commit catalog");

    let name: String = conn
        .query_row(
            "SELECT name FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
            [],
            |row| row.get(0),
        )
        .expect("read source title");
    assert_eq!(name, "Session index title");
}

#[test]
fn adapter_title_refresh_rebases_a_polluted_replay_derivation() {
    let mut conn = catalog_fixture();
    conn.execute(
        "UPDATE imported_history_session_cache
             SET name='js'
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
    )
    .expect("set already-polluted baseline");
    let baseline = current_catalog_snapshot(&mut conn);
    conn.execute(
        "UPDATE imported_history_session_cache SET name='update_plan'
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
    )
    .expect("simulate old polluted replay title");
    let polluted = current_catalog_snapshot(&mut conn);
    let tx = conn.transaction().expect("store old projection ownership");
    store_replay_catalog_derivation(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        &baseline,
        &polluted,
    )
    .expect("store old replay derivation");
    tx.commit().expect("commit old replay derivation");

    // A Codex catalog rescan now reasserts its source-owned title directly
    // instead of restoring the already-polluted replay baseline.
    conn.execute(
        "UPDATE imported_history_session_cache SET name='Session index title'
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
    )
    .expect("apply authoritative adapter refresh");

    let corrected_cursor = serde_json::json!({
        "catalog": ReplayCatalogProjection {
            title: Some("First genuine request".to_string()),
            title_priority: 1,
            ..ReplayCatalogProjection::default()
        }
    })
    .to_string();
    let tx = conn.transaction().expect("catalog repair transaction");
    publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        "g1",
        2,
        true,
        1_774_137_600_000_000_000,
        &corrected_cursor,
    )
    .expect("publish corrected catalog");
    tx.commit().expect("commit corrected catalog");

    assert_eq!(
        current_catalog_snapshot(&mut conn).name,
        "Session index title"
    );
    assert_eq!(
        derivation_count(&conn),
        1,
        "the repaired replay overlay must retain its ownership guard"
    );
}

#[test]
fn replay_catalog_publish_updates_only_projected_fields() {
    let mut conn = catalog_fixture();
    let projection = ReplayCatalogProjection {
        model: Some("gpt-5".to_string()),
        repo_path: Some("/work/orgii".to_string()),
        branch: Some("develop".to_string()),
        input_tokens: 100,
        output_tokens: 20,
        tokens_observed: true,
        continuation_group_key: Some("first-user".to_string()),
        continuation_observed: true,
        updated_at_ms: Some(1_774_137_600_000),
        ..ReplayCatalogProjection::default()
    };
    let cursor = serde_json::json!({"catalog": projection}).to_string();
    let tx = conn.transaction().expect("catalog transaction");
    publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        "g1",
        2,
        true,
        1_774_137_600_000_000_000,
        &cursor,
    )
    .expect("publish catalog");
    tx.commit().expect("commit catalog");

    let row = conn
        .query_row(
            "SELECT name,model,repo_path,branch,input_tokens,output_tokens,
                        files_changed,lines_added,lines_removed,touched_files_json,
                        source_metadata_json
                 FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .expect("published row");
    assert_eq!(row.0, "bounded replay title");
    assert_eq!(row.1, "gpt-5");
    assert_eq!(row.2, "/work/orgii");
    assert_eq!(row.3, "develop");
    assert_eq!((row.4, row.5), (100, 20));
    assert_eq!((row.6, row.7, row.8), (1, 2, 1));
    assert_eq!(row.9, r#"["src/new.rs"]"#);
    let metadata: Value = serde_json::from_str(&row.10).expect("metadata JSON");
    assert_eq!(metadata.get("keep"), Some(&Value::Bool(true)));
    assert_eq!(
        metadata
            .get(imported_cache::CONTINUATION_GROUP_KEY_FIELD)
            .and_then(Value::as_str),
        Some("first-user")
    );
}

#[test]
fn replay_catalog_publish_rolls_back_with_replay_transaction() {
    let mut conn = catalog_fixture();
    let cursor = serde_json::json!({
        "catalog": ReplayCatalogProjection {
            model: Some("must-rollback".to_string()),
            ..ReplayCatalogProjection::default()
        }
    })
    .to_string();
    {
        let tx = conn.transaction().expect("catalog transaction");
        publish_from_replay_tx(
            &tx,
            ImportedHistorySourceId::CodexApp,
            "fixture",
            "g1",
            2,
            true,
            1,
            &cursor,
        )
        .expect("publish then rollback");
        // Dropping an uncommitted transaction rolls back both replay and
        // catalog publication.
    }
    let model: String = conn
        .query_row(
            "SELECT model FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
            [],
            |row| row.get(0),
        )
        .expect("rolled-back model");
    assert_eq!(model, "old-model");
    assert_eq!(
        derivation_count(&conn),
        0,
        "the baseline/applied guard must roll back with its projection"
    );
}

#[test]
fn replay_catalog_prune_restores_unchanged_adapter_baseline() {
    let mut conn = catalog_fixture();
    let baseline = current_catalog_snapshot(&mut conn);
    publish_fixture_projection(&mut conn);
    let applied = current_catalog_snapshot(&mut conn);
    assert_ne!(applied, baseline, "fixture must exercise a real overlay");
    assert_eq!(derivation_count(&conn), 1);

    let tx = conn.transaction().expect("catalog prune transaction");
    clear_replay_projection_tx(&tx, "codex_app", "fixture")
        .expect("clear unchanged replay projection");
    tx.commit().expect("commit catalog prune");

    assert_eq!(current_catalog_snapshot(&mut conn), baseline);
    assert_eq!(derivation_count(&conn), 0);
}

#[test]
fn replay_catalog_prune_preserves_newer_adapter_refresh() {
    let mut conn = catalog_fixture();
    publish_fixture_projection(&mut conn);
    conn.execute(
        "UPDATE imported_history_session_cache SET
                 source_fingerprint='adapter-new-fingerprint',
                 source_mtime_ms=123456,
                 name='adapter-title',
                 model='adapter-model',
                 repo_path='/adapter/repo',
                 source_metadata_json='{\"adapter\":true}',
                 updated_at='2026-07-23T12:00:00Z'
             WHERE source='codex_app' AND source_session_id='fixture'",
        [],
    )
    .expect("simulate adapter refresh");
    let refreshed = current_catalog_snapshot(&mut conn);

    let tx = conn.transaction().expect("catalog prune transaction");
    clear_replay_projection_tx(&tx, "codex_app", "fixture")
        .expect("clear replay projection after adapter refresh");
    tx.commit().expect("commit catalog prune");

    assert_eq!(
        current_catalog_snapshot(&mut conn),
        refreshed,
        "eviction must not roll a newer adapter row back to the old baseline"
    );
    assert_eq!(derivation_count(&conn), 0);
}

#[test]
fn replay_catalog_prune_rolls_back_atomically() {
    let mut conn = catalog_fixture();
    publish_fixture_projection(&mut conn);
    let applied = current_catalog_snapshot(&mut conn);
    assert_eq!(derivation_count(&conn), 1);

    {
        let tx = conn.transaction().expect("catalog prune transaction");
        clear_replay_projection_tx(&tx, "codex_app", "fixture")
            .expect("clear replay projection before rollback");
        // Simulate an interrupted prune by dropping the transaction.
    }

    assert_eq!(current_catalog_snapshot(&mut conn), applied);
    assert_eq!(
        derivation_count(&conn),
        1,
        "projection and guard must remain visible together after rollback"
    );
}

#[test]
fn replay_catalog_publish_never_clears_unavailable_fields() {
    let mut conn = catalog_fixture();
    let cursor = serde_json::json!({
        "catalog": ReplayCatalogProjection::default()
    })
    .to_string();
    let tx = conn.transaction().expect("catalog transaction");
    publish_from_replay_tx(
        &tx,
        ImportedHistorySourceId::CodexApp,
        "fixture",
        "g1",
        99,
        true,
        123_000_000,
        &cursor,
    )
    .expect("publish partial catalog");
    tx.commit().expect("commit partial catalog");

    let row = conn
        .query_row(
            "SELECT name,model,repo_path,branch,input_tokens,files_changed,
                        lines_added,lines_removed,touched_files_json,
                        source_metadata_json,source_mtime_ms,source_size_bytes
                 FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .expect("preserved catalog row");
    assert_eq!(row.0, "fixture");
    assert_eq!(row.1, "old-model");
    assert_eq!(row.2, "/old");
    assert_eq!(row.3, "old");
    assert_eq!(row.4, 7);
    assert_eq!((row.5, row.6, row.7), (9, 9, 9));
    assert_eq!(row.8, r#"["old.rs"]"#);
    assert_eq!(row.9, r#"{"keep":true}"#);
    assert_eq!(
        (row.10, row.11),
        (999, 999),
        "replay snapshots must not overwrite adapter-owned discovery signatures"
    );
}
