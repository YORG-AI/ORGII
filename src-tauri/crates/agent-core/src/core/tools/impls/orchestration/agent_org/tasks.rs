//! Task-board LLM tools — `task_graph_create`, `task_create`, `task_update`,
//! `task_list`, `task_get` over `AgentOrgTaskStore`.
//!
//! Registration policy (see `init/tool_assembly.rs`):
//! - Available **only** when the session has an `AgentOrgRunContext`
//!   (i.e. it is the coordinator or one of the org members).
//! - Coordinator and members both get the full set, but writes are
//!   authority-checked at the tool boundary: coordinator → anyone;
//!   member → self + direct reports in Soft/Strict; Flat members → self.
//!   Tool availability is not task-administration authority.
//! - Outside an org run the tools are not registered (so plain
//!   single-agent sessions can't accidentally create dangling task
//!   rows).
//!
//! Side effects:
//! - `task_create` and `task_update` (when they set/change `owner`) emit
//!   a `TaskAssigned` row to the new owner's inbox via
//!   `agent_org_tasks::enqueue_task_assigned`. The wake hook fires so
//!   the recipient's session is brought up to drain its inbox.
//! - `task_update` with `status="deleted"` deletes the row instead of
//!   updating it. `deleted` is not a stored status — it is a sentinel
//!   value that means "remove this row from the board" so the LLM
//!   does not need a separate `task_delete` tool.

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    self, eligible_member_ids as task_eligible_member_ids, AgentOrgTaskStore, Task,
    TaskExecutionMode, TaskOutput, TaskStatus, TASK_COMPLETED_IMMUTABLE_ERROR,
    TASK_DEPENDENCY_CYCLE_ERROR, TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE,
    TASK_METADATA_OUTPUT, TASK_METADATA_REQUIRED_ROLE, TASK_MUTATION_CONFLICT_ERROR,
};
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;
use crate::tools::traits::ToolError;

#[path = "task_create.rs"]
pub mod task_create;
#[path = "task_graph_create.rs"]
pub mod task_graph_create;
#[path = "task_list_get.rs"]
pub mod task_list_get;
#[cfg(test)]
#[path = "task_tests.rs"]
mod task_tests;
#[path = "task_update.rs"]
pub mod task_update;

pub use task_create::{TaskCreateParams, TaskCreateTool, TaskDispatchPolicy};
pub use task_graph_create::{TaskGraphCreateParams, TaskGraphCreateTool, TaskGraphNodeParams};
pub use task_list_get::{TaskGetParams, TaskGetTool, TaskListParams, TaskListTool};
pub use task_update::{TaskUpdateParams, TaskUpdateTool};

/// Shared context for the four task tools. Cloned cheaply via `Arc` —
/// every tool stores its own clone so registry slots stay independent.
pub struct TaskToolsContext {
    pub org_context: Arc<AgentOrgRunContext>,
    /// Backing agent definition id of the calling session. This is transport
    /// metadata for legacy inbox columns only; task ownership never resolves
    /// through this value.
    pub caller_agent_id: String,
    /// Stable org roster member id for the calling participant.
    /// This is the task owner identity; agent_id is only the backing
    /// agent definition/template and may be shared by multiple members.
    pub caller_member_id: String,
    /// Best-effort wake hook so the new owner's session is brought up
    /// after a `TaskAssigned` row is persisted. Same hook
    /// `org_send_message` uses; passed in here so tests can inject
    /// the no-op variant.
    pub wake_hook: Arc<dyn InboxWakeHook>,
}

impl TaskToolsContext {
    pub(crate) fn owner_member_id_catalog(&self) -> String {
        let mut entries = vec![format!(
            "{} — {} ({})",
            COORDINATOR_MEMBER_ID,
            self.org_context.coordinator_name,
            self.org_context.coordinator_role
        )];
        entries.extend(
            self.org_context
                .members
                .iter()
                .map(|member| format!("{} — {} ({})", member.member_id, member.name, member.role)),
        );
        entries.join("; ")
    }

    pub(crate) fn authorized_task_target_catalog(&self) -> String {
        let allowed = self
            .org_context
            .allowed_task_target_member_ids_for(&self.caller_member_id);
        let mut entries = Vec::with_capacity(allowed.len());
        for member_id in allowed {
            if member_id == COORDINATOR_MEMBER_ID {
                entries.push(format!(
                    "{} — {} ({})",
                    COORDINATOR_MEMBER_ID,
                    self.org_context.coordinator_name,
                    self.org_context.coordinator_role
                ));
            } else if let Some(member) = self
                .org_context
                .members
                .iter()
                .find(|member| member.member_id == member_id)
            {
                entries.push(format!(
                    "{} — {} ({})",
                    member.member_id, member.name, member.role
                ));
            }
        }
        entries.join("; ")
    }

