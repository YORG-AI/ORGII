use serde_json::{json, Value};

use crate::sources::imported_history::{self, ImportedToolCall};

use super::super::super::desktop_exec::normalize_codex_exec_tool_calls;
use super::super::super::normalize::{
    normalize_codex_tool_calls, normalize_tool_name_key, normalize_web_search_args,
};
use super::super::NATIVE_SOURCE_EVENT_ID_ARG;

pub(in crate::sources::codex::app::transcript) fn pending_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let mut arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .map(imported_history::parse_inner_json)
        .unwrap_or_else(|| json!({}));
    // `thread/inject_items` preserves the native response-item id supplied by
    // the materializer. Canonical tool calls injected through that supported
    // API must not be normalized a second time; ordinary Codex rollout tool
    // calls have only `call_id` in the currently supported transcript schema.
    if let Some(source_item_id) = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
    {
        if let Some(args) = arguments.as_object_mut() {
            args.insert(
                NATIVE_SOURCE_EVENT_ID_ARG.to_string(),
                Value::String(
                    source_item_id
                        .strip_suffix(":call")
                        .unwrap_or(source_item_id)
                        .to_string(),
                ),
            );
        }
        return Some((
            call_id.clone(),
            vec![ImportedToolCall {
                call_id,
                raw_name: raw_name.clone(),
                canonical_name: raw_name,
                args: arguments,
                created_at: created_at.to_string(),
            }],
        ));
    }
    let normalized_calls = normalize_codex_tool_calls(&raw_name, arguments);
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

pub(crate) fn pending_custom_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized_calls = if normalize_tool_name_key(&raw_name) == "exec" {
        normalize_codex_exec_tool_calls(input)
    } else {
        let args = if raw_name == "apply_patch" {
            json!({ "patch": input })
        } else {
            json!({ "input": input })
        };
        normalize_codex_tool_calls(&raw_name, args)
    };
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

pub(in crate::sources::codex::app::transcript) fn web_search_call_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = payload.get("id")?.as_str()?.to_string();
    let action = payload.get("action").cloned().unwrap_or_else(|| json!({}));
    Some(ImportedToolCall {
        call_id,
        raw_name: "web_search_call".to_string(),
        canonical_name: "web_search".to_string(),
        args: normalize_web_search_args(action),
        created_at: created_at.to_string(),
    })
}

fn split_call_id(call_id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        call_id.to_string()
    } else {
        format!("{call_id}:part-{index}")
    }
}
