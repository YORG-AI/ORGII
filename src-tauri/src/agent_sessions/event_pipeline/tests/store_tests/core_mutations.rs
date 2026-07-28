use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::*;

use super::support::*;

#[test]
fn test_set_replaces_all() {
    let mut store = EventStore::new();
    store.set(vec![
        make_event("a", "tool_call"),
        make_event("b", "message"),
    ]);
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.version(), 1);

    store.set(vec![make_event("c", "tool_call")]);
    assert_eq!(store.event_count(), 1);
    assert_eq!(store.version(), 2);
    assert!(store.get_by_id("a").is_none());
    assert!(store.get_by_id("c").is_some());
}

#[test]
fn test_append_deduplicates() {
    let mut store = EventStore::new();
    store.append(vec![
        make_event("a", "tool_call"),
        make_event("b", "message"),
    ]);
    assert_eq!(store.event_count(), 2);

    store.append(vec![
        make_event("b", "message"),
        make_event("c", "tool_call"),
    ]);
    assert_eq!(store.event_count(), 3);
}

#[test]
fn test_delta_tracking_records_append_upsert_and_remove() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    store.mark_full_snapshot_emitted();

    store.append(vec![make_event("b", "tool_call")]);
    let (base_version, changed_ids, removed_ids) = store.take_delta_tracking();
    assert_eq!(base_version, 1);
    assert_eq!(store.version(), 2);
    assert_eq!(changed_ids, vec!["b".to_string()]);
    assert!(removed_ids.is_empty());

    let mut updated = make_event("a", "message");
    updated.display_text = "updated".to_string();
    store.upsert(updated);
    assert_eq!(store.remove_by_id_prefix("b"), 1);

    let (base_version, mut changed_ids, removed_ids) = store.take_delta_tracking();
    changed_ids.sort();
    assert_eq!(base_version, 2);
    assert_eq!(store.version(), 4);
    assert_eq!(changed_ids, vec!["a".to_string()]);
    assert_eq!(removed_ids, vec!["b".to_string()]);
}

#[test]
fn test_update_by_id() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "tool_call")]);

    let patch = SessionEventPatch {
        display_status: Some(EventDisplayStatus::Failed),
        display_text: Some("error occurred".to_string()),
        ..Default::default()
    };
    assert!(store.update_by_id("a", &patch));
    assert_eq!(
        store.get_by_id("a").unwrap().display_status,
        EventDisplayStatus::Failed
    );
    assert_eq!(store.get_by_id("a").unwrap().display_text, "error occurred");

    assert!(!store.update_by_id("nonexistent", &patch));
}

#[test]
fn test_upsert() {
    let mut store = EventStore::new();
    store.upsert(make_event("a", "tool_call"));
    assert_eq!(store.event_count(), 1);
    assert_eq!(store.version(), 1);

    let mut updated = make_event("a", "tool_call");
    updated.display_text = "updated text".to_string();
    store.upsert(updated);
    assert_eq!(store.event_count(), 1);
    assert_eq!(store.version(), 2);
    assert_eq!(store.get_by_id("a").unwrap().display_text, "updated text");

    store.upsert(make_event("b", "message"));
    assert_eq!(store.event_count(), 2);
}

#[test]
fn test_merge_tool_result() {
    let mut store = EventStore::new();
    store.set(vec![make_tool_call("tc-1", "call-1")]);
    assert_eq!(
        store.get_by_id("tc-1").unwrap().display_status,
        EventDisplayStatus::Running
    );

    store.merge_events(vec![make_tool_result("tr-1", "call-1")]);

    let merged = store.get_by_id("tc-1").unwrap();
    assert_eq!(merged.display_status, EventDisplayStatus::Completed);
    assert_eq!(merged.activity_status, ActivityStatus::Processed);
    assert_eq!(merged.result["content"], "file1.txt\nfile2.txt");
    // Args from original tool_call should be preserved (except streamOutput)
    assert_eq!(merged.args["command"], "ls");
    assert!(merged.args.get("streamOutput").is_none());
    // tool_result should NOT appear as separate event
    assert!(store.get_by_id("tr-1").is_none());
    assert_eq!(store.event_count(), 1);
}

