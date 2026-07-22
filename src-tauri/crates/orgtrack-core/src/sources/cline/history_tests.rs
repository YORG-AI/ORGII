use super::*;

#[test]
fn strips_user_input_wrapper() {
    assert_eq!(
        strip_user_input_wrapper("<user_input mode=\"act\">hello world</user_input>"),
        "hello world"
    );
    assert_eq!(strip_user_input_wrapper("  plain text  "), "plain text");
    // Missing close tag → inner text after the opening tag.
    assert_eq!(
        strip_user_input_wrapper("<user_input mode=\"plan\">unterminated"),
        "unterminated"
    );
}

#[test]
fn value_to_text_flattens_shapes() {
    assert_eq!(
        value_to_text(Some(&serde_json::json!("raw output"))),
        "raw output"
    );
    assert_eq!(
        value_to_text(Some(&serde_json::json!([
            {"type": "text", "text": "line one"},
            {"query": "q", "result": "line two"}
        ]))),
        "line one\nline two"
    );
    assert_eq!(value_to_text(None), "");
    assert_eq!(value_to_text(Some(&serde_json::Value::Null)), "");
}

#[test]
fn source_id_round_trips_through_prefix() {
    let sid = format!("{CLINE_SESSION_PREFIX}1783926944985_kdo7y");
    assert_eq!(
        cline_source_id_from_session_id(&sid).unwrap(),
        "1783926944985_kdo7y"
    );
    assert!(cline_source_id_from_session_id("bogus").is_err());
    assert!(cline_source_id_from_session_id(CLINE_SESSION_PREFIX).is_err());
}

#[test]
fn sessions_dir_candidate_points_at_cline_store() {
    let home = std::path::Path::new("/home/u");
    let dirs = cline_sessions_dir_candidates(home);
    assert_eq!(
        dirs,
        vec![home.join(".cline").join("data").join("sessions")]
    );
}

#[test]
fn db_candidate_points_at_cline_session_index() {
    let home = std::path::Path::new("/home/u");
    assert_eq!(
        cline_db_path_candidates(home),
        vec![home
            .join(".cline")
            .join("data")
            .join("db")
            .join("sessions.db")]
    );
}

#[test]
fn catalog_metadata_does_not_read_a_thirty_mib_messages_document() {
    use std::io::Write;

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("orgii-cline-catalog-{unique}.messages.json"));
    let mut file = std::fs::File::create(&path).expect("create Cline fixture");
    let block = vec![b'x'; 64 * 1024];
    for _ in 0..(30 * 1024 / 64) {
        file.write_all(&block).expect("extend Cline document");
    }
    file.flush().expect("flush Cline fixture");
    let size = file.metadata().expect("Cline fixture metadata").len();
    drop(file);

    let discovered = ClineDiscoveredRecord {
        record: ImportedHistoryDiscoveredRecord {
            source_session_id: "large-cline".to_string(),
            source_path: path.clone(),
            source_record_key: "large-cline".to_string(),
            source_mtime_ms: 1_774_137_600_000_000_000,
            source_size_bytes: size as i64,
            source_fingerprint: "db-index-only".to_string(),
            parser_version: CLINE_METADATA_PARSER_VERSION,
        },
        db_meta: Some(ClineDbSessionMeta {
            session_id: "large-cline".to_string(),
            updated_at: "2026-07-22T00:00:01Z".to_string(),
            prompt: Some("Cline compact catalog".to_string()),
            model: Some("claude-sonnet-4".to_string()),
            workspace_root: Some("/work/cline".to_string()),
            messages_path: path.to_string_lossy().to_string(),
            ..ClineDbSessionMeta::default()
        }),
    };
    let input = session_meta_to_cache_input(
        parse_cline_session_meta(&discovered)
            .expect("parse compact Cline metadata")
            .expect("Cline catalog row"),
    );
    assert_eq!(input.name, "Cline compact catalog");
    assert_eq!(input.repo_path.as_deref(), Some("/work/cline"));
    assert_eq!(input.model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(input.impact.files_changed, 0);

    std::fs::remove_file(path).expect("remove Cline fixture");
}

