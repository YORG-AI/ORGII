use std::collections::HashSet;

use conversation_portability::{PortableContentBlock, PortableRole, PortableToolCallState};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::{encode_jsonl, infer_tool_states, nonempty_string, parse_jsonl, NativeFormatContext};
use crate::semantic::{NativeSemanticEvent, NativeSemanticGroup};
use crate::{
    NativeMaterializationError, NativeMaterializationFailureKind, NativeMaterializationResult,
    NativeRuntimeTarget,
};

pub(crate) fn serialize(
    context: &NativeFormatContext<'_>,
    groups: &[NativeSemanticGroup],
) -> NativeMaterializationResult<Vec<u8>> {
    let NativeRuntimeTarget::ClaudeCode { model } = context.target else {
        return Err(NativeMaterializationError::invalid(
            "Claude writer received a non-Claude target",
        ));
    };
    if groups.is_empty() {
        return Err(NativeMaterializationError::unsupported_semantics(
            "Claude Code requires at least one native history event to resume a materialized session",
        ));
    }
    let cwd = context.workspace.to_str().ok_or_else(|| {
        NativeMaterializationError::invalid("Target workspace is not valid UTF-8")
    })?;
    let mut records = Vec::new();
    let mut parent_uuid: Option<String> = None;
    let mut pending_boundary = false;

    for group in groups {
        match encode_group(group)? {
            EncodedClaudeGroup::Conversation {
                role,
                blocks,
                has_tool_use,
            } => {
                if pending_boundary {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Claude compact_boundary must be followed immediately by its compact summary",
                    ));
                }
                let record_uuid = Uuid::new_v4().to_string();
                let mut record = common_record(context, cwd, &record_uuid, parent_uuid.as_deref());
                if role == PortableRole::User {
                    record.insert("type".into(), Value::String("user".into()));
                    record.insert(
                        "message".into(),
                        json!({ "role": "user", "content": blocks }),
                    );
                } else {
                    record.insert("type".into(), Value::String("assistant".into()));
                    record.insert(
                        "message".into(),
                        assistant_message(
                            model,
                            blocks,
                            if has_tool_use { "tool_use" } else { "end_turn" },
                        ),
                    );
                    record.insert(
                        "requestId".into(),
                        Value::String(format!("req_org2_{}", Uuid::new_v4().simple())),
                    );
                }
                records.push(Value::Object(record));
                parent_uuid = Some(record_uuid);
            }
            EncodedClaudeGroup::CompactionBoundary(content) => {
                if pending_boundary {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Claude compact boundaries cannot be adjacent",
                    ));
                }
                let boundary_uuid = Uuid::new_v4().to_string();
                records.push(json!({
                    "type": "system",
                    "subtype": "compact_boundary",
                    "uuid": boundary_uuid,
                    "parentUuid": null,
                    "logicalParentUuid": parent_uuid,
                    "sessionId": context.session_id,
                    "timestamp": context.created_at,
                    "cwd": cwd,
                    "version": context.cli_version,
                    "isSidechain": false,
                    "content": content,
                    "isMeta": false
                }));
                parent_uuid = Some(boundary_uuid);
                pending_boundary = true;
            }
            EncodedClaudeGroup::CompactionSummary(text) => {
                if !pending_boundary {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Claude compact summary has no preceding portable compaction boundary",
                    ));
                }
                let summary_uuid = Uuid::new_v4().to_string();
                let mut summary =
                    common_record(context, cwd, &summary_uuid, parent_uuid.as_deref());
                summary.insert("type".into(), Value::String("user".into()));
                summary.insert("isVisibleInTranscriptOnly".into(), Value::Bool(true));
                summary.insert("isCompactSummary".into(), Value::Bool(true));
                summary.insert("message".into(), json!({ "role": "user", "content": text }));
                records.push(Value::Object(summary));
                parent_uuid = Some(summary_uuid);
                pending_boundary = false;
            }
        }
    }

    if pending_boundary {
        return Err(NativeMaterializationError::unsupported_semantics(
            "Claude transcript cannot end at a compaction boundary without its summary",
        ));
    }

    let leaf_uuid = parent_uuid.ok_or_else(|| {
        NativeMaterializationError::unsupported_semantics(
            "Claude Code materialization produced no resumable leaf",
        )
    })?;
    records.push(json!({
        "type": "last-prompt",
        "leafUuid": leaf_uuid,
        "sessionId": context.session_id
    }));
    encode_jsonl(records)
}

