use serde::Deserialize;
use serde_json::Value;

use crate::sources::imported_history::{self, metadata::ImportedHistoryImpactStats};

#[derive(Debug, Clone)]
pub(super) struct SessionMeta {
    pub(super) source_session_id: String,
    pub(super) session_id: String,
    pub(super) source_path: String,
    pub(super) source_record_key: String,
    pub(super) source_mtime_ms: i64,
    pub(super) source_size_bytes: i64,
    pub(super) name: String,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) model: Option<String>,
    pub(super) input_tokens: i64,
    pub(super) output_tokens: i64,
    pub(super) cache_read_tokens: i64,
    pub(super) cache_write_tokens: i64,
    pub(super) repo_path: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct JsonlLine {
    #[serde(rename = "type")]
    pub(super) line_type: String,
    pub(super) id: String,
    pub(super) timestamp: Value,
    pub(super) cwd: String,
    pub(super) model_id: String,
    pub(super) git_branch: String,
    pub(super) message: Option<JsonlMessage>,
    pub(super) is_meta: bool,
    pub(super) origin: Option<JsonlOrigin>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct JsonlOrigin {
    pub(super) kind: String,
}

pub(super) fn is_harness_injected_line(parsed: &JsonlLine) -> bool {
    imported_history::is_harness_injected_user_marker(
        parsed.is_meta,
        parsed.origin.as_ref().map(|origin| origin.kind.as_str()),
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct JsonlMessage {
    pub(super) role: String,
    pub(super) model: String,
    pub(super) content: Value,
    pub(super) usage: Value,
}

pub(super) struct TranscriptTurn {
    pub(super) created_at: String,
    pub(super) message: JsonlMessage,
    pub(super) harness_injected: bool,
}

#[derive(Default)]
pub(super) struct TranscriptRead {
    pub(super) turns: Vec<TranscriptTurn>,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) repo_path: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) model: Option<String>,
    pub(super) input_tokens: i64,
    pub(super) output_tokens: i64,
    pub(super) cache_read_tokens: i64,
    pub(super) cache_write_tokens: i64,
    pub(super) first_user_text: Option<String>,
}
