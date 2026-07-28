use crate::agent_sessions::cli::parsers::alias_map::get_ui_canonical;
use crate::agent_sessions::event_pipeline::extractors::extractors::{
    detect_language, extract_batch, extract_event_data, strip_line_number_prefixes_pub,
};
use crate::agent_sessions::event_pipeline::extractors::{
    types::OrgTaskOperationOutcome, ExtractedData,
};
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

fn make_event(
    function_name: &str,
    variant: EventDisplayVariant,
    args: serde_json::Value,
    result: serde_json::Value,
) -> SessionEvent {
    SessionEvent {
        id: "evt-1".to_string(),
        chunk_id: Some("evt-1".to_string()),
        session_id: "sess-1".to_string(),
        created_at: "2025-01-15T10:30:00.000Z".to_string(),
        function_name: function_name.to_string(),
        ui_canonical: get_ui_canonical(function_name).to_string(),
        action_type: "tool_call".to_string(),
        args,
        result,
        source: EventSource::Assistant,
        display_text: function_name.to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: variant,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    }
}

#[test]
fn test_extract_thinking() {
    let event = SessionEvent {
        display_variant: EventDisplayVariant::Thinking,
        result: serde_json::json!({"thought": "Analyzing the codebase...", "duration": 2.5}),
        ..make_event(
            "thinking",
            EventDisplayVariant::Thinking,
            serde_json::json!({}),
            serde_json::json!({}),
        )
    };

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Thinking(t) => {
            assert_eq!(t.content.as_deref(), Some("Analyzing the codebase..."));
            assert_eq!(t.duration, Some(2.5));
        }
        _ => panic!("Expected Thinking variant"),
    }
}

#[test]
fn test_extract_file_read() {
    let event = make_event(
        "read_file",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"file_path": "/src/main.rs"}),
        serde_json::json!({"content": "fn main() {\n    println!(\"hello\");\n}"}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::File(f) => {
            assert_eq!(f.file_path, "/src/main.rs");
            assert_eq!(f.file_name, "main.rs");
            assert_eq!(f.language, "rust");
            assert_eq!(f.line_count, Some(3));
            assert!(f.content.is_some());
        }
        _ => panic!("Expected File variant"),
    }
}

#[test]
fn test_extract_file_read_uses_offset_limit_for_plain_imported_output() {
    let event = make_event(
        "read_file",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "file_path": "src/app.rs",
            "offset": 249,
            "limit": 36,
        }),
        serde_json::json!({"output": "plain imported sed output"}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::File(f) => {
            assert_eq!(f.file_path, "src/app.rs");
            assert_eq!(f.start_line, Some(250));
            assert_eq!(f.line_count, Some(36));
        }
        _ => panic!("Expected File variant"),
    }
}

#[test]
fn test_extract_file_read_accepts_camel_case_file_path() {
    let event = make_event(
        "read_file",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"filePath": "/workspace/package.json"}),
        serde_json::json!({"content": "{\"name\":\"demo\"}"}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::File(f) => {
            assert_eq!(f.file_path, "/workspace/package.json");
            assert_eq!(f.file_name, "package.json");
            assert_eq!(f.language, "json");
        }
        _ => panic!("Expected File variant"),
    }
}

#[test]
fn test_extract_edit() {
    let event = make_event(
        "edit_file_by_replace",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "file_path": "/src/lib.ts",
            "old_str": "const x = 1;",
            "new_str": "const x = 42;"
        }),
        serde_json::json!({"success": {"linesAdded": 1, "linesRemoved": 1}}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(e) => {
            assert_eq!(e.file_path, "/src/lib.ts");
            assert_eq!(e.file_name, "lib.ts");
            assert_eq!(e.language, "typescript");
            assert_eq!(e.old_content.as_deref(), Some("const x = 1;"));
            assert_eq!(e.new_content.as_deref(), Some("const x = 42;"));
            assert_eq!(e.lines_added, Some(1));
            assert_eq!(e.lines_removed, Some(1));
        }
        _ => panic!("Expected Edit variant"),
    }
}

