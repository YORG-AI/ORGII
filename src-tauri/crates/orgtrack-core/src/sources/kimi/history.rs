//! Bounded Kimi CLI / Kimi Code history and usage importer.
//!
//! The two products share a public source id but not an on-disk protocol:
//!
//! - `~/.kimi/sessions/<group>/<session>/wire.jsonl` stores legacy
//!   `StatusUpdate.payload.token_usage` records.
//! - `<Kimi Code home>/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`
//!   stores incremental `usage.record` records.
//!
//! Discovery is demand-driven. It follows neither symlinks nor ambient paths
//! outside the current external-history identity, and metadata parsing resumes
//! from the shared fixed-size append seam.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        RoundUsage, SOURCE_KIMI,
    },
    paths as imported_paths, scan_snapshot,
    watermark::{ImportedParseWatermark, PrefixHasher, WatermarkedTranscriptReader},
    ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

pub const KIMI_SESSION_PREFIX: &str = "kimihistoryapp-";
pub type KimiRecentPath = ImportedHistoryRecentPath;

const KIMI_METADATA_PARSER_VERSION: i64 = 5;
const DEFAULT_MODEL: &str = "kimi-for-coding";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_WIRE_FILE_BYTES: i64 = 64 * 1024 * 1024;
const MAX_CHANGED_SESSIONS_PER_SYNC: usize = 256;
const MAX_PARSE_SOURCE_BYTES_PER_SYNC: i64 = 64 * 1024 * 1024;
const MAX_STATE_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_USAGE_ROUNDS: usize = 20_000;
const MAX_ID_BYTES: usize = 1_024;
const MAX_MODEL_BYTES: usize = 1_024;
const MAX_REPLAY_CHUNKS: usize = 20_000;
const MAX_REPLAY_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLAY_MESSAGE_CHARS: usize = 50_000;
const MAX_CODE_OPEN_STEPS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KimiLayout {
    Legacy,
    Code,
}

impl KimiLayout {
    fn state_label(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Code => "code",
        }
    }
}

#[derive(Debug, Clone)]
struct LegacyConfig {
    model: String,
    fingerprint: String,
}

#[derive(Debug)]
struct KimiDiscovery {
    records: Vec<ImportedHistoryDiscoveredRecord>,
    legacy_config: LegacyConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct KimiRoundState {
    dedup_key: Option<String>,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    created_at_ms: i64,
    timestamp_is_wire: bool,
}

impl KimiRoundState {
    fn exact_total(&self) -> i128 {
        i128::from(self.input_tokens)
            + i128::from(self.output_tokens)
            + i128::from(self.cache_read_tokens)
            + i128::from(self.cache_write_tokens)
    }

    fn is_empty(&self) -> bool {
        self.exact_total() == 0
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct KimiMetaState {
    layout: String,
    config_fingerprint: String,
    default_model: String,
    latest_request_model: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    first_user_text: Option<String>,
    repo_path: Option<String>,
    has_replayable_content: bool,
    rounds: Vec<KimiRoundState>,
}

#[derive(Debug)]
struct ParsedKimiMeta {
    input: ImportedHistoryCacheInput,
    rounds: Vec<RoundUsage>,
    watermark: ImportedParseWatermark,
}

pub fn list_kimi_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    sync_kimi_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_KIMI, limit, offset)
}

pub fn list_kimi_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ImportedHistoryRecentPath>, String> {
    sync_kimi_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_KIMI, limit)
}

pub fn load_kimi_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let home = app_paths::external_history_home_dir();
    load_kimi_history_for_session_in(
        conn,
        session_id,
        &home,
        std::env::var_os("KIMI_CODE_HOME").as_deref(),
    )
}

fn load_kimi_history_for_session_in(
    conn: &Connection,
    session_id: &str,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<Vec<ActivityChunk>, String> {
    if !session_id.starts_with(KIMI_SESSION_PREFIX) {
        return Err(format!("Invalid Kimi session id: {session_id}"));
    }
    let (_, cached) =
        imported_cache::query_cached_session_by_session_id_from_conn(conn, session_id)?
            .filter(|(source, _)| source == SOURCE_KIMI)
            .ok_or_else(|| format!("Kimi session not found: {session_id}"))?;
    let layout = layout_from_source_id(&cached.source_session_id)?;
    let root = match layout {
        KimiLayout::Legacy => home.join(".kimi").join("sessions"),
        KimiLayout::Code => kimi_code_home_for(home, kimi_code_home).join("sessions"),
    };
    read_replay(
        Path::new(&cached.source_path),
        &root,
        home,
        session_id,
        layout,
    )
}

/// Candidate roots used by both importer and source detection.
///
/// An ambient `KIMI_CODE_HOME` is honored only when it resolves within the
/// current external-history identity. Secondary instances therefore cannot
/// inherit the primary user's custom Kimi path accidentally.
pub fn kimi_history_candidate_paths() -> Vec<PathBuf> {
    let home = app_paths::external_history_home_dir();
    vec![
        home.join(".kimi").join("sessions"),
        kimi_code_home_for(&home, std::env::var_os("KIMI_CODE_HOME").as_deref()).join("sessions"),
    ]
}

fn kimi_code_home_for(home: &Path, configured: Option<&std::ffi::OsStr>) -> PathBuf {
    let fallback = home.join(".kimi-code");
    let Some(configured) = configured.filter(|value| !value.is_empty()) else {
        return fallback;
    };
    let configured_path = Path::new(configured);
    let candidate = if configured_path.is_absolute() {
        configured_path.to_path_buf()
    } else if configured_path
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
    {
        home.join(configured_path)
    } else {
        return fallback;
    };
    if candidate
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return fallback;
    }
    let canonical_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let canonical_candidate =
        fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.to_path_buf());
    if canonical_candidate.starts_with(&canonical_home) {
        candidate
    } else {
        fallback
    }
}

