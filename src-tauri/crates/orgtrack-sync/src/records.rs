use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::approval::{ApprovalState, TrustLevel};
use crate::ids::{EntityId, RecordId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeType {
    Project,
    WorkItem,
    StandaloneContext,
    Session,
    SessionTrajectory,
    Commit,
    PullRequest,
    File,
    Attempt,
    Lesson,
    Validation,
    SyncRecord,
    Turn,
    Checkpoint,
    Artifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphEdgeType {
    Contains,
    LinksTo,
    Produced,
    Modified,
    Explains,
    Supersedes,
    Validates,
    Rejects,
    DerivedLesson,
    RunOf,
    NextTurn,
    ForkedFrom,
    ResumedFrom,
    CompactedTo,
    ValidatedBy,
    CommittedIn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub schema: String,
    pub record_id: RecordId,
    pub entity_id: Option<EntityId>,
    pub approval_state: ApprovalState,
    pub trust_level: TrustLevel,
    pub actor_id: Option<String>,
    pub source_ref: Option<String>,
    pub created_at: String,
    pub payload: SyncRecordPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncRecordPayload {
    Project(ProjectRecord),
    WorkItem(WorkItemRecord),
    SessionEvidence(SessionEvidenceRecord),
    SessionTrajectory(SessionTrajectoryRecord),
    CommitNote(CommitNoteRecord),
    FileNote(FileNoteRecord),
    PullRequest(PullRequestRecord),
    Attempt(AttemptRecord),
    Lesson(LessonRecord),
    Edge(AiBlameEdgeRecord),
    Validation(ValidationRecord),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub project_id: String,
    pub repo_url: Option<String>,
    pub default_branch: Option<String>,
    pub title: String,
    pub revision: String,
    pub base_revision: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRecord {
    pub work_item_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub status: Option<String>,
    pub revision: String,
    pub base_revision: Option<String>,
    pub linked_session_ids: Vec<String>,
    pub linked_commit_shas: Vec<String>,
    pub linked_pull_requests: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvidenceRecord {
    pub session_id: String,
    pub project_id: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_kind: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub final_lines_added: i64,
    pub final_lines_removed: i64,
    pub final_file_count: usize,
    pub linked_commit_shas: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTrajectoryRecord {
    pub trajectory_id: String,
    pub session_id: String,
    pub redaction_version: String,
    pub chunk_count: usize,
    pub chunks: Vec<Value>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNoteRecord {
    pub commit_sha: String,
    pub repo_url: Option<String>,
    pub summary: Option<String>,
    pub linked_session_ids: Vec<String>,
    pub linked_work_item_ids: Vec<String>,
    pub file_paths: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNoteRecord {
    pub repo_url: Option<String>,
    pub file_path: String,
    pub commit_sha: Option<String>,
    pub summary: Option<String>,
    pub linked_session_ids: Vec<String>,
    pub linked_work_item_ids: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestRecord {
    pub provider: String,
    pub repo_url: Option<String>,
    pub pull_request_id: String,
    pub url: String,
    pub title: Option<String>,
    pub linked_commit_shas: Vec<String>,
    pub linked_work_item_ids: Vec<String>,
    pub linked_session_ids: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub work_item_id: Option<String>,
    pub scope: String,
    pub outcome: String,
    pub summary: String,
    pub evidence: Value,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonRecord {
    pub lesson_id: String,
    pub scope: String,
    pub summary: String,
    pub related_file_paths: Vec<String>,
    pub related_attempt_ids: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBlameEdgeRecord {
    pub edge_id: String,
    pub from_node_type: GraphNodeType,
    pub from_stable_key: String,
    pub to_node_type: GraphNodeType,
    pub to_stable_key: String,
    pub edge_type: GraphEdgeType,
    pub confidence: f32,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRecord {
    pub validation_id: String,
    pub target_record_id: RecordId,
    pub approval_state: ApprovalState,
    pub reviewer_id: String,
    pub reason: Option<String>,
    pub metadata: Value,
}