#[test]
fn test_extract_apply_patch_prefers_real_diff_result() {
    let event = make_event(
        "apply_patch",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "patch_text": "*** Begin Patch\n*** Update File: sample.rs\n@@\n-old\n+new\n*** End Patch"
        }),
        serde_json::json!({
            "content": "Patch applied successfully.\nModified: sample.rs",
            "diffString": "--- a/sample.rs\n+++ b/sample.rs\n@@ -1,5 +1,5 @@\n line1\n line2\n-old\n+new\n line4\n line5\n",
            "linesAdded": 1,
            "linesRemoved": 1,
            "filePaths": ["sample.rs"],
            "segments": [{
                "filePath": "sample.rs",
                "diff": "--- a/sample.rs\n+++ b/sample.rs\n@@ -1,5 +1,5 @@\n line1\n line2\n-old\n+new\n line4\n line5\n",
                "linesAdded": 1,
                "linesRemoved": 1,
                "isDeleted": false
            }]
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(edit) => {
            let diff = edit.diff.as_deref().unwrap();
            assert!(diff.contains(" line1"));
            assert!(diff.contains(" line2"));
            assert!(diff.contains(" line4"));
            assert!(diff.contains(" line5"));
            assert_eq!(edit.lines_added, Some(1));
            assert_eq!(edit.lines_removed, Some(1));
            assert_eq!(
                edit.old_content.as_deref(),
                Some("line1\nline2\nold\nline4\nline5\n")
            );
            assert_eq!(
                edit.new_content.as_deref(),
                Some("line1\nline2\nnew\nline4\nline5\n")
            );
            assert_eq!(edit.old_start_line, Some(1));
            assert_eq!(edit.new_start_line, Some(1));
        }
        _ => panic!("Expected Edit variant"),
    }
}

#[test]
fn test_extract_apply_patch_normalizes_real_diff_segments() {
    let event = make_event(
        "apply_patch",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"patch_text": "*** Begin Patch\n*** End Patch"}),
        serde_json::json!({
            "content": "Patch applied successfully.",
            "diffString": "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA\n--- a/b.ts\n+++ b/b.ts\n@@ -5,1 +5,1 @@\n-oldB\n+newB",
            "linesAdded": 2,
            "linesRemoved": 2,
            "filePaths": ["a.ts", "b.ts"],
            "segments": [
                {
                    "filePath": "a.ts",
                    "diff": "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA",
                    "linesAdded": 1,
                    "linesRemoved": 1,
                    "isDeleted": false
                },
                {
                    "filePath": "b.ts",
                    "diff": "--- a/b.ts\n+++ b/b.ts\n@@ -5,1 +5,1 @@\n-oldB\n+newB",
                    "linesAdded": 1,
                    "linesRemoved": 1,
                    "isDeleted": false
                }
            ]
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(edit) => {
            assert_eq!(edit.apply_patch_segments.len(), 2);
            assert_eq!(
                edit.apply_patch_segments[0].old_content.as_deref(),
                Some("oldA")
            );
            assert_eq!(
                edit.apply_patch_segments[0].new_content.as_deref(),
                Some("newA")
            );
            assert_eq!(edit.apply_patch_segments[1].old_start_line, Some(5));
            assert_eq!(
                edit.apply_patch_segments[1].old_content.as_deref(),
                Some("oldB")
            );
            assert_eq!(
                edit.apply_patch_segments[1].new_content.as_deref(),
                Some("newB")
            );
        }
        _ => panic!("Expected Edit variant"),
    }
}

#[test]
fn test_extract_shell() {
    let event = make_event(
        "run_command_line",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"command": "npm install", "cwd": "/app"}),
        serde_json::json!({
            "output": {"success": {
                "command": "npm install",
                "stdout": "added 100 packages",
                "exitCode": 0,
                "executionTime": 3500.0
            }}
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Shell(s) => {
            assert_eq!(s.command, "npm install");
            assert_eq!(s.output.as_deref(), Some("added 100 packages"));
            assert_eq!(s.exit_code, Some(0));
            assert_eq!(s.cwd.as_deref(), Some("/app"));
            assert_eq!(s.execution_time, Some(3500.0));
            assert!(!s.is_failure);
        }
        _ => panic!("Expected Shell variant"),
    }
}

#[test]
fn test_extract_shell_failure() {
    let event = make_event(
        "run_command_line",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"command": "invalid-cmd"}),
        serde_json::json!({
            "failure": {
                "command": "invalid-cmd",
                "stderr": "command not found",
                "exitCode": 127
            }
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Shell(s) => {
            assert!(s.is_failure);
            assert_eq!(s.exit_code, Some(127));
        }
        _ => panic!("Expected Shell variant"),
    }
}

