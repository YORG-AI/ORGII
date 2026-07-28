use super::*;

fn add_event_with_legacy_projection(
    acc: &mut TurnMetadataAccumulator,
    function_name: Option<&str>,
    args_json: &str,
    result_json: &str,
    occurred_at: &str,
) {
    let Some(function_name) = function_name else {
        return;
    };
    let args = serde_json::from_str::<Value>(args_json).unwrap_or(Value::Null);
    let result = serde_json::from_str::<Value>(result_json).unwrap_or(Value::Null);
    let outcome = interaction_outcome_from_tool_result(&result);

    for interaction in file_interactions_from_tool(function_name, &args, Some(&result)) {
        acc.merge_resource_interaction(
            interaction.file_path,
            interaction.action,
            outcome,
            occurred_at,
        );
    }
    if outcome != ResourceInteractionOutcome::Failed {
        for change in extract_event_files(function_name, &args, &result) {
            acc.merge_modified_file(change);
        }
    }
    for artifact in parse_git_artifacts_from_tool_payload(args_json, result_json) {
        acc.merge_artifact(artifact);
    }
}

#[test]
fn projection_requirements_short_circuit_only_known_safe_tool_classes() {
    for name in [
        "user_message",
        "assistant",
        "assistant_message",
        "thinking",
        "reasoning",
        "node_repl",
    ] {
        assert!(
            metadata_projection_requirements(Some(name)).is_empty(),
            "{name} should not load metadata payloads"
        );
    }

    let grep = metadata_projection_requirements(Some("Grep"));
    assert!(grep.needs_args_json());
    assert!(!grep.needs_result_json());
    assert!(grep.projects_resource_interactions());
    assert!(!grep.projects_modified_files());
    assert!(!grep.projects_git_artifacts());

    let read = metadata_projection_requirements(Some("Read"));
    assert!(read.needs_args_json());
    assert!(read.needs_result_json());
    assert!(read.projects_resource_interactions());
    assert!(!read.projects_modified_files());
    assert!(!read.projects_git_artifacts());

    let edit = metadata_projection_requirements(Some("edit_file"));
    assert!(edit.projects_resource_interactions());
    assert!(edit.projects_modified_files());
    assert!(!edit.projects_git_artifacts());

    let bash = metadata_projection_requirements(Some("Bash"));
    assert!(!bash.projects_resource_interactions());
    assert!(!bash.projects_modified_files());
    assert!(bash.projects_git_artifacts());

    let future_tool = metadata_projection_requirements(Some("future_provider_tool"));
    assert!(future_tool.needs_args_json());
    assert!(future_tool.needs_result_json());
    assert!(future_tool.projects_resource_interactions());
    assert!(future_tool.projects_modified_files());
    assert!(future_tool.projects_git_artifacts());
}

#[test]
fn typed_projection_matches_legacy_metadata_for_representative_events() {
    let events = [
        (
            "Read",
            r#"{"file_path":"src/lib.rs"}"#,
            "{}",
            "2026-07-15T00:00:01Z",
        ),
        (
            "edit_file",
            r#"{"file_path":"src/lib.rs","new_string":"one\ntwo"}"#,
            r#"{"success":{"linesAdded":2,"linesRemoved":1}}"#,
            "2026-07-15T00:00:02Z",
        ),
        (
            "Grep",
            r#"{"path":"src"}"#,
            r#"{"matches":[{"file":"src/main.rs"}]}"#,
            "2026-07-15T00:00:03Z",
        ),
        (
            "Bash",
            r#"{"command":"git commit -m metadata"}"#,
            r#"{"success":{"command":"git commit -m metadata","stdout":"[feature abc1234] metadata","exitCode":0}}"#,
            "2026-07-15T00:00:04Z",
        ),
        (
            "future_provider_tool",
            r#"{"command":"gh pr create"}"#,
            r#"{"output":"https://github.com/acme/repo/pull/42"}"#,
            "2026-07-15T00:00:05Z",
        ),
    ];
    let mut legacy = TurnMetadataAccumulator::new();
    let mut typed = TurnMetadataAccumulator::new();
    for (name, args, result, occurred_at) in events {
        add_event_with_legacy_projection(&mut legacy, Some(name), args, result, occurred_at);
        typed.add_event_at(Some(name), args, result, occurred_at);
    }

    assert_eq!(typed.modified_files(), legacy.modified_files());
    assert_eq!(
        typed.resource_interactions(),
        legacy.resource_interactions()
    );
    assert_eq!(
        serde_json::to_value(typed.git_artifacts()).unwrap(),
        serde_json::to_value(legacy.git_artifacts()).unwrap()
    );
}

#[test]
fn ignores_read_only_and_unknown_tools() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(Some("read_file"), r#"{"file_path":"a.rs"}"#, "{}");
    acc.add_event(None, "{}", "{}");
    assert!(acc.files().is_empty());
}

