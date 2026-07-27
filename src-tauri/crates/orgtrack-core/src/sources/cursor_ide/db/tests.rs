use super::*;

#[test]
fn raw_composer_detects_subagent_info_when_present() {
    let json = r#"{
        "composerId": "c6f60eb9-575a-4478-aef7-037ee6c9f620",
        "name": "Cleanup bucket A",
        "createdAt": 1746150752293,
        "status": "completed",
        "contextTokensUsed": 12345.0,
        "subagentInfo": {
            "subagentType": 3,
            "subagentTypeName": "generalPurpose",
            "parentComposerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2"
        }
    }"#;
    let row: RawComposerData = serde_json::from_str(json).expect("parse");
    let info = row.subagent_info.expect("subagent info");
    assert_eq!(info.subagent_type_name, "generalPurpose");
    assert_eq!(
        info.parent_composer_id,
        "df05eda5-7f2e-40d1-9e15-1667a1c49af2"
    );
}

#[test]
fn raw_composer_treats_missing_subagent_info_as_top_level() {
    let json = r#"{
        "composerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2",
        "name": "User-initiated session",
        "createdAt": 1746150752293,
        "status": "completed",
        "contextTokensUsed": 0.0
    }"#;
    let row: RawComposerData = serde_json::from_str(json).expect("parse");
    assert!(row.subagent_info.is_none());
}

#[test]
fn raw_composer_treats_null_subagent_info_as_top_level() {
    let json = r#"{
        "composerId": "abc",
        "name": "Top-level",
        "createdAt": 1,
        "status": "",
        "contextTokensUsed": 0.0,
        "subagentInfo": null
    }"#;
    let row: RawComposerData = serde_json::from_str(json).expect("parse");
    assert!(row.subagent_info.is_none());
}

#[test]
fn cursor_cache_metadata_round_trips() {
    let metadata = CursorCacheMetadata {
        status: "completed".to_string(),
        is_agentic: true,
        mode: "agent".to_string(),
        no_index_database_identity: Some("state-db-1".to_string()),
        no_index_activity_signature: Some("main:1:2|wal:-".to_string()),
        index_blob_validation: Some(CursorIndexBlobValidation {
            signature: "index+state".to_string(),
            misses: 2,
            database_identity: "state-db-1".to_string(),
        }),
    };
    let encoded = serde_json::to_string(&metadata).expect("encode");
    let decoded: CursorCacheMetadata = serde_json::from_str(&encoded).expect("decode");

    assert_eq!(decoded.status, "completed");
    assert!(decoded.is_agentic);
    assert_eq!(decoded.mode, "agent");
    assert_eq!(
        decoded.no_index_database_identity.as_deref(),
        Some("state-db-1")
    );
    assert_eq!(
        decoded.no_index_activity_signature.as_deref(),
        Some("main:1:2|wal:-")
    );
    assert_eq!(
        decoded.index_blob_validation.as_ref().map(|value| {
            (
                value.signature.as_str(),
                value.misses,
                value.database_identity.as_str(),
            )
        }),
        Some(("index+state", 2, "state-db-1"))
    );
}

fn index_db_with_rows() -> Connection {
    let conn = Connection::open_in_memory().expect("open index db");
    conn.execute(
        "CREATE TABLE conversations (id TEXT, title TEXT, updated_at INTEGER, \
         is_archived INTEGER, root_fingerprint TEXT, source TEXT)",
        [],
    )
    .expect("create conversations");
    for (id, title, updated, archived, fp, source) in [
        ("c1", "Local chat", 1700, 0, "fp1", "local"),
        ("c2", "Archived", 1800, 1, "fp2", "local"),
        ("c3", "Cloud only", 1900, 0, "fp3", "cloud-cache"),
    ] {
        conn.execute(
            "INSERT INTO conversations VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, title, updated, archived, fp, source],
        )
        .expect("insert conversation");
    }
    conn
}

#[test]
fn index_discovery_reads_only_local_rows() {
    let conn = index_db_with_rows();
    let mut rows = discover_from_index(&conn).expect("discover");
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    // cloud-cache row (c3) is excluded — its content isn't in state.vscdb.
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, "c1");
    assert_eq!(rows[0].title, "Local chat");
    assert_eq!(rows[0].updated_at_ms, 1700);
    assert!(!rows[0].is_archived);
    assert!(rows[1].is_archived);
}