fn sync_kimi_history_cache(conn: &mut Connection) -> Result<(), String> {
    let home = app_paths::external_history_home_dir();
    sync_kimi_history_cache_in(conn, &home, std::env::var_os("KIMI_CODE_HOME").as_deref())
}

fn sync_kimi_history_cache_in(
    conn: &mut Connection,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<(), String> {
    let discovery = discover_kimi_records_in(conn, home, kimi_code_home)?;
    let signatures = discovery
        .records
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let mut changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_KIMI,
        &discovery.records,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    changed.sort_by(|left, right| {
        right
            .source_mtime_ms
            .cmp(&left.source_mtime_ms)
            .then_with(|| left.source_session_id.cmp(&right.source_session_id))
    });

    let mut processed = 0usize;
    let mut admitted_source_bytes = 0_i64;
    for record in changed {
        if processed >= MAX_CHANGED_SESSIONS_PER_SYNC {
            break;
        }
        let next_source_bytes =
            admitted_source_bytes.saturating_add(record.source_size_bytes.max(0));
        if processed > 0 && next_source_bytes > MAX_PARSE_SOURCE_BYTES_PER_SYNC {
            break;
        }
        let layout = layout_from_source_id(&record.source_session_id)?;
        let default_model = match layout {
            KimiLayout::Legacy => discovery.legacy_config.model.as_str(),
            KimiLayout::Code => DEFAULT_MODEL,
        };
        let stored = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_KIMI,
            &record.source_session_id,
        )?;
        let Some(parsed) = imported_history::skip_unparsable_record(
            SOURCE_KIMI,
            &record.source_session_id,
            parse_kimi_meta(record, layout, default_model, stored.as_ref()),
        ) else {
            continue;
        };
        let session_id = parsed.input.session_id.clone();
        // The session cache signature is the authoritative changed-record
        // marker, so commit it last. If a prior write fails, or the final
        // upsert fails, the old signature keeps this record eligible and the
        // next demand scan deterministically replaces the same rounds and
        // watermark state.
        imported_cache::write_session_rounds_from_conn(
            conn,
            std::slice::from_ref(&session_id),
            &parsed.rounds,
        )?;
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_KIMI,
            &record.source_session_id,
            &parsed.watermark,
        )?;
        upsert_kimi_cache_retry_safe(conn, &parsed.input)?;
        processed = processed.saturating_add(1);
        admitted_source_bytes = next_source_bytes;
    }

    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_KIMI,
        imported_cache::live_ids_from_signatures(&signatures),
        Vec::new(),
    )
}

fn upsert_kimi_cache_retry_safe(
    conn: &mut Connection,
    input: &ImportedHistoryCacheInput,
) -> Result<(), String> {
    let result =
        imported_cache::upsert_imported_session_cache_from_conn(conn, std::slice::from_ref(input));
    let Err(error) = result else {
        return Ok(());
    };

    // The shared cache helper commits its signature row before projecting the
    // core session. If that later projection fails, invalidate only the newly
    // committed signature so the next demand sync retries instead of treating
    // a partial projection as complete. The cache row remains visible but is
    // deliberately ineligible for signature reuse until recovery succeeds.
    conn.execute(
        "UPDATE imported_history_session_cache
         SET parser_version = -1
         WHERE source = ?1
           AND source_session_id = ?2
           AND source_path = ?3
           AND source_mtime_ms = ?4
           AND source_size_bytes = ?5
           AND source_fingerprint = ?6
           AND parser_version = ?7",
        params![
            input.source,
            input.source_session_id,
            input.source_path,
            input.source_mtime_ms,
            input.source_size_bytes,
            input.source_fingerprint,
            input.parser_version,
        ],
    )
    .map_err(|recovery_error| {
        format!("{error}; failed to keep the Kimi record retry-eligible: {recovery_error}")
    })?;
    Err(error)
}

