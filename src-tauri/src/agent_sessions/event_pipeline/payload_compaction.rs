use crate::agent_sessions::event_pipeline::types::{PayloadRef, SessionEvent};
use core_types::extracted::ExtractedData;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const PAYLOAD_COMPACTION_THRESHOLD_BYTES: usize = 64 * 1024;
const PAYLOAD_PREVIEW_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPayloadBody {
    pub event_id: String,
    pub field_path: String,
    pub body: String,
    pub full_size_bytes: usize,
}

const ARGS_STRING_PAYLOAD_FIELDS: &[&str] = &[
    "args.streamOutput",
    "args.streamContent",
    "args.content",
    "args.patch",
    "args.patch_text",
    "args.patchText",
    "args.oldContent",
    "args.old_content",
    "args.newContent",
    "args.new_content",
];

const RESULT_STRING_PAYLOAD_FIELDS: &[&str] = &[
    "result.content",
    "result.observation",
    "result.output",
    "result.output.stdout",
    "result.output.stderr",
    "result.error",
    "result.stdout",
    "result.stderr",
    "result.interleavedOutput",
    "result.interleaved_output",
    "result.diff",
    "result.diffString",
    "result.patch",
    "result.patch_text",
    "result.patchText",
    "result.snapshot",
    "result.domSnapshot",
    "result.dom_snapshot",
    "result.screenshot",
    "result.image",
    "result.html",
    "result.markdown",
    "result.body",
    "result.text",
];

pub fn compact_event_for_snapshot(event: &SessionEvent) -> SessionEvent {
    let mut compacted = event.clone();
    let mut refs = Vec::new();

    for field_path in ARGS_STRING_PAYLOAD_FIELDS {
        compact_json_string_field(&mut compacted.args, &event.id, field_path, &mut refs);
    }
    for field_path in RESULT_STRING_PAYLOAD_FIELDS {
        compact_json_string_field(&mut compacted.result, &event.id, field_path, &mut refs);
    }

    compact_display_text(&mut compacted, &mut refs);
    compact_extracted(&mut compacted, &mut refs);

    compacted.payload_refs = refs;
    compacted
}

pub fn load_event_payload_body(event: &SessionEvent, field_path: &str) -> Option<EventPayloadBody> {
    let body = payload_string(event, field_path)?;

    let full_size_bytes = body.len();
    Some(EventPayloadBody {
        event_id: event.id.clone(),
        field_path: field_path.to_string(),
        body,
        full_size_bytes,
    })
}

pub fn is_compacted_event(event: &SessionEvent) -> bool {
    !event.payload_refs.is_empty()
}

fn compact_display_text(event: &mut SessionEvent, refs: &mut Vec<PayloadRef>) {
    if event.display_text.len() <= PAYLOAD_COMPACTION_THRESHOLD_BYTES {
        return;
    }
    let preview = preview_text(&event.display_text);
    refs.push(PayloadRef {
        event_id: event.id.clone(),
        field_path: "displayText".to_string(),
        preview: preview.clone(),
        full_size_bytes: event.display_text.len(),
        truncated: true,
        replay_source_id: None,
        replay_generation: None,
        replay_source_event_id: None,
    });
    event.display_text = preview;
}

fn compact_json_string_field(
    root: &mut Value,
    event_id: &str,
    field_path: &str,
    refs: &mut Vec<PayloadRef>,
) {
    let keys = field_path.split('.').skip(1).collect::<Vec<_>>();
    let Some(Value::String(value)) = json_value_at_mut(root, &keys) else {
        return;
    };
    compact_string_value(value, event_id, field_path, refs);
}

fn json_value_at_mut<'a>(root: &'a mut Value, keys: &[&str]) -> Option<&'a mut Value> {
    let mut current = root;
    for key in keys {
        current = current.as_object_mut()?.get_mut(*key)?;
    }
    Some(current)
}

