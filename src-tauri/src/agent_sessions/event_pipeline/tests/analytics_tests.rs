//! Tests for the session analytics engine.

use crate::agent_sessions::event_pipeline::analytics::*;
use crate::agent_sessions::event_pipeline::types::*;

fn make_event(overrides: TestEventOverrides) -> SessionEvent {
    SessionEvent {
        id: overrides.id.unwrap_or_else(|| "evt-1".to_string()),
        chunk_id: None,
        session_id: overrides.session_id.unwrap_or_else(|| "sess-1".to_string()),
        created_at: overrides
            .created_at
            .unwrap_or_else(|| "2025-01-15T10:00:00.000Z".to_string()),
        function_name: overrides
            .function_name
            .clone()
            .unwrap_or_else(|| "read_file".to_string()),
        ui_canonical: overrides
            .function_name
            .unwrap_or_else(|| "read_file".to_string()),
        action_type: overrides
            .action_type
            .unwrap_or_else(|| "tool_call".to_string()),
        args: overrides.args.unwrap_or(serde_json::json!({})),
        result: overrides.result.unwrap_or(serde_json::json!({})),
        source: overrides.source.unwrap_or(EventSource::Assistant),
        display_text: overrides
            .display_text
            .unwrap_or_else(|| "Read file".to_string()),
        display_status: overrides
            .display_status
            .unwrap_or(EventDisplayStatus::Completed),
        display_variant: overrides
            .display_variant
            .unwrap_or(EventDisplayVariant::ToolCall),
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: overrides.file_path,
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

#[derive(Default)]
struct TestEventOverrides {
    id: Option<String>,
    session_id: Option<String>,
    created_at: Option<String>,
    function_name: Option<String>,
    action_type: Option<String>,
    args: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    source: Option<EventSource>,
    display_text: Option<String>,
    display_status: Option<EventDisplayStatus>,
    display_variant: Option<EventDisplayVariant>,
    file_path: Option<String>,
}

#[test]
fn test_empty_events() {
    let analytics = compute_session_analytics(&[]);
    assert_eq!(analytics.total_events, 0);
    assert_eq!(analytics.duration_ms, 0);
    assert!(analytics.tool_usage.is_empty());
}

#[test]
fn test_basic_tool_counting() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            function_name: Some("read_file".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            function_name: Some("read_file".into()),
            created_at: Some("2025-01-15T10:00:01.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("3".into()),
            function_name: Some("edit_file".into()),
            created_at: Some("2025-01-15T10:00:02.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.total_events, 3);
    assert_eq!(analytics.tool_usage.len(), 2);

    let read_tool = analytics
        .tool_usage
        .iter()
        .find(|t| t.function_name == "read_file")
        .unwrap();
    assert_eq!(read_tool.call_count, 2);
    assert_eq!(read_tool.completed_count, 2);

    let edit_tool = analytics
        .tool_usage
        .iter()
        .find(|t| t.function_name == "edit_file")
        .unwrap();
    assert_eq!(edit_tool.call_count, 1);
}

#[test]
fn test_duration_calculation() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            created_at: Some("2025-01-15T10:05:00.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.duration_ms, 300_000); // 5 minutes
}

#[test]
fn test_file_changes() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            function_name: Some("read_file".into()),
            file_path: Some("src/main.ts".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            function_name: Some("edit_file_by_replace".into()),
            file_path: Some("src/main.ts".into()),
            created_at: Some("2025-01-15T10:00:01.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("3".into()),
            function_name: Some("read_file".into()),
            file_path: Some("src/utils.ts".into()),
            created_at: Some("2025-01-15T10:00:02.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.file_changes.total_files, 2);
    assert!(!analytics.file_changes.top_files.is_empty());

    let main_file = analytics
        .file_changes
        .top_files
        .iter()
        .find(|f| f.file_path == "src/main.ts")
        .unwrap();
    assert_eq!(main_file.touch_count, 2);
}

#[test]
fn test_conversation_stats() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            source: Some(EventSource::User),
            display_variant: Some(EventDisplayVariant::Message),
            display_text: Some("Hello, fix the bug".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            source: Some(EventSource::Assistant),
            display_variant: Some(EventDisplayVariant::Thinking),
            display_text: Some("Let me analyze...".into()),
            created_at: Some("2025-01-15T10:00:02.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("3".into()),
            source: Some(EventSource::Assistant),
            display_variant: Some(EventDisplayVariant::Message),
            display_text: Some("I found the issue and fixed it.".into()),
            created_at: Some("2025-01-15T10:00:05.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.conversation_stats.user_message_count, 1);
    assert_eq!(analytics.conversation_stats.assistant_message_count, 1);
    assert_eq!(analytics.conversation_stats.thinking_event_count, 1);
    assert_eq!(analytics.conversation_stats.avg_response_time_ms, 5000); // 5 seconds
}

#[test]
fn test_error_tracking() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            function_name: Some("shell_execute".into()),
            display_status: Some(EventDisplayStatus::Failed),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            function_name: Some("read_file".into()),
            display_status: Some(EventDisplayStatus::Completed),
            created_at: Some("2025-01-15T10:00:01.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("3".into()),
            function_name: Some("shell_execute".into()),
            display_variant: Some(EventDisplayVariant::Error),
            created_at: Some("2025-01-15T10:00:02.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.error_stats.total_failures, 1);
    assert_eq!(analytics.error_stats.total_errors, 1);
    assert!(analytics.error_stats.error_rate > 0.0);
}

#[test]
fn test_timeline_buckets() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            created_at: Some("2025-01-15T10:15:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("3".into()),
            created_at: Some("2025-01-15T10:30:00.000Z".into()),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert!(!analytics.timeline_buckets.is_empty());
    let total_events: usize = analytics
        .timeline_buckets
        .iter()
        .map(|b| b.event_count)
        .sum();
    assert_eq!(total_events, 3);
}

#[test]
fn test_parse_iso_ms() {
    let ms = parse_iso_ms("2025-01-15T10:30:00.000Z");
    assert!(ms > 0);

    let ms2 = parse_iso_ms("2025-01-15T10:30:01.000Z");
    assert_eq!(ms2 - ms, 1000);

    let ms3 = parse_iso_ms("2025-01-15T11:30:00.000Z");
    assert_eq!(ms3 - ms, 3_600_000);
}

#[test]
fn test_multi_session_analytics() {
    let session_a = vec![
        make_event(TestEventOverrides {
            id: Some("a1".into()),
            session_id: Some("sess-a".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("a2".into()),
            session_id: Some("sess-a".into()),
            created_at: Some("2025-01-15T10:05:00.000Z".into()),
            ..Default::default()
        }),
    ];

    let session_b = vec![make_event(TestEventOverrides {
        id: Some("b1".into()),
        session_id: Some("sess-b".into()),
        created_at: Some("2025-01-15T11:00:00.000Z".into()),
        ..Default::default()
    })];

    let sessions = vec![
        ("sess-a".to_string(), session_a),
        ("sess-b".to_string(), session_b),
    ];

    let summary = compute_multi_session_analytics(&sessions);
    assert_eq!(summary.session_count, 2);
    assert_eq!(summary.total_events, 3);
    assert_eq!(summary.sessions.len(), 2);
}

#[test]
fn test_token_extraction() {
    let events = vec![
        make_event(TestEventOverrides {
            id: Some("1".into()),
            created_at: Some("2025-01-15T10:00:00.000Z".into()),
            result: Some(serde_json::json!({
                "usage": {
                    "input_tokens": 1500,
                    "output_tokens": 800
                },
                "model": "claude-3.5-sonnet"
            })),
            ..Default::default()
        }),
        make_event(TestEventOverrides {
            id: Some("2".into()),
            created_at: Some("2025-01-15T10:00:01.000Z".into()),
            result: Some(serde_json::json!({
                "usage": {
                    "prompt_tokens": 500,
                    "completion_tokens": 200
                },
                "model": "gpt-4"
            })),
            ..Default::default()
        }),
    ];

    let analytics = compute_session_analytics(&events);
    assert_eq!(analytics.token_stats.total_input_tokens, 2000);
    assert_eq!(analytics.token_stats.total_output_tokens, 1000);
    assert_eq!(analytics.token_stats.by_model.len(), 2);
}