pub(crate) fn reparse(
    bytes: &[u8],
    context: &NativeFormatContext<'_>,
) -> NativeMaterializationResult<Vec<NativeSemanticGroup>> {
    let NativeRuntimeTarget::ClaudeCode { model } = context.target else {
        return Err(NativeMaterializationError::parity(
            "Claude reader received a non-Claude target",
        ));
    };
    let expected_cwd = context.workspace.to_str().ok_or_else(|| {
        NativeMaterializationError::invalid("Target workspace is not valid UTF-8")
    })?;
    let records = parse_jsonl(bytes)?;
    let (last_prompt, dialogue) = records
        .split_last()
        .ok_or_else(|| NativeMaterializationError::parity("Claude transcript has no records"))?;
    if last_prompt.get("type").and_then(Value::as_str) != Some("last-prompt")
        || last_prompt.get("sessionId").and_then(Value::as_str) != Some(context.session_id)
    {
        return Err(NativeMaterializationError::parity(
            "Claude transcript does not end with a matching last-prompt record",
        ));
    }

    let mut groups = Vec::new();
    let mut seen_uuids = HashSet::new();
    let mut current_leaf: Option<String> = None;
    let mut pending_boundary: Option<String> = None;
    for record in dialogue {
        validate_common(record, context, expected_cwd)?;
        let record_uuid = nonempty_string(record, "uuid", "Claude record")?.to_string();
        if !seen_uuids.insert(record_uuid.clone()) {
            return Err(NativeMaterializationError::parity(
                "Claude transcript contains a duplicate record UUID",
            ));
        }
        let record_type = nonempty_string(record, "type", "Claude record")?;
        if record_type == "system" {
            if pending_boundary.is_some()
                || record.get("subtype").and_then(Value::as_str) != Some("compact_boundary")
                || nullable_uuid_field(record, "parentUuid", "Claude compact_boundary")?.is_some()
                || nullable_uuid_field(record, "logicalParentUuid", "Claude compact_boundary")?
                    != current_leaf.as_deref()
                || record.get("isMeta") != Some(&Value::Bool(false))
            {
                return Err(NativeMaterializationError::parity(
                    "Claude compact_boundary does not continue the active UUID graph",
                ));
            }
            let content = exact_boundary_content(record.get("content"))?;
            groups.push(NativeSemanticGroup {
                events: vec![NativeSemanticEvent::CompactionBoundary { content }],
            });
            pending_boundary = Some(record_uuid.clone());
            current_leaf = Some(record_uuid);
            continue;
        }
        if nullable_uuid_field(record, "parentUuid", "Claude record")? != current_leaf.as_deref() {
            return Err(NativeMaterializationError::parity(
                "Claude record parentUuid does not continue the active UUID graph",
            ));
        }
        if record.get("isCompactSummary") == Some(&Value::Bool(true)) {
            if record_type != "user"
                || pending_boundary.as_deref() != current_leaf.as_deref()
                || record.get("isVisibleInTranscriptOnly") != Some(&Value::Bool(true))
            {
                return Err(NativeMaterializationError::parity(
                    "Claude compact summary is not attached to its boundary",
                ));
            }
            let message = message_object(record)?;
            if message.get("role").and_then(Value::as_str) != Some("user") {
                return Err(NativeMaterializationError::parity(
                    "Claude compact summary message role is not user",
                ));
            }
            let text = exact_summary_text(message.get("content"))?;
            groups.push(NativeSemanticGroup {
                events: vec![NativeSemanticEvent::CompactionSummary {
                    content: vec![PortableContentBlock::Text { text }],
                }],
            });
            pending_boundary = None;
            current_leaf = Some(record_uuid);
            continue;
        }
        if pending_boundary.is_some() {
            return Err(NativeMaterializationError::parity(
                "Claude compact_boundary is not followed by its compact summary",
            ));
        }
        if record.get("isMeta") == Some(&Value::Bool(true)) {
            return Err(NativeMaterializationError::parity(
                "Claude materialized transcript contains a metadata-only conversation record",
            ));
        }
        let message = message_object(record)?;
        let mut events = Vec::new();
        match record_type {
            "user" => parse_user_message(message, &mut events)?,
            "assistant" => parse_assistant_message(message, model, &mut events)?,
            _ => {
                return Err(NativeMaterializationError::parity(format!(
                    "Claude transcript contains unsupported active record type {record_type}"
                )));
            }
        }
        groups.push(NativeSemanticGroup { events });
        current_leaf = Some(record_uuid);
    }
    if pending_boundary.is_some() {
        return Err(NativeMaterializationError::parity(
            "Claude transcript ends at a compact_boundary without a summary",
        ));
    }
    if last_prompt.get("leafUuid").and_then(Value::as_str) != current_leaf.as_deref() {
        return Err(NativeMaterializationError::parity(
            "Claude last-prompt does not identify the active leaf",
        ));
    }
    infer_tool_states(&mut groups)?;
    Ok(groups)
}