#[test]
fn test_extract_shell_uses_exact_process_exit_code_without_result_payload() {
    let event = make_event(
        "run_shell",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "command": "false",
            "shellProcessStatus": "exited",
            "shellExitCode": 1
        }),
        serde_json::json!({}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Shell(shell) => {
            assert_eq!(shell.command, "false");
            assert_eq!(shell.exit_code, Some(1));
            assert_eq!(shell.shell_process_status.as_deref(), Some("exited"));
            assert!(shell.output.is_none());
            assert!(shell.is_failure);
        }
        _ => panic!("Expected Shell variant"),
    }
}

#[test]
fn test_extract_search() {
    let event = SessionEvent {
        action_type: "grep".to_string(),
        ..make_event(
            "code_search",
            EventDisplayVariant::ToolCall,
            serde_json::json!({"query": "handleClick", "action": "grep"}),
            serde_json::json!({
                "matches": [
                    {"file": "src/Button.tsx", "line": 15, "content": "const handleClick = () => {"}
                ],
                "total": 5
            }),
        )
    };

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Search(s) => {
            assert_eq!(s.query, "handleClick");
            assert_eq!(s.results.len(), 1);
            assert_eq!(s.results[0].file, "src/Button.tsx");
            assert_eq!(s.total_matches, 5);
        }
        _ => panic!("Expected Search variant"),
    }
}

#[test]
fn test_extract_todo() {
    let event = make_event(
        "manage_todo",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"todos": [
            {"id": "1", "content": "Fix bug", "status": "completed"},
            {"id": "2", "content": "Write tests", "status": "pending"}
        ]}),
        serde_json::json!({}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Todo(t) => {
            assert_eq!(t.todos.len(), 2);
            assert_eq!(t.todos[0].content, "Fix bug");
            assert_eq!(t.todos[0].status, "completed");
            assert_eq!(t.todos[1].status, "pending");
        }
        _ => panic!("Expected Todo variant"),
    }
}

/// The native `manage_todo` tool's result is `{"content": "<header>\n[JSON
/// array]\n<nudge>"}` — `update`/`read` events carry NO `args.todos`, so the
/// extractor must parse the embedded snapshot from the LLM-facing text.
/// Regression pin for the simulator "updated to-dos / 0 items" bug.
#[test]
fn test_extract_todo_from_native_content_text() {
    let content = "Updated todo #1 — 2 todos (1 remaining)\n[\n  {\n    \"activeForm\": \"Fixing bug\",\n    \"content\": \"Fix bug\",\n    \"index\": 0,\n    \"priority\": \"high\",\n    \"status\": \"completed\"\n  },\n  {\n    \"activeForm\": null,\n    \"blockedBy\": [0],\n    \"content\": \"Write tests\",\n    \"index\": 1,\n    \"priority\": \"medium\",\n    \"status\": \"in_progress\"\n  }\n]\n\nEnsure that you continue to use the todo list to track your progress.";
    let event = make_event(
        "manage_todo",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"action": "update", "index": 1, "status": "in_progress"}),
        serde_json::json!({"content": content}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Todo(t) => {
            assert_eq!(t.todos.len(), 2);
            assert_eq!(t.todos[0].id, "0", "index backfills missing id");
            assert_eq!(t.todos[0].content, "Fix bug");
            assert_eq!(t.todos[0].active_form.as_deref(), Some("Fixing bug"));
            assert_eq!(t.todos[1].status, "in_progress");
            assert_eq!(t.todos[1].blocked_by, vec![0]);
            assert_eq!(t.todos[1].active_form, None, "null activeForm dropped");
        }
        _ => panic!("Expected Todo variant"),
    }
}

/// Structured `uiMetadata` (dual-track response) wins over every text
/// fallback and yields exact rows.
#[test]
fn test_extract_todo_prefers_ui_metadata() {
    let event = make_event(
        "manage_todo",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"action": "update", "index": 0}),
        serde_json::json!({
            "content": "garbled text without a parseable snapshot",
            "uiMetadata": {
                "display_type": "todo_list",
                "data": {"todos": [
                    {"index": 0, "content": "Ship feature", "status": "in_progress", "activeForm": "Shipping feature"}
                ]},
                "summary": "Updated todo #0 — 1 todos (1 remaining)"
            }
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Todo(t) => {
            assert_eq!(t.todos.len(), 1);
            assert_eq!(t.todos[0].id, "0");
            assert_eq!(t.todos[0].content, "Ship feature");
            assert_eq!(t.todos[0].active_form.as_deref(), Some("Shipping feature"));
        }
        _ => panic!("Expected Todo variant"),
    }
}

