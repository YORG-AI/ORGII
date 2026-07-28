use crate::agent_sessions::event_pipeline::store::{capture_shell_replay_bookmarks, EventStore};
use crate::agent_sessions::event_pipeline::types::*;

use super::support::*;

#[test]
fn test_shell_replay_exact_update_is_monotonic_and_seed_is_immutable() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.shell_replay_bookmarks = Some(Default::default());
    let mut sibling = shell.clone();
    sibling.id = "shell-1-sibling".to_string();
    let mut store = EventStore::new();
    store.set(vec![shell, sibling]);

    let initial = replay_state("call-shell-1", 1, 100, ShellReplayStatus::Running);
    assert_eq!(
        store.update_shell_replay_by_call_id("call-shell-1", initial.clone(), true),
        Some("shell-1-sibling".to_string())
    );
    let latest = replay_state("call-shell-1", 2, 200, ShellReplayStatus::Running);
    store.update_shell_replay_by_call_id("call-shell-1", latest.clone(), false);
    store.update_shell_replay_by_call_id("call-shell-1", initial.clone(), true);

    for id in ["shell-1", "shell-1-sibling"] {
        let event = store.get_by_id(id).unwrap();
        assert_eq!(event.shell_replay, Some(latest.clone()));
        assert_eq!(
            event
                .shell_replay_bookmarks
                .as_ref()
                .and_then(|bookmarks| bookmarks.get("call-shell-1")),
            Some(&initial)
        );
    }
}

#[test]
fn test_shell_replay_terminal_state_cannot_regress_to_running() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.shell_replay_bookmarks = Some(Default::default());
    let mut store = EventStore::new();
    store.set(vec![shell]);

    let mut complete = replay_state("call-shell-1", 3, 300, ShellReplayStatus::Complete);
    complete.completed_at = Some("2026-01-01T00:01:00Z".to_string());
    store.update_shell_replay_by_call_id("call-shell-1", complete.clone(), true);
    store.update_shell_replay_by_call_id(
        "call-shell-1",
        replay_state("call-shell-1", 4, 400, ShellReplayStatus::Running),
        false,
    );

    assert_eq!(
        store.get_by_id("shell-1").unwrap().shell_replay,
        Some(complete)
    );
}

#[test]
fn test_shell_replay_complete_can_be_corrected_to_incomplete() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.shell_replay_bookmarks = Some(Default::default());
    let mut store = EventStore::new();
    store.set(vec![shell]);

    let mut complete = replay_state("call-shell-1", 3, 300, ShellReplayStatus::Complete);
    complete.completed_at = Some("2026-01-01T00:01:00Z".to_string());
    store.update_shell_replay_by_call_id("call-shell-1", complete, true);

    let mut incomplete = replay_state("call-shell-1", 3, 300, ShellReplayStatus::Incomplete);
    incomplete.error = Some("final persistence barrier failed".to_string());
    store.update_shell_replay_by_call_id("call-shell-1", incomplete.clone(), false);

    assert_eq!(
        store.get_by_id("shell-1").unwrap().shell_replay,
        Some(incomplete)
    );
}

#[test]
fn test_shell_replay_incomplete_can_correct_an_optimistic_higher_watermark() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.shell_replay_bookmarks = Some(Default::default());
    let mut store = EventStore::new();
    store.set(vec![shell]);

    store.update_shell_replay_by_call_id(
        "call-shell-1",
        replay_state("call-shell-1", 9, 900, ShellReplayStatus::Complete),
        true,
    );
    let mut recovered = replay_state("call-shell-1", 8, 800, ShellReplayStatus::Incomplete);
    recovered.error = Some("torn final frame removed during recovery".to_string());
    store.update_shell_replay_by_call_id("call-shell-1", recovered.clone(), false);

    assert_eq!(
        store.get_by_id("shell-1").unwrap().shell_replay,
        Some(recovered)
    );
}

