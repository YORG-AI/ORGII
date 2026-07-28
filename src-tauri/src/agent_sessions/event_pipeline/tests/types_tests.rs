use crate::agent_sessions::event_pipeline::types::*;

fn make_event(id: &str, action_type: &str) -> SessionEvent {
    SessionEvent {
        id: id.to_string(),
        chunk_id: Some(id.to_string()),
        session_id: "test-session".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        function_name: "test".to_string(),
        ui_canonical: "test".to_string(),
        action_type: action_type.to_string(),
        args: serde_json::json!({}),
        result: serde_json::json!({}),
        source: EventSource::Assistant,
        display_text: "test".to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::ToolCall,
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
fn test_session_event_serialization_roundtrip() {
    let event = make_event("evt-1", "tool_call");
    let json = serde_json::to_string(&event).unwrap();
    let deserialized: SessionEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.id, "evt-1");
    assert_eq!(deserialized.action_type, "tool_call");
}

#[test]
fn test_camel_case_field_names() {
    let event = make_event("evt-2", "assistant");
    let json_value: serde_json::Value = serde_json::to_value(&event).unwrap();
    assert!(json_value.get("sessionId").is_some());
    assert!(json_value.get("createdAt").is_some());
    assert!(json_value.get("functionName").is_some());
    assert!(json_value.get("uiCanonical").is_some());
    assert!(json_value.get("actionType").is_some());
    assert!(json_value.get("displayStatus").is_some());
    assert!(json_value.get("displayVariant").is_some());
    assert!(json_value.get("activityStatus").is_some());
    // snake_case should NOT exist
    assert!(json_value.get("session_id").is_none());
    assert!(json_value.get("created_at").is_none());
}

#[test]
fn test_enum_serialization() {
    let json = serde_json::to_string(&EventDisplayVariant::ToolCall).unwrap();
    assert_eq!(json, r#""tool_call""#);

    let json = serde_json::to_string(&EventDisplayStatus::Running).unwrap();
    assert_eq!(json, r#""running""#);

    let json = serde_json::to_string(&EventSource::Assistant).unwrap();
    assert_eq!(json, r#""assistant""#);

    let json = serde_json::to_string(&ActivityStatus::Agent).unwrap();
    assert_eq!(json, r#""agent""#);
}

#[test]
fn test_patch_apply() {
    let mut event = make_event("evt-3", "tool_call");
    assert_eq!(event.display_status, EventDisplayStatus::Completed);

    let patch = SessionEventPatch {
        display_status: Some(EventDisplayStatus::Failed),
        display_text: Some("failed operation".to_string()),
        ..Default::default()
    };
    patch.apply_to(&mut event);

    assert_eq!(event.display_status, EventDisplayStatus::Failed);
    assert_eq!(event.display_text, "failed operation");
    // Unchanged fields
    assert_eq!(event.action_type, "tool_call");
}

#[test]
fn test_optional_fields_skip_serialization() {
    let event = make_event("evt-4", "message");
    let json_value: serde_json::Value = serde_json::to_value(&event).unwrap();
    // Optional None fields should be absent from JSON
    assert!(json_value.get("threadId").is_none());
    assert!(json_value.get("callId").is_none());
    assert!(json_value.get("filePath").is_none());
    assert!(json_value.get("isDelta").is_none());
}