/// "No todos for this session." style outputs must yield an empty list, not
/// a parse error or phantom rows.
#[test]
fn test_extract_todo_no_snapshot_text_yields_empty() {
    let event = make_event(
        "manage_todo",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"action": "read"}),
        serde_json::json!({"content": "No todos for this session."}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Todo(t) => assert!(t.todos.is_empty()),
        _ => panic!("Expected Todo variant"),
    }
}

#[test]
fn test_extract_org_task_create() {
    let event = make_event(
        "task_create",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"subject": "Wire task block"}),
        serde_json::json!({"content": serde_json::json!({
            "task": {
                "id": "task-1",
                "subject": "Wire task block",
                "description": "Use Rust extracted data",
                "status": "pending",
                "owner_member_id": "member-1",
                "blocks": ["task-0"],
                "blocked_by": []
            },
            "owner_changed": true,
            "task_assigned_dispatched": true
        }).to_string()}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.action, "create");
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Succeeded);
            assert_eq!(org_task.total, Some(1));
            assert_eq!(org_task.owner_changed, Some(true));
            assert_eq!(org_task.task_assigned_dispatched, Some(true));
            let task = org_task.task.expect("expected task payload");
            assert_eq!(task.id, "task-1");
            assert_eq!(task.subject.as_deref(), Some("Wire task block"));
            assert_eq!(task.description.as_deref(), Some("Use Rust extracted data"));
            assert_eq!(task.owner.as_deref(), Some("member-1"));
            assert_eq!(task.blocks, vec!["task-0".to_string()]);
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_graph_create_through_top_level_dispatch() {
    let event = make_event(
        "task_graph_create",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "tasks": [
                {"temp_id": "draft", "subject": "Draft implementation"},
                {
                    "temp_id": "review",
                    "subject": "Review implementation",
                    "blocked_by_temp_ids": ["draft"]
                }
            ]
        }),
        serde_json::json!({"content": serde_json::json!({
            "created": true,
            "tasks": [
                {
                    "id": "task-1",
                    "subject": "Draft implementation",
                    "status": "pending",
                    "blocked_by": []
                },
                {
                    "id": "task-2",
                    "subject": "Review implementation",
                    "status": "pending",
                    "blocked_by": ["task-1"]
                }
            ],
            "total": 2,
            "org_run_id": "run-1"
        }).to_string()}),
    );

    let data = extract_event_data(&event).expect("graph tool should be extracted");
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.action, "create");
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Succeeded);
            assert_eq!(org_task.total, Some(2));
            assert_eq!(org_task.org_run_id.as_deref(), Some("run-1"));
            assert_eq!(org_task.tasks.len(), 2);
            assert_eq!(org_task.tasks[1].blocked_by, vec!["task-1".to_string()]);
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_create_from_args_without_result() {
    let mut event = make_event(
        "task_create",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "id": "task-args",
            "subject": "Render running task",
            "description": "Use args before result arrives",
            "owner_member_id": "member-args",
            "status": "pending"
        }),
        serde_json::json!(null),
    );
    event.display_status = EventDisplayStatus::Running;

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.action, "create");
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Pending);
            let task = org_task.task.expect("expected args-backed task payload");
            assert_eq!(task.id, "task-args");
            assert_eq!(task.subject.as_deref(), Some("Render running task"));
            assert_eq!(task.owner.as_deref(), Some("member-args"));
            assert_eq!(task.status.as_deref(), Some("pending"));
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_rejected_create_keeps_attempt_for_history() {
    let event = make_event(
        "task_create",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "subject": "Verify final output",
            "owner_member_id": "sde-tester",
            "status": "pending"
        }),
        serde_json::json!({
            "created": false,
            "requires_dependency_confirmation": true,
            "guidance": "Add the omitted reviewer dependency."
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Rejected);
            assert_eq!(
                org_task.guidance.as_deref(),
                Some("Add the omitted reviewer dependency.")
            );
            let task = org_task
                .task
                .expect("attempted task should render in history");
            assert_eq!(task.subject.as_deref(), Some("Verify final output"));
            assert_eq!(task.owner.as_deref(), Some("sde-tester"));
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_structured_non_mutations_are_rejected() {
    let rejected_results = [
        serde_json::json!({ "rejected": true, "rejection_code": "lifecycle_owner_only" }),
        serde_json::json!({ "authorization_denied": true }),
        serde_json::json!({ "already_exists": true }),
        serde_json::json!({ "status_ignored": true }),
        serde_json::json!({ "deleted": false }),
    ];

    for result in rejected_results {
        let event = make_event(
            "task_update",
            EventDisplayVariant::ToolCall,
            serde_json::json!({
                "id": "task-1",
                "status": "completed"
            }),
            result,
        );

        let data = extract_event_data(&event).unwrap();
        match data {
            ExtractedData::OrgTask(org_task) => {
                assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Rejected);
            }
            _ => panic!("Expected OrgTask variant"),
        }
    }
}