#[test]
fn index_signature_tracks_update_archive_and_fingerprint() {
    let row = CursorIndexRow {
        id: "c1".into(),
        title: "t".into(),
        updated_at_ms: 1700,
        is_archived: false,
        root_fingerprint: "fp1".into(),
    };
    let sig = row.signature("/p/state.vscdb");
    assert_eq!(sig.source_session_id, "c1");
    assert_eq!(sig.source_mtime_ms, 1700);
    assert_eq!(sig.source_size_bytes, 0);
    assert_eq!(sig.source_fingerprint, "fp1");
    assert_eq!(sig.parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
    // Archiving alone changes the signature (rides in source_size_bytes).
    let archived = CursorIndexRow {
        is_archived: true,
        ..row.clone()
    };
    assert_ne!(
        archived.signature("/p").source_size_bytes,
        sig.source_size_bytes
    );
}

#[test]
fn build_input_from_index_without_composer_does_not_create_visible_shell() {
    let row = CursorIndexRow {
        id: "c9".into(),
        title: "Just title".into(),
        updated_at_ms: 4242,
        is_archived: false,
        root_fingerprint: "fp".into(),
    };
    let built = build_inputs_from_index(None, &row, "/store/state.vscdb").expect("build inputs");
    assert!(!built.child_list_authoritative);
    assert!(built.live_child_ids.is_empty());
    assert!(built.inputs.is_empty());
    assert_eq!(
        built.composer_availability,
        CursorComposerAvailability::TemporarilyUnavailable
    );
}

#[test]
fn build_input_from_index_with_composer_reads_rich_metadata() {
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    let composer = serde_json::json!({
        "composerId": "c1", "name": "Rich", "createdAt": 1000, "lastUpdatedAt": 2000,
        "status": "completed", "isAgentic": true, "unifiedMode": "agent",
        "totalLinesAdded": 5, "totalLinesRemoved": 2, "filesChangedCount": 1,
        "contextTokensUsed": 42.0,
        "trackedGitRepos": [{"repoPath": "/repo/orgii", "branches": [{"branchName": "fix/295"}]}],
        "originalFileStates": {
            "file:///repo/orgii/src/a.ts": {"isNewlyCreated": false, "contentKey": "k1"},
            "file:///repo/orgii/src/b.ts": {"isNewlyCreated": true, "contentKey": ""},
            "file:///repo/orgii/src/untouched.ts": {"isNewlyCreated": false, "contentKey": ""}
        },
        "fullConversationHeadersOnly": [{"bubbleId": "u1", "type": 1}]
    })
    .to_string();
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:c1', ?1)",
            params![composer],
        )
        .expect("insert composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('bubbleId:c1:u1', ?1)",
            params![serde_json::json!({
                "bubbleId": "u1", "type": 1, "text": "Help me fix this",
                "createdAt": "2026-07-20T00:00:00Z"
            })
            .to_string()],
        )
        .expect("insert user bubble");

    let row = CursorIndexRow {
        id: "c1".into(),
        title: "Index title".into(),
        updated_at_ms: 3000,
        is_archived: false,
        root_fingerprint: "fp".into(),
    };
    let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build inputs");
    assert!(built.child_list_authoritative);
    assert!(built.live_child_ids.is_empty());
    assert_eq!(built.inputs.len(), 1);
    let input = &built.inputs[0];
    // Rich fields come from the composer blob…
    assert_eq!(input.name, "Rich");
    assert_eq!(input.created_at_ms, 1000);
    assert_eq!(input.impact.lines_added, 5);
    assert_eq!(input.input_tokens, 42);
    // …including git + touched-file metadata (the point of the unification).
    assert_eq!(input.repo_path.as_deref(), Some("/repo/orgii"));
    assert_eq!(input.branch.as_deref(), Some("fix/295"));
    let mut touched = input.impact.touched_files.clone();
    touched.sort();
    // Edited (contentKey) + newly-created files, but not the untouched one.
    assert_eq!(
        touched,
        vec!["/repo/orgii/src/a.ts", "/repo/orgii/src/b.ts"]
    );
    // …while recency + change-signature come from the index row.
    assert_eq!(input.updated_at_ms, 3000);
    assert_eq!(input.source_mtime_ms, 3000);
    assert_eq!(input.source_fingerprint, "fp");
    assert!(input.listable);
}