#[test]
fn test_merge_tool_result_preserves_background_shell_until_exact_exit_callback() {
    let mut shell = make_tool_call("tc-background", "call-background");
    shell.function_name = "run_shell".to_string();
    shell.ui_canonical = core_types::tool_names::RUN_SHELL.to_string();
    shell.args = serde_json::json!({
        "command": "sleep 10",
        "shellPid": 4242,
        "shellProcessStatus": "background"
    });
    let mut store = EventStore::new();
    store.set(vec![shell]);

    store.merge_events(vec![make_tool_result("tr-background", "call-background")]);

    let merged = store.get_by_id("tc-background").unwrap();
    assert_eq!(merged.display_status, EventDisplayStatus::Completed);
    assert_eq!(merged.args["shellProcessStatus"], "background");
    assert_eq!(merged.args["shellPid"], 4242);
}

#[test]
fn test_merge_tool_result_preserves_args_and_merges_metadata() {
    let mut store = EventStore::new();

    // Tool call with file_path in args
    let mut tool_call = make_tool_call("tc-1", "call-1");
    tool_call.args =
        serde_json::json!({ "path": "/src/main.rs", "command": "edit", "streamOutput": "..." });
    tool_call.file_path = Some("/src/main.rs".to_string());
    store.set(vec![tool_call]);

    // Tool result with additional metadata
    let mut tool_result = make_tool_result("tr-1", "call-1");
    tool_result.args = serde_json::json!({ "execution_time": 150 }); // Extra metadata
    tool_result.command = Some("git diff".to_string());
    store.merge_events(vec![tool_result]);

    let merged = store.get_by_id("tc-1").unwrap();
    // Original args preserved
    assert_eq!(merged.args["path"], "/src/main.rs");
    assert_eq!(merged.args["command"], "edit");
    // Extra metadata from result merged in
    assert_eq!(merged.args["execution_time"], 150);
    // streamOutput removed
    assert!(merged.args.get("streamOutput").is_none());
    // file_path preserved from original
    assert_eq!(merged.file_path, Some("/src/main.rs".to_string()));
    // command propagated from result (original was None)
    assert_eq!(merged.command, Some("git diff".to_string()));
}

#[test]
fn test_merge_updates_existing() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);

    let mut updated = make_event("a", "message");
    updated.display_text = "new text".to_string();
    store.merge_events(vec![updated]);

    assert_eq!(store.event_count(), 1);
    assert_eq!(store.get_by_id("a").unwrap().display_text, "new text");
}

#[test]
fn test_merge_appends_new() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    store.merge_events(vec![make_event("b", "tool_call")]);
    assert_eq!(store.event_count(), 2);
}

#[test]
fn test_cap_at_max_events() {
    let mut store = EventStore::new();
    let events: Vec<SessionEvent> = (0..8010)
        .map(|i| make_event(&format!("evt-{}", i), "message"))
        .collect();
    store.set(events);
    assert_eq!(store.event_count(), 8000);
    // Oldest events should have been trimmed
    assert!(store.get_by_id("evt-0").is_none());
    assert!(store.get_by_id("evt-10").is_some());
}

#[test]
fn test_clear() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    store.clear();
    assert_eq!(store.event_count(), 0);
    assert!(store.get_by_id("a").is_none());
}

#[test]
fn test_streaming_flag() {
    let mut store = EventStore::new();
    assert!(!store.is_streaming());
    store.set_streaming(true);
    assert!(store.is_streaming());
    store.set_streaming(false);
    assert!(!store.is_streaming());
}

// ============================================================================
// Batch operation tests
// ============================================================================

