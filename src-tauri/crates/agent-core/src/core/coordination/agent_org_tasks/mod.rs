//! Agent Org task store: Task schema, persisted to SQLite.
//!
//! Tasks are stored in a single `agent_org_tasks` table scoped by
//! `org_run_id` (one Agent Org run = one team execution).
//!
//! This module exposes the schema, structs, and store CRUD used by the Agent
//! Org task tools and recovery paths. Ownerless tasks are durable
//! "awaiting assignment" rows; workers never claim them autonomously.

use std::collections::HashSet;

use rusqlite::{Connection, Result as SqliteResult};

pub(super) mod graph;
pub(super) mod helpers;
mod store;
pub use store::AgentOrgTaskStore;

#[cfg(test)]
mod tests;

pub const TASK_DEPENDENCY_CYCLE_ERROR: &str = "task_dependency_cycle";
pub const TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR: &str = "task_graph_unlisted_open_tasks";
pub const TASK_COMPLETED_IMMUTABLE_ERROR: &str = "task_completed_immutable";
pub const TASK_MUTATION_CONFLICT_ERROR: &str = "task_mutation_conflict";
pub const TASK_METADATA_ELIGIBLE_MEMBER_IDS: &str = "eligible_member_ids";
pub const TASK_METADATA_REQUIRED_ROLE: &str = "required_role";
pub const TASK_METADATA_OUTPUT: &str = "output";
pub const TASK_METADATA_EXECUTION_MODE: &str = "execution_mode";

/// Return every task reached by following `blocked_by` links upstream from
/// `task_ids`, including the starting ids. Scheduling guards share this
/// helper so single-task creation, atomic graph creation, and the store's
/// transaction-time recheck agree on what an existing dependency covers.
pub fn task_dependency_closure(task_ids: &[String], tasks: &[Task]) -> HashSet<String> {
    let mut covered = HashSet::new();
    let mut pending = task_ids.to_vec();
    while let Some(task_id) = pending.pop() {
        if !covered.insert(task_id.clone()) {
            continue;
        }
        if let Some(task) = tasks.iter().find(|task| task.id == task_id) {
            pending.extend(task.blocked_by.iter().cloned());
        }
    }
    covered
}

/// Execution mode requested by the task assignment itself.
///
/// This is deliberately task-scoped: a planning task must start its very
/// first provider turn in Plan mode, rather than relying on a separate inbox
/// control message that may only be drained after the mode was selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionMode {
    Build,
    Plan,
}

impl TaskExecutionMode {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Plan => "plan",
        }
    }

    pub fn from_wire(value: &str) -> Result<Self, String> {
        match value.trim() {
            "build" => Ok(Self::Build),
            "plan" => Ok(Self::Plan),
            other => Err(format!(
                "invalid task execution_mode {other:?}; expected build or plan"
            )),
        }
    }
}

/// Historical tasks predate the typed field and retain Build semantics.
pub fn task_execution_mode(task: &Task) -> TaskExecutionMode {
    task.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_EXECUTION_MODE))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| TaskExecutionMode::from_wire(value).ok())
        .unwrap_or(TaskExecutionMode::Build)
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
    task.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_OUTPUT))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
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
/// matching `graph::blockers_resolved`).
///
/// Returned in input order (callers load via `list`, which orders by
/// `created_at ASC`) so coordinator-facing repair notices stay deterministic.
///
/// This exists so periodic scanners (watchdog, run-progress wake
/// collection) can answer "which ready tasks still need assignment?" with
/// one task-list load + O(T) memory work — see issue #272.
pub fn ready_unassigned_tasks(tasks: &[Task]) -> Vec<&Task> {
    let completed_ids: std::collections::HashSet<&str> = tasks
        .iter()
        .filter(|task| task.status.is_resolved())
        .map(|task| task.id.as_str())
        .collect();
    tasks
        .iter()
        .filter(|task| {
            task.owner.is_none()
                && task.status == TaskStatus::Pending
                && task
                    .blocked_by
                    .iter()
                    .all(|blocker_id| completed_ids.contains(blocker_id.as_str()))
        })
        .collect()
}

pub(super) const TASK_EVENT_CREATED: &str = "created";
pub(super) const TASK_EVENT_UPDATED: &str = "updated";
pub(super) const TASK_EVENT_RELEASED: &str = "released";
pub(super) const TASK_EVENT_ESCALATED_TO_COORDINATOR: &str = "escalated_to_coordinator";

