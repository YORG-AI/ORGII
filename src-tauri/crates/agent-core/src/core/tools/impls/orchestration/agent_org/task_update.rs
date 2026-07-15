use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_tasks::{
    task_output, AgentOrgTaskStore, Task, TaskOutput, TaskStatus, UpdateTaskPatch,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{
    map_task_write_error, merge_task_metadata, parse_status, task_dependencies_resolved,
    task_to_json, validate_freeform_task_metadata, TaskToolsContext,
};

/// Params for `task_update`. Every mutable field is optional; only
/// fields explicitly set on the request are written. To clear ownership,
/// pass `owner_member_id: null`. Setting `status: "deleted"` deletes the row.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskUpdateParams {
    /// Task UUID to update. Required.
    pub id: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    /// New owner member_id. Use `coordinator`, an exact roster member_id,
    /// or explicit null to unassign. Agent IDs and display names are not accepted.
    #[serde(default)]
    pub owner_member_id: Option<Value>,
    /// New status. One of: `pending`, `in_progress`, `completed`, or the
    /// special sentinel `deleted` (which removes the row).
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub blocks: Option<Vec<String>>,
    #[serde(default)]
    pub blocked_by: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub eligible_member_ids: Option<Vec<String>>,
    #[serde(default)]
    pub required_role: Option<String>,
    /// Durable result produced by the owning member. Required whenever a task
    /// is completed; never put cross-session handoff content in another
    /// session's inbox/thread reference.
    #[serde(default)]
    pub output: Option<TaskOutputParams>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskOutputParams {
    /// Short result summary suitable for coordinator notifications. Required
    /// whenever `output` is supplied.
    pub summary: String,
    /// Full inline result when the handoff is text-sized.
    #[serde(default)]
    pub content: Option<String>,
    /// Durable artifact/file identifiers for large or file-backed results.
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

pub struct TaskUpdateTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskUpdateTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[derive(Debug, Clone, Copy)]
enum TaskUpdateRejectionCode {
    MissingOutputSummary,
    InvalidOutput,
    OutputRequiresCompletion,
    OutputOwnerOnly,
    LifecycleOwnerOnly,
    CompletionRequiresOutput,
}

impl TaskUpdateRejectionCode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::MissingOutputSummary => "missing_output_summary",
            Self::InvalidOutput => "invalid_output",
            Self::OutputRequiresCompletion => "output_requires_completion",
            Self::OutputOwnerOnly => "output_owner_only",
            Self::LifecycleOwnerOnly => "lifecycle_owner_only",
            Self::CompletionRequiresOutput => "completion_requires_output",
        }
    }
}

fn task_update_rejected_response(
    task_id: &str,
    task: Option<&Task>,
    code: TaskUpdateRejectionCode,
    guidance: &str,
    details: Value,
) -> Result<String, ToolError> {
    serde_json::to_string(&json!({
        "rejected": true,
        "rejection_code": code.as_str(),
        "action": "task_update",
        "task_id": task_id,
        "task": task.map(task_to_json),
        "mutation_applied": false,
        "guidance": guidance,
        "details": details,
    }))
    .map_err(|err| {
        ToolError::ExecutionFailed(format!(
            "task_update: failed to serialize rejection guidance: {err}"
        ))
    })
}

fn output_has_missing_or_non_string_summary(params: &Value) -> bool {
    params
        .get("output")
        .and_then(Value::as_object)
        .is_some_and(|output| output.get("summary").and_then(Value::as_str).is_none())
}

#[async_trait]
impl Tool for TaskUpdateTool {
    fn name(&self) -> &str {
        tool_names::TASK_UPDATE
    }

