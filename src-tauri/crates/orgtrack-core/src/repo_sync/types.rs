use serde::{Deserialize, Serialize};

use crate::canonical::AgentMetadata;
use crate::privacy::{OrgtrackTier, ORGTRACK_SCHEMA_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackScanStatus {
    Idle,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackScanPhase {
    Discover,
    Provenance,
    LocalEdits,
    Sessions,
    Commits,
    Index,
    Done,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackScanCounts {
    pub sessions: usize,
    pub files: usize,
    pub commits: usize,
    pub entries: usize,
    pub records: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackScanProgress {
    pub schema_version: u32,
    pub repo_path: String,
    pub tier: OrgtrackTier,
    pub status: OrgtrackScanStatus,
    pub phase: OrgtrackScanPhase,
    pub processed: usize,
    pub total: usize,
    pub counts: OrgtrackScanCounts,
    pub last_error: Option<String>,
    pub resumable: bool,
    pub cancel_requested: bool,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackScanCheckpoint {
    pub schema_version: u32,
    pub tier: Option<OrgtrackTier>,
    pub phase: Option<OrgtrackScanPhase>,
    pub last_provenance_id: Option<i64>,
    pub last_local_edit_event_id: Option<String>,
    pub last_session_id: Option<String>,
    pub last_commit_sha: Option<String>,
    pub processed: usize,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackManifest {
    pub schema_version: u32,
    pub generated_at: String,
    pub source_records_root: Option<String>,
    pub derived_index_root: Option<String>,
    pub last_provenance_id: Option<i64>,
    pub last_commit_lineage_id: Option<i64>,
    pub record_count: usize,
    pub timeline_record_count: usize,
    pub derived_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackIndex {
    pub schema_version: u32,
    pub generated_at: String,
    pub exported_tier: OrgtrackTier,
    pub derived_version: u64,
    pub summary: OrgtrackIndexSummary,
    pub sessions: Vec<OrgtrackIndexSession>,
    pub files: Vec<OrgtrackIndexFile>,
    pub commits: Vec<OrgtrackIndexCommit>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackIndexSummary {
    pub sessions_by_app_type: Vec<OrgtrackSummaryBucket>,
    pub models_used: Vec<OrgtrackSummaryBucket>,
    pub total_sessions: usize,
    pub total_files: usize,
    pub total_commits: usize,
    pub total_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSummaryBucket {
    pub key: String,
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackIndexSession {
    pub session_id: String,
    pub label: String,
    pub files_count: usize,
    pub commits_count: usize,
    pub committed_files_count: usize,
    pub committed_rate_percent: usize,
    pub first_edit_at: Option<i64>,
    pub last_edit_at: Option<i64>,
    pub agent_identity: OrgtrackAgentIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackIndexFile {
    pub path: String,
    pub path_hash: String,
    pub sessions_count: usize,
    pub commits_count: usize,
    pub entries_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackIndexCommit {
    pub commit_sha: String,
    pub files_count: usize,
    pub sessions_count: usize,
    pub reachability_state: OrgtrackReachabilityState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSessionMeta {
    pub schema_version: u32,
    pub tier: OrgtrackTier,
    pub session_id: String,
    pub label: String,
    pub agent_identity: OrgtrackAgentIdentity,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub branch_context: OrgtrackBranchContext,
    pub files: Vec<String>,
    pub commits: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSessionDetails {
    pub schema_version: u32,
    pub tier: OrgtrackTier,
    pub session_id: String,
    pub changed_files: Vec<OrgtrackChangedFile>,
    pub symbols: Vec<OrgtrackSymbolEntry>,
    pub parsed_categories: Vec<OrgtrackParsedCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackChangedFile {
    pub path: String,
    pub edit_count: usize,
    pub commits: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSymbolEntry {
    pub file_path: String,
    pub function_name: Option<String>,
    pub node_type: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
    pub commit_sha: Option<String>,
    pub reachability: OrgtrackReachability,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSessionTrajectory {
    pub schema_version: u32,
    pub tier: OrgtrackTier,
    pub session_id: String,
    pub raw_events: Vec<OrgtrackRawEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackRawEvent {
    pub source: OrgtrackRawEventSource,
    pub name: Option<String>,
    pub args_json: Option<String>,
    pub result_json: Option<String>,
    pub sequence: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackRawEventSource {
    Event,
    CodeSessionChunk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackCommitRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub commit_sha: String,
    pub files: Vec<String>,
    pub sessions: Vec<String>,
    pub branch_context: OrgtrackBranchContext,
    pub reachability: OrgtrackReachability,
    pub linked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackProvenanceRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub provenance_id: i64,
    pub session_id: String,
    pub file_path: String,
    pub path_hash: String,
    pub function_name: Option<String>,
    pub node_type: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
    pub created_at: i64,
    pub tier: OrgtrackTier,
    pub branch_context: OrgtrackBranchContext,
    pub agent_identity: OrgtrackAgentIdentity,
    pub linked_commits: Vec<String>,
    pub reachability: OrgtrackReachability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackFileTimeline {
    pub schema_version: u32,
    pub file_path: String,
    pub path_hash: String,
    pub entries: Vec<OrgtrackFileTimelineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackTimelineRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub file_path: String,
    pub path_hash: String,
    pub entry: OrgtrackFileTimelineEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackFileTimelineEntry {
    pub entry_type: OrgtrackTimelineEntryType,
    pub id: String,
    pub file_path: String,
    pub session_id: Option<String>,
    pub session_label: Option<String>,
    pub agent_identity: Option<OrgtrackAgentIdentity>,
    pub branch_context: OrgtrackBranchContext,
    pub commit_sha: Option<String>,
    pub reachability: OrgtrackReachability,
    pub timestamp: i64,
    pub summary: Option<String>,
    pub function_name: Option<String>,
    pub node_type: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub tier: OrgtrackTier,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackTimelineEntryType {
    SessionEdit,
    CommitLink,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackBranchContext {
    pub authoring_branch: Option<String>,
    pub authoring_head_sha: Option<String>,
    pub authoring_base_branch: Option<String>,
    pub authoring_base_sha: Option<String>,
    pub default_branch: Option<String>,
    pub worktree_path_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackReachabilityState {
    Uncommitted,
    LinkedUnreachable,
    ReachableExact,
    LandedEquivalent,
    RevertedOrAbsent,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackReachability {
    pub state: OrgtrackReachabilityState,
    pub checked_at_head: Option<String>,
    pub is_reachable_from_current_head: Option<bool>,
    pub is_reachable_from_default_branch: Option<bool>,
    pub first_reachable_commit_sha: Option<String>,
    pub current_file_contains_attributed_range: Option<String>,
}

impl Default for OrgtrackReachability {
    fn default() -> Self {
        Self {
            state: OrgtrackReachabilityState::Unknown,
            checked_at_head: None,
            is_reachable_from_current_head: None,
            is_reachable_from_default_branch: None,
            first_reachable_commit_sha: None,
            current_file_contains_attributed_range: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackAgentIdentity {
    pub dispatch_category: Option<String>,
    pub rust_agent_type: Option<String>,
    pub cli_agent_type: Option<String>,
    pub agent_exec_mode: Option<String>,
    pub session_id: String,
    pub display_name: Option<String>,
    pub provider_model_type: Option<String>,
    pub model: Option<String>,
    pub key_source: Option<String>,
    pub origin: Option<String>,
    pub parsed_categories: Vec<OrgtrackParsedCategory>,
}

impl From<AgentMetadata> for OrgtrackAgentIdentity {
    fn from(metadata: AgentMetadata) -> Self {
        Self {
            dispatch_category: metadata.dispatch_category,
            rust_agent_type: metadata.rust_agent_type,
            cli_agent_type: metadata.cli_agent_type,
            agent_exec_mode: metadata.agent_exec_mode,
            session_id: String::new(),
            display_name: metadata.display_name,
            provider_model_type: metadata.provider_model_type,
            model: metadata.model,
            key_source: metadata.key_source,
            origin: metadata.origin,
            parsed_categories: metadata
                .parsed_categories
                .into_iter()
                .map(|(key, value)| OrgtrackParsedCategory {
                    key,
                    value,
                    source: "canonical_metadata".to_string(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackParsedCategory {
    pub key: String,
    pub value: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackExportResult {
    pub repo_path: String,
    pub orgtrack_path: String,
    pub exported_tier: OrgtrackTier,
    pub sessions_written: usize,
    pub files_written: usize,
    pub commits_written: usize,
    pub entries_written: usize,
    pub records_written: usize,
    pub manifest_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackRepairResult {
    pub repo_path: String,
    pub records_read: usize,
    pub duplicates_skipped: usize,
    pub timelines_written: usize,
    pub commits_written: usize,
    pub sessions_written: usize,
    pub manifest_version: u64,
}

impl Default for OrgtrackScanProgress {
    fn default() -> Self {
        Self {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            repo_path: String::new(),
            tier: OrgtrackTier::Meta,
            status: OrgtrackScanStatus::Idle,
            phase: OrgtrackScanPhase::Discover,
            processed: 0,
            total: 0,
            counts: OrgtrackScanCounts::default(),
            last_error: None,
            resumable: false,
            cancel_requested: false,
            started_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
        }
    }
}