#[test]
fn build_input_recovers_user_bubble_missing_from_composer_headers() {
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:missing-header', ?1)",
            params![serde_json::json!({
                "composerId": "missing-header",
                "name": "",
                "createdAt": 1000,
                "lastUpdatedAt": 2000,
                "fullConversationHeadersOnly": []
            })
            .to_string()],
        )
        .expect("insert composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('bubbleId:missing-header:user-1', ?1)",
            params![serde_json::json!({
                "bubbleId": "user-1",
                "type": 1,
                "text": "Recover me from the indexed bubble range",
                "createdAt": "2026-07-20T00:00:00Z"
            })
            .to_string()],
        )
        .expect("insert unlisted user bubble");

    let row = CursorIndexRow {
        id: "missing-header".into(),
        title: String::new(),
        updated_at_ms: 2000,
        is_archived: false,
        root_fingerprint: "fp".into(),
    };
    let built = build_inputs_from_index(Some(&cursor), &row, "/store/state.vscdb")
        .expect("build missing-header input");

    assert_eq!(built.inputs.len(), 1);
    assert!(built.inputs[0].listable);
    assert_eq!(
        built.inputs[0].name,
        "Recover me from the indexed bubble range"
    );
}

#[test]
fn empty_user_text_still_marks_an_untitled_cursor_session_listable() {
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:empty-user-text', ?1)",
            params![serde_json::json!({
                "composerId": "empty-user-text",
                "name": "",
                "createdAt": 1000,
                "lastUpdatedAt": 2000,
                "fullConversationHeadersOnly": [{"bubbleId": "user-1", "type": 1}]
            })
            .to_string()],
        )
        .expect("insert composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('bubbleId:empty-user-text:user-1', ?1)",
            params![serde_json::json!({
                "bubbleId": "user-1",
                "type": 1,
                "text": "   ",
                "createdAt": "2026-07-20T00:00:00Z"
            })
            .to_string()],
        )
        .expect("insert empty user bubble");

    let row = CursorIndexRow {
        id: "empty-user-text".into(),
        title: String::new(),
        updated_at_ms: 2000,
        is_archived: false,
        root_fingerprint: "fp".into(),
    };
    let built = build_inputs_from_index(Some(&cursor), &row, "/store/state.vscdb")
        .expect("build empty-user-text input");

    assert_eq!(built.inputs.len(), 1);
    assert!(built.inputs[0].listable);
    assert!(built.inputs[0].name.is_empty());
}

#[test]
fn changed_parent_builds_collapsible_subagent_rows() {
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    let parent = serde_json::json!({
        "composerId": "parent-1",
        "name": "Parent",
        "createdAt": 1000,
        "lastUpdatedAt": 3000,
        "subagentComposerIds": ["child-1", "child-1", "", "parent-1"],
        "fullConversationHeadersOnly": [{"bubbleId": "u1", "type": 1}]
    })
    .to_string();
    let child = serde_json::json!({
        "composerId": "child-1",
        "name": "Explore codebase",
        "createdAt": 1500,
        "lastUpdatedAt": 2500,
        "status": "completed",
        "subagentInfo": {
            "subagentTypeName": "explore",
            "parentComposerId": "parent-1",
            "toolCallId": "tool-1"
        }
    })
    .to_string();
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:parent-1', ?1)",
            params![parent],
        )
        .expect("insert parent");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:child-1', ?1)",
            params![child],
        )
        .expect("insert child");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('bubbleId:parent-1:u1', ?1)",
            params![serde_json::json!({
                "bubbleId": "u1", "type": 1, "text": "Delegate this task",
                "createdAt": "2026-07-20T00:00:00Z"
            })
            .to_string()],
        )
        .expect("insert parent user bubble");

    let row = CursorIndexRow {
        id: "parent-1".into(),
        title: "Index parent".into(),
        updated_at_ms: 3000,
        is_archived: false,
        root_fingerprint: "fp".into(),
    };
    let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build inputs");

    assert!(built.child_list_authoritative);
    assert_eq!(built.live_child_ids, vec!["child-1"]);
    assert_eq!(built.inputs.len(), 2);
    let parent_input = &built.inputs[0];
    assert!(parent_input.listable);
    assert!(parent_input.parent_session_id.is_none());
    let child_input = &built.inputs[1];
    assert_eq!(
        child_input.session_id,
        format!("{CURSORIDE_SESSION_PREFIX}child-1")
    );
    assert!(!child_input.listable);
    assert_eq!(
        child_input.parent_session_id.as_deref(),
        Some("cursoride-parent-1")
    );
    assert_eq!(child_input.name, "Explore codebase");
}

