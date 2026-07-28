use super::*;

#[test]
fn extracts_user_query_and_strips_reminders() {
    // The observed wrapping: reminder block(s) first, then the typed prompt.
    assert_eq!(
        extract_user_query(
            "<system-reminder>\n[IMPORTANT] You must always respond in en-us.\n</system-reminder>\n\n\n\n<user_query>\nspawn a subagent to investigate RAM usage\n</user_query>"
        ),
        "spawn a subagent to investigate RAM usage"
    );
    // No wrapper → reminder blocks are dropped, the rest kept.
    assert_eq!(
        extract_user_query("<system-reminder>respond in en-us</system-reminder>plain ask"),
        "plain ask"
    );
    assert_eq!(extract_user_query("  plain text  "), "plain text");
    // Unterminated query tag → inner text after the opening tag.
    assert_eq!(
        extract_user_query("<user_query>unterminated"),
        "unterminated"
    );
}

#[test]
fn parses_quest_snapshot_tasks_from_folder_map() {
    let raw = r#"{
        "version": 1,
        "updatedAt": 1784202191335,
        "folders": {
            "__virtual__": {
                "updatedAt": 1784202191335,
                "tasks": [{
                    "id": "task-3a297cb30e744f1baf72",
                    "name": "Spawn RAM investigation agent",
                    "title": "Spawn RAM investigation agent",
                    "query": "Spawn RAM investigation agent",
                    "status": "Completed",
                    "createTime": 1784202123440,
                    "updatedAtTimestamp": 1784202191140,
                    "lastUserQueryAt": 0,
                    "filePath": "/Users/u/Documents/Qoder/2026-07-16/chat-1"
                }]
            }
        }
    }"#;

    let tasks = parse_quest_snapshot_tasks(raw);
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-3a297cb30e744f1baf72");
    assert_eq!(tasks[0].title, "Spawn RAM investigation agent");
    assert_eq!(tasks[0].create_time, 1784202123440);
    assert_eq!(tasks[0].updated_at_timestamp, 1784202191140);
    assert_eq!(
        tasks[0].file_path,
        "/Users/u/Documents/Qoder/2026-07-16/chat-1"
    );

    assert!(parse_quest_snapshot_tasks("not json").is_empty());
    assert!(parse_quest_snapshot_tasks("{}").is_empty());
}

#[test]
fn matches_snapshot_task_by_id_prefix_and_workspace_basename() {
    let task = QoderQuestTask {
        id: "task-3a297cb30e744f1baf72".to_string(),
        file_path: "/Users/u/Documents/Qoder/2026-07-16/chat-1".to_string(),
        ..Default::default()
    };
    let tasks = vec![task];

    // Dir `chat-1-fdad7ab4` = `<workspace-basename>-<hash>`; task dir
    // `task-3a2` = truncated id prefix.
    assert!(match_snapshot_task(&tasks, "chat-1-fdad7ab4", "task-3a2").is_some());
    // Wrong workspace basename → no match even though the id prefix fits.
    assert!(match_snapshot_task(&tasks, "other-proj-fdad7ab4", "task-3a2").is_none());
    // Wrong task prefix → no match.
    assert!(match_snapshot_task(&tasks, "chat-1-fdad7ab4", "task-9ff").is_none());
    // A basename that only partially overlaps must not match (`chat-1` vs `chat-10`).
    assert!(!project_dir_matches_workspace(
        "chat-10-fdad7ab4",
        "/w/chat-1"
    ));
    assert!(!project_dir_matches_workspace("chat-1-fdad7ab4", ""));
}

#[test]
fn source_id_round_trips_through_prefix() {
    let sid = format!("{QODER_SESSION_PREFIX}chat-1-fdad7ab4/task-3a2");
    assert_eq!(
        qoder_source_id_from_session_id(&sid).unwrap(),
        "chat-1-fdad7ab4/task-3a2"
    );
    assert!(qoder_source_id_from_session_id("bogus").is_err());
    assert!(qoder_source_id_from_session_id(QODER_SESSION_PREFIX).is_err());
}

#[test]
fn projects_dir_candidate_points_at_qoder_store() {
    let home = std::path::Path::new("/home/u");
    assert_eq!(
        qoder_projects_dir_candidates(home),
        vec![home.join(".qoder").join("cache").join("projects")]
    );
}

