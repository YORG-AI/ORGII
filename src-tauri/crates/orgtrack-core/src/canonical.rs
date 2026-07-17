use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::privacy::OrgtrackTier;
pub use orgtrack_protocol::{
    AttributionPrecision, FileResourceRecord, ResourceAction, ResourceInteractionCaptureMethod,
    ResourceInteractionEnvelopeV1, ResourceInteractionOutcome, ResourceInteractionRecord,
    SessionActorLifecycleEnvelopeV1, SessionActorLifecyclePhase, SessionActorRecord,
    RESOURCE_INTERACTION_SCHEMA_VERSION, SESSION_ACTOR_SCHEMA_VERSION,
};

pub const SOURCE_ORGII_RUST_AGENTS: &str = "orgii_rust_agents";
pub const SOURCE_ORGII_CLI_SESSIONS: &str = "orgii_cli_sessions";
pub const SOURCE_ORGII_CLOUD_REPLAY: &str = "orgii_cloud_replay";
/// Session placeholder created from hook metadata before a replayable source
/// transcript has been independently discovered.
pub const SESSION_PROVENANCE_HOOK_ORIGIN: &str = "session_provenance_hook";

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

/// Origin of a locally cached, read-only collaboration replay.
///
/// This is session identity metadata only. Transcript events continue to be
/// governed by the collaboration replay access ladder; no prompts, tool
/// output, diffs, or file contents are duplicated into Orgtrack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSessionOrigin {
    pub org_id: String,
    pub session_row_id: String,
    pub source_session_id: String,
    pub owner_member_id: String,
    pub owner_display_name: String,
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
    #[serde(default)]
    pub collaboration_origin: Option<CollaborationSessionOrigin>,
    pub metadata: AgentMetadata,
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