fn cursor_cache_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open cache db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init imported cache tables");
    conn
}

fn legacy_cursor_cache_input(id: &str, name: &str, listable: bool) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: id.to_string(),
        session_id: canonical_session_id(id),
        source_path: "/cursor/state.vscdb".to_string(),
        source_record_key: format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{id}"),
        source_mtime_ms: 100,
        source_size_bytes: 10,
        source_fingerprint: "legacy".to_string(),
        parser_version: 2,
        name: name.to_string(),
        created_at_ms: 100,
        updated_at_ms: 200,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: None,
        branch: None,
        impact: crate::sources::imported_history::metadata::ImportedHistoryImpactStats::default(),
        listable,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

fn cached_cursor_projection(conn: &Connection, id: &str) -> (i64, String, i64) {
    conn.query_row(
        "SELECT listable,name,parser_version
         FROM imported_history_session_cache
         WHERE source=?1 AND source_session_id=?2",
        params![SOURCE_CURSOR_IDE, id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("cached Cursor projection")
}

fn cached_cursor_metadata_string(conn: &Connection, id: &str, field: &str) -> Option<String> {
    conn.query_row(
        "SELECT source_metadata_json
         FROM imported_history_session_cache
         WHERE source=?1 AND source_session_id=?2",
        params![SOURCE_CURSOR_IDE, id],
        |row| row.get::<_, String>(0),
    )
    .expect("cached Cursor validation metadata")
    .parse::<serde_json::Value>()
    .ok()
    .and_then(|value| {
        value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    })
}

fn storage_snapshot(database_identity: &str, activity_signature: &str) -> CursorStorageSnapshot {
    CursorStorageSnapshot {
        database_identity: database_identity.to_string(),
        activity_signature: activity_signature.to_string(),
    }
}

fn cached_cursor_index_blob_validation(
    conn: &Connection,
    id: &str,
) -> Option<CursorIndexBlobValidation> {
    conn.query_row(
        "SELECT source_metadata_json
         FROM imported_history_session_cache
         WHERE source=?1 AND source_session_id=?2",
        params![SOURCE_CURSOR_IDE, id],
        |row| row.get::<_, String>(0),
    )
    .expect("cached Cursor index-blob metadata")
    .parse::<serde_json::Value>()
    .ok()
    .and_then(|value| value.get(INDEX_BLOB_VALIDATION_FIELD).cloned())
    .and_then(|value| serde_json::from_value(value).ok())
}

#[test]
fn missing_conversation_index_demotes_parser_v2_empty_shell_without_pruning_it() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input("empty-shell", "", true)],
    )
    .expect("seed polluted cache");
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:empty-shell', ?1)",
            params![serde_json::json!({
                "composerId": "empty-shell",
                "name": "",
                "createdAt": 100,
                "lastUpdatedAt": 200,
                "fullConversationHeadersOnly": []
            })
            .to_string()],
        )
        .expect("insert empty composer");

    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:-")),
    )
    .expect("repair cache without optional index");

    let (listable, name, parser_version) = cached_cursor_projection(&cache, "empty-shell");
    assert_eq!(listable, 0);
    assert!(name.is_empty());
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
}

#[test]
fn missing_conversation_index_promotes_valid_untitled_session_with_user_preview() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input("untitled", "", false)],
    )
    .expect("seed legacy cache");
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:untitled', ?1)",
            params![serde_json::json!({
                "composerId": "untitled",
                "name": "",
                "createdAt": 100,
                "lastUpdatedAt": 200,
                "fullConversationHeadersOnly": [{"bubbleId": "user-1", "type": 1}]
            })
            .to_string()],
        )
        .expect("insert composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('bubbleId:untitled:user-1', ?1)",
            params![serde_json::json!({
                "bubbleId": "user-1",
                "type": 1,
                "text": "  Explain   the authentication flow in plain language  ",
                "createdAt": "2026-07-20T00:00:00Z"
            })
            .to_string()],
        )
        .expect("insert user bubble");

    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:-")),
    )
    .expect("repair cache without optional index");

    let (listable, name, parser_version) = cached_cursor_projection(&cache, "untitled");
    assert_eq!(listable, 1);
    assert_eq!(name, "Explain the authentication flow in plain language");
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
}

