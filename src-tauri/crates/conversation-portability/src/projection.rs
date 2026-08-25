use std::collections::{BTreeMap, HashSet};

use core_types::activity::ActivityChunk;
use serde_json::Value;

use crate::{
    portable_image_uri, validate_component_bytes, validate_json_value, validate_non_empty,
    ExactReadOutcome, PortableAnnotationKind, PortableContentBlock, PortableConversation,
    PortableConversationSource, PortableEvent, PortableEventBody, PortableFidelity,
    PortableLossEntry, PortableLossManifest, PortableLossReason, PortableRole,
    PortableToolCallState, MAX_PORTABLE_CONVERSATION_EVENTS, PORTABLE_CONVERSATION_SCHEMA,
    PORTABLE_CONVERSATION_VERSION,
};

const ACTION_ASSISTANT: &str = "assistant";
const ACTION_COMPACTION_SUMMARY: &str = "compaction_summary";
const ACTION_ERROR: &str = "error";
const ACTION_RAW: &str = "raw";
const ACTION_TASK_COMPLETED: &str = "task_completed";
const ACTION_TASK_FAILED: &str = "task_failed";
const ACTION_TASK_START: &str = "task_start";
const ACTION_THINKING: &str = "thinking";
const ACTION_TOOL_CALL: &str = "tool_call";
const FUNCTION_ASSISTANT: &str = "assistant";
const FUNCTION_COMPACTION_SUMMARY: &str = "compaction_summary";
const FUNCTION_DEVELOPER_MESSAGE: &str = "developer_message";
const FUNCTION_SYSTEM_MESSAGE: &str = "system_message";
const FUNCTION_THINKING: &str = "thinking";
const FUNCTION_USER_MESSAGE: &str = "user_message";

/// Project a source snapshot that has already satisfied the exact-reader
/// contract. Blocking reader or projection loss is rejected; context-degrading
/// private/runtime loss remains machine-visible and cannot be described as
/// native-equivalent.
pub fn project_exact_read(read: ExactReadOutcome) -> Result<PortableConversation, String> {
    read.reader_loss_manifest.validate()?;
    if !read.reader_loss_manifest.is_continuation_materializable() {
        return Err("Exact export reader reported blocking continuation loss".to_string());
    }
    let conversation =
        project_activity_chunks(read.source, &read.chunks, read.reader_loss_manifest)?;
    conversation.require_materializable_continuation()?;
    Ok(conversation)
}

