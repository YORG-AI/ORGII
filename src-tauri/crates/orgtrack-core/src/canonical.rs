use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::privacy::OrgtrackTier;

pub const SOURCE_ORGII_RUST_AGENTS: &str = "orgii_rust_agents";
pub const SOURCE_ORGII_CLI_SESSIONS: &str = "orgii_cli_sessions";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Heartbeat,
    ToolCall,
    FileEdit,
    FileCreate,
    FileDelete,
    TerminalCommand,
    AgentAction,
    Message,
    ImportEvent,
    FocusGained,
    FocusLost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetadata {
    pub dispatch_category: Option<String>,
    pub rust_agent_type: Option<String>,
    pub cli_agent_type: Option<String>,
    pub agent_exec_mode: Option<String>,
    pub provider_model_type: Option<String>,
    pub model: Option<String>,
    pub key_source: Option<String>,
    pub origin: Option<String>,
    pub display_name: Option<String>,
    pub parsed_categories: BTreeMap<String, String>,
}

impl Default for AgentMetadata {
    fn default() -> Self {
        Self {
            dispatch_category: None,
            rust_agent_type: None,
            cli_agent_type: None,
            agent_exec_mode: None,
            provider_model_type: None,
            model: None,
            key_source: None,
            origin: None,
            display_name: None,
            parsed_categories: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub schema_version: u32,
    pub source: String,
    pub source_session_id: String,
    pub session_id: String,
    pub title: String,
    pub status: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
    pub workspace_path: Option<String>,
    pub branch: Option<String>,
    pub parent_session_id: Option<String>,
    pub org_member_id: Option<String>,
    pub metadata: AgentMetadata,
    /// Explicit Journey associations supplied by the session producer. They
    /// are never reconstructed from names, paths, branches, or event order.
    #[serde(default)]
    pub journey: JourneyMetadata,
}

/// Optional durable metadata consumed by the read-only Journey projector.
/// `topic_tags` has no automatic producer yet; it remains empty until an
/// explicit producer supplies it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JourneyMetadata {
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_identity: Option<String>,
    pub agent_band: Option<String>,
    #[serde(default)]
    pub topic_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub source: String,
    pub source_event_id: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub kind: ActivityKind,
    pub workspace_path: Option<String>,
    pub file_path: Option<String>,
    pub language: Option<String>,
    pub lines_added: i32,
    pub lines_removed: i32,
    pub metadata_json: Option<String>,
    pub tier: OrgtrackTier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub source: String,
    pub session_id: String,
    pub file_path: String,
    pub path_hash: String,
    pub function_name: Option<String>,
    pub node_type: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub lines_added: i32,
    pub lines_removed: i32,
    pub timestamp: i64,
    pub tier: OrgtrackTier,
    pub metadata: AgentMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLinkRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub commit_sha: String,
    pub file_paths: Vec<String>,
    pub session_ids: Vec<String>,
    pub reachability_state: String,
    pub linked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEditKind {
    Read,
    Write,
    Delete,
    Patch,
    CommitBoundary,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactQuality {
    Exact,
    PatchReversible,
    Inferred,
    StatsOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointKind {
    PreMessageSnapshot,
    PostToolCall,
    PostTurn,
    ExplicitUserCheckpoint,
    CommitBoundary,
    Inferred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEditArtifactRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub session_id: String,
    pub source_event_id: Option<String>,
    pub turn_id: Option<String>,
    /// Exact event-provided execution turn. Journey does not read the legacy
    /// `turn_id` or derive turns from `sequence_index`.
    #[serde(default)]
    pub execution_turn_id: Option<String>,
    pub sequence_index: i64,
    pub timestamp: Option<String>,
    pub workspace_path: Option<String>,
    pub file_path: String,
    pub path_hash: String,
    pub edit_kind: SessionEditKind,
    pub old_start_line: Option<u32>,
    pub new_start_line: Option<u32>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub lines_added: i32,
    pub lines_removed: i32,
    pub quality: ArtifactQuality,
    pub metadata: AgentMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiffChunkRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub edit_record_id: String,
    pub source: String,
    pub session_id: String,
    pub source_event_id: Option<String>,
    pub sequence_index: i64,
    pub chunk_index: i64,
    pub file_path: String,
    pub old_start_line: Option<u32>,
    pub new_start_line: Option<u32>,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub diff: Option<String>,
    pub lines_added: i32,
    pub lines_removed: i32,
    pub is_deleted: bool,
    pub quality: ArtifactQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFinalDiffRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub source: String,
    pub session_id: String,
    pub file_path: String,
    pub baseline_event_id: Option<String>,
    pub final_event_id: Option<String>,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub diff: Option<String>,
    pub lines_added: i32,
    pub lines_removed: i32,
    #[serde(default)]
    pub is_deleted: bool,
    pub quality: ArtifactQuality,
    pub differs_from_summed_chunks: bool,
    pub computed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpointRecord {
    pub schema_version: u32,
    pub checkpoint_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub session_id: String,
    pub sequence_index: i64,
    pub source_event_id: Option<String>,
    pub turn_id: Option<String>,
    pub checkpoint_kind: CheckpointKind,
    pub timestamp: Option<String>,
    pub affected_file_paths: Vec<String>,
    pub edit_record_ids: Vec<String>,
    pub quality: ArtifactQuality,
    pub undo_supported: bool,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpointFileStateRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub checkpoint_id: String,
    pub session_id: String,
    pub file_path: String,
    pub content: Option<String>,
    pub reverse_patch: Option<String>,
    pub diff: Option<String>,
    pub content_hash: Option<String>,
    pub quality: ArtifactQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTrajectoryRef {
    pub schema_version: u32,
    pub source: String,
    pub session_id: String,
    pub source_path: Option<String>,
    pub source_record_key: Option<String>,
    pub fingerprint: Option<String>,
    pub tier: OrgtrackTier,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCheckpoint {
    pub schema_version: u32,
    pub source: String,
    pub parser_version: u32,
    pub last_cursor: Option<String>,
    pub source_fingerprint: Option<String>,
    pub phase: Option<String>,
    pub processed: usize,
    pub updated_at: Option<String>,
}
