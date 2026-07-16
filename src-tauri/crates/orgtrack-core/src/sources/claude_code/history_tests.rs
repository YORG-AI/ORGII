use super::*;

#[test]
fn includes_claude_project_dir_candidates() {
    let home = std::path::Path::new("/Users/example");
    let paths = claude_projects_dir_candidates(home);
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(rendered
        .iter()
        .any(|path| path.contains(".claude/projects")));

    #[cfg(target_os = "macos")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/Claude Code/projects")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/claude-code/projects")));
    }

    #[cfg(target_os = "windows")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Roaming/Claude Code/projects")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Local/Claude Code/projects")));
    }
}

#[test]
fn parses_claude_jsonl_into_replay_chunks() {
    let temp_dir =
        std::env::temp_dir().join(format!("orgii-claude-history-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-replay.jsonl");
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"hello claude"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}],"usage":{"input_tokens":10,"output_tokens":2}}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"/tmp/project"}]}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");

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
fn parses_claude_session_metadata() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-meta-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-meta.jsonl");
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"build this"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-meta".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-meta".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.session_id, "claudecodeapp-claude-meta");
    assert_eq!(meta.name, "build this");
    assert_eq!(meta.model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(meta.repo_path.as_deref(), Some("/tmp/project"));
    assert_eq!(meta.branch.as_deref(), Some("main"));
    assert_eq!(meta.input_tokens, 23);
    assert_eq!(meta.output_tokens, 34);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_session_json_name_as_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-session-name-test-{}",
        std::process::id()
    ));
    let project_dir = temp_dir.join("projects").join("-Users-me-project");
    let sessions_dir = temp_dir.join("sessions");
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");

    let path = project_dir.join("64c10ac1-0c64-4437-86df-8a5beac77f4b.jsonl");
    let content = r#"{"type":"user","sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","gitBranch":"main","timestamp":"2026-07-08T07:06:46.543Z","message":{"role":"user","content":"first prompt fallback"}}
{"type":"assistant","sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","gitBranch":"main","timestamp":"2026-07-08T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":34}}}
"#;
    std::fs::write(&path, content).expect("write fixture");
    std::fs::write(
        sessions_dir.join("48664.json"),
        r#"{"pid":48664,"sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","startedAt":1783522457884,"name":"orgii-05","nameSource":"derived"}"#,
    )
    .expect("write session metadata");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "64c10ac1-0c64-4437-86df-8a5beac77f4b".to_string(),
        source_path: path.clone(),
        source_record_key: "64c10ac1-0c64-4437-86df-8a5beac77f4b".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "orgii-05");

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_summary_as_session_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-summary-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-summary.jsonl");
    let content = r#"{"type":"summary","summary":"Ship auth dashboard","leafUuid":"abc"}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"build this"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-summary".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-summary".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "Ship auth dashboard");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}