#[test]
fn test_extract_org_task_legacy_invalid_params_is_recoverable_rejection() {
    let message = "Error executing task_update: Invalid parameters: parameter validation failed: missing field `summary`";
    let mut event = make_event(
        "task_update",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "id": "task-needs-summary",
            "status": "completed",
            "output": { "content": "Full result" }
        }),
        serde_json::json!({
            "content": message,
            "observation": message
        }),
    );
    event.display_status = EventDisplayStatus::Failed;

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Rejected);
            assert!(org_task
                .guidance
                .as_deref()
                .is_some_and(|guidance| guidance.contains("non-empty summary")));
            assert_eq!(org_task.error_message.as_deref(), Some(message));
            assert_eq!(
                org_task.task.expect("args-backed task").id,
                "task-needs-summary"
            );
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_failed_create_is_not_successful() {
    let event = make_event(
        "task_create",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "subject": "Invalid dependency task",
            "owner_member_id": "sde-tester",
            "status": "pending"
        }),
        serde_json::json!({
            "content": "Error executing task_create: dependency task does not exist",
            "observation": "Error executing task_create: dependency task does not exist"
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Failed);
            assert_eq!(
                org_task.error_message.as_deref(),
                Some("Error executing task_create: dependency task does not exist")
            );
            assert!(org_task.task.is_some());
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_org_task_list() {
    let event = make_event(
        "task_list",
        EventDisplayVariant::ToolCall,
        serde_json::json!({}),
        serde_json::json!({"content": serde_json::json!({
            "tasks": [
                {"id": "task-1", "subject": "First", "status": "completed"},
                {"id": "task-2", "subject": "Second", "status": "pending"}
            ],
            "total": 2,
            "org_run_id": "run-1"
        }).to_string()}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::OrgTask(org_task) => {
            assert_eq!(org_task.action, "list");
            assert_eq!(org_task.outcome, OrgTaskOperationOutcome::Succeeded);
            assert_eq!(org_task.total, Some(2));
            assert_eq!(org_task.org_run_id.as_deref(), Some("run-1"));
            assert_eq!(org_task.tasks.len(), 2);
            assert_eq!(org_task.tasks[0].subject.as_deref(), Some("First"));
            assert_eq!(org_task.tasks[1].status.as_deref(), Some("pending"));
        }
        _ => panic!("Expected OrgTask variant"),
    }
}

#[test]
fn test_extract_subagent() {
    let event = make_event(
        "subagent",
        EventDisplayVariant::ToolCall,
        serde_json::json!({
            "description": "Explore the auth module",
            "subagent_type": "explorer"
        }),
        serde_json::json!({"content": "done", "success": true}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Subagent(s) => {
            assert_eq!(s.description, "Explore the auth module");
            assert_eq!(s.subagent_type, "explorer");
            assert_eq!(s.result_content, "done");
            assert!(s.success);
        }
        _ => panic!("Expected Subagent variant"),
    }
}

#[test]
fn test_session_start_returns_none() {
    let event = SessionEvent {
        display_variant: EventDisplayVariant::Session,
        args: serde_json::json!({"model": "claude-4", "cwd": "/project"}),
        ..make_event(
            "session_start",
            EventDisplayVariant::Session,
            serde_json::json!({}),
            serde_json::json!({}),
        )
    };

    assert!(extract_event_data(&event).is_none());
}

#[test]
fn test_extract_message() {
    let event = SessionEvent {
        display_variant: EventDisplayVariant::Message,
        source: EventSource::User,
        result: serde_json::json!({"content": "Fix the login page"}),
        ..make_event(
            "message",
            EventDisplayVariant::Message,
            serde_json::json!({}),
            serde_json::json!({}),
        )
    };

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Message(m) => {
            assert!(m.is_user);
            assert_eq!(m.content.as_deref(), Some("Fix the login page"));
        }
        _ => panic!("Expected Message variant"),
    }
}

#[test]
fn test_language_detection() {
    assert_eq!(detect_language("main.rs"), "rust");
    assert_eq!(detect_language("app.tsx"), "typescript");
    assert_eq!(detect_language("script.py"), "python");
    assert_eq!(detect_language("Makefile"), "plaintext");
    assert_eq!(detect_language("data.json"), "json");
    assert_eq!(detect_language("styles.scss"), "scss");
}

#[test]
fn test_extract_await() {
    let event = make_event(
        "await_output",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"handle": "job-123", "block_until_ms": 5000}),
        serde_json::json!({"output": "build finished successfully"}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Await(a) => {
            assert_eq!(a.handle.as_deref(), Some("job-123"));
            assert_eq!(a.block_until_ms, Some(5000));
            assert_eq!(
                a.result_text.as_deref(),
                Some("build finished successfully")
            );
        }
        _ => panic!("Expected Await variant"),
    }
}

#[test]
fn test_extract_list_dir() {
    let event = make_event(
        "list_dir",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"target_directory": "/proj/src"}),
        serde_json::json!({
            "entries": [
                {"name": "main.rs", "is_directory": false},
                {"name": "lib", "is_directory": true}
            ]
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::ListDir(l) => {
            assert_eq!(l.directory, "/proj/src");
            assert_eq!(l.entries.len(), 2);
            assert_eq!(l.entries[0].name, "main.rs");
            assert!(!l.entries[0].is_directory);
            assert!(l.entries[1].is_directory);
        }
        _ => panic!("Expected ListDir variant"),
    }
}

#[test]
fn test_extract_glob() {
    let event = SessionEvent {
        action_type: "find_files".to_string(),
        ..make_event(
            "code_search",
            EventDisplayVariant::ToolCall,
            serde_json::json!({"pattern": "src/**/*.rs", "action": "find_files"}),
            serde_json::json!({
                "files": ["src/main.rs", "src/lib.rs", "src/util/mod.rs"]
            }),
        )
    };

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Glob(g) => {
            assert_eq!(g.pattern, "src/**/*.rs");
            assert_eq!(g.files.len(), 3);
            assert_eq!(g.total_files, 3);
        }
        _ => panic!("Expected Glob variant"),
    }
}