    pub(crate) fn is_coordinator(&self) -> bool {
        self.caller_member_id == COORDINATOR_MEMBER_ID
    }

    pub(crate) fn task_authority_summary(&self) -> &'static str {
        if self.is_coordinator() {
            "coordinator: may create, assign, reassign, edit, and repair tasks for every participant, but may not impersonate another owner by setting that member's in_progress/completed lifecycle or writing that member's output"
        } else if self
            .org_context
            .direct_report_member_ids_for(&self.caller_member_id)
            .is_empty()
        {
            "worker: may manage only its own tasks and must update its own lifecycle/output"
        } else {
            "manager: may administer its own tasks and direct-report tasks, but may update lifecycle/output only for work it personally owns"
        }
    }

    pub(crate) fn unauthorized_task_target_member_ids(
        &self,
        target_member_ids: &[String],
    ) -> Vec<String> {
        let mut denied = target_member_ids
            .iter()
            .filter(|member_id| {
                !self
                    .org_context
                    .can_assign_task_to(&self.caller_member_id, member_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        denied.sort();
        denied.dedup();
        denied
    }

    pub(crate) fn authorization_denied_response(
        &self,
        action: &str,
        denied_target_member_ids: Vec<String>,
        guidance: &str,
    ) -> Result<String, ToolError> {
        let allowed_target_member_ids = self
            .org_context
            .allowed_task_target_member_ids_for(&self.caller_member_id);
        serde_json::to_string(&json!({
            "authorization_denied": true,
            "action": action,
            "caller_member_id": self.caller_member_id,
            "task_authority": self.task_authority_summary(),
            "denied_target_member_ids": denied_target_member_ids,
            "allowed_target_member_ids": allowed_target_member_ids,
            "guidance": guidance,
        }))
        .map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "failed to serialize task authorization guidance: {err}"
            ))
        })
    }

    pub(crate) fn can_administer_task(&self, task: &Task) -> bool {
        if self.is_coordinator() {
            return true;
        }

        let allowed = self
            .org_context
            .allowed_task_target_member_ids_for(&self.caller_member_id);
        match task.owner.as_deref() {
            Some(owner_member_id) => allowed.iter().any(|member_id| member_id == owner_member_id),
            None => {
                let eligible = task_eligible_member_ids(task);
                !eligible.is_empty()
                    && eligible.iter().all(|eligible_member_id| {
                        allowed
                            .iter()
                            .any(|member_id| member_id == eligible_member_id)
                    })
            }
        }
    }

    pub(crate) fn caller_display_name(&self) -> String {
        self.org_context
            .participant_display_name(&self.caller_member_id)
            .unwrap_or_else(|| self.caller_member_id.clone())
    }

    pub(crate) fn caller_owner_member_id(&self) -> String {
        self.caller_member_id.clone()
    }

    pub(crate) fn resolve_owner_member_id(
        &self,
        raw_owner_member_id: &str,
    ) -> Result<String, String> {
        let owner_member_id = raw_owner_member_id.trim();
        if owner_member_id.is_empty() {
            return Err("owner_member_id must not be empty".to_string());
        }
        if owner_member_id == COORDINATOR_MEMBER_ID {
            return Ok(COORDINATOR_MEMBER_ID.to_string());
        }
        if self
            .org_context
            .members
            .iter()
            .any(|member| member.member_id == owner_member_id)
        {
            return Ok(owner_member_id.to_string());
        }

        let known = self
            .org_context
            .members
            .iter()
            .map(|member| member.member_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "owner_member_id '{owner_member_id}' is not valid for this Agent Org run; use one of: [{}, {}]",
            COORDINATOR_MEMBER_ID, known
        ))
    }

    pub(crate) fn resolve_eligible_member_ids(
        &self,
        raw_member_ids: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let mut resolved = Vec::new();
        for raw_member_id in raw_member_ids {
            let member_id = raw_member_id.trim();
            if member_id.is_empty() {
                continue;
            }
            if member_id == COORDINATOR_MEMBER_ID {
                return Err(
                    "eligible_member_ids cannot include coordinator; use owner_member_id for coordinator-owned work"
                        .to_string(),
                );
            }
            let resolved_member_id = self.resolve_owner_member_id(member_id)?;
            if !resolved
                .iter()
                .any(|existing| existing == &resolved_member_id)
            {
                resolved.push(resolved_member_id);
            }
        }
        Ok(resolved)
    }

    fn recipient_agent_id_for_owner_member_id(
        &self,
        owner_member_id: &str,
    ) -> Result<String, String> {
        self.org_context
            .require_participant_agent_id(owner_member_id)
    }

    pub(crate) fn dispatch_task_assigned(&self, task: &Task) -> bool {
        self.dispatch_task_assigned_with_sender(task, false)
    }

    fn dispatch_task_assigned_as_system(&self, task: &Task) -> bool {
        self.dispatch_task_assigned_with_sender(task, true)
    }

    fn dispatch_task_assigned_with_sender(&self, task: &Task, system_dispatch: bool) -> bool {
        let display = if system_dispatch {
            "Agent Org scheduler".to_string()
        } else {
            self.caller_display_name()
        };
        let caller_owner_member_id = self.caller_owner_member_id();
        let sender_agent_id =
            if system_dispatch || task.owner.as_deref() == Some(caller_owner_member_id.as_str()) {
                SYSTEM_SENDER_ID.to_string()
            } else {
                self.caller_agent_id.clone()
            };
        let sender_member_id = if sender_agent_id == SYSTEM_SENDER_ID {
            None
        } else {
            Some(caller_owner_member_id.as_str())
        };
        if let Some(owner_member_id) = task.owner.as_deref() {
            let recipient_agent_id =
                match self.recipient_agent_id_for_owner_member_id(owner_member_id) {
                    Ok(agent_id) => agent_id,
                    Err(err) => {
                        tracing::warn!(
                            target = "agent_org_tasks",
                            owner_member_id = %owner_member_id,
                            task_id = %task.id,
                            error = %err,
                            "failed to resolve TaskAssigned recipient",
                        );
                        return false;
                    }
                };
            match agent_org_tasks::enqueue_task_assigned_to(
                task,
                &recipient_agent_id,
                owner_member_id,
                &sender_agent_id,
                sender_member_id,
                &display,
            ) {
                Ok(_) => {
                    self.wake_hook
                        .wake_member(owner_member_id, &self.org_context.run_id);
                    true
                }
                Err(err) => {
                    tracing::warn!(
                        target = "agent_org_tasks",
                        owner_member_id = %owner_member_id,
                        task_id = %task.id,
                        error = %err,
                        "failed to enqueue TaskAssigned inbox row",
                    );
                    false
                }
            }
        } else {
            false
        }
    }

    pub(crate) fn dispatch_task_completed(
        &self,
        task: &Task,
        remaining_open_task_count: usize,
    ) -> bool {
        let completed_by_member_id = self.caller_owner_member_id();
        if completed_by_member_id == COORDINATOR_MEMBER_ID {
            return false;
        }
        let output_summary = agent_org_tasks::task_output(task).map(|output| output.summary);
        let message = AgentMessage::TaskCompleted {
            task_id: task.id.clone(),
            subject: task.subject.clone(),
            completed_by_member_id,
            output_summary,
            remaining_open_task_count,
        };
        if let Err(err) = message.validate() {
            tracing::warn!(
                target = "agent_org_tasks",
                task_id = %task.id,
                error = %err,
                "refusing invalid TaskCompleted payload",
            );
            return false;
        }
        match AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: self.org_context.coordinator_agent_id.clone(),
            recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(self.org_context.run_id.clone()),
            message,
        }) {
            Ok(_) => {
                self.wake_hook
                    .wake_member(COORDINATOR_MEMBER_ID, &self.org_context.run_id);
                true
            }
            Err(err) => {
                tracing::warn!(
                    target = "agent_org_tasks",
                    task_id = %task.id,
                    error = %err,
                    "failed to enqueue TaskCompleted coordinator notification",
                );
                false
            }
        }
    }

    pub(crate) fn dispatch_ready_assigned_tasks_unblocked_by(
        &self,
        blocker_task_id: &str,
    ) -> Vec<String> {
        let tasks = match AgentOrgTaskStore::list(&self.org_context.run_id) {
            Ok(tasks) => tasks,
            Err(err) => {
                tracing::warn!(
                    target = "agent_org_tasks",
                    run_id = %self.org_context.run_id,
                    error = %err,
                    "failed to list tasks after dependency completion",
                );
                return Vec::new();
            }
        };
        let mut dispatched = Vec::new();
        for task in &tasks {
            if task.status != TaskStatus::Pending || task.owner.is_none() {
                continue;
            }
            if !task.blocked_by.iter().any(|id| id == blocker_task_id) {
                continue;
            }
            if !task_dependencies_resolved(&tasks, task) {
                continue;
            }
            // The authorized task graph already owns this transition. The
            // member completing an upstream task did not personally assign
            // the downstream owner, so render the wake as a system dispatch
            // rather than implying peer-to-peer managerial authority.
            if self.dispatch_task_assigned_as_system(task) {
                dispatched.push(task.id.clone());
            }
        }
        dispatched
    }
}