#[test]
fn test_shell_replay_incomplete_cannot_be_overwritten_by_complete() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.shell_replay_bookmarks = Some(Default::default());
    let mut store = EventStore::new();
    store.set(vec![shell]);

    let mut incomplete = replay_state("call-shell-1", 3, 300, ShellReplayStatus::Incomplete);
    incomplete.error = Some("disk full".to_string());
    store.update_shell_replay_by_call_id("call-shell-1", incomplete.clone(), true);
    store.update_shell_replay_by_call_id(
        "call-shell-1",
        replay_state("call-shell-1", 4, 400, ShellReplayStatus::Complete),
        false,
    );

    assert_eq!(
        store.get_by_id("shell-1").unwrap().shell_replay,
        Some(incomplete)
    );
}

#[test]
fn test_shell_replay_update_requires_exact_session_and_call() {
    let shell = make_shell_tool_call("shell-1");
    let mut store = EventStore::new();
    store.set(vec![shell]);

    assert!(store
        .update_shell_replay_by_call_id(
            "different-call",
            replay_state("call-shell-1", 1, 100, ShellReplayStatus::Running),
            true,
        )
        .is_none());

    let mut wrong_session = replay_state("call-shell-1", 1, 100, ShellReplayStatus::Running);
    wrong_session.replay_ref.session_id = "different-session".to_string();
    assert!(store
        .update_shell_replay_by_call_id("call-shell-1", wrong_session, true)
        .is_none());
    assert!(store.get_by_id("shell-1").unwrap().shell_replay.is_none());
}

#[test]
fn test_same_id_upsert_preserves_first_insert_bookmarks() {
    let initial = replay_state("other-call", 5, 500, ShellReplayStatus::Running);
    let mut first = make_event("timeline-1", "message");
    first.shell_replay_bookmarks = Some(std::collections::HashMap::from([(
        "other-call".to_string(),
        initial.clone(),
    )]));
    let mut store = EventStore::new();
    store.set(vec![first]);

    let future = replay_state("other-call", 99, 9_900, ShellReplayStatus::Complete);
    let mut update = make_event("timeline-1", "message");
    update.display_text = "updated".to_string();
    update.shell_replay_bookmarks = Some(std::collections::HashMap::from([(
        "other-call".to_string(),
        future,
    )]));
    store.upsert(update);

    let mut merge_update = make_event("timeline-1", "message");
    merge_update.display_text = "merged".to_string();
    merge_update.shell_replay_bookmarks = Some(std::collections::HashMap::from([(
        "other-call".to_string(),
        replay_state("other-call", 100, 10_000, ShellReplayStatus::Complete),
    )]));
    store.merge_events(vec![merge_update]);

    assert_eq!(
        store
            .get_by_id("timeline-1")
            .unwrap()
            .shell_replay_bookmarks
            .as_ref()
            .and_then(|bookmarks| bookmarks.get("other-call")),
        Some(&initial)
    );
}

#[test]
fn test_first_insert_bookmark_winner_fills_only_missing_active_calls() {
    let first = replay_state("call-a", 1, 100, ShellReplayStatus::Running);
    let future = replay_state("call-a", 9, 900, ShellReplayStatus::Running);
    let active_b = replay_state("call-b", 2, 200, ShellReplayStatus::Running);
    let mut event = make_event("timeline-1", "message");
    event.shell_replay_bookmarks = Some(std::collections::HashMap::from([(
        "call-a".to_string(),
        first.clone(),
    )]));

    capture_shell_replay_bookmarks(
        &mut event,
        &std::collections::HashMap::from([
            ("call-a".to_string(), future),
            ("call-b".to_string(), active_b.clone()),
        ]),
    );

    let bookmarks = event.shell_replay_bookmarks.unwrap();
    assert_eq!(bookmarks.get("call-a"), Some(&first));
    assert_eq!(bookmarks.get("call-b"), Some(&active_b));
}