enum EncodedClaudeGroup {
    Conversation {
        role: PortableRole,
        blocks: Vec<Value>,
        has_tool_use: bool,
    },
    CompactionBoundary(String),
    CompactionSummary(String),
}

fn encode_group(group: &NativeSemanticGroup) -> NativeMaterializationResult<EncodedClaudeGroup> {
    if group.events.is_empty() {
        return Err(NativeMaterializationError::invalid(
            "Portable native record group is empty",
        ));
    }
    if let [NativeSemanticEvent::CompactionBoundary { content }] = group.events.as_slice() {
        let content = match content.as_slice() {
            [] => String::new(),
            [PortableContentBlock::Text { text }] => text.clone(),
            _ => {
                return Err(NativeMaterializationError::unsupported_semantics(
                    "Claude Code compact_boundary only has a verified empty-or-single-text native representation",
                ));
            }
        };
        return Ok(EncodedClaudeGroup::CompactionBoundary(content));
    }
    if let [NativeSemanticEvent::CompactionSummary { content }] = group.events.as_slice() {
        let [PortableContentBlock::Text { text }] = content.as_slice() else {
            return Err(NativeMaterializationError::unsupported_semantics(
                "Claude Code compaction requires exactly one text block",
            ));
        };
        return Ok(EncodedClaudeGroup::CompactionSummary(text.clone()));
    }
    let mut role = None;
    let mut blocks = Vec::new();
    let mut has_tool_use = false;
    for event in &group.events {
        let (event_role, mut event_blocks) = match event {
            NativeSemanticEvent::Message { role, content } => {
                if matches!(role, PortableRole::System | PortableRole::Developer) {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Claude Code 2.1.2xx has no verified native replay record for system or developer messages",
                    ));
                }
                (*role, encode_message_content(*role, content)?)
            }
            NativeSemanticEvent::ToolCall {
                call_id,
                name,
                input,
                ..
            } => {
                if !input.is_object() {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Claude Code tool_use input must be a JSON object; wrapping it would change semantics",
                    ));
                }
                has_tool_use = true;
                (
                    PortableRole::Assistant,
                    vec![json!({
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": input
                    })],
                )
            }
            NativeSemanticEvent::ToolResult {
                call_id,
                content,
                is_error,
            } => (
                PortableRole::User,
                vec![json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": encode_tool_result_content(content)?,
                    "is_error": is_error
                })],
            ),
            NativeSemanticEvent::CompactionSummary { .. }
            | NativeSemanticEvent::CompactionBoundary { .. } => {
                return Err(NativeMaterializationError::unsupported_semantics(
                    "Claude compaction cannot share a native record with conversation blocks",
                ));
            }
        };
        if role.is_some_and(|role| role != event_role) {
            return Err(NativeMaterializationError::unsupported_semantics(
                "Claude source-record grouping changes role within one native message",
            ));
        }
        role = Some(event_role);
        blocks.append(&mut event_blocks);
    }
    Ok(EncodedClaudeGroup::Conversation {
        role: role.ok_or_else(|| NativeMaterializationError::invalid("Empty Claude group"))?,
        blocks,
        has_tool_use,
    })
}