pub(crate) fn task_dependencies_resolved(all_tasks: &[Task], task: &Task) -> bool {
    task.blocked_by.iter().all(|blocker_id| {
        all_tasks
            .iter()
            .find(|candidate| &candidate.id == blocker_id)
            .is_some_and(|candidate| candidate.status.is_resolved())
    })
}

pub(crate) fn merge_task_metadata(
    metadata: Option<Value>,
    eligible_member_ids: Option<Vec<String>>,
    required_role: Option<String>,
    execution_mode: Option<TaskExecutionMode>,
    output: Option<TaskOutput>,
) -> Option<Value> {
    let mut object = match metadata {
        Some(Value::Object(object)) => object,
        Some(other) => {
            let mut object = Map::new();
            object.insert("value".to_string(), other);
            object
        }
        None => Map::new(),
    };

    if let Some(eligible_member_ids) = eligible_member_ids {
        object.insert(
            TASK_METADATA_ELIGIBLE_MEMBER_IDS.to_string(),
            json!(eligible_member_ids),
        );
    }
    if let Some(required_role) = required_role {
        let required_role = required_role.trim();
        if required_role.is_empty() {
            object.remove(TASK_METADATA_REQUIRED_ROLE);
        } else {
            object.insert(
                TASK_METADATA_REQUIRED_ROLE.to_string(),
                Value::String(required_role.to_string()),
            );
        }
    }
    if let Some(execution_mode) = execution_mode {
        object.insert(
            TASK_METADATA_EXECUTION_MODE.to_string(),
            Value::String(execution_mode.as_wire().to_string()),
        );
    }
    if let Some(output) = output {
        object.insert(TASK_METADATA_OUTPUT.to_string(), json!(output));
    }

    (!object.is_empty()).then_some(Value::Object(object))
}

