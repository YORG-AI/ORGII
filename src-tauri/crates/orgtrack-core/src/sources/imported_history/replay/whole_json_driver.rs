//! Streaming whole-document replay adapter for Cline.
//!
//! Cline rewrites one `{ "messages": [...] }` JSON document. A rewrite is a
//! new replay generation, never a byte-offset append. The custom serde seed
//! holds at most one message plus outstanding tool calls, so cold indexing is
//! bounded by the largest message rather than the transcript size.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use core_types::activity::ActivityChunk;
use rusqlite::{params, Transaction};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::sources::imported_history::{self, ImportedToolCall};

use super::index::ReplayIndexState;
use super::payload_artifact;
use super::structured_driver::{compact_chunk, range_from_text, rebuild_turns};
use super::{ImportedHistorySourceId, ReplayPayloadDescriptor, ReplayPayloadRange, ReplayStats};

const CLINE_PROVIDER: &str = "cline";

#[derive(Debug, Clone)]
pub(super) struct WholeJsonSyncOutcome {
    pub stats: ReplayStats,
    pub driver_cursor_json: String,
    pub indexed_size_bytes: u64,
    pub total_events: u64,
    pub total_turns: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct WholeJsonCursor {
    message_count: u64,
    source_bytes: u64,
    sample_fingerprint: String,
}

pub(super) fn cursor_fingerprint(cursor_json: &str) -> Option<String> {
    serde_json::from_str::<WholeJsonCursor>(cursor_json)
        .ok()
        .map(|cursor| cursor.sample_fingerprint)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ClineMessage {
    role: String,
    content: Value,
    ts: Option<i64>,
}

impl Default for ClineMessage {
    fn default() -> Self {
        Self {
            role: String::new(),
            content: Value::Null,
            ts: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ClinePayloadLocator {
    Text {
        message_ordinal: u64,
        block_ordinal: usize,
        user: bool,
    },
    Tool {
        call_message_ordinal: u64,
        call_block_ordinal: usize,
        sub_index: usize,
        result_message_ordinal: Option<u64>,
        result_block_ordinal: Option<usize>,
    },
}

#[derive(Debug)]
struct PendingCall {
    raw_name: String,
    created_at: String,
    call_message_ordinal: u64,
    call_block_ordinal: usize,
    sub_calls: Vec<(String, Value)>,
    sequences: Vec<i64>,
    turn_index: i64,
}

struct IndexFold<'tx, 'conn, 'data> {
    tx: &'tx Transaction<'conn>,
    display_session_id: &'data str,
    source_session_id: &'data str,
    generation: &'data str,
    write_revision: u64,
    message_ordinal: u64,
    next_sequence: i64,
    turn_index: i64,
    pending: HashMap<String, PendingCall>,
    stats: ReplayStats,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    _previous_state: Option<&ReplayIndexState>,
    sample_fingerprint: &str,
) -> Result<WholeJsonSyncOutcome, String> {
    let source_bytes = std::fs::metadata(source_path)
        .map_err(|err| format!("stat Cline replay source {}: {err}", source_path.display()))?
        .len();
    let mut fold = IndexFold {
        tx,
        display_session_id,
        source_session_id,
        generation,
        write_revision,
        message_ordinal: 0,
        next_sequence: 0,
        turn_index: -1,
        pending: HashMap::new(),
        stats: ReplayStats::default(),
    };
    visit_messages(source_path, |message| fold_message(&mut fold, message))?;
    flush_pending(&mut fold)?;
    rebuild_turns(
        tx,
        ImportedHistorySourceId::Cline,
        source_session_id,
        generation,
    )?;
    let total_events = count_rows(tx, "imported_replay_events", source_session_id, generation)?;
    let total_turns = count_rows(tx, "imported_replay_turns", source_session_id, generation)?;
    Ok(WholeJsonSyncOutcome {
        driver_cursor_json: serde_json::to_string(&WholeJsonCursor {
            message_count: fold.message_ordinal,
            source_bytes,
            sample_fingerprint: sample_fingerprint.to_string(),
        })
        .map_err(|err| format!("encode Cline replay cursor: {err}"))?,
        indexed_size_bytes: source_bytes,
        total_events,
        total_turns,
        stats: fold.stats,
    })
}

fn fold_message(fold: &mut IndexFold<'_, '_, '_>, message: ClineMessage) -> Result<(), String> {
    let message_ordinal = fold.message_ordinal;
    fold.message_ordinal = fold.message_ordinal.saturating_add(1);
    fold.stats.parsed_rows = fold.stats.parsed_rows.saturating_add(1);
    fold.stats.parsed_bytes = fold
        .stats
        .parsed_bytes
        .saturating_add(serde_json::to_vec(&message).map_or(0, |bytes| bytes.len()) as u64);
    let created_at = message
        .ts
        .filter(|timestamp| *timestamp > 0)
        .map(imported_history::epoch_ms_to_iso)
        .unwrap_or_default();
    let user = message.role == "user";
    for (block_ordinal, block) in content_blocks(&message.content).enumerate() {
        match block_type(block) {
            "text" => {
                let raw = block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let text = if user {
                    strip_user_input_wrapper(raw)
                } else {
                    raw.trim()
                };
                if text.is_empty() {
                    continue;
                }
                if user {
                    fold.turn_index = fold.turn_index.saturating_add(1).max(0);
                }
                let chunk = if user {
                    imported_history::user_message_chunk(
                        fold.display_session_id,
                        CLINE_PROVIDER,
                        fold.next_sequence.max(0) as usize,
                        &created_at,
                        text,
                    )
                } else {
                    imported_history::assistant_message_chunk(
                        fold.display_session_id,
                        CLINE_PROVIDER,
                        fold.next_sequence.max(0) as usize,
                        &created_at,
                        text,
                    )
                };
                let locator = ClinePayloadLocator::Text {
                    message_ordinal,
                    block_ordinal,
                    user,
                };
                let sequence = take_sequence(fold);
                let turn_index = fold.turn_index.max(0);
                upsert_cline_event(
                    fold,
                    &format!("message:{message_ordinal}:block:{block_ordinal}:text"),
                    sequence,
                    turn_index,
                    chunk,
                    &locator,
                )?;
            }
            "tool_use" => {
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if call_id.is_empty() {
                    continue;
                }
                let raw_name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                let (sub_calls, _) = expand_cline_tool_call(&raw_name, &input);
                let sequences = (0..sub_calls.len()).map(|_| take_sequence(fold)).collect();
                fold.pending.insert(
                    call_id,
                    PendingCall {
                        raw_name,
                        created_at: created_at.clone(),
                        call_message_ordinal: message_ordinal,
                        call_block_ordinal: block_ordinal,
                        sub_calls,
                        sequences,
                        turn_index: fold.turn_index.max(0),
                    },
                );
            }
            "tool_result" => {
                let Some(call_id) = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .filter(|call_id| !call_id.is_empty())
                else {
                    continue;
                };
                let Some(pending) = fold.pending.remove(call_id) else {
                    continue;
                };
                emit_cline_tool(
                    fold,
                    call_id,
                    pending,
                    Some((message_ordinal, block_ordinal, block)),
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn flush_pending(fold: &mut IndexFold<'_, '_, '_>) -> Result<(), String> {
    let pending = std::mem::take(&mut fold.pending);
    for (call_id, pending) in pending {
        emit_cline_tool(fold, &call_id, pending, None)?;
    }
    Ok(())
}

fn emit_cline_tool(
    fold: &mut IndexFold<'_, '_, '_>,
    call_id: &str,
    pending: PendingCall,
    result: Option<(u64, usize, &Value)>,
) -> Result<(), String> {
    let batched = pending.sub_calls.len() > 1
        || matches!(
            pending.raw_name.as_str(),
            "run_commands" | "read_files" | "search_codebase"
        );
    let result_value = result.and_then(|(_, _, block)| block.get("content"));
    let failed = result
        .map(|(_, _, block)| {
            block.get("is_error").and_then(Value::as_bool) == Some(true)
                || block.get("success").and_then(Value::as_bool) == Some(false)
        })
        .unwrap_or(false);
    for (sub_index, ((canonical_name, args), sequence)) in pending
        .sub_calls
        .into_iter()
        .zip(pending.sequences)
        .enumerate()
    {
        let mut output = cline_sub_output(result_value, sub_index, batched);
        if pending.raw_name == "read_files" {
            output = strip_cline_read_gutter(&output);
        }
        let call = ImportedToolCall {
            call_id: format!("{call_id}#{sub_index}"),
            raw_name: pending.raw_name.clone(),
            canonical_name,
            args,
            created_at: pending.created_at.clone(),
        };
        let mut chunk = imported_history::tool_call_chunk(
            fold.display_session_id,
            CLINE_PROVIDER,
            sequence.max(0) as usize,
            &call,
            &output,
        );
        if failed || cline_sub_success(result_value, sub_index, batched) == Some(false) {
            if let Some(object) = chunk.result.as_object_mut() {
                object.insert("success".to_string(), Value::Bool(false));
                object.insert("status".to_string(), Value::String("failed".to_string()));
            }
        }
        let locator = ClinePayloadLocator::Tool {
            call_message_ordinal: pending.call_message_ordinal,
            call_block_ordinal: pending.call_block_ordinal,
            sub_index,
            result_message_ordinal: result.map(|(ordinal, _, _)| ordinal),
            result_block_ordinal: result.map(|(_, block, _)| block),
        };
        upsert_cline_event(
            fold,
            &format!(
                "message:{}:block:{}:tool:{call_id}:{sub_index}",
                pending.call_message_ordinal, pending.call_block_ordinal
            ),
            sequence,
            pending.turn_index,
            chunk,
            &locator,
        )?;
    }
    Ok(())
}

fn take_sequence(fold: &mut IndexFold<'_, '_, '_>) -> i64 {
    let sequence = fold.next_sequence;
    fold.next_sequence = fold.next_sequence.saturating_add(1);
    sequence
}

fn upsert_cline_event(
    fold: &mut IndexFold<'_, '_, '_>,
    event_key: &str,
    sequence: i64,
    turn_index: i64,
    mut chunk: ActivityChunk,
    locator: &ClinePayloadLocator,
) -> Result<(), String> {
    let source = ImportedHistorySourceId::Cline;
    let event_id = stable_event_id(fold.source_session_id, event_key);
    chunk.chunk_id = event_id.clone();
    let content_hash = hash_parts(&[serde_json::to_string(&chunk).unwrap_or_default().as_bytes()]);
    let locator_json = serde_json::to_string(locator)
        .map_err(|err| format!("encode Cline replay locator: {err}"))?;
    let full_chunk = chunk.clone();
    let payloads = compact_chunk(&mut chunk, &locator_json);
    for payload in &payloads {
        let text = chunk_field_text(&full_chunk, &payload.field_path)?;
        payload_artifact::store_text(
            fold.tx,
            source,
            fold.source_session_id,
            fold.generation,
            &event_id,
            &payload.field_path,
            &text,
        )
        .map_err(|err| format!("store Cline replay payload artifact: {err}"))?;
    }
    let args_json = serde_json::to_string(&chunk.args)
        .map_err(|err| format!("encode Cline replay args: {err}"))?;
    let result_json = serde_json::to_string(&chunk.result)
        .map_err(|err| format!("encode Cline replay result: {err}"))?;
    let payloads_json = serde_json::to_string(&payloads)
        .map_err(|err| format!("encode Cline replay payloads: {err}"))?;
    fold.tx
        .execute(
            "INSERT INTO imported_replay_events(
                 source,source_session_id,generation,sequence,event_id,turn_index,
                 action_type,function_name,created_at,args_preview_json,result_preview_json,
                 args_size_bytes,result_size_bytes,thread_id,process_id,source_start,source_end,
                 payloads_json,content_hash,event_revision
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0,0,?16,?17,?18)
             ON CONFLICT(source,source_session_id,generation,event_id) DO UPDATE SET
                 sequence=excluded.sequence,turn_index=excluded.turn_index,
                 action_type=excluded.action_type,function_name=excluded.function_name,
                 created_at=excluded.created_at,args_preview_json=excluded.args_preview_json,
                 result_preview_json=excluded.result_preview_json,args_size_bytes=excluded.args_size_bytes,
                 result_size_bytes=excluded.result_size_bytes,thread_id=excluded.thread_id,
                 process_id=excluded.process_id,payloads_json=excluded.payloads_json,
                 content_hash=excluded.content_hash,event_revision=excluded.event_revision",
            params![
                source.as_str(),
                fold.source_session_id,
                fold.generation,
                sequence,
                event_id,
                turn_index,
                chunk.action_type,
                chunk.function,
                chunk.created_at,
                args_json,
                result_json,
                chunk.args.to_string().len() as i64,
                chunk.result.to_string().len() as i64,
                chunk.thread_id,
                chunk.process_id,
                payloads_json,
                content_hash,
                fold.write_revision.min(i64::MAX as u64) as i64,
            ],
        )
        .map_err(|err| format!("upsert Cline replay event: {err}"))?;
    fold.stats.normalized_events = fold.stats.normalized_events.saturating_add(1);
    fold.stats.upserted_events = fold.stats.upserted_events.saturating_add(1);
    Ok(())
}

pub(super) fn read_payload(
    source_path: &Path,
    payloads_json: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let payloads: Vec<ReplayPayloadDescriptor> = serde_json::from_str(payloads_json)
        .map_err(|err| format!("decode Cline payload locators: {err}"))?;
    let payload = payloads
        .iter()
        .find(|payload| payload.field_path == field_path)
        .ok_or_else(|| "Cline replay payload field is not range-backed".to_string())?;
    let locator: ClinePayloadLocator = serde_json::from_str(
        payload
            .source_key
            .as_deref()
            .ok_or_else(|| "Cline replay payload locator is missing".to_string())?,
    )
    .map_err(|err| format!("decode Cline payload locator: {err}"))?;
    let chunk = reconstruct_chunk(source_path, &locator)?;
    let text = chunk_field_text(&chunk, field_path)?;
    range_from_text(event_id, field_path, &text, offset, max_bytes)
}

fn reconstruct_chunk(path: &Path, locator: &ClinePayloadLocator) -> Result<ActivityChunk, String> {
    let mut call_block = None;
    let mut result_block = None;
    let mut text_block = None;
    let mut text_created_at = String::new();
    let mut ordinal = 0_u64;
    visit_messages(path, |message| {
        let current = ordinal;
        ordinal = ordinal.saturating_add(1);
        match locator {
            ClinePayloadLocator::Text {
                message_ordinal,
                block_ordinal,
                ..
            } if current == *message_ordinal => {
                text_block = content_blocks(&message.content)
                    .nth(*block_ordinal)
                    .cloned();
                text_created_at = message
                    .ts
                    .filter(|timestamp| *timestamp > 0)
                    .map(imported_history::epoch_ms_to_iso)
                    .unwrap_or_default();
            }
            ClinePayloadLocator::Tool {
                call_message_ordinal,
                call_block_ordinal,
                result_message_ordinal,
                result_block_ordinal,
                ..
            } => {
                if current == *call_message_ordinal {
                    call_block = content_blocks(&message.content)
                        .nth(*call_block_ordinal)
                        .cloned();
                    text_created_at = message
                        .ts
                        .filter(|timestamp| *timestamp > 0)
                        .map(imported_history::epoch_ms_to_iso)
                        .unwrap_or_default();
                }
                if result_message_ordinal == &Some(current) {
                    if let Some(block_ordinal) = result_block_ordinal {
                        result_block = content_blocks(&message.content)
                            .nth(*block_ordinal)
                            .cloned();
                    }
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    match locator {
        ClinePayloadLocator::Text { user, .. } => {
            let block = text_block.ok_or_else(|| "Cline text payload moved".to_string())?;
            let raw = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = if *user {
                strip_user_input_wrapper(raw)
            } else {
                raw.trim()
            };
            Ok(if *user {
                imported_history::user_message_chunk(
                    "clineapp-payload",
                    CLINE_PROVIDER,
                    0,
                    &text_created_at,
                    text,
                )
            } else {
                imported_history::assistant_message_chunk(
                    "clineapp-payload",
                    CLINE_PROVIDER,
                    0,
                    &text_created_at,
                    text,
                )
            })
        }
        ClinePayloadLocator::Tool { sub_index, .. } => {
            let call_block = call_block.ok_or_else(|| "Cline tool payload moved".to_string())?;
            let call_id = call_block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let raw_name = call_block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let input = call_block.get("input").cloned().unwrap_or(Value::Null);
            let (sub_calls, batched) = expand_cline_tool_call(raw_name, &input);
            let (canonical_name, args) = sub_calls
                .into_iter()
                .nth(*sub_index)
                .ok_or_else(|| "Cline tool sub-call moved".to_string())?;
            let result_value = result_block.as_ref().and_then(|block| block.get("content"));
            let mut output = cline_sub_output(result_value, *sub_index, batched);
            if raw_name == "read_files" {
                output = strip_cline_read_gutter(&output);
            }
            let call = ImportedToolCall {
                call_id: format!("{call_id}#{sub_index}"),
                raw_name: raw_name.to_string(),
                canonical_name,
                args,
                created_at: text_created_at,
            };
            Ok(imported_history::tool_call_chunk(
                "clineapp-payload",
                CLINE_PROVIDER,
                0,
                &call,
                &output,
            ))
        }
    }
}

fn visit_messages(
    path: &Path,
    mut visit: impl FnMut(ClineMessage) -> Result<(), String>,
) -> Result<(), String> {
    let file = File::open(path)
        .map_err(|err| format!("open Cline replay source {}: {err}", path.display()))?;
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    TranscriptSeed { visit: &mut visit }
        .deserialize(&mut deserializer)
        .map_err(|err| format!("parse Cline replay source {}: {err}", path.display()))?;
    deserializer
        .end()
        .map_err(|err| format!("parse Cline replay source {}: {err}", path.display()))
}

struct TranscriptSeed<'a, F> {
    visit: &'a mut F,
}

impl<'de, F> DeserializeSeed<'de> for TranscriptSeed<'_, F>
where
    F: FnMut(ClineMessage) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(TranscriptVisitor { visit: self.visit })
    }
}

struct TranscriptVisitor<'a, F> {
    visit: &'a mut F,
}

impl<'de, F> Visitor<'de> for TranscriptVisitor<'_, F>
where
    F: FnMut(ClineMessage) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a Cline transcript object or message array")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut found = false;
        while let Some(key) = map.next_key::<String>()? {
            if key == "messages" {
                found = true;
                map.next_value_seed(MessagesSeed {
                    visit: &mut *self.visit,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if !found {
            return Err(serde::de::Error::custom(
                "Cline transcript has no messages array",
            ));
        }
        Ok(())
    }

    fn visit_seq<A>(self, sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        MessagesVisitor {
            visit: &mut *self.visit,
        }
        .visit_seq(sequence)
    }
}

struct MessagesSeed<'a, F> {
    visit: &'a mut F,
}

impl<'de, F> DeserializeSeed<'de> for MessagesSeed<'_, F>
where
    F: FnMut(ClineMessage) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(MessagesVisitor { visit: self.visit })
    }
}

struct MessagesVisitor<'a, F> {
    visit: &'a mut F,
}

impl<'de, F> Visitor<'de> for MessagesVisitor<'_, F>
where
    F: FnMut(ClineMessage) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a Cline messages array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while let Some(message) = sequence.next_element::<ClineMessage>()? {
            (self.visit)(message).map_err(serde::de::Error::custom)?;
        }
        Ok(())
    }
}

fn content_blocks(content: &Value) -> impl Iterator<Item = &Value> {
    content.as_array().into_iter().flatten()
}

fn block_type(block: &Value) -> &str {
    block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn strip_user_input_wrapper(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("<user_input") else {
        return trimmed;
    };
    let Some(end) = after_open.find('>') else {
        return trimmed;
    };
    after_open[end + 1..]
        .strip_suffix("</user_input>")
        .unwrap_or(&after_open[end + 1..])
        .trim()
}

fn expand_cline_tool_call(name: &str, input: &Value) -> (Vec<(String, Value)>, bool) {
    let sub_calls = match name {
        "run_commands" => input_array(input, "commands")
            .map(|command| {
                (
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    json!({"command":command,"cmd":command}),
                )
            })
            .collect::<Vec<_>>(),
        "read_files" => input_array(input, "files")
            .map(|file| {
                (
                    imported_history::FUNCTION_READ_FILE.to_string(),
                    json!({"file_path":file.get("path").cloned().unwrap_or(Value::Null)}),
                )
            })
            .collect(),
        "search_codebase" => input_array(input, "queries")
            .map(|query| {
                (
                    imported_history::FUNCTION_CODE_SEARCH.to_string(),
                    json!({"query":query}),
                )
            })
            .collect(),
        "editor" => {
            return (
                vec![(
                    imported_history::FUNCTION_EDIT_FILE.to_string(),
                    json!({
                        "file_path":input.get("path").cloned().unwrap_or(Value::Null),
                        "old_string":input.get("old_text").cloned().filter(|value| !value.is_null()).unwrap_or_else(|| json!("")),
                        "new_string":input.get("new_text").cloned().unwrap_or_else(|| json!("")),
                    }),
                )],
                false,
            );
        }
        _ => Vec::new(),
    };
    if sub_calls.is_empty() {
        (vec![(name.to_string(), input.clone())], false)
    } else {
        (sub_calls, true)
    }
}

fn input_array<'a>(input: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn cline_sub_output(results: Option<&Value>, index: usize, batched: bool) -> String {
    if batched {
        return results
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .map(|item| value_to_text(item.get("result").unwrap_or(item)))
            .unwrap_or_default();
    }
    results.map(value_to_text).unwrap_or_default()
}

fn cline_sub_success(results: Option<&Value>, index: usize, batched: bool) -> Option<bool> {
    let result = if batched {
        results?.as_array()?.get(index)?
    } else if let Some(first) = results?.as_array().and_then(|items| items.first()) {
        first
    } else {
        results?
    };
    result.get("success").and_then(Value::as_bool)
}

fn value_to_text(value: &Value) -> String {
    let mut output = String::new();
    append_value_text(value, &mut output);
    output.trim().to_string()
}

fn append_value_text(value: &Value, output: &mut String) {
    match value {
        Value::String(text) => push_line(output, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, output);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get("text").or_else(|| map.get("result")) {
                push_line(output, text);
            } else {
                push_line(output, &value.to_string());
            }
        }
        Value::Null => {}
        value => push_line(output, &value.to_string()),
    }
}

fn push_line(output: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(text);
}

fn strip_cline_read_gutter(text: &str) -> String {
    if text
        .lines()
        .find(|line| !line.trim().is_empty())
        .is_none_or(|line| gutter_body(line).is_none())
    {
        return text.to_string();
    }
    text.lines()
        .map(|line| gutter_body(line).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn gutter_body(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let digits_end = trimmed.find(|character: char| !character.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let rest = trimmed[digits_end..]
        .strip_prefix(' ')
        .unwrap_or(&trimmed[digits_end..]);
    let rest = rest.strip_prefix('|')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

fn chunk_field_text(chunk: &ActivityChunk, field_path: &str) -> Result<String, String> {
    let (root, path) = field_path
        .split_once('.')
        .map_or((field_path, ""), |parts| parts);
    let value = match root {
        "args" => &chunk.args,
        "result" => &chunk.result,
        _ => return Err("Cline replay field must be under args or result".to_string()),
    };
    let target = if path.is_empty() {
        value
    } else {
        path.split('.')
            .try_fold(value, |current, key| current.get(key))
            .ok_or_else(|| "Cline replay payload field moved".to_string())?
    };
    Ok(target
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| target.to_string()))
}

fn count_rows(
    tx: &Transaction<'_>,
    table: &str,
    source_session_id: &str,
    generation: &str,
) -> Result<u64, String> {
    tx.query_row(
        &format!(
            "SELECT COUNT(*) FROM {table} WHERE source='cline' AND source_session_id=?1 AND generation=?2"
        ),
        params![source_session_id, generation],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as u64)
    .map_err(|err| format!("count Cline replay {table}: {err}"))
}

fn stable_event_id(source_session_id: &str, event_key: &str) -> String {
    format!(
        "replay-cline-{}",
        hash_parts(&[source_session_id.as_bytes(), event_key.as_bytes()])
    )
}

fn hash_parts(parts: &[&[u8]]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use std::io::{BufWriter, Write};

    use super::*;
    use crate::projectors::turn_metadata::TurnMetadataAccumulator;

    fn replay_cache(path: &Path) -> (rusqlite::Connection, String) {
        use crate::store::sqlite::SqliteRecordStore;

        let cache = rusqlite::Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&cache).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        let session_id = "clineapp-cline-1".to_string();
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES('cline','cline-1',?1,?2)",
                params![session_id, path.to_string_lossy()],
            )
            .expect("cache Cline source");
        (cache, session_id)
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "orgii-cline-replay-{name}-{}-{}.json",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn metadata_from_chunks(chunks: &[ActivityChunk]) -> TurnMetadataAccumulator {
        let mut metadata = TurnMetadataAccumulator::new();
        for chunk in chunks {
            metadata.add_event_values_at(
                Some(&chunk.function),
                &chunk.args,
                &chunk.result,
                &chunk.created_at,
            );
        }
        metadata
    }

    #[test]
    fn invalid_partial_rewrite_is_reported_not_ready() {
        let path = temp_path("partial");
        std::fs::write(&path, br#"{"messages":[{"role":"user","content":["#)
            .expect("partial fixture");
        assert!(visit_messages(&path, |_| Ok(())).is_err());
        std::fs::write(
            &path,
            br#"{"messages":[{"role":"user","content":[{"type":"text","text":"ok"}]}]}"#,
        )
        .expect("complete fixture");
        visit_messages(&path, |_| Ok(())).expect("complete probe");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn thirty_mib_document_streams_one_message_at_a_time() {
        let path = temp_path("30mib");
        let file = File::create(&path).expect("fixture file");
        let mut writer = BufWriter::new(file);
        writer.write_all(br#"{"messages":["#).unwrap();
        let padding = "x".repeat(30 * 1024);
        for index in 0..1024 {
            if index > 0 {
                writer.write_all(b",").unwrap();
            }
            serde_json::to_writer(
                &mut writer,
                &json!({
                    "role":"assistant",
                    "content":[{"type":"text","text":padding}],
                    "ts":1_700_000_000_000_i64 + index,
                }),
            )
            .unwrap();
        }
        writer.write_all(b"]}").unwrap();
        writer.flush().unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() >= 30 * 1024 * 1024);
        let mut count = 0_u64;
        visit_messages(&path, |_| {
            count += 1;
            Ok(())
        })
        .expect("stream 30 MiB fixture");
        assert_eq!(count, 1024);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cline_compact_projection_matches_full_large_edit_and_git_output() {
        let path = temp_path("metadata");
        let large_edit = "new line\n".repeat(2_000);
        let git_output = format!(
            "[feature cab1234] metadata\n{}\nhttps://github.com/acme/cline/pull/99",
            "middle".repeat(14 * 1024)
        );
        assert!(large_edit.len() > super::super::NORMAL_PAYLOAD_PREVIEW_BYTES);
        assert!(git_output.len() > 80 * 1024);
        let transcript = json!({
            "messages":[
                {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">metadata</user_input>"}],"ts":1_700_000_000_000_i64},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"edit-1","name":"editor",
                    "input":{"path":"src/cline-large.rs","old_text":"old\nvalue","new_text":large_edit}
                }],"ts":1_700_000_000_001_i64},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"edit-1","content":"done"
                }],"ts":1_700_000_000_002_i64},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"git-1","name":"run_commands",
                    "input":{"commands":["git commit -m metadata"]}
                }],"ts":1_700_000_000_003_i64},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"git-1",
                    "content":[{"result":git_output,"success":true}]
                }],"ts":1_700_000_000_004_i64}
            ]
        });
        std::fs::write(&path, transcript.to_string()).expect("Cline metadata transcript");
        let (mut cache, session_id) = replay_cache(&path);
        let legacy =
            crate::sources::cline::history::load_cline_history_for_session(&cache, &session_id)
                .expect("load full Cline metadata baseline");
        let expected = metadata_from_chunks(&legacy);
        assert_eq!(expected.modified_files()[0].path, "src/cline-large.rs");
        assert_eq!(expected.modified_files()[0].additions, 2_000);
        assert_eq!(expected.modified_files()[0].deletions, 2);
        assert!(expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("cab1234")));
        // The legacy full loader caps one Cline tool result at 50k chars, so
        // the tail PR URL is the exact metadata that the bounded adapter must
        // improve on rather than reproduce losing.
        assert!(!expected
            .git_artifacts()
            .iter()
            .any(|artifact| artifact.pr_number == Some(99)));

        let projected = super::super::project_turn_metadata(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            None,
        )
        .expect("project compact Cline metadata");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].modified_files, expected.modified_files());
        assert_eq!(
            serde_json::to_value(&projected[0].resource_interactions).unwrap(),
            serde_json::to_value(expected.resource_interactions()).unwrap()
        );
        assert!(projected[0]
            .git_artifacts
            .iter()
            .any(|artifact| artifact.sha.as_deref() == Some("cab1234")));
        assert!(projected[0]
            .git_artifacts
            .iter()
            .any(|artifact| artifact.pr_number == Some(99)));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cline_public_replay_keeps_last_valid_generation_during_partial_rewrite() {
        let path = temp_path("atomic");
        let large_text = "cline-large-".repeat(900_000);
        let initial = json!({
            "messages":[
                {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">hello</user_input>"}],"ts":1_700_000_000_000_i64},
                {"role":"assistant","content":[{"type":"text","text":large_text}],"ts":1_700_000_000_001_i64}
            ]
        });
        std::fs::write(&path, initial.to_string()).expect("initial Cline transcript");
        let (mut cache, session_id) = replay_cache(&path);
        let opened = super::super::open_window(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            super::super::ReplayLimits::default(),
        )
        .expect("open Cline bounded replay");
        assert_eq!(opened.chunks.len(), 2);
        let assistant = opened
            .chunks
            .iter()
            .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
            .expect("Cline assistant");
        let artifact_count = cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='cline' AND generation=?1",
                [&opened.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("count deduplicated Cline artifacts");
        let artifact_ref_count = cache
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs
                 WHERE source='cline' AND generation=?1",
                [&opened.cursor.generation],
                |row| row.get::<_, i64>(0),
            )
            .expect("count Cline artifact refs");
        assert_eq!(
            artifact_count, 1,
            "identical compatibility fields share bytes"
        );
        assert_eq!(artifact_ref_count, 2);
        let first_range = super::super::read_payload_range(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &opened.cursor.generation,
            &assistant.chunk.chunk_id,
            "result.content",
            0,
            Some(2048),
        )
        .expect("Cline payload artifact");
        assert_eq!(first_range.text, large_text[..2048]);

        std::fs::write(&path, br#"{"messages":[{"role":"assistant","content":["#)
            .expect("partial Cline rewrite");
        let partial = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("serve previous Cline generation");
        assert!(partial.stats.not_ready);
        assert!(!partial.reset_required);
        assert_eq!(partial.cursor.generation, opened.cursor.generation);
        let old_range = super::super::read_payload_range(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &opened.cursor.generation,
            &assistant.chunk.chunk_id,
            "result.content",
            2048,
            Some(2048),
        )
        .expect("old Cline artifact during invalid rewrite");
        assert_eq!(old_range.text, large_text[2048..4096]);

        let complete = json!({
            "messages":[
                {"role":"user","content":[{"type":"text","text":"hello"}]},
                {"role":"assistant","content":[{"type":"text","text":"done"}]},
                {"role":"user","content":[{"type":"text","text":"second"}]},
                {"role":"assistant","content":[{"type":"text","text":"second done"}]}
            ]
        });
        std::fs::write(&path, complete.to_string()).expect("complete Cline rewrite");
        let reset = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &opened.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("publish complete Cline generation");
        assert!(reset.reset_required);
        assert_ne!(reset.cursor.generation, opened.cursor.generation);
        assert_eq!(reset.chunks.len(), 2);

        let unchanged = super::super::poll_delta(
            &mut cache,
            ImportedHistorySourceId::Cline,
            &session_id,
            &reset.cursor,
            super::super::ReplayLimits::default(),
        )
        .expect("unchanged Cline poll");
        assert_eq!(unchanged.stats.parsed_rows, 0);
        assert_eq!(unchanged.stats.upserted_events, 0);
        let _ = std::fs::remove_file(path);
    }
}
