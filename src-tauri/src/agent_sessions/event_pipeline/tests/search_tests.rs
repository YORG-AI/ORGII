use crate::agent_sessions::event_pipeline::search::{
    create_snippet, search_chat_events, ChatSearchOptions,
};
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

fn make_event(id: &str, function_name: &str, display_text: &str) -> SessionEvent {
    SessionEvent {
        id: id.to_string(),
        chunk_id: None,
        session_id: "test-session".to_string(),
        created_at: "2025-01-01T00:00:00Z".to_string(),
        function_name: function_name.to_string(),
        ui_canonical: function_name.to_string(),
        action_type: "tool_call".to_string(),
        args: serde_json::json!({}),
        result: serde_json::json!({}),
        source: EventSource::Assistant,
        display_text: display_text.to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Processed,
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
fn test_basic_search() {
    let events = vec![
        make_event("1", "read_file", "Reading config.ts"),
        make_event("2", "write_file", "Writing output.json"),
        make_event("3", "run_command", "npm install"),
    ];

    let options = ChatSearchOptions {
        query: "config".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].event_id, "1");
}

#[test]
fn test_case_insensitive() {
    let events = vec![make_event("1", "read_file", "Reading CONFIG.ts")];

    let options = ChatSearchOptions {
        query: "config".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 1);
}

#[test]
fn test_case_sensitive() {
    let events = vec![make_event("1", "read_file", "Reading CONFIG.ts")];

    let options = ChatSearchOptions {
        query: "config".to_string(),
        case_sensitive: true,
        use_regex: false,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 0);
}

#[test]
fn test_searches_args_and_result() {
    let mut event = make_event("1", "edit_file", "Editing");
    event.args = serde_json::json!({
        "file_path": "src/components/Button.tsx",
        "old_str": "const handleClick = () => {}",
    });
    event.result = serde_json::json!({
        "content": "Successfully edited Button component",
    });

    let options = ChatSearchOptions {
        query: "Button".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&[event], &options);
    assert_eq!(results.len(), 1);
}

#[test]
fn test_max_results() {
    let events: Vec<SessionEvent> = (0..200)
        .map(|i| {
            make_event(
                &format!("{}", i),
                "read_file",
                &format!("Reading file {}", i),
            )
        })
        .collect();

    let options = ChatSearchOptions {
        query: "file".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: 10,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 10);
}

#[test]
fn test_empty_query() {
    let events = vec![make_event("1", "read_file", "test")];

    let options = ChatSearchOptions {
        query: "  ".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert!(results.is_empty());
}

#[test]
fn test_regex_search() {
    let events = vec![
        make_event("1", "read_file", "Reading config.ts"),
        make_event("2", "read_file", "Reading config.json"),
        make_event("3", "read_file", "Reading data.csv"),
    ];

    let options = ChatSearchOptions {
        query: r"config\.\w+".to_string(),
        case_sensitive: false,
        use_regex: true,
        whole_word: false,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 2);
}

#[test]
fn test_whole_word() {
    let events = vec![
        make_event("1", "read_file", "Read the file"),
        make_event("2", "read_file", "Reading files"),
    ];

    let options = ChatSearchOptions {
        query: "file".to_string(),
        case_sensitive: false,
        use_regex: false,
        whole_word: true,
        max_results: 100,
    };

    let results = search_chat_events(&events, &options);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].event_id, "1");
}

#[test]
fn test_snippet_creation() {
    let snippet = create_snippet(
        "This is a long text with the keyword inside it",
        "keyword",
        false,
    );
    assert!(!snippet.is_empty());
    assert!(snippet.contains("keyword"));
}
