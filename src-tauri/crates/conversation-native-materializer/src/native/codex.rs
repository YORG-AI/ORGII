use conversation_portability::{PortableContentBlock, PortableRole, PortableToolCallState};
use serde_json::{json, Value};

use super::{encode_jsonl, infer_tool_states, nonempty_string, parse_jsonl, NativeFormatContext};
use crate::semantic::{NativeSemanticEvent, NativeSemanticGroup};
use crate::{NativeMaterializationError, NativeMaterializationResult, NativeRuntimeTarget};

pub(crate) fn serialize(
    context: &NativeFormatContext<'_>,
    groups: &[NativeSemanticGroup],
) -> NativeMaterializationResult<Vec<u8>> {
    let NativeRuntimeTarget::Codex { model_provider, .. } = context.target else {
        return Err(NativeMaterializationError::invalid(
            "Codex writer received a non-Codex target",
        ));
    };
    let cwd = context.workspace.to_str().ok_or_else(|| {
        NativeMaterializationError::invalid("Target workspace is not valid UTF-8")
    })?;
    let mut records = vec![json!({
        "timestamp": context.created_at,
        "type": "session_meta",
        "payload": {
            "session_id": context.session_id,
            "id": context.session_id,
            "timestamp": context.created_at,
            "cwd": cwd,
            "originator": "org2-native-materializer",
            "cli_version": context.cli_version,
            "source": "cli",
            "model_provider": model_provider,
            "history_mode": "legacy"
        }
    })];

    for group in groups {
        if group.events.is_empty() {
            return Err(NativeMaterializationError::invalid(
                "Portable native record group is empty",
            ));
        }
        if let Some((role, content)) = grouped_message_content(group)? {
            let native_content = encode_message_content(role, &content)?;
            if let [PortableContentBlock::Text { text }] = content.as_slice() {
                if matches!(role, PortableRole::User | PortableRole::Assistant) {
                    records.push(json!({
                        "timestamp": context.created_at,
                        "type": "event_msg",
                        "payload": {
                            "type": if role == PortableRole::User { "user_message" } else { "agent_message" },
                            "message": text
                        }
                    }));
                }
            }
            records.push(json!({
                "timestamp": context.created_at,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": role_name(role),
                    "content": native_content
                }
            }));
            continue;
        }
        let [event] = group.events.as_slice() else {
            return Err(NativeMaterializationError::unsupported_semantics(
                "Codex 0.144.x cannot preserve this mixed native source-record grouping",
            ));
        };
        match event {
            NativeSemanticEvent::Message { .. } => {
                return Err(NativeMaterializationError::unsupported_semantics(
                    "Codex message grouping could not be represented as one native response_item",
                ));
            }
            NativeSemanticEvent::ToolCall {
                call_id,
                name,
                input,
                ..
            } => {
                let arguments = serde_json::to_string(input).map_err(|error| {
                    NativeMaterializationError::unsupported_semantics(format!(
                        "Codex tool input cannot be encoded as JSON: {error}"
                    ))
                })?;
                records.push(json!({
                    "timestamp": context.created_at,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": name,
                        "arguments": arguments,
                        "call_id": call_id
                    }
                }));
            }
            NativeSemanticEvent::ToolResult {
                call_id,
                content,
                is_error,
            } => {
                if *is_error {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Codex 0.144.x has no verified native error-state field for function_call_output",
                    ));
                }
                records.push(json!({
                    "timestamp": context.created_at,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": encode_tool_result_content(content)?
                    }
                }));
            }
            NativeSemanticEvent::CompactionSummary { content } => {
                let [PortableContentBlock::Text { text }] = content.as_slice() else {
                    return Err(NativeMaterializationError::unsupported_semantics(
                        "Codex compaction requires exactly one text block",
                    ));
                };
                records.push(json!({
                    "timestamp": context.created_at,
                    "type": "compacted",
                    "payload": { "message": text }
                }));
            }
            NativeSemanticEvent::CompactionBoundary { .. } => {
                return Err(NativeMaterializationError::unsupported_semantics(
                    "Codex 0.144.x has no verified native compaction-boundary record",
                ));
            }
        }
    }
    encode_jsonl(records)
}