#[test]
fn missing_source_blob_is_hidden_once_then_repromoted_after_physical_change() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(
            "temporarily-missing",
            "Real history",
            true,
        )],
    )
    .expect("seed valid cache");
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");

    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:-")),
    )
    .expect("hide missing source blob");

    let (listable, name, parser_version) = cached_cursor_projection(&cache, "temporarily-missing");
    assert_eq!(listable, 0);
    assert_eq!(name, "Real history");
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
    assert_eq!(
        cached_cursor_metadata_string(
            &cache,
            "temporarily-missing",
            NO_INDEX_ACTIVITY_SIGNATURE_FIELD,
        )
        .as_deref(),
        Some("main:100:10|wal:-")
    );

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:-")),
    )
    .expect("unchanged missing blob refresh");
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "a stamped missing blob must not be probed again for the same physical generation"
    );

    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:temporarily-missing', ?1)",
            params![serde_json::json!({
                "composerId": "temporarily-missing",
                "name": "",
                "createdAt": 100,
                "lastUpdatedAt": 300,
                "fullConversationHeadersOnly": [{"bubbleId": "user-1", "type": 1}]
            })
            .to_string()],
        )
        .expect("restore composer blob");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (
                'bubbleId:temporarily-missing:user-1', ?1
             )",
            params![serde_json::json!({
                "bubbleId": "user-1",
                "type": 1,
                "text": "Recovered Cursor history",
                "createdAt": "2026-07-26T04:00:00Z"
            })
            .to_string()],
        )
        .expect("restore user bubble");
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:4096:200")),
    )
    .expect("revalidate restored source blob");
    let (listable, name, parser_version) = cached_cursor_projection(&cache, "temporarily-missing");
    assert_eq!(listable, 1);
    assert_eq!(name, "Real history");
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
}

#[test]
fn malformed_source_blob_is_hidden_and_stamped_without_discarding_cached_metadata() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(
            "temporarily-malformed",
            "Keep this title",
            true,
        )],
    )
    .expect("seed cached Cursor card");
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (
                'composerData:temporarily-malformed', '{not-json'
             )",
            [],
        )
        .expect("insert malformed composer blob");

    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:200:20|wal:-")),
    )
    .expect("hide malformed source blob");

    assert_eq!(
        cached_cursor_projection(&cache, "temporarily-malformed"),
        (
            0,
            "Keep this title".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION
        )
    );
    assert_eq!(
        cached_cursor_metadata_string(
            &cache,
            "temporarily-malformed",
            NO_INDEX_ACTIVITY_SIGNATURE_FIELD,
        )
        .as_deref(),
        Some("main:200:20|wal:-")
    );
}

#[test]
fn transient_cursor_read_error_preserves_last_known_card_and_does_not_stamp_success() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(
            "temporarily-busy",
            "Last known good Cursor history",
            true,
        )],
    )
    .expect("seed last known Cursor card");
    // A missing table produces the same adapter-level read error path used for
    // SQLITE_BUSY/LOCKED. It is not evidence that the composer was deleted.
    let unreadable_cursor = Connection::open_in_memory().expect("open unreadable Cursor DB");
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&unreadable_cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:300:30|wal:-")),
    )
    .expect("conservatively tolerate one bounded read failure");

    assert_eq!(
        cached_cursor_projection(&cache, "temporarily-busy"),
        (1, "Last known good Cursor history".to_string(), 2,)
    );
    assert!(
        cached_cursor_metadata_string(
            &cache,
            "temporarily-busy",
            NO_INDEX_ACTIVITY_SIGNATURE_FIELD,
        )
        .is_none(),
        "a failed read must remain retryable instead of being stamped as validation"
    );
}

