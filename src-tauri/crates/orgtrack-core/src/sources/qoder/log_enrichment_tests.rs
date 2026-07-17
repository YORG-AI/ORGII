use super::*;

use crate::sources::imported_history;

/// Line shapes copied verbatim from real Qoder logs (2026-07). Sessions A
/// (task-3a2…) and B (task-d60…) have OVERLAPPING activity windows, so only
/// content-based attribution can separate their invokes.
fn fixture_log() -> String {
    [
        r#"2026-07-16 19:42:04.351 [info] [ChatSessionService] ACP progress: task-3a297cb30e744f1baf72.session.execution, rid=undefined, type=current_model_update"#,
        r#"2026-07-16 19:42:09.761 [info] [ChatSessionService] ACP progress: task-3a297cb30e744f1baf72.session.execution, rid=8f5023af-2d32-4d90-b3bd-e3b23041f477, type=tool_call, toolCallId=call_72888b94a24d40a49eb072c4"#,
        r#"2026-07-16 19:42:13.206 [info] [SubAgentService] Registered SubAgent: {"parentToolCallId":"call_72888b94a24d40a49eb072c4","parentSessionId":"task-3a297cb30e744f1baf72.session.execution","agentType":"GeneralPurpose","agentName":"","prompt":"Investigate the RAM usage on this macOS computer.","rawInputDescription":"Investigate RAM usage"}"#,
        // exthost format: name line, args JSON on the next line. cwd = session
        // A's workspace → attributed to A even inside B's window.
        r#"2026-07-16 19:42:24.655 [info] ToolInvoke : run_in_terminal"#,
        r#"{"command":"vm_stat","command_names":null,"cwd":"/Users/u/Documents/Qoder/2026-07-16/chat-1","exec_mode":"","has_risk":false,"run_mode":"autoRun","timeout":180000}"#,
        // Session B starts while A is still active (overlapping windows).
        r#"2026-07-16 19:42:30.000 [info] [ChatSessionService] ACP progress: task-d600ed4bb0614ffc94d0.session.execution, rid=undefined, type=current_model_update"#,
        // agent.log invoke format; file_path under B's project cache dir.
        r#"2026-07-16 19:42:41.575 [info] [ToolInvokeHandlerContribution] Tool invoke request: b22b5f8d-0ab5-4ded-a9de-c1df47388513, read_file, {"file_path":"/Users/u/.qoder/cache/projects/chat-2-fdad7ab5/agent-tools/0ee51bd5/d569f6e1.txt"}"#,
        // Path-silent invoke while BOTH windows are open → ambiguous, dropped.
        r#"2026-07-16 19:42:50.000 [info] [ToolInvokeHandlerContribution] Tool invoke request: 00000000-0000-0000-0000-000000000001, read_file, {"file_path":"/tmp/ambiguous.txt"}"#,
        r#"2026-07-16 19:43:11.000 [info] [ChatSessionService] ACP progress: task-3a297cb30e744f1baf72.session.execution, rid=undefined, type=chat_finish"#,
        // A path-silent invoke after A finished, inside B's window only.
        r#"2026-07-16 19:43:20.000 [info] [ToolInvokeHandlerContribution] Tool invoke request: 00000000-0000-0000-0000-000000000002, grep_search, {"query":"orphaned"}"#,
        r#"2026-07-16 19:43:30.000 [info] [ChatSessionService] ACP progress: task-d600ed4bb0614ffc94d0.session.execution, rid=undefined, type=chat_finish"#,
    ]
    .join("\n")
}

fn text_chunks(session_id: &str) -> Vec<ActivityChunk> {
    vec![
        imported_history::user_message_chunk(session_id, "qoder", 0, "", "check RAM"),
        imported_history::assistant_message_chunk(session_id, "qoder", 1, "", "RAM looks fine."),
    ]
}


fn no_snapshots(_task_id: &str) -> HashMap<String, (String, String)> {
    HashMap::new()
}

fn parse_fixture() -> Vec<LogEvent> {
    let mut events = Vec::new();
    parse_launch_log(&fixture_log(), &mut events);
    events
}

