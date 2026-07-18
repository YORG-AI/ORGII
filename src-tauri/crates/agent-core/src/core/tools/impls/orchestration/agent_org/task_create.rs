use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_payload_limits::{
    validate_task_identifier, validate_task_identifier_list,
};
use crate::coordination::agent_org_tasks::{
    self, task_dependency_closure, AgentOrgTaskStore, CreateTaskParams, TaskCreateSchedulingPolicy,
    TaskExecutionMode, TaskStatus, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{
    map_task_write_error, merge_task_metadata, parse_status, task_to_json,
    validate_freeform_task_metadata, TaskToolsContext,
};

/// Explicit decision about when a newly-created task may be dispatched.
///
/// This is deliberately required at the LLM tool boundary. An omitted
/// `blocked_by` array used to silently mean "run now", which allowed review
/// and test tasks to race ahead of the work whose output they consume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDispatchPolicy {
    /// The task has no upstream input and may be dispatched immediately.
    Immediate,
    /// The task consumes durable output from all listed upstream tasks.
    AfterDependencies,
}

impl TaskDispatchPolicy {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "immediate" => Ok(Self::Immediate),
            "after_dependencies" => Ok(Self::AfterDependencies),
            other => Err(format!(
                "unknown dispatch_policy {other:?}; expected immediate or after_dependencies"
            )),
        }
    }

    fn into_blocked_by(self, task_ids: Vec<String>) -> Result<Vec<String>, String> {
        match self {
            Self::Immediate => {
                if task_ids.iter().any(|task_id| !task_id.trim().is_empty()) {
                    return Err(
                        "dispatch_policy=immediate cannot include dependency_task_ids; choose after_dependencies for consumer work"
                            .to_string(),
                    );
                }
                Ok(Vec::new())
            }
            Self::AfterDependencies => {
                let mut normalized = Vec::new();
                for task_id in task_ids {
                    let task_id = task_id.trim();
                    if task_id.is_empty() {
                        continue;
                    }
                    if !normalized.iter().any(|existing| existing == task_id) {
                        normalized.push(task_id.to_string());
                    }
                }
                if normalized.is_empty() {
                    return Err(
                        "dispatch_policy=after_dependencies requires at least one non-empty dependency_task_id"
                            .to_string(),
                    );
                }
                Ok(normalized)
            }
        }
    }
}

/// Params for `task_create`. `id` is optional — the store mints a
/// UUID if absent so the LLM does not have to.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskCreateParams {
    /// Optional caller-supplied bounded identifier. Defaults to a freshly
    /// minted v4 UUID. Use only when porting an external task or stamping a
    /// deterministic id in tests.
    #[serde(default)]
    pub id: Option<String>,
    /// One-line task title. Required, non-empty.
    pub subject: String,
    /// Optional long-form description. Defaults to empty string.
    #[serde(default)]
    pub description: Option<String>,
    /// Optional present-progressive form ("Refactoring auth layer")
    /// shown by the UI while the task is in_progress.
    #[serde(default)]
    pub active_form: Option<String>,
    /// Optional initial owner member_id. Use `coordinator` for the coordinator
    /// or an exact roster member_id. When set, `task_create` posts a
    /// `TaskAssigned` row to the new owner's inbox if the task is pending.
    #[serde(default)]
    pub owner_member_id: Option<String>,
    /// Optional initial status. Defaults to `pending`. Setting `in_progress`
    /// requires `owner_member_id`; task ownership is never inferred.
    #[serde(default)]
    pub status: Option<String>,
    /// Required dispatch decision. Use `immediate` only for independent work;
    /// use `after_dependencies` for review, test, aggregation, or any task
    /// that consumes another task's output.
    pub dispatch_policy: String,
    /// Required execution mode for the assigned member. Use `plan` only when
    /// the task must produce an explicit plan via `create_plan`; all ordinary
    /// implementation, review, test, research, and writing work uses `build`.
    pub execution_mode: String,
    /// Existing upstream task ids. Required and non-empty when
    /// `dispatch_policy=after_dependencies`; must be empty for `immediate`.
    #[serde(default)]
    pub dependency_task_ids: Vec<String>,
    /// Explicit confirmation that this task may run before other
    /// currently-open tasks not covered by its dependency chain. This is also
    /// required when a Build task intentionally bypasses an open Plan task.
    /// Defaults to false so an accidentally incomplete dependency list is
    /// returned as recoverable guidance instead of being persisted.
    #[serde(default)]
    pub allow_parallel_with_unlisted_open_tasks: bool,
    /// Free-form metadata bag. Stored verbatim.
    #[serde(default)]
    pub metadata: Option<Value>,
    /// Optional hard eligibility list for ownerless tasks. These are valid
    /// candidates for explicit coordinator assignment; eligibility never
    /// authorizes autonomous claim, update, or deletion.
    #[serde(default)]
    pub eligible_member_ids: Option<Vec<String>>,
    /// Optional human-readable role hint for display/prompt context only.
    #[serde(default)]
    pub required_role: Option<String>,
}