pub(crate) fn project_activity_chunks(
    source: PortableConversationSource,
    chunks: &[ActivityChunk],
    initial_losses: PortableLossManifest,
) -> Result<PortableConversation, String> {
    validate_non_empty("source kind", &source.source_kind)?;
    validate_non_empty("source session id", &source.source_session_id)?;
    if chunks.len() > MAX_PORTABLE_CONVERSATION_EVENTS {
        return Err(format!(
            "Source conversation has {} chunks; limit is {MAX_PORTABLE_CONVERSATION_EVENTS}",
            chunks.len()
        ));
    }

    let mut events = Vec::with_capacity(chunks.len());
    let mut losses = initial_losses
        .entries
        .into_iter()
        .map(|entry| (entry.reason, entry.count))
        .collect::<BTreeMap<_, _>>();
    let mut seen_tool_call_ids = HashSet::new();

    for (index, chunk) in chunks.iter().enumerate() {
        if chunk.session_id != source.source_session_id {
            return Err(format!(
                "Source chunk {} belongs to a different session",
                chunk.chunk_id
            ));
        }
        validate_non_empty("source chunk id", &chunk.chunk_id)?;
        validate_component_bytes("source chunk id", &chunk.chunk_id)?;
        if chunk.broadcast_only {
            return Err(format!(
                "Source chunk {} is an ephemeral broadcast delta",
                chunk.chunk_id
            ));
        }
        if chunk.process_id.is_some() {
            increment_loss(&mut losses, PortableLossReason::OpaqueProviderStateOmitted)?;
        }
        let source_thread_id = chunk.thread_id.as_deref().and_then(non_empty_owned);
        if chunk.thread_id.is_some() && source_thread_id.is_none() {
            increment_loss(&mut losses, PortableLossReason::OpaqueProviderStateOmitted)?;
        }
        let source_index = index as u64;
        let timestamp = non_empty_owned(&chunk.created_at);
        let event_stem = format!("{}:{index}", chunk.chunk_id);

        if chunk.function == FUNCTION_USER_MESSAGE {
            push_message(
                &mut events,
                &mut losses,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
                PortableRole::User,
                &chunk.result,
            )?;
            continue;
        }
        if chunk.function == FUNCTION_SYSTEM_MESSAGE {
            push_message(
                &mut events,
                &mut losses,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
                PortableRole::System,
                &chunk.result,
            )?;
            continue;
        }
        if chunk.function == FUNCTION_DEVELOPER_MESSAGE {
            push_message(
                &mut events,
                &mut losses,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
                PortableRole::Developer,
                &chunk.result,
            )?;
            continue;
        }
        if chunk.action_type == ACTION_COMPACTION_SUMMARY
            || chunk.function == FUNCTION_COMPACTION_SUMMARY
        {
            push_compaction_summary(
                &mut events,
                &mut losses,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
                &chunk.result,
            )?;
            continue;
        }
        if chunk.action_type == ACTION_RAW {
            increment_loss(&mut losses, PortableLossReason::UnknownRole)?;
            continue;
        }
        if chunk.function == FUNCTION_ASSISTANT || chunk.action_type == ACTION_ASSISTANT {
            push_message(
                &mut events,
                &mut losses,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
                PortableRole::Assistant,
                &chunk.result,
            )?;
            continue;
        }
        if chunk.function == FUNCTION_THINKING || chunk.action_type == ACTION_THINKING {
            increment_loss(&mut losses, PortableLossReason::PrivateReasoningOmitted)?;
            continue;
        }
        if chunk.action_type == ACTION_TOOL_CALL {
            push_tool_events(
                &mut events,
                &mut losses,
                &mut seen_tool_call_ids,
                chunk,
                index,
                event_stem,
                source_index,
                source_thread_id,
                timestamp,
            )?;
            continue;
        }
        if chunk.action_type == ACTION_ERROR {
            let content = visible_message_content(&chunk.result, &mut losses)?;
            if content.is_empty() {
                increment_loss(&mut losses, PortableLossReason::UnsupportedChunk)?;
            } else {
                push_event(
                    &mut events,
                    PortableEvent {
                        event_id: format!("{event_stem}:annotation"),
                        source_index,
                        source_thread_id,
                        timestamp,
                        body: PortableEventBody::Annotation {
                            annotation_kind: PortableAnnotationKind::SourceError,
                            content,
                        },
                    },
                )?;
            }
            continue;
        }
        if matches!(
            chunk.action_type.as_str(),
            ACTION_TASK_START | ACTION_TASK_COMPLETED | ACTION_TASK_FAILED
        ) {
            increment_loss(&mut losses, PortableLossReason::RuntimeLifecycleOmitted)?;
        } else {
            increment_loss(&mut losses, PortableLossReason::UnsupportedChunk)?;
        }
    }

    let total_omitted_items = losses
        .values()
        .try_fold(0u64, |total, count| total.checked_add(*count))
        .ok_or_else(|| "Portable projection loss count overflowed".to_string())?;
    let mut entries = losses
        .into_iter()
        .map(|(reason, count)| PortableLossEntry {
            reason,
            impact: reason.impact(),
            count,
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by_key(|entry| entry.reason.wire_name());
    let mut loss_manifest = PortableLossManifest {
        fidelity: PortableFidelity::default(),
        entries,
        total_omitted_items,
    };
    loss_manifest.fidelity = loss_manifest.computed_fidelity();
    let conversation = PortableConversation {
        schema: PORTABLE_CONVERSATION_SCHEMA.to_string(),
        schema_version: PORTABLE_CONVERSATION_VERSION,
        source,
        events,
        loss_manifest,
    };
    // This enforces the serialized bound at the producing boundary. A
    // transport may impose a stricter limit, but no caller may truncate.
    conversation.encode_canonical()?;
    Ok(conversation)
}

#[allow(clippy::too_many_arguments)]
fn push_message(
    events: &mut Vec<PortableEvent>,
    losses: &mut BTreeMap<PortableLossReason, u64>,
    event_stem: String,
    source_index: u64,
    source_thread_id: Option<String>,
    timestamp: Option<String>,
    role: PortableRole,
    result: &Value,
) -> Result<(), String> {
    let content = visible_message_content(result, losses)?;
    if content.is_empty() {
        // The caller turns this typed blocking loss into an exact-export
        // rejection after the full projection is available for validation.
        increment_loss(losses, PortableLossReason::EmptyVisibleMessage)?;
        return Ok(());
    }
    push_event(
        events,
        PortableEvent {
            event_id: format!("{event_stem}:message"),
            source_index,
            source_thread_id,
            timestamp,
            body: PortableEventBody::Message { role, content },
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn push_compaction_summary(
    events: &mut Vec<PortableEvent>,
    losses: &mut BTreeMap<PortableLossReason, u64>,
    event_stem: String,
    source_index: u64,
    source_thread_id: Option<String>,
    timestamp: Option<String>,
    result: &Value,
) -> Result<(), String> {
    let content = visible_message_content(result, losses)?;
    if content.is_empty() {
        increment_loss(losses, PortableLossReason::CompactionSummaryOmitted)?;
        return Ok(());
    }
    push_event(
        events,
        PortableEvent {
            event_id: format!("{event_stem}:compaction-summary"),
            source_index,
            source_thread_id,
            timestamp,
            body: PortableEventBody::CompactionSummary { content },
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn push_tool_events(
    events: &mut Vec<PortableEvent>,
    losses: &mut BTreeMap<PortableLossReason, u64>,
    seen_tool_call_ids: &mut HashSet<String>,
    chunk: &ActivityChunk,
    index: usize,
    event_stem: String,
    source_index: u64,
    source_thread_id: Option<String>,
    timestamp: Option<String>,
) -> Result<(), String> {
    let source_call_id = unique_string(&chunk.result, &["call_id", "callId"], "tool call id")?;
    if let Some(source_call_id) = source_call_id {
        validate_component_bytes("tool call id", source_call_id)?;
    }
    let mut call_id = if let Some(source_call_id) = source_call_id {
        source_call_id.to_owned()
    } else {
        increment_loss(losses, PortableLossReason::MissingToolCallId)?;
        portable_call_id(index, seen_tool_call_ids)
    };
    if source_call_id.is_some() && !seen_tool_call_ids.insert(call_id.clone()) {
        increment_loss(losses, PortableLossReason::DuplicateToolCallId)?;
        call_id = portable_call_id(index, seen_tool_call_ids);
        seen_tool_call_ids.insert(call_id.clone());
    } else if source_call_id.is_none() {
        seen_tool_call_ids.insert(call_id.clone());
    }
    let canonical_name = if !chunk.function.trim().is_empty() {
        validate_component_bytes("canonical tool name", &chunk.function)?;
        chunk.function.clone()
    } else {
        increment_loss(losses, PortableLossReason::MissingToolName)?;
        "unknown_tool".to_string()
    };
    let name = if let Some(name) = unique_string(
        &chunk.result,
        &["raw_tool_name", "rawToolName"],
        "raw tool name",
    )? {
        validate_component_bytes("tool name", name)?;
        name.to_owned()
    } else {
        canonical_name.clone()
    };
    let state = tool_call_state(&chunk.result)?;
    if state == PortableToolCallState::Pending && has_tool_result_payload(&chunk.result) {
        return Err("Pending portable tool call contains result payload".to_string());
    }
    validate_json_value(&chunk.args)?;
    push_event(
        events,
        PortableEvent {
            event_id: format!("{event_stem}:tool-call"),
            source_index,
            source_thread_id: source_thread_id.clone(),
            timestamp: timestamp.clone(),
            body: PortableEventBody::ToolCall {
                call_id: call_id.clone(),
                name,
                canonical_name,
                state,
                input: chunk.args.clone(),
            },
        },
    )?;
    if state == PortableToolCallState::Settled {
        push_event(
            events,
            PortableEvent {
                event_id: format!("{event_stem}:tool-result"),
                source_index,
                source_thread_id,
                timestamp,
                body: PortableEventBody::ToolResult {
                    call_id,
                    content: tool_result_content(&chunk.result, losses)?,
                    is_error: tool_result_is_error(&chunk.result)?,
                },
            },
        )?;
    }
    Ok(())
}

fn visible_message_content(
    result: &Value,
    losses: &mut BTreeMap<PortableLossReason, u64>,
) -> Result<Vec<PortableContentBlock>, String> {
    let mut content = Vec::new();
    if let Some(text) = message_text(result)? {
        validate_component_bytes("visible message", text)?;
        content.push(PortableContentBlock::Text {
            text: text.to_string(),
        });
    }
    append_image_blocks(result, losses, &mut content)?;
    Ok(content)
}

fn tool_result_content(
    result: &Value,
    losses: &mut BTreeMap<PortableLossReason, u64>,
) -> Result<Vec<PortableContentBlock>, String> {
    let mut content = Vec::new();
    if let Some(value) = unique_value(
        result,
        &["output", "observation", "content", "result"],
        "tool result",
    )? {
        match value {
            Value::String(text) if !text.is_empty() => {
                validate_component_bytes("tool result text", text)?;
                content.push(PortableContentBlock::Text { text: text.clone() });
            }
            Value::Null | Value::String(_) => {}
            other => content.push(PortableContentBlock::Json {
                value: {
                    validate_json_value(other)?;
                    other.clone()
                },
            }),
        }
    }
    append_image_blocks(result, losses, &mut content)?;
    Ok(content)
}

fn message_text(result: &Value) -> Result<Option<&str>, String> {
    let mut values = Vec::new();
    if let Some(value) = result.pointer("/message/content") {
        values.push(value);
    }
    for field in ["content", "observation", "output", "text"] {
        if let Some(value) = result.get(field) {
            values.push(value);
        }
    }
    if let Some(value) = result.get("message") {
        match value {
            Value::String(_) => values.push(value),
            Value::Object(message) if message.len() == 1 && message.contains_key("content") => {}
            Value::Null => {}
            _ => return Err("Portable message has unsupported message content".to_string()),
        }
    }

    let mut text = None;
    for value in values {
        match value {
            Value::Null => {}
            Value::String(value) if value.is_empty() => {}
            Value::String(value) if text.is_none() => text = Some(value.as_str()),
            Value::String(_) => {
                return Err("Portable message has multiple content fields".to_string());
            }
            _ => return Err("Portable message content must be normalized text".to_string()),
        }
    }
    Ok(text)
}

fn portable_call_id(index: usize, seen: &HashSet<String>) -> String {
    let base = format!("org2-portable-call-{index}");
    if !seen.contains(&base) {
        return base;
    }
    let mut collision = 1u64;
    loop {
        let candidate = format!("{base}-{collision}");
        if !seen.contains(&candidate) {
            return candidate;
        }
        collision = collision.saturating_add(1);
    }
}

fn append_image_blocks(
    result: &Value,
    losses: &mut BTreeMap<PortableLossReason, u64>,
    content: &mut Vec<PortableContentBlock>,
) -> Result<(), String> {
    let images = match result.get("images") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Array(images)) => images,
        Some(_) => {
            increment_loss(losses, PortableLossReason::InvalidAttachmentReference)?;
            return Ok(());
        }
    };
    for image in images {
        let Some(uri) = image.as_str() else {
            increment_loss(losses, PortableLossReason::InvalidAttachmentReference)?;
            continue;
        };
        validate_component_bytes("attachment URI", uri)?;
        if portable_image_uri(uri) {
            content.push(PortableContentBlock::Image {
                uri: uri.to_string(),
            });
        } else if uri.starts_with("https://") || uri.starts_with("http://") {
            // A mutable reference is not the referenced image bytes. Exact v1
            // therefore requires an embedded data URI and rejects this export.
            increment_loss(losses, PortableLossReason::RemoteAttachmentUncaptured)?;
        } else if looks_like_local_path(uri) {
            increment_loss(losses, PortableLossReason::LocalAttachmentUnavailable)?;
        } else {
            increment_loss(losses, PortableLossReason::InvalidAttachmentReference)?;
        }
    }
    Ok(())
}

fn push_event(events: &mut Vec<PortableEvent>, event: PortableEvent) -> Result<(), String> {
    if events.len() >= MAX_PORTABLE_CONVERSATION_EVENTS {
        return Err(format!(
            "Portable projection exceeds the {MAX_PORTABLE_CONVERSATION_EVENTS}-event limit"
        ));
    }
    events.push(event);
    Ok(())
}

fn looks_like_local_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.as_bytes().get(1) == Some(&b':')
}

fn unique_string<'a>(
    result: &'a Value,
    fields: &[&str],
    label: &str,
) -> Result<Option<&'a str>, String> {
    let mut found = None;
    for field in fields {
        let Some(value) = result.get(*field) else {
            continue;
        };
        match value {
            Value::Null => {}
            Value::String(value) if value.trim().is_empty() => {}
            Value::String(value) if found.is_none() => found = Some(value.as_str()),
            Value::String(_) => return Err(format!("Portable {label} has multiple aliases")),
            _ => return Err(format!("Portable {label} must be normalized text")),
        }
    }
    Ok(found)
}

fn unique_value<'a>(
    result: &'a Value,
    fields: &[&str],
    label: &str,
) -> Result<Option<&'a Value>, String> {
    let mut found = None;
    for field in fields {
        let Some(value) = result.get(*field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if found.is_some() {
            return Err(format!("Portable {label} has multiple content fields"));
        }
        found = Some(value);
    }
    Ok(found)
}

fn has_tool_result_payload(result: &Value) -> bool {
    ["output", "observation", "content", "result"]
        .iter()
        .any(|field| result.get(*field).is_some_and(|value| !value.is_null()))
        || result.get("images").is_some_and(|value| !value.is_null())
        || result.get("success").is_some_and(|value| !value.is_null())
        || result.get("is_error").is_some_and(|value| !value.is_null())
}

fn tool_result_is_error(result: &Value) -> Result<bool, String> {
    let is_error = optional_bool(result, "is_error")? == Some(true)
        || optional_bool(result, "success")? == Some(false)
        || matches!(
            result.get("status").and_then(Value::as_str),
            Some("failed" | "cancelled")
        );
    Ok(is_error)
}

fn optional_bool(result: &Value, field: &str) -> Result<Option<bool>, String> {
    match result.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("Portable tool result {field} must be a boolean")),
    }
}

fn tool_call_state(result: &Value) -> Result<PortableToolCallState, String> {
    match result.get("status").and_then(Value::as_str) {
        Some("pending" | "running" | "in_progress") => Ok(PortableToolCallState::Pending),
        Some("completed" | "failed" | "cancelled") => Ok(PortableToolCallState::Settled),
        Some(status) => Err(format!(
            "Portable tool call has unsupported explicit status: {status}"
        )),
        None => Err(
            "Portable tool call must explicitly declare a pending or settled status".to_string(),
        ),
    }
}

fn non_empty_owned(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn increment_loss(
    losses: &mut BTreeMap<PortableLossReason, u64>,
    reason: PortableLossReason,
) -> Result<(), String> {
    let count = losses.entry(reason).or_default();
    *count = count
        .checked_add(1)
        .ok_or_else(|| "Portable projection loss count overflowed".to_string())?;
    Ok(())
}