fn discover_kimi_records_in(
    conn: &Connection,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<KimiDiscovery, String> {
    let legacy_root = home.join(".kimi").join("sessions");
    let code_root = kimi_code_home_for(home, kimi_code_home).join("sessions");
    let legacy_config = read_legacy_config(home);
    let previous = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_KIMI);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Kimi");
    let mut records = Vec::new();
    let mut seen_physical_paths = HashSet::new();

    collect_layout_records(
        &mut walker,
        &legacy_root,
        home,
        2,
        KimiLayout::Legacy,
        &legacy_config.fingerprint,
        &mut seen_physical_paths,
        &mut records,
    )?;
    collect_layout_records(
        &mut walker,
        &code_root,
        home,
        4,
        KimiLayout::Code,
        "kimi-code-wire-v2",
        &mut seen_physical_paths,
        &mut records,
    )?;

    let next = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(conn, SOURCE_KIMI, &previous, &next)?;
    records.sort_by(|left, right| left.source_session_id.cmp(&right.source_session_id));
    Ok(KimiDiscovery {
        records,
        legacy_config,
    })
}

#[allow(clippy::too_many_arguments)]
// Scanner roots and output accumulators have distinct lifetimes and ownership;
// spelling them out keeps filesystem boundaries visible during traversal.
fn collect_layout_records(
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
    root: &Path,
    identity_home: &Path,
    max_depth: usize,
    layout: KimiLayout,
    fingerprint: &str,
    seen_physical_paths: &mut HashSet<PathBuf>,
    records: &mut Vec<ImportedHistoryDiscoveredRecord>,
) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Ok(_) => ensure_safe_history_root(root, identity_home)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect Kimi history root {}: {error}",
                root.display()
            ))
        }
    }
    let mut files = Vec::new();
    walker.collect_files_bounded(root, &mut files, max_depth)?;
    for path in files {
        let Some(relative) = path.strip_prefix(root).ok() else {
            continue;
        };
        let Some(source_session_id) = source_id_for_relative(layout, relative) else {
            continue;
        };
        ensure_exact_safe_history_file(&path, root, identity_home, layout)?;
        let physical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen_physical_paths.insert(physical) {
            continue;
        }
        let (mtime, size) = imported_paths::file_metadata_signature(&path, "Kimi")?;
        if size > MAX_WIRE_FILE_BYTES {
            return Err(format!(
                "Kimi history {} exceeds the {}-byte safety limit",
                path.display(),
                MAX_WIRE_FILE_BYTES
            ));
        }
        records.push(ImportedHistoryDiscoveredRecord {
            source_record_key: source_session_id.clone(),
            source_session_id,
            source_path: path,
            source_mtime_ms: mtime,
            source_size_bytes: size,
            source_fingerprint: fingerprint.to_string(),
            parser_version: KIMI_METADATA_PARSER_VERSION,
        });
    }
    Ok(())
}

fn source_id_for_relative(layout: KimiLayout, relative: &Path) -> Option<String> {
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let parts = match layout {
        KimiLayout::Legacy if components.len() == 3 && components[2] == "wire.jsonl" => {
            vec!["cli", components[0], components[1]]
        }
        KimiLayout::Code
            if components.len() == 5
                && components[2] == "agents"
                && components[4] == "wire.jsonl" =>
        {
            vec!["code", components[0], components[1], components[3]]
        }
        _ => return None,
    };
    if parts
        .iter()
        .any(|part| part.is_empty() || part.len() > MAX_ID_BYTES || *part == "." || *part == "..")
    {
        return None;
    }
    Some(parts.join("/"))
}

