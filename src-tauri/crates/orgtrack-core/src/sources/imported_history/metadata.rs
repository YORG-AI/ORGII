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

#[derive(Debug, Clone)]
pub struct ImportedHistoryCacheInput {
    pub source: &'static str,
    pub source_session_id: String,
    pub session_id: String,
    pub source_path: String,
    pub source_record_key: String,
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
}

#[derive(Debug, Clone)]
pub struct ImportedHistoryRecordSignature {
    pub source_session_id: String,
    pub source_path: String,
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
