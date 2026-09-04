//! Watermarked metadata parse for one session: replay the event scan into a
//! [`CopilotMetaState`], then fold the `workspace.yaml` sidecar and the
//! `session-store.db` usage rows into a cacheable session summary.

use crate::sources::imported_history::{
    self,
    metadata::{RoundUsage, SOURCE_COPILOT},
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
};

use super::meta_state::CopilotMetaState;
use super::types::{
    CopilotDiscoveredRecord, CopilotEventLine, CopilotHistoryMeta, ParsedCopilotMeta,
};
use super::workspace::read_copilot_workspace;
use super::{COPILOT_METADATA_PARSER_VERSION, MAX_PARSE_STATE_BYTES};

pub(super) fn parse_copilot_session_meta(
    discovered: &CopilotDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<ParsedCopilotMeta, String> {
    let record = &discovered.record;
    let enrichment = &discovered.enrichment;
    let events_path = &record.source_path;
    let workspace = read_copilot_workspace(events_path);
    let mut reader = WatermarkedTranscriptReader::open(
        events_path,
        "Copilot",
        watermark,
        COPILOT_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = CopilotMetaState::default();
    let mut resumed = false;
    if let Some(raw) = reader.resume_state_json() {
        if raw.len() <= MAX_PARSE_STATE_BYTES {
            if let Ok(candidate) = serde_json::from_str::<CopilotMetaState>(raw) {
                if candidate.validate().is_ok() {
                    state = candidate;
                    resumed = true;
                }
            }
        }
    }
    if !resumed && reader.resume_state_json().is_some() {
        reader = WatermarkedTranscriptReader::open(
            events_path,
            "Copilot",
            None,
            COPILOT_METADATA_PARSER_VERSION,
            record.source_mtime_ms,
            record.source_size_bytes,
        )?;
    }
    let mut tail_state = None;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        if line.terminated {
            state.feed(&event)?;
        } else {
            let mut candidate = state.clone();
            candidate.feed(&event)?;
            tail_state = Some(candidate);
        }
    }
    state.validate()?;
    let state_json = serde_json::to_string(&state)
        .map_err(|error| format!("Failed to serialize Copilot parse state: {error}"))?;
    if state_json.len() > MAX_PARSE_STATE_BYTES {
        return Err(format!(
            "Copilot parse state exceeds the {MAX_PARSE_STATE_BYTES}-byte safety limit"
        ));
    }
    let next_watermark = reader.into_watermark(
        COPILOT_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let scan = tail_state.unwrap_or(state);

    let created_at_ms = workspace
        .created_at
        .as_deref()
        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        .or(scan.start_time_ms)
        .or(scan.first_event_ms)
        // `source_mtime_ms` carries NANOSECONDS (see `file_metadata_signature`);
        // scale down for this ms-granularity fallback.
        .unwrap_or(record.source_mtime_ms / 1_000_000);
    let updated_at_ms = scan
        .last_event_ms
        .or_else(|| {
            workspace
                .updated_at
                .as_deref()
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
        .unwrap_or(created_at_ms)
        .max(created_at_ms);

    let name = workspace
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(scan.first_user_text.clone())
        .map(|value| imported_history::truncate_name(&value, 200))
        .unwrap_or_else(|| record.source_record_key.clone());

    let repo_path = workspace
        .cwd
        .clone()
        .or(scan.session_start_cwd.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let model = scan
        .last_assistant_model
        .clone()
        .or(scan.last_model_change.clone())
        .or_else(|| {
            enrichment
                .usage
                .iter()
                .rev()
                .find_map(|row| row.model.clone())
        });

    // Cache-row totals: db `input_tokens` is already cache-inclusive and
    // `output_tokens` already includes reasoning (module docs), so both sum
    // directly into the cache-input convention.
    let input_tokens = enrichment
        .usage
        .iter()
        .fold(0_i64, |total, row| total.saturating_add(row.input_tokens));
    let output_tokens = enrichment
        .usage
        .iter()
        .fold(0_i64, |total, row| total.saturating_add(row.output_tokens));
    let cache_read_tokens = enrichment.usage.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.cache_read_tokens)
    });
    let cache_write_tokens = enrichment.usage.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.cache_write_tokens)
    });

    let session_id = super::super::canonical_session_id(&record.source_session_id);
    // Per-round rows use FRESH input (cache excluded) per the
    // `imported_history_round_usage` convention, so the cache-inclusive db
    // column is unfolded again here.
    let rounds = enrichment
        .usage
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row.input_tokens > 0
                || row.output_tokens > 0
                || row.cache_read_tokens > 0
                || row.cache_write_tokens > 0
        })
        .map(|(seq, row)| RoundUsage {
            source: SOURCE_COPILOT,
            source_session_id: record.source_session_id.clone(),
            session_id: session_id.clone(),
            seq: seq as i64,
            model: row.model.clone().or_else(|| model.clone()),
            input_tokens: row
                .input_tokens
                .saturating_sub(row.cache_read_tokens)
                .saturating_sub(row.cache_write_tokens),
            output_tokens: row.output_tokens,
            cache_read_tokens: row.cache_read_tokens,
            cache_write_tokens: row.cache_write_tokens,
            created_at_ms: row.created_at_ms,
        })
        .collect();

    Ok(ParsedCopilotMeta {
        meta: CopilotHistoryMeta {
            source_session_id: record.source_session_id.clone(),
            session_id,
            source_path: events_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            source_fingerprint: record.source_fingerprint.clone(),
            name,
            created_at_ms,
            updated_at_ms,
            model,
            repo_path,
            branch: enrichment.branch.clone(),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            rounds,
            impact: scan.impact,
        },
        watermark: next_watermark,
    })
}
