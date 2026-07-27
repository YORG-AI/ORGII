//! Codex session-meta parsing and parent-thread resolution.

#[cfg(test)]
use std::collections::BTreeSet;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
#[cfg(test)]
use serde::Serialize;
use serde_json::Value;

use crate::sources::codex::canonical_session_id;
use crate::sources::imported_history::{
    self,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_CODEX_APP,
    },
};
#[cfg(test)]
use crate::sources::imported_history::{
    metadata::StoredRoundUsage,
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
};

#[cfg(test)]
use super::impact::{collect_codex_impact_from_patch_apply_end, collect_codex_impact_from_payload};
#[cfg(test)]
use super::index::codex_session_index_title_for_record;
use super::index::{
    codex_sessions_dir_for_session_path, codex_thread_id_from_file_stem,
    collect_codex_session_files,
};
use super::transcript::user_message_from_payload;
#[cfg(test)]
use super::CodexAppSessionMeta;
use super::{CodexAppSourceMetadata, CodexJsonlLine, CODEX_APP_METADATA_PARSER_VERSION};

/// Catalog discovery only needs stable card metadata.  Capping the prefix is
/// intentional: an appended 300 MiB rollout must not make a sidebar rescan
/// walk 300 MiB again. Exact turns, tokens, and impact come from the persistent
/// bounded replay index.
const CODEX_CATALOG_PREFIX_BYTES: u64 = 1024 * 1024;
const CODEX_UNTITLED_SESSION_NAME: &str = "Untitled";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTranscriptLocator {
    pub source_session_id: String,
    pub session_id: String,
    pub source_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct CodexTurnContextPayload {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
}

#[cfg(test)]
/// Resumable accumulator for one rollout's meta scan. Every field is exactly
/// the per-file state the old single-pass loop kept in locals, so it can be
/// frozen into a parse watermark's `state_json` at a complete-line boundary
/// and resumed against only the appended suffix.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CodexSessionMetaState {
    created_at_ms: i64,
    updated_at_ms: i64,
    /// Title carried inside the transcript's `session_meta` lines; the fresh
    /// session-index title (external, re-read each parse) still wins.
    transcript_title: String,
    first_prompt: String,
    model: Option<String>,
    repo_path: Option<String>,
    // Session totals are accumulated from per-round deltas (robust to codex's
    // cumulative resets on /compact). `input_tokens` is cache-inclusive here to
    // match the imported-cache convention.
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rounds: Vec<StoredRoundUsage>,
    // Previous cumulative `total_token_usage` for delta computation.
    prev_input: i64,
    prev_cached: i64,
    prev_cache_write: i64,
    prev_output: i64,
    // Primary impact source: `patch_apply_end` events, which Codex emits after
    // every *successful* apply with a structured `changes` map (path ->
    // unified_diff). This covers every edit path uniformly — the `apply_patch`
    // tool, `exec`-wrapped patches, etc. The tool-call scan is only a
    // fallback for older rollouts that predate `patch_apply_end`.
    impact: ImportedHistoryImpactStats,
    touched_files: BTreeSet<String>,
    fallback_impact: ImportedHistoryImpactStats,
    fallback_touched: BTreeSet<String>,
    parent_thread_id: Option<String>,
    source_metadata: CodexAppSourceMetadata,
}