#[test]
fn attributes_by_workspace_cwd_despite_overlapping_windows() {
    let events = parse_fixture();
    let enriched = enrich_chunks_with_events(
        "qoderapp-chat-1-fdad7ab4/task-3a2",
        "task-3a2",
        "chat-1-fdad7ab4",
        Some("/Users/u/Documents/Qoder/2026-07-16/chat-1"),
        text_chunks("qoderapp-chat-1-fdad7ab4/task-3a2"),
        &events,
        &no_snapshots,
    );

    // user + subagent + run_in_terminal + assistant. The ambiguous and
    // B-owned invokes must NOT land here.
    assert_eq!(enriched.len(), 4);

    let subagent = &enriched[1];
    assert_eq!(subagent.function, "subagent");
    assert_eq!(subagent.args["agentType"], "GeneralPurpose");
    assert_eq!(subagent.args["description"], "Investigate RAM usage");
    assert_eq!(subagent.result["recovered_from"], "agent_log");

    let terminal = &enriched[2];
    assert_eq!(
        terminal.function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(terminal.args["command"], "vm_stat");
    assert_eq!(terminal.args["cmd"], "vm_stat");
    assert!(!terminal.created_at.is_empty());
}

#[test]
fn attributes_by_project_cache_dir_and_attaches_no_bare_markers() {
    let events = parse_fixture();
    let enriched = enrich_chunks_with_events(
        "qoderapp-chat-2-fdad7ab5/task-d60",
        "task-d60",
        "chat-2-fdad7ab5",
        None,
        text_chunks("qoderapp-chat-2-fdad7ab5/task-d60"),
        &events,
        &no_snapshots,
    );

    let tools: Vec<_> = enriched
        .iter()
        .filter(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .collect();
    // The cache-dir read (ours by path) + the window-exclusive grep after A
    // finished. The ambiguous one and A's terminal command must not appear,
    // and no payload-less ACP markers are emitted.
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].function, imported_history::FUNCTION_READ_FILE);
    assert!(tools[0].args["file_path"]
        .as_str()
        .unwrap()
        .contains("chat-2-fdad7ab5"));
    assert_eq!(tools[1].function, "grep_search");
    assert!(enriched.iter().all(|chunk| chunk.function != "tool_call"));
}

