use super::*;
use serde_json::json;

#[test]
fn claude_read_keeps_exact_subagent_attribution_without_raw_output() {
    let envelopes = normalize_hook_payload(
        HookSource::ClaudeCode,
        &json!({
            "session_id": "session-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_use_id": "tool-1",
            "agent_id": "agent-1",
            "tool_input": {"file_path": "/repo/src/lib.rs"},
            "tool_response": {"content": "secret file contents"}
        }),
    )
    .expect("normalize Claude hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].session_id, "claudecodeapp-session-1");
    assert_eq!(envelopes[0].actor_id.as_deref(), Some("agent-1"));
    assert_eq!(envelopes[0].action, ResourceAction::Read);
    assert_eq!(
        envelopes[0].attribution_precision,
        AttributionPrecision::Exact
    );
    let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
    assert!(!serialized.contains("secret file contents"));
}

#[test]
fn qwen_replace_normalizes_to_a_write_without_raw_output() {
    let envelopes = normalize_hook_payload(
        HookSource::QwenCode,
        &json!({
            "session_id": "qwen-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            // Gemini-family in-place edit tool.
            "tool_name": "replace",
            "tool_use_id": "tool-9",
            "tool_input": {
                "file_path": "/repo/src/main.rs",
                "old_string": "secret before",
                "new_string": "secret after"
            },
            "tool_response": {"output": "diff with secret contents"}
        }),
    )
    .expect("normalize Qwen hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "qwen_code");
    assert_eq!(envelopes[0].session_id, "qwencodeapp-qwen-1");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
    let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
    assert!(!serialized.contains("secret"));
}

#[test]
fn factory_droid_create_preserves_the_create_action() {
    let envelopes = normalize_hook_payload(
        HookSource::FactoryDroid,
        &json!({
            "session_id": "droid-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "Create",
            "tool_use_id": "tool-7",
            "tool_input": {"file_path": "/repo/src/new.rs"}
        }),
    )
    .expect("normalize Droid hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "droid");
    assert_eq!(envelopes[0].session_id, "droidapp-droid-1");
    assert_eq!(envelopes[0].action, ResourceAction::Create);
    assert_eq!(envelopes[0].file_path, "/repo/src/new.rs");
}

#[test]
fn opencode_edit_normalizes_to_a_write_with_camelcase_path() {
    let envelopes = normalize_hook_payload(
        HookSource::OpenCode,
        &json!({
            "session_id": "ses_abc",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "edit",
            "tool_use_id": "call_1",
            "tool_input": {"filePath": "/repo/src/main.rs", "oldString": "a", "newString": "b"},
            "output": {"output": "secret diff output"}
        }),
    )
    .expect("normalize OpenCode hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "opencode");
    assert_eq!(envelopes[0].session_id, "opencodeapp-ses_abc");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
    assert_eq!(envelopes[0].file_path, "/repo/src/main.rs");
    let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
    assert!(!serialized.contains("secret"));
}

#[test]
fn trae_edit_normalizes_to_a_write() {
    let envelopes = normalize_hook_payload(
        HookSource::Trae,
        &json!({
            "session_id": "trae-1",
            "cwd": "/repo",
            "workspace_roots": ["/repo"],
            "hook_event_name": "PostToolUse",
            "tool_name": "EditFile",
            "tool_use_id": "t1",
            "tool_input": {"file_path": "/repo/src/lib.rs"}
        }),
    )
    .expect("normalize Trae hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "trae");
    assert_eq!(envelopes[0].session_id, "traeapp-trae-1");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
}

#[test]
fn kimi_str_replace_normalizes_to_a_write() {
    let envelopes = normalize_hook_payload(
        HookSource::Kimi,
        &json!({
            "session_id": "kimi-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "StrReplaceFile",
            "tool_input": {"file_path": "/repo/src/lib.rs", "content": "secret"}
        }),
    )
    .expect("normalize Kimi hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "kimi");
    assert_eq!(envelopes[0].session_id, "kimiapp-kimi-1");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
    let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
    assert!(!serialized.contains("secret"));
}

#[test]
fn antigravity_toolcall_write_normalizes_to_a_write() {
    let envelopes = normalize_hook_payload(
        HookSource::Antigravity,
        &json!({
            "session_id": "ag-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            // Antigravity nests the tool under `toolCall`, not tool_name/tool_input.
            "toolCall": {
                "name": "write_file",
                "args": {"file_path": "/repo/src/app.ts", "content": "x"}
            }
        }),
    )
    .expect("normalize Antigravity hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "antigravity");
    assert_eq!(envelopes[0].session_id, "antigravityapp-ag-1");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
    assert_eq!(envelopes[0].file_path, "/repo/src/app.ts");
}

#[test]
fn windsurf_post_write_code_normalizes_from_tool_info() {
    let envelopes = normalize_hook_payload(
        HookSource::Windsurf,
        &json!({
            "agent_action_name": "post_write_code",
            "trajectory_id": "traj-9",
            "execution_id": "exec-1",
            "timestamp": "2026-07-15T03:00:00Z",
            "model_name": "cascade",
            "tool_info": {
                "file_path": "/repo/src/main.rs",
                "edits": [{"old_string": "secret a", "new_string": "secret b"}]
            }
        }),
    )
    .expect("normalize Windsurf hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "windsurf");
    assert_eq!(envelopes[0].session_id, "windsurfapp-traj-9");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
    assert_eq!(envelopes[0].file_path, "/repo/src/main.rs");
    // No top-level cwd: the file's parent dir anchors the resolver.
    assert_eq!(envelopes[0].cwd, "/repo/src");
    let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
    assert!(!serialized.contains("secret"));
}

#[test]
fn windsurf_non_file_event_yields_no_envelope() {
    let envelopes = normalize_hook_payload(
        HookSource::Windsurf,
        &json!({
            "agent_action_name": "post_run_command",
            "trajectory_id": "traj-9",
            "tool_info": {"command_line": "npm test", "cwd": "/repo"}
        }),
    )
    .expect("normalize Windsurf command hook");
    assert!(envelopes.is_empty());
}

#[test]
fn zcode_write_normalizes_to_a_write() {
    let envelopes = normalize_hook_payload(
        HookSource::ZCode,
        &json!({
            "session_id": "zc-1",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "Write",
            "tool_input": {"file_path": "/repo/src/lib.rs"}
        }),
    )
    .expect("normalize ZCode hook");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].source, "zcode");
    assert_eq!(envelopes[0].session_id, "zcodeapp-zc-1");
    assert_eq!(envelopes[0].action, ResourceAction::Write);
}

#[test]
fn unknown_hook_source_is_rejected() {
    assert!(HookSource::parse("gemini-cli").is_err());
    assert!(HookSource::parse("warp").is_err());
    assert!(HookSource::parse("cline").is_err());
    assert_eq!(HookSource::parse("qwen").unwrap(), HookSource::QwenCode);
    assert_eq!(
        HookSource::parse("droid").unwrap(),
        HookSource::FactoryDroid
    );
    assert_eq!(HookSource::parse("trae").unwrap(), HookSource::Trae);
    assert_eq!(HookSource::parse("opencode").unwrap(), HookSource::OpenCode);
    assert_eq!(HookSource::parse("windsurf").unwrap(), HookSource::Windsurf);
    assert_eq!(HookSource::parse("kimi").unwrap(), HookSource::Kimi);
    assert_eq!(
        HookSource::parse("antigravity").unwrap(),
        HookSource::Antigravity
    );
    assert_eq!(HookSource::parse("zcode").unwrap(), HookSource::ZCode);
}

#[test]
fn codex_apply_patch_preserves_per_file_actions() {
    let envelopes = normalize_hook_payload(
            HookSource::Codex,
            &json!({
                "session_id": "session-2",
                "turn_id": "turn-2",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "tool_use_id": "tool-2",
                "tool_input": {
                    "command": "*** Begin Patch\n*** Add File: src/new.rs\n+x\n*** Delete File: src/old.rs\n*** End Patch"
                }
            }),
        )
        .expect("normalize Codex hook");

    assert_eq!(envelopes.len(), 2);
    assert_eq!(envelopes[0].session_id, "codexapp-session-2");
    assert_eq!(envelopes[0].action, ResourceAction::Create);
    assert_eq!(envelopes[1].action, ResourceAction::Delete);
    assert_eq!(
        envelopes[0].attribution_precision,
        AttributionPrecision::SessionOnly
    );
}

#[test]
fn codex_uses_parent_transcript_stem_as_loadable_root_session() {
    let envelopes = normalize_hook_payload(
            HookSource::Codex,
            &json!({
                "session_id": "019f-parent-thread",
                "transcript_path": "/Users/me/.codex/sessions/2026/07/14/rollout-2026-07-14T10-00-00-019f-parent-thread.jsonl",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "Read",
                "tool_use_id": "tool-1",
                "tool_input": {"file_path": "src/lib.rs"}
            }),
        )
        .expect("normalize Codex hook");

    assert_eq!(
        envelopes[0].session_id,
        "codexapp-rollout-2026-07-14T10-00-00-019f-parent-thread"
    );
    assert_eq!(envelopes[0].source_session_id, "019f-parent-thread");
}

#[test]
fn codex_subagent_stop_keeps_only_lifecycle_and_child_locator_metadata() {
    let payload = json!({
        "session_id": "019f-parent-thread",
        "turn_id": "turn-1",
        "transcript_path": "/Users/me/.codex/sessions/parent-rollout-019f-parent-thread.jsonl",
        "cwd": "/repo",
        "hook_event_name": "SubagentStop",
        "agent_id": "agent-1",
        "agent_type": "explorer",
        "agent_transcript_path": "/Users/me/.codex/sessions/child-rollout.jsonl",
        "last_assistant_message": "private answer"
    });
    let lifecycle = normalize_actor_lifecycle_payload(HookSource::Codex, &payload)
        .expect("normalize lifecycle")
        .expect("lifecycle envelope");

    assert_eq!(
        lifecycle.session_id,
        "codexapp-parent-rollout-019f-parent-thread"
    );
    assert_eq!(lifecycle.actor_id, "agent-1");
    assert_eq!(lifecycle.actor_type.as_deref(), Some("explorer"));
    assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Stopped);
    assert_eq!(
        lifecycle.transcript_path.as_deref(),
        Some("/Users/me/.codex/sessions/child-rollout.jsonl")
    );
    let serialized = serde_json::to_string(&lifecycle).expect("serialize lifecycle");
    assert!(!serialized.contains("private answer"));
}

#[test]
fn codex_subagent_start_does_not_mistake_child_transcript_for_parent() {
    let lifecycle = normalize_actor_lifecycle_payload(
        HookSource::Codex,
        &json!({
            "session_id": "019f-parent-thread",
            "turn_id": "turn-1",
            "transcript_path": "/Users/me/.codex/sessions/child-rollout-019f-child-thread.jsonl",
            "cwd": "/repo",
            "hook_event_name": "SubagentStart",
            "agent_id": "019f-child-thread",
            "agent_type": "default"
        }),
    )
    .expect("normalize lifecycle")
    .expect("lifecycle envelope");

    assert_eq!(lifecycle.session_id, "codexapp-019f-parent-thread");
    assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Started);
}

#[test]
fn cursor_subagent_start_preserves_parent_and_actor_identity() {
    let lifecycle = normalize_actor_lifecycle_payload(
        HookSource::Cursor,
        &json!({
            "conversation_id": "cursor-current-context",
            "generation_id": "generation-1",
            "workspace_roots": ["/repo"],
            "hook_event_name": "subagentStart",
            "subagent_id": "cursor-child-1",
            "subagent_type": "explore",
            "parent_conversation_id": "cursor-parent-1",
            "task": "private task description"
        }),
    )
    .expect("normalize Cursor lifecycle")
    .expect("Cursor lifecycle envelope");

    assert_eq!(lifecycle.source_session_id, "cursor-parent-1");
    assert_eq!(lifecycle.session_id, "cursoride-cursor-parent-1");
    assert_eq!(lifecycle.actor_id, "cursor-child-1");
    assert_eq!(lifecycle.actor_type.as_deref(), Some("explore"));
    assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Started);
    let serialized = serde_json::to_string(&lifecycle).expect("serialize lifecycle");
    assert!(!serialized.contains("private task description"));
}

#[test]
fn codex_exec_command_records_read_path_without_retaining_command() {
    let envelopes = normalize_hook_payload(
        HookSource::Codex,
        &json!({
            "session_id": "session-read",
            "turn_id": "turn-read",
            "cwd": "/repo",
            "hook_event_name": "PostToolUse",
            "tool_name": "exec_command",
            "tool_use_id": "tool-read",
            "tool_input": {"cmd": "sed -n '1,20p' src/lib.rs"},
            "tool_response": {"output": "private source"}
        }),
    )
    .expect("normalize Codex shell read");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].file_path, "src/lib.rs");
    assert_eq!(envelopes[0].action, ResourceAction::Read);
    let serialized = serde_json::to_string(&envelopes).expect("serialize envelopes");
    assert!(!serialized.contains("sed -n"));
    assert!(!serialized.contains("private source"));
}

#[test]
fn cursor_subagent_stop_uses_modified_files() {
    let envelopes = normalize_hook_payload(
        HookSource::Cursor,
        &json!({
            "conversation_id": "conversation-1",
            "generation_id": "generation-1",
            "workspace_roots": ["/repo"],
            "hook_event_name": "subagentStop",
            "modified_files": ["src/a.rs", "src/b.rs"]
        }),
    )
    .expect("normalize Cursor hook");

    assert_eq!(envelopes.len(), 2);
    assert_eq!(envelopes[0].session_id, "cursoride-conversation-1");
    assert_eq!(envelopes[0].cwd, "/repo");
    assert_eq!(envelopes[0].actor_id, None);
    assert_eq!(
        envelopes[0].attribution_precision,
        AttributionPrecision::SessionOnly
    );
    assert!(envelopes
        .iter()
        .all(|envelope| envelope.action == ResourceAction::Write));
}

#[test]
fn cursor_post_tool_use_matches_live_payload_without_retaining_private_fields() {
    let envelopes = normalize_hook_payload(
        HookSource::Cursor,
        &json!({
            "conversation_id": "conversation-live",
            "generation_id": "generation-live",
            "workspace_roots": ["/repo"],
            "hook_event_name": "postToolUse",
            "tool_name": "Read",
            "tool_use_id": "tool-live",
            "tool_input": {"file_path": "src/lib.rs"},
            "tool_output": "private file contents",
            "user_email": "private@example.com"
        }),
    )
    .expect("normalize live Cursor hook shape");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].session_id, "cursoride-conversation-live");
    assert_eq!(envelopes[0].turn_id.as_deref(), Some("generation-live"));
    assert_eq!(
        envelopes[0].source_event_id.as_deref(),
        Some("tool-live:read:src/lib.rs")
    );
    assert_eq!(envelopes[0].cwd, "/repo");
    assert_eq!(envelopes[0].file_path, "src/lib.rs");
    assert_eq!(envelopes[0].action, ResourceAction::Read);
    assert_eq!(
        envelopes[0].attribution_precision,
        AttributionPrecision::SessionOnly
    );
    let serialized = serde_json::to_string(&envelopes).expect("serialize envelopes");
    assert!(!serialized.contains("private file contents"));
    assert!(!serialized.contains("private@example.com"));
}

