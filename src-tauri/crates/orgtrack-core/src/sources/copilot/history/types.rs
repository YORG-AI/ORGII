//! Shared Copilot history data shapes: the raw `events.jsonl` line, the
//! `workspace.yaml` sidecar, `session-store.db` enrichment rows, and the
//! discovered-record / parsed-metadata carriers passed between submodules.

use serde::Deserialize;
use serde_json::Value;

use crate::sources::imported_history::{
    metadata::{
        ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        ImportedHistoryRecordSignature, RoundUsage,
    },
    watermark::{ImportedParseWatermark, PrefixHasher},
};

/// One `events.jsonl` line. `data` stays an untyped [`Value`] so unknown
/// event types (and new fields on known ones) parse without erroring.
#[derive(Debug, Default, Deserialize)]
pub(super) struct CopilotEventLine {
    #[serde(default)]
    pub(super) r#type: String,
    #[serde(default)]
    pub(super) data: Value,
    #[serde(default)]
    pub(super) timestamp: String,
}

/// Fields read from the flat `workspace.yaml` sidecar.
#[derive(Debug, Default, Clone)]
pub(super) struct CopilotWorkspaceMeta {
    pub(super) cwd: Option<String>,
    pub(super) name: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
}

/// One `assistant_usage_events` row (already in db order).
#[derive(Debug, Clone, Default)]
pub(super) struct CopilotUsageRow {
    pub(super) model: Option<String>,
    /// CACHE-INCLUSIVE input (fresh + cache_read + cache_write); see the
    /// module docs for the empirical verification.
    pub(super) input_tokens: i64,
    /// Reasoning-INCLUSIVE output; reasoning is a reported subset, not an
    /// addend.
    pub(super) output_tokens: i64,
    pub(super) cache_read_tokens: i64,
    pub(super) cache_write_tokens: i64,
    pub(super) created_at_ms: i64,
}

/// Best-effort per-session enrichment from `session-store.db`.
#[derive(Debug, Clone, Default)]
pub(super) struct CopilotDbEnrichment {
    pub(super) repository: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) usage: Vec<CopilotUsageRow>,
}

impl CopilotDbEnrichment {
    /// Minimal usage/branch signature folded into the discovery fingerprint,
    /// so out-of-band db writes (usage rows land after `events.jsonl` stops
    /// changing at shutdown, or the db was locked on the previous scan)
    /// trigger a re-parse on the next scan.
    pub(super) fn fingerprint(&self) -> String {
        let mut hasher = PrefixHasher::default();
        hasher.update(self.repository.as_deref().unwrap_or_default().as_bytes());
        hasher.update(&[0]);
        hasher.update(self.branch.as_deref().unwrap_or_default().as_bytes());
        for row in &self.usage {
            hasher.update(&[0xff]);
            hasher.update(row.model.as_deref().unwrap_or_default().as_bytes());
            for value in [
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
                row.created_at_ms,
            ] {
                hasher.update(&value.to_le_bytes());
            }
        }
        format!("db-v2:{}:{}", self.usage.len(), hasher.digest())
    }
}

#[derive(Debug, Clone)]
pub(super) struct CopilotDiscoveredRecord {
    pub(super) record: ImportedHistoryDiscoveredRecord,
    pub(super) enrichment: CopilotDbEnrichment,
}

impl CopilotDiscoveredRecord {
    pub(super) fn signature(&self) -> ImportedHistoryRecordSignature {
        self.record.signature()
    }
}

#[derive(Debug, Clone)]
pub(super) struct CopilotHistoryMeta {
    pub(super) source_session_id: String,
    pub(super) session_id: String,
    pub(super) source_path: String,
    pub(super) source_record_key: String,
    pub(super) source_mtime_ms: i64,
    pub(super) source_size_bytes: i64,
    pub(super) source_fingerprint: String,
    pub(super) name: String,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) model: Option<String>,
    pub(super) repo_path: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) input_tokens: i64,
    pub(super) output_tokens: i64,
    pub(super) cache_read_tokens: i64,
    pub(super) cache_write_tokens: i64,
    pub(super) rounds: Vec<RoundUsage>,
    pub(super) impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedCopilotMeta {
    pub(super) meta: CopilotHistoryMeta,
    pub(super) watermark: ImportedParseWatermark,
}
