use super::*;

#[test]
fn includes_codex_session_dir_candidates() {
    let home = std::path::Path::new("/Users/example");
    let paths = codex_sessions_dir_candidates(home);
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
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
fn normalizes_codex_collaboration_calls_without_exposing_encrypted_messages() {
    let spawn_calls = normalize_codex_tool_calls(
        "spawn_agent",
        json!({
            "task_name": "audit_todays_commits",
            "fork_turns": "all",
            "message": format!("gAAAAA{}", "x".repeat(100))
        }),
    );
    assert_eq!(spawn_calls.len(), 1);
    assert_eq!(spawn_calls[0].0, "subagent");
    assert_eq!(spawn_calls[0].1["description"], "audit_todays_commits");
    assert_eq!(spawn_calls[0].1["task"], "audit_todays_commits");
    assert!(spawn_calls[0].1.get("prompt").is_none());

    let plaintext_spawn = normalize_codex_tool_calls(
        "spawn_agent",
        json!({
            "task_name": "inspect_parser",
            "message": "Inspect the Codex parser and report the root cause."
        }),
    );
    assert_eq!(
        plaintext_spawn[0].1["prompt"],
        "Inspect the Codex parser and report the root cause."
    );

    let message_calls = normalize_codex_tool_calls(
        "send_message",
        json!({
            "target": "/root/audit_todays_commits",
            "message": format!("gAAAAA{}", "y".repeat(100))
        }),
    );
    assert!(
        message_calls.is_empty(),
        "encrypted messages should not create empty cards"
    );

    let followup_calls = normalize_codex_tool_calls(
        "followup_task",
        json!({
            "target": "/root/audit_todays_commits",
            "message": "Also check regression coverage."
        }),
    );
    assert_eq!(followup_calls[0].0, "org_send_message");
    assert_eq!(
        followup_calls[0].1["text"],
        "Also check regression coverage."
    );
}

#[test]
fn codex_subagent_activity_attaches_exact_child_identity_to_spawn() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-subagent-activity-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-subagent-activity.jsonl");
    let arguments = json!({
        "task_name": "audit_todays_commits",
        "fork_turns": "all",
        "message": format!("gAAAAA{}", "x".repeat(100))
    })
    .to_string();
    let content = format!(
        r#"{{"timestamp":"2026-07-23T10:18:51.000Z","type":"event_msg","payload":{{"type":"user_message","message":"audit today's commit history"}}}}
{{"timestamp":"2026-07-23T10:19:01.213Z","type":"response_item","payload":{{"type":"function_call","name":"spawn_agent","namespace":"collaboration","arguments":{},"call_id":"call_spawn"}}}}
{{"timestamp":"2026-07-23T10:19:01.638Z","type":"event_msg","payload":{{"type":"sub_agent_activity","event_id":"call_spawn","agent_thread_id":"019f8e7c-5713-78b2-b790-494c41020f0f","agent_path":"/root/audit_todays_commits","kind":"started"}}}}
{{"timestamp":"2026-07-23T10:19:01.648Z","type":"response_item","payload":{{"type":"function_call_output","call_id":"call_spawn","output":"{{\"task_name\":\"/root/audit_todays_commits\"}}"}}}}
"#,
        serde_json::to_string(&arguments).expect("encode spawn arguments")
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-parent", &path).expect("parse");
    let spawn = chunks
        .iter()
        .find(|chunk| chunk.function == "subagent")
        .expect("subagent chunk");

    assert_eq!(
        spawn.args["codexAgentThreadId"],
        "019f8e7c-5713-78b2-b790-494c41020f0f"
    );
    assert_eq!(spawn.args["agent_path"], "/root/audit_todays_commits");
    assert!(spawn.args.get("prompt").is_none());

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
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
fn codex_initial_window_compacts_old_turns_and_loads_one_turn_on_demand() {
    let temp_dir =
        std::env::temp_dir().join(format!("orgii-codex-window-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-window.jsonl");
    let content = r#"{"timestamp":"2026-07-21T01:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"timestamp":"2026-07-21T01:00:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"first reply"}}
{"timestamp":"2026-07-21T01:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"second"}}
{"timestamp":"2026-07-21T01:01:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"second reply"}}
{"timestamp":"2026-07-21T01:02:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"third"}}
{"timestamp":"2026-07-21T01:02:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"third reply"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let window =
        load_codex_app_initial_window_from_path("codexapp-window", &path, 1).expect("window");
    let wire = serde_json::to_value(&window).expect("serialize window");
    assert!(wire.get("turns").is_none());
    assert_eq!(window.turns.len(), 2);
    assert_eq!(window.chunks.len(), 4);
    assert_eq!(
        window.chunks[0]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("second")
    );
    assert_eq!(
        window.chunks[1]
            .result
            .get("unloadedTurn")
            .and_then(|value| value.get("nextTurnId"))
            .and_then(Value::as_str),
        Some(window.chunks[2].chunk_id.as_str())
    );
    assert_eq!(
        window.chunks[2]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("third")
    );

    let turn = load_codex_app_turn_from_path("codexapp-window", &path, &window.chunks[0].chunk_id)
        .expect("turn");
    assert_eq!(turn.loaded_event_count, 2);
    assert_eq!(
        turn.chunks
            .iter()
            .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
            .filter_map(|chunk| chunk.result.pointer("/message/content"))
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_current_rollout_reads_latest_turn_and_pages_backward_from_tail() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-tail-window-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-tail-window.jsonl");
    let content = r#"{"timestamp":"2026-07-21T01:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}
{"timestamp":"2026-07-21T01:00:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"timestamp":"2026-07-21T01:00:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"first reply"}}
{"timestamp":"2026-07-21T01:01:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}
{"timestamp":"2026-07-21T01:01:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"second"}}
{"timestamp":"2026-07-21T01:01:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"second reply"}}
{"timestamp":"2026-07-21T01:02:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3"}}
{"timestamp":"2026-07-21T01:02:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"third"}}
{"timestamp":"2026-07-21T01:02:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"third reply"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let window =
        load_codex_app_initial_window_from_path("codexapp-tail-window", &path, 1).expect("window");
    assert_eq!(
        window.turns.len(),
        2,
        "only the previous and latest turns are indexed"
    );
    assert_eq!(window.chunks.len(), 4);
    assert_eq!(
        window.chunks[0]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("second")
    );
    assert!(window.chunks[1].result.get("unloadedTurn").is_some());
    assert_eq!(
        window.chunks[2]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("third")
    );
    let second_turn_id = window.chunks[0].chunk_id.clone();
    let second = load_codex_app_turn_from_path("codexapp-tail-window", &path, &second_turn_id)
        .expect("load previous turn");
    assert_eq!(second.loaded_event_count, 2);
    assert_eq!(second.chunks.len(), 4);
    assert_eq!(
        second.chunks[0]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("first")
    );
    assert!(second.chunks[1].result.get("unloadedTurn").is_some());
    assert_eq!(
        second.chunks[2]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("second")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_embedded_tool_images_are_removed_before_json_deserialization() {
    let mut line = format!(
        r#"{{"payload":{{"output":[{{"type":"input_text","text":"kept"}},{{"type":"input_image","image_url":"data:image/png;base64,{}"}}]}}}}"#,
        "A".repeat(1024 * 1024)
    );

    strip_ignored_embedded_images(&mut line);

    assert!(line.len() < 256);
    assert!(!line.contains("base64"));
    let parsed: Value = serde_json::from_str(&line).expect("valid compacted JSON");
    assert_eq!(
        parsed
            .get("payload")
            .and_then(|payload| payload.get("output"))
            .and_then(Value::as_array)
            .and_then(|parts| parts.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str),
        Some("kept")
    );
}

#[test]
fn codex_task_lifecycle_projects_only_finished_turns_as_completed() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-lifecycle-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-lifecycle.jsonl");
    let active_content = r#"{"timestamp":"2026-07-21T01:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}
{"timestamp":"2026-07-21T01:00:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"inspect this"}}
{"timestamp":"2026-07-21T01:00:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working"}}
"#;
    std::fs::write(&path, active_content).expect("write active fixture");

    let active_chunks =
        load_codex_app_from_path("codexapp-lifecycle", &path).expect("parse active turn");
    assert_eq!(
        active_chunks[1].action_type,
        imported_history::ACTION_TYPE_TASK_START
    );
    let active_rounds = crate::projectors::turn_metadata::project_activity_chunks(&active_chunks);
    assert_eq!(active_rounds.len(), 1);
    assert_eq!(active_rounds[0].status, "pending");

    let completed_content = format!(
        "{active_content}{}\n",
        r#"{"timestamp":"2026-07-21T01:00:02.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}"#
    );
    std::fs::write(&path, completed_content).expect("write completed fixture");
    let completed_chunks =
        load_codex_app_from_path("codexapp-lifecycle", &path).expect("parse completed turn");
    assert_eq!(
        completed_chunks
            .last()
            .map(|chunk| chunk.action_type.as_str()),
        Some(imported_history::ACTION_TYPE_TASK_COMPLETED)
    );
    let completed_rounds =
        crate::projectors::turn_metadata::project_activity_chunks(&completed_chunks);
    assert_eq!(completed_rounds[0].status, "completed");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_decomposes_exploration_chain_and_typed_output() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-desktop-exec-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-desktop-exec.jsonl");
    let script = r#"const r = await tools.shell_command({command:"sed -n '1,20p' src/app.ts && rg -n \"icon\" src","workdir":"/tmp/project","timeout_ms":10000}); text(r)"#;
    let content = format!(
        "{}\n{}\n",
        json!({
            "timestamp": "2026-07-12T19:07:54.615Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_desktop_shell",
                "input": script,
            }
        }),
        json!({
            "timestamp": "2026-07-12T19:07:55.212Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_desktop_shell",
                "output": [
                    { "type": "input_text", "text": "Script completed\n" },
                    { "type": "input_text", "text": "Exit code: 0\nconst icon = true;" },
                ],
            }
        })
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-desktop-exec", &path).expect("parse");

    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(chunks[1].function, imported_history::FUNCTION_CODE_SEARCH);
    assert_eq!(
        chunks[0].args.get("command").and_then(Value::as_str),
        Some("sed -n '1,20p' src/app.ts")
    );
    assert_eq!(chunks[0].args["path"], "src/app.ts");
    assert_eq!(chunks[0].args["limit"], 20);
    assert_eq!(chunks[1].args["query"], "icon");
    assert_eq!(
        chunks[0].args.get("cwd").and_then(Value::as_str),
        Some("/tmp/project")
    );
    assert_ne!(
        chunks[0].args.get("input").and_then(Value::as_str),
        Some(script)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_preserves_failed_shell_status_and_exit_code() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-desktop-failed-exec-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-desktop-failed-exec.jsonl");
    let command = "wc -l ~/.orgii/skills/frontend-ui-audit/SKILL.md && sed -n '1,260p' ~/.orgii/skills/frontend-ui-audit/SKILL.md";
    let script = format!(
        "const r = await tools.shell_command({{command:{},workdir:\"/tmp/project\",timeout_ms:10000}}); text(r)",
        serde_json::to_string(command).expect("encode command")
    );
    let output = "Script failed\nWall time 0.1 seconds\nOutput:\nScript error:\nExit code: 1\nWall time: 0 seconds\nOutput:\nwc: /Users/laptop-h/.orgii/skills/frontend-ui-audit/SKILL.md: open: No such file or directory";
    let content = format!(
        "{}\n{}\n",
        json!({
            "timestamp": "2026-07-12T19:07:54.615Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_failed_shell",
                "input": script,
            }
        }),
        json!({
            "timestamp": "2026-07-12T19:07:55.212Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_failed_shell",
                "output": [
                    { "type": "input_text", "text": output },
                ],
            }
        })
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-desktop-failed-exec", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(
        chunks[0].args["path"],
        "~/.orgii/skills/frontend-ui-audit/SKILL.md"
    );
    assert_eq!(chunks[0].args["limit"], 260);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(chunks[0].result["status"], "failed");
    assert_eq!(chunks[0].result["is_error"], true);
    assert_eq!(chunks[0].result["exit_code"], 1);
    assert_eq!(chunks[0].result["failure"]["exitCode"], 1);
    assert_eq!(chunks[0].result["failure"]["stderr"], output);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_background_wait_completes_the_original_shell_call() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-background-wait-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-background-wait.jsonl");
    let command = "find .orgii -maxdepth 4 -type f -name SKILL.md -print 2>/dev/null; find /Users/laptop-h -path '*/frontend-ui-audit/SKILL.md' -print 2>/dev/null | head -20";
    let script = format!(
        "const r = await tools.shell_command({{command:{},workdir:\"/tmp/project\",timeout_ms:10000}}); text(r)",
        serde_json::to_string(command).expect("encode command")
    );
    let content = format!(
        "{}\n{}\n{}\n{}\n",
        json!({
            "timestamp": "2026-07-12T19:20:13.946Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_find_skill",
                "input": script,
            }
        }),
        json!({
            "timestamp": "2026-07-12T19:20:23.968Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_find_skill",
                "output": "Script running with cell ID 14\nWall time 10.0 seconds\nOutput:\n",
            }
        }),
        json!({
            "timestamp": "2026-07-12T19:20:25.809Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "wait",
                "call_id": "call_wait_find_skill",
                "arguments": r#"{"cell_id":"14","yield_time_ms":1000,"max_tokens":2000}"#,
            }
        }),
        json!({
            "timestamp": "2026-07-12T19:20:25.843Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_wait_find_skill",
                "output": [
                    { "type": "input_text", "text": "Script failed\nWall time 0.0 seconds\nOutput:\n" },
                    { "type": "input_text", "text": "Script error:\nExit code: 124\nWall time: 10 seconds\nOutput:\ncommand timed out after 10008 milliseconds\n.orgii/skills/architecture-audit/SKILL.md\n.orgii/skills/e2e-testing/SKILL.md\n" },
                ],
            }
        })
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-background-wait", &path).expect("parse");

    assert_eq!(chunks.len(), 2);
    assert!(chunks.iter().all(|chunk| {
        chunk.function == imported_history::FUNCTION_GLOB_FILE_SEARCH
            && chunk.result["success"] == false
            && chunk.result["exit_code"] == 124
            && chunk.result["output"]
                .as_str()
                .is_some_and(|output| output.contains("command timed out"))
    }));
    assert_eq!(chunks[0].args["pattern"], "SKILL.md");
    assert_eq!(chunks[1].args["pattern"], "*/frontend-ui-audit/SKILL.md");
    assert!(chunks.iter().all(|chunk| chunk.function != "wait"));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_unwraps_parallel_shell_commands() {
    let script = r#"const results = await Promise.all([
  tools.shell_command({command:"npm run typecheck","workdir":"/tmp/project","timeout_ms":120000}),
  tools.shell_command({command:"cargo test -p orgtrack_core","workdir":"/tmp/project","timeout_ms":120000})
]); results.forEach((r)=>text(r));"#;
    let payload = json!({
        "name": "exec",
        "call_id": "call_parallel",
        "input": script,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-12T19:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].canonical_name,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        calls[1].canonical_name,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(calls[0].args["command"], "npm run typecheck");
    assert_eq!(calls[1].args["command"], "cargo test -p orgtrack_core");
    assert_eq!(calls[0].call_id, "call_parallel:part-0");
    assert_eq!(calls[1].call_id, "call_parallel:part-1");
}

#[test]
fn codex_desktop_exec_unwraps_parallel_result_array_per_command() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-parallel-results-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-parallel-results.jsonl");
    let script = r#"const results = await Promise.all([
  tools.exec_command({cmd:"npx eslint src/ --format stylish",workdir:"/tmp/project",yield_time_ms:30000,max_output_tokens:20000}),
  tools.exec_command({cmd:"npm run typecheck",workdir:"/tmp/project",yield_time_ms:30000,max_output_tokens:30000})
]); results.forEach((result) => text(JSON.stringify(result)));"#;
    let wrapped_results = format!(
        "Script completed\nWall time 17.6 seconds\nOutput:\n{}",
        json!([
            {
                "chunk_id": "eed8df",
                "wall_time_seconds": 17.6,
                "session_id": 17954,
                "original_token_count": 0,
                "output": "lint passed\n"
            },
            {
                "chunk_id": "7ed187",
                "wall_time_seconds": 31.4,
                "session_id": 95241,
                "original_token_count": 14,
                "output": "> orgii@1.2.1 typecheck\n> tsc --noEmit --pretty false\n"
            }
        ])
    );
    let content = [
        json!({
            "timestamp": "2026-07-23T15:27:00Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_parallel_results",
                "input": script,
            }
        }),
        json!({
            "timestamp": "2026-07-23T15:27:18Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_parallel_results",
                "output": [
                    { "type": "input_text", "text": wrapped_results },
                ],
            }
        }),
    ]
    .into_iter()
    .map(|line| line.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-parallel-results", &path).expect("parse");

    assert_eq!(chunks.len(), 2);
    let lint = chunks
        .iter()
        .find(|chunk| chunk.args["command"] == "npx eslint src/ --format stylish")
        .expect("lint command");
    let typecheck = chunks
        .iter()
        .find(|chunk| chunk.args["command"] == "npm run typecheck")
        .expect("typecheck command");
    assert_eq!(lint.result["output"], "lint passed\n");
    assert_eq!(
        typecheck.result["output"],
        "> orgii@1.2.1 typecheck\n> tsc --noEmit --pretty false\n"
    );
    assert!(chunks.iter().all(|chunk| {
        chunk.result["output"]
            .as_str()
            .is_some_and(|output| !output.contains("Script completed"))
    }));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_unwraps_exec_command_arguments() {
    let script = r#"const results = await Promise.all([
  tools.exec_command({cmd:"git status --short --branch",workdir:"/Users/laptop-h/Documents/GitHub/ORGII",yield_time_ms:10000,max_output_tokens:3000}),
  tools.exec_command({cmd:"git remote -v",workdir:"/Users/laptop-h/Documents/GitHub/ORGII",yield_time_ms:10000,max_output_tokens:3000})
]); results.forEach((result) => text(result));"#;
    let payload = json!({
        "name": "exec",
        "call_id": "call_exec_command",
        "input": script,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-18T01:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 2);
    assert!(calls
        .iter()
        .all(|call| { call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE }));
    assert_eq!(calls[0].args["command"], "git status --short --branch");
    assert_eq!(calls[1].args["command"], "git remote -v");
    assert!(calls
        .iter()
        .all(|call| { call.args["cwd"] == "/Users/laptop-h/Documents/GitHub/ORGII" }));
    assert!(calls.iter().all(|call| {
        !call.args["command"]
            .as_str()
            .is_some_and(|command| command.contains("yield_time_ms"))
    }));
}

#[test]
fn codex_desktop_exec_maps_write_stdin_to_await_output() {
    let payload = json!({
        "name": "exec",
        "call_id": "call_write_stdin",
        "input": r#"const r = await tools.write_stdin({session_id:82118,chars:"",yield_time_ms:30000,max_output_tokens:16000}); text(r)"#,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-18T01:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].canonical_name,
        imported_history::FUNCTION_AWAIT_OUTPUT
    );
    assert_eq!(calls[0].args["command"], "wait_for");
    assert_eq!(calls[0].args["handle"], "82118");
    assert_eq!(calls[0].args["handles"], json!(["82118"]));
    assert_eq!(calls[0].args["block_until_ms"], 30000);
    assert_eq!(calls[0].args["chars"], "");
}

#[test]
fn codex_write_stdin_polls_merge_into_originating_exec_command() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-write-stdin-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-write-stdin.jsonl");
    let content = [
        json!({
            "timestamp": "2026-07-18T01:00:00Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_shell",
                "input": r#"const r = await tools.exec_command({cmd:"cargo test",workdir:"/tmp/project",yield_time_ms:10000,max_output_tokens:3000}); text(r)"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:10Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_shell",
                "output": [
                    { "type": "input_text", "text": "Script completed\nWall time 10.0 seconds\nOutput:\n" },
                    { "type": "input_text", "text": r#"{"session_id":82118,"output":"Compiling\n"}"# },
                ],
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:11Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_poll",
                "input": r#"const r = await tools.write_stdin({session_id:82118,chars:"",yield_time_ms:30000,max_output_tokens:3000}); text(r)"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:41Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_poll",
                "output": [
                    { "type": "input_text", "text": "Script completed\nWall time 30.0 seconds\nOutput:\n" },
                    { "type": "input_text", "text": r#"{"session_id":82118,"output":"Running tests\n"}"# },
                ],
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:42Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_interrupt",
                "input": r#"const r = await tools.write_stdin({session_id:82118,chars:"\u0003",yield_time_ms:1000,max_output_tokens:3000}); text(r)"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:43Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_interrupt",
                "output": [
                    { "type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n" },
                    { "type": "input_text", "text": r#"{"exit_code":130,"output":"Interrupted\n"}"# },
                ],
            }
        }),
    ]
    .into_iter()
    .map(|line| line.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-write-stdin", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(chunks[0].args["command"], "cargo test");
    assert_eq!(
        chunks[0].result["output"],
        "Compiling\nRunning tests\nInterrupted\n"
    );
    assert_eq!(chunks[0].result["exit_code"], 130);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(chunks[0].args["stdin_events"][0]["kind"], "interrupt");
    assert_eq!(chunks[0].args["stdin_events"][0]["chars"], "\u{3}");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_write_stdin_cell_wait_still_merges_into_originating_command() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-write-stdin-cell-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-write-stdin-cell.jsonl");
    let content = [
        json!({
            "timestamp": "2026-07-18T01:00:00Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_shell",
                "input": r#"const r = await tools.exec_command({cmd:"pnpm test",workdir:"/tmp/project",yield_time_ms:10000,max_output_tokens:3000}); text(r)"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:10Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_shell",
                "output": [{
                    "type": "input_text",
                    "text": r#"{"session_id":42,"output":"Starting\n"}"#,
                }],
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:11Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_poll",
                "input": r#"const r = await tools.write_stdin({session_id:42,chars:"",yield_time_ms:30000,max_output_tokens:3000}); text(r)"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:21Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_poll",
                "output": "Script running with cell ID 9\nWall time 10.0 seconds\nOutput:\n",
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:22Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "wait",
                "call_id": "call_wait",
                "arguments": r#"{"cell_id":"9","yield_time_ms":30000,"max_tokens":3000}"#,
            }
        }),
        json!({
            "timestamp": "2026-07-18T01:00:23Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_wait",
                "output": [{
                    "type": "input_text",
                    "text": r#"{"exit_code":0,"output":"Passed\n"}"#,
                }],
            }
        }),
    ]
    .into_iter()
    .map(|line| line.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-write-stdin-cell", &path).expect("parse");

    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(chunks[0].args["command"], "pnpm test");
    assert_eq!(chunks[0].result["output"], "Starting\nPassed\n");
    assert_eq!(chunks[0].result["exit_code"], 0);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_preserves_multiline_shell_script() {
    let command = "sed -n '1,180p' src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/menuItemBuilders.tsx\nsed -n '250,370p' src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/index.tsx\nsed -n '1,180p' src/config/agentIcons.tsx\nrg -n \"interface.*MenuItem|type.*MenuItem|renderStatusDot|agentIconId\" src/scaffold/NavigationSidebar src/scaffold -g '*.tsx' -g '*.ts' | head -200";
    let script = format!(
        "const r = await tools.shell_command({{command:{},workdir:\"/tmp/project\",timeout_ms:10000}}); text(r)",
        serde_json::to_string(command).expect("encode command")
    );
    let payload = json!({
        "name": "exec",
        "call_id": "call_multiline",
        "input": script,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-12T19:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 4);
    assert_eq!(
        calls[0].canonical_name,
        imported_history::FUNCTION_READ_FILE
    );
    assert_eq!(
        calls[1].canonical_name,
        imported_history::FUNCTION_READ_FILE
    );
    assert_eq!(
        calls[2].canonical_name,
        imported_history::FUNCTION_READ_FILE
    );
    assert_eq!(
        calls[3].canonical_name,
        imported_history::FUNCTION_CODE_SEARCH
    );
    assert_eq!(
        calls[0].args["path"],
        "src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/menuItemBuilders.tsx"
    );
    assert_eq!(calls[0].args["limit"], 180);
    assert_eq!(
        calls[1].args["path"],
        "src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/index.tsx"
    );
    assert_eq!(calls[1].args["offset"], 249);
    assert_eq!(calls[1].args["limit"], 121);
    assert_eq!(calls[2].args["path"], "src/config/agentIcons.tsx");
    assert_eq!(calls[2].args["limit"], 180);
    assert_eq!(
        calls[3].args["query"],
        "interface.*MenuItem|type.*MenuItem|renderStatusDot|agentIconId"
    );
    assert_eq!(calls[0].args["cwd"], "/tmp/project");

    let output = (1..=483)
        .map(|line| format!("line-{line}\n"))
        .collect::<String>();
    let parts = output_parts_for_tool_calls(&calls, &output);
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0].lines().count(), 180);
    assert_eq!(parts[1].lines().count(), 121);
    assert_eq!(parts[2].lines().count(), 180);
    assert_eq!(parts[3].lines().count(), 2);
}

#[test]
fn codex_desktop_exec_decomposes_pwd_and_rg_exploration_chain() {
    let command = "pwd && rg --files -g 'AGENTS.md' -g '!node_modules' -g '!target' | head -50 && rg -n \"Codex icon|External data sources|Kanban page RAM|task.*icon|thread.*icon|agent.*icon\" . --glob '!node_modules' --glob '!target' --glob '!dist'";
    let script = format!(
        "const r = await tools.shell_command({{command:{},workdir:\"/Users/laptop-h/Documents/GitHub/ORGII\",timeout_ms:10000}}); text(r)",
        serde_json::to_string(command).expect("encode command")
    );
    let payload = json!({
        "name": "exec",
        "call_id": "call_pwd_rg_chain",
        "input": script,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-12T19:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].canonical_name,
        imported_history::FUNCTION_GLOB_FILE_SEARCH
    );
    assert_eq!(calls[0].args["pattern"], "AGENTS.md");
    assert_eq!(calls[0].args["command_index"], 1);
    assert_eq!(calls[0].args["command_count"], 3);
    assert_eq!(
        calls[1].canonical_name,
        imported_history::FUNCTION_CODE_SEARCH
    );
    assert_eq!(
        calls[1].args["query"],
        "Codex icon|External data sources|Kanban page RAM|task.*icon|thread.*icon|agent.*icon"
    );
    assert_eq!(calls[1].args["command_index"], 2);
    assert_eq!(calls[0].call_id, "call_pwd_rg_chain:part-0");
    assert_eq!(calls[1].call_id, "call_pwd_rg_chain:part-1");
}

#[test]
fn codex_desktop_exec_unwraps_apply_patch_variable() {
    let patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch";
    let script = format!(
        "const patch = {}; const r = await tools.apply_patch(patch); text(r)",
        serde_json::to_string(patch).expect("encode patch")
    );
    let payload = json!({
        "name": "exec",
        "call_id": "call_patch",
        "input": script,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-12T19:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].canonical_name,
        imported_history::FUNCTION_EDIT_FILE
    );
    assert_eq!(calls[0].args["file_path"], "src/app.ts");
    assert_eq!(calls[0].args["patch_text"], patch);
}

#[test]
fn codex_rollout_without_session_start_still_recovers_exec_apply_patch() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-missing-session-start-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-missing-session-start.jsonl");
    let patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch";
    let script = format!(
        "const patch = {}; const r = await tools.apply_patch(patch); text(r)",
        serde_json::to_string(patch).expect("encode patch")
    );
    let content = format!(
        "{}\n{}\n",
        json!({
            "timestamp": "2026-07-20T12:49:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call_missed_hook_patch",
                "input": script,
            }
        }),
        json!({
            "timestamp": "2026-07-20T12:49:00.100Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_missed_hook_patch",
                "output": "Success",
            }
        })
    );
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-missing-session-start", &path)
        .expect("parse rollout without lifecycle hooks");

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(chunks[0].args["file_path"], "src/app.ts");
    assert_eq!(chunks[0].args["patch_text"], patch);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_desktop_exec_unwraps_web_search_query() {
    let payload = json!({
        "name": "exec",
        "call_id": "call_web",
        "input": r#"const r = await tools.web__run({search_query:[{q:"Codex app event format"}],response_length:"short"}); text(r)"#,
    });

    let (_, calls) = pending_custom_tool_calls_from_payload(&payload, "2026-07-12T19:00:00Z")
        .expect("parse custom tool call");

    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].canonical_name, "web_search");
    assert_eq!(calls[0].args["query"], "Codex app event format");
}

#[test]
fn codex_first_class_web_search_calls_render_as_web_activity() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-web-search-call-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-web-search-call.jsonl");
    let content = r#"{"timestamp":"2026-07-09T13:51:02.341Z","type":"response_item","payload":{"type":"web_search_call","id":"ws_search","status":"completed","action":{"type":"search","query":"Codex app event format","queries":["Codex app event format"]}}}
{"timestamp":"2026-07-09T13:51:26.167Z","type":"response_item","payload":{"type":"web_search_call","id":"ws_open","status":"completed","action":{"type":"open_page","url":"https://developers.openai.com/codex"}}}
{"timestamp":"2026-07-09T13:51:30.413Z","type":"response_item","payload":{"type":"web_search_call","id":"ws_find","status":"completed","action":{"type":"find_in_page","url":"https://developers.openai.com/codex","pattern":"app-server"}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-web-search", &path).expect("parse");

    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(|chunk| chunk.function == "web_search"));
    assert_eq!(chunks[0].args["action"], "search");
    assert_eq!(chunks[0].args["query"], "Codex app event format");
    assert_eq!(chunks[1].args["action"], "open_page");
    assert_eq!(
        chunks[1].args["query"],
        "https://developers.openai.com/codex"
    );
    assert_eq!(chunks[2].args["action"], "find_in_page");
    assert_eq!(chunks[2].args["pattern"], "app-server");

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
fn codex_patch_apply_end_is_authoritative_impact_source() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-patch-apply-end-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-patch-apply-end.jsonl");

    // The same edit is present both as an `apply_patch` tool call AND as the
    // authoritative `patch_apply_end` result. The parser must count it once,
    // from `patch_apply_end`, not add the tool-call fallback on top.
    let tool_patch = "*** Begin Patch\n*** Update File: src/app.rs\n@@\n-old\n+new\n*** End Patch";
    let tool_arguments = serde_json::json!({ "patch": tool_patch }).to_string();
    let changes = serde_json::json!({
        "src/app.rs": {
            "type": "update",
            "unified_diff": "@@ -1,1 +1,2 @@\n-old\n+new\n+extra\n",
            "move_path": null
        },
        "src/added.rs": {
            "type": "add",
            "unified_diff": "@@ -0,0 +1,1 @@\n+fresh\n",
            "move_path": null
        }
    });
    let content = format!(
        r#"{{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"abc"}}}}
{{"timestamp":"2026-02-11T06:16:07.000Z","type":"response_item","payload":{{"type":"function_call","name":"apply_patch","arguments":{},"call_id":"call_patch"}}}}
{{"timestamp":"2026-02-11T06:16:08.000Z","type":"event_msg","payload":{{"type":"patch_apply_end","call_id":"call_patch","success":true,"stdout":"Success","stderr":"","changes":{}}}}}
"#,
        serde_json::to_string(&tool_arguments).expect("encode args string"),
        changes
    );
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "rollout-patch-apply-end".to_string(),
        source_path: path.clone(),
        source_record_key: "rollout-patch-apply-end".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    // Two files from `changes`, line counts from the unified diffs — and the
    // tool-call fallback is NOT added on top (would inflate lines otherwise).
    assert_eq!(meta.impact.files_changed, 2);
    assert_eq!(meta.impact.lines_added, 3); // +new +extra +fresh
    assert_eq!(meta.impact.lines_removed, 1); // -old
    assert_eq!(
        meta.impact.touched_files,
        vec!["src/added.rs".to_string(), "src/app.rs".to_string()]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn codex_failed_patch_apply_end_is_ignored() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-failed-patch-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-failed-patch.jsonl");
    let changes = serde_json::json!({
        "src/app.rs": { "type": "update", "unified_diff": "@@\n-old\n+new\n" }
    });
    let content = format!(
        r#"{{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"abc"}}}}
{{"timestamp":"2026-02-11T06:16:08.000Z","type":"event_msg","payload":{{"type":"patch_apply_end","call_id":"c1","success":false,"stdout":"","stderr":"nope","changes":{}}}}}
"#,
        changes
    );
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Codex").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "rollout-failed-patch".to_string(),
        source_path: path.clone(),
        source_record_key: "rollout-failed-patch".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };
    let meta = parse_codex_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.impact.files_changed, 0);
    assert_eq!(meta.impact.lines_added, 0);
    assert_eq!(meta.impact.lines_removed, 0);
    assert!(meta.impact.touched_files.is_empty());

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
    let parent_sessions_dir = temp_dir.join("sessions").join("2026").join("07").join("08");
    let child_sessions_dir = temp_dir.join("sessions").join("2026").join("07").join("09");
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
            r#"{{"timestamp":"2026-07-08T15:12:12.000Z","type":"session_meta","payload":{{"cwd":"/Users/me/project","id":"{child_thread_id}","session_id":"{parent_thread_id}","forked_from_id":"{parent_thread_id}","parent_thread_id":"{parent_thread_id}","thread_source":"subagent","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{parent_thread_id}","depth":1,"agent_path":"/root/inspect_session_naming","agent_nickname":"Copernicus"}}}}}}}}}}
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
    assert_eq!(
        meta.source_metadata.first_prompt.as_deref(),
        Some("inspect session naming")
    );
    assert_eq!(
        meta.source_metadata.agent_nickname.as_deref(),
        Some("Copernicus")
    );
    assert_eq!(
        meta.source_metadata.agent_path.as_deref(),
        Some("/root/inspect_session_naming")
    );
    let cache_input = meta::parse_codex_catalog_input(&record)
        .expect("parse compact catalog input")
        .expect("catalog input");
    let cached_metadata: Value = serde_json::from_str(
        cache_input
            .source_metadata_json
            .as_deref()
            .expect("subagent metadata"),
    )
    .expect("parse subagent metadata");
    assert_eq!(cached_metadata["firstPrompt"], "inspect session naming");
    assert_eq!(cached_metadata["agentNickname"], "Copernicus");

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

#[test]
fn strips_orgii_exec_mode_bridge_from_codex_user_text() {
    // Bridge prefix followed by the real user text → only the user text.
    let with_bridge = "<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\nfix the login bug";
    assert_eq!(
        strip_orgii_exec_mode_bridge(with_bridge),
        "fix the login bug"
    );

    // Bridge-only message → empty.
    let bridge_only =
        "<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>";
    assert_eq!(strip_orgii_exec_mode_bridge(bridge_only), "");

    // No bridge → unchanged.
    let plain = "just a normal prompt";
    assert_eq!(strip_orgii_exec_mode_bridge(plain), plain);

    // Payload plumbing: bridge-only user_message is skipped entirely
    // (no replay chunk, no title candidate); prefixed one is stripped.
    let bridge_only_payload = serde_json::json!({
        "type": "user_message",
        "message": bridge_only,
    });
    assert_eq!(user_message_from_payload(&bridge_only_payload), None);

    let prefixed_payload = serde_json::json!({
        "type": "user_message",
        "message": with_bridge,
    });
    assert_eq!(
        user_message_from_payload(&prefixed_payload).as_deref(),
        Some("fix the login bug")
    );
}

#[test]
fn strips_ide_context_from_codex_user_text() {
    // Bridge + ide_context prefixes followed by the real user text → only
    // the user text.
    let with_both = "<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\n<ide_context>\nopen file: src/app.ts\n</ide_context>\n\nfix the login bug";
    assert_eq!(strip_orgii_exec_mode_bridge(with_both), "fix the login bug");

    // ide_context-only message → empty.
    let ide_only = "<ide_context>\nopen file: src/app.ts\n</ide_context>";
    assert_eq!(strip_orgii_exec_mode_bridge(ide_only), "");

    // Unclosed known tag → the whole remainder is internal.
    let unclosed = "<ide_context>\ntruncated without close";
    assert_eq!(strip_orgii_exec_mode_bridge(unclosed), "");

    // Payload plumbing: ide_context-only user_message is skipped entirely
    // (no replay chunk, no title candidate); prefixed one is stripped.
    let ide_only_payload = serde_json::json!({
        "type": "user_message",
        "message": ide_only,
    });
    assert_eq!(user_message_from_payload(&ide_only_payload), None);

    let both_payload = serde_json::json!({
        "type": "user_message",
        "message": with_both,
    });
    assert_eq!(
        user_message_from_payload(&both_payload).as_deref(),
        Some("fix the login bug")
    );
}

#[test]
fn resumes_codex_meta_parse_from_watermark() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-history-watermark-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-watermark.jsonl");
    let prefix = r#"{"timestamp":"2026-02-11T06:16:06.458Z","type":"session_meta","payload":{"cwd":"/Users/me/project","id":"abc"}}
{"timestamp":"2026-02-11T06:16:07.000Z","type":"event_msg","payload":{"type":"user_message","message":"resume me","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"2026-02-11T06:16:09.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"cache_write_input_tokens":10,"output_tokens":30,"reasoning_output_tokens":5}}}}
"#;
    std::fs::write(&path, prefix).expect("write fixture");

    let record_for = |path: &std::path::Path| {
        let (source_mtime_ms, source_size_bytes) =
            imported_paths::file_metadata_signature(path, "Codex").expect("metadata");
        ImportedHistoryDiscoveredRecord {
            source_session_id: "rollout-watermark".to_string(),
            source_path: path.to_path_buf(),
            source_record_key: "rollout-watermark".to_string(),
            source_mtime_ms,
            source_size_bytes,
            source_fingerprint: String::new(),
            parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        }
    };

    let first = parse_codex_session_meta_incremental(&record_for(&path), None).expect("parse");
    assert!(!first.resumed);
    assert_eq!(first.watermark.byte_offset, prefix.len() as i64);
    let first_meta = first.meta.expect("first meta");
    assert_eq!(first_meta.input_tokens, 100);
    assert_eq!(first_meta.output_tokens, 35);
    assert_eq!(first_meta.rounds.len(), 1);

    // Cumulative totals continue past the watermark; the per-round delta
    // depends on prev_* carried inside the persisted state.
    let suffix = r#"{"timestamp":"2026-02-11T06:17:09.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":260,"cached_input_tokens":60,"cache_write_input_tokens":25,"output_tokens":70,"reasoning_output_tokens":10}}}}