#[test]
fn test_complete_last_running() {
    let mut store = EventStore::new();
    store.set(vec![
        make_event("a", "message"),
        make_running_event("b"),
        make_running_event("c"),
    ]);
    let v_before = store.version();
    let result = store.complete_last_running();
    assert_eq!(result, Some("c".to_string()));
    assert_eq!(
        store.get_by_id("c").unwrap().display_status,
        EventDisplayStatus::Completed
    );
    assert_eq!(
        store.get_by_id("b").unwrap().display_status,
        EventDisplayStatus::Running
    );
    assert!(store.version() > v_before);
}

#[test]
fn test_complete_last_running_none() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    let v_before = store.version();
    let result = store.complete_last_running();
    assert!(result.is_none());
    assert_eq!(store.version(), v_before);
}

#[test]
fn test_complete_last_running_skips_awaiting_user() {
    // Regression: AskQuestionCard used to disappear because `agent:complete`
    // for the surrounding turn called `complete_last_running`, which flipped
    // the blocking `ask_user_questions` tool_call to Completed.
    //
    // With the AwaitingUser phase, only explicit `interaction_finalized`
    // (via `merge_events`) is allowed to complete it.
    let mut store = EventStore::new();
    store.set(vec![
        make_event("msg", "message"),
        make_awaiting_user_event("tool-call-ask"),
    ]);
    let v_before = store.version();
    let result = store.complete_last_running();
    assert!(
        result.is_none(),
        "AwaitingUser event must not be treated as Running"
    );
    assert_eq!(
        store.get_by_id("tool-call-ask").unwrap().display_status,
        EventDisplayStatus::AwaitingUser
    );
    assert_eq!(
        store.version(),
        v_before,
        "version must not bump when nothing changes"
    );
}

#[test]
fn test_complete_last_running_picks_running_past_awaiting_user() {
    // If a real Running event exists before the AwaitingUser one in insertion
    // order (AwaitingUser inserted LAST), `complete_last_running` should skip
    // AwaitingUser and land on the Running event behind it.
    let mut store = EventStore::new();
    store.set(vec![
        make_running_event("running-thinking"),
        make_awaiting_user_event("tool-call-ask"),
    ]);
    let result = store.complete_last_running();
    assert_eq!(result, Some("running-thinking".to_string()));
    assert_eq!(
        store.get_by_id("running-thinking").unwrap().display_status,
        EventDisplayStatus::Completed
    );
    assert_eq!(
        store.get_by_id("tool-call-ask").unwrap().display_status,
        EventDisplayStatus::AwaitingUser,
        "AwaitingUser must remain untouched"
    );
}

#[test]
fn test_merge_events_transitions_awaiting_user_to_completed() {
    // The `interaction_finalized` path emits a tool_result that merges into
    // the AwaitingUser tool_call; that merge is the sole legitimate way to
    // transition into Completed.
    let mut store = EventStore::new();
    let mut call = make_awaiting_user_event("tool-call-ask");
    call.call_id = Some("ask-123".to_string());
    store.set(vec![call]);

    let mut result_event = make_event("tool-result-ask", "tool_result");
    result_event.call_id = Some("ask-123".to_string());
    result_event.result = serde_json::json!({ "answers": ["use_redis"], "status": "answered" });

    store.merge_events(vec![result_event]);

    let completed = store.get_by_id("tool-call-ask").unwrap();
    assert_eq!(
        completed.display_status,
        EventDisplayStatus::Completed,
        "interaction_finalized must flip AwaitingUser → Completed"
    );
}

#[test]
fn test_patch_by_ids() {
    let mut store = EventStore::new();
    store.set(vec![
        make_running_event("a"),
        make_running_event("b"),
        make_running_event("c"),
    ]);
    let patch = SessionEventPatch {
        display_status: Some(EventDisplayStatus::Completed),
        is_delta: Some(false),
        ..Default::default()
    };
    let count = store.patch_by_ids(&["a".to_string(), "c".to_string()], &patch);
    assert_eq!(count, 2);
    assert_eq!(
        store.get_by_id("a").unwrap().display_status,
        EventDisplayStatus::Completed
    );
    assert_eq!(
        store.get_by_id("b").unwrap().display_status,
        EventDisplayStatus::Running
    );
    assert_eq!(
        store.get_by_id("c").unwrap().display_status,
        EventDisplayStatus::Completed
    );
}

