//! Tests for event pagination.

use crate::agent_sessions::event_pipeline::pagination::*;
use crate::agent_sessions::event_pipeline::types::*;

fn make_event(id: &str, created_at: &str) -> SessionEvent {
    SessionEvent {
        id: id.to_string(),
        chunk_id: None,
        session_id: "sess-1".to_string(),
        created_at: created_at.to_string(),
        function_name: "read_file".to_string(),
        ui_canonical: "read_file".to_string(),
        action_type: "tool_call".to_string(),
        args: serde_json::json!({}),
        result: serde_json::json!({}),
        source: EventSource::Assistant,
        display_text: format!("Event {}", id),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: Some(format!("src/{}.ts", id)),
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

fn make_events(count: usize) -> Vec<SessionEvent> {
    (0..count)
        .map(|i| {
            make_event(
                &format!("evt-{}", i),
                &format!("2025-01-15T10:{:02}:00.000Z", i),
            )
        })
        .collect()
}

#[test]
fn test_basic_pagination_forward() {
    let events = make_events(10);
    let request = PaginationRequest {
        limit: 3,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters::default(),
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.events.len(), 3);
    assert_eq!(result.events[0].id, "evt-0");
    assert_eq!(result.events[2].id, "evt-2");
    assert!(result.has_more);
    assert!(result.next_cursor.is_some());
    assert!(result.prev_cursor.is_none());
    assert_eq!(result.total_matching, 10);
}

#[test]
fn test_pagination_with_cursor() {
    let events = make_events(10);
    let request = PaginationRequest {
        limit: 3,
        cursor: Some("evt-2".to_string()),
        direction: PaginationDirection::Forward,
        filters: EventFilters::default(),
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.events.len(), 3);
    assert_eq!(result.events[0].id, "evt-3");
    assert_eq!(result.events[2].id, "evt-5");
    assert!(result.has_more);
}

#[test]
fn test_pagination_backward() {
    let events = make_events(10);
    let request = PaginationRequest {
        limit: 3,
        cursor: Some("evt-5".to_string()),
        direction: PaginationDirection::Backward,
        filters: EventFilters::default(),
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.events.len(), 3);
    assert_eq!(result.events[0].id, "evt-2");
    assert_eq!(result.events[2].id, "evt-4");
}

#[test]
fn test_pagination_at_end() {
    let events = make_events(5);
    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters::default(),
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.events.len(), 5);
    assert!(!result.has_more);
    assert!(result.next_cursor.is_none());
}

#[test]
fn test_source_filter() {
    let mut events = make_events(4);
    events[0].source = EventSource::User;
    events[1].source = EventSource::Assistant;
    events[2].source = EventSource::User;
    events[3].source = EventSource::System;

    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters {
            source: Some(EventSource::User),
            ..Default::default()
        },
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.total_matching, 2);
}

#[test]
fn test_text_query_filter() {
    let mut events = make_events(3);
    events[0].display_text = "Reading main.ts file".to_string();
    events[1].display_text = "Writing to output.log".to_string();
    events[2].display_text = "Reading config.json file".to_string();

    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters {
            text_query: Some("reading".to_string()),
            ..Default::default()
        },
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.total_matching, 2);
}

#[test]
fn test_file_path_prefix_filter() {
    let mut events = make_events(4);
    events[0].file_path = Some("src/components/Button.tsx".to_string());
    events[1].file_path = Some("src/hooks/useAuth.ts".to_string());
    events[2].file_path = Some("src/components/Modal.tsx".to_string());
    events[3].file_path = None;

    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters {
            file_path_prefix: Some("src/components/".to_string()),
            ..Default::default()
        },
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.total_matching, 2);
}

#[test]
fn test_combined_filters() {
    let mut events = make_events(6);
    events[0].function_name = "read_file".to_string();
    events[0].source = EventSource::Assistant;
    events[1].function_name = "read_file".to_string();
    events[1].source = EventSource::User;
    events[2].function_name = "edit_file".to_string();
    events[2].source = EventSource::Assistant;
    events[3].function_name = "read_file".to_string();
    events[3].source = EventSource::Assistant;
    events[4].function_name = "read_file".to_string();
    events[4].source = EventSource::System;
    events[5].function_name = "shell_execute".to_string();
    events[5].source = EventSource::Assistant;

    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters {
            function_name: Some("read_file".to_string()),
            source: Some(EventSource::Assistant),
            ..Default::default()
        },
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.total_matching, 2);
}

#[test]
fn test_empty_events() {
    let events: Vec<SessionEvent> = Vec::new();
    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters::default(),
    };

    let result = paginate_events(&events, &request);
    assert!(result.events.is_empty());
    assert_eq!(result.total_matching, 0);
    assert!(!result.has_more);
}

#[test]
fn test_distinct_functions() {
    let mut events = make_events(4);
    events[0].function_name = "read_file".to_string();
    events[1].function_name = "edit_file".to_string();
    events[2].function_name = "read_file".to_string();
    events[3].function_name = "shell_execute".to_string();

    let functions = get_distinct_functions(&events);
    assert_eq!(functions.len(), 3);
    assert_eq!(functions[0].function_name, "read_file");
    assert_eq!(functions[0].count, 2);
}

#[test]
fn test_count_matching() {
    let mut events = make_events(5);
    events[0].function_name = "plan_tool".to_string();
    events[1].function_name = "run_tool".to_string();
    events[2].function_name = "run_tool".to_string();
    events[3].function_name = "plan_tool".to_string();
    events[4].function_name = "run_tool".to_string();

    let count = count_matching_events(
        &events,
        &EventFilters {
            function_name: Some("run_tool".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(count, 3);
}

#[test]
fn test_timestamp_range_filter() {
    let events = vec![
        make_event("evt-0", "2025-01-15T10:00:00.000Z"),
        make_event("evt-1", "2025-01-15T10:05:00.000Z"),
        make_event("evt-2", "2025-01-15T10:10:00.000Z"),
        make_event("evt-3", "2025-01-15T10:15:00.000Z"),
        make_event("evt-4", "2025-01-15T10:20:00.000Z"),
    ];

    let request = PaginationRequest {
        limit: 10,
        cursor: None,
        direction: PaginationDirection::Forward,
        filters: EventFilters {
            after_timestamp: Some("2025-01-15T10:05:00.000Z".to_string()),
            before_timestamp: Some("2025-01-15T10:15:00.000Z".to_string()),
            ..Default::default()
        },
    };

    let result = paginate_events(&events, &request);
    assert_eq!(result.total_matching, 3); // evt-1, evt-2, evt-3
}
