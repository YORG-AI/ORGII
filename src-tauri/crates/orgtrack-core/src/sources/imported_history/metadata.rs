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
pub const SOURCE_OPENCODE: &str = "opencode";
pub const SOURCE_WINDSURF: &str = "windsurf";
pub const SOURCE_WORKBUDDY: &str = "workbuddy";
pub const SOURCE_TRAE: &str = "trae";
pub const SOURCE_CLINE: &str = "cline";
pub const SOURCE_WARP: &str = "warp";
pub const SOURCE_ZCODE: &str = "zcode";
pub const SOURCE_QODER: &str = "qoder";
// Hook-only sources: ORGII installs a managed PostToolUse command hook for
// these CLIs and records their file-interaction provenance, but does not yet
// import their session transcripts. Kept out of `is_imported_history_source`
// so the scan inventory does not advertise a Rescan that has no parser.
pub const SOURCE_QWEN_CODE: &str = "qwen_code";
pub const SOURCE_FACTORY_DROID: &str = "droid";
pub const SOURCE_KIMI: &str = "kimi";
pub const SOURCE_ANTIGRAVITY: &str = "antigravity";

pub fn is_imported_history_source(source: &str) -> bool {
    matches!(
        source,
        SOURCE_CLAUDE_CODE
            | SOURCE_CODEX_APP
            | SOURCE_CURSOR_IDE
            | SOURCE_OPENCODE
            | SOURCE_WINDSURF
            | SOURCE_WORKBUDDY
            | SOURCE_TRAE
            | SOURCE_CLINE
            | SOURCE_WARP
            | SOURCE_ZCODE
            | SOURCE_QODER
    )
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
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub impact: ImportedHistoryImpactStats,
    pub listable: bool,
    pub source_metadata_json: Option<String>,
    pub parent_session_id: Option<String>,
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
