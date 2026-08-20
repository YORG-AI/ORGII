//! Pure builders for `SessionEvent` rows that the handler pushes into the
//! per-session `EventStore`. Kept side-effect-free so the unit-test surface
//! around event shape stays small and obvious.

use serde_json::Value;
use uuid::Uuid;

use core_types::cli_alias as alias_map;
use core_types::session_event::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

pub(super) fn build_assistant_message_event(session_id: &str, content: &str) -> SessionEvent {
    let event_id = format!("assistant-{}", Uuid::new_v4().simple());
    let mut event = SessionEvent {
        id: event_id.clone(),
        chunk_id: Some(event_id),
        session_id: session_id.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        function_name: "assistant".to_string(),
        ui_canonical: "agent_message".to_string(),
        action_type: "assistant".to_string(),
        args: Value::Object(serde_json::Map::new()),
        result: serde_json::json!({
            "content": content,
            "observation": content,
            "role": "assistant",
            "is_delta": false,
        }),
        source: EventSource::Assistant,
        display_text: content.to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: Some(false),
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

/// Build a `SessionEvent` for a tool_call.
///
/// Interactive tools (`is_interactive_tool`) start in `AwaitingUser` so the
/// generic `complete_last_running` paths can't flip them to `Completed`
/// prematurely — only `agent:interaction_finalized` (via `merge_events`)
/// transitions them out of `AwaitingUser`.
pub(super) fn build_tool_call_event(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    display_name: &str,
    args: &Value,
    repo_path: Option<&str>,
) -> SessionEvent {
    let file_path = extract_file_path(args);
    let repo_path = repo_path.map(ToString::to_string);
    let initial_status = if crate::core::tools::is_interactive_tool(tool_name) {
        EventDisplayStatus::AwaitingUser
    } else {
        EventDisplayStatus::Running
    };
    let mut event = SessionEvent {
        id: core_types::tool_names::tool_call_event_id(tool_call_id),
        chunk_id: None,
        session_id: session_id.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        function_name: tool_name.to_string(),
        ui_canonical: alias_map::get_ui_canonical(tool_name).to_string(),
        action_type: "tool_call".to_string(),
        args: args.clone(),
        result: Value::Null,
        source: EventSource::Assistant,
        display_text: display_name.to_string(),
        display_status: initial_status,
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: Some(tool_call_id.to_string()),
        file_path,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

fn extract_file_path(args: &Value) -> Option<String> {
    let object = args.as_object()?;
    ["file_path", "filePath", "target_file", "targetFile", "path"]
        .iter()
        .find_map(|key| object.get(*key)?.as_str())
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
}

/// Build a `SessionEvent` for a tool_result. The `merge_events` path in
/// `EventStore` folds this into the matching tool_call via `call_id`.
///
/// Always emits an `Object` result (`{content, observation}` or a richer
/// parsed JSON object). This is load-bearing for the interactive-tool
/// finalize pipeline: `EventStore::merge_events_with_hydration` merges
/// `result` field-by-field **only when both sides are objects** — its
/// fallback `(_, incoming) => incoming` arm replaces the target wholesale.
///
/// `agent:interaction_finalized` writes the structured payload first
/// (`{status, answers|choice, content, observation}`); then the generic
/// `on_tool_result` runs and pushes this event with the tool's textual
/// return value. If we emitted a `Value::String`, the fallback arm would
/// clobber `status`/`answers`/`choice` and the history card would render
/// "Questions skipped" / a wrong choice. Wrapping plain strings in
/// `{content, observation}` keeps the merge on the structured-merge path.
///
/// When the tool provided structured `ui_metadata` (dual-track response
/// pattern), it is embedded into the result object under `uiMetadata` so
/// extractors can consume exact structured data instead of re-parsing the
/// LLM-facing text.
pub(super) fn build_tool_result_event(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    display_name: &str,
    result: &str,
    ui_metadata: Option<&crate::tools::traits::ToolUIMetadata>,
) -> SessionEvent {
    // The bounded text returned by run_shell belongs in the LLM transcript,
    // which is persisted before this UI event is built. Copying it into both
    // `content` and `observation` (and then again into `extracted`) would keep
    // three 30 KiB strings per shell card in EventStore. Shell rendering uses
    // the durable replay ref/bookmark/preview instead, so its generic result is
    // intentionally metadata-only.
    let mut result_value = if tool_name == crate::tools::names::RUN_SHELL {
        serde_json::json!({ "shellReplayBacked": true })
    } else {
        match serde_json::from_str::<Value>(result) {
            Ok(Value::Object(object)) => Value::Object(object),
            _ => serde_json::json!({
                "content": result,
                "observation": result,
            }),
        }
    };

    if let Some(meta) = ui_metadata {
        if let Ok(meta_value) = serde_json::to_value(meta) {
            match &mut result_value {
                Value::Object(object) => {
                    object.insert("uiMetadata".to_string(), meta_value);
                }
                Value::String(text) => {
                    result_value = serde_json::json!({
                        "content": text,
                        "uiMetadata": meta_value,
                    });
                }
                _ => {}
            }
        }
    }

    SessionEvent {
        id: format!("tool-result-{}", tool_call_id),
        chunk_id: None,
        session_id: session_id.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        function_name: tool_name.to_string(),
        ui_canonical: alias_map::get_ui_canonical(tool_name).to_string(),
        action_type: "tool_result".to_string(),
        args: Value::Object(serde_json::Map::new()),
        result: result_value,
        source: EventSource::Assistant,
        display_text: display_name.to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Processed,
        thread_id: None,
        process_id: None,
        call_id: Some(tool_call_id.to_string()),
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
