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
