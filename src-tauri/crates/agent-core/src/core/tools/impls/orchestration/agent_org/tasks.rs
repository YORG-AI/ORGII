//! Task-board LLM tools — `task_graph_create`, `task_create`, `task_update`,
//! `task_list`, `task_get` over `AgentOrgTaskStore`.
//!
//! Registration policy (see `init/tool_assembly.rs`):
//! - Available **only** when the session has an `AgentOrgRunContext`
//!   (i.e. it is the coordinator or one of the org members).
//! - Tool availability is broader than mutation authority. The Task Store
//!   validates a persisted Coordinator turn for graph operations and a
//!   persisted Owner TaskExecution turn for lifecycle operations.
//! - Outside an org run the tools are not registered (so plain
//!   single-agent sessions can't accidentally create dangling task
//!   rows).
//!
//! Side effects:
//! - `task_create` and `task_update` (when they set/change `owner`) emit
//!   a `TaskAssigned` row to the new owner's inbox via
//!   `agent_org_tasks::enqueue_task_assigned`. The wake hook fires so
//!   the recipient's session is brought up to drain its inbox.
//! - `task_update` accepts an explicit tagged operation. No operation can mix
//!   graph-admin fields with Owner lifecycle fields, and no delete sentinel
//!   exists in the formal Task lifecycle.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    self, eligible_member_ids as task_eligible_member_ids, Task, TaskMutationOutcome, TaskStatus,
    TaskSummary, TASK_COMPLETED_IMMUTABLE_ERROR, TASK_DELETE_HAS_DEPENDENTS_ERROR,
    TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR, TASK_DEPENDENCY_CYCLE_ERROR,
    TASK_DEPENDENCY_LIMIT_ERROR, TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_REQUIRED_ROLE,
    TASK_MUTATION_CONFLICT_ERROR, TASK_RUN_TASK_LIMIT_ERROR,
};
use crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;
use crate::tools::traits::ToolError;

#[cfg(test)]
#[path = "assignment_observation_tests.rs"]
mod assignment_observation_tests;
#[path = "inbox_repair.rs"]
pub mod inbox_repair;
#[path = "run_complete.rs"]
pub mod run_complete;
#[path = "task_create.rs"]
pub mod task_create;
#[cfg(test)]
#[path = "task_formal_receipt_tests.rs"]
mod task_formal_receipt_tests;
#[path = "task_graph_create.rs"]
pub mod task_graph_create;
#[path = "task_list_get.rs"]
pub mod task_list_get;
#[cfg(test)]
#[path = "task_tests.rs"]
mod task_tests;
#[path = "task_update.rs"]
pub mod task_update;

pub use inbox_repair::{OrgInboxRepairParams, OrgInboxRepairTool};
pub use run_complete::{OrgRunCompleteParams, OrgRunCompleteTool};
pub use task_create::{TaskCreateParams, TaskCreateTool, TaskDispatchPolicy};
pub use task_graph_create::{TaskGraphCreateParams, TaskGraphCreateTool, TaskGraphNodeParams};
pub use task_list_get::{TaskGetParams, TaskGetTool, TaskListParams, TaskListTool};
pub use task_update::{TaskUpdateParams, TaskUpdateTool};

/// Shared context for Agent Org task, run-completion, and inbox-repair tools.
/// Cloned cheaply via `Arc` — every tool stores its own clone so registry
/// slots stay independent.
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
    /// Live session registry used only to drain an already-committed exact
    /// TaskExecution handoff. Isolated fixtures omit it and therefore persist
    /// `unknown` instead of dispatching a replacement without proof.
    pub app_state: Option<crate::state::AgentAppState>,
}

/// Durable task side effects written in the same transaction as their board
/// mutation. Only the wake list is acted on after commit; losing a wake is
/// recoverable because the inbox rows remain the durable source of truth.
#[derive(Debug, Default)]
pub(crate) struct TaskOutboxCommit {
    pub(crate) task_assigned_ids: Vec<String>,
    pub(crate) unblocked_task_assigned_ids: Vec<String>,
    pub(crate) task_completed_notified: bool,
    pub(crate) task_terminal_notified: bool,
    pub(crate) coordinator_observation_required: bool,
    pub(crate) remaining_open_task_count: usize,
    pub(crate) assignment_required_task_ids: Vec<String>,
    wake_member_ids: Vec<String>,
    pub(crate) execution_handoff:
        Option<crate::coordination::agent_org_task_handoffs::TaskExecutionHandoffReceipt>,
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