pub(crate) fn validate_freeform_task_metadata(metadata: Option<&Value>) -> Result<(), String> {
    let Some(Value::Object(object)) = metadata else {
        return Ok(());
    };
    let reserved: Vec<&str> = [
        TASK_METADATA_ELIGIBLE_MEMBER_IDS,
        TASK_METADATA_REQUIRED_ROLE,
        TASK_METADATA_EXECUTION_MODE,
        TASK_METADATA_OUTPUT,
    ]
    .into_iter()
    .filter(|key| object.contains_key(*key))
    .collect();
    if reserved.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "metadata contains reserved Agent Org task field(s): {}; use the typed parameters instead",
            reserved.join(", ")
        ))
    }
}

pub(crate) fn parse_status(value: &str) -> Result<TaskStatus, String> {
    TaskStatus::from_wire(value).map_err(|err| {
        format!("invalid status: {err} (expected: pending | in_progress | completed)")
    })
}

pub(crate) fn map_task_write_error(err: String) -> ToolError {
    if err.starts_with(TASK_DEPENDENCY_CYCLE_ERROR)
        || err.starts_with(TASK_COMPLETED_IMMUTABLE_ERROR)
        || err.starts_with(TASK_MUTATION_CONFLICT_ERROR)
    {
        ToolError::InvalidParams(err)
    } else {
        ToolError::ExecutionFailed(err)
    }
}

pub(crate) fn task_to_json(task: &Task) -> Value {
    let required_role = task
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_REQUIRED_ROLE))
        .and_then(Value::as_str);
    json!({
        "id": task.id,
        "subject": task.subject,
        "description": task.description,
        "active_form": task.active_form,
        "owner": task.owner,
        "owner_member_id": task.owner,
        "status": task.status.as_wire(),
        "blocks": task.blocks,
        "blocked_by": task.blocked_by,
        "eligible_member_ids": task_eligible_member_ids(task),
        "required_role": required_role,
        "execution_mode": agent_org_tasks::task_execution_mode(task).as_wire(),
        "output": agent_org_tasks::task_output(task),
        "metadata": task.metadata,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    })
}
