use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_payload_limits::validate_task_identifier_list;
use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::coordination::agent_org_tasks::{
    self, task_dependency_closure, AgentOrgTaskStore, CreatePendingTaskParams,
    TaskCreateSchedulingPolicy, TaskExecutionMode, TaskGraphWriterAdmin,
    TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
};
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{
    classify_task_receipt_error, merge_task_metadata, task_to_json,
    validate_freeform_task_metadata, TaskOutboxCommit, TaskToolsContext,
};

/// Explicit decision about when a newly-created task may be dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDispatchPolicy {
    Immediate,
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
                    if !task_id.is_empty() && !normalized.iter().any(|existing| existing == task_id)
                    {
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

/// Model-facing create request. Durable ids are always minted after receipt
/// lookup inside the Task Store transaction and returned in the result.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskCreateParams {
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub owner_member_id: Option<String>,
    pub dispatch_policy: String,
    pub execution_mode: String,
    #[serde(default)]
    pub dependency_task_ids: Vec<String>,
    #[serde(default)]
    pub allow_parallel_with_unlisted_open_tasks: bool,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub eligible_member_ids: Option<Vec<String>>,
    #[serde(default)]
    pub required_role: Option<String>,
}

pub struct TaskCreateTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskCreateTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for TaskCreateTool {
    fn name(&self) -> &str {
        tool_names::TASK_CREATE
    }

