//! Kimi Code loop-event replay, coalescing streamed step parts into chunks.

use std::collections::HashMap;
use std::path::Path;

use core_types::activity::ActivityChunk;
use serde_json::Value;

use crate::sources::imported_history::{self, watermark::WatermarkedTranscriptReader};

use super::identity::{
    KIMI_METADATA_PARSER_VERSION, MAX_CODE_OPEN_STEPS, MAX_ID_BYTES, MAX_REPLAY_MESSAGE_CHARS,
    MAX_REPLAY_TEXT_BYTES,
};
use super::replay::{bounded_replay_fragment, push_replay_message, push_replay_thinking};
use super::wire::{code_context_message_text, code_loop_part, code_timestamp_ms};

#[derive(Debug)]
struct PendingCodeStep {
    created_at: String,
    thinking: String,
    thinking_chars: usize,
    text: String,
    text_chars: usize,
}

pub(super) fn read_code_replay(
    path: &Path,
    session_id: &str,
    mtime: i64,
    size: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Kimi Code",
        None,
        KIMI_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut chunks = Vec::new();
    let mut retained_text_bytes = 0usize;
    let mut pending_text_bytes = 0usize;
    let mut open_steps = HashMap::<String, PendingCodeStep>::new();
    let mut step_order = Vec::<String>::new();

    while let Some(line) = reader.next_line()? {
        let Ok(value) = serde_json::from_str::<Value>(line.text.trim()) else {
            continue;
        };
        let timestamp = code_timestamp_ms(&value).unwrap_or(mtime / 1_000_000);
        let created_at = imported_history::epoch_ms_to_iso(timestamp);

        if let Some((role, text)) = code_context_message_text(&value) {
            if matches!(role, "user" | "assistant") && !text.is_empty() {
                push_replay_message(
                    &mut chunks,
                    &mut retained_text_bytes,
                    session_id,
                    role,
                    &created_at,
                    text,
                )?;
            }
            continue;
        }

        if value.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
            continue;
        }
        let Some(event) = value.get("event") else {
            continue;
        };
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "step.begin" => {
                let Some(step_id) = bounded_code_id(event.get("uuid")) else {
                    continue;
                };
                if open_steps.contains_key(&step_id) || open_steps.len() >= MAX_CODE_OPEN_STEPS {
                    continue;
                }
                open_steps.insert(
                    step_id.clone(),
                    PendingCodeStep {
                        created_at,
                        thinking: String::new(),
                        thinking_chars: 0,
                        text: String::new(),
                        text_chars: 0,
                    },
                );
                step_order.push(step_id);
            }
            "content.part" => {
                let Some(step_id) = bounded_code_id(event.get("stepUuid")) else {
                    continue;
                };
                let Some((kind, raw)) = code_loop_part(&value) else {
                    continue;
                };
                let Some(step) = open_steps.get_mut(&step_id) else {
                    continue;
                };
                let (target, chars) = if kind == "think" {
                    (&mut step.thinking, &mut step.thinking_chars)
                } else {
                    (&mut step.text, &mut step.text_chars)
                };
                append_code_replay_fragment(
                    target,
                    chars,
                    raw,
                    retained_text_bytes,
                    &mut pending_text_bytes,
                )?;
            }
            "step.end" => {
                let Some(step_id) = bounded_code_id(event.get("uuid")) else {
                    continue;
                };
                if let Some(step) = open_steps.remove(&step_id) {
                    flush_code_step(
                        &mut chunks,
                        &mut retained_text_bytes,
                        &mut pending_text_bytes,
                        session_id,
                        step,
                    )?;
                }
            }
            _ => {}
        }
    }

    for step_id in step_order {
        if let Some(step) = open_steps.remove(&step_id) {
            flush_code_step(
                &mut chunks,
                &mut retained_text_bytes,
                &mut pending_text_bytes,
                session_id,
                step,
            )?;
        }
    }
    Ok(chunks)
}

fn bounded_code_id(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)
        .map(str::to_string)
}

fn append_code_replay_fragment(
    target: &mut String,
    target_chars: &mut usize,
    raw: &str,
    retained_text_bytes: usize,
    pending_text_bytes: &mut usize,
) -> Result<(), String> {
    let remaining_chars = MAX_REPLAY_MESSAGE_CHARS.saturating_sub(*target_chars);
    let reserved_bytes = retained_text_bytes.saturating_add(*pending_text_bytes);
    let remaining_bytes = MAX_REPLAY_TEXT_BYTES.saturating_sub(reserved_bytes);
    if remaining_bytes == 0 && !raw.is_empty() {
        return Err("Kimi replay exceeds the bounded in-memory safety limit".to_string());
    }
    let fragment = bounded_replay_fragment(raw, remaining_chars, remaining_bytes);
    *target_chars = (*target_chars).saturating_add(fragment.chars().count());
    *pending_text_bytes = (*pending_text_bytes).saturating_add(fragment.len());
    target.push_str(&fragment);
    Ok(())
}

fn flush_code_step(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    pending_text_bytes: &mut usize,
    session_id: &str,
    step: PendingCodeStep,
) -> Result<(), String> {
    *pending_text_bytes = (*pending_text_bytes)
        .saturating_sub(step.thinking.len())
        .saturating_sub(step.text.len());
    if !step.thinking.is_empty() {
        push_replay_thinking(
            chunks,
            retained_text_bytes,
            session_id,
            &step.created_at,
            step.thinking,
        )?;
    }
    if !step.text.is_empty() {
        push_replay_message(
            chunks,
            retained_text_bytes,
            session_id,
            "assistant",
            &step.created_at,
            step.text,
        )?;
    }
    Ok(())
}