fn read_legacy_config(home: &Path) -> LegacyConfig {
    let kimi_home = home.join(".kimi");
    let model = read_bounded_config(&kimi_home.join("config.toml"), home)
        .and_then(|bytes| model_from_toml(&bytes))
        .or_else(|| {
            read_bounded_config(&kimi_home.join("config.json"), home)
                .and_then(|bytes| model_from_json(&bytes))
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    LegacyConfig {
        fingerprint: model_fingerprint(&model),
        model,
    }
}

fn read_bounded_config(path: &Path, identity_home: &Path) -> Option<Vec<u8>> {
    ensure_safe_descendant(path, identity_home, true).ok()?;
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_CONFIG_BYTES).then_some(bytes)
}

fn model_from_json(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .get("default_model")
                .or_else(|| value.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|model| !model.is_empty() && model.len() <= MAX_MODEL_BYTES)
}

fn model_from_toml(bytes: &[u8]) -> Option<String> {
    let content = std::str::from_utf8(bytes).ok()?;
    for line in content.lines() {
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "default_model" {
            continue;
        }
        let raw_value = raw_value.trim_start();
        let model = if raw_value.starts_with('"') {
            let quoted = take_quoted_value(raw_value, b'"', true)?;
            serde_json::from_str::<String>(quoted).ok()?
        } else if raw_value.starts_with('\'') {
            let quoted = take_quoted_value(raw_value, b'\'', false)?;
            quoted[1..quoted.len().saturating_sub(1)].to_string()
        } else {
            continue;
        };
        let model = model.trim().to_string();
        if !model.is_empty() && model.len() <= MAX_MODEL_BYTES {
            return Some(model);
        }
    }
    None
}

fn take_quoted_value(value: &str, quote: u8, honors_escape: bool) -> Option<&str> {
    let bytes = value.as_bytes();
    if bytes.first().copied() != Some(quote) {
        return None;
    }
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate().skip(1) {
        if honors_escape && byte == b'\\' && !escaped {
            escaped = true;
            continue;
        }
        if byte == quote && !escaped {
            return value.get(..=index);
        }
        escaped = false;
    }
    None
}

fn model_fingerprint(model: &str) -> String {
    let mut hasher = PrefixHasher::default();
    hasher.update(model.as_bytes());
    format!("kimi-config-model-v1:{}", hasher.digest())
}

fn layout_from_source_id(source_session_id: &str) -> Result<KimiLayout, String> {
    if source_session_id.starts_with("cli/") {
        Ok(KimiLayout::Legacy)
    } else if source_session_id.starts_with("code/") {
        Ok(KimiLayout::Code)
    } else {
        Err(format!(
            "Unknown Kimi source namespace: {source_session_id}"
        ))
    }
}

fn session_placement(
    source_session_id: &str,
    has_replayable_content: bool,
) -> Result<(bool, Option<String>), String> {
    match layout_from_source_id(source_session_id)? {
        KimiLayout::Legacy => Ok((true, None)),
        KimiLayout::Code => {
            let parts = source_session_id.split('/').collect::<Vec<_>>();
            if parts.len() != 4 {
                return Err(format!(
                    "Invalid Kimi Code source identity: {source_session_id}"
                ));
            }
            let parent_session_id = (parts[3] != "main")
                .then(|| format!("{KIMI_SESSION_PREFIX}code/{}/{}/main", parts[1], parts[2]));
            // Main agents with replayable context appear in the sidebar.
            // Subagents retain the same bit for stats/fork ownership, but their
            // parent id keeps them out of the top-level list. Metadata-only
            // rows remain cached for usage/signatures without empty sessions.
            Ok((has_replayable_content, parent_session_id))
        }
    }
}

fn parse_kimi_meta(
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

fn initial_state(layout: KimiLayout, default_model: &str, fingerprint: &str) -> KimiMetaState {
    KimiMetaState {
        layout: layout.state_label().to_string(),
        config_fingerprint: fingerprint.to_string(),
        default_model: default_model.to_string(),
        ..KimiMetaState::default()
    }
}

impl KimiMetaState {
    fn dedup_indices(&self) -> Result<HashMap<String, usize>, String> {
        let mut indices = HashMap::new();
        for (index, round) in self.rounds.iter().enumerate() {
            if let Some(key) = round.dedup_key.as_ref().filter(|key| !key.is_empty()) {
                if indices.insert(key.clone(), index).is_some() {
                    return Err("Kimi parse state contains duplicate usage ids".to_string());
                }
            }
        }
        Ok(indices)
    }

    fn feed(
        &mut self,
        line: &str,
        layout: KimiLayout,
        fallback_timestamp_ms: i64,
        dedup_indices: &mut HashMap<String, usize>,
    ) -> Result<(), String> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Ok(());
        };
        match layout {
            KimiLayout::Legacy => {
                let timestamp = legacy_timestamp_ms(&value).unwrap_or(fallback_timestamp_ms);
                self.observe_timestamp(timestamp);
                let Some(message) = value.get("message") else {
                    return Ok(());
                };
                let message_type = message
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let payload = message.get("payload").unwrap_or(&Value::Null);
                if message_type == "TurnBegin" && self.first_user_text.is_none() {
                    self.first_user_text =
                        first_string(payload, &["user_input", "userInput", "input"])
                            .map(|text| imported_history::truncate_name(text, 200));
                }
                if message_type != "StatusUpdate" {
                    return Ok(());
                }
                let Some(usage) = payload.get("token_usage") else {
                    return Ok(());
                };
                let round = round_from_usage(
                    usage,
                    &self.default_model,
                    timestamp,
                    legacy_timestamp_ms(&value).is_some(),
                    payload
                        .get("message_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string),
                );
                self.push_legacy_round(round, dedup_indices)
            }
            KimiLayout::Code => {
                let line_type = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let timestamp = code_timestamp_ms(&value).unwrap_or(fallback_timestamp_ms);
                self.observe_timestamp(timestamp);
                if line_type == "config.update" {
                    self.repo_path = value
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|path| !path.is_empty() && path.len() <= 4_096)
                        .map(str::to_string);
                    return Ok(());
                }
                if let Some((role, content)) = code_context_message(&value) {
                    if matches!(role, "user" | "assistant") && code_content_has_text(content) {
                        self.has_replayable_content = true;
                    }
                    if role == "user" && self.first_user_text.is_none() {
                        let text = code_content_text(content);
                        if !text.is_empty() {
                            self.first_user_text =
                                Some(imported_history::truncate_name(&text, 200));
                        }
                    }
                }
                if code_loop_part(&value).is_some_and(|(_, text)| !text.is_empty()) {
                    self.has_replayable_content = true;
                }
                if line_type == "llm.request" {
                    if let Some(model) = value
                        .get("model")
                        .and_then(Value::as_str)
                        .and_then(concrete_code_model)
                    {
                        self.latest_request_model = Some(model);
                    }
                    return Ok(());
                }
                // Every usage.record is an incremental model call. Scope only
                // classifies the call as turn or session work; it is not an
                // aggregate marker. step.end is deliberately ignored because
                // it repeats the corresponding usage.record.
                if line_type != "usage.record" {
                    return Ok(());
                }
                let Some(usage) = value.get("usage") else {
                    return Ok(());
                };
                let model = value
                    .get("model")
                    .and_then(Value::as_str)
                    .and_then(concrete_code_model)
                    .or_else(|| self.latest_request_model.clone())
                    .unwrap_or_else(|| self.default_model.clone());
                self.push_round(round_from_usage(
                    usage,
                    &model,
                    timestamp,
                    code_timestamp_ms(&value).is_some(),
                    None,
                ))
            }
        }
    }

    fn push_legacy_round(
        &mut self,
        round: KimiRoundState,
        dedup_indices: &mut HashMap<String, usize>,
    ) -> Result<(), String> {
        if round.is_empty() {
            return Ok(());
        }
        let Some(key) = round.dedup_key.clone().filter(|key| !key.is_empty()) else {
            return self.push_round(round);
        };
        if key.len() > MAX_ID_BYTES {
            return Err("Kimi message id exceeds the safety limit".to_string());
        }
        if let Some(index) = dedup_indices.get(&key).copied() {
            let existing = &self.rounds[index];
            let replace = round.exact_total() > existing.exact_total()
                || (round.exact_total() == existing.exact_total()
                    && ((round.timestamp_is_wire && !existing.timestamp_is_wire)
                        || (round.timestamp_is_wire == existing.timestamp_is_wire
                            && round.created_at_ms >= existing.created_at_ms)));
            if replace {
                self.rounds[index] = round;
            }
            return Ok(());
        }
        let index = self.rounds.len();
        self.push_round(round)?;
        dedup_indices.insert(key, index);
        Ok(())
    }

    fn push_round(&mut self, round: KimiRoundState) -> Result<(), String> {
        if round.is_empty() {
            return Ok(());
        }
        if self.rounds.len() >= MAX_USAGE_ROUNDS {
            return Err(format!(
                "Kimi history exceeds the {MAX_USAGE_ROUNDS}-round safety limit"
            ));
        }
        self.rounds.push(round);
        Ok(())
    }

    fn observe_timestamp(&mut self, timestamp_ms: i64) {
        if timestamp_ms <= 0 {
            return;
        }
        if self.created_at_ms == 0 || timestamp_ms < self.created_at_ms {
            self.created_at_ms = timestamp_ms;
        }
        self.updated_at_ms = self.updated_at_ms.max(timestamp_ms);
    }

    fn validate(&self) -> Result<(), String> {
        if self.layout.len() > 16
            || self.config_fingerprint.len() > MAX_ID_BYTES
            || self.default_model.len() > MAX_MODEL_BYTES
            || self
                .latest_request_model
                .as_ref()
                .is_some_and(|model| model.len() > MAX_MODEL_BYTES)
            || self
                .first_user_text
                .as_ref()
                .is_some_and(|text| text.len() > 1_024)
            || self
                .repo_path
                .as_ref()
                .is_some_and(|path| path.len() > 4_096)
        {
            return Err("Kimi parse state contains an oversized field".to_string());
        }
        if self.rounds.len() > MAX_USAGE_ROUNDS {
            return Err("Kimi parse state contains too many usage rounds".to_string());
        }
        for round in &self.rounds {
            if round.model.len() > MAX_MODEL_BYTES
                || round
                    .dedup_key
                    .as_ref()
                    .is_some_and(|key| key.len() > MAX_ID_BYTES)
                || [
                    round.input_tokens,
                    round.output_tokens,
                    round.cache_read_tokens,
                    round.cache_write_tokens,
                ]
                .into_iter()
                .any(|tokens| tokens < 0)
            {
                return Err("Kimi parse state contains an invalid usage round".to_string());
            }
        }
        self.dedup_indices().map(|_| ())
    }

    fn finish(
        self,
        record: &ImportedHistoryDiscoveredRecord,
    ) -> Result<(ImportedHistoryCacheInput, Vec<RoundUsage>), String> {
        self.validate()?;
        let fallback_ms = record.source_mtime_ms / 1_000_000;
        let session_id = format!("{KIMI_SESSION_PREFIX}{}", record.source_session_id);
        let (listable, parent_session_id) =
            session_placement(&record.source_session_id, self.has_replayable_content)?;
        let mut input_tokens = 0_i64;
        let mut output_tokens = 0_i64;
        let mut cache_read_tokens = 0_i64;
        let mut cache_write_tokens = 0_i64;
        let mut rounds = Vec::with_capacity(self.rounds.len());
        for (sequence, round) in self.rounds.into_iter().enumerate() {
            input_tokens = input_tokens
                .saturating_add(round.input_tokens)
                .saturating_add(round.cache_read_tokens)
                .saturating_add(round.cache_write_tokens);
            output_tokens = output_tokens.saturating_add(round.output_tokens);
            cache_read_tokens = cache_read_tokens.saturating_add(round.cache_read_tokens);
            cache_write_tokens = cache_write_tokens.saturating_add(round.cache_write_tokens);
            rounds.push(RoundUsage {
                source: SOURCE_KIMI,
                source_session_id: record.source_session_id.clone(),
                session_id: session_id.clone(),
                seq: sequence as i64,
                model: Some(round.model),
                input_tokens: round.input_tokens,
                output_tokens: round.output_tokens,
                cache_read_tokens: round.cache_read_tokens,
                cache_write_tokens: round.cache_write_tokens,
                created_at_ms: round.created_at_ms,
            });
        }
        let model = rounds
            .last()
            .and_then(|round| round.model.clone())
            .or_else(|| Some(self.default_model.clone()));
        let name = self.first_user_text.unwrap_or_else(|| {
            self.repo_path
                .as_deref()
                .and_then(imported_history::repo_name_from_path)
                .unwrap_or_else(|| record.source_record_key.clone())
        });
        Ok((
            ImportedHistoryCacheInput {
                source: SOURCE_KIMI,
                source_session_id: record.source_session_id.clone(),
                session_id,
                source_path: record.source_path.to_string_lossy().to_string(),
                source_record_key: record.source_record_key.clone(),
                source_mtime_ms: record.source_mtime_ms,
                source_size_bytes: record.source_size_bytes,
                source_fingerprint: record.source_fingerprint.clone(),
                parser_version: KIMI_METADATA_PARSER_VERSION,
                name,
                created_at_ms: if self.created_at_ms > 0 {
                    self.created_at_ms
                } else {
                    fallback_ms
                },
                updated_at_ms: if self.updated_at_ms > 0 {
                    self.updated_at_ms
                } else {
                    fallback_ms
                },
                model,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                repo_path: self.repo_path,
                branch: None,
                impact: ImportedHistoryImpactStats::default(),
                listable,
                source_metadata_json: None,
                parent_session_id,
                client_origin: None,
                client_origin_raw: None,
            },
            rounds,
        ))
    }
}

