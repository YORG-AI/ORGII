use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use crate::{
    EncodedPortableConversation, PortableContentBlock, PortableConversation, PortableEventBody,
    MAX_PORTABLE_CONVERSATION_BYTES,
};

/// ORG2 canonical JSON v1.
///
/// The format is implemented here rather than delegated to a serializer's map
/// feature flags: object keys use Rust `str` lexical order, arrays retain input
/// order, strings use the fixed escaping rules below, integers use base-10,
/// and finite floats use the pinned `ryu` formatter. Golden vectors freeze the
/// bytes and digest for cross-version compatibility.
pub(crate) fn encode_canonical_json(
    conversation: &PortableConversation,
) -> Result<EncodedPortableConversation, String> {
    encode_canonical_json_with_limit(conversation, MAX_PORTABLE_CONVERSATION_BYTES)
}

#[cfg(test)]
pub(crate) fn encode_canonical_json_with_test_limit(
    conversation: &PortableConversation,
    limit: usize,
) -> Result<EncodedPortableConversation, String> {
    encode_canonical_json_with_limit(conversation, limit)
}

fn encode_canonical_json_with_limit(
    conversation: &PortableConversation,
    limit: usize,
) -> Result<EncodedPortableConversation, String> {
    let lower_bound = payload_lower_bound(conversation)?;
    if lower_bound > limit {
        return Err(format!(
            "Portable conversation payload is at least {lower_bound} bytes; limit is {limit}"
        ));
    }

    let value = serde_json::to_value(conversation)
        .map_err(|err| format!("Failed to prepare portable canonical JSON: {err}"))?;
    let mut writer = CappedWriter::new(limit);
    write_value(&mut writer, &value)?;
    let bytes = writer.finish();
    Ok(EncodedPortableConversation {
        sha256: hex_lower(&Sha256::digest(&bytes)),
        bytes,
    })
}

fn payload_lower_bound(conversation: &PortableConversation) -> Result<usize, String> {
    let mut total = 0usize;
    add_escaped_len(&mut total, &conversation.schema)?;
    add_escaped_len(&mut total, &conversation.source.source_kind)?;
    add_escaped_len(&mut total, &conversation.source.source_session_id)?;
    add_escaped_len(&mut total, &conversation.source.source_snapshot.digest)?;
    for value in [
        conversation.source.source_runtime_version.as_deref(),
        conversation.source.title.as_deref(),
        conversation.source.model.as_deref(),
        conversation.source.source_workspace_hint.as_deref(),
        conversation.source.started_at.as_deref(),
        conversation.source.updated_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        add_escaped_len(&mut total, value)?;
    }
    for event in &conversation.events {
        add_escaped_len(&mut total, &event.event_id)?;
        for provenance in [
            event.source_record_type.as_deref(),
            event.source_record_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            add_escaped_len(&mut total, provenance)?;
        }
        if let Some(thread_id) = event.source_thread_id.as_deref() {
            add_escaped_len(&mut total, thread_id)?;
        }
        if let Some(timestamp) = event.timestamp.as_deref() {
            add_escaped_len(&mut total, timestamp)?;
        }
        match &event.body {
            PortableEventBody::Message { content, .. }
            | PortableEventBody::ToolResult { content, .. }
            | PortableEventBody::Annotation { content, .. }
            | PortableEventBody::CompactionSummary { content }
            | PortableEventBody::CompactionBoundary { content } => {
                add_content_lower_bound(&mut total, content)?;
            }
            PortableEventBody::ToolCall {
                call_id,
                name,
                canonical_name,
                input,
                ..
            } => {
                add_escaped_len(&mut total, call_id)?;
                add_escaped_len(&mut total, name)?;
                add_escaped_len(&mut total, canonical_name)?;
                add_len(&mut total, value_lower_bound(input)?)?;
            }
        }
    }
    Ok(total)
}

fn add_content_lower_bound(
    total: &mut usize,
    content: &[PortableContentBlock],
) -> Result<(), String> {
    for block in content {
        match block {
            PortableContentBlock::Text { text } => add_escaped_len(total, text)?,
            PortableContentBlock::Image { uri } => add_escaped_len(total, uri)?,
            PortableContentBlock::Json { value } => {
                add_len(total, value_lower_bound(value)?)?;
            }
        }
    }
    Ok(())
}

