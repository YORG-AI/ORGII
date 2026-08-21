//! Agent Org task store: Task schema, persisted to SQLite.
//!
//! Tasks are stored in a single `agent_org_tasks` table scoped by
//! `org_run_id` (one Agent Org run = one team execution).
//!
//! This module exposes the schema, structs, and store CRUD used by the Agent
//! Org task tools and recovery paths. Ownerless tasks are durable
//! "awaiting assignment" rows; workers never claim them autonomously.

use std::collections::{HashMap, HashSet};

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, Result as SqliteResult};

use crate::coordination::agent_org_runs::{
    recovery_dispatch_recipient_is_available, AgentOrgRunStore,
};

mod actor;
pub(super) mod graph;
pub(super) mod helpers;
mod store;
pub(crate) use actor::{SystemArchiveOrRecovery, SystemTaskOperation};
pub use actor::{TaskGraphWriterAdmin, TaskOwnerExecution};
pub(crate) use graph::validate_dependency_graph;
pub use graph::TaskGraphIndex;
pub use store::AgentOrgTaskStore;

#[cfg(test)]
mod pr4_tests;
#[cfg(test)]
mod tests;

pub const TASK_DEPENDENCY_CYCLE_ERROR: &str = "task_dependency_cycle";
pub const TASK_DEPENDENCY_LIMIT_ERROR: &str = "task_dependency_limit";
pub const TASK_RUN_TASK_LIMIT_ERROR: &str = "task_run_task_limit";
pub const TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR: &str = "task_graph_unlisted_open_tasks";
pub const TASK_TERMINAL_IMMUTABLE_ERROR: &str = "task_terminal_immutable";
pub const TASK_COMPLETED_IMMUTABLE_ERROR: &str = TASK_TERMINAL_IMMUTABLE_ERROR;
pub const TASK_MUTATION_CONFLICT_ERROR: &str = "task_mutation_conflict";
pub const TASK_DELETE_HAS_DEPENDENTS_ERROR: &str = "task_delete_has_dependents";
pub const TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR: &str = "task_delete_is_delivery_replacement";
pub const TASK_METADATA_ELIGIBLE_MEMBER_IDS: &str = "eligible_member_ids";
pub const TASK_METADATA_REQUIRED_ROLE: &str = "required_role";
pub(crate) const TASK_METADATA_OUTPUT: &str = "output";
pub(crate) const TASK_METADATA_EXECUTION_MODE: &str = "execution_mode";