fn round_from_usage(
    usage: &Value,
    model: &str,
    created_at_ms: i64,
    timestamp_is_wire: bool,
    dedup_key: Option<String>,
) -> KimiRoundState {
    KimiRoundState {
        dedup_key,
        model: bounded_model(model),
        input_tokens: nonnegative_token(usage, &["input_other", "inputOther"]),
        output_tokens: nonnegative_token(usage, &["output"]),
        cache_read_tokens: nonnegative_token(usage, &["input_cache_read", "inputCacheRead"]),
        cache_write_tokens: nonnegative_token(
            usage,
            &["input_cache_creation", "inputCacheCreation"],
        ),
        created_at_ms,
        timestamp_is_wire,
    }
}

fn nonnegative_token(value: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().map(|raw| raw.min(i64::MAX as u64) as i64))
        })
        .unwrap_or(0)
        .max(0)
}

fn bounded_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_BYTES {
        DEFAULT_MODEL.to_string()
    } else {
        model.to_string()
    }
}

fn concrete_code_model(model: &str) -> Option<String> {
    let normalized = model
        .trim()
        .strip_prefix("kimi-code/")
        .unwrap_or(model.trim())
        .trim();
    let symbolic =
        normalized.len() >= 4 && normalized.starts_with("__") && normalized.ends_with("__");
    (!normalized.is_empty() && !symbolic && normalized.len() <= MAX_MODEL_BYTES)
        .then(|| normalized.to_string())
}

