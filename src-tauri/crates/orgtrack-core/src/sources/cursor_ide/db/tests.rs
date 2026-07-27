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
fn build_input_from_index_without_composer_uses_index_fields() {
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