/// Task status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl TaskStatus {
    pub fn as_wire(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Completed => "completed",
        }
    }

    pub fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(TaskStatus::Pending),
            "in_progress" => Ok(TaskStatus::InProgress),
            "completed" => Ok(TaskStatus::Completed),
            other => Err(format!("invalid TaskStatus wire value: {other}")),
        }
    }

    /// `completed` is treated as resolved for dependency and finality checks.
    pub fn is_resolved(&self) -> bool {
        matches!(self, TaskStatus::Completed)
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
    pub blocks: Vec<String>,
    pub blocked_by: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
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
    pub created_at: String,
}

/// Inputs for creating a task. `id` is caller-supplied so the LLM tool
/// layer can deterministically generate UUIDs. If you want the store to
/// mint one, call `new_task_id()` first.
#[derive(Debug, Clone)]
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

/// Patch applied by `update`. Every field is `Option`; only `Some(_)`
/// fields are written. `None` keeps the existing value. To clear a
/// nullable column (e.g. unassign owner), use the explicit clear-flag
/// pattern via `UpdateTaskPatch::clear_owner` etc.
#[derive(Debug, Clone, Default)]
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
/// - `(org_run_id, status, owner)` -- `find_available` and unclaimed
///   listings.
/// - `(org_run_id, owner)` -- `unassignTeammateTasks` and per-member
///   listings.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_tasks (
            id TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            active_form TEXT,
            owner TEXT,
            status TEXT NOT NULL,
            blocks_json TEXT NOT NULL DEFAULT '[]',
            blocked_by_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (org_run_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_tasks_status
            ON agent_org_tasks(org_run_id, status, owner);
        CREATE INDEX IF NOT EXISTS idx_agent_org_tasks_owner
            ON agent_org_tasks(org_run_id, owner);
        CREATE TABLE IF NOT EXISTS agent_org_task_events (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            previous_owner TEXT,
            next_owner TEXT,
            previous_status TEXT,
            next_status TEXT,
            actor_member_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_task_events_run
            ON agent_org_task_events(org_run_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_task_events_task
            ON agent_org_task_events(org_run_id, task_id, created_at, id);",
    )?;
    add_column_if_missing(conn, "agent_org_tasks", "active_form", "TEXT")?;
    add_column_if_missing(
        conn,
        "agent_org_tasks",
        "blocks_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        conn,
        "agent_org_tasks",
        "blocked_by_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(conn, "agent_org_tasks", "metadata_json", "TEXT")?;
    add_column_if_missing(conn, "agent_org_task_events", "actor_member_id", "TEXT")?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> SqliteResult<()> {
    let sql = format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(err, Some(message)))
            if err.code == rusqlite::ErrorCode::Unknown
                && message.contains("duplicate column name") =>
        {
            Ok(())
        }
        Err(err) => Err(err),
    }
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
    let owner_member_id = task
        .owner
        .as_deref()
        .ok_or_else(|| "enqueue_task_assigned_to called for unowned task".to_string())?;
    if owner_member_id != recipient_member_id {
        return Err(format!(
            "recipient_member_id '{recipient_member_id}' does not match task owner '{owner_member_id}'"
        ));
    }

    let all_tasks = AgentOrgTaskStore::list(&task.org_run_id)?;
    let mut remaining_inline_chars = 50_000usize;
    let dependency_outputs = task
        .blocked_by
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

    let message = crate::core::coordination::agent_inbox::AgentMessage::TaskAssigned {
        task_id: task.id.clone(),
        subject: task.subject.clone(),
        description: task.description.clone(),
        assigned_by: assigned_by_display_name.to_string(),
        execution_mode: task_execution_mode(task),
        dependency_outputs,
    };
    message.validate()?;

    let row = crate::core::coordination::agent_inbox::AgentInboxStore::insert(
        crate::core::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: recipient_agent_id.to_string(),
            recipient_member_id: Some(recipient_member_id.to_string()),
            sender_agent_id: sender_agent_id.to_string(),
            sender_member_id: sender_member_id.map(str::to_string),
            org_run_id: Some(task.org_run_id.clone()),
            message,
        },
    )
    .map_err(|err| format!("failed to insert TaskAssigned inbox row: {err}"))?;
    Ok(row.id)
}
