use std::collections::{HashMap, HashSet};

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

const TYPE_USER: &str = "user";
const TYPE_ASSISTANT: &str = "assistant";
const TYPE_SYSTEM: &str = "system";
const TYPE_LAST_PROMPT: &str = "last-prompt";
const SUBTYPE_COMPACT_BOUNDARY: &str = "compact_boundary";
const VERIFIED_CLAUDE_VERSION: &str = "2.1.209";

pub(super) fn read_claude_exact(
    source: &ExactImportedFileSource,
    records: ExactSourceRecords,
) -> Result<ExactReadOutcome, ExactReadError> {
    validate_claude_filename(source)?;
    let mut by_uuid = HashMap::<String, usize>::new();
    let mut last_prompt_leaf = None;
    let mut fallback_leaf = None;
    let mut observed_title = None;
    let mut loss_counts = HashMap::new();

    for (position, record) in records.records.iter().enumerate() {
        let record_type = required_string(&record.value, "type", record.index)?;
        if let Some(record_uuid) = optional_string(&record.value, "uuid", record.index)? {
            validate_uuid(record_uuid, record.index, "uuid")?;
            if by_uuid.insert(record_uuid.to_string(), position).is_some() {
                return Err(graph_error(
                    "Claude transcript contains a duplicate record UUID",
                ));
            }
        }
        match record_type {
            TYPE_USER | TYPE_ASSISTANT => {
                if record.value.get("message").is_some_and(Value::is_object)
                    && !optional_bool(&record.value, "isSidechain", record.index)?.unwrap_or(false)
                {
                    fallback_leaf = optional_string(&record.value, "uuid", record.index)?
                        .map(ToString::to_string);
                }
            }
            TYPE_SYSTEM if subtype(record)? == SUBTYPE_COMPACT_BOUNDARY => {
                fallback_leaf =
                    optional_string(&record.value, "uuid", record.index)?.map(ToString::to_string);
            }
            TYPE_LAST_PROMPT => {
                validate_optional_session_id(record, &source.source_session_id)?;
                if let Some(leaf) = optional_string(&record.value, "leafUuid", record.index)? {
                    validate_uuid(leaf, record.index, "leafUuid")?;
                    last_prompt_leaf = Some(leaf.to_string());
                }
            }
            "custom-title" => {
                if let Some(title) = optional_string(&record.value, "customTitle", record.index)? {
                    observed_title = Some(title.to_string());
                }
            }
            "ai-title" if observed_title.is_none() => {
                if let Some(title) = optional_string(&record.value, "aiTitle", record.index)? {
                    observed_title = Some(title.to_string());
                }
            }
            "summary" if observed_title.is_none() => {
                if let Some(title) = optional_string(&record.value, "summary", record.index)? {
                    observed_title = Some(title.to_string());
                }
            }
            "queue-operation" | "file-history-snapshot" => {
                increment_loss(
                    &mut loss_counts,
                    PortableLossReason::RuntimeLifecycleOmitted,
                )?;
            }
            TYPE_SYSTEM => {
                return Err(unknown_record(
                    record,
                    "unknown Claude system record subtype",
                ));
            }
            _ => return Err(unknown_record(record, "unknown Claude transcript record")),
        }
    }

    let leaf = last_prompt_leaf.or(fallback_leaf).ok_or_else(|| {
        ExactReadError::new(
            ExactReadFailureKind::UnsupportedSource,
            "Claude transcript has no active conversation leaf",
        )
    })?;
    if !by_uuid.contains_key(&leaf) {
        return Err(graph_error(
            "Claude last-prompt references a missing active leaf UUID",
        ));
    }
    let active_positions = active_graph(&records.records, &by_uuid, &leaf)?;
    let active_set = active_positions.iter().copied().collect::<HashSet<_>>();
    for (position, record) in records.records.iter().enumerate() {
        if !active_set.contains(&position) {
            continue;
        }
        if optional_bool(&record.value, "isSidechain", record.index)?.unwrap_or(false) {
            return Err(ExactReadError::new(
                ExactReadFailureKind::UnsupportedSource,
                "Claude active graph enters a sidechain/subagent record",
            ));
        }
        if optional_bool(&record.value, "isMeta", record.index)?.unwrap_or(false) {
            return Err(unknown_record(
                record,
                "Claude active graph contains model-affecting isMeta history",
            ));
        }
    }

    let mut events = Vec::new();
    let mut observed_workspace: Option<String> = None;
    let mut observed_version: Option<String> = None;
    let mut observed_model: Option<String> = None;
    let mut started_at = None;
    let mut updated_at = None;

    for position in active_positions {
        let record = &records.records[position];
        validate_required_session_id(record, &source.source_session_id)?;
        observe_required_consistent_string(
            record,
            "cwd",
            "Claude active graph contains mixed cwd values",
            &mut observed_workspace,
        )?;
        observe_required_consistent_string(
            record,
            "version",
            "Claude active graph contains mixed CLI versions",
            &mut observed_version,
        )?;
        let timestamp =
            optional_string(&record.value, "timestamp", record.index)?.map(ToString::to_string);
        if started_at.is_none() {
            started_at = timestamp.clone();
        }
        if timestamp.is_some() {
            updated_at = timestamp.clone();
        }
        let record_type = required_string(&record.value, "type", record.index)?;
        match record_type {
            TYPE_SYSTEM if subtype(record)? == SUBTYPE_COMPACT_BOUNDARY => {
                let content = match record.value.get("content") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::String(text)) if !text.is_empty() => {
                        vec![PortableContentBlock::Text { text: text.clone() }]
                    }
                    Some(Value::String(_)) => Vec::new(),
                    Some(_) => {
                        return Err(unknown_record(
                            record,
                            "Claude compact boundary content is not text",
                        ));
                    }
                };
                if record.value.get("compactMetadata").is_some() {
                    increment_loss(
                        &mut loss_counts,
                        PortableLossReason::OpaqueProviderStateOmitted,
                    )?;
                }
                push_event(
                    &mut events,
                    event_for_record(
                        record,
                        None,
                        "compaction-boundary",
                        timestamp,
                        PortableEventBody::CompactionBoundary { content },
                    )?,
                )?;
            }
            TYPE_USER | TYPE_ASSISTANT => {
                let message = required_object(&record.value, "message", record.index)?;
                let expected_role = if record_type == TYPE_USER {
                    PortableRole::User
                } else {
                    PortableRole::Assistant
                };
                let message_role = required_string(message, "role", record.index)?;
                if !matches!(
                    (expected_role, message_role),
                    (PortableRole::User, TYPE_USER) | (PortableRole::Assistant, TYPE_ASSISTANT)
                ) {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::UnknownRole,
                        format!(
                            "Claude record {} has role {message_role:?}, expected {record_type:?}",
                            record.index
                        ),
                    ));
                }
                if expected_role == PortableRole::Assistant {
                    if let Some(model) = optional_string(message, "model", record.index)? {
                        observed_model.get_or_insert_with(|| model.to_string());
                    }
                }
                if optional_bool(&record.value, "isCompactSummary", record.index)?.unwrap_or(false)
                {
                    let boundary_uuid = required_string(&record.value, "parentUuid", record.index)?;
                    let boundary = by_uuid
                        .get(boundary_uuid)
                        .map(|position| &records.records[*position])
                        .ok_or_else(|| {
                            graph_error("Claude compact summary references a missing boundary")
                        })?;
                    if required_string(&boundary.value, "type", boundary.index)? != TYPE_SYSTEM
                        || subtype(boundary)? != SUBTYPE_COMPACT_BOUNDARY
                    {
                        return Err(graph_error(
                            "Claude compact summary is not paired with a compact boundary",
                        ));
                    }
                    let content = portable_content_only(
                        message.get("content"),
                        record,
                        "Claude compact summary",
                    )?;
                    if content.is_empty() {
                        return Err(ExactReadError::new(
                            ExactReadFailureKind::VisibleContentTruncated,
                            "Claude compact summary has no portable content",
                        ));
                    }
                    push_event(
                        &mut events,
                        event_for_record(
                            record,
                            None,
                            "compaction-summary",
                            timestamp,
                            PortableEventBody::CompactionSummary { content },
                        )?,
                    )?;
                } else {
                    append_message_content(
                        &mut events,
                        &mut loss_counts,
                        record,
                        expected_role,
                        message.get("content"),
                        timestamp,
                    )?;
                }
                if record.value.get("toolUseResult").is_some()
                    || record.value.get("sourceToolAssistantUUID").is_some()
                {
                    increment_loss(
                        &mut loss_counts,
                        PortableLossReason::OpaqueProviderStateOmitted,
                    )?;
                }
            }
            _ => {
                return Err(unknown_record(
                    record,
                    "Claude active graph contains unsupported record semantics",
                ));
            }
        }
    }

    if observed_version.as_deref() != Some(VERIFIED_CLAUDE_VERSION) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::UnsupportedSource,
            format!("Claude exact reader only supports verified runtime {VERIFIED_CLAUDE_VERSION}"),
        ));
    }

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