#[test]
fn test_patch_by_ids_with_missing() {
    let mut store = EventStore::new();
    store.set(vec![make_running_event("a")]);
    let patch = SessionEventPatch {
        display_status: Some(EventDisplayStatus::Completed),
        ..Default::default()
    };
    let count = store.patch_by_ids(&["a".to_string(), "nonexistent".to_string()], &patch);
    assert_eq!(count, 1);
}

#[test]
fn test_remove_by_id_prefix() {
    let mut store = EventStore::new();
    store.set(vec![
        make_event("stream-msg-1", "message"),
        make_event("stream-msg-2", "message"),
        make_event("normal-1", "tool_call"),
        make_event("stream-think-1", "message"),
    ]);
    let removed = store.remove_by_id_prefix("stream-msg-");
    assert_eq!(removed, 2);
    assert_eq!(store.event_count(), 2);
    assert!(store.get_by_id("stream-msg-1").is_none());
    assert!(store.get_by_id("normal-1").is_some());
    assert!(store.get_by_id("stream-think-1").is_some());
}

#[test]
fn test_remove_by_id_prefix_no_match() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    let v_before = store.version();
    let removed = store.remove_by_id_prefix("nonexistent-");
    assert_eq!(removed, 0);
    assert_eq!(store.version(), v_before);
}

#[test]
fn test_remove_by_ids() {
    let mut store = EventStore::new();
    store.set(vec![
        make_event("stream-msg-1", "message"),
        make_event("normal-1", "tool_call"),
        make_event("stream-think-1", "message"),
    ]);
    let removed = store.remove_by_ids(&[
        "stream-msg-1".to_string(),
        "stream-think-1".to_string(),
        "nonexistent".to_string(),
    ]);
    assert_eq!(removed, 2);
    assert!(store.get_by_id("stream-msg-1").is_none());
    assert!(store.get_by_id("stream-think-1").is_none());
    assert!(store.get_by_id("normal-1").is_some());

    // Removed ids surface in delta tracking so `es:changed` subscribers drop them.
    let (_, _, removed_ids) = store.take_delta_tracking();
    assert!(removed_ids.contains(&"stream-msg-1".to_string()));
    assert!(removed_ids.contains(&"stream-think-1".to_string()));
}

#[test]
fn test_remove_by_ids_no_match_keeps_version() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    let v_before = store.version();
    let removed = store.remove_by_ids(&["nonexistent".to_string()]);
    assert_eq!(removed, 0);
    assert_eq!(store.version(), v_before);
}

#[test]
fn test_remove_synthetic_user_inputs_keeps_backend_user_input_ids() {
    let mut store = EventStore::new();
    let mut synthetic = make_event("user-input-synthetic", "raw");
    synthetic.source = EventSource::User;
    synthetic.function_name = "user_message".to_string();
    synthetic.ui_canonical = "user_message".to_string();
    synthetic.result = serde_json::json!({ "syntheticUserInput": true });
    synthetic.chunk_id = None;

    let mut backend = make_event("user-input-cliagent-real", "raw");
    backend.source = EventSource::User;
    backend.function_name = "user_message".to_string();
    backend.ui_canonical = "user_message".to_string();
    backend.display_text = "authoritative different text".to_string();

    store.set(vec![synthetic, backend]);
    let removed = store.remove_synthetic_user_inputs();

    assert_eq!(removed, 1);
    assert!(store.get_by_id("user-input-synthetic").is_none());
    assert!(store.get_by_id("user-input-cliagent-real").is_some());
}

