use std::collections::HashMap;
use std::path::Path;

use conversation_portability::{
    ExactReadError, ExactReadFailureKind, ExactReadOutcome, PortableContentBlock, PortableEvent,
    PortableEventBody, PortableLossReason, PortableRole, PortableToolCallState,
};
use serde_json::{Map, Value};

use super::source_file::{ExactSourceRecord, ExactSourceRecords};
use super::{
    finalize_outcome, increment_loss, link_tool_events, push_event, uuid_like,
    ExactImportedFileSource, ExactOutcomeMetadata,
};

const VERIFIED_CODEX_VERSION: &str = "0.144.4";

#[derive(Debug, Clone)]
struct UiMessage {
    record_index: u64,
    role: PortableRole,
    text: String,
}

#[derive(Debug, Clone)]
struct CanonicalMessage {
    role: PortableRole,
    text: String,
}

pub(super) fn thread_id_from_rollout_path(path: &Path) -> Result<String, ExactReadError> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| source_identity_error("Codex rollout has no UTF-8 file stem"))?;
    let Some(thread_id) = stem
        .len()
        .checked_sub(36)
        .and_then(|start| stem.get(start..))
    else {
        return Err(source_identity_error(
            "Codex rollout filename has no thread UUID suffix",
        ));
    };
    if !uuid_like(thread_id)
        || !stem.starts_with("rollout-")
        || source_extension(path) != Some("jsonl")
    {
        return Err(source_identity_error(
            "Codex exact reader only accepts rollout-...-<thread-uuid>.jsonl sources",
        ));
    }
    Ok(thread_id.to_string())
}