fn validate_claude_filename(source: &ExactImportedFileSource) -> Result<(), ExactReadError> {
    let stem = source
        .source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            ExactReadError::new(
                ExactReadFailureKind::InvalidSourcePath,
                "Claude source path has no UTF-8 JSONL file stem",
            )
        })?;
    if !uuid_like(&source.source_session_id)
        || stem != source.source_session_id
        || source
            .source_path
            .extension()
            .and_then(|value| value.to_str())
            != Some("jsonl")
    {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            "Claude source filename does not match its source session id",
        ));
    }
    Ok(())
}

fn active_graph(
    records: &[ExactSourceRecord],
    by_uuid: &HashMap<String, usize>,
    leaf: &str,
) -> Result<Vec<usize>, ExactReadError> {
    let mut leaf_to_root = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Some(leaf.to_string());
    while let Some(uuid) = cursor {
        if !seen.insert(uuid.clone()) {
            return Err(graph_error(
                "Claude active graph contains an ancestry cycle",
            ));
        }
        let position = by_uuid
            .get(&uuid)
            .copied()
            .ok_or_else(|| graph_error("Claude active graph references a missing parent UUID"))?;
        let record = &records[position];
        leaf_to_root.push(position);
        if let Some(parent) = optional_string(&record.value, "parentUuid", record.index)? {
            validate_uuid(parent, record.index, "parentUuid")?;
            cursor = Some(parent.to_string());
            continue;
        }
        let logical_parent = if required_string(&record.value, "type", record.index)? == TYPE_SYSTEM
            && subtype(record)? == SUBTYPE_COMPACT_BOUNDARY
        {
            let logical = optional_string(&record.value, "logicalParentUuid", record.index)?;
            if let Some(logical) = logical {
                validate_uuid(logical, record.index, "logicalParentUuid")?;
            }
            logical.map(ToString::to_string)
        } else {
            None
        };
        if logical_parent
            .as_ref()
            .is_some_and(|logical_parent| seen.contains(logical_parent))
        {
            if valid_preserved_compaction_back_edge(record, &seen, by_uuid, records)? {
                break;
            }
            return Err(graph_error(
                "Claude active graph contains an ancestry cycle",
            ));
        }
        cursor = logical_parent;
    }
    leaf_to_root.reverse();
    Ok(leaf_to_root)
}

