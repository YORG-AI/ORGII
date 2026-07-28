use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::*;

use super::support::*;

#[test]
fn test_find_last_spawning_tool() {
    let mut store = EventStore::new();
    store.set(vec![
        make_task_tool_call("task-1"),
        make_event("msg-1", "message"),
    ]);
    assert_eq!(store.find_last_spawning_tool(&["task"]), Some(0));
}

#[test]
fn test_find_last_spawning_tool_none() {
    let mut store = EventStore::new();
    store.set(vec![make_event("msg-1", "message")]);
    assert!(store.find_last_spawning_tool(&["task"]).is_none());
}

#[test]
fn test_find_last_spawning_tool_stops_at_result() {
    let mut store = EventStore::new();
    let mut task_call = make_task_tool_call("task-1");
    task_call.action_type = "tool_call".to_string();
    let mut task_result = make_event("task-r", "tool_result");
    task_result.function_name = "task".to_string();
    store.set(vec![task_call, task_result, make_event("msg-1", "message")]);
    assert!(store.find_last_spawning_tool(&["task"]).is_none());
}

#[test]
fn test_has_active_spawning_tool() {
    let mut store = EventStore::new();
    store.set(vec![make_task_tool_call("task-1")]);
    assert!(store.has_active_spawning_tool(&["task"]));
    assert!(!store.has_active_spawning_tool(&["session"]));
}

// ============================================================================
// cancel_orphan_interactive_events tests
// ============================================================================

#[test]
fn test_cancel_orphan_interactive_events_cancels_awaiting_user() {
    let mut store = EventStore::new();
    let mut orphan = make_tool_call("ask-1", "call-ask-1");
    orphan.display_status = EventDisplayStatus::AwaitingUser;
    store.set(vec![make_event("msg-1", "message"), orphan]);

    let cancelled = store.cancel_orphan_interactive_events();

    assert_eq!(cancelled, vec!["ask-1".to_string()]);
    let event = store.get_by_id("ask-1").unwrap();
    assert_eq!(event.display_status, EventDisplayStatus::Completed);
    assert_eq!(event.result["status"], "cancelled");
}

#[test]
fn test_cancel_orphan_interactive_events_leaves_running_untouched() {
    let mut store = EventStore::new();
    let running = make_tool_call("run-1", "call-run-1");
    store.set(vec![running]);

    let cancelled = store.cancel_orphan_interactive_events();

    assert!(cancelled.is_empty());
    let event = store.get_by_id("run-1").unwrap();
    assert_eq!(event.display_status, EventDisplayStatus::Running);
}

#[test]
fn test_cancel_orphan_interactive_events_mixed() {
    let mut store = EventStore::new();
    let running = make_tool_call("run-1", "call-run-1");
    let mut awaiting1 = make_tool_call("ask-1", "call-ask-1");
    awaiting1.display_status = EventDisplayStatus::AwaitingUser;
    let mut awaiting2 = make_tool_call("ask-2", "call-ask-2");
    awaiting2.display_status = EventDisplayStatus::AwaitingUser;
    // A pre-completed event (not AwaitingUser, not Running).
    let mut already_done = make_event("done-1", "tool_call");
    already_done.display_status = EventDisplayStatus::Completed;
    store.set(vec![running, awaiting1, awaiting2, already_done]);

    let cancelled = store.cancel_orphan_interactive_events();

    assert_eq!(cancelled.len(), 2);
    assert!(cancelled.contains(&"ask-1".to_string()));
    assert!(cancelled.contains(&"ask-2".to_string()));
    // running stays Running
    assert_eq!(
        store.get_by_id("run-1").unwrap().display_status,
        EventDisplayStatus::Running
    );
    // pre-completed stays Completed with original empty result
    assert_eq!(
        store.get_by_id("done-1").unwrap().display_status,
        EventDisplayStatus::Completed
    );
    assert!(store
        .get_by_id("done-1")
        .unwrap()
        .result
        .as_object()
        .unwrap()
        .is_empty());
}