"#;
    std::fs::write(&path, format!("{prefix}{suffix}")).expect("append fixture");

    let resumed = parse_codex_session_meta_incremental(&record_for(&path), Some(&first.watermark))
        .expect("parse resumed");
    assert!(resumed.resumed);
    let scratch =
        parse_codex_session_meta_incremental(&record_for(&path), None).expect("parse from scratch");
    assert!(!scratch.resumed);

    let resumed_meta = resumed.meta.expect("resumed meta");
    let scratch_meta = scratch.meta.expect("scratch meta");
    assert_eq!(resumed_meta.input_tokens, scratch_meta.input_tokens);
    assert_eq!(resumed_meta.output_tokens, scratch_meta.output_tokens);
    assert_eq!(resumed_meta.cache_read_tokens, scratch_meta.cache_read_tokens);
    assert_eq!(
        resumed_meta.cache_write_tokens,
        scratch_meta.cache_write_tokens
    );
    assert_eq!(resumed_meta.rounds.len(), 2);
    assert_eq!(resumed_meta.rounds.len(), scratch_meta.rounds.len());
    assert_eq!(resumed_meta.rounds[1].seq, 1);
    assert_eq!(resumed_meta.rounds[1].input_tokens, 105); // Δinput 160 − Δcached 40 − Δcache_write 15
    assert_eq!(
        resumed_meta.rounds[1].input_tokens,
        scratch_meta.rounds[1].input_tokens
    );
    assert_eq!(resumed_meta.name, scratch_meta.name);
    assert_eq!(resumed_meta.updated_at_ms, scratch_meta.updated_at_ms);
    assert_eq!(resumed.watermark.byte_offset, scratch.watermark.byte_offset);
    assert_eq!(resumed.watermark.prefix_hash, scratch.watermark.prefix_hash);

    // Same-length prefix mutation invalidates the resume.
    let mutated = format!("{prefix}{suffix}").replace("resume me", "RESUME ME");
    std::fs::write(&path, mutated).expect("mutate fixture");
    let reparsed =
        parse_codex_session_meta_incremental(&record_for(&path), Some(&resumed.watermark))
            .expect("parse mutated");
    assert!(!reparsed.resumed);
    let reparsed_meta = reparsed.meta.expect("reparsed meta");
    assert_eq!(reparsed_meta.input_tokens, scratch_meta.input_tokens);
    assert_eq!(reparsed_meta.name, "RESUME ME");

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}