#[test]
fn imports_db_indexed_subagent_without_hydrating_its_transcript() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("orgii-cline-{unique}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let messages_path = dir.join("agent_child.messages.json");
    std::fs::write(
        &messages_path,
        r#"{"messages":[{"role":"assistant","ts":1770000001000,"content":[{"type":"tool_use","id":"edit-1","name":"editor","input":{"path":"src/child.rs","old_text":"old","new_text":"new\nextra"}}]}]}"#,
    )
    .expect("write child transcript");
    let db_path = dir.join("sessions.db");
    let conn = Connection::open(&db_path).expect("open session db");
    conn.execute_batch(
        "CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            started_at TEXT,
            updated_at TEXT,
            provider TEXT,
            model TEXT,
            cwd TEXT,
            workspace_root TEXT,
            parent_session_id TEXT,
            is_subagent INTEGER,
            prompt TEXT,
            metadata_json TEXT,
            messages_path TEXT
        );",
    )
    .expect("create sessions table");
    conn.execute(
        "INSERT INTO sessions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11)",
        (
            "root__agent_child",
            "2026-02-01T00:00:00Z",
            "2026-02-01T00:00:01Z",
            "deepseek",
            "deepseek-v4",
            "/tmp/repo",
            "/tmp/repo",
            "root",
            "edit child file",
            r#"{"title":"Child task"}"#,
            messages_path.to_string_lossy().as_ref(),
        ),
    )
    .expect("insert child row");
    drop(conn);

    let discovered = discover_cline_db_records(&db_path).expect("discover db records");
    assert_eq!(discovered.len(), 1);
    let input = session_meta_to_cache_input(
        parse_cline_session_meta(&discovered[0])
            .expect("parse child")
            .expect("child metadata"),
    );

    assert_eq!(input.source_session_id, "root__agent_child");
    assert_eq!(input.parent_session_id.as_deref(), Some("clineapp-root"));
    assert_eq!(input.name, "Child task");
    assert!(input.impact.touched_files.is_empty());
    assert_eq!(input.impact.lines_added, 0);
    assert_eq!(input.impact.lines_removed, 0);

    std::fs::remove_dir_all(dir).expect("remove temp dir");
}

#[test]
fn transcript_to_chunks_pairs_tools_and_orders_turns() {
    let transcript: ClineTranscript = serde_json::from_str(
        r#"{
          "messages": [
            {"role": "user", "ts": 1000, "content": [
              {"type": "text", "text": "<user_input mode=\"act\">do the thing</user_input>"}
            ]},
            {"role": "assistant", "ts": 2000, "content": [
              {"type": "text", "text": "on it"},
              {"type": "tool_use", "id": "call_1", "name": "search_codebase", "input": {"query": "cline"}}
            ]},
            {"role": "user", "ts": 3000, "content": [
              {"type": "tool_result", "tool_use_id": "call_1", "content": [{"type": "text", "text": "found 3 hits"}]}
            ]},
            {"role": "assistant", "ts": 4000, "content": [
              {"type": "text", "text": "done"}
            ]}
          ]
        }"#,
    )
    .expect("parses");

    let chunks = transcript_to_chunks("clineapp-abc", &transcript);
    // user(text) + assistant(text) + tool_use + assistant(text) = 4 chunks;
    // the tool_result block is consumed as the tool's output, not its own chunk.
    assert_eq!(chunks.len(), 4);

    // First is the unwrapped user message.
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(chunks[0].result["message"]["content"], "do the thing");

    // A non-batched shape (singular `query`, unknown to the expander) falls
    // through to a passthrough chunk carrying its args and paired result.
    let tool = &chunks[2];
    assert_eq!(tool.action_type, imported_history::ACTION_TYPE_TOOL_CALL);
    assert_eq!(tool.function, "search_codebase");
    assert_eq!(tool.args["query"], "cline");
    assert_eq!(tool.result["output"], "found 3 hits");
    assert_eq!(tool.created_at, imported_history::epoch_ms_to_iso(2000));
}