pub(crate) fn appended_first_user_turn(
    appended: &[u8],
    expected_session_id: &str,
) -> NativeMaterializationResult<Option<String>> {
    for record in parse_jsonl(appended)? {
        if record.get("type").and_then(Value::as_str) != Some("user")
            || record.get("sessionId").and_then(Value::as_str) != Some(expected_session_id)
            || record.get("isMeta") == Some(&Value::Bool(true))
            || record.get("isCompactSummary") == Some(&Value::Bool(true))
        {
            continue;
        }
        let message = message_object(&record)?;
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let content = message.get("content").ok_or_else(|| {
            NativeMaterializationError::new(
                NativeMaterializationFailureKind::AcceptanceFailed,
                "Claude resumed user record has no content",
            )
        })?;
        if is_only_tool_results(content) {
            continue;
        }
        return Ok(Some(exact_public_user_text(content)?));
    }
    Ok(None)
}

fn common_record(
    context: &NativeFormatContext<'_>,
    cwd: &str,
    record_uuid: &str,
    parent_uuid: Option<&str>,
) -> Map<String, Value> {
    let mut record = Map::new();
    record.insert(
        "parentUuid".into(),
        parent_uuid.map_or(Value::Null, |value| Value::String(value.to_string())),
    );
    record.insert("isSidechain".into(), Value::Bool(false));
    record.insert("userType".into(), Value::String("external".into()));
    record.insert("cwd".into(), Value::String(cwd.to_string()));
    record.insert(
        "sessionId".into(),
        Value::String(context.session_id.to_string()),
    );
    record.insert(
        "version".into(),
        Value::String(context.cli_version.to_string()),
    );
    record.insert("gitBranch".into(), Value::String(String::new()));
    record.insert("uuid".into(), Value::String(record_uuid.to_string()));
    record.insert(
        "timestamp".into(),
        Value::String(context.created_at.to_string()),
    );
    record
}

fn assistant_message(model: &str, content: Vec<Value>, stop_reason: &str) -> Value {
    json!({
        "id": format!("msg_org2_{}", Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "output_tokens": 0
        }
    })
}

fn encode_message_content(
    role: PortableRole,
    blocks: &[PortableContentBlock],
) -> NativeMaterializationResult<Vec<Value>> {
    blocks
        .iter()
        .map(|block| match block {
            PortableContentBlock::Text { text } => Ok(json!({ "type": "text", "text": text })),
            PortableContentBlock::Image { uri } if role == PortableRole::User => {
                Ok(json!({ "type": "image", "source": claude_image_source(uri)? }))
            }
            PortableContentBlock::Image { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Claude Code 2.1.2xx only has a verified replay image block for user messages",
                ))
            }
            PortableContentBlock::Json { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Claude Code messages have no verified native arbitrary-JSON content block",
                ))
            }
        })
        .collect()
}

fn encode_tool_result_content(
    blocks: &[PortableContentBlock],
) -> NativeMaterializationResult<Vec<Value>> {
    blocks
        .iter()
        .map(|block| match block {
            PortableContentBlock::Text { text } => Ok(json!({ "type": "text", "text": text })),
            PortableContentBlock::Image { uri } => {
                Ok(json!({ "type": "image", "source": claude_image_source(uri)? }))
            }
            PortableContentBlock::Json { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Claude Code tool results have no verified native arbitrary-JSON content block",
                ))
            }
        })
        .collect()
}

fn claude_image_source(uri: &str) -> NativeMaterializationResult<Value> {
    let (header, data) = uri.split_once(',').ok_or_else(|| {
        NativeMaterializationError::unsupported_semantics("Invalid portable image data URI")
    })?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| {
            NativeMaterializationError::unsupported_semantics(
                "Claude Code only supports verified base64 image sources",
            )
        })?;
    Ok(json!({ "type": "base64", "media_type": media_type, "data": data }))
}

fn validate_common(
    record: &Value,
    context: &NativeFormatContext<'_>,
    cwd: &str,
) -> NativeMaterializationResult<()> {
    for (key, expected) in [
        ("sessionId", context.session_id),
        ("version", context.cli_version),
        ("cwd", cwd),
    ] {
        if record.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(NativeMaterializationError::parity(format!(
                "Claude record {key} does not match the explicit target"
            )));
        }
    }
    if record.get("isSidechain") != Some(&Value::Bool(false)) {
        return Err(NativeMaterializationError::parity(
            "Claude materialized record is a sidechain",
        ));
    }
    Ok(())
}

fn message_object(record: &Value) -> NativeMaterializationResult<&Map<String, Value>> {
    record
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeMaterializationError::parity("Claude record has no message object"))
}