pub(super) fn read_codex_exact(
    source: &ExactImportedFileSource,
    records: ExactSourceRecords,
) -> Result<ExactReadOutcome, ExactReadError> {
    let filename_thread_id = thread_id_from_rollout_path(&source.source_path)?;
    if filename_thread_id != source.source_session_id {
        return Err(source_identity_error(
            "Codex rollout filename does not match its source thread id",
        ));
    }
    let first = records.records.first().ok_or_else(|| {
        ExactReadError::new(
            ExactReadFailureKind::UnsupportedSource,
            "Codex rollout is empty",
        )
    })?;
    if required_string(&first.value, "type", first.index)? != "session_meta" {
        return Err(source_identity_error(
            "Codex legacy rollout must begin with session_meta",
        ));
    }

    let mut events = Vec::new();
    let mut loss_counts = HashMap::new();
    let mut ui_messages = Vec::new();
    let mut canonical_messages = Vec::new();
    let mut canonical_user_assistant_count = 0usize;
    let mut session_meta_seen = false;
    let mut compacted_count = 0usize;
    let mut context_compacted_count = 0usize;
    let mut observed_workspace = None;
    let mut observed_version = None;
    let mut observed_model = None;
    let mut observed_title = None;
    let mut started_at = None;
    let mut updated_at = None;

    for record in &records.records {
        let record_type = required_string(&record.value, "type", record.index)?;
        let timestamp =
            optional_string(&record.value, "timestamp", record.index)?.map(ToString::to_string);
        if started_at.is_none() {
            started_at = timestamp.clone();
        }
        if timestamp.is_some() {
            updated_at = timestamp.clone();
        }
        let payload = required_object(&record.value, "payload", record.index)?;
        if find_key_recursive(payload, &["encrypted_content"]).is_some() {
            return Err(ExactReadError::new(
                ExactReadFailureKind::EncryptedContext,
                format!(
                    "Codex source record {} contains encrypted-only context",
                    record.index
                ),
            ));
        }
        match record_type {
            "session_meta" => {
                if session_meta_seen {
                    return Err(source_identity_error(
                        "Codex rollout contains more than one session_meta record",
                    ));
                }
                session_meta_seen = true;
                reject_model_context_fields(payload, record, "session_meta")?;
                let history_mode = required_string(payload, "history_mode", record.index)?;
                if history_mode != "legacy" {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::UnsupportedHistoryMode,
                        format!(
                            "Codex history mode {history_mode:?} is not exact-exportable; expected legacy"
                        ),
                    ));
                }
                if payload
                    .get("history_base")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::UnsupportedHistoryMode,
                        "Codex history_base lineage is not exact-exportable",
                    ));
                }
                validate_codex_meta_id(payload, record.index, &source.source_session_id)?;
                observe_consistent_string(
                    payload,
                    record.index,
                    "cwd",
                    "Codex rollout contains mixed cwd values",
                    &mut observed_workspace,
                )?;
                observe_consistent_string(
                    payload,
                    record.index,
                    "cli_version",
                    "Codex rollout contains mixed CLI versions",
                    &mut observed_version,
                )?;
                if observed_workspace.is_none() || observed_version.is_none() {
                    return Err(source_identity_error(
                        "Codex session_meta must declare cwd and cli_version",
                    ));
                }
                if observed_version.as_deref() != Some(VERIFIED_CODEX_VERSION) {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::UnsupportedHistoryMode,
                        format!(
                            "Codex exact reader only supports verified legacy runtime {VERIFIED_CODEX_VERSION}"
                        ),
                    ));
                }
                if started_at.is_none() {
                    started_at = optional_string(payload, "timestamp", record.index)?
                        .map(ToString::to_string);
                }
                if let Some(title) = optional_string(payload, "thread_name", record.index)? {
                    observed_title = Some(title.to_string());
                }
            }
            "response_item" => {
                let item_type = required_string(payload, "type", record.index)?;
                match item_type {
                    "message" => {
                        let role = codex_role(payload, record)?;
                        let duplicate_text = append_codex_message(
                            &mut events,
                            record,
                            role,
                            payload.get("content"),
                            timestamp,
                        )?;
                        if matches!(role, PortableRole::User | PortableRole::Assistant) {
                            canonical_user_assistant_count =
                                canonical_user_assistant_count.saturating_add(1);
                            if let Some(text) = duplicate_text {
                                canonical_messages.push(CanonicalMessage { role, text });
                            }
                        }
                        if payload
                            .get("internal_chat_message_metadata_passthrough")
                            .is_some()
                        {
                            return Err(ExactReadError::new(
                                ExactReadFailureKind::UnsupportedHistoryMode,
                                "Codex internal paginated message metadata is not supported by the legacy exact reader",
                            ));
                        }
                    }
                    "function_call" | "custom_tool_call" => {
                        let call_id =
                            required_string(payload, "call_id", record.index)?.to_string();
                        let name = required_string(payload, "name", record.index)?.to_string();
                        let input = codex_tool_input(payload, record, item_type)?;
                        push_event(
                            &mut events,
                            event_for_record(
                                record,
                                None,
                                item_type,
                                timestamp,
                                PortableEventBody::ToolCall {
                                    call_id,
                                    canonical_name: name.clone(),
                                    name,
                                    state: PortableToolCallState::Pending,
                                    input,
                                },
                            )?,
                        )?;
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let call_id =
                            required_string(payload, "call_id", record.index)?.to_string();
                        let content = codex_tool_result_content(payload.get("output"), record)?;
                        let is_error =
                            optional_bool(payload, "is_error", record.index)?.unwrap_or(false);
                        push_event(
                            &mut events,
                            event_for_record(
                                record,
                                None,
                                item_type,
                                timestamp,
                                PortableEventBody::ToolResult {
                                    call_id,
                                    content,
                                    is_error,
                                },
                            )?,
                        )?;
                    }
                    "reasoning" => {
                        increment_loss(
                            &mut loss_counts,
                            PortableLossReason::PrivateReasoningOmitted,
                        )?;
                    }
                    _ => {
                        return Err(unknown_record(
                            record,
                            &format!("Unknown Codex response_item type {item_type:?}"),
                        ));
                    }
                }
            }
            "event_msg" => {
                let event_type = required_string(payload, "type", record.index)?;
                match event_type {
                    "user_message" | "agent_message" => {
                        validate_ui_message_projection(payload, record)?;
                        let text = required_string(payload, "message", record.index)?.to_string();
                        ui_messages.push(UiMessage {
                            record_index: record.index,
                            role: if event_type == "user_message" {
                                PortableRole::User
                            } else {
                                PortableRole::Assistant
                            },
                            text,
                        });
                    }
                    "context_compacted" => {
                        context_compacted_count = context_compacted_count.saturating_add(1);
                        if context_compacted_count > compacted_count {
                            return Err(ExactReadError::new(
                                ExactReadFailureKind::RecordSkipped,
                                "Codex context_compacted UI event precedes any unmatched canonical compacted record",
                            ));
                        }
                    }
                    "thread_name_updated" => {
                        observed_title = optional_string(payload, "thread_name", record.index)?
                            .or(optional_string(payload, "name", record.index)?)
                            .map(ToString::to_string)
                            .or(observed_title);
                    }
                    "task_started" => {
                        if let Some(model) = optional_string(payload, "model", record.index)? {
                            observed_model.get_or_insert_with(|| model.to_string());
                        }
                        increment_loss(
                            &mut loss_counts,
                            PortableLossReason::RuntimeLifecycleOmitted,
                        )?;
                    }
                    "task_complete" | "turn_aborted" | "token_count" | "task_failed" => {
                        increment_loss(
                            &mut loss_counts,
                            PortableLossReason::RuntimeLifecycleOmitted,
                        )?;
                    }
                    "item_completed" | "item_started" => {
                        return Err(ExactReadError::new(
                            ExactReadFailureKind::UnsupportedHistoryMode,
                            "Codex paginated item events are not accepted by the legacy exact reader",
                        ));
                    }
                    _ => {
                        return Err(unknown_record(
                            record,
                            &format!("Unknown Codex event_msg type {event_type:?}"),
                        ));
                    }
                }
            }
            "compacted" => {
                if payload
                    .get("replacement_history")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::UnsupportedHistoryMode,
                        "Codex replacement_history compaction is not exact-exportable",
                    ));
                }
                let message = required_string(payload, "message", record.index)?;
                push_event(
                    &mut events,
                    event_for_record(
                        record,
                        None,
                        "compaction-summary",
                        timestamp,
                        PortableEventBody::CompactionSummary {
                            content: vec![PortableContentBlock::Text {
                                text: message.to_string(),
                            }],
                        },
                    )?,
                )?;
                compacted_count = compacted_count.saturating_add(1);
            }
            "turn_context" => {
                reject_model_context_fields(payload, record, "turn_context")?;
                observe_consistent_string(
                    payload,
                    record.index,
                    "cwd",
                    "Codex rollout contains mixed cwd values",
                    &mut observed_workspace,
                )?;
                if let Some(model) = optional_string(payload, "model", record.index)? {
                    observed_model.get_or_insert_with(|| model.to_string());
                }
                increment_loss(
                    &mut loss_counts,
                    PortableLossReason::RuntimeLifecycleOmitted,
                )?;
            }
            "world_state" | "security_risk_score" => {
                increment_loss(
                    &mut loss_counts,
                    PortableLossReason::OpaqueProviderStateOmitted,
                )?;
            }
            _ => {
                return Err(unknown_record(
                    record,
                    &format!("Unknown Codex rollout record type {record_type:?}"),
                ));
            }
        }
    }

    if !session_meta_seen {
        return Err(source_identity_error(
            "Codex rollout is missing its canonical session_meta",
        ));
    }
    if canonical_user_assistant_count == 0 {
        return Err(ExactReadError::new(
            ExactReadFailureKind::UnsupportedHistoryMode,
            "Codex event_msg UI messages cannot substitute for canonical response_item history",
        ));
    }
    verify_ui_duplicates(&ui_messages, &canonical_messages)?;
    events.sort_by_key(|event| (event.source_record_index, event.source_block_index));
    link_tool_events(&mut events)?;
    finalize_outcome(
        source,
        &records,
        events,
        loss_counts,
        ExactOutcomeMetadata {
            source_runtime_version: observed_version,
            observed_title,
            observed_model,
            observed_workspace,
            started_at,
            updated_at,
        },
    )
}