fn valid_preserved_compaction_back_edge(
    boundary: &ExactSourceRecord,
    seen: &HashSet<String>,
    by_uuid: &HashMap<String, usize>,
    records: &[ExactSourceRecord],
) -> Result<bool, ExactReadError> {
    let Some(Value::Object(metadata)) = boundary.value.get("compactMetadata") else {
        return Ok(false);
    };
    let Some(Value::Object(segment)) = metadata.get("preservedSegment") else {
        return Ok(false);
    };
    let Some(Value::Object(messages)) = metadata.get("preservedMessages") else {
        return Ok(false);
    };
    let Some(anchor) = optional_string(segment, "anchorUuid", boundary.index)? else {
        return Ok(false);
    };
    let Some(head) = optional_string(segment, "headUuid", boundary.index)? else {
        return Ok(false);
    };
    let Some(tail) = optional_string(segment, "tailUuid", boundary.index)? else {
        return Ok(false);
    };
    for (field, value) in [
        ("anchorUuid", anchor),
        ("headUuid", head),
        ("tailUuid", tail),
    ] {
        validate_uuid(value, boundary.index, field)?;
    }
    if optional_string(&boundary.value, "logicalParentUuid", boundary.index)? != Some(tail) {
        return Ok(false);
    }
    let Some(anchor_position) = by_uuid.get(anchor).copied() else {
        return Ok(false);
    };
    let anchor_record = &records[anchor_position];
    if !optional_bool(
        &anchor_record.value,
        "isCompactSummary",
        anchor_record.index,
    )?
    .unwrap_or(false)
        || optional_string(&anchor_record.value, "parentUuid", anchor_record.index)?
            != optional_string(&boundary.value, "uuid", boundary.index)?
    {
        return Ok(false);
    }
    let declared = messages
        .get("allUuids")
        .or_else(|| messages.get("uuids"))
        .and_then(Value::as_array)
        .ok_or_else(|| graph_error("Claude compact metadata has no preserved UUID list"))?;
    let declared = declared
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or_else(|| {
                graph_error("Claude compact metadata contains a non-string preserved UUID")
            })?;
            validate_uuid(value, boundary.index, "preserved UUID")?;
            Ok(value)
        })
        .collect::<Result<HashSet<_>, _>>()?;
    if !declared.contains(head)
        || !declared.contains(tail)
        || !declared.iter().all(|uuid| seen.contains(*uuid))
    {
        return Ok(false);
    }
    let mut cursor = Some(tail.to_string());
    let mut path = HashSet::new();
    while let Some(uuid) = cursor {
        if uuid == anchor {
            return Ok(path.contains(head));
        }
        if !path.insert(uuid.clone()) || !seen.contains(&uuid) {
            return Ok(false);
        }
        let Some(position) = by_uuid.get(&uuid).copied() else {
            return Ok(false);
        };
        cursor = optional_string(
            &records[position].value,
            "parentUuid",
            records[position].index,
        )?
        .map(ToString::to_string);
    }
    Ok(false)
}