#[test]
fn pairs_invoke_with_recent_acp_call_id() {
    let log = [
        r#"2026-07-16 19:42:09.000 [info] [ChatSessionService] ACP progress: task-aaa.session.execution, rid=u, type=tool_call, toolCallId=call_pair_me"#,
        r#"2026-07-16 19:42:09.500 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-1, read_file, {"file_path":"/tmp/x.txt"}"#,
    ]
    .join("\n");
    let mut events = Vec::new();
    parse_launch_log(&log, &mut events);

    let enriched = enrich_chunks_with_events(
        "qoderapp-p/task-aaa",
        "task-aaa",
        "p",
        None,
        text_chunks("qoderapp-p/task-aaa"),
        &events,
        &no_snapshots,
    );
    let tool = enriched
        .iter()
        .find(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .expect("tool chunk");
    assert_eq!(tool.result["call_id"], "call_pair_me");
}

#[test]
fn maps_file_edits_and_problem_probes_to_typed_cards() {
    // Verbatim shapes from a real agent.log: a create tracked by
    // FileChangeTracking (session as truncated dir name) followed by a
    // get_problems diagnostics probe.
    let log = [
        r#"2026-07-16 21:46:40.100 [info] [ChatSessionService] ACP progress: task-031d2bde542c426da46f.session.execution, rid=u, type=tool_call, toolCallId=call_edit_1"#,
        r#"2026-07-16 21:46:40.822 [info] [FileChangeTracking] Agent file tracked: /Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py (session=task-031)"#,
        r#"2026-07-16 21:46:40.823 [info] [FileChangeTracking] /Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py | source=agent | session=task-031, request=337dc91c | Agent create"#,
        r#"2026-07-16 21:46:42.130 [info] [ToolInvokeHandlerContribution] Tool invoke request: ff747a59-5cdb-4a5b-bbb7-ab4f7a91298a, get_problems, {"filePaths":["/Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py"],"file_paths":["/Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py"]}"#,
        // A later edit of the same file: the whole-session snapshot diff must
        // land on THIS card (the last edit), not the create above.
        r#"2026-07-16 21:46:45.000 [info] [FileChangeTracking] /Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py | source=agent | session=task-031, request=448ee1d | Agent edit"#,
        r#"2026-07-16 21:46:50.000 [info] [ChatSessionService] ACP progress: task-031d2bde542c426da46f.session.execution, rid=u, type=chat_finish"#,
    ]
    .join("\n");
    let mut events = Vec::new();
    parse_launch_log(&log, &mut events);

    let file_path = "/Users/u/Documents/Qoder/2026-07-16/chat-4/documents/test_sample.py";
    let snapshots = move |task_id: &str| {
        assert_eq!(task_id, "task-031d2bde542c426da46f");
        HashMap::from([(
            file_path.to_string(),
            (String::new(), "import unittest\n".to_string()),
        )])
    };

    let enriched = enrich_chunks_with_events(
        "qoderapp-chat-4-fdad7ab7/task-031",
        "task-031",
        "chat-4-fdad7ab7",
        Some("/Users/u/Documents/Qoder/2026-07-16/chat-4"),
        text_chunks("qoderapp-chat-4-fdad7ab7/task-031"),
        &events,
        &snapshots,
    );

    let tools: Vec<_> = enriched
        .iter()
        .filter(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .collect();
    // create + probe + edit; the pipe-less "Agent file tracked:" duplicate is
    // ignored.
    assert_eq!(tools.len(), 3);

    let create = tools[0];
    assert_eq!(create.function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(create.args["file_path"], file_path);
    assert_eq!(create.args["operation"], "create");
    assert_eq!(create.result["raw_tool_name"], "file_create");
    // Paired to the ACP tool_call that preceded it.
    assert_eq!(create.result["call_id"], "call_edit_1");
    // The snapshot diff belongs to the LAST edit of the file, not this one.
    assert!(create.args.get("new_string").is_none());

    let lsp = tools[1];
    assert_eq!(lsp.function, "query_lsp");
    assert_eq!(lsp.result["raw_tool_name"], "get_problems");
    assert_eq!(lsp.args["file_path"], file_path);

    let edit = tools[2];
    assert_eq!(edit.function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(edit.args["operation"], "edit");
    assert_eq!(edit.args["old_string"], "");
    assert_eq!(edit.args["new_string"], "import unittest\n");
}

#[test]
fn impact_from_snapshots_counts_real_line_diffs() {
    let snapshots = HashMap::from([
        (
            "/w/created.py".to_string(),
            (String::new(), "line one\nline two\n".to_string()),
        ),
        (
            "/w/edited.py".to_string(),
            // One line changed out of three: numstat must be +1/−1, not the
            // naive full-file +3/−3.
            (
                "keep\nold line\nkeep\n".to_string(),
                "keep\nnew line\nkeep\n".to_string(),
            ),
        ),
    ]);

    let impact = impact_from_snapshots(&snapshots);
    assert_eq!(impact.files_changed, 2);
    assert_eq!(impact.lines_added, 3);
    assert_eq!(impact.lines_removed, 1);
    assert_eq!(impact.touched_files, vec!["/w/created.py", "/w/edited.py"]);
}

#[test]
fn edit_store_paths_resolve_by_prefix_and_back_off_on_ambiguity() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let storage = std::env::temp_dir().join(format!("orgii-qoder-storeres-{unique}"));
    let sessions = storage.join("ws-1").join("chatEditingSessions");
    for task_id in ["task-031d2bde542c426da46f", "task-9ffaaaa", "task-9ffbbbb"] {
        let dir = sessions.join(format!("{task_id}{SESSION_ID_SUFFIX}"));
        std::fs::create_dir_all(&dir).expect("create session dir");
        std::fs::write(dir.join("state.json"), "{}").expect("write state");
    }
    let storage_dirs = vec![storage.clone()];

    // Exact full-id resolution.
    assert_eq!(
        edit_store_paths(&storage_dirs, "task-031", Some("task-031d2bde542c426da46f")).len(),
        1
    );
    // Unique prefix resolution.
    assert_eq!(edit_store_paths(&storage_dirs, "task-031", None).len(), 1);
    // Two distinct ids share the prefix → ambiguous → nothing.
    assert!(edit_store_paths(&storage_dirs, "task-9ff", None).is_empty());

    std::fs::remove_dir_all(&storage).expect("remove temp dir");
}

#[test]
fn reads_edit_snapshots_from_chat_editing_session_store() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let session_dir = std::env::temp_dir().join(format!("orgii-qoder-editsnap-{unique}"));
    std::fs::create_dir_all(session_dir.join("contents")).expect("create contents dir");
    std::fs::write(session_dir.join("contents").join("da39a3e"), "").expect("write old");
    std::fs::write(
        session_dir.join("contents").join("797f358"),
        "import unittest\n",
    )
    .expect("write new");
    // Shape copied from a real chatEditingSessions state.json (v2), with a
    // percent-encoded space in the resource to exercise URI decoding.
    std::fs::write(
        session_dir.join("state.json"),
        r#"{
            "version": 2,
            "sessionId": "task-031d2bde542c426da46f.session.execution",
            "recentSnapshot": {
                "entries": [{
                    "resource": "file:///Users/u/My%20Docs/test_sample.py",
                    "languageId": "python",
                    "originalHash": "da39a3e",
                    "currentHash": "797f358",
                    "state": 0
                }]
            }
        }"#,
    )
    .expect("write state");

    let snapshots = edit_snapshots_from_session_dir(&session_dir);
    assert_eq!(
        snapshots.get("/Users/u/My Docs/test_sample.py"),
        Some(&(String::new(), "import unittest\n".to_string()))
    );

    std::fs::remove_dir_all(&session_dir).expect("remove temp dir");
}

#[test]
fn ambiguous_task_prefix_backs_off_unchanged() {
    let log = [
        r#"2026-07-16 19:42:04.351 [info] [ChatSessionService] ACP progress: task-abc111.session.execution, rid=undefined, type=current_model_update"#,
        r#"2026-07-16 19:42:05.351 [info] [ChatSessionService] ACP progress: task-abc222.session.execution, rid=undefined, type=current_model_update"#,
    ]
    .join("\n");
    let mut events = Vec::new();
    parse_launch_log(&log, &mut events);

    let chunks = text_chunks("qoderapp-p/task-abc");
    let enriched = enrich_chunks_with_events(
        "qoderapp-p/task-abc",
        "task-abc",
        "p",
        None,
        chunks.clone(),
        &events,
        &no_snapshots,
    );
    assert_eq!(enriched.len(), chunks.len());
}

#[test]
fn no_matching_session_backs_off_unchanged() {
    let events = parse_fixture();
    let chunks = text_chunks("qoderapp-p/task-fff");
    let enriched = enrich_chunks_with_events(
        "qoderapp-p/task-fff",
        "task-fff",
        "p",
        None,
        chunks.clone(),
        &events,
        &no_snapshots,
    );
    assert_eq!(enriched.len(), chunks.len());
}

#[test]
fn spill_file_reads_attach_their_content_as_output() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("orgii-qoder-spill-{unique}"));
    let spill_dir = root.join("cache/projects/proj-ab/agent-tools/ab");
    std::fs::create_dir_all(&spill_dir).expect("create spill dir");
    let spill_path = spill_dir.join("cd.txt");
    std::fs::write(&spill_path, "fetched doc body").expect("write spill");

    let log = [
        r#"2026-07-16 19:42:04.351 [info] [ChatSessionService] ACP progress: task-aaa.session.execution, rid=undefined, type=current_model_update"#.to_string(),
        format!(
            r#"2026-07-16 19:42:05.000 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-1, read_file, {{"file_path":"{}"}}"#,
            spill_path.display()
        ),
    ]
    .join("\n");
    let mut events = Vec::new();
    parse_launch_log(&log, &mut events);

    let enriched = enrich_chunks_with_events(
        "qoderapp-proj-ab/task-aaa",
        "task-aaa",
        "proj-ab",
        None,
        text_chunks("qoderapp-proj-ab/task-aaa"),
        &events,
        &no_snapshots,
    );
    let tool = enriched
        .iter()
        .find(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
        .expect("tool chunk");
    assert_eq!(tool.result["output"], "fetched doc body");

    std::fs::remove_dir_all(&root).expect("remove temp dir");
}