#[test]
fn transcript_to_chunks_unwraps_query_and_pairs_tools() {
    let lines: Vec<QoderTranscriptLine> = [
        r#"{"role":"user","message":{"content":[{"type":"text","text":"<system-reminder>respond in en-us</system-reminder><user_query>check RAM</user_query>"}]}}"#,
        r#"{"role":"assistant","message":{"content":[{"type":"thinking","thinking":"look at vm_stat"},{"type":"tool_use","id":"call_1","name":"run_command","input":{"command":"vm_stat"}}]}}"#,
        r#"{"role":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"Pages free: 100"}]}]}}"#,
        r#"{"role":"assistant","message":{"content":[{"type":"text","text":"RAM looks fine."}]}}"#,
    ]
    .into_iter()
    .map(|line| serde_json::from_str(line).expect("parses"))
    .collect();

    let chunks = transcript_to_chunks("qoderapp-p/t", &lines);
    // user text + thinking + tool_use + assistant text = 4 chunks; the
    // tool_result block is consumed as the tool's output.
    assert_eq!(chunks.len(), 4);

    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(chunks[0].result["message"]["content"], "check RAM");

    assert_eq!(
        chunks[1].action_type,
        imported_history::ACTION_TYPE_THINKING
    );
    assert_eq!(chunks[1].result["thought"], "look at vm_stat");

    let tool = &chunks[2];
    assert_eq!(tool.action_type, imported_history::ACTION_TYPE_TOOL_CALL);
    assert_eq!(tool.function, "run_command");
    assert_eq!(tool.args["command"], "vm_stat");
    assert_eq!(tool.result["output"], "Pages free: 100");

    assert_eq!(chunks[3].result["content"], "RAM looks fine.");
}

#[test]
fn failed_tool_result_marks_chunk_failed() {
    let lines: Vec<QoderTranscriptLine> = [
        r#"{"role":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"run_command","input":{"command":"boom"}}]}}"#,
        r#"{"role":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","is_error":true,"content":"exploded"}]}}"#,
    ]
    .into_iter()
    .map(|line| serde_json::from_str(line).expect("parses"))
    .collect();

    let chunks = transcript_to_chunks("qoderapp-p/t", &lines);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(chunks[0].result["status"], "failed");
    assert_eq!(chunks[0].result["output"], "exploded");
}

#[test]
fn discovers_composite_ids_and_snapshot_metadata_from_fixture() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let projects_dir = std::env::temp_dir().join(format!("orgii-qoder-{unique}"));
    let task_dir = projects_dir
        .join("chat-1-fdad7ab4")
        .join(CONVERSATION_HISTORY_DIR)
        .join("task-3a2");
    std::fs::create_dir_all(&task_dir).expect("create task dir");
    std::fs::write(
        task_dir.join("task-3a2.jsonl"),
        concat!(
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>check RAM</user_query>"}]}}"#,
            "\n",
            r#"{"role":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#,
            "\n",
        ),
    )
    .expect("write transcript");

    let snapshot = vec![QoderQuestTask {
        id: "task-3a297cb30e744f1baf72".to_string(),
        title: "Spawn RAM investigation agent".to_string(),
        create_time: 1784202123440,
        updated_at_timestamp: 1784202191140,
        file_path: "/Users/u/Documents/Qoder/2026-07-16/chat-1".to_string(),
        ..Default::default()
    }];

    let records =
        discover_records_in_projects_dir(&projects_dir, &snapshot).expect("discover records");
    assert_eq!(records.len(), 1);
    let input = session_meta_to_cache_input(parse_qoder_session_meta(&records[0]));

    assert_eq!(input.source_session_id, "chat-1-fdad7ab4/task-3a2");
    assert_eq!(input.session_id, "qoderapp-chat-1-fdad7ab4/task-3a2");
    assert_eq!(input.name, "Spawn RAM investigation agent");
    assert_eq!(input.created_at_ms, 1784202123440);
    assert_eq!(input.updated_at_ms, 1784202191140);
    assert_eq!(
        input.repo_path.as_deref(),
        Some("/Users/u/Documents/Qoder/2026-07-16/chat-1")
    );

    std::fs::remove_dir_all(&projects_dir).expect("remove temp dir");
}

#[test]
fn unmatched_transcript_falls_back_to_first_user_text_and_mtime() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let projects_dir = std::env::temp_dir().join(format!("orgii-qoder-fb-{unique}"));
    let task_dir = projects_dir
        .join("proj-aaaa1111")
        .join(CONVERSATION_HISTORY_DIR)
        .join("task-9ff");
    std::fs::create_dir_all(&task_dir).expect("create task dir");
    std::fs::write(
        task_dir.join("task-9ff.jsonl"),
        r#"{"role":"user","message":{"content":[{"type":"text","text":"fix the login bug"}]}}"#,
    )
    .expect("write transcript");

    let records = discover_records_in_projects_dir(&projects_dir, &[]).expect("discover records");
    assert_eq!(records.len(), 1);
    let input = session_meta_to_cache_input(parse_qoder_session_meta(&records[0]));

    assert_eq!(input.name, "fix the login bug");
    assert!(input.repo_path.is_none());
    // Dates fall back to the file mtime (the signature carries nanoseconds).
    assert_eq!(
        input.created_at_ms,
        records[0].record.source_mtime_ms / 1_000_000
    );
    assert_eq!(input.updated_at_ms, input.created_at_ms);

    std::fs::remove_dir_all(&projects_dir).expect("remove temp dir");
}
