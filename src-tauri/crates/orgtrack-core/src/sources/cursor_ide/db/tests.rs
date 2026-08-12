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
    };
    let encoded = serde_json::to_string(&metadata).expect("encode");
    let decoded: CursorCacheMetadata = serde_json::from_str(&encoded).expect("decode");

    assert_eq!(decoded.status, "completed");
    assert!(decoded.is_agentic);
    assert_eq!(decoded.mode, "agent");
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
        children: Vec::new(),
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

fn cursor_db_with_headers(headers: serde_json::Value) -> Connection {
    let conn = Connection::open_in_memory().expect("open Cursor db");
    conn.execute(
        "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .expect("create ItemTable");
    conn.execute(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .expect("create cursorDiskKV");
    conn.execute(
        "INSERT INTO ItemTable VALUES (?1, ?2)",
        params![COMPOSER_HEADERS_KEY, headers.to_string()],
    )
    .expect("insert composer headers");
    conn
}

#[test]
fn header_discovery_supports_cursor_without_conversation_search_db() {
    let conn = cursor_db_with_headers(serde_json::json!({
        "allComposers": [
            {
                "type": "head",
                "composerId": "current",
                "name": "Repo exploration",
                "createdAt": 1000,
                "lastUpdatedAt": 2000,
                "conversationCheckpointLastUpdatedAt": 3000,
                "isArchived": false
            },
            {
                "type": "head",
                "composerId": "subagent",
                "name": "Explore",
                "lastUpdatedAt": 4000,
                "subagentInfo": {
                    "subagentTypeName": "explore",
                    "parentComposerId": "current",
                    "toolCallId": "tool-1"
                }
            },
            {
                "type": "head",
                "composerId": "empty-state-draft",
                "createdAt": 4500,
                "isDraft": true
            },
            {"type": "head", "composerId": "  ", "name": "Invalid"}
        ]
    }));

    let rows = discover_from_headers(&conn)
        .expect("discover")
        .expect("authoritative headers");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "current");
    assert_eq!(rows[0].title, "Repo exploration");
    assert_eq!(rows[0].updated_at_ms, 3000);
    assert!(!rows[0].is_archived);
    assert!(rows[0].root_fingerprint.contains("Repo exploration"));
    assert_eq!(rows[0].children.len(), 1);
    assert_eq!(rows[0].children[0].id, "subagent");
    assert_eq!(rows[0].children[0].title, "Explore");
    assert_eq!(rows[0].children[0].updated_at_ms, 4000);
    assert!(rows[0].root_fingerprint.contains("subagent:4000"));
}

#[test]
fn missing_or_partial_headers_are_not_authoritative_empty_results() {
    let conn = Connection::open_in_memory().expect("open Cursor db");
    conn.execute(
        "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .expect("create ItemTable");
    assert!(discover_from_headers(&conn)
        .expect("missing headers")
        .is_none());

    conn.execute(
        "INSERT INTO ItemTable VALUES (?1, '{')",
        params![COMPOSER_HEADERS_KEY],
    )
    .expect("insert partial headers");
    assert!(discover_from_headers(&conn)
        .expect("partial headers")
        .is_none());

    conn.execute(
        "UPDATE ItemTable SET value = NULL WHERE key = ?1",
        params![COMPOSER_HEADERS_KEY],
    )
    .expect("null composer headers");
    assert!(discover_from_headers(&conn)
        .expect("null headers")
        .is_none());
}

#[test]
fn build_input_from_index_without_composer_uses_index_fields() {
    let row = CursorIndexRow {
        id: "c9".into(),
        title: "Just title".into(),
        updated_at_ms: 4242,
        is_archived: false,
        root_fingerprint: "fp".into(),
        children: Vec::new(),
    };
    let built = build_inputs_from_index(None, &row, "/store/state.vscdb").expect("build inputs");
    assert!(!built.child_list_authoritative);
    assert!(built.live_child_ids.is_empty());
    assert_eq!(built.inputs.len(), 1);
    let input = &built.inputs[0];
    assert_eq!(input.session_id, format!("{CURSORIDE_SESSION_PREFIX}c9"));
    assert_eq!(input.name, "Just title");
    assert_eq!(input.created_at_ms, 4242);
    assert_eq!(input.updated_at_ms, 4242);
    assert_eq!(input.source_mtime_ms, 4242);
    assert!(input.listable);
    assert!(input.model.is_none());
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
        }
    })
    .to_string();
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:c1', ?1)",
            params![composer],
        )
        .expect("insert composer");

    let row = CursorIndexRow {
        id: "c1".into(),
        title: "Index title".into(),
        updated_at_ms: 3000,
        is_archived: false,
        root_fingerprint: "fp".into(),
        children: Vec::new(),
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
}

