mod claude;
mod codex;

use std::path::Path;

use serde_json::Value;

use crate::semantic::{NativeSemanticEvent, NativeSemanticGroup};
use crate::{
    NativeConversationRuntime, NativeMaterializationError, NativeMaterializationResult,
    NativeRuntimeTarget,
};

pub(crate) const MAX_NATIVE_TRANSCRIPT_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_NATIVE_TRANSCRIPT_RECORDS: usize = 100_000;

pub(crate) struct NativeFormatContext<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) workspace: &'a Path,
    pub(crate) cli_version: &'a str,
    pub(crate) target: &'a NativeRuntimeTarget,
    pub(crate) created_at: &'a str,
}

pub(crate) fn serialize_native(
    context: &NativeFormatContext<'_>,
    groups: &[NativeSemanticGroup],
) -> NativeMaterializationResult<Vec<u8>> {
    match context.target {
        NativeRuntimeTarget::ClaudeCode { .. } => claude::serialize(context, groups),
        NativeRuntimeTarget::Codex { .. } => codex::serialize(context, groups),
    }
}

/// Reparse through the target-side native reader. This intentionally does not
/// share wire structs with either writer.
pub(crate) fn reparse_native(
    runtime: NativeConversationRuntime,
    bytes: &[u8],
    context: &NativeFormatContext<'_>,
) -> NativeMaterializationResult<Vec<NativeSemanticGroup>> {
    match runtime {
        NativeConversationRuntime::ClaudeCode => claude::reparse(bytes, context),
        NativeConversationRuntime::Codex => codex::reparse(bytes, context),
    }
}

pub(crate) fn appended_first_user_turn(
    runtime: NativeConversationRuntime,
    appended: &[u8],
    expected_session_id: &str,
) -> NativeMaterializationResult<Option<String>> {
    match runtime {
        NativeConversationRuntime::ClaudeCode => {
            claude::appended_first_user_turn(appended, expected_session_id)
        }
        NativeConversationRuntime::Codex => codex::appended_first_user_turn(appended),
    }
}

pub(crate) fn encode_jsonl(records: Vec<Value>) -> NativeMaterializationResult<Vec<u8>> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, &record).map_err(|error| {
            NativeMaterializationError::parity(format!(
                "Failed to encode native JSONL record: {error}"
            ))
        })?;
        bytes.push(b'\n');
        if bytes.len() > MAX_NATIVE_TRANSCRIPT_BYTES {
            return Err(NativeMaterializationError::unsupported_semantics(format!(
                "Native transcript exceeds the {MAX_NATIVE_TRANSCRIPT_BYTES}-byte safety limit"
            )));
        }
    }
    Ok(bytes)
}

pub(crate) fn parse_jsonl(bytes: &[u8]) -> NativeMaterializationResult<Vec<Value>> {
    if bytes.len() > MAX_NATIVE_TRANSCRIPT_BYTES {
        return Err(NativeMaterializationError::parity(format!(
            "Native transcript exceeds the {MAX_NATIVE_TRANSCRIPT_BYTES}-byte safety limit"
        )));
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(NativeMaterializationError::parity(
            "Native transcript is not newline-terminated JSONL",
        ));
    }
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let payload = &bytes[..bytes.len() - 1];
    if payload.is_empty() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for (index, line) in payload.split(|byte| *byte == b'\n').enumerate() {
        if line.is_empty() {
            return Err(NativeMaterializationError::parity(format!(
                "Native transcript contains an empty JSONL record at line {}",
                index + 1
            )));
        }
        if records.len() == MAX_NATIVE_TRANSCRIPT_RECORDS {
            return Err(NativeMaterializationError::parity(format!(
                "Native transcript exceeds the {MAX_NATIVE_TRANSCRIPT_RECORDS}-record safety limit"
            )));
        }
        let value = serde_json::from_slice::<Value>(line).map_err(|error| {
            NativeMaterializationError::parity(format!(
                "Native transcript line {} is invalid JSON: {error}",
                index + 1
            ))
        })?;
        if !value.is_object() {
            return Err(NativeMaterializationError::parity(format!(
                "Native transcript line {} is not an object",
                index + 1
            )));
        }
        records.push(value);
    }
    Ok(records)
}

pub(crate) fn infer_tool_states(
    groups: &mut [NativeSemanticGroup],
) -> NativeMaterializationResult<()> {
    use std::collections::HashSet;

    let mut results = HashSet::new();
    for event in groups.iter().flat_map(|group| group.events.iter()) {
        if let NativeSemanticEvent::ToolResult { call_id, .. } = event {
            if !results.insert(call_id.clone()) {
                return Err(NativeMaterializationError::parity(format!(
                    "Native transcript contains duplicate tool result {call_id}"
                )));
            }
        }
    }
    let mut calls = HashSet::new();
    for event in groups.iter_mut().flat_map(|group| group.events.iter_mut()) {
        if let NativeSemanticEvent::ToolCall { call_id, state, .. } = event {
            if !calls.insert(call_id.clone()) {
                return Err(NativeMaterializationError::parity(format!(
                    "Native transcript contains duplicate tool call {call_id}"
                )));
            }
            *state = if results.contains(call_id) {
                conversation_portability::PortableToolCallState::Settled
            } else {
                conversation_portability::PortableToolCallState::Pending
            };
        }
    }
    if let Some(orphan) = results.into_iter().find(|result| !calls.contains(result)) {
        return Err(NativeMaterializationError::parity(format!(
            "Native transcript contains orphan tool result {orphan}"
        )));
    }
    Ok(())
}

pub(crate) fn nonempty_string<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> NativeMaterializationResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            NativeMaterializationError::parity(format!(
                "Native {context} is missing non-empty {key}"
            ))
        })
}