fn parse_user_message(
    message: &Map<String, Value>,
    events: &mut Vec<NativeSemanticEvent>,
) -> NativeMaterializationResult<()> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return Err(NativeMaterializationError::parity(
            "Claude user record has a non-user message role",
        ));
    }
    let content = message
        .get("content")
        .ok_or_else(|| NativeMaterializationError::parity("Claude user message has no content"))?;
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return Err(NativeMaterializationError::parity(
                "Claude user message has empty text",
            ));
        }
        events.push(NativeSemanticEvent::Message {
            role: PortableRole::User,
            content: vec![PortableContentBlock::Text {
                text: text.to_string(),
            }],
        });
        return Ok(());
    }
    let blocks = content.as_array().ok_or_else(|| {
        NativeMaterializationError::parity("Claude user message content is not text or an array")
    })?;
    if blocks.is_empty() {
        return Err(NativeMaterializationError::parity(
            "Claude user message content is empty",
        ));
    }
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            events.push(parse_tool_result(block)?);
        } else {
            events.push(NativeSemanticEvent::Message {
                role: PortableRole::User,
                content: vec![parse_user_content_block(block)?],
            });
        }
    }
    Ok(())
}

fn parse_assistant_message(
    message: &Map<String, Value>,
    expected_model: &str,
    events: &mut Vec<NativeSemanticEvent>,
) -> NativeMaterializationResult<()> {
    if message.get("role").and_then(Value::as_str) != Some("assistant")
        || message.get("model").and_then(Value::as_str) != Some(expected_model)
    {
        return Err(NativeMaterializationError::parity(
            "Claude assistant message role/model does not match the explicit target",
        ));
    }
    let blocks = message
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            NativeMaterializationError::parity("Claude assistant content is not an array")
        })?;
    if blocks.is_empty() {
        return Err(NativeMaterializationError::parity(
            "Claude assistant message content is empty",
        ));
    }
    for block in blocks {
        match nonempty_string(block, "type", "Claude assistant block")? {
            "text" => events.push(NativeSemanticEvent::Message {
                role: PortableRole::Assistant,
                content: vec![PortableContentBlock::Text {
                    text: nonempty_string(block, "text", "Claude assistant text")?.to_string(),
                }],
            }),
            "tool_use" => {
                let input = block.get("input").cloned().ok_or_else(|| {
                    NativeMaterializationError::parity("Claude tool_use has no input")
                })?;
                if !input.is_object() {
                    return Err(NativeMaterializationError::parity(
                        "Claude tool_use input is not an object",
                    ));
                }
                events.push(NativeSemanticEvent::ToolCall {
                    call_id: nonempty_string(block, "id", "Claude tool_use")?.to_string(),
                    name: nonempty_string(block, "name", "Claude tool_use")?.to_string(),
                    state: PortableToolCallState::Pending,
                    input,
                });
            }
            block_type => {
                return Err(NativeMaterializationError::parity(format!(
                    "Claude assistant block {block_type} is not supported"
                )));
            }
        }
    }
    Ok(())
}

fn parse_tool_result(block: &Value) -> NativeMaterializationResult<NativeSemanticEvent> {
    let content = block
        .get("content")
        .ok_or_else(|| NativeMaterializationError::parity("Claude tool_result has no content"))?;
    let content = if let Some(text) = content.as_str() {
        if text.is_empty() {
            Vec::new()
        } else {
            vec![PortableContentBlock::Text {
                text: text.to_string(),
            }]
        }
    } else {
        content
            .as_array()
            .ok_or_else(|| {
                NativeMaterializationError::parity(
                    "Claude tool_result content is not text or an array",
                )
            })?
            .iter()
            .map(parse_tool_result_block)
            .collect::<NativeMaterializationResult<Vec<_>>>()?
    };
    let is_error = block
        .get("is_error")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            NativeMaterializationError::parity(
                "Claude tool_result is_error is not an explicit boolean",
            )
        })?;
    Ok(NativeSemanticEvent::ToolResult {
        call_id: nonempty_string(block, "tool_use_id", "Claude tool_result")?.to_string(),
        content,
        is_error,
    })
}