fn append_codex_message(
    events: &mut Vec<PortableEvent>,
    record: &ExactSourceRecord,
    role: PortableRole,
    content: Option<&Value>,
    timestamp: Option<String>,
) -> Result<Option<String>, ExactReadError> {
    let Some(Value::Array(blocks)) = content else {
        return Err(content_error(
            record,
            "Codex response message content must be an array",
        ));
    };
    if blocks.is_empty() {
        return Err(content_error(
            record,
            "Codex response message content is empty",
        ));
    }
    let mut duplicate_text = None;
    let mut text_count = 0usize;
    for (block_index, block) in blocks.iter().enumerate() {
        let Value::Object(block) = block else {
            return Err(content_error(
                record,
                "Codex message block is not an object",
            ));
        };
        let block_type = required_string(block, "type", record.index)?;
        let portable = match block_type {
            "input_text" | "output_text" | "text" => {
                let text = required_string(block, "text", record.index)?.to_string();
                text_count = text_count.saturating_add(1);
                duplicate_text = Some(text.clone());
                PortableContentBlock::Text { text }
            }
            "input_image" | "image" => codex_image(block, record)?,
            _ => {
                return Err(content_error(
                    record,
                    &format!("Unknown Codex message block type {block_type:?}"),
                ));
            }
        };
        let source_block_index = u64::try_from(block_index).map_err(|_| {
            ExactReadError::new(
                ExactReadFailureKind::RecordLimit,
                "Codex content block index overflowed",
            )
        })?;
        push_event(
            events,
            event_for_record(
                record,
                Some(source_block_index),
                block_type,
                timestamp.clone(),
                PortableEventBody::Message {
                    role,
                    content: vec![portable],
                },
            )?,
        )?;
    }
    Ok((text_count == 1).then_some(duplicate_text).flatten())
}