#[test]
fn definitively_missing_cursor_database_hides_old_ghosts_without_deleting_cache_rows() {
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(
            "cursor-not-installed",
            "Old cached Cursor session",
            true,
        )],
    )
    .expect("seed old Cursor ghost");

    demote_definitively_missing_cursor_database(&cache)
        .expect("hide cards whose physical Cursor DB is absent");
    assert_eq!(
        cached_cursor_projection(&cache, "cursor-not-installed"),
        (
            0,
            "Old cached Cursor session".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION
        )
    );
    assert_eq!(
        cached_cursor_metadata_string(
            &cache,
            "cursor-not-installed",
            NO_INDEX_DATABASE_IDENTITY_FIELD,
        )
        .as_deref(),
        Some(CURSOR_STORAGE_MISSING_IDENTITY)
    );

    reset_cursor_content_probe_count();
    demote_definitively_missing_cursor_database(&cache).expect("unchanged absent database refresh");
    assert_eq!(cursor_content_probe_count(), 0);
}

#[test]
fn indexed_missing_blob_is_hidden_on_first_successful_validation_until_storage_changes() {
    let id = "indexed-missing";
    let mut cache = cursor_cache_conn();
    let mut cached = legacy_cursor_cache_input(id, "Previously valid Cursor history", true);
    // Match the index signature exactly. This proves the migration candidate
    // does not depend on changed-record discovery: an old visible card without
    // a validation stamp must still be checked once.
    cached.source_path = "/cursor/state.vscdb".to_string();
    cached.source_mtime_ms = 300;
    cached.source_size_bytes = 0;
    cached.source_fingerprint = "fp-new".to_string();
    cached.parser_version = CURSOR_IDE_METADATA_PARSER_VERSION;
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &[cached])
        .expect("seed previously valid indexed card");
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
            "INSERT INTO conversations VALUES (?1,'Indexed title',300,0,'fp-new','local')",
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

    let physical_one = storage_snapshot("state-db-1", "main:300:30|wal:-");
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&physical_one),
    )
    .expect("first definitive missing-blob refresh");
    assert_eq!(
        cached_cursor_projection(&cache, id),
        (
            0,
            "Previously valid Cursor history".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION,
        ),
        "a successful point-read that proves the composer absent must hide the stale card"
    );
    assert_eq!(
        cached_cursor_index_blob_validation(&cache, id)
            .as_ref()
            .map(|value| value.misses),
        Some(2)
    );

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&physical_one),
    )
    .expect("unchanged hidden shell refresh");
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "stable index + physical signatures must not repeatedly probe the missing blob"
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
        .expect("restore indexed composer");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
            params![
                format!("{BUBBLE_KEY_PREFIX}{id}:u1"),
                serde_json::json!({
                    "bubbleId": "u1",
                    "type": 1,
                    "text": "Restored indexed Cursor history",
                    "createdAt": "2026-07-26T04:00:00Z"
                })
                .to_string()
            ],
        )
        .expect("restore indexed user bubble");

    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:300:30|wal:4096:400")),
    )
    .expect("promote restored indexed composer");
    let (listable, name, parser_version) = cached_cursor_projection(&cache, id);
    assert_eq!(listable, 1);
    assert_eq!(name, "Indexed title");
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
    assert_eq!(
        cached_cursor_index_blob_validation(&cache, id)
            .as_ref()
            .map(|value| value.misses),
        Some(0),
        "a successful materialization replaces the missing guard with a compact valid stamp"
    );

    reset_cursor_content_probe_count();
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:300:30|wal:4096:400")),
    )
    .expect("unchanged valid indexed refresh");
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "a successful validation stamp must keep unchanged indexed cards metadata-only"
    );
}

#[test]
fn indexed_transient_blob_read_error_preserves_last_known_card_without_stamping() {
    let id = "indexed-temporarily-unreadable";
    let mut cache = cursor_cache_conn();
    let mut cached = legacy_cursor_cache_input(id, "Last known indexed history", true);
    cached.source_path = "/cursor/state.vscdb".to_string();
    cached.source_mtime_ms = 300;
    cached.source_size_bytes = 0;
    cached.source_fingerprint = "fp-current".to_string();
    cached.parser_version = CURSOR_IDE_METADATA_PARSER_VERSION;
    source_cache::upsert_imported_session_cache_from_conn(&mut cache, &[cached])
        .expect("seed last known indexed card");

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
            "INSERT INTO conversations VALUES (?1,'Indexed title',300,0,'fp-current','local')",
            [id],
        )
        .expect("insert indexed conversation");

    // A missing cursorDiskKV table exercises the same adapter-level query
    // error branch as SQLITE_BUSY/LOCKED and permission/open failures. It is
    // not positive evidence that the indexed composer was deleted.
    let unreadable_cursor = Connection::open_in_memory().expect("open unreadable Cursor DB");
    delta_sync_from_connections(
        &mut cache,
        Some(&index),
        Some(&unreadable_cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:300:30|wal:-")),
    )
    .expect("preserve projection across transient point-read failure");

    assert_eq!(
        cached_cursor_projection(&cache, id),
        (
            1,
            "Last known indexed history".to_string(),
            CURSOR_IDE_METADATA_PARSER_VERSION,
        )
    );
    assert!(
        cached_cursor_index_blob_validation(&cache, id).is_none(),
        "an indeterminate read must remain retryable instead of stamping a definitive miss"
    );
}