#[test]
fn test_extract_web_search() {
    let event = make_event(
        "web_search",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"query": "rust async book"}),
        serde_json::json!({
            "results": [
                {"title": "Async Book", "url": "https://rust-lang.github.io/async-book/", "snippet": "Official async/await guide"},
                {"title": "Tokio", "url": "https://tokio.rs", "snippet": "Async runtime"}
            ]
        }),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::WebSearch(w) => {
            assert_eq!(w.query, "rust async book");
            assert_eq!(w.results.len(), 2);
            assert_eq!(w.results[0].title, "Async Book");
            assert_eq!(w.results[1].url, "https://tokio.rs");
        }
        _ => panic!("Expected WebSearch variant"),
    }
}

#[test]
fn test_extract_delete_file() {
    let event = SessionEvent {
        action_type: "delete".to_string(),
        ..make_event(
            "delete_file",
            EventDisplayVariant::ToolCall,
            serde_json::json!({"path": "/proj/old.rs", "action": "delete"}),
            serde_json::json!({"success": true}),
        )
    };

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::DeleteFile(d) => {
            assert_eq!(d.file_path, "/proj/old.rs");
            assert_eq!(d.file_name, "old.rs");
        }
        _ => panic!("Expected DeleteFile variant"),
    }
}

#[test]
fn test_extract_apply_patch_single_file() {
    let patch = "*** Begin Patch\n*** Add File: src/new.rs\n+fn main() {}\n*** End Patch";
    let event = make_event(
        "apply_patch",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"patch_text": patch}),
        serde_json::json!({}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(e) => {
            // Single-file patch: segments vec stays empty; file_path routed from patch.
            assert!(e.apply_patch_segments.is_empty());
            assert_eq!(e.file_path, "src/new.rs");
            assert_eq!(e.file_name, "new.rs");
        }
        _ => panic!("Expected Edit variant"),
    }
}

