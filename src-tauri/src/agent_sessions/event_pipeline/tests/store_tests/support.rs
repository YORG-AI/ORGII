use crate::agent_sessions::event_pipeline::types::*;

pub(super) fn make_event(id: &str, action_type: &str) -> SessionEvent {
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

pub(super) fn make_tool_call(id: &str, call_id: &str) -> SessionEvent {
    let mut event = make_event(id, "tool_call");
    event.call_id = Some(call_id.to_string());
    event.display_status = EventDisplayStatus::Running;
    event.args = serde_json::json!({ "command": "ls", "streamOutput": "..." });
    event
}

pub(super) fn make_tool_result(id: &str, call_id: &str) -> SessionEvent {
    let mut event = make_event(id, "tool_result");
    event.call_id = Some(call_id.to_string());
    event.result = serde_json::json!({ "content": "file1.txt\nfile2.txt" });
    event
}

pub(super) fn make_running_event(id: &str) -> SessionEvent {
    let mut event = make_event(id, "message");
    event.display_status = EventDisplayStatus::Running;
    event
}

pub(super) fn make_task_tool_call(id: &str) -> SessionEvent {
    let mut event = make_event(id, "tool_call");
    event.function_name = "task".to_string();
    event.display_status = EventDisplayStatus::Running;
    event.args = serde_json::json!({ "description": "explore codebase" });
    event
}

pub(super) fn make_shell_tool_call(id: &str) -> SessionEvent {
    let mut event = make_event(id, "tool_call");
    event.function_name = "run_shell".to_string();
    event.ui_canonical = "run_shell".to_string();
    event.call_id = Some(format!("call-{id}"));
    event.display_status = EventDisplayStatus::Running;
    event.args = serde_json::json!({ "command": "ls" });
    event
}

pub(super) fn make_awaiting_user_event(id: &str) -> SessionEvent {
    let mut event = make_event(id, "tool_call");
    event.function_name = "ask_user_questions".to_string();
    event.display_status = EventDisplayStatus::AwaitingUser;
    event
}

pub(super) fn replay_state(
    call_id: &str,
    sequence: u64,
    visible_bytes: u64,
    status: ShellReplayStatus,
) -> ShellReplayState {
    ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: "test-session".to_string(),
            call_id: call_id.to_string(),
            format_version: 1,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: sequence,
            visible_bytes,
        },
        terminal_preview: format!("preview-{sequence}"),
        status,
        error: None,
        completed_at: None,
    }
}

pub(super) fn make_user_turn_header(turn_id: &str, created_at: &str) -> SessionEvent {
    let mut event = make_event(turn_id, "raw");
    event.function_name = "user_message".to_string();
    event.ui_canonical = "user_message".to_string();
    event.source = EventSource::User;
    event.display_variant = EventDisplayVariant::Message;
    event.created_at = created_at.to_string();
    event
}

pub(super) fn make_turn_placeholder(turn_id: &str, next_turn_id: Option<&str>) -> SessionEvent {
    let mut event = make_event(&format!("turn-placeholder-{turn_id}"), "turn_placeholder");
    event.function_name = "turn_placeholder".to_string();
    event.ui_canonical = "turn_placeholder".to_string();
    event.result = serde_json::json!({
        "unloadedTurn": {
            "turnId": turn_id,
            "bodyEventCount": 2,
            "nextTurnId": next_turn_id,
        }
    });
    event
}