#[test]
fn parses_both_log_formats_and_ignores_garbage() {
    let mut events = Vec::new();
    parse_launch_log(
        &[
            "not a log line",
            r#"2026-07-16 19:42:09.761 [info] [ChatSessionService] ACP progress: task-x.session.execution, rid=u, type=tool_call, toolCallId=call_1"#,
            r#"2026-07-16 19:42:24.655 [info] ToolInvoke : run_in_terminal"#,
            r#"{"command":"ls","cwd":"/w"}"#,
            // exthost name line with a non-JSON follower: skipped, not misparsed.
            r#"2026-07-16 19:42:25.000 [info] ToolInvoke : broken_tool"#,
            r#"2026-07-16 19:42:26.000 [info] some unrelated line"#,
        ]
        .join("\n"),
        &mut events,
    );
    assert_eq!(events.len(), 2);
    match &events[0] {
        LogEvent::Acp {
            session_task_id,
            tool_call_id: Some(id),
            ..
        } => {
            assert_eq!(session_task_id, "task-x");
            assert_eq!(id, "call_1");
        }
        other => panic!("unexpected event: {other:?}"),
    }
    match &events[1] {
        LogEvent::ToolInvoke { name, args, .. } => {
            assert_eq!(name, "run_in_terminal");
            assert_eq!(args["command"], "ls");
        }
        other => panic!("unexpected event: {other:?}"),
    }
}