#[test]
fn composer_uses_header_title_and_time_when_blob_fields_are_empty() {
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
                'composerData:c1',
                '{\"composerId\":\"c1\",\"name\":\"\",\"createdAt\":0}'
            )",
            [],
        )
        .expect("insert composer");
    let row = CursorIndexRow {
        id: "c1".into(),
        title: "Header title".into(),
        updated_at_ms: 4242,
        is_archived: false,
        root_fingerprint: "headers".into(),
        children: Vec::new(),
    };

    let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build");
    assert_eq!(built.inputs[0].name, "Header title");
    assert_eq!(built.inputs[0].created_at_ms, 4242);
    assert_eq!(built.inputs[0].updated_at_ms, 4242);
}

#[test]
fn null_composer_blob_degrades_to_header_metadata() {
    let cursor = Connection::open_in_memory().expect("open cursor db");
    cursor
        .execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES ('composerData:draft', NULL)",
            [],
        )
        .expect("insert null draft");
    let row = CursorIndexRow {
        id: "draft".into(),
        title: "Unsaved draft".into(),
        updated_at_ms: 4242,
        is_archived: false,
        root_fingerprint: "headers".into(),
        children: Vec::new(),
    };

    let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build");
    assert!(!built.child_list_authoritative);
    assert_eq!(built.inputs[0].name, "Unsaved draft");
    assert_eq!(built.inputs[0].updated_at_ms, 4242);
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
        "subagentComposerIds": ["child-1", "child-1", "", "parent-1"]
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

    let row = CursorIndexRow {
        id: "parent-1".into(),
        title: "Index parent".into(),
        updated_at_ms: 3000,
        is_archived: false,
        root_fingerprint: "fp".into(),
        children: Vec::new(),
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

#[test]
fn header_child_stays_collapsed_when_parent_blob_omits_child_ids() {
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
                'composerData:parent-1',
                '{\"composerId\":\"parent-1\",\"name\":\"Parent\",\"createdAt\":1000}'
            )",
            [],
        )
        .expect("insert parent");
    cursor
        .execute(
            "INSERT INTO cursorDiskKV VALUES (
                'composerData:child-1',
                '{\"composerId\":\"child-1\",\"name\":\"\",\"createdAt\":0,
                  \"subagentInfo\":{\"parentComposerId\":\"parent-1\"}}'
            )",
            [],
        )
        .expect("insert child");

    let row = CursorIndexRow {
        id: "parent-1".into(),
        title: "Index parent".into(),
        updated_at_ms: 3000,
        is_archived: false,
        root_fingerprint: "header-child".into(),
        children: vec![CursorIndexChild {
            id: "child-1".into(),
            title: "Explore from header".into(),
            updated_at_ms: 4000,
        }],
    };
    let built = build_inputs_from_index(Some(&cursor), &row, "/store").expect("build inputs");

    assert!(built.child_list_authoritative);
    assert_eq!(built.live_child_ids, vec!["child-1"]);
    assert_eq!(built.inputs.len(), 2);
    assert_eq!(built.inputs[1].name, "Explore from header");
    assert_eq!(built.inputs[1].updated_at_ms, 4000);
    assert_eq!(
        built.inputs[1].parent_session_id.as_deref(),
        Some("cursoride-parent-1")
    );
}

