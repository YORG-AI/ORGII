use super::*;

#[test]
fn includes_codex_session_dir_candidates() {
    let home = std::path::Path::new("/Users/example");
    let paths = codex_sessions_dir_candidates(home);
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(rendered.iter().any(|path| path.contains(".codex/sessions")));

    #[cfg(target_os = "macos")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/Codex/sessions")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/codex/sessions")));
    }

    #[cfg(target_os = "windows")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Roaming/Codex/sessions")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Local/Codex/sessions")));
    }
}

#[test]
fn parses_codex_jsonl_into_replay_chunks() {
    let temp_dir =
        std::env::temp_dir().join(format!("orgii-codex-history-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-test.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:06.458Z","type":"event_msg","payload":{"type":"user_message","message":"hello codex","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"pwd\"}","call_id":"call_1"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"/tmp/project"}}
{"timestamp":"2026-02-11T06:16:09.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-rollout-test", &path).expect("parse");

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
        Some("/tmp/project")
    );
    assert_eq!(
        chunks[2].action_type,
        imported_history::ACTION_TYPE_ASSISTANT
    );
    assert_eq!(chunks[2].function, imported_history::FUNCTION_ASSISTANT);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_shell_command_renders_as_terminal_when_not_search() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-shell-command-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-shell-command.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"git status --short\",\"workdir\":\"/tmp/project\"}","call_id":"call_terminal"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_terminal","output":" M src/lib.rs"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-shell-command", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        chunks[0].args.get("command").and_then(Value::as_str),
        Some("git status --short")
    );
    assert_eq!(
        chunks[0].args.get("cwd").and_then(Value::as_str),
        Some("/tmp/project")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_rg_shell_command_renders_as_code_search() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-rg-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-rg.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"rg -n \\\"Shell Command\\\" src\"}","call_id":"call_rg"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_rg","output":"src/a.rs:10:Shell Command\nsrc/b.rs:20:Shell Command"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-rg", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_CODE_SEARCH);
    assert_eq!(
        chunks[0].args.get("query").and_then(Value::as_str),
        Some("Shell Command")
    );
    assert_eq!(
        chunks[0].result.get("content").and_then(Value::as_str),
        Some("src/a.rs:10:Shell Command\nsrc/b.rs:20:Shell Command")
    );
    assert_eq!(
        chunks[0]
            .result
            .get("matches")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(2)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_sed_shell_command_renders_as_read_file() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-sed-read-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-sed-read.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"sed -n '11,30p' src/app.ts\",\"workdir\":\"/tmp/project\"}","call_id":"call_sed"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_sed","output":"export const value = 1;"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-sed-read", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(
        chunks[0].args.get("path").and_then(Value::as_str),
        Some("src/app.ts")
    );
    assert_eq!(
        chunks[0].args.get("offset").and_then(Value::as_i64),
        Some(10)
    );
    assert_eq!(
        chunks[0].args.get("limit").and_then(Value::as_i64),
        Some(20)
    );
    assert_eq!(
        chunks[0].result.get("output").and_then(Value::as_str),
        Some("export const value = 1;")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_chained_sed_reads_split_into_read_file_chunks() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-chained-sed-read-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-chained-sed-read.jsonl");
    let command = "sed -n '250,285p' src-tauri/crates/orgtrack-core/src/sources/imported_history/mod.rs && sed -n '860,900p' src-tauri/crates/orgtrack-core/src/sources/codex/app.rs";
    let arguments =
        serde_json::json!({ "command": command, "workdir": "/tmp/project" }).to_string();
    let output = (1..=77)
        .map(|line| format!("line-{line}\n"))
        .collect::<String>();
    let content = format!(
        r#"{{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{{"type":"function_call","name":"shell_command","arguments":{},"call_id":"call_chained_sed"}}}}
{{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{{"type":"function_call_output","call_id":"call_chained_sed","output":{}}}}}
"#,
        serde_json::to_string(&arguments).expect("encode args string"),
        serde_json::to_string(&output).expect("encode output string")
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-chained-sed-read", &path).expect("parse");

    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(chunks[1].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(
        chunks[0].args.get("path").and_then(Value::as_str),
        Some("src-tauri/crates/orgtrack-core/src/sources/imported_history/mod.rs")
    );
    assert_eq!(
        chunks[0].args.get("offset").and_then(Value::as_i64),
        Some(249)
    );
    assert_eq!(
        chunks[0].args.get("limit").and_then(Value::as_i64),
        Some(36)
    );
    assert_eq!(
        chunks[1].args.get("path").and_then(Value::as_str),
        Some("src-tauri/crates/orgtrack-core/src/sources/codex/app.rs")
    );
    assert_eq!(
        chunks[1].args.get("offset").and_then(Value::as_i64),
        Some(859)
    );
    assert_eq!(
        chunks[1].args.get("limit").and_then(Value::as_i64),
        Some(41)
    );
    assert_eq!(
        chunks[0].args.get("source_command").and_then(Value::as_str),
        Some(command)
    );
    let first_output = (1..=36)
        .map(|line| format!("line-{line}\n"))
        .collect::<String>();
    let second_output = (37..=77)
        .map(|line| format!("line-{line}\n"))
        .collect::<String>();
    assert_eq!(
        chunks[0].result.get("output").and_then(Value::as_str),
        Some(first_output.as_str())
    );
    assert_eq!(
        chunks[1].result.get("output").and_then(Value::as_str),
        Some(second_output.as_str())
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_mixed_chained_shell_command_stays_terminal() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-mixed-chain-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-mixed-chain.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"sed -n '1,2p' src/app.ts && git status --short\",\"workdir\":\"/tmp/project\"}","call_id":"call_mixed_chain"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_mixed_chain","output":"const x = 1;\n M src/app.ts"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-mixed-chain", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_nl_sed_pipeline_shell_command_renders_as_read_file() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-nl-sed-read-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-nl-sed-read.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"nl -ba src-tauri/crates/orgtrack-core/src/sources/codex/app.rs | sed -n '52,65p;176,265p;1148,1165p'\",\"workdir\":\"/tmp/project\"}","call_id":"call_nl_sed"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_nl_sed","output":"    52\t    impact: ImportedHistoryImpactStats,\n   176\t    let mut created_at_ms = 0;"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-nl-sed-read", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(
        chunks[0].args.get("path").and_then(Value::as_str),
        Some("src-tauri/crates/orgtrack-core/src/sources/codex/app.rs")
    );
    assert_eq!(
        chunks[0].args.get("offset").and_then(Value::as_i64),
        Some(51)
    );
    assert!(chunks[0]
        .args
        .get("limit")
        .is_some_and(serde_json::Value::is_null));
    assert_eq!(
        chunks[0].args.get("command").and_then(Value::as_str),
        Some(
            "nl -ba src-tauri/crates/orgtrack-core/src/sources/codex/app.rs | sed -n '52,65p;176,265p;1148,1165p'"
        )
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_sed_transform_shell_command_stays_terminal() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-sed-terminal-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-sed-terminal.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"sed 's/old/new/' src/app.ts\",\"workdir\":\"/tmp/project\"}","call_id":"call_sed_transform"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_sed_transform","output":"new text"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-sed-terminal", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        chunks[0].args.get("command").and_then(Value::as_str),
        Some("sed 's/old/new/' src/app.ts")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_nl_sed_transform_pipeline_stays_terminal() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-nl-sed-terminal-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-nl-sed-terminal.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"nl -ba src/app.ts | sed 's/old/new/'\",\"workdir\":\"/tmp/project\"}","call_id":"call_nl_sed_transform"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_nl_sed_transform","output":"new text"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-nl-sed-terminal", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        chunks[0].args.get("command").and_then(Value::as_str),
        Some("nl -ba src/app.ts | sed 's/old/new/'")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_apply_patch_exposes_patch_text_and_file_path() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-apply-patch-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-apply-patch.jsonl");
    let patch = "*** Begin Patch\n*** Update File: src/app.rs\n@@\n-old\n+new\n*** End Patch";
    let arguments = serde_json::json!({ "patch": patch }).to_string();
    let content = format!(
        r#"{{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{{"type":"function_call","name":"apply_patch","arguments":{},"call_id":"call_patch"}}}}
{{"timestamp":"2026-02-11T06:16:08.000Z","type":"response_item","payload":{{"type":"function_call_output","call_id":"call_patch","output":"Done"}}}}
"#,
        serde_json::to_string(&arguments).expect("encode args string")
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-apply-patch", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(
        chunks[0].args.get("action").and_then(Value::as_str),
        Some("apply_patch")
    );
    assert_eq!(
        chunks[0].args.get("file_path").and_then(Value::as_str),
        Some("src/app.rs")
    );
    assert_eq!(
        chunks[0].args.get("patch_text").and_then(Value::as_str),
        Some(patch)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_apply_patch_headers_contribute_file_stats() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-apply-patch-stats-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-apply-patch-stats.jsonl");
    let patch = "*** Begin Patch\n*** Update File: src/app.rs\n@@\n-old\n+new\n+extra\n*** Add File: src/new.rs\n+fresh\n*** End Patch";
    let arguments = serde_json::json!({ "patch": patch }).to_string();
    let content = format!(
        r#"{{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"abc"}}}}
{{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{{"type":"function_call","name":"apply_patch","arguments":{},"call_id":"call_patch"}}}}
"#,
        serde_json::to_string(&arguments).expect("encode args string")
    );
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "rollout-apply-patch-stats".to_string(),
        source_path: path.clone(),
        source_record_key: "rollout-apply-patch-stats".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.impact.files_changed, 2);
    assert_eq!(meta.impact.lines_added, 3);
    assert_eq!(meta.impact.lines_removed, 1);
    assert_eq!(
        meta.impact.touched_files,
        vec!["src/app.rs".to_string(), "src/new.rs".to_string()]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn parses_codex_session_metadata() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-meta-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-meta.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{"cwd":"/Users/me/project","id":"abc"}}
{"timestamp":"2026-02-11T06:16:07.000Z","type":"turn_context","payload":{"cwd":"/Users/me/project","model":"gpt-5.3-codex"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"event_msg","payload":{"type":"user_message","message":"build this","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"2026-02-11T06:16:09.000Z","type":"event_msg","payload":{"type":"token_count","total_token_usage":{"input_tokens":12,"output_tokens":34}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "rollout-meta".to_string(),
        source_path: path.clone(),
        source_record_key: "rollout-meta".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.session_id, "codexapp-rollout-meta");
    assert_eq!(meta.name, "build this");
    assert_eq!(meta.model.as_deref(), Some("gpt-5.3-codex"));
    assert_eq!(meta.repo_path.as_deref(), Some("/Users/me/project"));
    assert_eq!(meta.input_tokens, 12);
    assert_eq!(meta.output_tokens, 34);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_codex_session_index_thread_name_as_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-index-title-test-{}",
        std::process::id()
    ));
    let sessions_dir = temp_dir.join("sessions").join("2026").join("07").join("08");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
    let thread_id = "019f423a-51c2-7013-8310-2df985d06f7a";
    let path = sessions_dir.join(format!("rollout-2026-07-08T22-55-46-{thread_id}.jsonl"));
    let content = r#"{"timestamp":"2026-07-08T14:55:46.000Z","type":"session_meta","payload":{"cwd":"/Users/me/project","id":"019f423a-51c2-7013-8310-2df985d06f7a"}}
{"timestamp":"2026-07-08T14:55:47.000Z","type":"event_msg","payload":{"type":"user_message","message":"first prompt fallback","images":[],"local_images":[],"text_elements":[]}}
"#;
    std::fs::write(&path, content).expect("write fixture");
    std::fs::write(
        temp_dir.join("session_index.jsonl"),
        format!(
            r#"{{"id":"{thread_id}","thread_name":"Update session sidebar","updated_at":"2026-07-08T14:55:57.939376Z"}}
"#
        ),
    )
    .expect("write session index");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("file stem")
            .to_string(),
        source_path: path.clone(),
        source_record_key: path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("file stem")
            .to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "Update session sidebar");

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn maps_codex_subagent_parent_thread_to_parent_session_id() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-subagent-parent-test-{}",
        std::process::id()
    ));
    let parent_sessions_dir = temp_dir
        .join("sessions")
        .join("2026")
        .join("07")
        .join("08");
    let child_sessions_dir = temp_dir
        .join("sessions")
        .join("2026")
        .join("07")
        .join("09");
    std::fs::create_dir_all(&parent_sessions_dir).expect("create parent sessions dir");
    std::fs::create_dir_all(&child_sessions_dir).expect("create child sessions dir");

    let parent_thread_id = "019f423a-51c2-7013-8310-2df985d06f7a";
    let child_thread_id = "019f427d-8e5a-7533-baf4-2bce6a8bcdda";
    let parent_file_stem = format!("rollout-2026-07-08T22-55-46-{parent_thread_id}");
    let child_file_stem = format!("rollout-2026-07-09T00-09-12-{child_thread_id}");
    let parent_path = parent_sessions_dir.join(format!("{parent_file_stem}.jsonl"));
    let child_path = child_sessions_dir.join(format!("{child_file_stem}.jsonl"));

    std::fs::write(
        &parent_path,
        format!(
            r#"{{"timestamp":"2026-07-08T14:55:46.000Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"{parent_thread_id}"}}}}
"#
        ),
    )
    .expect("write parent fixture");
    std::fs::write(
        &child_path,
        format!(
            r#"{{"timestamp":"2026-07-08T15:12:12.000Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"{child_thread_id}","session_id":"{parent_thread_id}","forked_from_id":"{parent_thread_id}","parent_thread_id":"{parent_thread_id}","thread_source":"subagent","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{parent_thread_id}","depth":1,"agent_nickname":"Copernicus"}}}}}}}}}}
{{"timestamp":"2026-07-08T15:12:13.000Z","type":"event_msg","payload":{{"type":"user_message","message":"inspect session naming","images":[],"local_images":[],"text_elements":[]}}}}
"#
        ),
    )
    .expect("write child fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&child_path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: child_file_stem.clone(),
        source_path: child_path,
        source_record_key: child_file_stem,
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    let expected_parent_session_id = format!("codexapp-{parent_file_stem}");
    assert_eq!(
        meta.parent_session_id.as_deref(),
        Some(expected_parent_session_id.as_str())
    );

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn does_not_map_regular_codex_fork_as_subagent_parent() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-regular-fork-test-{}",
        std::process::id()
    ));
    let sessions_dir = temp_dir.join("sessions").join("2026").join("07").join("08");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");

    let parent_thread_id = "019f423a-51c2-7013-8310-2df985d06f7a";
    let child_thread_id = "019f4249-5f02-7ec3-998c-981f6676ccb3";
    let parent_file_stem = format!("rollout-2026-07-08T22-55-46-{parent_thread_id}");
    let child_file_stem = format!("rollout-2026-07-08T23-12-12-{child_thread_id}");
    let parent_path = sessions_dir.join(format!("{parent_file_stem}.jsonl"));
    let child_path = sessions_dir.join(format!("{child_file_stem}.jsonl"));

    std::fs::write(
        &parent_path,
        format!(
            r#"{{"timestamp":"2026-07-08T14:55:46.000Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"{parent_thread_id}"}}}}
"#
        ),
    )
    .expect("write parent fixture");
    std::fs::write(
        &child_path,
        format!(
            r#"{{"timestamp":"2026-07-08T15:12:12.000Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"{child_thread_id}","forked_from_id":"{parent_thread_id}"}}}}
{{"timestamp":"2026-07-08T15:12:13.000Z","type":"event_msg","payload":{{"type":"user_message","message":"regular fork","images":[],"local_images":[],"text_elements":[]}}}}
"#
        ),
    )
    .expect("write child fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&child_path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: child_file_stem.clone(),
        source_path: child_path,
        source_record_key: child_file_stem,
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert!(meta.parent_session_id.is_none());

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_codex_session_meta_title_as_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-title-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-title.jsonl");
    let content = r#"{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{"cwd":"/Users/me/project","id":"abc","title":"Review payment flow"}}
{"timestamp":"2026-02-11T06:16:08.000Z","type":"event_msg","payload":{"type":"user_message","message":"build this","images":[],"local_images":[],"text_elements":[]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "rollout-title".to_string(),
        source_path: path.clone(),
        source_record_key: "rollout-title".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "Review payment flow");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}