fn append_message_content(
    events: &mut Vec<PortableEvent>,
    losses: &mut HashMap<PortableLossReason, u64>,
    record: &ExactSourceRecord,
    role: PortableRole,
    content: Option<&Value>,
    timestamp: Option<String>,
) -> Result<(), ExactReadError> {
    match content {
        Some(Value::String(text)) if !text.is_empty() => push_event(
            events,
            event_for_record(
                record,
                None,
                "message",
                timestamp,
                PortableEventBody::Message {
                    role,
                    content: vec![PortableContentBlock::Text { text: text.clone() }],
                },
            )?,
        ),
        Some(Value::Array(blocks)) => {
            for (block_index, block) in blocks.iter().enumerate() {
                let Value::Object(block) = block else {
                    return Err(content_error(
                        record,
                        "Claude message block is not an object",
                    ));
                };
                let block_type = required_string(block, "type", record.index)?;
                let source_block_index = u64::try_from(block_index).map_err(|_| {
                    ExactReadError::new(
                        ExactReadFailureKind::RecordLimit,
                        "Claude content block index overflowed",
                    )
                })?;
                let body = match block_type {
                    "text" => {
                        let text = required_string(block, "text", record.index)?;
                        PortableEventBody::Message {
                            role,
                            content: vec![PortableContentBlock::Text {
                                text: text.to_string(),
                            }],
                        }
                    }
                    "image" => PortableEventBody::Message {
                        role,
                        content: vec![claude_image(block, record)?],
                    },
                    "tool_use" if role == PortableRole::Assistant => {
                        let call_id = required_string(block, "id", record.index)?.to_string();
                        let name = required_string(block, "name", record.index)?.to_string();
                        let input = block.get("input").cloned().ok_or_else(|| {
                            content_error(record, "Claude tool_use block has no input")
                        })?;
                        if !input.is_object() {
                            return Err(content_error(
                                record,
                                "Claude tool_use input must be an object",
                            ));
                        }
                        PortableEventBody::ToolCall {
                            call_id,
                            canonical_name: name.clone(),
                            name,
                            state: PortableToolCallState::Pending,
                            input,
                        }
                    }
                    "tool_result" if role == PortableRole::User => {
                        let call_id =
                            required_string(block, "tool_use_id", record.index)?.to_string();
                        let is_error =
                            optional_bool(block, "is_error", record.index)?.unwrap_or(false);
                        PortableEventBody::ToolResult {
                            call_id,
                            content: portable_tool_result_content(block.get("content"), record)?,
                            is_error,
                        }
                    }
                    "thinking" | "redacted_thinking" if role == PortableRole::Assistant => {
                        increment_loss(losses, PortableLossReason::PrivateReasoningOmitted)?;
                        continue;
                    }
                    _ => {
                        return Err(content_error(
                            record,
                            &format!("Unknown Claude content block type {block_type:?}"),
                        ));
                    }
                };
                push_event(
                    events,
                    event_for_record(
                        record,
                        Some(source_block_index),
                        block_type,
                        timestamp.clone(),
                        body,
                    )?,
                )?;
            }
            Ok(())
        }
        _ => Err(content_error(
            record,
            "Claude message content is missing, empty, or unsupported",
        )),
    }
}

