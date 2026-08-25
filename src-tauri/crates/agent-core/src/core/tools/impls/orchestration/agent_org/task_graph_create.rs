use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_payload_limits::{
    validate_task_identifier_list, TASK_GRAPH_CREATE_MAX_TASKS,
};
use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::coordination::agent_org_tasks::{
    self, task_dependency_closure, AgentOrgTaskStore, CreatePendingTaskParams, TaskExecutionMode,
    TaskGraphWriterAdmin, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
};
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptAbort, AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{
    classify_task_receipt_error, merge_task_metadata, task_to_json,
    validate_freeform_task_metadata, TaskOutboxCommit, TaskToolsContext,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskGraphNodeParams {
    pub key: String,
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub owner_member_id: Option<String>,
    pub execution_mode: String,
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
    pub tasks: Vec<TaskGraphNodeParams>,
    #[serde(default)]
    pub allow_parallel_with_existing_open_tasks: bool,
}

struct PreparedGraphNode {
    key: String,
    subject: String,
    description: String,
    active_form: Option<String>,
    owner: Option<String>,
    execution_mode: TaskExecutionMode,
    depends_on: Vec<String>,
    metadata: Option<Value>,
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
            "Create a complete pending Task graph atomically. Each node has a request-local key, ",
            "and depends_on may reference local keys or existing durable Task ids. The runtime ",
            "mints all durable ids after the exactly-once receipt lookup, validates the complete ",
            "candidate graph, then commits Tasks, audit history, Inbox outbox, and receipt together."
        )
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour task authority: {}\nAuthorized owner_member_id values: {}",
            self.description(),
            self.ctx.task_authority_summary(),
            self.ctx.authorized_task_target_catalog()
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
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let canonical_params = params_value.clone();
        let params: TaskGraphCreateParams = parse_params(params_value)?;
        if !self.ctx.is_task_graph_writer() {
            return self.ctx.authorization_denied_response(
                "task_graph_create",
                vec![self.ctx.caller_owner_member_id()],
                "Only the Coordinator or a configured Writer may create Task graph work.",
            );
        }
        if params.tasks.is_empty() || params.tasks.len() > TASK_GRAPH_CREATE_MAX_TASKS {
            return Err(ToolError::InvalidParams(format!(
                "task_graph_create requires 1..={TASK_GRAPH_CREATE_MAX_TASKS} tasks per request"
            )));
        }

        let mut keys = HashSet::with_capacity(params.tasks.len());
        let mut prepared = Vec::with_capacity(params.tasks.len());
        for (index, node) in params.tasks.into_iter().enumerate() {
            let key = node.key.trim().to_string();
            if key.is_empty() || key.chars().count() > 80 || !keys.insert(key.clone()) {
                return Err(ToolError::InvalidParams(format!(
                    "task graph key at index {index} must be unique and 1..=80 characters"
                )));
            }
            if node.subject.trim().is_empty() {
                return Err(ToolError::InvalidParams(format!(
                    "task graph node '{key}' requires a non-empty subject"
                )));
            }
            validate_task_identifier_list(
                &format!("task_graph_create.tasks[{index}].depends_on"),
                &node.depends_on,
            )
            .map_err(ToolError::InvalidParams)?;
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
                        "The graph contains an owner outside this Writer's frozen Task authority.",
                    );
                }
            }
            let eligible_member_ids = node
                .eligible_member_ids
                .map(|ids| self.ctx.resolve_eligible_member_ids(ids))
                .transpose()
                .map_err(ToolError::InvalidParams)?;
            if owner.is_none() && eligible_member_ids.as_ref().is_none_or(Vec::is_empty) {
                return Err(ToolError::InvalidParams(format!(
                    "ownerless graph node '{key}' requires eligible_member_ids"
                )));
            }
            if let Some(ids) = eligible_member_ids.as_ref() {
                let denied = self.ctx.unauthorized_task_target_member_ids(ids);
                if !denied.is_empty() {
                    return self.ctx.authorization_denied_response(
                        "task_graph_create.set_eligibility",
                        denied,
                        "The graph contains an eligibility target outside this Writer's frozen Task authority.",
                    );
                }
            }
            prepared.push(PreparedGraphNode {
                key,
                subject: node.subject,
                description: node.description.unwrap_or_default(),
                active_form: node.active_form,
                owner,
                execution_mode: TaskExecutionMode::from_wire(&node.execution_mode)
                    .map_err(ToolError::InvalidParams)?,
                depends_on: node.depends_on,
                metadata: merge_task_metadata(
                    node.metadata,
                    eligible_member_ids,
                    node.required_role,
                ),
            });
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
        let allow_parallel = params.allow_parallel_with_existing_open_tasks;

        let (receipt, committed_outbox) = tokio::task::spawn_blocking(move || {
            let mut committed_outbox: Option<TaskOutboxCommit> = None;
            let receipt = AgentOrgToolReceiptStore::execute(
                receipt_key,
                tool_names::TASK_GRAPH_CREATE,
                "create_graph",
                &canonical_params,
                |tx| {
                    let existing_tasks = AgentOrgTaskStore::list_with_connection(tx, &run_id)
                        .map_err(AgentOrgToolReceiptAbort::storage)?;
                    let existing_ids = existing_tasks
                        .iter()
                        .map(|task| task.id.clone())
                        .collect::<HashSet<_>>();
                    let mut key_to_id = HashMap::with_capacity(prepared.len());
                    for node in &prepared {
                        key_to_id.insert(node.key.clone(), agent_org_tasks::new_task_id());
                    }
                    let mut create_params = Vec::with_capacity(prepared.len());
                    for node in prepared {
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
                            .collect::<Result<Vec<_>, _>>();
                        let blocked_by = match blocked_by {
                            Ok(blocked_by) => blocked_by,
                            Err(error) => return Ok(Err(error)),
                        };
                        create_params.push(CreatePendingTaskParams {
                            id: key_to_id[&node.key].clone(),
                            org_run_id: run_id.clone(),
                            subject: node.subject,
                            description: node.description,
                            active_form: node.active_form,
                            owner: node.owner,
                            execution_mode: node.execution_mode,
                            blocked_by,
                            metadata: node.metadata,
                            originating_message_id: None,
                            replaces_task_id: None,
                        });
                    }
                    let directly_referenced_existing = create_params
                        .iter()
                        .flat_map(|task| task.blocked_by.iter())
                        .filter(|dependency| existing_ids.contains(dependency.as_str()))
                        .cloned()
                        .collect::<Vec<_>>();
                    let referenced_existing =
                        task_dependency_closure(&directly_referenced_existing, &existing_tasks);
                    let omitted = existing_tasks
                        .iter()
                        .filter(|task| {
                            task.status.is_open() && !referenced_existing.contains(&task.id)
                        })
                        .map(|task| task.id.clone())
                        .collect::<Vec<_>>();
                    if !omitted.is_empty() && !allow_parallel {
                        let response = serde_json::to_string(&json!({
                            "created": false,
                            "requires_parallel_confirmation": true,
                            "unlisted_open_task_ids": omitted,
                            "guidance": "This graph starts while older open work remains outside it. Add dependencies or explicitly confirm an independent branch."
                        }))
                        .map_err(AgentOrgToolReceiptAbort::storage)?;
                        return Ok(Ok(response));
                    }
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
                    match AgentOrgTaskStore::create_pending_batch_in_tx(
                        tx,
                        actor,
                        create_params,
                        allow_parallel,
                        |tx, created, all_tasks| {
                            context.persist_created_tasks_outbox_in_tx(tx, created, all_tasks)
                        },
                    ) {
                        Ok((created, outbox)) => {
                            let assignment_required_task_ids = created
                                .iter()
                                .filter(|task| task.owner.is_none())
                                .map(|task| task.id.clone())
                                .collect::<Vec<_>>();
                            let task_id_by_key = key_to_id
                                .into_iter()
                                .map(|(key, id)| (key, Value::String(id)))
                                .collect::<serde_json::Map<_, _>>();
                            let response = serde_json::to_string(&json!({
                                "created": true,
                                "org_run_id": run_id,
                                "tasks": created.iter().map(task_to_json).collect::<Vec<_>>(),
                                "task_id_by_key": task_id_by_key,
                                "task_assigned_dispatched_ids": outbox.task_assigned_ids,
                                "assignment_required_task_ids": assignment_required_task_ids,
                            }))
                            .map_err(AgentOrgToolReceiptAbort::storage)?;
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
                            .map_err(AgentOrgToolReceiptAbort::storage)?;
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
        .map_err(|error| {
            ToolError::ExecutionFailed(format!("task_graph_create worker failed: {error}"))
        })??;

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