fn parse_user_content_block(block: &Value) -> NativeMaterializationResult<PortableContentBlock> {
    match nonempty_string(block, "type", "Claude user block")? {
        "text" => Ok(PortableContentBlock::Text {
            text: nonempty_string(block, "text", "Claude user text")?.to_string(),
        }),
        "image" => Ok(PortableContentBlock::Image {
            uri: image_uri_from_source(block.get("source"))?,
        }),
        block_type => Err(NativeMaterializationError::parity(format!(
            "Claude user block {block_type} is not supported"
        ))),
    }
}

fn parse_tool_result_block(block: &Value) -> NativeMaterializationResult<PortableContentBlock> {
    match nonempty_string(block, "type", "Claude tool result block")? {
        "text" => Ok(PortableContentBlock::Text {
            text: nonempty_string(block, "text", "Claude tool result text")?.to_string(),
        }),
        "image" => Ok(PortableContentBlock::Image {
            uri: image_uri_from_source(block.get("source"))?,
        }),
        block_type => Err(NativeMaterializationError::parity(format!(
            "Claude tool result block {block_type} is not supported"
        ))),
    }
}

fn image_uri_from_source(source: Option<&Value>) -> NativeMaterializationResult<String> {
    let source = source
        .and_then(Value::as_object)
        .ok_or_else(|| NativeMaterializationError::parity("Claude image has no source object"))?;
    if source.get("type").and_then(Value::as_str) != Some("base64") {
        return Err(NativeMaterializationError::parity(
            "Claude image source is not base64",
        ));
    }
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "image/gif" | "image/jpeg" | "image/png" | "image/webp"
            )
        })
        .ok_or_else(|| {
            NativeMaterializationError::parity("Claude image media type is unsupported")
        })?;
    let data = source
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeMaterializationError::parity("Claude image data is empty"))?;
    Ok(format!("data:{media_type};base64,{data}"))
}

fn exact_summary_text(content: Option<&Value>) -> NativeMaterializationResult<String> {
    if let Some(text) = content
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Ok(text.to_string());
    }
    let blocks = content.and_then(Value::as_array).ok_or_else(|| {
        NativeMaterializationError::parity("Claude compact summary has unsupported content")
    })?;
    let [block] = blocks.as_slice() else {
        return Err(NativeMaterializationError::parity(
            "Claude compact summary is not exactly one text block",
        ));
    };
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return Err(NativeMaterializationError::parity(
            "Claude compact summary block is not text",
        ));
    }
    Ok(nonempty_string(block, "text", "Claude compact summary")?.to_string())
}

fn exact_boundary_content(
    content: Option<&Value>,
) -> NativeMaterializationResult<Vec<PortableContentBlock>> {
    let text = content.and_then(Value::as_str).ok_or_else(|| {
        NativeMaterializationError::parity(
            "Claude compact_boundary content is not the verified string representation",
        )
    })?;
    if text.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![PortableContentBlock::Text {
            text: text.to_string(),
        }])
    }
}

fn exact_public_user_text(content: &Value) -> NativeMaterializationResult<String> {
    if let Some(text) = content.as_str() {
        return Ok(text.to_string());
    }
    let blocks = content.as_array().ok_or_else(|| {
        NativeMaterializationError::new(
            NativeMaterializationFailureKind::AcceptanceFailed,
            "Claude first resumed user turn has unsupported content",
        )
    })?;
    let [block] = blocks.as_slice() else {
        return Err(NativeMaterializationError::new(
            NativeMaterializationFailureKind::AcceptanceFailed,
            "Claude first resumed user turn is not exactly one text block",
        ));
    };
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return Err(NativeMaterializationError::new(
            NativeMaterializationFailureKind::AcceptanceFailed,
            "Claude first resumed user turn is not text",
        ));
    }
    block
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            NativeMaterializationError::new(
                NativeMaterializationFailureKind::AcceptanceFailed,
                "Claude first resumed user turn has no text",
            )
        })
}

fn is_only_tool_results(content: &Value) -> bool {
    content.as_array().is_some_and(|blocks| {
        !blocks.is_empty()
            && blocks
                .iter()
                .all(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
    })
}

fn nullable_uuid_field<'a>(
    record: &'a Value,
    key: &str,
    context: &str,
) -> NativeMaterializationResult<Option<&'a str>> {
    match record.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        Some(_) => Err(NativeMaterializationError::parity(format!(
            "{context} {key} is not null or a non-empty UUID string"
        ))),
        None => Err(NativeMaterializationError::parity(format!(
            "{context} is missing {key}"
        ))),
    }
}