fn legacy_timestamp_ms(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp")?.as_f64()?;
    if !timestamp.is_finite() || timestamp <= 0.0 {
        return None;
    }
    let millis = timestamp * 1000.0;
    (millis.is_finite() && millis > 0.0 && millis <= i64::MAX as f64).then_some(millis as i64)
}

fn code_timestamp_ms(value: &Value) -> Option<i64> {
    value
        .get("time")?
        .as_i64()
        .filter(|timestamp| *timestamp > 0)
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn code_context_message(value: &Value) -> Option<(&str, &Value)> {
    if value.get("type").and_then(Value::as_str) != Some("context.append_message") {
        return None;
    }
    let message = value.get("message")?;
    let role = message.get("role")?.as_str()?;
    Some((role, message.get("content")?))
}

fn code_context_message_text(value: &Value) -> Option<(&str, String)> {
    let (role, content) = code_context_message(value)?;
    Some((role, code_content_text(content)))
}

fn code_content_has_text(content: &Value) -> bool {
    if content.as_str().is_some_and(|text| !text.is_empty()) {
        return true;
    }
    content.as_array().is_some_and(|parts| {
        parts.iter().any(|part| {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
            match kind {
                "text" => part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()),
                "think" => part
                    .get("think")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()),
                _ => false,
            }
        })
    })
}