fn compact_string_value(
    value: &mut String,
    event_id: &str,
    field_path: &str,
    refs: &mut Vec<PayloadRef>,
) {
    if value.len() <= PAYLOAD_COMPACTION_THRESHOLD_BYTES {
        return;
    }
    let preview = preview_text(value);
    refs.push(PayloadRef {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        preview: preview.clone(),
        full_size_bytes: value.len(),
        truncated: true,
        replay_source_id: None,
        replay_generation: None,
        replay_source_event_id: None,
    });
    *value = preview;
}

fn compact_extracted(event: &mut SessionEvent, refs: &mut Vec<PayloadRef>) {
    let Some(extracted) = event.extracted.as_mut() else {
        return;
    };

    match extracted {
        ExtractedData::Shell(data) => {
            compact_optional_string(&mut data.output, &event.id, "extracted.shell.output", refs);
            compact_optional_string(
                &mut data.stream_output,
                &event.id,
                "extracted.shell.streamOutput",
                refs,
            );
        }
        ExtractedData::File(data) => {
            compact_optional_string(&mut data.content, &event.id, "extracted.file.content", refs);
        }
        ExtractedData::Edit(data) => {
            compact_optional_string(&mut data.content, &event.id, "extracted.edit.content", refs);
            compact_optional_string(
                &mut data.old_content,
                &event.id,
                "extracted.edit.oldContent",
                refs,
            );
            compact_optional_string(
                &mut data.new_content,
                &event.id,
                "extracted.edit.newContent",
                refs,
            );
            compact_optional_string(&mut data.diff, &event.id, "extracted.edit.diff", refs);
            for segment in data.apply_patch_segments.iter_mut() {
                compact_optional_string(
                    &mut segment.content,
                    &event.id,
                    "extracted.edit.content",
                    refs,
                );
                compact_optional_string(
                    &mut segment.old_content,
                    &event.id,
                    "extracted.edit.oldContent",
                    refs,
                );
                compact_optional_string(
                    &mut segment.new_content,
                    &event.id,
                    "extracted.edit.newContent",
                    refs,
                );
                compact_optional_string(&mut segment.diff, &event.id, "extracted.edit.diff", refs);
            }
        }
        ExtractedData::Message(data) => {
            compact_optional_string(
                &mut data.content,
                &event.id,
                "extracted.message.content",
                refs,
            );
        }
        ExtractedData::Subagent(data) => {
            compact_string_value(
                &mut data.result_content,
                &event.id,
                "extracted.subagent.resultContent",
                refs,
            );
            compact_optional_string(
                &mut data.prompt,
                &event.id,
                "extracted.subagent.prompt",
                refs,
            );
            compact_optional_string(
                &mut data.reasoning_text,
                &event.id,
                "extracted.subagent.reasoningText",
                refs,
            );
        }
        _ => {}
    }
}

fn compact_optional_string(
    value: &mut Option<String>,
    event_id: &str,
    field_path: &str,
    refs: &mut Vec<PayloadRef>,
) {
    let Some(text) = value.as_mut() else {
        return;
    };
    compact_string_value(text, event_id, field_path, refs);
}

fn payload_string(event: &SessionEvent, field_path: &str) -> Option<String> {
    if field_path == "displayText" {
        return Some(event.display_text.clone());
    }
    if let Some(path) = field_path.strip_prefix("args.") {
        let keys = path.split('.').collect::<Vec<_>>();
        return json_string_at(&event.args, &keys);
    }
    if let Some(path) = field_path.strip_prefix("result.") {
        let keys = path.split('.').collect::<Vec<_>>();
        return json_string_at(&event.result, &keys);
    }
    if field_path.starts_with("extracted.") {
        return extracted_string(event, field_path);
    }
    None
}

