use serde::Serialize;

use crate::canonical::{
    ActivityRecord, CommitLinkRecord, FileChangeRecord, FileResourceRecord,
    ResourceInteractionRecord, ScanCheckpoint, SessionActorRecord,
    SessionCheckpointFileStateRecord, SessionCheckpointRecord, SessionDiffChunkRecord,
    SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
};

/// A flattened, privacy-safe view of one recently captured hook interaction,
/// joined with its file resource. Used by the Session Provenance panel's
/// "recent signals" table. Carries only metadata — never file contents or raw
/// tool output (those never enter the interaction store to begin with).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentHookSignal {
    pub source: String,
    pub session_id: String,
    /// Human-readable session title, when the session has been reconciled with
    /// a real name by an importer. `None` for hook-only sessions whose title is
    /// still just the raw source id — the UI falls back to a shortened id.
    pub session_title: Option<String>,
    pub actor_id: Option<String>,
    /// Repository-relative display path of the touched file.
    pub file_path: String,
    pub workspace_path: String,
    /// `read` | `write` | `create` | `delete` | `rename` | `search`.
    pub action: String,
    /// `succeeded` | `failed` | `unknown`.
    pub outcome: String,
    /// RFC3339 timestamp the interaction occurred at.
    pub occurred_at: String,
    /// Always `hook` for this projection; carried for forward-compatibility.
    pub capture_method: String,
}

/// One bounded page of canonical interactions for a file. Pagination happens
/// by root session rather than raw interaction, so a returned session always
/// has complete counts and subagent attribution within that page.
#[derive(Debug, Clone)]
pub struct FileResourceInteractionPage {
    pub interactions: Vec<ResourceInteractionRecord>,
    pub total_sessions: usize,
    pub offset: usize,
    pub limit: usize,
}

pub trait RecordStore {
    fn upsert_session(&self, record: &SessionRecord) -> Result<(), String>;
    fn append_activity(&self, record: &ActivityRecord) -> Result<(), String>;
    fn upsert_file_change(&self, record: &FileChangeRecord) -> Result<(), String>;
    fn upsert_file_resource(&self, record: &FileResourceRecord) -> Result<(), String>;
    fn append_resource_interaction(&self, record: &ResourceInteractionRecord)
        -> Result<(), String>;
    fn upsert_session_actor(&self, record: &SessionActorRecord) -> Result<(), String>;
    fn upsert_commit_link(&self, record: &CommitLinkRecord) -> Result<(), String>;
    fn upsert_edit_artifact(&self, record: &SessionEditArtifactRecord) -> Result<(), String>;
    fn upsert_diff_chunk(&self, record: &SessionDiffChunkRecord) -> Result<(), String>;
    fn upsert_final_diff(&self, record: &SessionFinalDiffRecord) -> Result<(), String>;
    fn upsert_session_checkpoint(&self, record: &SessionCheckpointRecord) -> Result<(), String>;
    fn upsert_checkpoint_file_state(
        &self,
        record: &SessionCheckpointFileStateRecord,
    ) -> Result<(), String>;
    fn delete_session_artifacts(&self, source: &str, session_id: &str) -> Result<(), String>;
    fn delete_session_derived_artifacts(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<(), String>;
    fn list_commit_links(&self) -> Result<Vec<CommitLinkRecord>, String>;
    fn list_commit_links_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<CommitLinkRecord>, String>;
    fn list_edit_artifacts(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionEditArtifactRecord>, String>;
    fn list_diff_chunks(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionDiffChunkRecord>, String>;
    fn list_final_diffs(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionFinalDiffRecord>, String>;
    fn list_session_checkpoints(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionCheckpointRecord>, String>;
    fn list_checkpoint_file_states(
        &self,
        checkpoint_id: &str,
    ) -> Result<Vec<SessionCheckpointFileStateRecord>, String>;
    fn get_checkpoint(&self, source: &str) -> Result<Option<ScanCheckpoint>, String>;
    fn put_checkpoint(&self, checkpoint: &ScanCheckpoint) -> Result<(), String>;
    fn list_sessions(&self, workspace_path: Option<&str>) -> Result<Vec<SessionRecord>, String>;
    fn list_file_changes(
        &self,
        workspace_path: Option<&str>,
    ) -> Result<Vec<FileChangeRecord>, String>;
    fn list_file_resource_interactions_page(
        &self,
        repository_id: Option<&str>,
        workspace_path: &str,
        repo_relative_path: &str,
        limit: usize,
        offset: usize,
    ) -> Result<FileResourceInteractionPage, String>;
    fn get_file_resource_revision(
        &self,
        repository_id: Option<&str>,
        workspace_path: &str,
        repo_relative_path: &str,
    ) -> Result<u64, String>;
    fn get_session(&self, session_id: &str) -> Result<Option<SessionRecord>, String>;
    fn get_session_actor(
        &self,
        source: &str,
        session_id: &str,
        actor_id: &str,
    ) -> Result<Option<SessionActorRecord>, String>;
    fn get_session_actor_by_source_identity(
        &self,
        source: &str,
        source_session_id: &str,
        actor_id: &str,
    ) -> Result<Option<SessionActorRecord>, String>;
    fn list_session_actors(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<Vec<SessionActorRecord>, String>;
    fn get_session_actor_by_transcript_session_id(
        &self,
        source: &str,
        transcript_session_id: &str,
    ) -> Result<Option<SessionActorRecord>, String>;
}

#[cfg(feature = "sqlite")]
pub mod sqlite;