#[cfg(test)]
impl CodexSessionMetaState {
    fn feed(&mut self, trimmed: &str, record: &ImportedHistoryDiscoveredRecord) {
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if self.created_at_ms == 0 || timestamp < self.created_at_ms {
                self.created_at_ms = timestamp;
            }
            if timestamp > self.updated_at_ms {
                self.updated_at_ms = timestamp;
            }
        }
        if self.first_prompt.is_empty() {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                self.first_prompt = message;
            }
        }
        if self.transcript_title.is_empty() && parsed.line_type == "session_meta" {
            if let Some(title) = session_title_from_payload(&parsed.payload) {
                self.transcript_title = imported_history::truncate_name(&title, 200);
            }
        }
        if self.parent_thread_id.is_none() && parsed.line_type == "session_meta" {
            self.parent_thread_id = parent_thread_id_from_session_meta_payload(
                &parsed.payload,
                codex_thread_id_from_file_stem(&record.source_record_key),
            );
        }
        if parsed.line_type == "session_meta" {
            capture_subagent_source_metadata(&parsed.payload, &mut self.source_metadata);
        }
        if self.model.is_none() || self.repo_path.is_none() {
            if let Ok(turn_context) =
                serde_json::from_value::<CodexTurnContextPayload>(parsed.payload.clone())
            {
                if self.model.is_none() && !turn_context.model.trim().is_empty() {
                    self.model = Some(turn_context.model);
                }
                if self.repo_path.is_none() && !turn_context.cwd.trim().is_empty() {
                    self.repo_path = Some(turn_context.cwd);
                }
            }
        }
        if parsed.payload.get("type").and_then(Value::as_str) == Some("token_count") {
            // Real rollouts nest usage under `info.total_token_usage` (cumulative).
            if let Some(total_usage) = parsed
                .payload
                .get("info")
                .and_then(|info| info.get("total_token_usage"))
                .or_else(|| parsed.payload.get("total_token_usage"))
            {
                let field = |key: &str| total_usage.get(key).and_then(Value::as_i64).unwrap_or(0);
                let cum_input = field("input_tokens"); // cache-inclusive
                let cum_cached = field("cached_input_tokens");
                let cum_cache_write = field("cache_write_input_tokens");
                let cum_output = field("output_tokens") + field("reasoning_output_tokens");
                // Per-field delta, treating a decrease (codex resets on /compact)
                // as a fresh start so totals never go negative or undercount.
                let delta = |cum: i64, prev: i64| if cum >= prev { cum - prev } else { cum };
                let d_input = delta(cum_input, self.prev_input);
                let d_cached = delta(cum_cached, self.prev_cached);
                let d_cache_write = delta(cum_cache_write, self.prev_cache_write);
                let d_output = delta(cum_output, self.prev_output);
                let d_fresh = (d_input - d_cached - d_cache_write).max(0);
                if d_input > 0 || d_output > 0 {
                    let event_ms = parsed
                        .timestamp
                        .as_deref()
                        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
                        .unwrap_or(self.updated_at_ms);
                    self.rounds.push(StoredRoundUsage {
                        seq: self.rounds.len() as i64,
                        model: self.model.clone(),
                        input_tokens: d_fresh,
                        output_tokens: d_output,
                        cache_read_tokens: d_cached,
                        cache_write_tokens: d_cache_write,
                        created_at_ms: event_ms,
                    });
                    self.input_tokens += d_input;
                    self.output_tokens += d_output;
                    self.cache_read_tokens += d_cached;
                    self.cache_write_tokens += d_cache_write;
                }
                self.prev_input = cum_input;
                self.prev_cached = cum_cached;
                self.prev_cache_write = cum_cache_write;
                self.prev_output = cum_output;
            }
        }
        collect_codex_impact_from_patch_apply_end(
            &parsed.payload,
            &mut self.impact,
            &mut self.touched_files,
        );
        collect_codex_impact_from_payload(
            &parsed.payload,
            &mut self.fallback_impact,
            &mut self.fallback_touched,
        );
    }

    fn finish(
        mut self,
        record: &ImportedHistoryDiscoveredRecord,
        external_title: String,
    ) -> Option<CodexAppSessionMeta> {
        // Prefer the authoritative `patch_apply_end` tally; only fall back to
        // the tool-call scan when no successful applies were recorded.
        if self.touched_files.is_empty()
            && self.impact.lines_added == 0
            && self.impact.lines_removed == 0
        {
            self.impact = self.fallback_impact;
            self.touched_files = self.fallback_touched;
        }
        self.impact.touched_files = self.touched_files.into_iter().collect();
        self.impact.files_changed = self.impact.touched_files.len() as i64;

        if self.created_at_ms == 0 && record.source_mtime_ms == 0 {
            return None;
        }

        let title = if external_title.is_empty() {
            self.transcript_title
        } else {
            external_title
        };
        let name = if !title.is_empty() {
            title
        } else if self.first_prompt.is_empty() {
            CODEX_UNTITLED_SESSION_NAME.to_string()
        } else {
            imported_history::truncate_name(&self.first_prompt, 200)
        };
        let session_id = canonical_session_id(&record.source_session_id);
        let rounds = self
            .rounds
            .into_iter()
            .map(|round| {
                round.into_round_usage(SOURCE_CODEX_APP, &record.source_session_id, &session_id)
            })
            .collect();
        let mut source_metadata = self.source_metadata;
        source_metadata.first_prompt =
            (!self.first_prompt.trim().is_empty()).then_some(self.first_prompt);
        Some(CodexAppSessionMeta {
            source_session_id: record.source_session_id.clone(),
            session_id,
            source_path: record.source_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            source_fingerprint: record.source_fingerprint.clone(),
            name,
            parent_session_id: self
                .parent_thread_id
                .as_deref()
                .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id)),
            created_at_ms: if self.created_at_ms > 0 {
                self.created_at_ms
            } else {
                record.source_mtime_ms
            },
            updated_at_ms: if self.updated_at_ms > 0 {
                self.updated_at_ms
            } else {
                record.source_mtime_ms
            },
            model: self.model,
            repo_path: self.repo_path,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            impact: self.impact,
            rounds,
            source_metadata,
        })
    }
}