#[test]
fn cursor_placeholder_titles_yield_to_first_real_user_preview() {
    let id = "d3880bd5-3420-4d93-8f48-abef565346b2";
    let preview = Some("Explain the replay architecture");
    for placeholder in [
        "",
        id,
        "11111111-2222-4333-8444-555555555555",
        &format!("{CURSORIDE_SESSION_PREFIX}{id}"),
        &format!("{COMPOSER_KEY_PREFIX}{id}"),
        &format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{id}"),
        "New Agent",
        "New Chat",
        "Untitled",
        "Untitled Cursor session",
        "Cursor session",
        "Composer",
    ] {
        assert_eq!(
            preferred_cursor_title(id, placeholder, "", preview),
            "Explain the replay architecture",
            "placeholder title {placeholder:?} must not leak into the sidebar"
        );
    }
    assert_eq!(
        preferred_cursor_title(id, "Investigate issue 443", "", preview),
        "Investigate issue 443"
    );
}

#[test]
fn unchanged_no_index_shell_skips_repeated_blob_probes_and_rechecks_on_source_change() {
    let id = "d3880bd5-3420-4d93-8f48-abef565346b2";
    let mut cache = cursor_cache_conn();
    source_cache::upsert_imported_session_cache_from_conn(
        &mut cache,
        &[legacy_cursor_cache_input(id, id, true)],
    )
    .expect("seed polluted UUID shell");
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
            params![
                format!("{COMPOSER_KEY_PREFIX}{id}"),
                serde_json::json!({
                    "composerId": id,
                    "name": id,
                    "createdAt": 100,
                    "lastUpdatedAt": 200,
                    "fullConversationHeadersOnly": []
                })
                .to_string()
            ],
        )
        .expect("insert empty composer shell");

    let generation_one = storage_snapshot("state-db-1", "main:100:10|wal:-");
    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&generation_one),
    )
    .expect("validate empty shell");
    let (listable, name, parser_version) = cached_cursor_projection(&cache, id);
    assert_eq!(listable, 0, "an empty composer shell must stay hidden");
    assert!(
        name.is_empty(),
        "a raw composer UUID must not become a title"
    );
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);

    reset_cursor_content_probe_count();
    for _ in 0..2 {
        delta_sync_from_connections(
            &mut cache,
            None,
            Some(&cursor),
            "/cursor/state.vscdb",
            Some(&generation_one),
        )
        .expect("unchanged refresh");
    }
    assert_eq!(
        cursor_content_probe_count(),
        0,
        "two unchanged refreshes must not point-read the composer blob again"
    );

    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (?1, ?2)",
            params![
                format!("{BUBBLE_KEY_PREFIX}{id}:user-1"),
                serde_json::json!({
                    "bubbleId": "user-1",
                    "type": 1,
                    "text": "Show the real Cursor conversation",
                    "createdAt": "2026-07-26T04:00:00Z"
                })
                .to_string()
            ],
        )
        .expect("append real user bubble");

    delta_sync_from_connections(
        &mut cache,
        None,
        Some(&cursor),
        "/cursor/state.vscdb",
        Some(&storage_snapshot("state-db-1", "main:100:10|wal:4096:200")),
    )
    .expect("revalidate after physical source change");
    let (listable, name, parser_version) = cached_cursor_projection(&cache, id);
    assert_eq!(listable, 1);
    assert_eq!(name, "Show the real Cursor conversation");
    assert_eq!(parser_version, CURSOR_IDE_METADATA_PARSER_VERSION);
    assert!(
        cursor_content_probe_count() > 0,
        "a changed source must recheck the known composer"
    );
}

#[path = "tests/validation_regressions.rs"]
mod validation_regressions;