pub(crate) fn reparse(
    bytes: &[u8],
    context: &NativeFormatContext<'_>,
) -> NativeMaterializationResult<Vec<NativeSemanticGroup>> {
    let NativeRuntimeTarget::Codex { model_provider, .. } = context.target else {
        return Err(NativeMaterializationError::parity(
            "Codex reader received a non-Codex target",
        ));
    };
    let expected_cwd = context.workspace.to_str().ok_or_else(|| {
        NativeMaterializationError::invalid("Target workspace is not valid UTF-8")
    })?;
    let records = parse_jsonl(bytes)?;
    let Some(first) = records.first() else {
        return Err(NativeMaterializationError::parity(
            "Codex transcript has no session_meta record",
        ));
    };
    if first.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err(NativeMaterializationError::parity(
            "Codex transcript does not begin with session_meta",
        ));
    }
    validate_session_meta(
        first,
        context.session_id,
        expected_cwd,
        context.cli_version,
        model_provider,
    )?;

    let mut groups = Vec::new();
    let mut pending_projection: Option<(PortableRole, String)> = None;
    for record in records.iter().skip(1) {
        let record_type = nonempty_string(record, "type", "Codex record")?;
        let payload = record
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(|| NativeMaterializationError::parity("Codex record has no payload"))?;
        match record_type {
            "event_msg" => {
                if pending_projection.is_some() {
                    return Err(NativeMaterializationError::parity(
                        "Codex transcript has adjacent unmatched UI projections",
                    ));
                }
                let event_type = payload.get("type").and_then(Value::as_str);
                let role = match event_type {
                    Some("user_message") => PortableRole::User,
                    Some("agent_message") => PortableRole::Assistant,
                    _ => {
                        return Err(NativeMaterializationError::parity(
                            "Codex transcript contains an unsupported event_msg",
                        ));
                    }
                };
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        NativeMaterializationError::parity(
                            "Codex UI projection has no non-empty message",
                        )
                    })?;
                pending_projection = Some((role, message.to_string()));
            }
            "response_item" => {
                let parsed = parse_response_item(&Value::Object(payload.clone()))?;
                if let Some((projected_role, projected_text)) = pending_projection.take() {
                    if parsed.iter().any(|event| {
                        !matches!(event, NativeSemanticEvent::Message { role, .. } if *role == projected_role)
                    }) || projected_text_blocks(&parsed).as_slice() != [projected_text.as_str()]
                    {
                        return Err(NativeMaterializationError::parity(
                            "Codex UI projection disagrees with model-visible response_item",
                        ));
                    }
                }
                groups.push(NativeSemanticGroup { events: parsed });
            }
            "compacted" => {
                if pending_projection.is_some() {
                    return Err(NativeMaterializationError::parity(
                        "Codex UI projection is not followed by its response_item",
                    ));
                }
                let text = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        NativeMaterializationError::parity(
                            "Codex compacted record has no non-empty message",
                        )
                    })?;
                groups.push(NativeSemanticGroup {
                    events: vec![NativeSemanticEvent::CompactionSummary {
                        content: vec![PortableContentBlock::Text {
                            text: text.to_string(),
                        }],
                    }],
                });
            }
            _ => {
                return Err(NativeMaterializationError::parity(format!(
                    "Codex transcript contains unsupported record type {record_type}"
                )));
            }
        }
    }
    if pending_projection.is_some() {
        return Err(NativeMaterializationError::parity(
            "Codex transcript ends with an unmatched UI projection",
        ));
    }
    infer_tool_states(&mut groups)?;
    Ok(groups)
}

fn grouped_message_content(
    group: &NativeSemanticGroup,
) -> NativeMaterializationResult<Option<(PortableRole, Vec<PortableContentBlock>)>> {
    let Some(NativeSemanticEvent::Message { role, .. }) = group.events.first() else {
        return Ok(None);
    };
    let mut content = Vec::new();
    for event in &group.events {
        let NativeSemanticEvent::Message {
            role: event_role,
            content: event_content,
        } = event
        else {
            return Err(NativeMaterializationError::unsupported_semantics(
                "Codex message record grouping contains a non-message event",
            ));
        };
        if event_role != role {
            return Err(NativeMaterializationError::unsupported_semantics(
                "Codex message record grouping changes role within one native record",
            ));
        }
        content.extend(event_content.iter().cloned());
    }
    Ok(Some((*role, content)))
}

fn projected_text_blocks(events: &[NativeSemanticEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            NativeSemanticEvent::Message { content, .. } => match content.as_slice() {
                [PortableContentBlock::Text { text }] => Some(text.as_str()),
                [PortableContentBlock::Image { .. }] | [PortableContentBlock::Json { .. }] => None,
                _ => None,
            },
            _ => None,
        })
        .collect()
}