#[test]
fn test_merge_authoritative_user_message_evicts_matching_synthetic_placeholder() {
    let mut store = EventStore::new();
    let mut synthetic = make_event("user-input-synthetic", "raw");
    synthetic.source = EventSource::User;
    synthetic.function_name = "user_message".to_string();
    synthetic.ui_canonical = "user_message".to_string();
    synthetic.result = serde_json::json!({ "syntheticUserInput": true });
    synthetic.chunk_id = None;
    synthetic.display_text = "hello from user".to_string();

    store.append(vec![synthetic]);
    assert!(store.get_by_id("user-input-synthetic").is_some());

    let mut backend = make_event("user-input-cliagent-real", "raw");
    backend.source = EventSource::User;
    backend.function_name = "user".to_string();
    backend.ui_canonical = "user".to_string();
    backend.display_text = "hello from user".to_string();

    store.merge_events(vec![backend]);

    assert!(store.get_by_id("user-input-synthetic").is_none());
    assert!(store.get_by_id("user-input-cliagent-real").is_some());
}

#[test]
fn test_set_reconciles_persisted_matching_synthetic_placeholder() {
    let mut store = EventStore::new();
    let mut synthetic = make_event("user-input-synthetic", "raw");
    synthetic.source = EventSource::User;
    synthetic.function_name = "user_message".to_string();
    synthetic.result = serde_json::json!({ "syntheticUserInput": true });
    synthetic.display_text = "persisted duplicate".to_string();

    let mut backend = make_event("user-input-real", "raw");
    backend.source = EventSource::User;
    backend.function_name = "provider_specific_user_event".to_string();
    backend.display_text = "persisted duplicate".to_string();

    store.set(vec![synthetic, backend]);

    assert!(store.get_by_id("user-input-synthetic").is_none());
    assert!(store.get_by_id("user-input-real").is_some());
}

#[test]
fn test_merge_authoritative_message_keeps_legitimate_repeated_user_text() {
    let mut store = EventStore::new();
    let mut first = make_event("user-input-first", "raw");
    first.source = EventSource::User;
    first.function_name = "user".to_string();
    first.ui_canonical = "user".to_string();
    first.display_text = "repeat me".to_string();

    let mut second = make_event("user-input-second", "raw");
    second.source = EventSource::User;
    second.function_name = "user".to_string();
    second.ui_canonical = "user".to_string();
    second.display_text = "repeat me".to_string();

    store.append(vec![first]);
    store.merge_events(vec![second]);

    assert!(store.get_by_id("user-input-first").is_some());
    assert!(store.get_by_id("user-input-second").is_some());
}

#[test]
fn test_merge_authoritative_message_keeps_non_matching_synthetic_text() {
    let mut store = EventStore::new();
    let mut synthetic = make_event("user-input-synthetic", "raw");
    synthetic.source = EventSource::User;
    synthetic.function_name = "user_message".to_string();
    synthetic.ui_canonical = "user_message".to_string();
    synthetic.result = serde_json::json!({ "syntheticUserInput": true });
    synthetic.display_text = "different pending text".to_string();

    let mut backend = make_event("user-input-real", "raw");
    backend.source = EventSource::User;
    backend.function_name = "provider_specific_user_event".to_string();
    backend.ui_canonical = "user".to_string();
    backend.display_text = "authoritative text".to_string();

    store.append(vec![synthetic]);
    store.merge_events(vec![backend]);

    assert!(store.get_by_id("user-input-synthetic").is_some());
    assert!(store.get_by_id("user-input-real").is_some());
}

#[test]
fn test_replace_and_remove() {
    let mut store = EventStore::new();
    let mut placeholder = make_event("stream-1", "message");
    placeholder.created_at = "2026-05-22T06:48:20.100Z".to_string();
    let mut normal_event = make_event("normal-1", "tool_call");
    normal_event.created_at = "2026-05-22T06:48:21.000Z".to_string();
    store.set(vec![placeholder, normal_event]);
    let mut new_event = make_event("final-1", "message");
    new_event.created_at = "2026-05-22T06:48:30.000Z".to_string();

    store.replace_and_remove(Some("stream-1"), new_event);

    assert!(store.get_by_id("stream-1").is_none());
    assert!(store.get_by_id("final-1").is_some());
    assert!(store.get_by_id("normal-1").is_some());
    assert_eq!(store.events()[0].id, "final-1");
    assert_eq!(store.events()[0].created_at, "2026-05-22T06:48:20.100Z");
    assert_eq!(store.events()[1].id, "normal-1");
}