#[test]
fn test_extract_apply_patch_accepts_patch_arg() {
    let patch = "*** Begin Patch\n*** Update File: src/app.rs\n@@\n-old\n+new\n*** End Patch";
    let event = make_event(
        "apply_patch",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"patch": patch}),
        serde_json::json!({}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(e) => {
            assert_eq!(e.file_path, "src/app.rs");
            assert_eq!(e.file_name, "app.rs");
            assert_eq!(e.lines_added, Some(1));
            assert_eq!(e.lines_removed, Some(1));
            assert_eq!(e.old_start_line, None);
            assert_eq!(e.new_start_line, None);
            assert!(e.diff.as_deref().unwrap_or_default().contains("+new"));
        }
        _ => panic!("Expected Edit variant"),
    }
}

#[test]
fn test_extract_apply_patch_preserves_explicit_hunk_line_range() {
    let patch = "*** Begin Patch\n*** Update File: src/app.rs\n@@ -42,2 +43,2 @@\n-old\n+new\n*** End Patch";
    let event = make_event(
        "apply_patch",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"patch": patch}),
        serde_json::json!({}),
    );

    let data = extract_event_data(&event).unwrap();
    match data {
        ExtractedData::Edit(e) => {
            assert_eq!(e.file_path, "src/app.rs");
            assert_eq!(e.old_start_line, Some(42));
            assert_eq!(e.new_start_line, Some(43));
            assert!(e
                .diff
                .as_deref()
                .unwrap_or_default()
                .contains("@@ -42,2 +43,2 @@"));
        }
        _ => panic!("Expected Edit variant"),
    }
}

// ============================================================================
// Debounce / recompute behavior
// ============================================================================

#[test]
fn test_extracted_data_serialization_shape() {
    // Wire format must be `{kind: "file", filePath: "...", ...}`
    // (serde tag = "kind", rename_all = "camelCase"). Frontend depends on this shape.
    let data = ExtractedData::File(
        crate::agent_sessions::event_pipeline::extractors::types::ExtractedFileData {
            file_path: "/a.rs".to_string(),
            file_name: "a.rs".to_string(),
            content: None,
            language: "rust".to_string(),
            line_count: None,
            start_line: None,
        },
    );
    let json = serde_json::to_string(&data).unwrap();
    assert!(json.contains("\"kind\":\"file\""), "got: {}", json);
    assert!(json.contains("\"filePath\":\"/a.rs\""), "got: {}", json);
    assert!(json.contains("\"language\":\"rust\""), "got: {}", json);
}

#[test]
fn test_recompute_extracted_sets_timestamp() {
    super::super::register_extractor_hook();
    let mut event = make_event(
        "read_file",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"file_path": "/a.rs"}),
        serde_json::json!({"content": "fn main() {}"}),
    );
    assert!(event.extracted.is_none());
    assert!(event.last_extract_at.is_none());

    crate::agent_sessions::event_pipeline::extractors::register_extractor_hook();
    event.recompute_extracted();

    assert!(event.extracted.is_some());
    assert!(event.last_extract_at.is_some());
}

#[test]
fn test_status_change_forces_recompute() {
    use crate::agent_sessions::event_pipeline::types::SessionEventPatch;

    super::super::register_extractor_hook();
    let mut event = make_event(
        "run_shell",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"command": "echo hi"}),
        serde_json::json!({}),
    );
    event.display_status = EventDisplayStatus::Running;
    crate::agent_sessions::event_pipeline::extractors::register_extractor_hook();
    event.recompute_extracted();
    let stamp_before = event.last_extract_at;

    // Status change — should force recompute regardless of debounce window.
    let patch = SessionEventPatch {
        display_status: Some(EventDisplayStatus::Completed),
        result: Some(
            serde_json::json!({"output": {"success": {"command": "echo hi", "stdout": "hi", "exitCode": 0}}}),
        ),
        ..Default::default()
    };
    patch.apply_to(&mut event);

    assert!(event.last_extract_at > stamp_before);
    assert!(matches!(event.extracted, Some(ExtractedData::Shell(_))));
}