pub(crate) fn appended_first_user_turn(
    appended: &[u8],
) -> NativeMaterializationResult<Option<String>> {
    for value in parse_jsonl(appended)? {
        if value.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message")
            || payload.get("role").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        return Ok(Some(exact_text_turn(payload.get("content"))?));
    }
    Ok(None)
}

fn validate_session_meta(
    value: &Value,
    session_id: &str,
    cwd: &str,
    cli_version: &str,
    model_provider: &str,
) -> NativeMaterializationResult<()> {
    let payload = value
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeMaterializationError::parity("Codex session_meta has no payload"))?;
    for (key, expected) in [
        ("id", session_id),
        ("session_id", session_id),
        ("cwd", cwd),
        ("cli_version", cli_version),
        ("model_provider", model_provider),
        ("history_mode", "legacy"),
    ] {
        if payload.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(NativeMaterializationError::parity(format!(
                "Codex session_meta {key} does not match the explicit target"
            )));
        }
    }
    if payload
        .get("history_base")
        .is_some_and(|value| !value.is_null())
    {
        return Err(NativeMaterializationError::parity(
            "Codex history_base lineage is not allowed for a new target session",
        ));
    }
    Ok(())
}

fn parse_response_item(value: &Value) -> NativeMaterializationResult<Vec<NativeSemanticEvent>> {
    let item_type = nonempty_string(value, "type", "Codex response_item payload")?;
    match item_type {
        "message" => {
            let role = parse_role(nonempty_string(value, "role", "Codex message")?)?;
            let content = parse_message_content(
                role,
                value
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        NativeMaterializationError::parity(
                            "Codex response message content is not an array",
                        )
                    })?,
            )?;
            Ok(content
                .into_iter()
                .map(|block| NativeSemanticEvent::Message {
                    role,
                    content: vec![block],
                })
                .collect())
        }
        "function_call" => {
            let call_id = nonempty_string(value, "call_id", "Codex function_call")?;
            let name = nonempty_string(value, "name", "Codex function_call")?;
            let arguments = nonempty_string(value, "arguments", "Codex function_call")?;
            let input = serde_json::from_str(arguments).map_err(|error| {
                NativeMaterializationError::parity(format!(
                    "Codex function_call arguments are not JSON: {error}"
                ))
            })?;
            Ok(vec![NativeSemanticEvent::ToolCall {
                call_id: call_id.to_string(),
                name: name.to_string(),
                state: PortableToolCallState::Pending,
                input,
            }])
        }
        "function_call_output" => {
            let call_id = nonempty_string(value, "call_id", "Codex function_call_output")?;
            let content = parse_tool_result_content(value.get("output").ok_or_else(|| {
                NativeMaterializationError::parity("Codex function_call_output has no output")
            })?)?;
            Ok(vec![NativeSemanticEvent::ToolResult {
                call_id: call_id.to_string(),
                content,
                is_error: false,
            }])
        }
        _ => Err(NativeMaterializationError::parity(format!(
            "Codex response_item type {item_type} is not part of the materialized transcript"
        ))),
    }
}

fn encode_message_content(
    role: PortableRole,
    blocks: &[PortableContentBlock],
) -> NativeMaterializationResult<Vec<Value>> {
    blocks
        .iter()
        .map(|block| match block {
            PortableContentBlock::Text { text } => Ok(json!({
                "type": if role == PortableRole::Assistant { "output_text" } else { "input_text" },
                "text": text
            })),
            PortableContentBlock::Image { uri } if role == PortableRole::User => {
                Ok(json!({ "type": "input_image", "image_url": uri }))
            }
            PortableContentBlock::Image { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Codex 0.144.x only has a verified native image block for user messages",
                ))
            }
            PortableContentBlock::Json { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Codex messages have no verified native arbitrary-JSON content block",
                ))
            }
        })
        .collect()
}