#[test]
fn test_replace_and_remove_removes_placeholder_when_final_already_exists() {
    let mut store = EventStore::new();
    let mut placeholder = make_event("stream-think-ts-1", "message");
    placeholder.created_at = "2026-05-22T07:18:20.100Z".to_string();
    let mut existing_final = make_event("stream-think-1-final", "message");
    existing_final.created_at = "2026-05-22T07:18:22.000Z".to_string();
    let normal_event = make_event("normal-1", "tool_call");
    store.set(vec![placeholder, existing_final, normal_event]);

    let mut new_event = make_event("stream-think-1-final", "message");
    new_event.created_at = "2026-05-22T07:18:30.000Z".to_string();
    store.replace_and_remove(Some("stream-think-ts-1"), new_event);

    assert!(store.get_by_id("stream-think-ts-1").is_none());
    assert!(store.get_by_id("stream-think-1-final").is_some());
    assert_eq!(
        store
            .events()
            .iter()
            .filter(|event| event.id == "stream-think-1-final")
            .count(),
        1
    );
    assert_eq!(store.events()[0].id, "stream-think-1-final");
    assert_eq!(store.events()[0].created_at, "2026-05-22T07:18:20.100Z");
    assert_eq!(store.events()[1].id, "normal-1");
}

#[test]
fn test_replace_and_remove_removes_tail_placeholder_when_final_already_exists() {
    let mut store = EventStore::new();
    let mut existing_final = make_event("stream-think-1-final", "message");
    existing_final.created_at = "2026-05-22T07:18:22.000Z".to_string();
    let normal_event = make_event("normal-1", "tool_call");
    let mut placeholder = make_event("stream-think-ts-1", "message");
    placeholder.created_at = "2026-05-22T07:18:20.100Z".to_string();
    store.set(vec![existing_final, normal_event, placeholder]);

    let mut new_event = make_event("stream-think-1-final", "message");
    new_event.created_at = "2026-05-22T07:18:30.000Z".to_string();
    store.replace_and_remove(Some("stream-think-ts-1"), new_event);

    assert!(store.get_by_id("stream-think-ts-1").is_none());
    assert!(store.get_by_id("stream-think-1-final").is_some());
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.events()[0].id, "stream-think-1-final");
    assert_eq!(store.events()[0].created_at, "2026-05-22T07:18:20.100Z");
    assert_eq!(store.events()[1].id, "normal-1");
}

#[test]
fn test_replace_and_remove_no_remove() {
    let mut store = EventStore::new();
    store.set(vec![make_event("a", "message")]);
    let new_event = make_event("b", "message");
    store.replace_and_remove(None, new_event);
    assert_eq!(store.event_count(), 2);
}

#[test]
fn test_authoritative_stream_upsert_replaces_matching_ts_placeholder() {
    let mut store = EventStore::new();
    let mut placeholder = make_event("stream-think-ts-test-session-100", "llm_thinking");
    placeholder.created_at = "2026-05-22T07:18:20.100Z".to_string();
    placeholder.display_text = "same thought".to_string();
    let normal_event = make_event("normal-1", "tool_call");
    store.set(vec![placeholder, normal_event]);

    let mut authoritative = make_event("stream-think-test-session-1-final", "llm_thinking");
    authoritative.created_at = "2026-05-22T07:18:30.000Z".to_string();
    authoritative.display_text = "same thought".to_string();
    store.upsert(authoritative);

    assert!(store
        .get_by_id("stream-think-ts-test-session-100")
        .is_none());
    assert!(store
        .get_by_id("stream-think-test-session-1-final")
        .is_some());
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.events()[0].id, "stream-think-test-session-1-final");
    assert_eq!(store.events()[0].created_at, "2026-05-22T07:18:20.100Z");
    assert_eq!(store.events()[1].id, "normal-1");
}

