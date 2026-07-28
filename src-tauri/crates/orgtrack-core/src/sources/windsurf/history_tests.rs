use super::*;
use rusqlite::Connection;
use serde_json::Value;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .expect("create cursorDiskKV");

    let composer = r#"{
        "composerId":"composer-1",
        "name":"Build Windsurf import",
        "createdAt":1770000000000,
        "lastUpdatedAt":1770000005000,
        "status":"completed",
        "modelConfig":{"modelName":"windsurf-model"},
        "contextTokensUsed":123,
        "trackedGitRepos":[{"repoPath":"/tmp/windsurf-repo","branches":[{"branchName":"main"}]}],
        "fullConversationHeadersOnly":[
            {"bubbleId":"u1","type":1},
            {"bubbleId":"t1","type":2},
            {"bubbleId":"a1","type":2}
        ]
    }"#;
    let user_bubble = r#"{
        "type":1,
        "bubbleId":"u1",
        "createdAt":"2026-02-01T00:00:00Z",
        "text":"hello windsurf"
    }"#;
    let tool_bubble = r#"{
        "type":2,
        "bubbleId":"t1",
        "createdAt":"2026-02-01T00:00:01Z",
        "text":"",
        "toolFormerData":{
            "name":"terminal_command",
            "toolCallId":"call-1",
            "status":"completed",
            "params":"{\"command\":\"pwd\"}",
            "result":"{\"output\":\"/tmp/windsurf-repo\"}",
            "additionalData":{}
        }
    }"#;
    let assistant_bubble = r#"{
        "type":2,
        "bubbleId":"a1",
        "createdAt":"2026-02-01T00:00:02Z",
        "text":"done"
    }"#;

    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["composerData:composer-1", composer],
    )
    .expect("insert composer");
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["bubbleId:composer-1:u1", user_bubble],
    )
    .expect("insert user bubble");
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["bubbleId:composer-1:t1", tool_bubble],
    )
    .expect("insert tool bubble");
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["bubbleId:composer-1:a1", assistant_bubble],
    )
    .expect("insert assistant bubble");

    conn
}

#[test]
fn includes_windsurf_candidate_db_paths() {
    let paths = windsurf_db_candidate_paths();
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(rendered.iter().any(|path| path.contains("Windsurf")));
    assert!(rendered.iter().any(|path| path.contains(".windsurf")));
    assert!(!rendered.iter().any(|path| path.contains("Devin")));
    assert!(!rendered.iter().any(|path| path.contains(".devin")));
}

#[test]
fn maps_windsurf_composer_metadata_to_cache_input() {
    let conn = fixture_conn();

    let metas = list_windsurf_composer_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/state.vscdb"),
        1770000006000,
        4096,
    )
    .expect("list composer metadata");
    let inputs = metas
        .into_iter()
        .map(composer_meta_to_cache_input)
        .collect::<Vec<_>>();

    assert_eq!(inputs.len(), 1);
    let row = imported_cache::ImportedHistoryCachedSession {
        source_session_id: inputs[0].source_session_id.clone(),
        session_id: inputs[0].session_id.clone(),
        source_path: inputs[0].source_path.clone(),
        source_record_key: inputs[0].source_record_key.clone(),
        source_mtime_ms: inputs[0].source_mtime_ms,
        source_size_bytes: inputs[0].source_size_bytes,
        source_fingerprint: inputs[0].source_fingerprint.clone(),
        parser_version: inputs[0].parser_version,
        name: inputs[0].name.clone(),
        created_at_ms: inputs[0].created_at_ms,
        updated_at_ms: inputs[0].updated_at_ms,
        model: inputs[0].model.clone(),
        input_tokens: inputs[0].input_tokens,
        output_tokens: inputs[0].output_tokens,
        repo_path: inputs[0].repo_path.clone(),
        repo_root_path: None,
        repo_remote_urls: Vec::new(),
        branch: inputs[0].branch.clone(),
        impact: inputs[0].impact.clone(),
        listable: inputs[0].listable,
        source_metadata_json: inputs[0].source_metadata_json.clone(),
        parent_session_id: inputs[0].parent_session_id.clone(),
    }
    .to_row();
    assert_eq!(row.session_id, "windsurfapp-composer-1");
    assert_eq!(row.name, "Build Windsurf import");
    assert_eq!(row.category, imported_history::IMPORTED_HISTORY_CATEGORY);
    assert!(row.read_only);
    assert_eq!(row.model.as_deref(), Some("windsurf-model"));
    assert_eq!(row.total_tokens, 123);
    assert_eq!(row.repo_path.as_deref(), Some("/tmp/windsurf-repo"));
    assert_eq!(row.repo_name.as_deref(), Some("windsurf-repo"));
    assert_eq!(row.branch.as_deref(), Some("main"));
}

#[test]
fn parses_windsurf_bubbles_into_replay_chunks() {
    let conn = fixture_conn();

    let chunks = load_windsurf_history_from_conn(&conn, "windsurfapp-composer-1", "composer-1")
        .expect("load chunks");

    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].action_type, imported_history::ACTION_TYPE_RAW);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(
        chunks[1].action_type,
        imported_history::ACTION_TYPE_TOOL_CALL
    );
    assert_eq!(
        chunks[1].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        chunks[1].args.get("command").and_then(Value::as_str),
        Some("pwd")
    );
    assert_eq!(
        chunks[1].result.get("output").and_then(Value::as_str),
        Some("/tmp/windsurf-repo")
    );
    assert_eq!(
        chunks[2].action_type,
        imported_history::ACTION_TYPE_ASSISTANT
    );
    assert_eq!(chunks[2].function, imported_history::FUNCTION_ASSISTANT);
}

#[test]
fn maps_windsurf_subagent_parent_and_child_impact() {
    let conn = fixture_conn();
    let child = r#"{
        "composerId":"composer-child",
        "name":"Edit the child file",
        "createdAt":1770000006000,
        "lastUpdatedAt":1770000007000,
        "subagentInfo":{"parentComposerId":"composer-1"},
        "fullConversationHeadersOnly":[{"bubbleId":"edit1","type":2}]
    }"#;
    let edit = r#"{
        "type":2,
        "bubbleId":"edit1",
        "createdAt":"2026-02-01T00:00:03Z",
        "toolFormerData":{
            "name":"edit_file",
            "toolCallId":"call-edit",
            "status":"completed",
            "params":"{\"file_path\":\"src/child.ts\",\"old_content\":\"old\",\"new_content\":\"new\\nextra\"}",
            "result":"{}",
            "additionalData":{}
        }
    }"#;
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["composerData:composer-child", child],
    )
    .expect("insert child composer");
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        ["bubbleId:composer-child:edit1", edit],
    )
    .expect("insert child edit");

    let inputs = list_windsurf_composer_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/state.vscdb"),
        1770000008000,
        4096,
    )
    .expect("list metadata")
    .into_iter()
    .map(composer_meta_to_cache_input)
    .collect::<Vec<_>>();
    let child = inputs
        .iter()
        .find(|input| input.source_session_id == "composer-child")
        .expect("child input");

    assert_eq!(
        child.parent_session_id.as_deref(),
        Some("windsurfapp-composer-1")
    );
    assert_eq!(child.impact.touched_files, vec!["src/child.ts"]);
    assert_eq!(child.impact.lines_added, 2);
    assert_eq!(child.impact.lines_removed, 1);
    assert!(!child.listable);
}
