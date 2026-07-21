use crate::agent_sessions::event_pipeline::ingestion::tool_call_merger::merge_tool_call_pairs;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

fn make_event(id: &str, action_type: &str, call_id: Option<&str>) -> SessionEvent {
    SessionEvent {
        id: id.to_string(),
        chunk_id: Some(id.to_string()),
        session_id: "sess-1".to_string(),
        created_at: "2025-01-15T10:30:00.000Z".to_string(),
        function_name: "read_file".to_string(),
        ui_canonical: "read_file".to_string(),
        action_type: action_type.to_string(),
        args: serde_json::json!({}),
        result: serde_json::json!({}),
        source: EventSource::Assistant,
        display_text: "read_file".to_string(),
        display_status: EventDisplayStatus::Running,
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: call_id.map(|s| s.to_string()),
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
fn test_merge_start_end_pair() {
    let mut start = make_event("start-1", "tool_call", Some("call-001"));
    start.args = serde_json::json!({"file_path": "/src/main.rs"});
    start.file_path = Some("/src/main.rs".to_string());

    let mut end = make_event("end-1", "tool_result", Some("call-001"));
    end.result = serde_json::json!({"content": "fn main() {}"});
    end.display_status = EventDisplayStatus::Completed;

    let events = vec![start, end];
    let result = merge_tool_call_pairs(events);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].display_status, EventDisplayStatus::Completed);
    assert_eq!(result[0].file_path, Some("/src/main.rs".to_string()));
    assert!(result[0]
        .result
        .as_object()
        .unwrap()
        .contains_key("content"));
    assert!(result[0]
        .args
        .as_object()
        .unwrap()
        .contains_key("file_path"));
}

#[test]
fn test_no_merge_without_call_id() {
    let event1 = make_event("evt-1", "tool_call", None);
    let event2 = make_event("evt-2", "tool_result", None);

    let events = vec![event1, event2];
    let result = merge_tool_call_pairs(events);

    assert_eq!(result.len(), 2);
}

#[test]
fn test_preserves_non_tool_events() {
    let mut msg = make_event("msg-1", "assistant", None);
    msg.display_variant = EventDisplayVariant::Message;

    let mut start = make_event("start-1", "tool_call", Some("call-001"));
    start.args = serde_json::json!({"command": "ls"});

    let mut end = make_event("end-1", "tool_result", Some("call-001"));
    end.result = serde_json::json!({"output": "file1\nfile2"});
    end.display_status = EventDisplayStatus::Completed;

    let events = vec![msg.clone(), start, end];
    let result = merge_tool_call_pairs(events);

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].display_variant, EventDisplayVariant::Message);
    assert_eq!(result[1].display_status, EventDisplayStatus::Completed);
}

#[test]
fn test_single_tool_call_no_merge() {
    let event = make_event("single-1", "tool_call", Some("call-002"));
    let events = vec![event];
    let result = merge_tool_call_pairs(events);
    assert_eq!(result.len(), 1);
}

#[test]
fn test_merge_preserves_order() {
    let msg1 = {
        let mut e = make_event("msg-1", "assistant", None);
        e.display_variant = EventDisplayVariant::Message;
        e
    };

    let mut start = make_event("start-1", "tool_call", Some("call-001"));
    start.args = serde_json::json!({"file_path": "/a.rs"});

    let msg2 = {
        let mut e = make_event("msg-2", "assistant", None);
        e.display_variant = EventDisplayVariant::Message;
        e
    };

    let mut end = make_event("end-1", "tool_result", Some("call-001"));
    end.result = serde_json::json!({"content": "data"});
    end.display_status = EventDisplayStatus::Completed;

    let events = vec![msg1, start, msg2, end];
    let result = merge_tool_call_pairs(events);

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].id, "msg-1");
    assert_eq!(result[1].call_id, Some("call-001".to_string()));
    assert_eq!(result[1].display_status, EventDisplayStatus::Completed);
    assert_eq!(result[2].id, "msg-2");
}

#[test]
fn test_merge_takes_end_file_path_if_start_missing() {
    let start = make_event("start-1", "tool_call", Some("call-003"));
    let mut end = make_event("end-1", "tool_result", Some("call-003"));
    end.result = serde_json::json!({"success": true});
    end.file_path = Some("/result/path.rs".to_string());
    end.display_status = EventDisplayStatus::Completed;

    let events = vec![start, end];
    let result = merge_tool_call_pairs(events);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].file_path, Some("/result/path.rs".to_string()));
}