fn codex_role(
    payload: &Map<String, Value>,
    record: &ExactSourceRecord,
) -> Result<PortableRole, ExactReadError> {
    match required_string(payload, "role", record.index)? {
        "user" => Ok(PortableRole::User),
        "assistant" => Ok(PortableRole::Assistant),
        "system" => Ok(PortableRole::System),
        "developer" => Ok(PortableRole::Developer),
        role => Err(ExactReadError::new(
            ExactReadFailureKind::UnknownRole,
            format!(
                "Unknown Codex message role {role:?} at record {}",
                record.index
            ),
        )),
    }
}

fn codex_tool_input(
    payload: &Map<String, Value>,
    record: &ExactSourceRecord,
    item_type: &str,
) -> Result<Value, ExactReadError> {
    let value = payload
        .get("arguments")
        .or_else(|| payload.get("input"))
        .ok_or_else(|| content_error(record, "Codex tool call has no arguments/input payload"))?;
    if item_type == "function_call" {
        let encoded = value.as_str().ok_or_else(|| {
            content_error(
                record,
                "Codex function_call arguments must be encoded JSON text",
            )
        })?;
        serde_json::from_str(encoded).map_err(|error| {
            content_error(
                record,
                &format!("Codex function_call arguments are not valid JSON: {error}"),
            )
        })
    } else if let Some(encoded) = value.as_str() {
        Ok(serde_json::from_str(encoded).unwrap_or_else(|_| Value::String(encoded.to_string())))
    } else {
        Ok(value.clone())
    }
}