#[test]
fn test_authoritative_stream_upsert_removes_placeholder_when_final_already_exists() {
    let mut store = EventStore::new();
    let mut placeholder = make_event("stream-think-ts-test-session-100", "llm_thinking");
    placeholder.created_at = "2026-05-22T07:18:20.100Z".to_string();
    placeholder.display_text = "same thought".to_string();
    let mut existing_final = make_event("stream-think-test-session-1-final", "llm_thinking");
    existing_final.created_at = "2026-05-22T07:18:22.000Z".to_string();
    existing_final.display_text = "same thought".to_string();
    let normal_event = make_event("normal-1", "tool_call");
    store.set(vec![placeholder, existing_final, normal_event]);

    let mut authoritative = make_event("stream-think-test-session-1-final", "llm_thinking");
    authoritative.created_at = "2026-05-22T07:18:30.000Z".to_string();
    authoritative.display_text = "same thought".to_string();
    store.upsert(authoritative);

    assert!(store
        .get_by_id("stream-think-ts-test-session-100")
        .is_none());
    assert!(store
        .get_by_id("stream-think-test-session-1-final")
        .is_some());
    assert_eq!(
        store
            .events()
            .iter()
            .filter(|event| event.id == "stream-think-test-session-1-final")
            .count(),
        1
    );
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.events()[0].id, "stream-think-test-session-1-final");
    assert_eq!(store.events()[0].created_at, "2026-05-22T07:18:20.100Z");
    assert_eq!(store.events()[1].id, "normal-1");
}

#[test]
fn test_authoritative_thinking_upsert_replaces_duplicate_in_current_turn() {
    let mut store = EventStore::new();
    let mut user = make_event("user-1", "user_message");
    user.source = EventSource::User;
    user.display_variant = EventDisplayVariant::Message;
    user.display_text = "first prompt".to_string();

    let mut first = make_event("stream-think-session-1", "llm_thinking");
    first.display_variant = EventDisplayVariant::Thinking;
    first.display_text = "same thought".to_string();
    first.created_at = "2026-05-22T07:18:20.100Z".to_string();

    store.set(vec![user, first]);

    let mut duplicate = make_event("stream-think-session-2", "llm_thinking");
    duplicate.display_variant = EventDisplayVariant::Thinking;
    duplicate.display_text = "same   thought".to_string();
    duplicate.created_at = "2026-05-22T07:18:30.000Z".to_string();

    store.upsert(duplicate);

    assert!(store.get_by_id("stream-think-session-1").is_none());
    assert!(store.get_by_id("stream-think-session-2").is_some());
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.events()[1].id, "stream-think-session-2");
    assert_eq!(store.events()[1].created_at, "2026-05-22T07:18:20.100Z");
}

#[test]
fn test_authoritative_thinking_upsert_preserves_same_text_across_turns() {
    let mut store = EventStore::new();
    let mut user_one = make_event("user-1", "user_message");
    user_one.source = EventSource::User;
    user_one.display_variant = EventDisplayVariant::Message;
    user_one.display_text = "first prompt".to_string();

    let mut first = make_event("stream-think-session-1", "llm_thinking");
    first.display_variant = EventDisplayVariant::Thinking;
    first.display_text = "same thought".to_string();

    let mut user_two = make_event("user-2", "user_message");
    user_two.source = EventSource::User;
    user_two.display_variant = EventDisplayVariant::Message;
    user_two.display_text = "second prompt".to_string();

    store.set(vec![user_one, first, user_two]);

    let mut repeated_next_turn = make_event("stream-think-session-2", "llm_thinking");
    repeated_next_turn.display_variant = EventDisplayVariant::Thinking;
    repeated_next_turn.display_text = "same thought".to_string();

    store.upsert(repeated_next_turn);

    assert!(store.get_by_id("stream-think-session-1").is_some());
    assert!(store.get_by_id("stream-think-session-2").is_some());
    assert_eq!(store.event_count(), 4);
}

