//! Codex session-meta parsing and parent-thread resolution.

#[cfg(test)]
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::sources::codex::canonical_session_id;
#[cfg(test)]
use crate::sources::imported_history::metadata::RoundUsage;
use crate::sources::imported_history::{
    self,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_CODEX_APP,
    },
};

#[cfg(test)]
use super::impact::{collect_codex_impact_from_patch_apply_end, collect_codex_impact_from_payload};
use super::index::{
    codex_session_index_title_for_record, codex_sessions_dir_for_session_path,
    codex_thread_id_from_file_stem, collect_codex_session_files,
};
use super::transcript::user_message_from_payload;
#[cfg(test)]
use super::CodexAppSessionMeta;
use super::{CodexJsonlLine, CODEX_APP_METADATA_PARSER_VERSION};

/// Catalog discovery only needs stable card metadata.  Capping the prefix is
/// intentional: an appended 300 MiB rollout must not make a sidebar rescan
/// walk 300 MiB again. Exact turns, tokens, and impact come from the persistent
/// bounded replay index.
const CODEX_CATALOG_PREFIX_BYTES: u64 = 1024 * 1024;

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
pub(crate) fn parse_codex_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<CodexAppSessionMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Codex history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut external_title = codex_session_index_title_for_record(record)?;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    // Session totals are accumulated from per-round deltas (robust to codex's
    // cumulative resets on /compact). `input_tokens` is cache-inclusive here to
    // match the imported-cache convention.
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut cache_read_tokens = 0;
    let mut cache_write_tokens = 0;
    let mut rounds: Vec<RoundUsage> = Vec::new();
    // Previous cumulative `total_token_usage` for delta computation.
    let mut prev_input = 0i64;
    let mut prev_cached = 0i64;
    let mut prev_cache_write = 0i64;
    let mut prev_output = 0i64;
    // Primary impact source: `patch_apply_end` events, which Codex emits after
    // every *successful* apply with a structured `changes` map (path ->
    // unified_diff). This covers every edit path uniformly — the `apply_patch`
    // tool, `exec`-wrapped patches, etc. The tool-call scan below is only a
    // fallback for older rollouts that predate `patch_apply_end`.
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();
    let mut fallback_impact = ImportedHistoryImpactStats::default();
    let mut fallback_touched = BTreeSet::new();
    let mut parent_thread_id: Option<String> = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if first_prompt.is_empty() {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                first_prompt = imported_history::truncate_name(&message, 200);
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
        if model.is_none() || repo_path.is_none() {
            if let Ok(turn_context) =
                serde_json::from_value::<CodexTurnContextPayload>(parsed.payload.clone())
            {
                if model.is_none() && !turn_context.model.trim().is_empty() {
                    model = Some(turn_context.model);
                }
                if repo_path.is_none() && !turn_context.cwd.trim().is_empty() {
                    repo_path = Some(turn_context.cwd);
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
                let d_input = delta(cum_input, prev_input);
                let d_cached = delta(cum_cached, prev_cached);
                let d_cache_write = delta(cum_cache_write, prev_cache_write);
                let d_output = delta(cum_output, prev_output);
                let d_fresh = (d_input - d_cached - d_cache_write).max(0);
                if d_input > 0 || d_output > 0 {
                    let event_ms = parsed
                        .timestamp
                        .as_deref()
                        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
                        .unwrap_or(updated_at_ms);
                    rounds.push(RoundUsage {
                        source: SOURCE_CODEX_APP,
                        source_session_id: record.source_session_id.clone(),
                        session_id: canonical_session_id(&record.source_session_id),
                        seq: rounds.len() as i64,
                        model: model.clone(),
                        input_tokens: d_fresh,
                        output_tokens: d_output,
                        cache_read_tokens: d_cached,
                        cache_write_tokens: d_cache_write,
                        created_at_ms: event_ms,
                    });
                    input_tokens += d_input;
                    output_tokens += d_output;
                    cache_read_tokens += d_cached;
                    cache_write_tokens += d_cache_write;
                }
                prev_input = cum_input;
                prev_cached = cum_cached;
                prev_cache_write = cum_cache_write;
                prev_output = cum_output;
            }
        }
        collect_codex_impact_from_patch_apply_end(&parsed.payload, &mut impact, &mut touched_files);
        collect_codex_impact_from_payload(
            &parsed.payload,
            &mut fallback_impact,
            &mut fallback_touched,
        );
    }

    // Prefer the authoritative `patch_apply_end` tally; only fall back to the
    // tool-call scan when no successful applies were recorded (older rollouts).
    if touched_files.is_empty() && impact.lines_added == 0 && impact.lines_removed == 0 {
        impact = fallback_impact;
        touched_files = fallback_touched;
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    let name = if !external_title.is_empty() {
        external_title
    } else if first_prompt.is_empty() {
        record.source_record_key.clone()
    } else {
        first_prompt
    };
    Ok(Some(CodexAppSessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: canonical_session_id(&record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        parent_session_id: parent_thread_id
            .as_deref()
            .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id)),
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            record.source_mtime_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            record.source_mtime_ms
        },
        model,
        repo_path,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        impact,
        rounds,
    }))
}

pub(super) fn parse_codex_catalog_input(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ImportedHistoryCacheInput>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Codex catalog prefix {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file.take(CODEX_CATALOG_PREFIX_BYTES));
    let mut created_at_ms = 0;
    let mut external_title = codex_session_index_title_for_record(record)?;
    let mut first_prompt = String::new();
    let mut model = None;
    let mut repo_path = None;
    let mut parent_thread_id = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex catalog prefix: {err}"))?;
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
                first_prompt = imported_history::truncate_name(&message, 200);
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
        first_prompt
    } else {
        record.source_record_key.clone()
    };
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
        source_metadata_json: None,
        parent_session_id: parent_thread_id
            .as_deref()
            .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id)),
    }))
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
}