#[test]
fn test_debounce_skips_rapid_payload_updates() {
    use crate::agent_sessions::event_pipeline::types::SessionEventPatch;

    super::super::register_extractor_hook();
    let mut event = make_event(
        "run_shell",
        EventDisplayVariant::ToolCall,
        serde_json::json!({"command": "long"}),
        serde_json::json!({}),
    );
    event.display_status = EventDisplayStatus::Running;
    event.recompute_extracted();
    let stamp_before = event.last_extract_at;

    // Payload-only patch within the debounce window — should NOT recompute.
    let patch = SessionEventPatch {
        args: Some(serde_json::json!({"command": "long", "extra": 1})),
        ..Default::default()
    };
    patch.apply_to(&mut event);

    assert_eq!(event.last_extract_at, stamp_before);
}

#[test]
fn test_batch_extract() {
    let events = vec![
        make_event(
            "read_file",
            EventDisplayVariant::ToolCall,
            serde_json::json!({"file_path": "/a.rs"}),
            serde_json::json!({"content": "data"}),
        ),
        SessionEvent {
            display_variant: EventDisplayVariant::Thinking,
            result: serde_json::json!({"thought": "hmm"}),
            ..make_event(
                "thinking",
                EventDisplayVariant::Thinking,
                serde_json::json!({}),
                serde_json::json!({}),
            )
        },
    ];

    let batch = extract_batch(&events);
    assert_eq!(batch.len(), 2);
}

// ============================================================================
// strip_line_number_prefixes_pub — keep in sync with
// foundation/tool_infra/file.rs::format_text_result, which emits
// `{:>6}│{}` today. Legacy events emitted `→` as separator.
// ============================================================================

#[test]
fn strip_line_prefixes_current_box_separator() {
    let input = "     1│import React from 'react';\n     2│\n     3│export default App;";
    let stripped = strip_line_number_prefixes_pub(input);
    assert_eq!(
        stripped,
        "import React from 'react';\n\nexport default App;"
    );
}

#[test]
fn strip_line_prefixes_legacy_arrow_separator() {
    let input = "  1→import React from 'react';\n  2→\n  3→export default App;";
    let stripped = strip_line_number_prefixes_pub(input);
    assert_eq!(
        stripped,
        "import React from 'react';\n\nexport default App;"
    );
}

#[test]
fn strip_line_prefixes_leaves_plain_content_untouched() {
    let input = "const x = 1;\nconst y = 2;";
    assert_eq!(strip_line_number_prefixes_pub(input), input);
}

#[test]
fn strip_line_prefixes_leaves_unrelated_box_chars_untouched() {
    // First non-empty line does not start with digits → don't touch anything,
    // even if later lines contain `│` incidentally.
    let input = "fn main() {\n    println!(\"│\");\n}";
    assert_eq!(strip_line_number_prefixes_pub(input), input);
}

#[test]
fn strip_line_prefixes_removes_action_marker_with_numbered_body() {
    // Real shape produced by `read_file` (coding/files.rs::classify_read_action):
    // a single `[action: ...]` marker line followed by numbered content.
    let input = "[action: read_text]\n     1│/**\n     2│ * useServiceAuth Hook\n     3│ */";
    let stripped = strip_line_number_prefixes_pub(input);
    assert_eq!(stripped, "/**\n * useServiceAuth Hook\n */");
}

#[test]
fn strip_line_prefixes_removes_action_marker_even_without_numbered_body() {
    // `read_image` and `read_pdf` actions don't have line numbers but still
    // carry the marker line that must not reach the renderer.
    let input = "[action: read_image]\nImage: foo.png (image/png, 12kb)";
    let stripped = strip_line_number_prefixes_pub(input);
    assert_eq!(stripped, "Image: foo.png (image/png, 12kb)");
}

#[test]
fn strip_line_prefixes_with_start_reports_ranged_read_offset() {
    use super::super::lang::strip_line_number_prefixes_with_start;

    // Ranged read starting at line 120 — gutters must keep real line numbers.
    let input = "[action: read_text]\n   120│fn main() {\n   121│}";
    let (stripped, start) = strip_line_number_prefixes_with_start(input);
    assert_eq!(stripped, "fn main() {\n}");
    assert_eq!(start, Some(120));

    // Read from the top → start is 1.
    let from_top = "     1│a\n     2│b";
    let (_, start_top) = strip_line_number_prefixes_with_start(from_top);
    assert_eq!(start_top, Some(1));

    // Plain content → no start line.
    let (_, none) = strip_line_number_prefixes_with_start("const x = 1;");
    assert_eq!(none, None);
}