    fn description(&self) -> &str {
        concat!(
            "Create one pending Task on the current Team's durable board. The Coordinator and ",
            "a configured Writer may manage graph work; an ordinary Owner may only update the ",
            "Task bound to its exact TaskExecution turn. The runtime mints the durable Task id. ",
            "Choose immediate only for independent work, or after_dependencies with every ",
            "upstream durable Task id for review, test, synthesis, and other consumer work."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour task authority: {}\nAuthorized owner_member_id values: {}",
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
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        let canonical_params = params_value.clone();
        let params: TaskCreateParams = parse_params(params_value)?;
        if !self.ctx.is_task_graph_writer() {
            return self.ctx.authorization_denied_response(
                "task_create",
                vec![self.ctx.caller_owner_member_id()],
                "Only the Coordinator or a configured Writer may create Task graph work.",
            );
        }
        if params.subject.trim().is_empty() {
            return Err(ToolError::InvalidParams(
                "task_create requires a non-empty `subject`".to_string(),
            ));
        }
        validate_freeform_task_metadata(params.metadata.as_ref())
            .map_err(ToolError::InvalidParams)?;
        let dispatch_policy =
            TaskDispatchPolicy::parse(&params.dispatch_policy).map_err(ToolError::InvalidParams)?;
        let blocked_by = dispatch_policy
            .into_blocked_by(params.dependency_task_ids)
            .map_err(ToolError::InvalidParams)?;
        validate_task_identifier_list("task_create.dependency_task_ids", &blocked_by)
            .map_err(ToolError::InvalidParams)?;
        let execution_mode = TaskExecutionMode::from_wire(&params.execution_mode)
            .map_err(ToolError::InvalidParams)?;
        let owner = params
            .owner_member_id
            .as_deref()
            .map(|member_id| self.ctx.resolve_owner_member_id(member_id))
            .transpose()
            .map_err(ToolError::InvalidParams)?;
        if let Some(owner_member_id) = owner.as_ref() {
            let denied = self
                .ctx
                .unauthorized_task_target_member_ids(std::slice::from_ref(owner_member_id));
            if !denied.is_empty() {
                return self.ctx.authorization_denied_response(
                    "task_create.assign_owner",
                    denied,
                    "The requested owner is outside this Writer's frozen Task authority.",
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
                    "The requested eligibility list is outside this Writer's frozen Task authority.",
                );
            }
        }
        if owner.is_none() && eligible_member_ids.as_ref().is_none_or(Vec::is_empty) {
            return Err(ToolError::InvalidParams(
                "ownerless pending tasks require a non-empty eligible_member_ids list".to_string(),
            ));
        }

        let actor =
            TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
                .map_err(ToolError::InvalidParams)?;
        let activation_session_id = call_ctx.session_id.clone();
        let activation_turn_intent_id = call_ctx.turn_intent_id.clone();
        let receipt_key = AgentOrgToolReceiptKey::from_call_context(
            self.ctx.org_context.run_id.clone(),
            call_ctx,
        )?;
        let run_id = self.ctx.org_context.run_id.clone();
        let context = Arc::clone(&self.ctx);
        let requested_dependency_task_ids = blocked_by.clone();
        let allow_parallel = params.allow_parallel_with_unlisted_open_tasks;
        let metadata =
            merge_task_metadata(params.metadata, eligible_member_ids, params.required_role);
        let subject = params.subject;
        let description = params.description.unwrap_or_default();
        let active_form = params.active_form;

        let (receipt, committed_outbox) = tokio::task::spawn_blocking(move || {
            let mut committed_outbox: Option<TaskOutboxCommit> = None;
            let receipt = AgentOrgToolReceiptStore::execute(
                receipt_key,
                tool_names::TASK_CREATE,
                "create",
                &canonical_params,
                |tx| {
                    let existing_tasks = AgentOrgTaskStore::list_with_connection(tx, &run_id)
                        .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)?;
                    let missing_dependency_ids = requested_dependency_task_ids
                        .iter()
                        .filter(|dependency_id| {
                            !existing_tasks.iter().any(|task| &task.id == *dependency_id)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !missing_dependency_ids.is_empty() {
                        return Ok(Err(ToolError::InvalidParams(format!(
                            "dispatch_policy references task ids that do not exist in this run: {}. Create upstream tasks first, then use their returned ids.",
                            missing_dependency_ids.join(", ")
                        ))));
                    }
                    let covered = task_dependency_closure(
                        &requested_dependency_task_ids,
                        &existing_tasks,
                    );
                    let omitted = existing_tasks
                        .iter()
                        .filter(|task| task.status.is_open() && !covered.contains(&task.id))
                        .map(|task| task.id.clone())
                        .collect::<Vec<_>>();
                    if !omitted.is_empty() && !allow_parallel {
                        let response = serde_json::to_string(&json!({
                            "created": false,
                            "requires_parallel_confirmation": true,
                            "unlisted_open_task_ids": omitted,
                            "guidance": "Open work is outside this Task's dependency chain. Add its ids when this Task consumes that output, or explicitly confirm an independent branch."
                        }))
                        .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)?;
                        return Ok(Ok(response));
                    }
                    let create_params = CreatePendingTaskParams {
                        id: agent_org_tasks::new_task_id(),
                        org_run_id: run_id.clone(),
                        subject,
                        description,
                        active_form,
                        owner,
                        execution_mode,
                        blocked_by: requested_dependency_task_ids.clone(),
                        metadata,
                        originating_message_id: None,
                        replaces_task_id: None,
                    };
                    if let Err(error) = AgentOrgRunStore::activate_idle_for_task_graph_in_tx(
                        tx,
                        &run_id,
                        &activation_session_id,
                        &activation_turn_intent_id,
                    ) {
                        return match classify_task_receipt_error(error) {
                            Ok(error) => Ok(Err(error)),
                            Err(abort) => Err(abort),
                        };
                    }
                    match AgentOrgTaskStore::create_pending_in_tx(
                        tx,
                        actor,
                        create_params,
                        TaskCreateSchedulingPolicy {
                            allow_parallel_with_unlisted_open_tasks: allow_parallel,
                        },
                        |tx, task, tasks| {
                            context.persist_created_tasks_outbox_in_tx(
                                tx,
                                std::slice::from_ref(task),
                                tasks,
                                Some(&activation_turn_intent_id),
                            )
                        },
                    ) {
                        Ok((task, outbox)) => {
                            let assignment_required = task.owner.is_none();
                            let task_assigned_dispatched =
                                outbox.task_assigned_ids.iter().any(|id| id == &task.id);
                            let response = serde_json::to_string(&json!({
                                "task": task_to_json(&task),
                                "already_exists": false,
                                "task_assigned_dispatched": task_assigned_dispatched,
                                "assignment_required": assignment_required,
                                "guidance": assignment_required.then_some("This Task is waiting for explicit owner assignment. No worker will self-claim or be woken."),
                            }))
                            .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)?;
                            committed_outbox = Some(outbox);
                            Ok(Ok(response))
                        }
                        Err(error) if error.starts_with(TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR) => {
                            let ids = error
                                .split_once(':')
                                .map(|(_, ids)| ids.split(',').collect::<Vec<_>>())
                                .unwrap_or_default();
                            let response = serde_json::to_string(&json!({
                                "created": false,
                                "requires_parallel_confirmation": true,
                                "unlisted_open_task_ids": ids,
                                "guidance": "Open work changed inside the transaction; retry with dependencies or explicit independent-branch confirmation."
                            }))
                            .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)?;
                            Ok(Ok(response))
                        }
                        Err(error) => match classify_task_receipt_error(error) {
                            Ok(error) => Ok(Err(error)),
                            Err(abort) => Err(abort),
                        },
                    }
                },
            )?;
            Ok::<_, ToolError>((receipt, committed_outbox))
        })
        .await
        .map_err(|error| ToolError::ExecutionFailed(format!("task_create worker failed: {error}")))??;

        if receipt.is_fresh() {
            if let Some(outbox) = committed_outbox.as_ref() {
                self.ctx.wake_committed_task_outbox(outbox);
            }
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                &self.ctx.org_context.run_id,
            );
        }
        receipt.result
    }

    fn is_read_only(&self) -> bool {
        false
    }
}