fn portable_content_only(
    content: Option<&Value>,
    record: &ExactSourceRecord,
    label: &str,
) -> Result<Vec<PortableContentBlock>, ExactReadError> {
    match content {
        Some(Value::String(text)) if !text.is_empty() => {
            Ok(vec![PortableContentBlock::Text { text: text.clone() }])
        }
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| {
                let Value::Object(block) = block else {
                    return Err(content_error(
                        record,
                        &format!("{label} block is not an object"),
                    ));
                };
                match required_string(block, "type", record.index)? {
                    "text" => Ok(PortableContentBlock::Text {
                        text: required_string(block, "text", record.index)?.to_string(),
                    }),
                    "image" => claude_image(block, record),
                    other => Err(content_error(
                        record,
                        &format!("{label} contains unsupported block type {other:?}"),
                    )),
                }
            })
            .collect(),
        _ => Err(content_error(
            record,
            &format!("{label} content is unsupported"),
        )),
    }
}

fn portable_tool_result_content(
    content: Option<&Value>,
    record: &ExactSourceRecord,
) -> Result<Vec<PortableContentBlock>, ExactReadError> {
    match content {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(text)) => {
            if text.is_empty() {
                Ok(Vec::new())
            } else {
                Ok(vec![PortableContentBlock::Text { text: text.clone() }])
            }
        }
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block {
                Value::String(text) if !text.is_empty() => {
                    Ok(PortableContentBlock::Text { text: text.clone() })
                }
                Value::Object(block) => match required_string(block, "type", record.index)? {
                    "text" => Ok(PortableContentBlock::Text {
                        text: required_string(block, "text", record.index)?.to_string(),
                    }),
                    "image" => claude_image(block, record),
                    other => Err(content_error(
                        record,
                        &format!("Unknown Claude tool-result block type {other:?}"),
                    )),
                },
                _ => Err(content_error(
                    record,
                    "Claude tool-result block is malformed",
                )),
            })
            .collect(),
        _ => Err(content_error(
            record,
            "Claude tool-result content has an unsupported shape",
        )),
    }
}

