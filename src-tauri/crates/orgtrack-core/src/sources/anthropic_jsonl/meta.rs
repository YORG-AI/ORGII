use crate::sources::imported_history::{
    self,
    metadata::ImportedHistoryDiscoveredRecord,
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
};

use super::config::AnthropicJsonlSource;
use super::meta_state::SessionMetaState;
use super::model::SessionMeta;
use super::transcript::{messages_to_chunks, read_transcript};

const MAX_INCREMENTAL_STATE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct IncrementalSessionMetaParse {
    pub(super) meta: SessionMeta,
    pub(super) watermark: ImportedParseWatermark,
}

pub(super) fn parse_session_meta(
    config: &AnthropicJsonlSource,
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<SessionMeta, String> {
    let read = read_transcript(config, &record.source_path)?;

    let fallback_ms = record.source_mtime_ms / 1_000_000;
    let session_id = format!("{}{}", config.session_prefix, record.source_session_id);
    let impact = imported_history::impact_from_edit_chunks(&messages_to_chunks(
        config,
        &session_id,
        &read.turns,
    ));
    Ok(SessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        name: read
            .first_user_text
            .map(|value| imported_history::truncate_name(&value, 200))
            .unwrap_or_else(|| record.source_record_key.clone()),
        created_at_ms: if read.created_at_ms > 0 {
            read.created_at_ms
        } else {
            fallback_ms
        },
        updated_at_ms: if read.updated_at_ms > 0 {
            read.updated_at_ms
        } else {
            fallback_ms
        },
        model: read.model,
        input_tokens: read.input_tokens,
        output_tokens: read.output_tokens,
        cache_read_tokens: read.cache_read_tokens,
        cache_write_tokens: read.cache_write_tokens,
        repo_path: read.repo_path,
        branch: read.branch,
        impact,
    })
}

pub(super) fn parse_session_meta_incremental(
    config: &AnthropicJsonlSource,
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<IncrementalSessionMetaParse, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        config.display_name,
        watermark,
        config.parser_version,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = SessionMetaState::default();
    if let Some(state_json) = reader.resume_state_json() {
        match (state_json.len() <= MAX_INCREMENTAL_STATE_BYTES)
            .then(|| serde_json::from_str::<SessionMetaState>(state_json))
        {
            Some(Ok(parsed)) if parsed.validate_bounds().is_ok() => {
                state = parsed;
            }
            _ => {
                reader = WatermarkedTranscriptReader::open(
                    &record.source_path,
                    config.display_name,
                    None,
                    config.parser_version,
                    record.source_mtime_ms,
                    record.source_size_bytes,
                )?;
            }
        }
    }
    let mut tail_state = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed)?;
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed)?;
            tail_state = Some(snapshot);
        }
    }
    let state_json = serde_json::to_string(&state).map_err(|err| {
        format!(
            "Failed to serialize {} parse state: {err}",
            config.display_name
        )
    })?;
    if state_json.len() > MAX_INCREMENTAL_STATE_BYTES {
        return Err(format!(
            "{} incremental parse state exceeds the {}-byte safety limit",
            config.display_name, MAX_INCREMENTAL_STATE_BYTES
        ));
    }
    let next_watermark = reader.into_watermark(
        config.parser_version,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let meta = tail_state.unwrap_or(state).finish(config, record)?;
    Ok(IncrementalSessionMetaParse {
        meta,
        watermark: next_watermark,
    })
}