fn parse_message_content(
    role: PortableRole,
    blocks: &[Value],
) -> NativeMaterializationResult<Vec<PortableContentBlock>> {
    if blocks.is_empty() {
        return Err(NativeMaterializationError::parity(
            "Codex message content is empty",
        ));
    }
    blocks
        .iter()
        .map(|block| {
            let block_type = nonempty_string(block, "type", "Codex message block")?;
            match block_type {
                "input_text" if role != PortableRole::Assistant => Ok(PortableContentBlock::Text {
                    text: nonempty_string(block, "text", "Codex input_text")?.to_string(),
                }),
                "output_text" if role == PortableRole::Assistant => {
                    Ok(PortableContentBlock::Text {
                        text: nonempty_string(block, "text", "Codex output_text")?.to_string(),
                    })
                }
                "input_image" if role == PortableRole::User => Ok(PortableContentBlock::Image {
                    uri: nonempty_string(block, "image_url", "Codex input_image")?.to_string(),
                }),
                _ => Err(NativeMaterializationError::parity(format!(
                    "Codex message block {block_type} is not valid for role {}",
                    role_name(role)
                ))),
            }
        })
        .collect()
}

fn encode_tool_result_content(
    blocks: &[PortableContentBlock],
) -> NativeMaterializationResult<Value> {
    if blocks.is_empty() {
        return Ok(Value::String(String::new()));
    }
    let blocks = blocks
        .iter()
        .map(|block| match block {
            PortableContentBlock::Text { text } => {
                Ok(json!({ "type": "input_text", "text": text }))
            }
            PortableContentBlock::Image { uri } => {
                Ok(json!({ "type": "input_image", "image_url": uri }))
            }
            PortableContentBlock::Json { .. } => {
                Err(NativeMaterializationError::unsupported_semantics(
                    "Codex tool results have no verified native arbitrary-JSON content block",
                ))
            }
        })
        .collect::<NativeMaterializationResult<Vec<_>>>()?;
    Ok(Value::Array(blocks))
}

fn parse_tool_result_content(
    value: &Value,
) -> NativeMaterializationResult<Vec<PortableContentBlock>> {
    if let Some(text) = value.as_str() {
        return if text.is_empty() {
            Ok(Vec::new())
        } else {
            Ok(vec![PortableContentBlock::Text {
                text: text.to_string(),
            }])
        };
    }
    let blocks = value.as_array().ok_or_else(|| {
        NativeMaterializationError::parity(
            "Codex function_call_output must be a string or content array",
        )
    })?;
    blocks
        .iter()
        .map(
            |block| match nonempty_string(block, "type", "Codex tool result block")? {
                "input_text" => Ok(PortableContentBlock::Text {
                    text: nonempty_string(block, "text", "Codex tool result text")?.to_string(),
                }),
                "input_image" => Ok(PortableContentBlock::Image {
                    uri: nonempty_string(block, "image_url", "Codex tool result image")?
                        .to_string(),
                }),
                block_type => Err(NativeMaterializationError::parity(format!(
                    "Codex tool result block {block_type} is not supported"
                ))),
            },
        )
        .collect()
}

fn exact_text_turn(content: Option<&Value>) -> NativeMaterializationResult<String> {
    let blocks = content.and_then(Value::as_array).ok_or_else(|| {
        NativeMaterializationError::new(
            crate::NativeMaterializationFailureKind::AcceptanceFailed,
            "Codex first resumed user turn has non-array content",
        )
    })?;
    let [block] = blocks.as_slice() else {
        return Err(NativeMaterializationError::new(
            crate::NativeMaterializationFailureKind::AcceptanceFailed,
            "Codex first resumed user turn is not exactly one text block",
        ));
    };
    if block.get("type").and_then(Value::as_str) != Some("input_text") {
        return Err(NativeMaterializationError::new(
            crate::NativeMaterializationFailureKind::AcceptanceFailed,
            "Codex first resumed user turn is not input_text",
        ));
    }
    block
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            NativeMaterializationError::new(
                crate::NativeMaterializationFailureKind::AcceptanceFailed,
                "Codex first resumed user turn has no text",
            )
        })
}

fn role_name(role: PortableRole) -> &'static str {
    match role {
        PortableRole::User => "user",
        PortableRole::Assistant => "assistant",
        PortableRole::System => "system",
        PortableRole::Developer => "developer",
    }
}

fn parse_role(value: &str) -> NativeMaterializationResult<PortableRole> {
    match value {
        "user" => Ok(PortableRole::User),
        "assistant" => Ok(PortableRole::Assistant),
        "system" => Ok(PortableRole::System),
        "developer" => Ok(PortableRole::Developer),
        _ => Err(NativeMaterializationError::parity(format!(
            "Codex message has unsupported role {value}"
        ))),
    }
}