#[cfg(test)]
pub(crate) struct CodexSessionMetaParse {
    pub meta: Option<CodexAppSessionMeta>,
    pub watermark: ImportedParseWatermark,
    #[cfg_attr(not(test), allow(dead_code))]
    pub resumed: bool,
}

#[cfg(test)]
pub(crate) fn parse_codex_session_meta_incremental(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<CodexSessionMetaParse, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        "Codex",
        watermark,
        CODEX_APP_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = CodexSessionMetaState::default();
    let mut resumed = false;
    if let Some(state_json) = reader.resume_state_json() {
        match serde_json::from_str::<CodexSessionMetaState>(state_json) {
            Ok(parsed) => {
                state = parsed;
                resumed = true;
            }
            Err(_) => {
                reader = WatermarkedTranscriptReader::open(
                    &record.source_path,
                    "Codex",
                    None,
                    CODEX_APP_METADATA_PARSER_VERSION,
                    record.source_mtime_ms,
                    record.source_size_bytes,
                )?;
            }
        }
    }
    let mut tail_state: Option<CodexSessionMetaState> = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed, record);
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed, record);
            tail_state = Some(snapshot);
        }
    }
    let external_title = codex_session_index_title_for_record(record)?;
    let state_json = serde_json::to_string(&state)
        .map_err(|err| format!("Failed to serialize Codex parse state: {err}"))?;
    let next_watermark = reader.into_watermark(
        CODEX_APP_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let meta = tail_state.unwrap_or(state).finish(record, external_title);
    Ok(CodexSessionMetaParse {
        meta,
        watermark: next_watermark,
        resumed,
    })
}

#[cfg(test)]
pub(crate) fn parse_codex_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<CodexAppSessionMeta>, String> {
    Ok(parse_codex_session_meta_incremental(record, None)?.meta)
}

#[cfg(test)]
pub(super) fn parse_codex_catalog_input(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ImportedHistoryCacheInput>, String> {
    let external_title = codex_session_index_title_for_record(record)?;
    parse_codex_catalog_input_with_title(record, Some(&external_title))
}

pub(super) fn parse_codex_catalog_input_with_title(
    record: &ImportedHistoryDiscoveredRecord,
    authoritative_title: Option<&str>,
) -> Result<Option<ImportedHistoryCacheInput>, String> {
    let mut created_at_ms = 0;
    let mut external_title = authoritative_title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(ToString::to_string)
        .unwrap_or_default();
    let mut first_prompt = String::new();
    let mut model = None;
    let mut repo_path = None;
    let mut parent_thread_id = None;
    let mut source_metadata = CodexAppSourceMetadata::default();

    for line in imported_history::read_complete_jsonl_prefix_lines(
        &record.source_path,
        "Codex",
        CODEX_CATALOG_PREFIX_BYTES,
    )? {
        let Ok(parsed) = serde_json::from_str::<CodexJsonlLine>(line.trim()) else {
            continue;
        };
        if created_at_ms == 0 {
            created_at_ms = parsed
                .timestamp
                .as_deref()
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
                .unwrap_or_default();
        }
        if first_prompt.is_empty() {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                first_prompt = message;
            }
        }
        if external_title.is_empty() && parsed.line_type == "session_meta" {
            if let Some(title) = session_title_from_payload(&parsed.payload) {
                external_title = imported_history::truncate_name(&title, 200);
            }
        }
        if parent_thread_id.is_none() && parsed.line_type == "session_meta" {
            parent_thread_id = parent_thread_id_from_session_meta_payload(
                &parsed.payload,
                codex_thread_id_from_file_stem(&record.source_record_key),
            );
        }
        if parsed.line_type == "session_meta" {
            capture_subagent_source_metadata(&parsed.payload, &mut source_metadata);
        }
        if model.is_none() || repo_path.is_none() {
            if let Ok(turn_context) =
                serde_json::from_value::<CodexTurnContextPayload>(parsed.payload)
            {
                if model.is_none() && !turn_context.model.trim().is_empty() {
                    model = Some(turn_context.model);
                }
                if repo_path.is_none() && !turn_context.cwd.trim().is_empty() {
                    repo_path = Some(turn_context.cwd);
                }
            }
        }
        if !first_prompt.is_empty()
            && model.is_some()
            && repo_path.is_some()
            && parent_thread_id.is_some()
        {
            break;
        }
    }

    let source_time_ms = record.source_mtime_ms.saturating_div(1_000_000);
    if created_at_ms == 0 && source_time_ms == 0 {
        return Ok(None);
    }
    let name = if !external_title.is_empty() {
        external_title
    } else if !first_prompt.is_empty() {
        imported_history::truncate_name(&first_prompt, 200)
    } else {
        CODEX_UNTITLED_SESSION_NAME.to_string()
    };
    source_metadata.first_prompt = (!first_prompt.trim().is_empty()).then_some(first_prompt);
    let parent_session_id = parent_thread_id
        .as_deref()
        .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id));
    let source_metadata_json = parent_session_id
        .as_ref()
        .and_then(|_| serde_json::to_string(&source_metadata).ok());
    Ok(Some(ImportedHistoryCacheInput {
        source: SOURCE_CODEX_APP,
        source_session_id: record.source_session_id.clone(),
        session_id: canonical_session_id(&record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        name,
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            source_time_ms
        },
        updated_at_ms: source_time_ms.max(created_at_ms),
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path,
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json,
        parent_session_id,
    }))
}