fn json_string_at(root: &Value, path: &[&str]) -> Option<String> {
    let mut current = root;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn extracted_string(event: &SessionEvent, field_path: &str) -> Option<String> {
    let value = serde_json::to_value(event.extracted.as_ref()?).ok()?;
    let path = field_path.strip_prefix("extracted.")?;
    let mut current = &value;
    for key in path.split('.') {
        current = get_camel_or_snake(current, key)?;
    }
    current.as_str().map(str::to_string)
}

fn get_camel_or_snake<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let object: &Map<String, Value> = value.as_object()?;
    object.get(key).or_else(|| object.get(&camel_to_snake(key)))
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 4);
    for char_value in value.chars() {
        if char_value.is_uppercase() {
            output.push('_');
            output.extend(char_value.to_lowercase());
        } else {
            output.push(char_value);
        }
    }
    output.trim_start_matches('_').to_string()
}

fn preview_text(value: &str) -> String {
    let mut end = PAYLOAD_PREVIEW_BYTES.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut preview = value[..end].to_string();
    preview.push_str("\n... (payload truncated; load full output to view more)");
    preview
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::event_pipeline::types::{
        ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource,
    };

    fn make_large_event() -> SessionEvent {
        SessionEvent {
            id: "event-1".to_string(),
            chunk_id: Some("event-1".to_string()),
            session_id: "session-1".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            function_name: "run_shell".to_string(),
            ui_canonical: "run_shell".to_string(),
            action_type: "tool_call".to_string(),
            args: serde_json::json!({ "streamOutput": "x".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 1) }),
            result: serde_json::json!({ "content": "y".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 2) }),
            source: EventSource::Assistant,
            display_text: "short".to_string(),
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
    fn compacts_large_json_payloads_and_preserves_original() {
        let event = make_large_event();
        let compacted = compact_event_for_snapshot(&event);

        assert_eq!(event.payload_refs.len(), 0);
        assert_eq!(compacted.payload_refs.len(), 2);
        assert!(
            compacted.args["streamOutput"].as_str().unwrap().len()
                < event.args["streamOutput"].as_str().unwrap().len()
        );
        assert!(
            compacted.result["content"].as_str().unwrap().len()
                < event.result["content"].as_str().unwrap().len()
        );
    }

    #[test]
    fn loads_original_body_from_full_event() {
        let event = make_large_event();
        let body = load_event_payload_body(&event, "result.content").unwrap();

        assert_eq!(body.event_id, "event-1");
        assert_eq!(body.field_path, "result.content");
        assert_eq!(body.body.len(), PAYLOAD_COMPACTION_THRESHOLD_BYTES + 2);
    }

    #[test]
    fn compacts_large_patch_and_browser_payloads() {
        let mut event = make_large_event();
        event.args = serde_json::json!({
            "patch_text": "p".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 3),
        });
        event.result = serde_json::json!({
            "domSnapshot": "d".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 4),
            "diffString": "f".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 5),
        });

        let compacted = compact_event_for_snapshot(&event);
        let field_paths = compacted
            .payload_refs
            .iter()
            .map(|payload_ref| payload_ref.field_path.as_str())
            .collect::<Vec<_>>();

        assert!(field_paths.contains(&"args.patch_text"));
        assert!(field_paths.contains(&"result.domSnapshot"));
        assert!(field_paths.contains(&"result.diffString"));
        assert_eq!(
            load_event_payload_body(&event, "result.domSnapshot")
                .unwrap()
                .body
                .len(),
            PAYLOAD_COMPACTION_THRESHOLD_BYTES + 4
        );
    }

    #[test]
    fn compacts_nested_json_payload_paths() {
        let mut event = make_large_event();
        event.result = serde_json::json!({
            "output": {
                "stdout": "s".repeat(PAYLOAD_COMPACTION_THRESHOLD_BYTES + 6),
            },
        });

        let compacted = compact_event_for_snapshot(&event);

        assert!(compacted
            .payload_refs
            .iter()
            .any(|payload_ref| payload_ref.field_path == "result.output.stdout"));
        assert!(
            compacted.result["output"]["stdout"].as_str().unwrap().len()
                < event.result["output"]["stdout"].as_str().unwrap().len()
        );
        assert_eq!(
            load_event_payload_body(&event, "result.output.stdout")
                .unwrap()
                .body
                .len(),
            PAYLOAD_COMPACTION_THRESHOLD_BYTES + 6
        );
    }
}
