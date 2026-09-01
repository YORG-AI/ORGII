//! The resumable Kimi parse state and its usage-round accumulation rules.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    self,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        RoundUsage, SOURCE_KIMI,
    },
};

use super::identity::{
    session_placement, KimiLayout, DEFAULT_MODEL, KIMI_METADATA_PARSER_VERSION,
    KIMI_SESSION_PREFIX, MAX_ID_BYTES, MAX_MODEL_BYTES, MAX_USAGE_ROUNDS,
};
use super::wire::{
    code_content_has_text, code_content_text, code_context_message, code_loop_part,
    code_timestamp_ms, first_string, legacy_timestamp_ms,
};

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
pub(super) struct KimiMetaState {
    pub(super) layout: String,
    pub(super) config_fingerprint: String,
    default_model: String,
    latest_request_model: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    first_user_text: Option<String>,
    repo_path: Option<String>,
    has_replayable_content: bool,
    rounds: Vec<KimiRoundState>,
}

pub(super) fn initial_state(
    layout: KimiLayout,
    default_model: &str,
    fingerprint: &str,
) -> KimiMetaState {
    KimiMetaState {
        layout: layout.state_label().to_string(),
        config_fingerprint: fingerprint.to_string(),
        default_model: default_model.to_string(),
        ..KimiMetaState::default()
    }
}

impl KimiMetaState {
    pub(super) fn dedup_indices(&self) -> Result<HashMap<String, usize>, String> {
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

    pub(super) fn feed(
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

    pub(super) fn validate(&self) -> Result<(), String> {
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

    pub(super) fn finish(
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