fn capture_subagent_source_metadata(payload: &Value, metadata: &mut CodexAppSourceMetadata) {
    let thread_spawn = payload.pointer("/source/subagent/thread_spawn");
    if metadata.agent_path.is_none() {
        metadata.agent_path = thread_spawn
            .and_then(|value| value.get("agent_path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    if metadata.agent_nickname.is_none() {
        metadata.agent_nickname = thread_spawn
            .and_then(|value| value.get("agent_nickname"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
}

fn parent_thread_id_from_session_meta_payload(
    payload: &Value,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let is_subagent = payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || payload.pointer("/source/subagent").is_some();
    if !is_subagent {
        return None;
    }

    let direct_candidates = [
        payload.get("parent_thread_id"),
        payload.pointer("/source/subagent/thread_spawn/parent_thread_id"),
        payload.get("forked_from_id"),
        payload.get("session_id"),
    ];

    for candidate in direct_candidates {
        if let Some(parent_thread_id) = candidate
            .and_then(Value::as_str)
            .and_then(|value| normalize_parent_thread_id_candidate(value, current_thread_id))
        {
            return Some(parent_thread_id);
        }
    }
    None
}

fn normalize_parent_thread_id_candidate(
    value: &str,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || Some(trimmed) == current_thread_id {
        return None;
    }
    Some(trimmed.to_string())
}

fn codex_parent_session_id_for_record(
    record: &ImportedHistoryDiscoveredRecord,
    parent_thread_id: &str,
) -> Option<String> {
    resolve_codex_transcript_for_thread_id_near_path(&record.source_path, parent_thread_id)
        .ok()
        .flatten()
        .map(|locator| locator.session_id)
}

/// Resolve a Codex thread UUID to the concrete rollout file that ORGII can
/// replay. Lifecycle hooks identify the parent with a stable thread UUID, but
/// their common `transcript_path` may point at the active child rollout.
pub fn resolve_codex_transcript_for_thread_id_near_path(
    reference_path: &Path,
    thread_id: &str,
) -> Result<Option<CodexTranscriptLocator>, String> {
    let Some(sessions_dir) = codex_sessions_dir_for_session_path(reference_path) else {
        return Ok(None);
    };
    let find_locator = |mut files: Vec<PathBuf>| {
        files.sort();
        files.into_iter().find_map(|path| {
            let file_stem = path
                .file_stem()
                .and_then(|value| value.to_str())?
                .to_string();
            (codex_thread_id_from_file_stem(&file_stem) == Some(thread_id)).then(|| {
                CodexTranscriptLocator {
                    session_id: canonical_session_id(&file_stem),
                    source_session_id: file_stem,
                    source_path: path,
                }
            })
        })
    };

    // Parent and child rollouts from one subagent run normally share the same
    // dated directory. Search that tiny locality before falling back to the
    // full CODEX_HOME session tree, which can contain years of history.
    if let Some(nearby_dir) = reference_path.parent() {
        let mut nearby_files = Vec::new();
        collect_codex_session_files(nearby_dir, &mut nearby_files)?;
        if let Some(locator) = find_locator(nearby_files) {
            return Ok(Some(locator));
        }
    }

    let mut files = Vec::new();
    collect_codex_session_files(&sessions_dir, &mut files)?;
    Ok(find_locator(files))
}

fn session_title_from_payload(payload: &Value) -> Option<String> {
    [
        "title",
        "name",
        "threadName",
        "thread_name",
        "conversationTitle",
        "conversation_title",
    ]
    .iter()
    .filter_map(|key| payload.get(*key).and_then(Value::as_str))
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

#[cfg(test)]
mod catalog_tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn catalog_prefix_is_bounded_for_a_thirty_mib_rollout() {
        let path = std::env::temp_dir().join(format!(
            "orgii-codex-catalog-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut file = fs::File::create(&path).expect("create Codex catalog fixture");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp":"2026-07-22T00:00:00Z",
                "type":"session_meta",
                "payload":{"title":"bounded catalog","cwd":"/work/orgii","model":"gpt-5"}
            })
        )
        .expect("write metadata line");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp":"2026-07-22T00:00:01Z",
                "type":"event_msg",
                "payload":{"type":"user_message","message":"first prompt"}
            })
        )
        .expect("write prompt line");
        let block = vec![b'x'; 64 * 1024];
        for _ in 0..(30 * 1024 / 64) {
            file.write_all(&block).expect("extend large rollout");
        }
        file.flush().expect("flush fixture");
        let size = file.metadata().expect("fixture metadata").len();
        drop(file);
        assert!(size > 30 * 1024 * 1024 - 1024);

        let record = ImportedHistoryDiscoveredRecord {
            source_session_id: "catalog-large".to_string(),
            source_path: path.clone(),
            source_record_key: "catalog-large".to_string(),
            source_mtime_ms: 1_774_137_600_000_000_000,
            source_size_bytes: size as i64,
            source_fingerprint: String::new(),
            parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        };
        let input = parse_codex_catalog_input(&record)
            .expect("parse bounded catalog")
            .expect("catalog row");
        assert_eq!(input.name, "bounded catalog");
        assert_eq!(input.repo_path.as_deref(), Some("/work/orgii"));
        assert_eq!(input.model.as_deref(), Some("gpt-5"));
        assert_eq!(input.input_tokens, 0);
        assert!(CODEX_CATALOG_PREFIX_BYTES < size);

        fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn catalog_reads_complete_final_record_without_a_trailing_newline() {
        let path = std::env::temp_dir().join(format!(
            "orgii-codex-catalog-no-newline-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let record_json = serde_json::json!({
            "timestamp":"2026-07-22T00:00:00Z",
            "type":"session_meta",
            "payload":{"title":"natural EOF Codex catalog","cwd":"/work/orgii"}
        })
        .to_string();
        fs::write(&path, &record_json).expect("write no-newline Codex fixture");
        let record = ImportedHistoryDiscoveredRecord {
            source_session_id: "catalog-no-newline".to_string(),
            source_path: path.clone(),
            source_record_key: "catalog-no-newline".to_string(),
            source_mtime_ms: 1_774_137_600_000_000_000,
            source_size_bytes: record_json.len() as i64,
            source_fingerprint: String::new(),
            parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        };

        let input = parse_codex_catalog_input(&record)
            .expect("parse no-newline Codex catalog")
            .expect("Codex catalog row");

        assert_eq!(input.name, "natural EOF Codex catalog");
        fs::remove_file(path).expect("remove no-newline Codex fixture");
    }

    #[test]
    fn catalog_uses_untitled_when_only_tool_and_system_records_exist() {
        let path = std::env::temp_dir().join(format!(
            "orgii-codex-catalog-tool-only-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let body = [
            serde_json::json!({
                "timestamp":"2026-07-22T00:00:00Z",
                "type":"session_meta",
                "payload":{"cwd":"/work/orgii"}
            }),
            serde_json::json!({
                "timestamp":"2026-07-22T00:00:01Z",
                "type":"response_item",
                "payload":{"type":"custom_tool_call","name":"update_plan"}
            }),
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, format!("{body}\n")).expect("write tool-only Codex fixture");
        let record = ImportedHistoryDiscoveredRecord {
            source_session_id: "catalog-tool-only".to_string(),
            source_path: path.clone(),
            source_record_key: "catalog-tool-only".to_string(),
            source_mtime_ms: 1_774_137_600_000_000_000,
            source_size_bytes: body.len() as i64 + 1,
            source_fingerprint: String::new(),
            parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        };

        let input = parse_codex_catalog_input_with_title(&record, None)
            .expect("parse tool-only Codex catalog")
            .expect("Codex catalog row");

        assert_eq!(input.name, "Untitled");
        fs::remove_file(path).expect("remove tool-only Codex fixture");
    }
}