#[test]
fn cached_list_applies_filter_before_offset_like_page_zero() {
    let mut cache_conn = Connection::open_in_memory().expect("open cache");
    crate::store::sqlite::SqliteRecordStore::init_tables(&cache_conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&cache_conn)
        .expect("init source cache");

    // Newest-first cache order: A (4000), hidden (3000), B (2000), C (1000).
    let mut inputs = Vec::new();
    for (id, title, updated) in [
        ("a", "Visible A", 4000),
        ("x", "hidden", 3000),
        ("b", "Visible B", 2000),
        ("c", "Visible C", 1000),
    ] {
        let row = CursorIndexRow {
            id: id.into(),
            title: title.into(),
            updated_at_ms: updated,
            is_archived: false,
            root_fingerprint: "fp".into(),
            children: Vec::new(),
        };
        let built = build_inputs_from_index(None, &row, "/store/state.vscdb").expect("build");
        inputs.extend(built.inputs);
    }
    source_cache::upsert_imported_session_cache_from_conn(&mut cache_conn, &inputs)
        .expect("seed cache");

    // Page zero filters, THEN applies limit/offset, so continuation offsets
    // are positions in the filtered stream. The cached continuation reader
    // must apply the same filter, or offset 2 would land on "Visible B"
    // again (raw index 2) — a duplicate — instead of "Visible C".
    let include = |row: &CursorSession| Ok(row.name != "hidden");
    let (page_zero, has_more) =
        list_for_sidebar_filtered_cached(&cache_conn, 2, 0, include).expect("page zero");
    assert_eq!(
        page_zero
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["Visible A", "Visible B"]
    );
    assert!(has_more);

    let (continuation, has_more) =
        list_for_sidebar_filtered_cached(&cache_conn, 2, 2, include).expect("continuation");
    assert_eq!(
        continuation
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["Visible C"]
    );
    assert!(!has_more);
}

#[test]
fn unrecognized_header_types_filtering_to_empty_are_not_authoritative() {
    // A future Cursor renaming `type: "head"` must not read as "the user
    // deleted every session" — that would prune the whole cache.
    let conn = cursor_db_with_headers(serde_json::json!({
        "allComposers": [
            {"type": "future-head", "composerId": "c1", "name": "One", "lastUpdatedAt": 1000},
            {"type": "future-head", "composerId": "c2", "name": "Two", "lastUpdatedAt": 2000}
        ]
    }));

    assert!(discover_from_headers(&conn).expect("discover").is_none());
}

#[test]
fn draft_only_headers_are_an_authoritative_empty() {
    // All-draft registries are a real state (fresh Cursor with only the New
    // Agent screen open) and stay authoritative: no roots exist.
    let conn = cursor_db_with_headers(serde_json::json!({
        "allComposers": [
            {"type": "head", "composerId": "empty-state-draft", "isDraft": true}
        ]
    }));

    let rows = discover_from_headers(&conn)
        .expect("discover")
        .expect("authoritative");
    assert!(rows.is_empty());
}

fn empty_index_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open index db");
    conn.execute(
        "CREATE TABLE conversations (id TEXT, title TEXT, updated_at INTEGER, \
         is_archived INTEGER, root_fingerprint TEXT, source TEXT)",
        [],
    )
    .expect("create conversations");
    conn
}

#[test]
fn empty_index_defers_to_nonempty_headers() {
    // A readable-but-empty conversation-search.db (e.g. a Cursor build that
    // stopped maintaining it but left the file behind) must not shadow a
    // headers registry that still sees sessions.
    let index = empty_index_db();
    let cursor = cursor_db_with_headers(serde_json::json!({
        "allComposers": [
            {"type": "head", "composerId": "current", "name": "Repo exploration",
             "createdAt": 1000, "lastUpdatedAt": 2000}
        ]
    }));

    let rows = discover_sessions(Some(&index), Some(&cursor)).expect("authoritative");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "current");
}

#[test]
fn empty_index_stands_when_headers_agree_or_are_unavailable() {
    let index = empty_index_db();

    // Headers unavailable (no cursor conn): the empty index is authoritative,
    // as it was before headers discovery existed.
    let rows = discover_sessions(Some(&index), None).expect("authoritative");
    assert!(rows.is_empty());

    // Headers present and also empty: both sources agree.
    let cursor = cursor_db_with_headers(serde_json::json!({ "allComposers": [] }));
    let rows = discover_sessions(Some(&index), Some(&cursor)).expect("authoritative");
    assert!(rows.is_empty());

    // Index unreadable and headers unavailable: nothing authoritative.
    assert!(discover_sessions(None, None).is_none());
}

#[test]
fn nonempty_index_wins_over_headers() {
    let index = index_db_with_rows();
    let cursor = cursor_db_with_headers(serde_json::json!({
        "allComposers": [
            {"type": "head", "composerId": "header-only", "name": "H", "lastUpdatedAt": 1}
        ]
    }));

    let rows = discover_sessions(Some(&index), Some(&cursor)).expect("authoritative");
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.id != "header-only"));
}