#[test]
fn edit_file_extracts_path_and_line_stats() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("edit_file"),
        r#"{"file_path":"src/foo.rs"}"#,
        r#"{"success":{"linesAdded":3,"linesRemoved":1}}"#,
    );
    let files = acc.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "src/foo.rs");
    assert_eq!(files[0].file_name, "foo.rs");
    assert_eq!(files[0].status, "modified");
    assert_eq!(files[0].additions, 3);
    assert_eq!(files[0].deletions, 1);
}

#[test]
fn create_and_delete_status_mapping() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(Some("create_file"), r#"{"file_path":"new.ts"}"#, "{}");
    acc.add_event(Some("delete_file"), r#"{"file_path":"old.ts"}"#, "{}");
    let files = acc.files();
    assert_eq!(files[0].status, "created");
    assert_eq!(files[1].status, "deleted");
}

#[test]
fn file_name_supports_provider_paths_from_both_platforms() {
    assert_eq!(file_name_for("src/lib.rs"), "lib.rs");
    assert_eq!(file_name_for(r"C:\repo\src\lib.rs"), "lib.rs");
}

#[test]
fn create_file_falls_back_to_content_line_count() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("create_file"),
        r#"{"file_path":"note.md","content":"one\ntwo\nthree"}"#,
        "{}",
    );
    let files = acc.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, "created");
    assert_eq!(files[0].additions, 3);
    assert_eq!(files[0].deletions, 0);
}

#[test]
fn duplicate_path_merges_and_sums() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("edit_file"),
        r#"{"file_path":"a.rs"}"#,
        r#"{"linesAdded":2,"linesRemoved":0}"#,
    );
    acc.add_event(
        Some("edit_file"),
        r#"{"file_path":"a.rs"}"#,
        r#"{"linesAdded":5,"linesRemoved":3}"#,
    );
    let files = acc.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].additions, 7);
    assert_eq!(files[0].deletions, 3);
}

#[test]
fn error_result_is_skipped() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("edit_file"),
        r#"{"file_path":"a.rs"}"#,
        r#"{"content":"Error: permission denied"}"#,
    );
    assert!(acc.files().is_empty());
}

#[test]
fn apply_patch_uses_segments() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("apply_patch"),
        r#"{"patch_text":"*** Update File: a.rs\n"}"#,
        r#"{"segments":[
                {"filePath":"a.rs","linesAdded":4,"linesRemoved":1},
                {"filePath":"b.rs","isDeleted":true}
            ]}"#,
    );
    let files = acc.files();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "a.rs");
    assert_eq!(files[0].additions, 4);
    assert_eq!(files[1].path, "b.rs");
    assert_eq!(files[1].status, "deleted");
}

#[test]
fn apply_patch_falls_back_to_patch_text_with_line_stats() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
            Some("apply_patch"),
            r#"{"patch_text":"*** Add File: x.rs\n+one\n+two\n*** Update File: y.rs\n-old\n+new\n context\n"}"#,
            "{}",
        );
    let files = acc.files();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["x.rs", "y.rs"]);
    assert_eq!(files[0].additions, 2);
    assert_eq!(files[0].deletions, 0);
    assert_eq!(files[1].additions, 1);
    assert_eq!(files[1].deletions, 1);
}

#[test]
fn apply_patch_prefers_patch_text_stats_over_file_paths() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
        Some("apply_patch"),
        r#"{"patch_text":"*** Update File: a.rs\n-old\n+new\n+extra\n"}"#,
        r#"{"filePaths":["a.rs"]}"#,
    );
    let files = acc.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.rs");
    assert_eq!(files[0].additions, 2);
    assert_eq!(files[0].deletions, 1);
}

#[test]
fn normalized_codex_edit_file_keeps_apply_patch_line_stats() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
            Some("edit_file_by_replace"),
            r#"{"action":"apply_patch","patch_text":"*** Update File: src/app.ts\n-old\n+new\n+extra\n"}"#,
            r#"{"filePaths":["src/app.ts"]}"#,
        );

    let files = acc.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "src/app.ts");
    assert_eq!(files[0].additions, 2);
    assert_eq!(files[0].deletions, 1);
}

#[test]
fn malformed_json_is_tolerated() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(Some("edit_file"), "{not json", "{also not json");
    assert!(acc.files().is_empty());
}

