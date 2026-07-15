//! Extracted rendering data types.
//!
//! Pre-computed structured data for each event type, so the frontend
//! rendering layer does zero parsing at display time.
//!
//! Lives in `core_types` so leaf consumers (`agent_core`, the future
//! extracted `agent-core` crate, and any rendering helper) can reach
//! these envelopes without depending on `agent_sessions::event_pipeline`.

use serde::{Deserialize, Serialize};

/// Envelope for all extracted data. Each variant carries the pre-parsed
/// fields a specific block/panel needs to render. Dispatch on the frontend
/// is driven by the tool's resolved `AppSubtool` — see `event-rendering.mdc`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtractedData {
    Thinking(ExtractedThinkingData),
    File(ExtractedFileData),
    Edit(ExtractedEditData),
    Shell(ExtractedShellData),
    Search(ExtractedSearchData),
    Glob(ExtractedGlobData),
    Todo(ExtractedTodoData),
    Message(ExtractedMessageData),
    ListDir(ExtractedListDirData),
    Await(ExtractedAwaitData),
    WebSearch(ExtractedWebSearchData),
    Subagent(ExtractedSubagentData),
    OrgTask(ExtractedOrgTaskData),
    DeleteFile(ExtractedDeleteFileData),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedThinkingData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFileData {
    pub file_path: String,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_count: Option<usize>,
    /// 1-indexed line number of the first content line, parsed from the
    /// numbered `read_file` output. `None` (or 1) means the read started at
    /// the top of the file. Viewers use this to offset their line gutter so
    /// ranged reads (offset/limit) show real file line numbers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEditData {
    pub file_path: String,
    pub file_name: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_start_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_start_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<usize>,
    /// File was deleted (apply_patch `*** Delete File` segment).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_deleted: bool,
    /// For apply_patch: one entry per `*** Add/Modify/Delete File` section.
    /// When present, renderers should iterate over segments instead of using
    /// the top-level fields.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apply_patch_segments: Vec<ExtractedEditData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedShellData {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kill_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_time: Option<f64>,
    pub is_failure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_pid: Option<i64>,
    /// "running" | "background" | "exited" | "killed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_process_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_artifacts: Option<Vec<ExtractedGitArtifactData>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchMatch {
    pub file: String,
    pub line: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedSearchData {
    pub query: String,
    pub results: Vec<EventSearchMatch>,
    pub total_matches: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub status: String,
    /// Present-continuous label preferred by renderers while the todo is
    /// `in_progress` (e.g. "Running tests"). Serialized as `activeForm`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_form: Option<String>,
    /// Indices of tasks that must complete before this task can start.
    /// Serialized as `blockedBy` (camelCase) to match the frontend `TodoItem`.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub blocked_by: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedTodoData {
    pub todos: Vec<TodoItem>,
    pub was_merge: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedMessageData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub is_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedListDirData {
    pub directory: String,
    pub entries: Vec<DirEntry>,
    /// Raw text when structured entries were not returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedGlobData {
    pub pattern: String,
    pub files: Vec<String>,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAwaitData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_until_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitArtifactKind {
    Commit,
    PullRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedGitArtifactData {
    pub kind: GitArtifactKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedWebSearchData {
    pub query: String,
    pub results: Vec<WebSearchResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedSubagentData {
    pub description: String,
    pub subagent_type: String,
    pub result_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    pub success: bool,
    /// Child session ID for loading nested events from the per-session
    /// EventStore. The frontend uses this to subscribe via
    /// `useSessionEvents(subagentSessionId)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_text: Option<String>,
    /// Full prompt text the LLM passed to the `agent` tool. Shown as a
    /// read-only pinned block at the top of the expanded SubagentBlock so
    /// users can see exactly what the subagent was asked to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Human-readable error message for the failed terminal state. Only
    /// populated when `success` is `false`. Surfaced in the collapsed
    /// subtitle and the expanded body of failed subagent cards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgTaskItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_agent_icon_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_cli_agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
}

/// Finality of an Agent Org task-tool operation.
///
/// This is deliberately separate from [`OrgTaskItem::status`]: the latter is
/// the lifecycle of a task that exists, while this enum describes whether the
/// tool call itself was accepted. A rejected `task_create` can carry attempted
/// task fields for history rendering without pretending that a task exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgTaskOperationOutcome {
    Pending,
    Succeeded,
    Rejected,
    Failed,
    /// Backward-compatible value for persisted extracted payloads created
    /// before operation outcomes were added. New extraction never emits it.
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedOrgTaskData {
    pub action: String,
    #[serde(default)]
    pub outcome: OrgTaskOperationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<OrgTaskItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<OrgTaskItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_assigned_dispatched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedDeleteFileData {
    pub file_path: String,
    pub file_name: String,
}