#[test]
fn test_live_shell_event_keeps_only_bounded_replay_payload() {
    let mut shell = make_shell_tool_call("shell-1");
    shell.args["streamOutput"] = serde_json::Value::String("duplicate".repeat(20_000));
    shell.result = serde_json::json!({
        "content": "duplicate".repeat(20_000),
        "observation": "duplicate".repeat(20_000)
    });
    let mut state = replay_state("call-shell-1", 1, 80_000, ShellReplayStatus::Running);
    state.terminal_preview = "中".repeat(20_000);
    shell.shell_replay = Some(state);
    let mut store = EventStore::new();
    store.upsert(shell);

    let stored = store.get_by_id("shell-1").unwrap();
    assert!(stored.args.get("streamOutput").is_none());
    assert_eq!(stored.result, serde_json::json!({}));
    assert!(stored.shell_replay.as_ref().unwrap().terminal_preview.len() <= 32 * 1024);
}

#[test]
fn test_live_external_shell_without_replay_never_becomes_an_empty_card() {
    let mut shell = make_shell_tool_call("external-shell-no-replay");
    shell.display_status = EventDisplayStatus::Completed;
    shell.shell_replay = None;
    shell.args["streamOutput"] = serde_json::Value::String(String::new());
    shell.result = serde_json::json!({
        "stdout": format!("{}EXTERNAL-TAIL", "x".repeat(80_000)),
        "exit_code": 0
    });

    let mut store = EventStore::new();
    store.upsert(shell);

    let stored = store.get_by_id("external-shell-no-replay").unwrap();
    assert_eq!(stored.result, serde_json::json!({}));
    let replay = stored
        .shell_replay
        .as_ref()
        .expect("bounded external fallback preview");
    assert_eq!(replay.status, ShellReplayStatus::Incomplete);
    assert_eq!(replay.bookmark, ShellReplayBookmark::default());
    assert!(replay.terminal_preview.len() <= 32 * 1024);
    assert!(replay.terminal_preview.ends_with("EXTERNAL-TAIL"));
    assert!(replay
        .error
        .as_deref()
        .is_some_and(|error| error.contains("仅显示有界预览")));
}

#[test]
fn test_running_external_shell_without_replay_keeps_bounded_stream_preview() {
    let mut shell = make_shell_tool_call("external-shell-running");
    shell.shell_replay = None;
    shell.args["streamOutput"] =
        serde_json::Value::String(format!("{}RUNNING-TAIL", "x".repeat(80_000)));

    let mut store = EventStore::new();
    store.upsert(shell);

    let stored = store.get_by_id("external-shell-running").unwrap();
    assert!(stored.shell_replay.is_none());
    let preview = stored.args["streamOutput"].as_str().unwrap();
    assert!(preview.len() <= 32 * 1024);
    assert!(preview.ends_with("RUNNING-TAIL"));
}

#[test]
fn test_hydration_converts_legacy_shell_output_to_bounded_incomplete_preview() {
    let mut shell = make_shell_tool_call("legacy-shell");
    shell.args["streamOutput"] = serde_json::Value::String("old-stream".repeat(10_000));
    shell.result = serde_json::json!({
        "output": {
            "success": {
                "stdout": format!("{}TAIL-SENTINEL", "x".repeat(80_000)),
                "exitCode": 7
            }
        }
    });
    shell.shell_replay = None;
    shell.shell_replay_bookmarks = None;

    let mut store = EventStore::new();
    store.set(vec![shell]);

    let stored = store.get_by_id("legacy-shell").unwrap();
    assert_eq!(stored.result, serde_json::json!({}));
    assert!(stored.args.get("streamOutput").is_none());
    assert_eq!(stored.args["shellExitCode"], 7);
    assert!(stored.shell_replay_bookmarks.is_none());
    let replay = stored.shell_replay.as_ref().unwrap();
    assert_eq!(replay.status, ShellReplayStatus::Incomplete);
    assert!(replay.completed_at.is_none());
    assert!(replay.terminal_preview.len() <= 32 * 1024);
    assert!(replay.terminal_preview.ends_with("TAIL-SENTINEL"));
    assert_eq!(replay.bookmark, ShellReplayBookmark::default());
}
