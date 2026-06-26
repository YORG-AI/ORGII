use crate::canonical::{
    ActivityRecord, CommitLinkRecord, FileChangeRecord, SessionCheckpointFileStateRecord,
    SessionCheckpointRecord, SessionDiffChunkRecord, SessionEditArtifactRecord,
    SessionFinalDiffRecord, SessionRecord,
};

#[derive(Debug, Clone)]
pub struct SourceDescriptor {
    pub id: String,
    pub label: String,
    pub parser_version: u32,
}

#[derive(Debug, Clone, Default)]
pub struct SourceScanOptions {
    pub workspace_path: Option<String>,
    pub resume: bool,
    pub rebuild: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SourceRecords {
    pub sessions: Vec<SessionRecord>,
    pub activities: Vec<ActivityRecord>,
    pub file_changes: Vec<FileChangeRecord>,
    pub commit_links: Vec<CommitLinkRecord>,
    pub edit_artifacts: Vec<SessionEditArtifactRecord>,
    pub diff_chunks: Vec<SessionDiffChunkRecord>,
    pub final_diffs: Vec<SessionFinalDiffRecord>,
    pub checkpoints: Vec<SessionCheckpointRecord>,
    pub checkpoint_file_states: Vec<SessionCheckpointFileStateRecord>,
}

pub trait SourceAdapter {
    fn descriptor(&self) -> SourceDescriptor;
    fn scan(&self, options: &SourceScanOptions) -> Result<SourceRecords, String>;
}

pub mod activity;
pub mod claude_code;
pub mod cli_session_db;
pub mod codex;
pub mod cursor_ide;
pub mod imported_history;
pub mod opencode;
pub mod orgii_cli;
pub mod orgii_rust_agents;
pub mod windsurf;
pub mod workbuddy;