fn claude_image(
    block: &Map<String, Value>,
    record: &ExactSourceRecord,
) -> Result<PortableContentBlock, ExactReadError> {
    let image_source = required_object(block, "source", record.index)?;
    if required_string(image_source, "type", record.index)? != "base64" {
        return Err(ExactReadError::new(
            ExactReadFailureKind::AttachmentUnavailable,
            "Claude image is a reference rather than embedded source bytes",
        ));
    }
    let media_type = required_string(image_source, "media_type", record.index)?;
    if !matches!(
        media_type,
        "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    ) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::AttachmentUnavailable,
            "Claude embedded image has an unsupported media type",
        ));
    }
    let data = required_string(image_source, "data", record.index)?;
    if data.is_empty() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::AttachmentUnavailable,
            "Claude embedded image contains no bytes",
        ));
    }
    Ok(PortableContentBlock::Image {
        uri: format!("data:{media_type};base64,{data}"),
    })
}

fn event_for_record(
    record: &ExactSourceRecord,
    source_block_index: Option<u64>,
    suffix: &str,
    timestamp: Option<String>,
    body: PortableEventBody,
) -> Result<PortableEvent, ExactReadError> {
    let record_type = required_string(&record.value, "type", record.index)?.to_string();
    let record_id = optional_string(&record.value, "uuid", record.index)?.map(ToString::to_string);
    let id_stem = record_id
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
        source_record_id: record_id,
        source_block_index,
        source_thread_id: None,
        timestamp,
        body,
    })
}

fn observe_required_consistent_string(
    record: &ExactSourceRecord,
    field: &str,
    error: &str,
    observed: &mut Option<String>,
) -> Result<(), ExactReadError> {
    let value = required_string(&record.value, field, record.index)?;
    if observed.as_deref().is_some_and(|current| current != value) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            error,
        ));
    }
    observed.get_or_insert_with(|| value.to_string());
    Ok(())
}

fn validate_required_session_id(
    record: &ExactSourceRecord,
    expected: &str,
) -> Result<(), ExactReadError> {
    let actual = required_string(&record.value, "sessionId", record.index)?;
    if actual != expected {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            "Claude active graph contains a different sessionId",
        ));
    }
    Ok(())
}

fn validate_optional_session_id(
    record: &ExactSourceRecord,
    expected: &str,
) -> Result<(), ExactReadError> {
    if optional_string(&record.value, "sessionId", record.index)?
        .is_some_and(|actual| actual != expected)
    {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            "Claude metadata contains a different sessionId",
        ));
    }
    Ok(())
}

fn subtype(record: &ExactSourceRecord) -> Result<&str, ExactReadError> {
    Ok(optional_string(&record.value, "subtype", record.index)?.unwrap_or_default())
}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a Map<String, Value>, ExactReadError> {
    super::required_object_field("Claude", object, field, source_index)
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a str, ExactReadError> {
    super::required_string_field("Claude", object, field, source_index)
}

fn optional_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<&'a str>, ExactReadError> {
    super::optional_string_field("Claude", object, field, source_index)
}

fn optional_bool(
    object: &Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<bool>, ExactReadError> {
    super::optional_bool_field("Claude", object, field, source_index)
}

fn unknown_record(record: &ExactSourceRecord, message: &str) -> ExactReadError {
    super::source_record_error(ExactReadFailureKind::UnknownRecord, record.index, message)
}

fn content_error(record: &ExactSourceRecord, message: &str) -> ExactReadError {
    super::source_record_error(
        ExactReadFailureKind::UnknownContentBlock,
        record.index,
        message,
    )
}

fn graph_error(message: &str) -> ExactReadError {
    ExactReadError::new(ExactReadFailureKind::InvalidConversationGraph, message)
}

fn validate_uuid(value: &str, record_index: u64, field: &str) -> Result<(), ExactReadError> {
    if uuid_like(value) {
        Ok(())
    } else {
        Err(graph_error(&format!(
            "Claude record {record_index} field {field:?} is not a UUID"
        )))
    }
}