pub struct TaskCreateTool {
    ctx: Arc<TaskToolsContext>,
    #[cfg(test)]
    pre_persist_hook: Option<Arc<TaskCreatePrePersistHook>>,
}

/// Deterministic test seam for reproducing a task-board change after the
/// tool's advisory read but before the store starts its commit transaction.
#[cfg(test)]
#[derive(Default)]
pub(super) struct TaskCreatePrePersistHook {
    reached: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

#[cfg(test)]
impl TaskCreatePrePersistHook {
    pub(super) async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    pub(super) fn resume(&self) {
        self.resume.notify_one();
    }

    async fn pause(&self) {
        self.reached.notify_one();
        self.resume.notified().await;
    }
}

impl TaskCreateTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self {
            ctx,
            #[cfg(test)]
            pre_persist_hook: None,
        }
    }

    #[cfg(test)]
    pub(super) fn with_pre_persist_hook(
        ctx: Arc<TaskToolsContext>,
        hook: Arc<TaskCreatePrePersistHook>,
    ) -> Self {
        Self {
            ctx,
            pre_persist_hook: Some(hook),
        }
    }
}

#[async_trait]
impl Tool for TaskCreateTool {
    fn name(&self) -> &str {
        tool_names::TASK_CREATE
    }

    fn description(&self) -> &str {
        concat!(
            "Create a task on the org run's task board. The board is shared by every ",
            "agent in this Agent Org run, but write authority follows the org structure: ",
            "the coordinator may assign any participant; a member may assign itself and, ",
            "in soft/strict hierarchy modes, its direct reports. Peer communication does ",
            "not grant peer task-assignment authority. ",
            "Set `owner_member_id` to `coordinator` or an exact roster member_id for ",
            "direct assignment — a pending assignee will receive a `task_assigned` inbox ",
            "row on their next turn. If you leave `owner_member_id` unset, the task is ",
            "parked as awaiting explicit coordinator assignment and MUST provide ",
            "`eligible_member_ids` with the exact candidate worker member_ids. No worker ",
            "will self-claim or be woken for an ownerless task. ",
            "You MUST choose exactly one `dispatch_policy`: `immediate` only when the ",
            "task can start independently with the information already available, or ",
            "`after_dependencies` plus `dependency_task_ids` with every upstream task id when this task reviews, ",
            "tests, aggregates, or otherwise consumes earlier work. Do not create producer ",
            "and reviewer/consumer tasks as unrelated parallel work: dependent tasks are ",
            "held until every upstream task is completed, ",
            "then receive the upstream tasks' durable outputs in their TaskAssigned message. ",
            "If other tasks are still open but omitted from `dependency_task_ids`, creation ",
            "pauses with recoverable guidance. Add the omitted task ids when their output is ",
            "needed. Only the coordinator may set ",
            "`allow_parallel_with_unlisted_open_tasks=true` after deciding that the new ",
            "task is intentionally independent of every omitted open task. ",
            "You MUST also choose `execution_mode`: use `plan` only for a task whose ",
            "deliverable is an explicit plan submitted through `create_plan`; use `build` ",
            "for implementation, writing, review, testing, research, and all other work. ",
            "`required_role` is a human-readable hint only; it does not authorize claim ",
            "by itself. `status` defaults to `pending`; `in_progress` requires ",
            "`owner_member_id` to equal the calling session's member_id."
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
        params_schema::<TaskCreateParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let params: TaskCreateParams = parse_params(params_value)?;
        validate_freeform_task_metadata(params.metadata.as_ref())
            .map_err(ToolError::InvalidParams)?;
        if params.subject.trim().is_empty() {
            return Err(ToolError::InvalidParams(
                "task_create requires a non-empty `subject`".into(),
            ));
        }
        let dispatch_policy =
            TaskDispatchPolicy::parse(&params.dispatch_policy).map_err(ToolError::InvalidParams)?;
        let execution_mode = TaskExecutionMode::from_wire(&params.execution_mode)
            .map_err(ToolError::InvalidParams)?;
        if dispatch_policy == TaskDispatchPolicy::AfterDependencies
            && params
                .dependency_task_ids
                .iter()
                .all(|task_id| task_id.trim().is_empty())
        {
            return serde_json::to_string(&json!({
                "created": false,
                "requires_dependency_ids": true,
                "guidance": "dispatch_policy=after_dependencies requires at least one real dependency_task_id. Prefer task_graph_create for a new multi-stage workflow, or retry task_create with the upstream durable task ids.",
            }))
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
        }
        let blocked_by = dispatch_policy
            .into_blocked_by(params.dependency_task_ids)
            .map_err(ToolError::InvalidParams)?;
        if params.allow_parallel_with_unlisted_open_tasks && !self.ctx.is_coordinator() {
            return self.ctx.authorization_denied_response(
                "task_create.override_unlisted_open_tasks",
                Vec::new(),
                "Only the coordinator may confirm that a new task can bypass other open work. Send the proposed parallel work to the coordinator for approval.",
            );
        }
        let resolved_owner = match params.owner_member_id.as_deref() {
            Some(owner_member_id) => Some(
                self.ctx
                    .resolve_owner_member_id(owner_member_id)
                    .map_err(ToolError::InvalidParams)?,
            ),
            None => None,
        };
        if let Some(owner_member_id) = resolved_owner.as_ref() {
            let denied = self
                .ctx
                .unauthorized_task_target_member_ids(std::slice::from_ref(owner_member_id));
            if !denied.is_empty() {
                return self.ctx.authorization_denied_response(
                    "task_create.assign_owner",
                    denied,
                    "You may create work only for yourself or your direct reports. Ask the coordinator to create or assign work for a peer or another branch.",
                );
            }
        }
        let eligible_member_ids = params
            .eligible_member_ids
            .map(|member_ids| self.ctx.resolve_eligible_member_ids(member_ids))
            .transpose()
            .map_err(ToolError::InvalidParams)?;
        if let Some(member_ids) = eligible_member_ids.as_ref() {
            let denied = self.ctx.unauthorized_task_target_member_ids(member_ids);
            if !denied.is_empty() {
                return self.ctx.authorization_denied_response(
                    "task_create.set_eligibility",
                    denied,
                    "An ownerless task may list only candidates you are authorized to manage. Ask the coordinator to create cross-peer or cross-branch unassigned work.",
                );
            }
        }
        let status = match params.status.as_deref() {
            None => TaskStatus::Pending,
            Some(value) => parse_status(value).map_err(ToolError::InvalidParams)?,
        };
        if status == TaskStatus::InProgress {
            let caller_member_id = self.ctx.caller_owner_member_id();
            match resolved_owner.as_deref() {
                Some(owner_member_id) if owner_member_id == caller_member_id => {}
                Some(owner_member_id) => {
                    return Err(ToolError::InvalidParams(format!(
                        "task_create status=in_progress can only be set by the owning member; caller_member_id={caller_member_id}, owner_member_id={owner_member_id}"
                    )));
                }
                None => {
                    return Err(ToolError::InvalidParams(
                        "task_create status=in_progress requires owner_member_id to equal the calling session's member_id".to_string(),
                    ));
                }
            }
        }
        let explicit_id = params
            .id
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
        let id = params
            .id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(agent_org_tasks::new_task_id);
        validate_task_identifier("task_create.id", &id).map_err(ToolError::InvalidParams)?;
        validate_task_identifier_list("task_create.dependency_task_ids", &blocked_by)
            .map_err(ToolError::InvalidParams)?;
        if blocked_by.iter().any(|dependency_id| dependency_id == &id) {
            return Err(ToolError::InvalidParams(format!(
                "{}: task '{id}' cannot depend on itself",
                crate::coordination::agent_org_tasks::TASK_DEPENDENCY_CYCLE_ERROR
            )));
        }
        let read_run_id = self.ctx.org_context.run_id.clone();
        let read_task_id = explicit_id.then(|| id.clone());
        let (existing, existing_tasks) = tokio::task::spawn_blocking(move || {
            let existing = read_task_id
                .as_deref()
                .map(|task_id| AgentOrgTaskStore::get(&read_run_id, task_id))
                .transpose()?
                .flatten();
            let tasks = if existing.is_some() {
                Vec::new()
            } else {
                AgentOrgTaskStore::list(&read_run_id)?
            };
            Ok::<_, String>((existing, tasks))
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("task_create read worker failed: {err}"))
        })?
        .map_err(map_task_write_error)?;
        if explicit_id {
            if let Some(existing) = existing {
                let body = json!({
                    "task": task_to_json(&existing),
                    "already_exists": true,
                    "guidance": "Task id already exists in this run; use task_update for changes instead of creating a duplicate.",
                    "task_assigned_dispatched": false,
                });
                return serde_json::to_string(&body).map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "task_create: failed to serialize result: {err}"
                    ))
                });
            }
        }

        if !blocked_by.is_empty() {
            let missing_dependency_ids = blocked_by
                .iter()
                .filter(|dependency_id| {
                    !existing_tasks.iter().any(|task| &task.id == *dependency_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !missing_dependency_ids.is_empty() {
                return Err(ToolError::InvalidParams(format!(
                    "dispatch_policy references task ids that do not exist in this run: {}. Create upstream tasks first, then use their returned ids.",
                    missing_dependency_ids.join(", ")
                )));
            }
        }

        // The old guard trusted `dispatch_policy=immediate` and inspected
        // omitted work only after the model had already declared the task a
        // dependency consumer. A coordinator could therefore recover from a
        // rejected review/synthesis task by relabelling it `immediate`. Treat
        // every open task as a scheduling decision: either it is covered by
        // this dependency closure, or the coordinator explicitly confirms a
        // genuinely independent branch.
        let covered_dependency_ids = task_dependency_closure(&blocked_by, &existing_tasks);
        let unlisted_open_tasks = existing_tasks
            .iter()
            .filter(|task| !task.status.is_resolved())
            .filter(|task| !covered_dependency_ids.contains(&task.id))
            .collect::<Vec<_>>();
        if !status.is_resolved()
            && !unlisted_open_tasks.is_empty()
            && !params.allow_parallel_with_unlisted_open_tasks
        {
            let requires_dependency_confirmation = !blocked_by.is_empty()
                || unlisted_open_tasks.iter().any(|task| {
                    agent_org_tasks::task_execution_mode(task) == TaskExecutionMode::Plan
                });
            let suggested_dependency_task_ids = blocked_by
                .iter()
                .cloned()
                .chain(unlisted_open_tasks.iter().map(|task| task.id.clone()))
                .collect::<Vec<_>>();
            let unlisted_open_tasks = unlisted_open_tasks
                .into_iter()
                .map(|task| {
                    json!({
                        "id": task.id,
                        "subject": task.subject,
                        "owner_member_id": task.owner,
                        "status": task.status.as_wire(),
                    })
                })
                .collect::<Vec<_>>();
            let body = json!({
                "created": false,
                "requires_dependency_confirmation": requires_dependency_confirmation,
                "requires_parallel_confirmation": !requires_dependency_confirmation,
                "unlisted_open_tasks": unlisted_open_tasks,
                "suggested_retry": {
                    "dispatch_policy": "after_dependencies",
                    "dependency_task_ids": suggested_dependency_task_ids,
                },
                "guidance": "Open work is not covered by this task's dependency chain. If the new task consumes those outputs, retry with suggested_retry. If it is intentionally independent of every listed task, only the coordinator may retry with allow_parallel_with_unlisted_open_tasks=true.",
            });
            return serde_json::to_string(&body).map_err(|err| {
                ToolError::ExecutionFailed(format!(
                    "task_create: failed to serialize scheduling guidance: {err}"
                ))
            });
        }

        if resolved_owner.is_none()
            && status == TaskStatus::Pending
            && eligible_member_ids.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(ToolError::InvalidParams(
                "ownerless pending tasks require a non-empty eligible_member_ids list".to_string(),
            ));
        }
        let metadata = merge_task_metadata(
            params.metadata,
            eligible_member_ids,
            params.required_role,
            Some(execution_mode),
            None,
        );

        #[cfg(test)]
        if let Some(hook) = self.pre_persist_hook.as_ref() {
            hook.pause().await;
        }

        let create_context = Arc::clone(&self.ctx);
        let allow_parallel_with_unlisted_open_tasks =
            params.allow_parallel_with_unlisted_open_tasks;
        let requested_dependency_task_ids = blocked_by.clone();
        let create_params = CreateTaskParams {
            id,
            org_run_id: self.ctx.org_context.run_id.clone(),
            subject: params.subject,
            description: params.description.unwrap_or_default(),
            active_form: params.active_form,
            owner: resolved_owner,
            status,
            blocks: Vec::new(),
            blocked_by,
            metadata,
        };
        let create_result = tokio::task::spawn_blocking(move || {
            AgentOrgTaskStore::create_with_transactional_effects(
                create_params,
                TaskCreateSchedulingPolicy {
                    allow_parallel_with_unlisted_open_tasks,
                },
                |tx, task, tasks| {
                    create_context.persist_created_tasks_outbox_in_tx(
                        tx,
                        std::slice::from_ref(task),
                        tasks,
                    )
                },
            )
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("task_create mutation worker failed: {err}"))
        })?;
        let (task, outbox) = match create_result {
            Ok(created) => created,
            Err(error) => {
                if let Some(task_ids) = error
                    .strip_prefix(TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR)
                    .and_then(|suffix| suffix.strip_prefix(':'))
                {
                    let unlisted_open_task_ids = task_ids
                        .split(',')
                        .filter(|task_id| !task_id.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    let suggested_dependency_task_ids = requested_dependency_task_ids
                        .iter()
                        .cloned()
                        .chain(unlisted_open_task_ids.iter().cloned())
                        .collect::<Vec<_>>();
                    return serde_json::to_string(&json!({
                        "created": false,
                        "requires_dependency_confirmation": true,
                        "requires_parallel_confirmation": true,
                        "unlisted_open_task_ids": unlisted_open_task_ids,
                        "suggested_retry": {
                            "dispatch_policy": "after_dependencies",
                            "dependency_task_ids": suggested_dependency_task_ids,
                        },
                        "guidance": "Open work changed while this task was being validated. Add the listed durable task ids when this task consumes their output, or retry with allow_parallel_with_unlisted_open_tasks=true only when the new task is intentionally independent.",
                    }))
                    .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
                }
                return Err(map_task_write_error(error));
            }
        };
        self.ctx.wake_committed_task_outbox(&outbox);
        let task_assigned_dispatched = outbox.task_assigned_ids.iter().any(|id| id == &task.id);
        let assignment_required = task.owner.is_none();

        let body = json!({
            "task": task_to_json(&task),
            "already_exists": false,
            "task_assigned_dispatched": task_assigned_dispatched,
            "assignment_required": assignment_required,
            "guidance": assignment_required.then_some("This task is waiting for an explicit owner assignment. No worker will self-claim or be woken."),
        });
        serde_json::to_string(&body).map_err(|err| {
            ToolError::ExecutionFailed(format!("task_create: failed to serialize result: {err}"))
        })
    }

    fn is_read_only(&self) -> bool {
        false
    }
}
