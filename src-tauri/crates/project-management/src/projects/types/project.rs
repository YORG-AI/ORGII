//! Project, todos, comments, delegation, context, init, and detection types.

use serde::{Deserialize, Serialize};

use super::config::{LabelsFile, MembersFile};
use super::orchestrator::AgentDefaults;

pub const PERSONAL_ORG_ID: &str = "personal-org";

// ============================================
// Project
// ============================================

/// Project metadata row in `projects.db`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(default = "default_org_id")]
    pub org_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default = "default_health")]
    pub health: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub linked_repos: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Per-project auto-increment counter for work item IDs (starts at 1)
    #[serde(default = "default_next_id")]
    pub next_work_item_id: u32,
    /// 3-char alphanumeric prefix for work item IDs (e.g. "AUT")
    #[serde(default = "default_work_item_prefix")]
    pub work_item_prefix: String,
    /// Whether prefix was manually set by user (true) or auto-derived from name (false)
    #[serde(default = "default_false")]
    pub work_item_prefix_custom: bool,
    /// Project-level defaults for agent workflows (inherited by new work items)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_defaults: Option<AgentDefaults>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOrg {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub org_key: String,
    pub source: String,
    pub sync_provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_config_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_org_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectOrgRequest {
    pub name: String,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigureProjectOrgGitFolderSyncRequest {
    pub org_id: String,
    pub folder_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProjectOrgGitFolderRequest {
    pub org_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveProjectOrgGitFolderConflictRequest {
    pub org_id: String,
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectGitFolderSyncStatus {
    Synced,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectGitFolderConflictKind {
    GitMarker,
    ParseError,
    RecordDiverged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectGitFolderConflictEntityType {
    Org,
    Project,
    WorkItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGitFolderSyncConflict {
    pub id: String,
    pub kind: ProjectGitFolderConflictKind,
    pub entity_type: ProjectGitFolderConflictEntityType,
    pub file_path: String,
    pub relative_path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_short_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProjectOrgGitFolderResult {
    pub org_id: String,
    pub folder_path: String,
    pub status: ProjectGitFolderSyncStatus,
    pub conflicts: Vec<ProjectGitFolderSyncConflict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    pub projects_exported: usize,
    pub projects_imported: usize,
    pub work_items_exported: usize,
    pub work_items_imported: usize,
}

fn default_org_id() -> String {
    PERSONAL_ORG_ID.to_string()
}

fn default_priority() -> String {
    "none".to_string()
}

fn default_health() -> String {
    "no_updates".to_string()
}

fn default_next_id() -> u32 {
    1
}

fn default_work_item_prefix() -> String {
    "STR".to_string()
}

fn default_false() -> bool {
    false
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Combined project data returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectData {
    pub meta: ProjectMeta,
    /// Contents of README.md (may be empty)
    pub description: String,
    /// Folder slug (directory name)
    pub slug: String,
    /// Bound external sync adapter, omitted for local-only projects.
    ///
    /// The list UI needs only the adapter identity. Connection IDs and
    /// adapter configuration remain private to the sync subsystem.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_adapter_id: Option<String>,
}

// ============================================
// Todos (inside work items)
// ============================================

/// A single to-do entry inside a work item's YAML frontmatter
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoEntry {
    pub id: String,
    pub content: String,
    /// "pending" | "in_progress" | "completed"
    #[serde(default = "default_todo_status")]
    pub status: String,
}

fn default_todo_status() -> String {
    "pending".to_string()
}

/// Typed explicit recipient of a Discussion comment. `mentioned_user_ids`
/// stays the member-only compatibility field; routing reads this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MentionTarget {
    Member { id: String },
    Agent { id: String },
    AgentOrg { id: String },
    All,
}

/// A comment on a work item
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CommentEntry {
    pub id: String,
    pub author: String,
    pub content: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentioned_user_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<MentionTarget>,
    /// Replies form a stable thread tree. `thread_id` always names the root;
    /// top-level comments use their own id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub conclusion: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

/// A market delegation entry on a work item
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelegationEntry {
    pub task_id: String,
    pub agent_app_id: String,
    pub agent_app_name: String,
    pub skill_id: String,
    pub status: String,
    pub cost_usd: f64,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

// ============================================
// Init Result
// ============================================

/// Result of resolving the project store workspace context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitResult {
    pub path: String,
    pub created_files: Vec<String>,
}

// ============================================
// Project Context (combined initial load)
// ============================================

/// Combined project context for initial page load.
/// Returns projects, labels, and members in a single IPC call
/// to avoid the frontend making 3 separate requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    /// All projects in the repo
    pub projects: Vec<ProjectData>,
    /// All labels from labels.yaml
    pub labels: LabelsFile,
    /// All members from members.yaml
    pub members: MembersFile,
}

// ============================================
// Detection
// ============================================

/// Whether the project store is available for a repo and its status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub exists: bool,
    pub path: Option<String>,
    pub version: Option<u32>,
    pub work_item_count: usize,
    pub project_count: usize,
}
