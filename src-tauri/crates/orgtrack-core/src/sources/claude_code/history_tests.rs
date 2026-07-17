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
fn prefers_claude_custom_title_over_ai_title_and_prompt() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-title-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-title.jsonl");
    // The app derives the displayed name from `custom-title` (user override)
    // first, then `ai-title`; the raw first prompt is only a last resort.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"noisy first prompt that should not win"}}
{"type":"ai-title","aiTitle":"Auto generated title","sessionId":"abc"}
{"type":"custom-title","customTitle":"User chosen title","sessionId":"abc"}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-title".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-title".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "User chosen title");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn counts_diff_stats_from_structured_patch() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-patch-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-patch.jsonl");
    // Two edited files: file_a nets +2/-1, file_b (a create) nets +1/-0.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"do edits"}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"filePath":"/tmp/project/a.rs","structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,"lines":[" ctx","-old line","+new line one","+new line two"]}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]},"toolUseResult":{"type":"create","filePath":"/tmp/project/b.rs","structuredPatch":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+brand new"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-patch".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-patch".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.impact.lines_added, 3);
    assert_eq!(meta.impact.lines_removed, 1);
    assert_eq!(meta.impact.files_changed, 2);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
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

#[test]
fn maps_claude_subagent_sidechain_to_parent_session_id() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-subagent-test-{}",
        std::process::id()
    ));
    let parent_uuid = "2a8996f3-3f82-4372-a315-3f116b2b79a7";
    let subagents_dir = temp_dir.join(parent_uuid).join("subagents");
    std::fs::create_dir_all(&subagents_dir).expect("create subagents dir");

    // Task-tool subagent transcript: every line is a sidechain and carries the
    // spawning session's UUID in `sessionId`, while the file itself is named
    // after the subagent's own `agent-*` id.
    let file_stem = "agent-affecc89fcde78ea8";
    let path = subagents_dir.join(format!("{file_stem}.jsonl"));
    let content = format!(
        r#"{{"type":"user","isSidechain":true,"sessionId":"{parent_uuid}","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:46.543Z","message":{{"role":"user","content":"explore the codebase"}}}}
{{"type":"assistant","isSidechain":true,"sessionId":"{parent_uuid}","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:49.000Z","message":{{"role":"assistant","model":"claude-sonnet-4","content":[{{"type":"text","text":"done"}}],"usage":{{"input_tokens":12,"output_tokens":34}}}}}}
"#
    );
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: file_stem.to_string(),
        source_path: path.clone(),
        source_record_key: file_stem.to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.session_id, format!("claudecodeapp-{file_stem}"));
    assert_eq!(
        meta.parent_session_id.as_deref(),
        Some(format!("claudecodeapp-{parent_uuid}").as_str())
    );
    // The cache input must carry the parent through so the sidebar SQL
    // (`parent_session_id = ''`) and the frontend visibility filter subsume it.
    let cache_input = session_meta_to_cache_input(meta);
    assert_eq!(
        cache_input.parent_session_id.as_deref(),
        Some(format!("claudecodeapp-{parent_uuid}").as_str())
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn top_level_claude_session_has_no_parent_session_id() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-no-parent-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    // A normal session's `sessionId` equals its own file stem and no line is a
    // sidechain, so it must stay a top-level (parentless) session.
    let path = temp_dir.join("claude-top-level.jsonl");
    let content = r#"{"type":"user","sessionId":"claude-top-level","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:46.543Z","message":{"role":"user","content":"build this"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-top-level".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-top-level".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.parent_session_id, None);
    assert_eq!(session_meta_to_cache_input(meta).parent_session_id, None);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn edit_replay_chunk_carries_structured_patch_as_diff() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-edit-diff-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-edit.jsonl");
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/tmp/p/a.rs","old_string":"old line","new_string":"new line one\nnew line two"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"The file has been updated."}]},"toolUseResult":{"filePath":"/tmp/p/a.rs","oldString":"old line","newString":"new line one\nnew line two","structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,"lines":[" ctx","-old line","+new line one","+new line two"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let edit = &chunks[0];
    assert_eq!(edit.function, imported_history::FUNCTION_EDIT_FILE);
    // Args no longer bury fields under `payload`; old/new stay off so the
    // context-rich diff (below) is what the frontend renders.
    assert_eq!(
        edit.args.get("action").and_then(Value::as_str),
        Some("edit")
    );
    assert_eq!(
        edit.args.get("file_path").and_then(Value::as_str),
        Some("/tmp/p/a.rs")
    );
    assert!(edit.args.get("payload").is_none());
    assert!(edit.args.get("old_string").is_none());

    let diff = edit
        .result
        .get("diff")
        .and_then(Value::as_str)
        .expect("diff");
    assert!(diff.contains("--- /tmp/p/a.rs"));
    assert!(diff.contains("@@ -1,2 +1,3 @@"));
    assert!(diff.contains("-old line"));
    assert!(diff.contains("+new line one"));
    assert!(diff.contains(" ctx"));
    assert_eq!(
        edit.result.get("linesAdded").and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        edit.result.get("linesRemoved").and_then(Value::as_i64),
        Some(1)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn write_replay_chunk_is_tagged_create_and_diffs_from_patch() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-write-diff-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-write.jsonl");
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"/tmp/p/new.rs","content":"fn main() {}\n"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"w1","content":"File created."}]},"toolUseResult":{"type":"create","filePath":"/tmp/p/new.rs","content":"fn main() {}\n","structuredPatch":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+fn main() {}"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let write = &chunks[0];
    assert_eq!(write.function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(
        write.args.get("action").and_then(Value::as_str),
        Some("create")
    );
    let diff = write
        .result
        .get("diff")
        .and_then(Value::as_str)
        .expect("diff");
    assert!(diff.contains("@@ -0,0 +1,1 @@"));
    assert!(diff.contains("+fn main() {}"));
    assert_eq!(
        write.result.get("linesAdded").and_then(Value::as_i64),
        Some(1)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn edit_without_structured_patch_falls_back_to_old_new_on_args() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-edit-fallback-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-edit-fallback.jsonl");
    // Older/edge transcript: a tool result with authoritative old/new strings but
    // no structuredPatch. The strings are surfaced onto the args so a snippet
    // diff still renders.
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t9","name":"Edit","input":{"file_path":"/tmp/p/a.rs","old_string":"foo","new_string":"bar"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t9","content":"ok"}]},"toolUseResult":{"filePath":"/tmp/p/a.rs","oldString":"foo","newString":"bar"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let edit = &chunks[0];
    assert_eq!(
        edit.args.get("old_string").and_then(Value::as_str),
        Some("foo")
    );
    assert_eq!(
        edit.args.get("new_string").and_then(Value::as_str),
        Some("bar")
    );
    assert!(edit.result.get("diff").is_none());

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn captures_first_user_uuid_as_continuation_group_key() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-continuation-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("d0641111-1111-1111-1111-111111111111.jsonl");
    // Continuation rewrites preserve message uuids; the first `type:"user"`
    // line's uuid is the family key. Title/meta records before it must not
    // contribute a key.
    let content = r#"{"type":"custom-title","customTitle":"My convo","sessionId":"d0641111-1111-1111-1111-111111111111"}
{"type":"user","uuid":"b7b5ae5f-0000-0000-0000-000000000001","sessionId":"d0641111-1111-1111-1111-111111111111","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-17T10:00:00.000Z","message":{"role":"user","content":"first message"}}
{"type":"user","uuid":"b7b5ae5f-0000-0000-0000-000000000002","sessionId":"d0641111-1111-1111-1111-111111111111","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-17T10:01:00.000Z","message":{"role":"user","content":"second message"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "d0641111-1111-1111-1111-111111111111".to_string(),
        source_path: path.clone(),
        source_record_key: "d0641111-1111-1111-1111-111111111111".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");
    assert_eq!(
        meta.first_user_uuid.as_deref(),
        Some("b7b5ae5f-0000-0000-0000-000000000001")
    );

    let cache_input = session_meta_to_cache_input(meta);
    let metadata_json = cache_input.source_metadata_json.expect("metadata json");
    let parsed: serde_json::Value = serde_json::from_str(&metadata_json).expect("parse json");
    assert_eq!(
        parsed
            .get(imported_cache::CONTINUATION_GROUP_KEY_FIELD)
            .and_then(|value| value.as_str()),
        Some("b7b5ae5f-0000-0000-0000-000000000001")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn strips_ide_context_from_claude_replay() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-ide-context-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-ide-context.jsonl");
    // Line 1: ide_context-only user message (no user-authored text at all).
    // Line 2: bridge + ide_context prefixed user message with real text.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"<ide_context>\nopen file: src/app.ts\n</ide_context>"}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\n<ide_context>\nopen file: src/app.ts\n</ide_context>\n\nfix the login bug"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    // Replay: the ide_context-only line emits no bubble; the prefixed
    // line's bubble carries only the user-authored text.
    let chunks =
        load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    let user_chunks: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .collect();
    assert_eq!(user_chunks.len(), 1);
    assert_eq!(
        user_chunks[0]
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn strips_orgii_exec_mode_bridge_from_claude_title_and_replay() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-bridge-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-bridge.jsonl");
    // Line 1: bridge-only user message (no user-authored text at all).
    // Line 2: bridge-prefixed user message with real text after it.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>"}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\nfix the login bug"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    // Title/first_prompt: the bridge-only line is skipped as a candidate;
    // the prefixed line contributes only the user-authored text.
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-bridge".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-bridge".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");
    assert_eq!(meta.name, "fix the login bug");

    // Replay: the bridge-only line emits no bubble; the prefixed line's
    // bubble carries only the user-authored text.
    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    let user_chunks: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .collect();
    assert_eq!(user_chunks.len(), 1);
    assert_eq!(
        user_chunks[0]
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}