    fn description(&self) -> &str {
        concat!(
            "Update a task on the org run's task board. Only the fields you set are ",
            "written; missing fields keep their current value. Task write authority ",
            "has two separate parts. Administrative authority follows the org structure: ",
            "the coordinator may create, assign, reassign, edit, and repair every task; a ",
            "member may administer its own tasks and, in soft/strict hierarchy modes, tasks ",
            "owned by its direct reports. Work-authorship authority is always owner-only: ",
            "only the current owner may set `status=\"in_progress\"`, set ",
            "`status=\"completed\"`, or write `output`. Assignment or dependency unblocking ",
            "already wakes the owner, so a coordinator/manager must not start or complete ",
            "the owner's task on its behalf. Peer messaging does not grant task authority. ",
            "Special semantics:\n",
            "  - `owner_member_id=null` unassigns the task into an explicit ",
            "    coordinator-assignment state. Set or preserve `eligible_member_ids` ",
            "    so the coordinator can choose a valid replacement; workers do not ",
            "    self-claim ownerless tasks.\n",
            "  - `owner_member_id=\"coordinator\"` or `owner_member_id=\"<member_id>\"` ",
            "    reassigns the task and posts a `task_assigned` inbox row to a pending ",
            "    member owner. Agent IDs and display names are not accepted.\n",
            "  - `eligible_member_ids` sets or repairs the allowed replacement ",
            "    candidates for ownerless tasks. Only the coordinator assigns from that ",
            "    list; `required_role` is display/prompt context only.\n",
            "  - `status=\"deleted\"` removes the row from the board (sentinel value — \n",
            "    `deleted` is not stored; the row is deleted instead).\n",
            "Completed tasks cannot be reopened by setting `status=\"in_progress\"`; ",
            "they also cannot be moved back to `pending`; create a follow-up task instead. ",
            "When you begin an assigned task you own, first set `status=\"in_progress\"`. ",
            "When completing work, always pass `status=\"completed\"` together with ",
            "`output={summary, content?, artifact_ids?}`; `summary` is required. Durable ",
            "output is how the coordinator and downstream members read the result because ",
            "they cannot read your private session history. Use this tool to reassign work ",
            "mid-run, mark your own progress, or retire a task."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour task authority: {}\nAuthorized owner_member_id values for this caller: {}\nUse only `owner_member_id`; do not pass agent_id or display name as ownership. For `eligible_member_ids`, use only worker member_ids from the same authorized catalog except `coordinator`; do not use display names or agent_definition_id.",
            self.description(),
            self.ctx.task_authority_summary(),
            self.ctx.authorized_task_target_catalog()
        ))
    }

    fn parameters(&self) -> Value {
        params_schema::<TaskUpdateParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let task_id_hint = params_value
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if output_has_missing_or_non_string_summary(&params_value) {
            let task = if task_id_hint.is_empty() {
                None
            } else {
                AgentOrgTaskStore::get(&self.ctx.org_context.run_id, &task_id_hint)
                    .map_err(ToolError::ExecutionFailed)?
            };
            return task_update_rejected_response(
                &task_id_hint,
                task.as_ref(),
                TaskUpdateRejectionCode::MissingOutputSummary,
                "Task output needs a non-empty `summary`. Retry task_update with status=completed and output={summary, content?, artifact_ids?}.",
                json!({ "required_field": "output.summary" }),
            );
        }
        let owner_member_id_value = params_value.get("owner_member_id").cloned();
        let params: TaskUpdateParams = parse_params(params_value)?;
        validate_freeform_task_metadata(params.metadata.as_ref())
            .map_err(ToolError::InvalidParams)?;
        let task_id = params.id.trim().to_string();
        if task_id.is_empty() {
            return Err(ToolError::InvalidParams(
                "task_update requires a non-empty `id`".into(),
            ));
        }
        let org_run_id = self.ctx.org_context.run_id.clone();
        let output_requested = params.output.is_some();
        let output_params = params.output;
        let delete_requested = matches!(params.status.as_deref(), Some("deleted"));

        let mut patch = UpdateTaskPatch::default();
        if let Some(subject) = params.subject {
            if subject.trim().is_empty() {
                return Err(ToolError::InvalidParams(
                    "task_update: `subject` cannot be empty".into(),
                ));
            }
            patch.subject = Some(subject);
        }
        if let Some(description) = params.description {
            patch.description = Some(description);
        }
        if let Some(active_form) = params.active_form {
            patch.active_form = Some(if active_form.trim().is_empty() {
                None
            } else {
                Some(active_form)
            });
        }
        if let Some(owner_member_id_value) = owner_member_id_value {
            if owner_member_id_value.is_null() {
                patch.owner = Some(None);
            } else if let Some(owner_member_id) = owner_member_id_value.as_str() {
                let resolved_owner = self
                    .ctx
                    .resolve_owner_member_id(owner_member_id)
                    .map_err(ToolError::InvalidParams)?;
                patch.owner = Some(Some(resolved_owner));
            } else {
                return Err(ToolError::InvalidParams(
                    "task_update: `owner_member_id` must be a string member_id or null".into(),
                ));
            }
        }
        if let Some(status) = params
            .status
            .as_deref()
            .filter(|status| *status != "deleted")
        {
            patch.status = Some(parse_status(status).map_err(ToolError::InvalidParams)?);
        }
        if let Some(blocks) = params.blocks {
            patch.blocks = Some(blocks);
        }
        if let Some(blocked_by) = params.blocked_by {
            patch.blocked_by = Some(blocked_by);
        }
        if let Some(metadata) = params.metadata {
            patch.metadata = Some(Some(metadata));
        }

        // Capture the prior owner so we know whether to dispatch a
        // TaskAssigned row when the patch resolves to a new owner. We
        // do this before applying so we don't have to re-query after.
        let prior = AgentOrgTaskStore::get(&org_run_id, &task_id)
            .map_err(ToolError::ExecutionFailed)?
            .ok_or_else(|| {
                ToolError::ExecutionFailed(format!(
                    "task_update: task '{task_id}' not found in run '{org_run_id}'"
                ))
            })?;
        let prior_owner = prior.owner.clone();
        let caller_member_id = self.ctx.caller_owner_member_id();
        if output_params.is_some() && params.status.as_deref() != Some("completed") {
            return task_update_rejected_response(
                &task_id,
                Some(&prior),
                TaskUpdateRejectionCode::OutputRequiresCompletion,
                "`output` is accepted only when the owning member completes the task. Retry with status=completed, or omit output for a non-completion update.",
                json!({ "required_status": "completed" }),
            );
        }
        let assigning_ownerless_task =
            prior.owner.is_none() && patch.owner.as_ref().is_some_and(|owner| owner.is_some());
        if assigning_ownerless_task && !self.ctx.is_coordinator() {
            return self.ctx.authorization_denied_response(
                "task_update.assign_ownerless",
                patch
                    .owner
                    .as_ref()
                    .and_then(|owner| owner.clone())
                    .into_iter()
                    .collect(),
                "Ownerless means waiting for coordinator assignment. Workers cannot self-claim or assign an ownerless task; ask the coordinator to choose the owner explicitly.",
            );
        }
        if !self.ctx.can_administer_task(&prior) {
            let task_targets = prior
                .owner
                .clone()
                .into_iter()
                .chain(crate::coordination::agent_org_tasks::eligible_member_ids(
                    &prior,
                ))
                .collect::<Vec<_>>();
            let denied = self.ctx.unauthorized_task_target_member_ids(&task_targets);
            return self.ctx.authorization_denied_response(
                if delete_requested {
                    "task_update.delete"
                } else {
                    "task_update.modify"
                },
                denied,
                "You may modify only your own tasks or tasks owned by your direct reports. Ask the coordinator to modify, reassign, or delete peer and cross-branch work.",
            );
        }

        // Sentinel: status = "deleted" deletes only after task-scope
        // authorization. Previously every member with task_update could delete
        // any shared-board row before ownership was even read.
        if delete_requested {
            let removed =
                AgentOrgTaskStore::delete_if_unchanged(&org_run_id, &task_id, &prior.updated_at)
                    .map_err(map_task_write_error)?;
            let body = json!({
                "deleted": removed,
                "id": task_id,
            });
            return serde_json::to_string(&body).map_err(|err| {
                ToolError::ExecutionFailed(format!(
                    "task_update: failed to serialize delete result: {err}"
                ))
            });
        }

        if let Some(Some(owner_member_id)) = patch.owner.as_ref() {
            let denied = self
                .ctx
                .unauthorized_task_target_member_ids(std::slice::from_ref(owner_member_id));
            if !denied.is_empty() {
                return self.ctx.authorization_denied_response(
                    "task_update.reassign_owner",
                    denied,
                    "You may reassign work only to yourself or your direct reports. Ask the coordinator to reassign work to a peer or another branch.",
                );
            }
        }
        if prior.status == TaskStatus::Completed
            && patch
                .status
                .is_some_and(|status| status != TaskStatus::Completed)
        {
            let body = json!({
                "task": task_to_json(&prior),
                "status_ignored": true,
                "guidance": "Completed tasks are immutable. Create a follow-up/revision task and reference this task in blocked_by instead of reopening it.",
            });
            return serde_json::to_string(&body).map_err(|err| {
                ToolError::ExecutionFailed(format!(
                    "task_update: failed to serialize completed-task guidance: {err}"
                ))
            });
        }

        if output_requested && prior_owner.as_deref() != Some(caller_member_id.as_str()) {
            let owner = prior_owner.as_deref().unwrap_or("unowned");
            return task_update_rejected_response(
                &task_id,
                Some(&prior),
                TaskUpdateRejectionCode::OutputOwnerOnly,
                "Only the task owner may submit this task's output. The coordinator or manager may assign and repair the task, but must wait for the owner to report its own result.",
                json!({
                    "caller_member_id": caller_member_id,
                    "owner_member_id": owner,
                }),
            );
        }
        let output = match output_params {
            Some(output) => match validate_task_output(output, &caller_member_id) {
                Ok(output) => Some(output),
                Err(guidance) => {
                    return task_update_rejected_response(
                        &task_id,
                        Some(&prior),
                        TaskUpdateRejectionCode::InvalidOutput,
                        &guidance,
                        json!({ "field": "output" }),
                    );
                }
            },
            None => None,
        };
        if params.eligible_member_ids.is_some()
            || params.required_role.is_some()
            || output.is_some()
        {
            let eligible_member_ids = params
                .eligible_member_ids
                .map(|member_ids| self.ctx.resolve_eligible_member_ids(member_ids))
                .transpose()
                .map_err(ToolError::InvalidParams)?;
            if let Some(member_ids) = eligible_member_ids.as_ref() {
                let denied = self.ctx.unauthorized_task_target_member_ids(member_ids);
                if !denied.is_empty() {
                    return self.ctx.authorization_denied_response(
                        "task_update.set_eligibility",
                        denied,
                        "An ownerless task may list only candidates you are authorized to manage. Ask the coordinator to repair cross-peer and cross-branch eligibility.",
                    );
                }
            }
            let base_metadata = patch.metadata.take().flatten().or(prior.metadata.clone());
            patch.metadata = Some(merge_task_metadata(
                base_metadata,
                eligible_member_ids,
                params.required_role,
                None,
                output,
            ));
        }
        let effective_owner = patch.owner.clone().unwrap_or_else(|| prior.owner.clone());
        let effective_status = patch.status.unwrap_or(prior.status);
        let effective_metadata = patch
            .metadata
            .as_ref()
            .and_then(|value| value.as_ref())
            .or(prior.metadata.as_ref());
        let effective_eligible_member_ids = effective_metadata
            .and_then(|metadata| {
                metadata
                    .get(crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS)
            })
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|member_id| !member_id.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if effective_owner.is_none() {
            let denied = self
                .ctx
                .unauthorized_task_target_member_ids(&effective_eligible_member_ids);
            if !denied.is_empty() {
                return self.ctx.authorization_denied_response(
                    "task_update.unassign_for_coordinator_assignment",
                    denied,
                    "Making a task ownerless cannot expand your authority to peers or another branch. Ownerless work waits for the coordinator; ask the coordinator to release or reassign it for those members.",
                );
            }
        }
        if effective_owner.is_none()
            && effective_status == TaskStatus::Pending
            && effective_eligible_member_ids.is_empty()
        {
            return Err(ToolError::InvalidParams(
                "unassigning a pending task requires a non-empty eligible_member_ids list"
                    .to_string(),
            ));
        }
        if patch.status == Some(TaskStatus::InProgress) {
            if prior.status == TaskStatus::Completed {
                return Err(ToolError::InvalidParams(
                    "task_update status=in_progress cannot reopen a completed task; create a new follow-up task or explicitly assign new pending work".to_string(),
                ));
            }
            let target_owner = patch
                .owner
                .as_ref()
                .and_then(|owner| owner.as_ref())
                .or(prior_owner.as_ref());
            match target_owner {
                Some(owner_member_id) if owner_member_id == &caller_member_id => {}
                Some(owner_member_id) => {
                    return task_update_rejected_response(
                        &task_id,
                        Some(&prior),
                        TaskUpdateRejectionCode::LifecycleOwnerOnly,
                        "Only the task owner may mark its work in progress. Assignment and dependency unblocking already wake the owner; wait for that member to record its own start.",
                        json!({
                            "requested_status": "in_progress",
                            "caller_member_id": caller_member_id,
                            "owner_member_id": owner_member_id,
                        }),
                    );
                }
                None => {
                    return task_update_rejected_response(
                        &task_id,
                        Some(&prior),
                        TaskUpdateRejectionCode::LifecycleOwnerOnly,
                        "An ownerless task cannot be marked in progress by the coordinator. Assign it to a member, or let an eligible member claim it and record its own start.",
                        json!({
                            "requested_status": "in_progress",
                            "caller_member_id": caller_member_id,
                            "owner_member_id": Value::Null,
                        }),
                    );
                }
            }
        }

        if patch.status == Some(TaskStatus::Completed) && prior.status != TaskStatus::Completed {
            let target_owner = patch
                .owner
                .as_ref()
                .and_then(|owner| owner.as_ref())
                .or(prior_owner.as_ref());
            if target_owner != Some(&caller_member_id) {
                let owner = target_owner.map(String::as_str).unwrap_or("unowned");
                return task_update_rejected_response(
                    &task_id,
                    Some(&prior),
                    TaskUpdateRejectionCode::LifecycleOwnerOnly,
                    "Only the task owner may complete its work. The coordinator or manager may reassign or repair the task, but must not certify another member's result.",
                    json!({
                        "requested_status": "completed",
                        "caller_member_id": caller_member_id,
                        "owner_member_id": owner,
                    }),
                );
            }

            let effective_output = patch
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.as_ref())
                .and_then(|metadata| {
                    metadata.get(crate::coordination::agent_org_tasks::TASK_METADATA_OUTPUT)
                })
                .cloned()
                .and_then(|value| serde_json::from_value::<TaskOutput>(value).ok())
                .or_else(|| task_output(&prior));
            if effective_output.is_none() {
                return task_update_rejected_response(
                    &task_id,
                    Some(&prior),
                    TaskUpdateRejectionCode::CompletionRequiresOutput,
                    "Every completed task needs durable output. Retry task_update with status=completed and output={summary, content?, artifact_ids?}; summary is required so the coordinator and downstream members can understand the result.",
                    json!({ "required_field": "output.summary" }),
                );
            }
        }

        let outcome = AgentOrgTaskStore::update_with_outcome_if_unchanged(
            &org_run_id,
            &task_id,
            &prior.updated_at,
            patch,
        )
        .map_err(map_task_write_error)?;
        let updated = outcome.current;
        let owner_changed = outcome.owner_changed;
        let status_changed = outcome.status_changed;
        let completed_now = outcome.became_completed;
        let became_ready = outcome.became_ready;
        let updated_tasks = AgentOrgTaskStore::list(&self.ctx.org_context.run_id)
            .map_err(ToolError::ExecutionFailed)?;
        let updated_ready = updated.owner.is_some()
            && updated.status == TaskStatus::Pending
            && task_dependencies_resolved(&updated_tasks, &updated);
        let task_assigned_dispatched = updated_ready
            && (owner_changed || became_ready)
            && self.ctx.dispatch_task_assigned(&updated);
        let unblocked_task_assigned_ids = if completed_now {
            self.ctx
                .dispatch_ready_assigned_tasks_unblocked_by(&updated.id)
        } else {
            Vec::new()
        };
        let assignment_required_task_ids: Vec<String> = updated_tasks
            .iter()
            .filter(|task| task.owner.is_none() && !task.status.is_resolved())
            .map(|task| task.id.clone())
            .collect();
        let has_assignment_required = !assignment_required_task_ids.is_empty();
        let remaining_open_task_count = updated_tasks
            .iter()
            .filter(|task| !task.status.is_resolved())
            .count();
        let task_completed_notified = completed_now
            && self
                .ctx
                .dispatch_task_completed(&updated, remaining_open_task_count);

        let body = json!({
            "task": task_to_json(&updated),
            "owner_changed": owner_changed,
            "status_changed": status_changed,
            "task_assigned_dispatched": task_assigned_dispatched,
            "assignment_required_task_ids": assignment_required_task_ids,
            "guidance": has_assignment_required.then_some("Ownerless tasks are waiting for explicit coordinator assignment. No worker will self-claim or be woken."),
            "unblocked_task_assigned_ids": unblocked_task_assigned_ids,
            "task_completed_notified": task_completed_notified,
            "remaining_open_task_count": remaining_open_task_count,
        });
        serde_json::to_string(&body).map_err(|err| {
            ToolError::ExecutionFailed(format!("task_update: failed to serialize result: {err}"))
        })
    }

    fn is_read_only(&self) -> bool {
        false
    }
}