#[test]
fn expands_batched_cline_tools_into_single_op_chunks() {
    let transcript: ClineTranscript = serde_json::from_str(
        r#"{
          "messages": [
            {"role": "assistant", "ts": 2000, "content": [
              {"type": "tool_use", "id": "call_1", "name": "read_files", "input": {"files": [
                {"path": "/a.rs", "start_line": 1, "end_line": 2},
                {"path": "/b.rs", "start_line": 1, "end_line": 2}
              ]}}
            ]},
            {"role": "user", "ts": 3000, "content": [
              {"type": "tool_result", "tool_use_id": "call_1", "name": "read_files", "content": [
                {"query": "/a.rs:1-2", "result": " 1 | fn a() {}", "success": true},
                {"query": "/b.rs:1-2", "result": " 1 | fn b() {}", "success": true}
              ]}
            ]},
            {"role": "assistant", "ts": 4000, "content": [
              {"type": "tool_use", "id": "call_2", "name": "run_commands", "input": {"commands": ["echo hi", "ls"]}},
              {"type": "tool_use", "id": "call_3", "name": "editor", "input": {
                "path": "/a.rs", "old_text": "fn a() {}", "new_text": "fn a() { todo!() }"
              }}
            ]},
            {"role": "user", "ts": 5000, "content": [
              {"type": "tool_result", "tool_use_id": "call_2", "name": "run_commands", "content": [
                {"query": "echo hi", "result": "hi", "success": true},
                {"query": "ls", "result": "a.rs\nb.rs", "success": true}
              ]},
              {"type": "tool_result", "tool_use_id": "call_3", "name": "editor", "content": [
                {"query": "/a.rs", "result": "edited /a.rs", "success": true}
              ]}
            ]}
          ]
        }"#,
    )
    .expect("parses");

    let chunks = transcript_to_chunks("clineapp-abc", &transcript);
    let tools: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .collect();
    // 2 reads + 2 commands + 1 edit.
    assert_eq!(tools.len(), 5);

    // read_files → one read_file card per file, gutter stripped, paired by index.
    assert_eq!(tools[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(tools[0].args["file_path"], "/a.rs");
    assert_eq!(tools[0].result["output"], "fn a() {}");
    assert_eq!(tools[1].args["file_path"], "/b.rs");
    assert_eq!(tools[1].result["output"], "fn b() {}");

    // run_commands → one run_command_line card per command.
    assert_eq!(
        tools[2].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(tools[2].args["command"], "echo hi");
    assert_eq!(tools[2].result["output"], "hi");
    assert_eq!(tools[3].args["command"], "ls");
    assert_eq!(tools[3].result["output"], "a.rs\nb.rs");

    // editor → one edit_file_by_replace card with top-level old/new for the diff UI.
    assert_eq!(tools[4].function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(tools[4].args["file_path"], "/a.rs");
    assert_eq!(tools[4].args["old_string"], "fn a() {}");
    assert_eq!(tools[4].args["new_string"], "fn a() { todo!() }");
    assert_eq!(tools[4].result["output"], "edited /a.rs");
}

#[test]
fn editor_insert_and_create_map_to_empty_old_string() {
    // `editor` with a null `old_text` (file creation / insert_line) → empty
    // old_string so the diff UI renders it as an addition.
    let transcript: ClineTranscript = serde_json::from_str(
        r#"{
          "messages": [
            {"role": "assistant", "ts": 1000, "content": [
              {"type": "tool_use", "id": "e1", "name": "editor", "input": {
                "path": "/new.rs", "old_text": null, "new_text": "fn main() {}", "insert_line": 1
              }}
            ]}
          ]
        }"#,
    )
    .expect("parses");

    let chunks = transcript_to_chunks("clineapp-abc", &transcript);
    let edit = chunks
        .iter()
        .find(|chunk| chunk.function == imported_history::FUNCTION_EDIT_FILE)
        .expect("edit chunk");
    assert_eq!(edit.args["file_path"], "/new.rs");
    assert_eq!(edit.args["old_string"], "");
    assert_eq!(edit.args["new_string"], "fn main() {}");
}

#[test]
fn failed_editor_result_is_excluded_from_impact() {
    let transcript: ClineTranscript = serde_json::from_str(
        r#"{
          "messages": [
            {"role":"assistant","ts":1000,"content":[
              {"type":"tool_use","id":"e1","name":"editor","input":{"path":"failed.rs","old_text":"old","new_text":"new"}}
            ]},
            {"role":"user","ts":2000,"content":[
              {"type":"tool_result","tool_use_id":"e1","content":[{"success":false,"result":"rejected"}]}
            ]}
          ]
        }"#,
    )
    .expect("parses");

    let chunks = transcript_to_chunks("clineapp-abc", &transcript);
    assert_eq!(
        imported_history::impact_from_edit_chunks(&chunks).files_changed,
        0
    );
}

#[test]
fn strips_cline_read_gutter_only_when_present() {
    assert_eq!(
        strip_cline_read_gutter(" 1 | fn a() {}\n 2 | fn b() {}"),
        "fn a() {}\nfn b() {}"
    );
    // Command output containing a pipe is left untouched.
    assert_eq!(strip_cline_read_gutter("cat x | grep y"), "cat x | grep y");
    assert_eq!(strip_cline_read_gutter(""), "");
}
