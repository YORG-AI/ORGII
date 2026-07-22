use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct ImportedHistoryImpactStats {
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
}

pub const SOURCE_CLAUDE_CODE: &str = "claude_code";
pub const SOURCE_CODEX_APP: &str = "codex_app";
pub const SOURCE_CURSOR_IDE: &str = "cursor_ide";
pub const SOURCE_CURSOR_CLI: &str = "cursor_cli";
pub const SOURCE_OPENCODE: &str = "opencode";
pub const SOURCE_WINDSURF: &str = "windsurf";
pub const SOURCE_WORKBUDDY: &str = "workbuddy";
pub const SOURCE_TRAE: &str = "trae";
pub const SOURCE_CLINE: &str = "cline";
pub const SOURCE_WARP: &str = "warp";
pub const SOURCE_ZCODE: &str = "zcode";
pub const SOURCE_QODER: &str = "qoder";
pub const SOURCE_MIMO_CODE: &str = "mimo_code";
pub const SOURCE_OMP: &str = "omp";
pub const SOURCE_QODER_CLI: &str = "qoder_cli";
/// Transcript-bearing sources that must each have a bounded replay adapter.
/// The replay registry contract test compares against this inventory, so a
/// newly imported source cannot silently inherit a full-history fallback.
pub const IMPORTED_HISTORY_SOURCES: [&str; 15] = [
    SOURCE_CLAUDE_CODE,
    SOURCE_CODEX_APP,
    SOURCE_CURSOR_IDE,
    SOURCE_CURSOR_CLI,
    SOURCE_OPENCODE,
    SOURCE_WINDSURF,
    SOURCE_WORKBUDDY,
    SOURCE_TRAE,
    SOURCE_CLINE,
    SOURCE_WARP,
    SOURCE_ZCODE,
    SOURCE_QODER,
    SOURCE_MIMO_CODE,
    SOURCE_OMP,
    SOURCE_QODER_CLI,
];
// Hook-only sources: ORGII installs a managed PostToolUse command hook for
// these CLIs and records their file-interaction provenance, but does not yet
// import their session transcripts. Kept out of `is_imported_history_source`
// so the scan inventory does not advertise a Rescan that has no parser.
pub const SOURCE_QWEN_CODE: &str = "qwen_code";
pub const SOURCE_FACTORY_DROID: &str = "droid";
pub const SOURCE_KIMI: &str = "kimi";
pub const SOURCE_ANTIGRAVITY: &str = "antigravity";

pub fn is_imported_history_source(source: &str) -> bool {
    IMPORTED_HISTORY_SOURCES.contains(&source)
}

#[derive(Debug, Clone)]
pub struct ImportedHistoryCacheInput {
    pub source: &'static str,
    pub source_session_id: String,
    pub session_id: String,
    pub source_path: String,
    pub source_record_key: String,
    /// Source file modified time as **nanoseconds** since the Unix epoch
    /// (nanosecond granularity so rapid in-place edits invalidate reliably).
    /// The `_ms` suffix is retained only to match the cache column name.
    pub source_mtime_ms: i64,
    pub source_size_bytes: i64,
    pub source_fingerprint: String,
    pub parser_version: i64,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub model: Option<String>,
    /// Cache-inclusive input (input + cache_read + cache_write), matching what
    /// the source reports. The usage projection subtracts the cache fields
    /// below to recover fresh input.
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Cache-read tokens contained within `input_tokens` (0 when the source
    /// does not report cache separately).
    pub cache_read_tokens: i64,
    /// Cache-write / creation tokens contained within `input_tokens`.
    pub cache_write_tokens: i64,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub impact: ImportedHistoryImpactStats,
    pub listable: bool,
    pub source_metadata_json: Option<String>,
    pub parent_session_id: Option<String>,
}

/// One imported per-round (assistant round / LLM call) usage record, written to
/// `imported_history_round_usage`. `input_tokens` is FRESH (cache excluded),
/// matching the native `session_token_usage` grain.
#[derive(Debug, Clone)]
pub struct RoundUsage {
    pub source: &'static str,
    pub source_session_id: String,
    pub session_id: String,
    /// 0-based round index within the session (ordering key).
    pub seq: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ImportedHistoryRecordSignature {
    pub source_session_id: String,
    pub source_path: String,
    /// Nanosecond-granularity source mtime; see [`ImportedHistoryCacheInput::source_mtime_ms`].
    pub source_mtime_ms: i64,
    pub source_size_bytes: i64,
    pub source_fingerprint: String,
    pub parser_version: i64,
}

#[derive(Debug, Clone)]
pub struct ImportedHistoryDiscoveredRecord {
    pub source_session_id: String,
    pub source_path: PathBuf,
    pub source_record_key: String,
    pub source_mtime_ms: i64,
    pub source_size_bytes: i64,
    pub source_fingerprint: String,
    pub parser_version: i64,
}

impl ImportedHistoryDiscoveredRecord {
    pub fn signature(&self) -> ImportedHistoryRecordSignature {
        ImportedHistoryRecordSignature {
            source_session_id: self.source_session_id.clone(),
            source_path: self.source_path.to_string_lossy().to_string(),
            source_mtime_ms: self.source_mtime_ms,
            source_size_bytes: self.source_size_bytes,
            source_fingerprint: self.source_fingerprint.clone(),
            parser_version: self.parser_version,
        }
    }
}