#[test]
fn test_authoritative_message_upsert_replaces_duplicate_in_current_turn() {
    let mut store = EventStore::new();
    let mut user = make_event("user-1", "user_message");
    user.source = EventSource::User;
    user.display_variant = EventDisplayVariant::Message;
    user.display_text = "first prompt".to_string();

    let mut first = make_event("stream-msg-session-1", "message");
    first.display_variant = EventDisplayVariant::Message;
    first.display_text = "same assistant note".to_string();
    first.created_at = "2026-05-22T07:18:20.100Z".to_string();

    store.set(vec![user, first]);

    let mut duplicate = make_event("stream-msg-session-2", "message");
    duplicate.display_variant = EventDisplayVariant::Message;
    duplicate.display_text = "same assistant note".to_string();
    duplicate.created_at = "2026-05-22T07:18:30.000Z".to_string();

    store.upsert(duplicate);

    assert!(store.get_by_id("stream-msg-session-1").is_none());
    assert!(store.get_by_id("stream-msg-session-2").is_some());
    assert_eq!(store.event_count(), 2);
    assert_eq!(store.events()[1].id, "stream-msg-session-2");
    assert_eq!(store.events()[1].created_at, "2026-05-22T07:18:20.100Z");
}

#[test]
fn test_authoritative_message_upsert_preserves_same_text_across_turns() {
    let mut store = EventStore::new();
    let mut user_one = make_event("user-1", "user_message");
    user_one.source = EventSource::User;
    user_one.display_variant = EventDisplayVariant::Message;
    user_one.display_text = "first prompt".to_string();

    let mut first = make_event("stream-msg-session-1", "message");
    first.display_variant = EventDisplayVariant::Message;
    first.display_text = "same assistant note".to_string();

    let mut user_two = make_event("user-2", "user_message");
    user_two.source = EventSource::User;
    user_two.display_variant = EventDisplayVariant::Message;
    user_two.display_text = "second prompt".to_string();

    store.set(vec![user_one, first, user_two]);

    let mut repeated_next_turn = make_event("stream-msg-session-2", "message");
    repeated_next_turn.display_variant = EventDisplayVariant::Message;
    repeated_next_turn.display_text = "same assistant note".to_string();

    store.upsert(repeated_next_turn);

    assert!(store.get_by_id("stream-msg-session-1").is_some());
    assert!(store.get_by_id("stream-msg-session-2").is_some());
    assert_eq!(store.event_count(), 4);
}

#[test]
fn test_update_spawning_tool_args() {
    let mut store = EventStore::new();
    store.set(vec![
        make_event("msg-1", "message"),
        make_task_tool_call("task-1"),
    ]);
    let task_names = &["task"];
    let result = store.update_spawning_tool_args(
        task_names,
        serde_json::json!({
            "reasoningText": "analyzing code...",
            "subActivities": [{"tool": "read", "args": {}}]
        }),
    );
    assert_eq!(result, Some("task-1".to_string()));
    let task = store.get_by_id("task-1").unwrap();
    assert_eq!(task.args["reasoningText"], "analyzing code...");
    assert_eq!(task.args["description"], "explore codebase");
}

#[test]
fn test_update_spawning_tool_args_none() {
    let mut store = EventStore::new();
    store.set(vec![make_event("msg-1", "message")]);
    let task_names = &["task"];
    let result = store.update_spawning_tool_args(task_names, serde_json::json!({"key": "value"}));
    assert!(result.is_none());
}

#[test]
fn test_update_spawning_tool_args_multi_names() {
    let mut store = EventStore::new();
    let mut session_call = make_event("session-1", "tool_call");
    session_call.function_name = "session".to_string();
    session_call.display_status = EventDisplayStatus::Running;
    session_call.args = serde_json::json!({ "desc": "test" });
    store.set(vec![make_event("msg-1", "message"), session_call]);

    let names = &["task", "session", "spawn"];
    let result = store.update_spawning_tool_args(names, serde_json::json!({"subActivities": []}));
    assert_eq!(result, Some("session-1".to_string()));
    let updated = store.get_by_id("session-1").unwrap();
    assert_eq!(updated.args["desc"], "test");
    assert!(updated.args["subActivities"].is_array());
}