fn value_lower_bound(value: &Value) -> Result<usize, String> {
    match value {
        Value::Null => Ok(4),
        Value::Bool(true) => Ok(4),
        Value::Bool(false) => Ok(5),
        Value::Number(number) => Ok(number.to_string().len()),
        Value::String(value) => escaped_string_len(value)?
            .checked_add(2)
            .ok_or_else(|| "Portable JSON size overflowed".to_string()),
        Value::Array(values) => {
            let mut total = 2usize;
            if !values.is_empty() {
                add_len(&mut total, values.len() - 1)?;
            }
            for value in values {
                add_len(&mut total, value_lower_bound(value)?)?;
            }
            Ok(total)
        }
        Value::Object(values) => {
            let mut total = 2usize;
            if !values.is_empty() {
                add_len(&mut total, values.len() - 1)?;
            }
            for (key, value) in values {
                add_len(&mut total, escaped_string_len(key)?)?;
                add_len(&mut total, 3)?; // key quotes plus colon
                add_len(&mut total, value_lower_bound(value)?)?;
            }
            Ok(total)
        }
    }
}

fn add_len(total: &mut usize, value: usize) -> Result<(), String> {
    *total = total
        .checked_add(value)
        .ok_or_else(|| "Portable conversation size overflowed".to_string())?;
    Ok(())
}

fn add_escaped_len(total: &mut usize, value: &str) -> Result<(), String> {
    add_len(total, escaped_string_len(value)?)
}

fn escaped_string_len(value: &str) -> Result<usize, String> {
    value.chars().try_fold(0usize, |total, character| {
        let encoded = match character {
            '"' | '\\' | '\u{08}' | '\u{09}' | '\u{0a}' | '\u{0c}' | '\u{0d}' => 2,
            character if character <= '\u{1f}' => 6,
            character => character.len_utf8(),
        };
        total
            .checked_add(encoded)
            .ok_or_else(|| "Portable JSON size overflowed".to_string())
    })
}

struct CappedWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl CappedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| "Portable canonical JSON size overflowed".to_string())?;
        if next > self.limit {
            return Err(format!(
                "Portable conversation exceeds the {}-byte canonical limit",
                self.limit
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn byte(&mut self, byte: u8) -> Result<(), String> {
        self.push(&[byte])
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn write_value(writer: &mut CappedWriter, value: &Value) -> Result<(), String> {
    match value {
        Value::Null => writer.push(b"null"),
        Value::Bool(true) => writer.push(b"true"),
        Value::Bool(false) => writer.push(b"false"),
        Value::Number(number) => write_number(writer, number),
        Value::String(value) => write_string(writer, value),
        Value::Array(values) => {
            writer.byte(b'[')?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    writer.byte(b',')?;
                }
                write_value(writer, value)?;
            }
            writer.byte(b']')
        }
        Value::Object(values) => {
            writer.byte(b'{')?;
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    writer.byte(b',')?;
                }
                write_string(writer, key)?;
                writer.byte(b':')?;
                write_value(writer, value)?;
            }
            writer.byte(b'}')
        }
    }
}

fn write_number(writer: &mut CappedWriter, number: &Number) -> Result<(), String> {
    if let Some(value) = number.as_i64() {
        return writer.push(value.to_string().as_bytes());
    }
    if let Some(value) = number.as_u64() {
        return writer.push(value.to_string().as_bytes());
    }
    let value = number
        .as_f64()
        .ok_or_else(|| "Portable JSON contains an unsupported number".to_string())?;
    if !value.is_finite() {
        return Err("Portable JSON contains a non-finite number".to_string());
    }
    let mut buffer = ryu::Buffer::new();
    writer.push(buffer.format_finite(value).as_bytes())
}

fn write_string(writer: &mut CappedWriter, value: &str) -> Result<(), String> {
    writer.byte(b'"')?;
    for character in value.chars() {
        match character {
            '"' => writer.push(br#"\""#)?,
            '\\' => writer.push(br#"\\"#)?,
            '\u{08}' => writer.push(br#"\b"#)?,
            '\u{09}' => writer.push(br#"\t"#)?,
            '\u{0a}' => writer.push(br#"\n"#)?,
            '\u{0c}' => writer.push(br#"\f"#)?,
            '\u{0d}' => writer.push(br#"\r"#)?,
            character if character <= '\u{1f}' => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let value = character as u8;
                writer.push(&[
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    HEX[(value >> 4) as usize],
                    HEX[(value & 0x0f) as usize],
                ])?;
            }
            character => {
                let mut encoded = [0u8; 4];
                writer.push(character.encode_utf8(&mut encoded).as_bytes())?;
            }
        }
    }
    writer.byte(b'"')
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}
