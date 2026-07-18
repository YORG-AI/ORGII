use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_payload_limits::{
    validate_task_identifier_list, TASK_GRAPH_CREATE_MAX_TASKS,
};
use crate::coordination::agent_org_tasks::{
    self, task_dependency_closure, AgentOrgTaskStore, CreateTaskParams, TaskExecutionMode,
    TaskStatus, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{
    map_task_write_error, merge_task_metadata, task_to_json, validate_freeform_task_metadata,
    TaskToolsContext,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskGraphNodeParams {
    /// Short unique key used only inside this request (for example `plan`,
    /// `implement`, `review`). The runtime resolves it to a durable UUID.
    pub key: String,
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub owner_member_id: Option<String>,
    /// `plan` only for a plan submitted through create_plan; otherwise build.
    pub execution_mode: String,
    /// Local node keys from this request or durable task ids already on the
    /// same run. Every listed task must complete before this node is assigned.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub eligible_member_ids: Option<Vec<String>>,
    #[serde(default)]
    pub required_role: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskGraphCreateParams {
    /// Complete graph patch to create atomically. Use at most 32 nodes.
    pub tasks: Vec<TaskGraphNodeParams>,
    /// Required only when this graph intentionally starts a new independent
    /// branch while older open tasks remain outside the graph.
    #[serde(default)]
    pub allow_parallel_with_existing_open_tasks: bool,
}

pub struct TaskGraphCreateTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskGraphCreateTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for TaskGraphCreateTool {
    fn name(&self) -> &str {
        tool_names::TASK_GRAPH_CREATE
    }

    fn description(&self) -> &str {
        concat!(
            "Create a complete Agent Org task dependency graph atomically. Use this as the ",
            "coordinator's preferred way to decompose a new multi-stage request. Each node ",
            "has a short local `key`; `depends_on` references those keys, so you do not need ",
            "to create upstream tasks first or copy UUIDs between tool calls. The runtime ",
            "validates owners, eligibility, dependency references, cycles, execution modes, ",
            "and the run mutation boundary before inserting anything. If validation fails, ",
            "zero tasks are created. Roots may run in parallel; review, test, synthesis, and ",
            "other consumers must list every upstream key whose output they consume."
        )
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour task authority: {}\nAuthorized owner_member_id values: {}\nUse local keys such as plan/write/review/final; do not invent UUID dependencies for nodes in the same request.",
            self.description(),
            self.ctx.task_authority_summary(),
            self.ctx.authorized_task_target_catalog(),
        ))
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        params_schema::<TaskGraphCreateParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let params: TaskGraphCreateParams = parse_params(params_value)?;
        if !self.ctx.is_coordinator() {
            return self.ctx.authorization_denied_response(
                "task_graph_create",
                vec![self.ctx.caller_owner_member_id()],
                "Only the coordinator may create a cross-member task graph. Send the proposed graph to the coordinator.",
            );
        }
        if params.tasks.is_empty() || params.tasks.len() > TASK_GRAPH_CREATE_MAX_TASKS {
            return Err(ToolError::InvalidParams(format!(
                "task_graph_create requires 1..={TASK_GRAPH_CREATE_MAX_TASKS} tasks per request"
            )));
        }
        for (index, node) in params.tasks.iter().enumerate() {
            validate_task_identifier_list(
                &format!("task_graph_create.tasks[{index}].depends_on"),
                &node.depends_on,
            )
            .map_err(ToolError::InvalidParams)?;
        }

        let read_run_id = self.ctx.org_context.run_id.clone();
        let existing_tasks =
            tokio::task::spawn_blocking(move || AgentOrgTaskStore::list(&read_run_id))
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "task_graph_create read worker failed: {err}"
                    ))
                })?
                .map_err(ToolError::ExecutionFailed)?;
        let existing_ids = existing_tasks
            .iter()
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let open_existing = existing_tasks
            .iter()
            .filter(|task| !task.status.is_resolved())
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        let directly_referenced_existing = params
            .tasks
            .iter()
            .flat_map(|node| node.depends_on.iter())
            .filter(|dependency| existing_ids.contains(dependency.as_str()))
            .cloned()
            .collect::<HashSet<_>>();
        let referenced_existing = task_dependency_closure(
            &directly_referenced_existing.into_iter().collect::<Vec<_>>(),
            &existing_tasks,
        );
        let omitted_existing = open_existing
            .iter()
            .filter(|task_id| !referenced_existing.contains(task_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !omitted_existing.is_empty() && !params.allow_parallel_with_existing_open_tasks {
            return serde_json::to_string(&json!({
                "created": false,
                "requires_parallel_confirmation": true,
                "unlisted_open_task_ids": omitted_existing,
                "guidance": "This graph would start while older open tasks remain outside it. Add those durable task ids to the appropriate depends_on lists, or retry with allow_parallel_with_existing_open_tasks=true only when the new graph is intentionally independent.",
            }))
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
        }

        let mut key_to_id = HashMap::with_capacity(params.tasks.len());
        for node in &params.tasks {
            let key = node.key.trim();
            if key.is_empty() || key.chars().count() > 80 {
                return Err(ToolError::InvalidParams(
                    "every task graph key must be 1..=80 characters".to_string(),
                ));
            }
            if key_to_id
                .insert(key.to_string(), agent_org_tasks::new_task_id())
                .is_some()
            {
                return Err(ToolError::InvalidParams(format!(
                    "duplicate task graph key: {key}"
                )));
            }
        }

        let mut create_params = Vec::with_capacity(params.tasks.len());
        for node in params.tasks {
            if node.subject.trim().is_empty() {
                return Err(ToolError::InvalidParams(format!(
                    "task graph node '{}' requires a non-empty subject",
                    node.key
                )));
            }
            validate_freeform_task_metadata(node.metadata.as_ref())
                .map_err(ToolError::InvalidParams)?;
            let owner = node
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
                        "task_graph_create.assign_owner",
                        denied,
                        "The graph contains an owner outside your task authority.",
                    );
                }
            }
            let eligible_member_ids = node
                .eligible_member_ids
                .map(|member_ids| self.ctx.resolve_eligible_member_ids(member_ids))
                .transpose()
                .map_err(ToolError::InvalidParams)?;
            if owner.is_none()
                && eligible_member_ids
                    .as_ref()
                    .is_none_or(|ids| ids.is_empty())
            {
                return Err(ToolError::InvalidParams(format!(
                    "ownerless graph node '{}' requires eligible_member_ids",
                    node.key
                )));
            }
            let execution_mode = TaskExecutionMode::from_wire(&node.execution_mode)
                .map_err(ToolError::InvalidParams)?;
            let blocked_by = node
                .depends_on
                .iter()
                .map(|dependency| {
                    let dependency = dependency.trim();
                    key_to_id
                        .get(dependency)
                        .cloned()
                        .or_else(|| {
                            existing_ids
                                .contains(dependency)
                                .then(|| dependency.to_string())
                        })
                        .ok_or_else(|| {
                            ToolError::InvalidParams(format!(
                                "task graph node '{}' references unknown dependency '{dependency}'",
                                node.key
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let id = key_to_id.get(node.key.trim()).cloned().ok_or_else(|| {
                ToolError::ExecutionFailed(format!(
                    "task graph key '{}' lost its generated id before persistence",
                    node.key
                ))
            })?;
            let metadata = merge_task_metadata(
                node.metadata,
                eligible_member_ids,
                node.required_role,
                Some(execution_mode),
                None,
            );
            create_params.push(CreateTaskParams {
                id,
                org_run_id: self.ctx.org_context.run_id.clone(),
                subject: node.subject,
                description: node.description.unwrap_or_default(),
                active_form: node.active_form,
                owner,
                status: TaskStatus::Pending,
                blocks: Vec::new(),
                blocked_by,
                metadata,
            });
        }

        let create_context = Arc::clone(&self.ctx);
        let allow_parallel = params.allow_parallel_with_existing_open_tasks;
        let create_result = tokio::task::spawn_blocking(move || {
            AgentOrgTaskStore::create_batch_with_transactional_effects(
                create_params,
                allow_parallel,
                |tx, created, all_tasks| {
                    create_context.persist_created_tasks_outbox_in_tx(tx, created, all_tasks)
                },
            )
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("task_graph_create mutation worker failed: {err}"))
        })?;
        let (created, outbox) = match create_result {
            Ok(created) => created,
            Err(error) => {
                if let Some(task_ids) = error
                    .strip_prefix(TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR)
                    .and_then(|suffix| suffix.strip_prefix(':'))
                {
                    let unlisted_open_task_ids = task_ids
                        .split(',')
                        .filter(|task_id| !task_id.is_empty())
                        .collect::<Vec<_>>();
                    return serde_json::to_string(&json!({
                        "created": false,
                        "requires_parallel_confirmation": true,
                        "unlisted_open_task_ids": unlisted_open_task_ids,
                        "guidance": "Open work changed while this graph was being validated. Add the listed ids to depends_on, or retry with allow_parallel_with_existing_open_tasks=true only when the graph is intentionally independent.",
                    }))
                    .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
                }
                return Err(map_task_write_error(error));
            }
        };
        self.ctx.wake_committed_task_outbox(&outbox);
        let dispatched_task_ids = outbox.task_assigned_ids;
        let assignment_required_task_ids: Vec<String> = created
            .iter()
            .filter(|task| task.owner.is_none())
            .map(|task| task.id.clone())
            .collect();
        let has_assignment_required = !assignment_required_task_ids.is_empty();
        let task_id_by_key = key_to_id
            .into_iter()
            .map(|(key, task_id)| (key, Value::String(task_id)))
            .collect::<serde_json::Map<String, Value>>();
        serde_json::to_string(&json!({
            "created": true,
            "org_run_id": self.ctx.org_context.run_id,
            "tasks": created.iter().map(task_to_json).collect::<Vec<_>>(),
            "task_id_by_key": task_id_by_key,
            "task_assigned_dispatched_ids": dispatched_task_ids,
            "assignment_required_task_ids": assignment_required_task_ids,
            "guidance": has_assignment_required.then_some("Ownerless tasks are waiting for explicit assignment. No worker will self-claim or be woken."),
        }))
        .map_err(|err| ToolError::ExecutionFailed(err.to_string()))
    }

    fn is_read_only(&self) -> bool {
        false
    }
}