fn code_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return bounded_replay_fragment(text, MAX_REPLAY_MESSAGE_CHARS, MAX_REPLAY_TEXT_BYTES);
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    let mut chars = 0usize;
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
        let raw = match kind {
            "text" => part.get("text").and_then(Value::as_str),
            "think" => part.get("think").and_then(Value::as_str),
            _ => None,
        };
        let Some(raw) = raw else {
            continue;
        };
        let fragment = bounded_replay_fragment(
            raw,
            MAX_REPLAY_MESSAGE_CHARS.saturating_sub(chars),
            MAX_REPLAY_TEXT_BYTES.saturating_sub(text.len()),
        );
        chars = chars.saturating_add(fragment.chars().count());
        text.push_str(&fragment);
        if chars >= MAX_REPLAY_MESSAGE_CHARS {
            break;
        }
    }
    text
}

fn code_loop_part(value: &Value) -> Option<(&str, &str)> {
    if value.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
        return None;
    }
    let event = value.get("event")?;
    if event.get("type").and_then(Value::as_str) != Some("content.part") {
        return None;
    }
    let part = event.get("part")?;
    match part.get("type").and_then(Value::as_str)? {
        "text" => Some(("text", part.get("text")?.as_str()?)),
        "think" => Some(("think", part.get("think")?.as_str()?)),
        _ => None,
    }
}

fn read_replay(
    path: &Path,
    root: &Path,
    identity_home: &Path,
    session_id: &str,
    layout: KimiLayout,
) -> Result<Vec<ActivityChunk>, String> {
    ensure_exact_safe_history_file(path, root, identity_home, layout)?;
    let (mtime, size) = imported_paths::file_metadata_signature(path, "Kimi")?;
    if size > MAX_WIRE_FILE_BYTES {
        return Err("Kimi history exceeds the replay safety limit".to_string());
    }
    if layout == KimiLayout::Code {
        return read_code_replay(path, session_id, mtime, size);
    }
    read_legacy_replay(path, session_id, mtime, size)
}

fn read_legacy_replay(
    path: &Path,
    session_id: &str,
    mtime: i64,
    size: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Kimi",
        None,
        KIMI_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut chunks = Vec::new();
    let mut retained_text_bytes = 0usize;
    let mut pending_assistant: Option<(String, String, usize)> = None;
    while let Some(line) = reader.next_line()? {
        let Ok(value) = serde_json::from_str::<Value>(line.text.trim()) else {
            continue;
        };
        let timestamp = legacy_timestamp_ms(&value).unwrap_or(mtime / 1_000_000);
        let created_at = imported_history::epoch_ms_to_iso(timestamp);
        let Some(message) = value.get("message") else {
            continue;
        };
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = message.get("payload").unwrap_or(&Value::Null);
        match kind {
            "TurnBegin" => {
                flush_pending_assistant(
                    &mut chunks,
                    &mut retained_text_bytes,
                    &mut pending_assistant,
                    session_id,
                )?;
                let Some(text) = first_string(payload, &["user_input", "userInput", "input"])
                else {
                    continue;
                };
                push_replay_message(
                    &mut chunks,
                    &mut retained_text_bytes,
                    session_id,
                    "user",
                    &created_at,
                    imported_history::truncate_name(text, MAX_REPLAY_MESSAGE_CHARS),
                )?;
            }
            "ContentPart" => {
                let Some(text) = ["text", "content"]
                    .into_iter()
                    .find_map(|key| payload.get(key).and_then(Value::as_str))
                    .filter(|text| !text.is_empty())
                else {
                    continue;
                };
                let pending =
                    pending_assistant.get_or_insert_with(|| (created_at.clone(), String::new(), 0));
                let remaining_chars = MAX_REPLAY_MESSAGE_CHARS.saturating_sub(pending.2);
                let reserved_bytes = retained_text_bytes.saturating_add(pending.1.len());
                let remaining_bytes = MAX_REPLAY_TEXT_BYTES.saturating_sub(reserved_bytes);
                if remaining_bytes == 0 && !text.is_empty() {
                    return Err(
                        "Kimi replay exceeds the bounded in-memory safety limit".to_string()
                    );
                }
                let fragment = bounded_replay_fragment(text, remaining_chars, remaining_bytes);
                pending.2 = pending.2.saturating_add(fragment.chars().count());
                pending.1.push_str(&fragment);
            }
            _ => {}
        }
    }
    flush_pending_assistant(
        &mut chunks,
        &mut retained_text_bytes,
        &mut pending_assistant,
        session_id,
    )?;
    Ok(chunks)
}