fn codex_tool_result_content(
    output: Option<&Value>,
    record: &ExactSourceRecord,
) -> Result<Vec<PortableContentBlock>, ExactReadError> {
    match output {
        Some(Value::String(text)) => {
            if text.is_empty() {
                Ok(Vec::new())
            } else {
                Ok(vec![PortableContentBlock::Text { text: text.clone() }])
            }
        }
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| {
                let Value::Object(block) = block else {
                    return Err(content_error(
                        record,
                        "Codex tool-result block is not an object",
                    ));
                };
                match required_string(block, "type", record.index)? {
                    "input_text" | "output_text" | "text" => Ok(PortableContentBlock::Text {
                        text: required_string(block, "text", record.index)?.to_string(),
                    }),
                    "input_image" | "image" => codex_image(block, record),
                    other => Err(content_error(
                        record,
                        &format!("Unknown Codex tool-result block type {other:?}"),
                    )),
                }
            })
            .collect(),
        None | Some(Value::Null) => Ok(Vec::new()),
        _ => Err(content_error(
            record,
            "Codex tool-result output has an unsupported shape",
        )),
    }
}

fn codex_image(
    block: &Map<String, Value>,
    record: &ExactSourceRecord,
) -> Result<PortableContentBlock, ExactReadError> {
    let uri = optional_string(block, "image_url", record.index)?
        .or(optional_string(block, "url", record.index)?)
        .ok_or_else(|| content_error(record, "Codex image block has no URI"))?;
    if !uri.starts_with("data:image/") {
        return Err(ExactReadError::new(
            ExactReadFailureKind::AttachmentUnavailable,
            "Codex image is a mutable/local reference rather than embedded bytes",
        ));
    }
    Ok(PortableContentBlock::Image {
        uri: uri.to_string(),
    })
}

fn verify_ui_duplicates(
    ui_messages: &[UiMessage],
    canonical_messages: &[CanonicalMessage],
) -> Result<(), ExactReadError> {
    let mut cursor = 0usize;
    for ui in ui_messages {
        let Some(relative) = canonical_messages[cursor..]
            .iter()
            .position(|canonical| canonical.role == ui.role && canonical.text == ui.text)
        else {
            return Err(ExactReadError::new(
                ExactReadFailureKind::RecordSkipped,
                format!(
                    "Codex UI message at record {} has no exact canonical response_item duplicate",
                    ui.record_index
                ),
            ));
        };
        cursor = cursor.saturating_add(relative).saturating_add(1);
    }
    Ok(())
}

fn validate_ui_message_projection(
    payload: &Map<String, Value>,
    record: &ExactSourceRecord,
) -> Result<(), ExactReadError> {
    const ALLOWED: &[&str] = &["type", "message", "images", "local_images", "text_elements"];
    if let Some(field) = payload
        .keys()
        .find(|field| !ALLOWED.contains(&field.as_str()))
    {
        return Err(unknown_record(
            record,
            &format!("Codex UI message contains unknown field {field:?}"),
        ));
    }
    for field in ["images", "local_images", "text_elements"] {
        match payload.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::Array(values)) if values.is_empty() => {}
            Some(Value::Array(_)) => {
                return Err(ExactReadError::new(
                    ExactReadFailureKind::RecordSkipped,
                    format!(
                        "Codex UI message field {field:?} is not proven by its canonical response_item"
                    ),
                ));
            }
            Some(_) => {
                return Err(ExactReadError::new(
                    ExactReadFailureKind::MalformedRecord,
                    format!("Codex UI message field {field:?} must be an array"),
                ));
            }
        }
    }
    Ok(())
}

fn reject_model_context_fields(
    payload: &Map<String, Value>,
    record: &ExactSourceRecord,
    record_type: &str,
) -> Result<(), ExactReadError> {
    let fields = [
        "instructions",
        "base_instructions",
        "developer_instructions",
        "user_instructions",
        "model_instructions",
        "environment_context",
    ];
    if let Some(field) = find_key_recursive(payload, &fields) {
        return Err(unknown_record(
            record,
            &format!("Codex {record_type} contains unportable model-visible field {field:?}"),
        ));
    }
    Ok(())
}