/// SQL predicate shared by Quiescence and watchdog repair discovery.
///
/// Historical/manual SQLite rows can bypass the typed write boundary.  Keep
/// this predicate in one place so the Quiescence count and the watchdog's
/// concrete repair identities cannot disagree about whether a row is safe to
/// deserialize.  The numeric values are interpolated from the same payload
/// constants used by new writes.
pub(crate) fn corrupt_task_row_predicate_sql() -> String {
    use crate::coordination::agent_org_payload_limits as limits;

    format!(
        r#"(
            status NOT IN ('pending','in_progress','completed','failed','cancelled')
            OR execution_mode NOT IN ('build','plan')
            OR (owner IS NOT NULL AND (trim(owner)='' OR owner<>trim(owner) OR owner='coordinator'))
            OR (status IN ('in_progress','completed','failed') AND owner IS NULL)
            OR trim(id)='' OR id<>trim(id)
            OR length(id)>{id_chars} OR length(CAST(id AS BLOB))>{id_bytes}
            OR trim(subject)=''
            OR length(subject)>{subject_chars} OR length(CAST(subject AS BLOB))>{subject_bytes}
            OR length(description)>{description_chars} OR length(CAST(description AS BLOB))>{description_bytes}
            OR (active_form IS NOT NULL AND (
                length(active_form)>{active_chars} OR length(CAST(active_form AS BLOB))>{active_bytes}
            ))
            OR trim(created_by_participant_id)=''
            OR trim(source_turn_intent_id)=''
            OR datetime(created_at) IS NULL OR datetime(updated_at) IS NULL
            OR length(CAST(blocked_by_json AS BLOB))>{dependency_json_bytes}
            OR json_valid(blocked_by_json)=0 OR json_type(blocked_by_json)<>'array'
            OR EXISTS (SELECT 1 FROM json_each(blocked_by_json)
                       WHERE type<>'text' OR trim(value)='' OR value<>trim(value))
            OR (metadata_json IS NOT NULL AND (
                length(CAST(metadata_json AS BLOB))>{metadata_bytes}
                OR json_valid(metadata_json)=0 OR json_type(metadata_json)<>'object'
                OR json_type(metadata_json,'$.output') IS NOT NULL
                OR json_type(metadata_json,'$.execution_mode') IS NOT NULL
                OR (json_type(metadata_json,'$.eligible_member_ids') IS NOT NULL
                    AND json_type(metadata_json,'$.eligible_member_ids')<>'array')
                OR EXISTS (
                    SELECT 1 FROM json_each(metadata_json,'$.eligible_member_ids')
                    WHERE type<>'text' OR trim(value)='' OR value<>trim(value)
                       OR length(value)>{id_chars} OR length(CAST(value AS BLOB))>{id_bytes}
                )
                OR (json_type(metadata_json,'$.required_role') IS NOT NULL
                    AND (json_type(metadata_json,'$.required_role')<>'text'
                         OR trim(json_extract(metadata_json,'$.required_role'))=''))
            ))
            OR (output_json IS NOT NULL AND json_valid(output_json)=0)
            OR (failure_reason_json IS NOT NULL AND json_valid(failure_reason_json)=0)
            OR (cancel_reason_json IS NOT NULL AND json_valid(cancel_reason_json)=0)
            OR (output_json IS NOT NULL AND (
                json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.summary') IS NOT 'text'
                OR trim(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.summary'))=''
                OR length(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.summary'))>{output_summary_chars}
                OR length(CAST(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.summary') AS BLOB))>{output_summary_bytes}
                OR (json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.content') IS NOT NULL
                    AND json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.content') NOT IN ('text','null'))
                OR (json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.content')='text'
                    AND (length(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.content'))>{output_content_chars}
                         OR length(CAST(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.content') AS BLOB))>{output_content_bytes}))
                OR json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.artifactIds') IS NOT 'array'
                OR json_array_length(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.artifactIds')>{artifact_count}
                OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.artifactIds')
                           WHERE type<>'text' OR trim(value)='' OR value<>trim(value)
                              OR length(value)>{artifact_chars} OR length(CAST(value AS BLOB))>{artifact_bytes})
                OR (SELECT COALESCE(SUM(length(value)),0) FROM json_each(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.artifactIds'))>{artifact_total_chars}
                OR (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM json_each(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.artifactIds'))>{artifact_total_bytes}
                OR json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedByMemberId') IS NOT 'text'
                OR trim(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedByMemberId'))=''
                OR json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedByMemberId')<>owner
                OR length(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedByMemberId'))>{id_chars}
                OR length(CAST(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedByMemberId') AS BLOB))>{id_bytes}
                OR json_type(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedAt') IS NOT 'text'
                OR instr(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedAt'),'T')=0
                OR datetime(json_extract(CASE WHEN json_valid(output_json)=1 THEN output_json ELSE '{{}}' END,'$.producedAt')) IS NULL
            ))
            OR (failure_reason_json IS NOT NULL AND (
                json_type(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.code') IS NOT 'text'
                OR json_type(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.message') IS NOT 'text'
                OR trim(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.code'))=''
                OR trim(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.message'))=''
                OR length(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.code'))>128
                OR length(CAST(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.code') AS BLOB))>512
                OR length(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.message'))>2000
                OR length(CAST(json_extract(CASE WHEN json_valid(failure_reason_json)=1 THEN failure_reason_json ELSE '{{}}' END,'$.message') AS BLOB))>8000
            ))
            OR (cancel_reason_json IS NOT NULL AND (
                json_type(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.code') IS NOT 'text'
                OR json_type(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.message') IS NOT 'text'
                OR trim(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.code'))=''
                OR trim(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.message'))=''
                OR length(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.code'))>128
                OR length(CAST(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.code') AS BLOB))>512
                OR length(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.message'))>2000
                OR length(CAST(json_extract(CASE WHEN json_valid(cancel_reason_json)=1 THEN cancel_reason_json ELSE '{{}}' END,'$.message') AS BLOB))>8000
            ))
            OR NOT (
                (status IN ('pending','in_progress') AND output_json IS NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NULL)
                OR (status='completed' AND output_json IS NOT NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NULL)
                OR (status='failed' AND output_json IS NULL AND failure_reason_json IS NOT NULL AND cancel_reason_json IS NULL)
                OR (status='cancelled' AND output_json IS NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NOT NULL)
            )
        )"#,
        id_chars = limits::TASK_IDENTIFIER_MAX_CHARS,
        id_bytes = limits::TASK_IDENTIFIER_MAX_BYTES,
        subject_chars = limits::TASK_SUBJECT_MAX_CHARS,
        subject_bytes = limits::TASK_SUBJECT_MAX_BYTES,
        description_chars = limits::TASK_DESCRIPTION_MAX_CHARS,
        description_bytes = limits::TASK_DESCRIPTION_MAX_BYTES,
        active_chars = limits::TASK_ACTIVE_FORM_MAX_CHARS,
        active_bytes = limits::TASK_ACTIVE_FORM_MAX_BYTES,
        metadata_bytes = limits::TASK_METADATA_MAX_BYTES,
        dependency_json_bytes = limits::TASK_DEPENDENCY_JSON_MAX_BYTES,
        output_summary_chars = limits::TASK_OUTPUT_SUMMARY_MAX_CHARS,
        output_summary_bytes = limits::TASK_OUTPUT_SUMMARY_MAX_BYTES,
        output_content_chars = limits::TASK_OUTPUT_CONTENT_MAX_CHARS,
        output_content_bytes = limits::TASK_OUTPUT_CONTENT_MAX_BYTES,
        artifact_count = limits::TASK_ARTIFACT_ID_MAX_COUNT,
        artifact_chars = limits::TASK_ARTIFACT_ID_MAX_CHARS,
        artifact_bytes = limits::TASK_ARTIFACT_ID_MAX_BYTES,
        artifact_total_chars = limits::TASK_ARTIFACT_IDS_TOTAL_MAX_CHARS,
        artifact_total_bytes = limits::TASK_ARTIFACT_IDS_TOTAL_MAX_BYTES,
    )
}

/// Transaction-time scheduling decision for a single Task created through
/// the graph-writer boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskCreateSchedulingPolicy {
    pub allow_parallel_with_unlisted_open_tasks: bool,
}

/// Return every Task reached by following canonical `blocked_by` edges.
pub fn task_dependency_closure(task_ids: &[String], tasks: &[Task]) -> HashSet<String> {
    TaskGraphIndex::new(tasks).dependency_closure(task_ids)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionMode {
    Build,
    Plan,
}

impl TaskExecutionMode {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Plan => "plan",
        }
    }

    pub fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "build" => Ok(Self::Build),
            "plan" => Ok(Self::Plan),
            other => Err(format!(
                "invalid task execution_mode {other:?}; expected build or plan"
            )),
        }
    }
}

pub fn task_execution_mode(task: &Task) -> TaskExecutionMode {
    task.execution_mode
}

/// Durable, task-scoped result used for cross-session handoff.
///
/// A downstream member reads this from the task board instead of trying to
/// dereference another session's chat history or inbox row number.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutput {
    pub summary: String,
    pub content: Option<String>,
    pub artifact_ids: Vec<String>,
    pub produced_by_member_id: String,
    pub produced_at: String,
}

pub fn task_output(task: &Task) -> Option<TaskOutput> {
    task.output.clone()
}

/// Owner-supplied completion payload.  The Store, not the caller, records
/// who produced it and when.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputInput {
    pub summary: String,
    pub content: Option<String>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

/// Bounded machine-readable reason for a failed or cancelled task.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTerminalReason {
    pub code: String,
    pub message: String,
}

/// A quiet Running owner keeps its task; this age only controls when the
/// watchdog asks the coordinator to inspect it. Explicit failure disposition
/// is the only automatic task-release path.
pub const STALE_MEMBER_NOTICE_SECS: i64 = 15 * 60;

pub fn eligible_member_ids(task: &Task) -> Vec<String> {
    task.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_ELIGIBLE_MEMBER_IDS))
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|member_id| !member_id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Single-pass ready-unassigned scan over an already-loaded task list.
///
/// A task needs coordinator assignment when it is `pending`, has no owner, and every
/// `blocked_by` entry resolves to a `completed` task in the same list
/// (a blocker id that does not resolve to a row counts as unresolved,
/// matching [`TaskGraphIndex::is_ready`]).
///
/// Returned in input order (callers load via `list`, which orders by
/// `created_at ASC`) so coordinator-facing repair notices stay deterministic.
///
/// This exists so periodic scanners (watchdog, run-progress wake
/// collection) can answer "which ready tasks still need assignment?" with
/// one task-list load + O(T) memory work — see issue #272.
pub fn ready_unassigned_tasks(tasks: &[Task]) -> Vec<&Task> {
    let graph = TaskGraphIndex::new(tasks);
    tasks
        .iter()
        .filter(|task| task.owner.is_none() && graph.is_ready(task))
        .collect()
}

pub(super) const TASK_EVENT_CREATED: &str = "created";
pub(super) const TASK_EVENT_UPDATED: &str = "updated";
#[cfg(test)]
pub(super) const TASK_EVENT_DELETED: &str = "deleted";
pub(super) const TASK_EVENT_RELEASED: &str = "released";

/// Task status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_wire(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(TaskStatus::Pending),
            "in_progress" => Ok(TaskStatus::InProgress),
            "completed" => Ok(TaskStatus::Completed),
            "failed" => Ok(TaskStatus::Failed),
            "cancelled" => Ok(TaskStatus::Cancelled),
            other => Err(format!("invalid TaskStatus wire value: {other}")),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn is_open(&self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }

    pub fn satisfies_dependency(&self) -> bool {
        matches!(self, Self::Completed)
    }
}

/// Persisted task row.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub org_run_id: String,
    pub subject: String,
    pub description: String,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub status: TaskStatus,
    pub execution_mode: TaskExecutionMode,
    pub blocks: Vec<String>,
    pub blocked_by: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub output: Option<TaskOutput>,
    pub failure_reason: Option<TaskTerminalReason>,
    pub cancel_reason: Option<TaskTerminalReason>,
    pub created_by_participant_id: String,
    pub source_turn_intent_id: String,
    pub originating_message_id: Option<String>,
    pub replaces_task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload-bounded task row for paginated board/list projections.
/// Description is conservatively truncated for board UI; raw metadata and
/// full output content intentionally remain in `task_get`. This DTO can be
/// read directly from SQL without deserializing a fat task board.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub description_truncated: bool,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub status: TaskStatus,
    pub blocks: Vec<String>,
    pub blocks_truncated: bool,
    pub blocked_by: Vec<String>,
    pub blocked_by_truncated: bool,
    pub dependencies_satisfied: bool,
    pub eligible_member_ids: Vec<String>,
    pub eligible_member_ids_truncated: bool,
    pub required_role: Option<String>,
    pub execution_mode: TaskExecutionMode,
    pub output: Option<TaskOutputSummary>,
    pub failure_reason: Option<TaskTerminalReason>,
    pub cancel_reason: Option<TaskTerminalReason>,
    pub replaces_task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputSummary {
    pub summary: String,
    pub artifact_ids: Vec<String>,
    pub artifact_ids_truncated: bool,
    pub produced_by_member_id: Option<String>,
    pub produced_at: Option<String>,
    pub has_content: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummaryPage {
    pub tasks: Vec<TaskSummary>,
    pub filtered_total: usize,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPageBucket {
    Current,
    History,
}

impl TaskPageBucket {
    pub fn accepts(self, status: TaskStatus) -> bool {
        match self {
            Self::Current => status.is_open(),
            Self::History => status.is_terminal(),
        }
    }

    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::History => "history",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPageDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone)]
pub struct TaskMutationOutcome {
    pub previous: Task,
    pub current: Task,
    pub owner_changed: bool,
    pub status_changed: bool,
    pub became_completed: bool,
    pub became_ready: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHistoryEvent {
    pub id: String,
    pub org_run_id: String,
    pub task_id: String,
    pub event_type: String,
    pub previous_owner: Option<String>,
    pub next_owner: Option<String>,
    pub previous_status: Option<TaskStatus>,
    pub next_status: Option<TaskStatus>,
    pub actor_member_id: Option<String>,
    pub actor_kind: String,
    pub source_turn_intent_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskAnnotationKind {
    Progress,
    Evidence,
    AuditNote,
}

impl TaskAnnotationKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::Evidence => "evidence",
            Self::AuditNote => "audit_note",
        }
    }

    pub fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "progress" => Ok(Self::Progress),
            "evidence" => Ok(Self::Evidence),
            "audit_note" => Ok(Self::AuditNote),
            other => Err(format!("invalid TaskAnnotationKind wire value: {other}")),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAnnotation {
    pub id: String,
    pub org_run_id: String,
    pub task_id: String,
    pub kind: TaskAnnotationKind,
    pub body: String,
    pub actor_kind: String,
    pub actor_participant_id: String,
    pub source_turn_intent_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAnnotationPage {
    pub annotations: Vec<TaskAnnotation>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// Inputs for creating a task. `id` is caller-supplied so the LLM tool
/// layer can deterministically generate UUIDs. If you want the store to
/// mint one, call `new_task_id()` first.
#[derive(Debug, Clone)]
#[cfg(test)]
pub struct CreateTaskParams {
    pub id: String,
    pub org_run_id: String,
    pub subject: String,
    pub description: String,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub status: TaskStatus,
    pub blocks: Vec<String>,
    pub blocked_by: Vec<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Canonical graph-writer request.  Creation is always `pending`; provenance
/// is injected from the persisted Coordinator turn context inside the Store.
#[derive(Debug, Clone)]
pub struct CreatePendingTaskParams {
    pub id: String,
    pub org_run_id: String,
    pub subject: String,
    pub description: String,
    pub active_form: Option<String>,
    pub owner: Option<String>,
    pub execution_mode: TaskExecutionMode,
    pub blocked_by: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub originating_message_id: Option<String>,
    pub replaces_task_id: Option<String>,
}

/// Sparse graph-admin patch.  It intentionally contains no lifecycle result
/// fields, so a graph writer cannot accidentally impersonate an Owner.
#[derive(Debug, Clone, Default)]
pub struct PendingTaskGraphPatch {
    pub subject: Option<String>,
    pub description: Option<String>,
    pub active_form: Option<Option<String>>,
    pub owner: Option<Option<String>>,
    pub execution_mode: Option<TaskExecutionMode>,
    pub blocked_by: Option<Vec<String>>,
    pub metadata: Option<Option<serde_json::Value>>,
}

/// Test-only compatibility patch for pre-PR4 Store fixtures. Production
/// code cannot compile this type and must use the typed actor requests.
#[derive(Debug, Clone, Default)]
#[cfg(test)]
pub struct UpdateTaskPatch {
    pub subject: Option<String>,
    pub description: Option<String>,
    pub active_form: Option<Option<String>>,
    pub owner: Option<Option<String>>,
    pub status: Option<TaskStatus>,
    pub blocks: Option<Vec<String>>,
    pub blocked_by: Option<Vec<String>>,
    pub metadata: Option<Option<serde_json::Value>>,
}

pub fn new_task_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Initialize the `agent_org_tasks` table.
///
/// Hot-path indexes:
/// - `(org_run_id, status, owner)` -- bounded status/owner summaries and
///   recovery diagnostics.
/// - `(org_run_id, owner)` -- per-member listings and failure requeue.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    create_schema(conn)
}

pub(crate) fn create_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_tasks (
            id TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            active_form TEXT,
            owner TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','failed','cancelled')),
            execution_mode TEXT NOT NULL CHECK(execution_mode IN ('build','plan')),
            blocked_by_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT,
            output_json TEXT,
            failure_reason_json TEXT,
            cancel_reason_json TEXT,
            created_by_participant_id TEXT NOT NULL CHECK(trim(created_by_participant_id) <> ''),
            source_turn_intent_id TEXT NOT NULL CHECK(trim(source_turn_intent_id) <> ''),
            originating_message_id TEXT,
            replaces_task_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (org_run_id, id),
            FOREIGN KEY (org_run_id, replaces_task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id),
            CHECK(owner IS NULL OR (trim(owner) <> '' AND owner <> 'coordinator')),
            CHECK(replaces_task_id IS NULL OR replaces_task_id <> id),
            CHECK(json_valid(blocked_by_json)=1 AND json_type(blocked_by_json)='array'),
            CHECK(metadata_json IS NULL OR (
                json_valid(metadata_json)=1 AND json_type(metadata_json)='object'
                AND json_type(metadata_json,'$.output') IS NULL
                AND json_type(metadata_json,'$.execution_mode') IS NULL
            )),
            CHECK(output_json IS NULL OR (json_valid(output_json)=1 AND json_type(output_json)='object')),
            CHECK(failure_reason_json IS NULL OR (json_valid(failure_reason_json)=1 AND json_type(failure_reason_json)='object')),
            CHECK(cancel_reason_json IS NULL OR (json_valid(cancel_reason_json)=1 AND json_type(cancel_reason_json)='object')),
            CHECK(status NOT IN ('in_progress','completed','failed') OR owner IS NOT NULL),
            CHECK(
                (status IN ('pending','in_progress') AND output_json IS NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NULL)
                OR (status='completed' AND output_json IS NOT NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NULL)
                OR (status='failed' AND output_json IS NULL AND failure_reason_json IS NOT NULL AND cancel_reason_json IS NULL)
                OR (status='cancelled' AND output_json IS NULL AND failure_reason_json IS NULL AND cancel_reason_json IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_tasks_page
            ON agent_org_runtime_tasks(org_run_id, status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_tasks_owner
            ON agent_org_runtime_tasks(org_run_id, owner, status);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_tasks_replacement
            ON agent_org_runtime_tasks(org_run_id, replaces_task_id);
        CREATE TABLE IF NOT EXISTS agent_org_runtime_task_events (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            previous_owner TEXT,
            next_owner TEXT,
            previous_status TEXT,
            next_status TEXT,
            actor_member_id TEXT,
            actor_kind TEXT NOT NULL CHECK(actor_kind IN ('graph_writer','owner_execution','system')),
            source_turn_intent_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_task_events_run
            ON agent_org_runtime_task_events(org_run_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_task_events_task
            ON agent_org_runtime_task_events(org_run_id, task_id, created_at, id);
        CREATE TABLE IF NOT EXISTS agent_org_runtime_task_annotations (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('progress','evidence','audit_note')),
            body TEXT NOT NULL CHECK(trim(body) <> ''),
            actor_kind TEXT NOT NULL CHECK(actor_kind IN ('graph_writer','owner_execution','system')),
            actor_participant_id TEXT NOT NULL CHECK(trim(actor_participant_id) <> ''),
            source_turn_intent_id TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (org_run_id, task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_task_annotations_page
            ON agent_org_runtime_task_annotations(org_run_id, task_id, created_at, id);",
    )
}

/// Inbox helper: enqueue a `TaskAssigned` payload into the task owner's
/// inbox for the same `org_run_id` as the task itself.
///
/// Producer contract:
///
/// - `recipient_member_id` is the canonical task owner member id and must
///   match `task.owner` exactly.
/// - `recipient_agent_id` is only the delivery address for the current
///   materialized member session.
/// - `sender_member_id` is the caller's canonical member id for LLM/tool
///   producers, or `None` for system recovery/redelivery events.
///
/// Returns the row id of the persisted inbox row. The caller is
/// responsible for waking the recipient via the `InboxWakeHook`; this
/// function is intentionally side-effect-free beyond the insert so it
/// can be reused by the synchronous tool path and watchdog redelivery.
///
/// `assigned_by_display_name` is the human-readable label that ends up
/// in the `<task_assigned assigned_by="...">` attribute. Pass the
/// producer's display name (e.g. "Coordinator", "Alice"), not the
/// agent_id.
pub fn enqueue_task_assigned_to(
    task: &Task,
    recipient_agent_id: &str,
    recipient_member_id: &str,
    sender_agent_id: &str,
    sender_member_id: Option<&str>,
    assigned_by_display_name: &str,
) -> Result<i64, String> {
    let all_tasks = AgentOrgTaskStore::list(&task.org_run_id)?;
    enqueue_task_assigned_to_with_tasks(
        task,
        &all_tasks,
        recipient_agent_id,
        recipient_member_id,
        sender_agent_id,
        sender_member_id,
        assigned_by_display_name,
    )
}

/// Board-aware TaskAssigned producer for callers that already hold a
/// consistent task snapshot. Batch dispatch paths must use this overload so
/// dependency outputs are rendered from one board load instead of issuing an
/// extra `list()` query per task.
pub fn enqueue_task_assigned_to_with_tasks(
    task: &Task,
    all_tasks: &[Task],
    recipient_agent_id: &str,
    recipient_member_id: &str,
    sender_agent_id: &str,
    sender_member_id: Option<&str>,
    assigned_by_display_name: &str,
) -> Result<i64, String> {
    enqueue_task_assigned_to_with_tasks_impl(
        task,
        all_tasks,
        recipient_agent_id,
        recipient_member_id,
        sender_agent_id,
        sender_member_id,
        assigned_by_display_name,
        TaskAssignedInsert::Normal,
    )
}

/// Batch recovery assignments for one member in one writer transaction.
///
/// Assignment actions are already grouped by member. Rechecking the session,
/// task graph, and existing durable deliveries once per member avoids opening
/// one IMMEDIATE transaction and rescanning the whole board for every task.
/// Invalidated tasks are skipped independently; all still-current deliveries
/// commit together.
#[allow(clippy::too_many_arguments)]
pub(crate) fn enqueue_task_assignments_if_still_ready_for_recovery(
    org_run_id: &str,
    task_ids: &[String],
    recipient_agent_id: &str,
    recipient_member_id: &str,
    sender_agent_id: &str,
    sender_member_id: Option<&str>,
    assigned_by_display_name: &str,
) -> Result<Vec<i64>, String> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    with_sessions_writer(|| -> Result<Vec<i64>, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let running: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runtime_runs WHERE id=?1 AND status='running'
                 )",
                params![org_run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if !running {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }

        let sessions =
            AgentOrgRunStore::list_descendant_worker_sessions_with_connection(&tx, org_run_id)?;
        if !recovery_dispatch_recipient_is_available(
            &sessions,
            recipient_member_id,
            recipient_agent_id,
        ) {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }

        let all_tasks = AgentOrgTaskStore::list_with_connection(&tx, org_run_id)?;
        let graph = TaskGraphIndex::new(&all_tasks);
        let requested_task_ids = task_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        let current_tasks = all_tasks
            .iter()
            .filter(|task| requested_task_ids.contains(task.id.as_str()))
            .filter(|task| {
                task.status == TaskStatus::Pending
                    && task.owner.as_deref() == Some(recipient_member_id)
                    && graph.is_ready(task)
            })
            .collect::<Vec<_>>();
        if current_tasks.is_empty() {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }

        // Another producer may have delivered one or more exact assignments
        // after the analyzer snapshot. Load the recipient's unread assignment
        // set once and reuse those durable rows instead of inserting copies.
        let mut existing_stmt = tx
            .prepare(
                "SELECT id,
                        CASE
                            WHEN json_valid(payload_json)
                             AND json_type(payload_json, '$.task_id')='text'
                            THEN json_extract(payload_json, '$.task_id')
                        END
                 FROM agent_org_runtime_inbox INDEXED BY idx_agent_org_runtime_inbox_run_unread_recipient
                 WHERE org_run_id=?1
                   AND recipient_member_id=?2
                   AND payload_kind='task_assigned'
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )
                 ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let existing_rows = existing_stmt
            .query_map(params![org_run_id, recipient_member_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|err| err.to_string())?;
        let mut existing_by_task_id = HashMap::new();
        for row in existing_rows {
            let (row_id, task_id) = row.map_err(|err| err.to_string())?;
            if let Some(task_id) = task_id {
                existing_by_task_id.entry(task_id).or_insert(row_id);
            }
        }
        drop(existing_stmt);

        let mut row_ids = Vec::with_capacity(current_tasks.len());
        for task in current_tasks {
            if let Some(existing_row_id) = existing_by_task_id.get(&task.id) {
                row_ids.push(*existing_row_id);
                continue;
            }
            row_ids.push(enqueue_task_assigned_to_with_tasks_impl(
                task,
                &all_tasks,
                recipient_agent_id,
                recipient_member_id,
                sender_agent_id,
                sender_member_id,
                assigned_by_display_name,
                TaskAssignedInsert::Transaction(&tx),
            )?);
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(row_ids)
    })
}

/// Transaction-aware variant used when a task mutation and its TaskAssigned
/// outbox row must commit together.
#[allow(clippy::too_many_arguments)]
pub(crate) fn enqueue_task_assigned_to_with_tasks_in_tx(
    conn: &rusqlite::Connection,
    task: &Task,
    all_tasks: &[Task],
    recipient_agent_id: &str,
    recipient_member_id: &str,
    sender_agent_id: &str,
    sender_member_id: Option<&str>,
    assigned_by_display_name: &str,
) -> Result<i64, String> {
    enqueue_task_assigned_to_with_tasks_impl(
        task,
        all_tasks,
        recipient_agent_id,
        recipient_member_id,
        sender_agent_id,
        sender_member_id,
        assigned_by_display_name,
        TaskAssignedInsert::Transaction(conn),
    )
}

enum TaskAssignedInsert<'a> {
    Normal,
    Transaction(&'a rusqlite::Connection),
}

#[allow(clippy::too_many_arguments)]
fn enqueue_task_assigned_to_with_tasks_impl<'a>(
    task: &Task,
    all_tasks: &[Task],
    recipient_agent_id: &str,
    recipient_member_id: &str,
    sender_agent_id: &str,
    sender_member_id: Option<&str>,
    assigned_by_display_name: &str,
    insertion: TaskAssignedInsert<'a>,
) -> Result<i64, String> {
    let owner_member_id = task
        .owner
        .as_deref()
        .ok_or_else(|| "enqueue_task_assigned_to called for unowned task".to_string())?;
    if owner_member_id != recipient_member_id {
        return Err(format!(
            "recipient_member_id '{recipient_member_id}' does not match task owner '{owner_member_id}'"
        ));
    }

    let graph = TaskGraphIndex::new(all_tasks);
    let mut remaining_inline_chars = 50_000usize;
    let dependency_outputs = graph
        .blocked_by(&task.id)
        .iter()
        .filter_map(|blocker_id| {
            let blocker = all_tasks
                .iter()
                .find(|candidate| &candidate.id == blocker_id)?;
            let output = task_output(blocker)?;
            let content = output.content.and_then(|content| {
                if remaining_inline_chars == 0 {
                    return None;
                }
                let allowance = remaining_inline_chars.min(20_000);
                let content_chars = content.chars().count();
                let inline = if content_chars <= allowance {
                    content
                } else {
                    const MARKER: &str =
                        "\n[Inline output truncated; call task_get for the full durable output.]";
                    let marker_chars = MARKER.chars().count();
                    if allowance > marker_chars {
                        let mut value = crate::utils::safe_truncate_chars_to_string(
                            &content,
                            allowance - marker_chars,
                        );
                        value.push_str(MARKER);
                        value
                    } else {
                        crate::utils::safe_truncate_chars_to_string(&content, allowance)
                    }
                };
                remaining_inline_chars =
                    remaining_inline_chars.saturating_sub(inline.chars().count());
                Some(inline)
            });
            Some(
                crate::core::coordination::agent_inbox::TaskDependencyOutput {
                    task_id: blocker.id.clone(),
                    subject: blocker.subject.clone(),
                    summary: output.summary,
                    content,
                    artifact_ids: output.artifact_ids,
                    produced_by_member_id: output.produced_by_member_id,
                },
            )
        })
        .collect();

    let subject = crate::utils::safe_truncate_chars_to_string(
        &task.subject,
        crate::coordination::agent_org_payload_limits::TASK_SUBJECT_MAX_CHARS,
    );
    let description = bounded_assignment_description(&task.description);
    let message = crate::core::coordination::agent_inbox::AgentMessage::TaskAssigned {
        task_id: task.id.clone(),
        subject,
        description,
        assigned_by: assigned_by_display_name.to_string(),
        execution_mode: task_execution_mode(task),
        dependency_outputs,
    };
    message.validate()?;

    let params = crate::core::coordination::agent_inbox::InsertInboxParams {
        recipient_agent_id: recipient_agent_id.to_string(),
        recipient_member_id: Some(recipient_member_id.to_string()),
        sender_agent_id: sender_agent_id.to_string(),
        sender_member_id: sender_member_id.map(str::to_string),
        org_run_id: Some(task.org_run_id.clone()),
        message,
    };
    match insertion {
        TaskAssignedInsert::Transaction(conn) => {
            crate::core::coordination::agent_inbox::AgentInboxStore::insert_in_tx(conn, params)
                .map(|row| row.id)
                .map_err(|err| format!("failed to insert TaskAssigned inbox row: {err}"))
        }
        TaskAssignedInsert::Normal => {
            crate::core::coordination::agent_inbox::AgentInboxStore::insert(params)
                .map(|row| row.id)
                .map_err(|err| format!("failed to insert TaskAssigned inbox row: {err}"))
        }
    }
}

fn bounded_assignment_description(description: &str) -> String {
    use crate::coordination::agent_org_payload_limits::TASK_DESCRIPTION_MAX_CHARS;

    if description.chars().count() <= TASK_DESCRIPTION_MAX_CHARS {
        return description.to_string();
    }
    const MARKER: &str =
        "\n[Task description truncated; call task_get for the full durable description.]";
    let marker_chars = MARKER.chars().count();
    if marker_chars >= TASK_DESCRIPTION_MAX_CHARS {
        return crate::utils::safe_truncate_chars_to_string(
            description,
            TASK_DESCRIPTION_MAX_CHARS,
        );
    }
    let mut bounded = crate::utils::safe_truncate_chars_to_string(
        description,
        TASK_DESCRIPTION_MAX_CHARS - marker_chars,
    );
    bounded.push_str(MARKER);
    bounded
}