#[derive(Debug)]
struct PendingCodeStep {
    created_at: String,
    thinking: String,
    thinking_chars: usize,
    text: String,
    text_chars: usize,
}

fn read_code_replay(
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

fn bounded_replay_fragment(value: &str, max_chars: usize, max_bytes: usize) -> String {
    let mut result = String::new();
    for character in value.chars().take(max_chars) {
        if result.len().saturating_add(character.len_utf8()) > max_bytes {
            break;
        }
        result.push(character);
    }
    result
}

fn flush_pending_assistant(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    pending: &mut Option<(String, String, usize)>,
    session_id: &str,
) -> Result<(), String> {
    let Some((created_at, text, _)) = pending.take() else {
        return Ok(());
    };
    if text.is_empty() {
        return Ok(());
    }
    push_replay_message(
        chunks,
        retained_text_bytes,
        session_id,
        "assistant",
        &created_at,
        text,
    )
}

fn push_replay_message(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    session_id: &str,
    role: &str,
    created_at: &str,
    text: String,
) -> Result<(), String> {
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_text_bytes.saturating_add(text.len()) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Kimi replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_text_bytes = (*retained_text_bytes).saturating_add(text.len());
    let sequence = chunks.len();
    chunks.push(if role == "user" {
        imported_history::user_message_chunk(session_id, "kimi", sequence, created_at, &text)
    } else {
        imported_history::assistant_message_chunk(session_id, "kimi", sequence, created_at, &text)
    });
    Ok(())
}

fn push_replay_thinking(
    chunks: &mut Vec<ActivityChunk>,
    retained_text_bytes: &mut usize,
    session_id: &str,
    created_at: &str,
    text: String,
) -> Result<(), String> {
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_text_bytes.saturating_add(text.len()) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Kimi replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_text_bytes = (*retained_text_bytes).saturating_add(text.len());
    let sequence = chunks.len();
    chunks.push(imported_history::thinking_chunk(
        session_id, "kimi", sequence, created_at, &text,
    ));
    Ok(())
}

fn ensure_exact_safe_history_file(
    path: &Path,
    root: &Path,
    identity_home: &Path,
    layout: KimiLayout,
) -> Result<(), String> {
    ensure_safe_history_root(root, identity_home)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Kimi history path escaped its configured root".to_string())?;
    if source_id_for_relative(layout, relative).is_none() {
        return Err("Kimi history path does not match the exact provider layout".to_string());
    }

    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("Kimi history path contains an unsafe component".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|err| {
            format!(
                "Failed to inspect Kimi history {}: {err}",
                current.display()
            )
        })?;
        let is_leaf = components.peek().is_none();
        if metadata.file_type().is_symlink()
            || (is_leaf && !metadata.is_file())
            || (!is_leaf && !metadata.is_dir())
        {
            return Err(format!(
                "Refusing unsafe Kimi history path: {}",
                current.display()
            ));
        }
    }

    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect Kimi history {}: {err}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Refusing unsafe Kimi history path: {}",
            path.display()
        ));
    }
    Ok(())
}

fn ensure_safe_history_root(root: &Path, identity_home: &Path) -> Result<(), String> {
    ensure_safe_descendant(root, identity_home, false)
}

fn ensure_safe_descendant(
    path: &Path,
    identity_home: &Path,
    leaf_is_file: bool,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(identity_home)
        .map_err(|_| "Kimi path escaped its external-history identity".to_string())?;
    let mut current = fs::canonicalize(identity_home).map_err(|error| {
        format!(
            "Failed to resolve Kimi external-history identity {}: {error}",
            identity_home.display()
        )
    })?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("Kimi path contains an unsafe component".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            format!("Failed to inspect Kimi path {}: {error}", current.display())
        })?;
        let is_leaf = components.peek().is_none();
        if metadata.file_type().is_symlink()
            || (is_leaf && leaf_is_file && !metadata.is_file())
            || ((!is_leaf || !leaf_is_file) && !metadata.is_dir())
        {
            return Err(format!("Refusing unsafe Kimi path: {}", current.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