fn validate_codex_meta_id(
    payload: &Map<String, Value>,
    record_index: u64,
    expected: &str,
) -> Result<(), ExactReadError> {
    let id = optional_string(payload, "id", record_index)?;
    let session_id = optional_string(payload, "session_id", record_index)?;
    if id.is_none() && session_id.is_none() {
        return Err(source_identity_error(
            "Codex session_meta has no id or session_id",
        ));
    }
    if id.is_some_and(|id| id != expected)
        || session_id.is_some_and(|session_id| session_id != expected)
        || id
            .zip(session_id)
            .is_some_and(|(id, session_id)| id != session_id)
    {
        return Err(source_identity_error(
            "Codex session_meta id does not match the rollout filename",
        ));
    }
    Ok(())
}

fn observe_consistent_string(
    object: &Map<String, Value>,
    record_index: u64,
    field: &str,
    message: &str,
    observed: &mut Option<String>,
) -> Result<(), ExactReadError> {
    let Some(value) = optional_string(object, field, record_index)? else {
        return Ok(());
    };
    if observed.as_deref().is_some_and(|current| current != value) {
        return Err(source_identity_error(message));
    }
    observed.get_or_insert_with(|| value.to_string());
    Ok(())
}

fn event_for_record(
    record: &ExactSourceRecord,
    source_block_index: Option<u64>,
    suffix: &str,
    timestamp: Option<String>,
    body: PortableEventBody,
) -> Result<PortableEvent, ExactReadError> {
    let record_type = required_string(&record.value, "type", record.index)?.to_string();
    let payload = required_object(&record.value, "payload", record.index)?;
    let source_record_id = optional_string(payload, "id", record.index)?
        .or(optional_string(payload, "call_id", record.index)?)
        .map(ToString::to_string);
    let id_stem = source_record_id
        .clone()
        .unwrap_or_else(|| format!("record-{}", record.index));
    Ok(PortableEvent {
        event_id: match source_block_index {
            Some(block_index) => format!("{id_stem}:block-{block_index}:{suffix}"),
            None => format!("{id_stem}:{suffix}"),
        },
        source_index: record.index,
        source_record_index: record.index,
        source_record_type: Some(record_type),
        source_record_id,
        source_block_index,
        source_thread_id: None,
        timestamp,
        body,
    })
}

fn find_key_recursive<'a>(object: &Map<String, Value>, keys: &[&'a str]) -> Option<&'a str> {
    if let Some(key) = keys.iter().find(|key| object.contains_key(**key)) {
        return Some(*key);
    }
    let mut stack = object.values().collect::<Vec<_>>();
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(object) => {
                if let Some(key) = keys.iter().find(|key| object.contains_key(**key)) {
                    return Some(*key);
                }
                stack.extend(object.values());
            }
            Value::Array(values) => stack.extend(values),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
    None
}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a Map<String, Value>, ExactReadError> {
    super::required_object_field("Codex", object, field, source_index)
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a str, ExactReadError> {
    super::required_string_field("Codex", object, field, source_index)
}

fn optional_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<&'a str>, ExactReadError> {
    super::optional_string_field("Codex", object, field, source_index)
}

fn optional_bool(
    object: &Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<bool>, ExactReadError> {
    super::optional_bool_field("Codex", object, field, source_index)
}

fn content_error(record: &ExactSourceRecord, message: &str) -> ExactReadError {
    super::source_record_error(
        ExactReadFailureKind::UnknownContentBlock,
        record.index,
        message,
    )
}

fn unknown_record(record: &ExactSourceRecord, message: &str) -> ExactReadError {
    super::source_record_error(ExactReadFailureKind::UnknownRecord, record.index, message)
}

fn source_identity_error(message: &str) -> ExactReadError {
    ExactReadError::new(ExactReadFailureKind::InvalidSourceIdentity, message)
}

fn source_extension(path: &Path) -> Option<&str> {
    path.extension().and_then(|value| value.to_str())
}