fn validate_task_output(
    output: TaskOutputParams,
    produced_by_member_id: &str,
) -> Result<TaskOutput, String> {
    let summary = output.summary.trim();
    if summary.is_empty() {
        return Err(
            "Task output needs a non-empty `summary`. Briefly state what was delivered and retry."
                .to_string(),
        );
    }
    if summary.chars().count() > 1_000 {
        return Err(
            "Task output `summary` must be 1000 characters or fewer; shorten it and retry."
                .to_string(),
        );
    }
    let content = output
        .content
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty());
    if content
        .as_ref()
        .is_some_and(|content| content.chars().count() > 20_000)
    {
        return Err(
            "Task output `content` must be 20000 characters or fewer; store larger results as artifacts and reference their ids instead."
                .to_string(),
        );
    }
    let mut artifact_ids = Vec::new();
    for artifact_id in output.artifact_ids {
        let artifact_id = artifact_id.trim();
        if artifact_id.is_empty() {
            continue;
        }
        if artifact_id.chars().count() > 1_000 {
            return Err(
                "Each task output `artifact_ids` entry must be 1000 characters or fewer."
                    .to_string(),
            );
        }
        if !artifact_ids.iter().any(|existing| existing == artifact_id) {
            artifact_ids.push(artifact_id.to_string());
        }
    }
    Ok(TaskOutput {
        summary: summary.to_string(),
        content,
        artifact_ids,
        produced_by_member_id: produced_by_member_id.to_string(),
        produced_at: chrono::Utc::now().to_rfc3339(),
    })
}