    pub(crate) fn is_task_graph_writer(&self) -> bool {
        self.is_coordinator()
            || self
                .org_context
                .capability_index
                .is_additional_writer(&self.caller_member_id)
    }

    pub(crate) fn task_authority_summary(&self) -> &'static str {
        if self.is_coordinator() {
            "coordinator: may create, assign, reassign, edit, and repair tasks for every participant, but may not impersonate another owner by setting that member's in_progress/completed lifecycle or writing that member's output"
        } else if self.is_task_graph_writer() {
            "writer task owner: during the exact persisted TaskExecution turn, may manage graph fields for every participant and may execute only the lifecycle of the Task bound to this turn"
        } else {
            "worker: may only start, annotate, complete, or fail the exact Task bound to its persisted TaskExecution turn"
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
            return Err("Coordinator cannot be a formal Task Owner".to_string());
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
            "owner_member_id '{owner_member_id}' is not valid for this Agent Org run; use one of: [{known}] (Coordinator cannot own a formal Task)"
        ))
    }

    pub(crate) fn resolve_eligible_member_ids(
        &self,
        raw_member_ids: Vec<String>,
    ) -> Result<Vec<String>, String> {
        crate::coordination::agent_org_payload_limits::validate_task_eligible_member_ids(
            "eligible_member_ids",
            &raw_member_ids,
        )?;
        let mut resolved = Vec::new();
        for raw_member_id in raw_member_ids {
            let member_id = raw_member_id.trim();
            if member_id.is_empty() {
                continue;
            }
            if member_id == COORDINATOR_MEMBER_ID {
                return Err(
                    "eligible_member_ids cannot include coordinator; Coordinator cannot own or execute formal Task work"
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

    pub(crate) fn persist_created_tasks_outbox_in_tx(
        &self,
        conn: &rusqlite::Connection,
        created_tasks: &[Task],
        all_tasks: &[Task],
        source_turn_intent_id: Option<&str>,
    ) -> Result<TaskOutboxCommit, String> {
        let graph = agent_org_tasks::TaskGraphIndex::new(all_tasks);
        let mut outbox = TaskOutboxCommit {
            remaining_open_task_count: all_tasks
                .iter()
                .filter(|task| task.status.is_open())
                .count(),
            assignment_required_task_ids: all_tasks
                .iter()
                .filter(|task| task.owner.is_none() && task.status.is_open())
                .map(|task| task.id.clone())
                .collect(),
            ..TaskOutboxCommit::default()
        };
        for task in created_tasks {
            if task.status != TaskStatus::Pending || task.owner.is_none() || !graph.is_ready(task) {
                continue;
            }
            self.persist_task_assigned_in_tx(
                conn,
                task,
                all_tasks,
                false,
                source_turn_intent_id,
                &mut outbox,
            )?;
            outbox.task_assigned_ids.push(task.id.clone());
        }
        Ok(outbox)
    }

    pub(crate) fn persist_task_update_outbox_in_tx(
        &self,
        conn: &rusqlite::Connection,
        outcome: &TaskMutationOutcome,
        all_tasks: &[Task],
        source_turn_intent_id: Option<&str>,
    ) -> Result<TaskOutboxCommit, String> {
        let mut outbox = TaskOutboxCommit {
            remaining_open_task_count: all_tasks
                .iter()
                .filter(|task| task.status.is_open())
                .count(),
            assignment_required_task_ids: all_tasks
                .iter()
                .filter(|task| task.owner.is_none() && task.status.is_open())
                .map(|task| task.id.clone())
                .collect(),
            ..TaskOutboxCommit::default()
        };
        let updated = &outcome.current;
        let graph = agent_org_tasks::TaskGraphIndex::new(all_tasks);
        let updated_ready = updated.status == TaskStatus::Pending
            && updated.owner.is_some()
            && graph.is_ready(updated);
        if updated_ready && (outcome.owner_changed || outcome.became_ready) {
            self.persist_task_assigned_in_tx(
                conn,
                updated,
                all_tasks,
                false,
                source_turn_intent_id,
                &mut outbox,
            )?;
            outbox.task_assigned_ids.push(updated.id.clone());
        }

        if outcome.became_completed {
            for task in all_tasks {
                if task.status != TaskStatus::Pending || task.owner.is_none() {
                    continue;
                }
                // `TaskGraphIndex` derives reverse edges from canonical
                // downstream `blocked_by` rows, so readiness and dispatch use
                // one persisted dependency direction.
                if !graph.blocked_by(&task.id).contains(&updated.id) || !graph.is_ready(task) {
                    continue;
                }
                self.persist_task_assigned_in_tx(
                    conn,
                    task,
                    all_tasks,
                    true,
                    source_turn_intent_id,
                    &mut outbox,
                )?;
                outbox.unblocked_task_assigned_ids.push(task.id.clone());
            }
            outbox.task_completed_notified = self.persist_task_completed_in_tx(
                conn,
                updated,
                outbox.remaining_open_task_count,
                source_turn_intent_id,
            )?;
        } else if outcome.status_changed
            && matches!(updated.status, TaskStatus::Failed | TaskStatus::Cancelled)
        {
            outbox.task_terminal_notified = self.persist_task_terminal_in_tx(
                conn,
                updated,
                outbox.remaining_open_task_count,
                source_turn_intent_id,
            )?;
        }
        Ok(outbox)
    }

    fn persist_task_assigned_in_tx(
        &self,
        conn: &rusqlite::Connection,
        task: &Task,
        tasks: &[Task],
        system_dispatch: bool,
        source_turn_intent_id: Option<&str>,
        outbox: &mut TaskOutboxCommit,
    ) -> Result<(), String> {
        let owner_member_id = task
            .owner
            .as_deref()
            .ok_or_else(|| format!("ready task {} has no owner", task.id))?;
        let recipient_agent_id = self.recipient_agent_id_for_owner_member_id(owner_member_id)?;
        let display = if system_dispatch {
            "Agent Org scheduler".to_string()
        } else {
            self.caller_display_name()
        };
        let caller_owner_member_id = self.caller_owner_member_id();
        let sender_agent_id =
            if system_dispatch || owner_member_id == caller_owner_member_id.as_str() {
                SYSTEM_SENDER_ID.to_string()
            } else {
                self.caller_agent_id.clone()
            };
        let sender_member_id =
            (sender_agent_id != SYSTEM_SENDER_ID).then_some(caller_owner_member_id.as_str());
        let coordinator_observation_required =
            assignment_requires_coordinator_observation(sender_member_id, source_turn_intent_id);
        agent_org_tasks::enqueue_task_assigned_to_with_tasks_in_tx(
            conn,
            task,
            tasks,
            &recipient_agent_id,
            owner_member_id,
            &sender_agent_id,
            sender_member_id,
            &display,
            source_turn_intent_id,
        )?;
        outbox.coordinator_observation_required |= coordinator_observation_required;
        outbox.wake_member_ids.push(owner_member_id.to_string());
        Ok(())
    }

    fn persist_task_completed_in_tx(
        &self,
        conn: &rusqlite::Connection,
        task: &Task,
        remaining_open_task_count: usize,
        source_turn_intent_id: Option<&str>,
    ) -> Result<bool, String> {
        let completed_by_member_id = self.caller_owner_member_id();
        if completed_by_member_id == COORDINATOR_MEMBER_ID {
            return Ok(false);
        }
        let output = task
            .output
            .as_ref()
            .ok_or_else(|| format!("completed Task {} has no TaskOutput", task.id))?;
        let output_digest = agent_org_tasks::task_output_digest(output)?;
        let message = AgentMessage::TaskCompleted {
            task_id: task.id.clone(),
            subject: task.subject.clone(),
            completed_by_member_id: completed_by_member_id.clone(),
            output_summary: Some(output.summary.clone()),
            plan_revision_id: output.plan_revision_id.clone(),
            remaining_open_task_count,
        };
        message.validate()?;
        let record = AgentInboxStore::insert_in_tx_without_formal_trigger(
            conn,
            InsertInboxParams {
                recipient_agent_id: self.org_context.coordinator_agent_id.clone(),
                recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: Some(completed_by_member_id.clone()),
                org_run_id: Some(self.org_context.run_id.clone()),
                message,
            },
        )?;
        crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
            conn,
            &self.org_context.run_id,
            record.id,
            crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                source_kind: if output.plan_revision_id.is_some() {
                    "plan_decision"
                } else {
                    "task_output"
                },
                task_id: Some(&task.id),
                owner_member_id: Some(&completed_by_member_id),
                source_turn_intent_id,
                task_output_digest: Some(&output_digest),
                plan_revision_id: output.plan_revision_id.as_deref(),
                suppress_self_wake: false,
            },
        )?;
        Ok(true)
    }

    fn persist_task_terminal_in_tx(
        &self,
        conn: &rusqlite::Connection,
        task: &Task,
        remaining_open_task_count: usize,
        source_turn_intent_id: Option<&str>,
    ) -> Result<bool, String> {
        let terminal_by_member_id = self.caller_owner_member_id();
        let (terminal_status, reason, source_kind) = match task.status {
            TaskStatus::Failed => (
                crate::coordination::agent_inbox::TaskTerminalStatus::Failed,
                task.failure_reason.as_ref(),
                "task_failure",
            ),
            TaskStatus::Cancelled => (
                crate::coordination::agent_inbox::TaskTerminalStatus::Cancelled,
                task.cancel_reason.as_ref(),
                "task_cancellation",
            ),
            _ => return Ok(false),
        };
        let reason = reason
            .ok_or_else(|| format!("terminal Task {} is missing its typed reason", task.id))?;
        let message = AgentMessage::TaskTerminal {
            task_id: task.id.clone(),
            subject: task.subject.clone(),
            terminal_status,
            terminal_by_member_id: terminal_by_member_id.clone(),
            reason_code: reason.code.clone(),
            reason_message: reason.message.clone(),
            remaining_open_task_count,
        };
        message.validate()?;
        let suppress_self_wake = agent_org_tasks::task_assignment_is_observed_by_coordinator(
            Some(&terminal_by_member_id),
            source_turn_intent_id,
        );
        let record = AgentInboxStore::insert_in_tx_without_formal_trigger(
            conn,
            InsertInboxParams {
                recipient_agent_id: self.org_context.coordinator_agent_id.clone(),
                recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                sender_member_id: Some(terminal_by_member_id.clone()),
                org_run_id: Some(self.org_context.run_id.clone()),
                message,
            },
        )?;
        crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
            conn,
            &self.org_context.run_id,
            record.id,
            crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                source_kind,
                task_id: Some(&task.id),
                owner_member_id: Some(&terminal_by_member_id),
                source_turn_intent_id,
                task_output_digest: None,
                plan_revision_id: None,
                suppress_self_wake,
            },
        )?;
        if suppress_self_wake {
            conn.execute(
                "UPDATE agent_org_runtime_inbox SET read_at=?2 WHERE id=?1 AND read_at IS NULL",
                rusqlite::params![record.id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(!suppress_self_wake)
    }

    pub(crate) fn wake_committed_task_outbox(&self, outbox: &TaskOutboxCommit) {
        for member_id in committed_task_outbox_wake_member_ids(outbox) {
            self.wake_hook
                .wake_member(member_id, &self.org_context.run_id);
        }
    }
}

fn assignment_requires_coordinator_observation(
    sender_member_id: Option<&str>,
    source_turn_intent_id: Option<&str>,
) -> bool {
    !agent_org_tasks::task_assignment_is_observed_by_coordinator(
        sender_member_id,
        source_turn_intent_id,
    )
}

fn committed_task_outbox_wake_member_ids(outbox: &TaskOutboxCommit) -> Vec<&str> {
    let mut seen = HashSet::new();
    outbox
        .wake_member_ids
        .iter()
        .map(String::as_str)
        .chain(
            outbox
                .task_completed_notified
                .then_some(COORDINATOR_MEMBER_ID),
        )
        .chain(
            outbox
                .task_terminal_notified
                .then_some(COORDINATOR_MEMBER_ID),
        )
        .chain(
            outbox
                .coordinator_observation_required
                .then_some(COORDINATOR_MEMBER_ID),
        )
        .filter(|member_id| seen.insert(*member_id))
        .collect()
}

pub(crate) fn task_dependencies_resolved(all_tasks: &[Task], task: &Task) -> bool {
    crate::coordination::agent_org_tasks::TaskGraphIndex::new(all_tasks)
        .unresolved_blockers(&task.id)
        .is_empty()
}

pub(crate) fn merge_task_metadata(
    metadata: Option<Value>,
    eligible_member_ids: Option<Vec<String>>,
    required_role: Option<String>,
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
    (!object.is_empty()).then_some(Value::Object(object))
}

pub(crate) fn validate_freeform_task_metadata(metadata: Option<&Value>) -> Result<(), String> {
    let Some(Value::Object(object)) = metadata else {
        return Ok(());
    };
    let reserved: Vec<&str> = [
        TASK_METADATA_ELIGIBLE_MEMBER_IDS,
        TASK_METADATA_REQUIRED_ROLE,
        "execution_mode",
        "output",
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
        format!(
            "invalid status: {err} (expected: pending | in_progress | completed | failed | cancelled)"
        )
    })
}

pub(crate) fn map_task_write_error(err: String) -> ToolError {
    if err.starts_with(TASK_DEPENDENCY_CYCLE_ERROR)
        || err.starts_with(TASK_COMPLETED_IMMUTABLE_ERROR)
        || err.starts_with(TASK_MUTATION_CONFLICT_ERROR)
        || err.starts_with(TASK_DELETE_HAS_DEPENDENTS_ERROR)
        || err.starts_with(TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR)
        || err.starts_with(TASK_DEPENDENCY_LIMIT_ERROR)
        || err.starts_with(TASK_RUN_TASK_LIMIT_ERROR)
        || err.starts_with("task_not_found")
        || err.starts_with("task_graph_edit_requires_pending")
        || err.starts_with("task_owner_")
        || err.starts_with("task_dependencies_not_completed")
        || err.starts_with("Owner annotations require")
        || err.starts_with("audit_note is available")
    {
        ToolError::InvalidParams(err)
    } else {
        ToolError::ExecutionFailed(err)
    }
}

pub(crate) fn classify_task_receipt_error(
    error: String,
) -> Result<ToolError, AgentOrgToolReceiptAbort> {
    if [
        "agent_org_run_not_mutable",
        "team_archived",
        "agent_org_run_not_found",
        "agent_org_idle_activation_",
        "team_paused_resume_required",
        "task_actor_",
        "task_graph_writer_",
        "task_owner_context_",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
    {
        return Err(AgentOrgToolReceiptAbort::rejected(map_task_write_error(
            error,
        )));
    }
    if [
        "database is locked",
        "database disk image is malformed",
        "disk I/O error",
        "no such table",
        "FOREIGN KEY constraint failed",
    ]
    .iter()
    .any(|fragment| error.contains(fragment))
    {
        return Err(AgentOrgToolReceiptAbort::storage(error));
    }
    Ok(map_task_write_error(error))
}

pub(crate) fn unresolved_episode_creation_response(error: &str) -> Option<Value> {
    let episode_id = error.strip_prefix(
        crate::coordination::agent_org_work_episodes::UNRESOLVED_EPISODE_NEW_MISSION_ERROR,
    )?;
    let episode_id = episode_id.strip_prefix(':').unwrap_or(episode_id);
    Some(json!({
        "created": false,
        "requires_episode_resolution": true,
        "active_work_episode_id": episode_id,
        "guidance": "This user request arrived while the previous work episode is still uncertified. Do not add new-mission Tasks to it. First certify the previous episode if its completed and explicitly user-cancelled scope is valid, or explain the unresolved blocker to the user. Start the new Task graph only after that episode closes."
    }))
}

pub(crate) fn duplicate_task_creation_response(error: &str) -> Option<Value> {
    let task_id = error.strip_prefix(agent_org_tasks::TASK_SAME_TURN_DUPLICATE_ERROR)?;
    let task_id = task_id.strip_prefix(':').unwrap_or(task_id);
    Some(json!({
        "created": false,
        "duplicate_task_in_same_turn": true,
        "conflicting_task_id": task_id,
        "guidance": "This Coordinator Turn already created a Task with the same normalized goal, owner/required role, and execution mode. Do not create a second copy or bypass this guard by renaming a graph key. Use task_update operation=patch_pending on the existing Task if its pending definition needs correction."
    }))
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
        "failure_reason": task.failure_reason,
        "cancel_reason": task.cancel_reason,
        "created_by_participant_id": task.created_by_participant_id,
        "source_turn_intent_id": task.source_turn_intent_id,
        "originating_message_id": task.originating_message_id,
        "replaces_task_id": task.replaces_task_id,
        "metadata": task.metadata.as_ref().and_then(|metadata| {
            let mut metadata = metadata.as_object()?.clone();
            for reserved_key in [
                agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS,
                agent_org_tasks::TASK_METADATA_REQUIRED_ROLE,
            ] {
                metadata.remove(reserved_key);
            }
            (!metadata.is_empty()).then_some(Value::Object(metadata))
        }),
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    })
}

pub(crate) fn compact_task_summary_to_json(task: &TaskSummary) -> Value {
    json!({
        "id": task.id,
        "subject": task.subject,
        "description": task.description,
        "description_truncated": task.description_truncated,
        "active_form": task.active_form,
        "owner": task.owner,
        "owner_member_id": task.owner,
        "status": task.status.as_wire(),
        "blocks": task.blocks,
        "blocks_truncated": task.blocks_truncated,
        "blocked_by": task.blocked_by,
        "blocked_by_truncated": task.blocked_by_truncated,
        "eligible_member_ids": task.eligible_member_ids,
        "eligible_member_ids_truncated": task.eligible_member_ids_truncated,
        "required_role": task.required_role,
        "execution_mode": task.execution_mode.as_wire(),
        "output": task.output,
        "failure_reason": task.failure_reason,
        "cancel_reason": task.cancel_reason,
        "replaces_task_id": task.replaces_task_id,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    })
}