#[test]
fn folds_read_metadata_and_drops_searches_across_provider_tool_names() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event_at(
        Some("Read"),
        r#"{"file_path":"src/lib.rs"}"#,
        "{}",
        "2026-07-15T00:00:01Z",
    );
    acc.add_event_at(
        Some("Grep"),
        r#"{"path":"src"}"#,
        r#"{"matches":[{"file":"src/lib.rs"},{"path":"src/main.rs"}]}"#,
        "2026-07-15T00:00:02Z",
    );

    // search-rows: only the read survives — the Grep contributes neither its
    // queried path nor the paths named in its matches.
    let interactions = acc.resource_interactions();
    assert_eq!(interactions.len(), 1);
    assert!(interactions.iter().any(|item| {
        item.path == "src/lib.rs"
            && item.action == ResourceAction::Read
            && item.outcome == ResourceInteractionOutcome::Succeeded
    }));
    assert!(!interactions
        .iter()
        .any(|item| item.action == ResourceAction::Search));
}

#[test]
fn records_failed_observation_but_does_not_claim_a_modification() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event_at(
        Some("replace"),
        r#"{"file_path":"src/lib.rs","new_string":"replacement"}"#,
        r#"{"content":"Error: permission denied"}"#,
        "2026-07-15T00:00:03Z",
    );

    assert!(acc.modified_files().is_empty());
    assert_eq!(acc.resource_interactions().len(), 1);
    assert_eq!(
        acc.resource_interactions()[0].outcome,
        ResourceInteractionOutcome::Failed
    );
}

#[test]
fn shell_artifacts_are_projected_without_host_tool_constants() {
    let mut acc = TurnMetadataAccumulator::new();
    acc.add_event(
            Some("Bash"),
            r#"{"command":"git commit -m metadata"}"#,
            r#"{"success":{"command":"git commit -m metadata","stdout":"[feature abc1234] metadata","exitCode":0}}"#,
        );

    assert_eq!(acc.git_artifacts().len(), 1);
    assert_eq!(acc.git_artifacts()[0].sha.as_deref(), Some("abc1234"));
}

#[test]
fn imported_activity_projection_uses_user_messages_not_execution_threads() {
    let mut first_user = ActivityChunk::new("session-1", "raw", "user_message");
    first_user.chunk_id = "user-1".to_string();
    first_user.created_at = "2026-07-15T00:00:00Z".to_string();
    first_user.args = serde_json::json!({"content": "inspect the code"});
    let mut read = ActivityChunk::new("session-1", "tool_call", "Read");
    read.chunk_id = "read-1".to_string();
    read.thread_id = Some("subagent-9".to_string());
    read.created_at = "2026-07-15T00:00:01Z".to_string();
    read.args = serde_json::json!({"file_path": "src/lib.rs"});
    let mut second_user = ActivityChunk::new("session-1", "raw", "user_message");
    second_user.chunk_id = "user-2".to_string();
    second_user.created_at = "2026-07-15T00:01:00Z".to_string();
    second_user.args = serde_json::json!({"content": "now edit it"});
    let mut edit = ActivityChunk::new("session-1", "tool_call", "replace");
    edit.chunk_id = "edit-1".to_string();
    edit.thread_id = Some("subagent-10".to_string());
    edit.created_at = "2026-07-15T00:01:01Z".to_string();
    edit.args = serde_json::json!({
        "file_path": "src/lib.rs",
        "old_string": "old",
        "new_string": "new"
    });

    let rounds = project_activity_chunks(&[first_user, read, second_user, edit]);

    assert_eq!(rounds.len(), 2);
    assert_eq!(rounds[0].turn_id, "user-1");
    assert_eq!(rounds[1].turn_id, "user-2");
    assert_eq!(
        rounds[0].resource_interactions[0].action,
        ResourceAction::Read
    );
    assert_eq!(rounds[1].modified_files[0].path, "src/lib.rs");
}

#[test]
fn lifecycle_markers_keep_active_tail_pending_until_completion() {
    let mut user = ActivityChunk::new("session-1", "raw", "user_message");
    user.chunk_id = "user-1".to_string();
    user.created_at = "2026-07-15T00:00:00Z".to_string();
    user.args = serde_json::json!({"content": "edit it"});
    let mut start = ActivityChunk::new("session-1", "task_start", "task_start");
    start.created_at = "2026-07-15T00:00:00Z".to_string();
    let mut edit = ActivityChunk::new("session-1", "tool_call", "edit_file");
    edit.created_at = "2026-07-15T00:00:01Z".to_string();
    edit.args = serde_json::json!({"file_path": "src/lib.rs", "content": "new"});

    let active = project_activity_chunks(&[user.clone(), start.clone(), edit.clone()]);
    assert_eq!(active[0].status, "pending");
    assert_eq!(active[0].ended_at, None);

    let mut complete = ActivityChunk::new("session-1", "task_completed", "task_completed");
    complete.created_at = "2026-07-15T00:00:02Z".to_string();
    let completed = project_activity_chunks(&[user, start, edit, complete]);
    assert_eq!(completed[0].status, "completed");
    assert_eq!(
        completed[0].ended_at.as_deref(),
        Some("2026-07-15T00:00:02Z")
    );
    assert_eq!(completed[0].event_count, 2);
}
