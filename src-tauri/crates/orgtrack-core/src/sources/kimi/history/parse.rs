//! Resumable metadata parsing over the shared fixed-size append seam.

use crate::sources::imported_history::{
    metadata::{ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, RoundUsage},
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
};

use super::identity::{KimiLayout, KIMI_METADATA_PARSER_VERSION, MAX_STATE_JSON_BYTES};
use super::meta_state::{initial_state, KimiMetaState};

#[derive(Debug)]
pub(super) struct ParsedKimiMeta {
    pub(super) input: ImportedHistoryCacheInput,
    pub(super) rounds: Vec<RoundUsage>,
    pub(super) watermark: ImportedParseWatermark,
}

pub(super) fn parse_kimi_meta(
    record: &ImportedHistoryDiscoveredRecord,
    layout: KimiLayout,
    default_model: &str,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<ParsedKimiMeta, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        "Kimi",
        watermark,
        KIMI_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = initial_state(layout, default_model, &record.source_fingerprint);
    let mut resumed = false;
    if let Some(raw) = reader.resume_state_json() {
        if raw.len() <= MAX_STATE_JSON_BYTES {
            if let Ok(candidate) = serde_json::from_str::<KimiMetaState>(raw) {
                if candidate.layout == layout.state_label()
                    && candidate.config_fingerprint == record.source_fingerprint
                    && candidate.validate().is_ok()
                {
                    state = candidate;
                    resumed = true;
                }
            }
        }
    }
    if !resumed && reader.resume_state_json().is_some() {
        reader = WatermarkedTranscriptReader::open(
            &record.source_path,
            "Kimi",
            None,
            KIMI_METADATA_PARSER_VERSION,
            record.source_mtime_ms,
            record.source_size_bytes,
        )?;
    }

    let mut dedup_indices = state.dedup_indices()?;
    let mut tail_state = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(
                trimmed,
                layout,
                record.source_mtime_ms / 1_000_000,
                &mut dedup_indices,
            )?;
        } else {
            let mut candidate = state.clone();
            let mut candidate_indices = candidate.dedup_indices()?;
            candidate.feed(
                trimmed,
                layout,
                record.source_mtime_ms / 1_000_000,
                &mut candidate_indices,
            )?;
            tail_state = Some(candidate);
        }
    }
    state.validate()?;
    let state_json = serde_json::to_string(&state)
        .map_err(|err| format!("Failed to serialize Kimi parse state: {err}"))?;
    if state_json.len() > MAX_STATE_JSON_BYTES {
        return Err(format!(
            "Kimi parse state exceeds the {MAX_STATE_JSON_BYTES}-byte safety limit"
        ));
    }
    let next_watermark = reader.into_watermark(
        KIMI_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let visible_state = tail_state.unwrap_or(state);
    let (input, rounds) = visible_state.finish(record)?;
    Ok(ParsedKimiMeta {
        input,
        rounds,
        watermark: next_watermark,
    })
}