#[test]
fn vendor_timestamps_are_normalized_to_utc() {
    let envelopes = normalize_hook_payload(
        HookSource::ClaudeCode,
        &json!({
            "session_id": "session-3",
            "cwd": "/repo",
            "timestamp": "2026-07-14T10:00:00+02:00",
            "tool_name": "Read",
            "tool_input": {"file_path": "src/lib.rs"}
        }),
    )
    .expect("normalize timestamp");
    assert_eq!(envelopes[0].occurred_at, "2026-07-14T08:00:00.000Z");
}

#[test]
fn file_interactions_without_a_workspace_are_rejected() {
    let error = normalize_hook_payload(
        HookSource::ClaudeCode,
        &json!({
            "session_id": "session-4",
            "tool_name": "Read",
            "tool_input": {"file_path": "src/lib.rs"}
        }),
    )
    .expect_err("relative paths without a workspace must not be attributed");
    assert!(error.contains("workspace path"));
}

#[test]
fn one_hook_payload_has_a_bounded_interaction_fanout() {
    let modified_files = (0..=MAX_RESOURCE_INTERACTIONS_PER_HOOK)
        .map(|index| format!("src/generated-{index}.rs"))
        .collect::<Vec<_>>();
    let envelopes = normalize_hook_payload(
        HookSource::Cursor,
        &json!({
            "conversation_id": "bounded-fanout",
            "workspace_roots": ["/repo"],
            "hook_event_name": "subagentStop",
            "modified_files": modified_files
        }),
    )
    .expect("normalize bounded hook payload");

    assert_eq!(envelopes.len(), MAX_RESOURCE_INTERACTIONS_PER_HOOK);
}
