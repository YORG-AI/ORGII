use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreatePendingTaskParams, PendingTaskGraphPatch, TaskAnnotationKind,
    TaskExecutionMode, TaskGraphWriterAdmin, TaskOutputInput, TaskOwnerExecution,
    TaskTerminalReason,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{parse_params, CallContext, Tool, ToolError};

use super::{
    map_task_write_error, task_to_json, validate_freeform_task_metadata, TaskOutboxCommit,
    TaskToolsContext,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskUpdateParams {
    PatchPending {
        id: String,
        #[serde(default)]
        subject: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        active_form: Option<String>,
        #[serde(default)]
        clear_active_form: bool,
        #[serde(default)]
        owner_member_id: Option<String>,
        #[serde(default)]
        clear_owner: bool,
        #[serde(default)]
        execution_mode: Option<String>,
        #[serde(default)]
        blocked_by: Option<Vec<String>>,
        #[serde(default)]
        metadata: Option<Value>,
        #[serde(default)]
        eligible_member_ids: Option<Vec<String>>,
        #[serde(default)]
        required_role: Option<String>,
    },
    Start {
        id: String,
    },
    Complete {
        id: String,
        output: TaskOutputParams,
    },
    Fail {
        id: String,
        reason: TaskReasonParams,
    },
    Cancel {
        id: String,
        reason: TaskReasonParams,
    },
    CancelAndReplace {
        id: String,
        reason: TaskReasonParams,
        replacement: ReplacementTaskParams,
    },
    AppendProgress {
        id: String,
        body: String,
    },
    AppendEvidence {
        id: String,
        body: String,
    },
    AppendAuditNote {
        id: String,
        body: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskOutputParams {
    pub summary: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskReasonParams {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplacementTaskParams {
    #[serde(default)]
    pub id: Option<String>,
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub owner_member_id: Option<String>,
    pub execution_mode: String,
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub eligible_member_ids: Option<Vec<String>>,
    #[serde(default)]
    pub required_role: Option<String>,
}

const COORDINATOR_TASK_UPDATE_OPERATIONS: &[&str] = &[
    "patch_pending",
    "cancel",
    "cancel_and_replace",
    "append_audit_note",
];
const OWNER_TASK_UPDATE_OPERATIONS: &[&str] = &[
    "start",
    "complete",
    "fail",
    "append_progress",
    "append_evidence",
];
const TASK_UPDATE_FIELDS: &[&str] = &[
    "operation",
    "id",
    "subject",
    "description",
    "active_form",
    "clear_active_form",
    "owner_member_id",
    "clear_owner",
    "execution_mode",
    "blocked_by",
    "metadata",
    "eligible_member_ids",
    "required_role",
    "body",
    "output",
    "reason",
    "replacement",
];
const TASK_OUTPUT_FIELDS: &[&str] = &["summary", "content", "artifact_ids"];
const TASK_REASON_FIELDS: &[&str] = &["code", "message"];
const REPLACEMENT_TASK_FIELDS: &[&str] = &[
    "id",
    "subject",
    "description",
    "active_form",
    "owner_member_id",
    "execution_mode",
    "blocked_by",
    "metadata",
    "eligible_member_ids",
    "required_role",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskUpdateAuthority {
    Coordinator,
    Owner,
}

struct TaskUpdateOperationContract {
    authority: TaskUpdateAuthority,
    allowed_fields: &'static [&'static str],
}

fn task_update_operation_contract(operation: &str) -> Option<TaskUpdateOperationContract> {
    let contract = match operation {
        "patch_pending" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Coordinator,
            allowed_fields: &[
                "operation",
                "id",
                "subject",
                "description",
                "active_form",
                "clear_active_form",
                "owner_member_id",
                "clear_owner",
                "execution_mode",
                "blocked_by",
                "metadata",
                "eligible_member_ids",
                "required_role",
            ],
        },
        "start" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Owner,
            allowed_fields: &["operation", "id"],
        },
        "complete" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Owner,
            allowed_fields: &["operation", "id", "output"],
        },
        "fail" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Owner,
            allowed_fields: &["operation", "id", "reason"],
        },
        "cancel" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Coordinator,
            allowed_fields: &["operation", "id", "reason"],
        },
        "cancel_and_replace" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Coordinator,
            allowed_fields: &["operation", "id", "reason", "replacement"],
        },
        "append_progress" | "append_evidence" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Owner,
            allowed_fields: &["operation", "id", "body"],
        },
        "append_audit_note" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Coordinator,
            allowed_fields: &["operation", "id", "body"],
        },
        _ => return None,
    };
    Some(contract)
}

fn is_semantically_empty_json_placeholder(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(value) => value.trim().is_empty(),
        Value::Array(values) => values.is_empty(),
        Value::Object(values) => values.values().all(is_semantically_empty_json_placeholder),
        Value::Bool(_) | Value::Number(_) => false,
    }
}

fn is_empty_known_object_placeholder(value: &Value, known_fields: &[&str]) -> bool {
    let Value::Object(values) = value else {
        return false;
    };
    values.iter().all(|(key, value)| {
        known_fields.contains(&key.as_str()) && is_semantically_empty_json_placeholder(value)
    })
}

fn is_removable_cross_operation_placeholder(field: &str, value: &Value) -> bool {
    if !TASK_UPDATE_FIELDS.contains(&field) {
        return false;
    }
    if value.is_null()
        || value.as_str().is_some_and(|value| value.trim().is_empty())
        || value.as_array().is_some_and(Vec::is_empty)
    {
        return true;
    }
    if matches!(field, "clear_active_form" | "clear_owner") && value == &Value::Bool(false) {
        return true;
    }
    match field {
        "output" => is_empty_known_object_placeholder(value, TASK_OUTPUT_FIELDS),
        "reason" => is_empty_known_object_placeholder(value, TASK_REASON_FIELDS),
        "replacement" => is_empty_known_object_placeholder(value, REPLACEMENT_TASK_FIELDS),
        "metadata" => value
            .as_object()
            .is_some_and(|_| is_semantically_empty_json_placeholder(value)),
        _ => false,
    }
}

fn task_update_operation_example(operation: &str) -> Value {
    match operation {
        "patch_pending" => json!({
            "operation": "patch_pending",
            "id": "<task-id>",
            "subject": "<optional new subject>"
        }),
        "start" => json!({"operation": "start", "id": "<exact task-id>"}),
        "complete" => json!({
            "operation": "complete",
            "id": "<exact task-id>",
            "output": {"summary": "<required summary>"}
        }),
        "fail" => json!({
            "operation": "fail",
            "id": "<exact task-id>",
            "reason": {"code": "<bounded code>", "message": "<bounded message>"}
        }),
        "cancel" => json!({
            "operation": "cancel",
            "id": "<task-id>",
            "reason": {"code": "<bounded code>", "message": "<bounded message>"}
        }),
        "cancel_and_replace" => json!({
            "operation": "cancel_and_replace",
            "id": "<task-id>",
            "reason": {"code": "<bounded code>", "message": "<bounded message>"},
            "replacement": {
                "subject": "<replacement subject>",
                "execution_mode": "build"
            }
        }),
        "append_progress" => json!({
            "operation": "append_progress",
            "id": "<exact task-id>",
            "body": "<progress>"
        }),
        "append_evidence" => json!({
            "operation": "append_evidence",
            "id": "<exact task-id>",
            "body": "<evidence>"
        }),
        "append_audit_note" => json!({
            "operation": "append_audit_note",
            "id": "<task-id>",
            "body": "<audit note>"
        }),
        _ => Value::Null,
    }
}

fn task_update_correction(
    is_coordinator: bool,
    operation: Option<&str>,
    unexpected_fields: Vec<String>,
    reason: &str,
) -> Value {
    let allowed_operations = if is_coordinator {
        COORDINATOR_TASK_UPDATE_OPERATIONS
    } else {
        OWNER_TASK_UPDATE_OPERATIONS
    };
    let contract = operation.and_then(task_update_operation_contract);
    let allowed_fields = contract
        .as_ref()
        .map(|contract| contract.allowed_fields)
        .unwrap_or(&[]);
    let expected_call = operation
        .map(task_update_operation_example)
        .unwrap_or(Value::Null);
    json!({
        "needs_correction": true,
        "tool": tool_names::TASK_UPDATE,
        "operation": operation,
        "reason": reason,
        "unexpected_fields": unexpected_fields,
        "allowed_operations": allowed_operations,
        "allowed_fields": allowed_fields,
        "expected_call": expected_call,
        "guidance": "Retry task_update once using only the fields in expected_call/allowed_fields. Do not copy fields from another operation."
    })
}

fn task_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary"],
        "properties": {
            "summary": { "type": "string" },
            "content": { "type": "string" },
            "artifact_ids": { "type": "array", "items": { "type": "string" } }
        }
    })
}

fn task_reason_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["code", "message"],
        "properties": {
            "code": { "type": "string" },
            "message": { "type": "string" }
        }
    })
}

fn replacement_task_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["subject", "execution_mode"],
        "properties": {
            "id": { "type": "string" },
            "subject": { "type": "string" },
            "description": { "type": "string" },
            "active_form": { "type": "string" },
            "owner_member_id": { "type": "string" },
            "execution_mode": { "type": "string", "enum": ["plan", "build"] },
            "blocked_by": { "type": "array", "items": { "type": "string" } },
            "metadata": { "type": "object", "additionalProperties": true },
            "eligible_member_ids": { "type": "array", "items": { "type": "string" } },
            "required_role": { "type": "string" }
        }
    })
}

fn task_update_parameters(is_coordinator: bool) -> Value {
    if is_coordinator {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["operation", "id"],
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": COORDINATOR_TASK_UPDATE_OPERATIONS,
                    "description": "Coordinator only. patch_pending uses graph fields; cancel uses reason; cancel_and_replace uses reason+replacement; append_audit_note uses body. Omit fields from every other operation."
                },
                "id": { "type": "string" },
                "subject": { "type": "string", "description": "patch_pending only" },
                "description": { "type": "string", "description": "patch_pending only" },
                "active_form": { "type": "string", "description": "patch_pending only" },
                "clear_active_form": { "type": "boolean", "description": "patch_pending only" },
                "owner_member_id": { "type": "string", "description": "patch_pending only" },
                "clear_owner": { "type": "boolean", "description": "patch_pending only" },
                "execution_mode": { "type": "string", "enum": ["plan", "build"], "description": "patch_pending only" },
                "blocked_by": { "type": "array", "items": { "type": "string" }, "description": "patch_pending only" },
                "metadata": { "type": "object", "additionalProperties": true, "description": "patch_pending only" },
                "eligible_member_ids": { "type": "array", "items": { "type": "string" }, "description": "patch_pending only" },
                "required_role": { "type": "string", "description": "patch_pending only" },
                "body": { "type": "string", "description": "append_audit_note only" },
                "reason": task_reason_schema(),
                "replacement": replacement_task_schema()
            }
        })
    } else {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["operation", "id"],
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": OWNER_TASK_UPDATE_OPERATIONS,
                    "description": "Owner only. start accepts exactly operation+id; complete adds output; fail adds reason; append_progress/append_evidence add body. Omit fields from every other operation."
                },
                "id": { "type": "string" },
                "body": { "type": "string", "description": "append_progress or append_evidence only" },
                "output": task_output_schema(),
                "reason": task_reason_schema()
            }
        })
    }
}

pub struct TaskUpdateTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskUpdateTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for TaskUpdateTool {
    fn name(&self) -> &str {
        tool_names::TASK_UPDATE
    }

    fn description(&self) -> &str {
        "Apply one explicit Task operation. Coordinator operations manage pending graph fields, cancellation, replacement, and terminal audit notes. Owner operations start, complete, fail, or append progress/evidence to that Owner's persisted in-progress Task. Mixed graph and Owner fields are rejected by the tagged operation schema."
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour Task authority: {}. New work is always created pending; only an Owner TaskExecution turn can start, complete, or fail it.",
            self.description(),
            self.ctx.task_authority_summary(),
        ))
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        // `TaskUpdateParams` stays a serde-tagged enum so the runtime parser
        // rejects fields that belong to a different actor/operation. Schemars
        // represents that enum as a top-level `oneOf`, however, and several
        // function-calling providers silently discard such schemas. Keep the
        // portable flat object, but expose only operations and fields this
        // session's persisted org role may actually use. This prevents strict
        // providers from filling Coordinator-only fields into an Owner
        // `start` call while the typed parser remains the authority boundary.
        task_update_parameters(self.ctx.is_coordinator())
    }

    async fn execute_text(
        &self,
        mut params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let params = match self.parse_model_params(&mut params_value) {
            Ok(params) => params,
            Err(correction) => {
                return serde_json::to_string(&correction)
                    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
            }
        };
        match params {
            TaskUpdateParams::PatchPending {
                id,
                subject,
                description,
                active_form,
                clear_active_form,
                owner_member_id,
                clear_owner,
                execution_mode,
                blocked_by,
                metadata,
                eligible_member_ids,
                required_role,
            } => {
                if clear_active_form && active_form.is_some() {
                    return Err(ToolError::InvalidParams(
                        "patch_pending cannot set and clear active_form together".to_string(),
                    ));
                }
                if clear_owner && owner_member_id.is_some() {
                    return Err(ToolError::InvalidParams(
                        "patch_pending cannot set and clear owner together".to_string(),
                    ));
                }
                validate_freeform_task_metadata(metadata.as_ref())
                    .map_err(ToolError::InvalidParams)?;
                let actor = self.graph_actor(call_ctx)?;
                let run_id = self.ctx.org_context.run_id.clone();
                let prior_id = id.clone();
                let prior =
                    tokio::task::spawn_blocking(move || AgentOrgTaskStore::get(&run_id, &prior_id))
                        .await
                        .map_err(join_error)?
                        .map_err(ToolError::ExecutionFailed)?
                        .ok_or_else(|| ToolError::InvalidParams(format!("task_not_found: {id}")))?;
                let owner = owner_member_id
                    .as_deref()
                    .map(|owner| self.ctx.resolve_owner_member_id(owner))
                    .transpose()
                    .map_err(ToolError::InvalidParams)?;
                reject_coordinator_owner(owner.as_deref())?;
                let eligible_member_ids = eligible_member_ids
                    .map(|ids| self.ctx.resolve_eligible_member_ids(ids))
                    .transpose()
                    .map_err(ToolError::InvalidParams)?;
                let metadata = merge_graph_metadata(
                    prior.metadata.clone(),
                    metadata,
                    eligible_member_ids,
                    required_role,
                )?;
                let patch = PendingTaskGraphPatch {
                    subject,
                    description,
                    active_form: clear_active_form.then_some(None).or(active_form.map(Some)),
                    owner: clear_owner.then_some(None).or(owner.map(Some)),
                    execution_mode: execution_mode
                        .as_deref()
                        .map(TaskExecutionMode::from_wire)
                        .transpose()
                        .map_err(ToolError::InvalidParams)?,
                    blocked_by,
                    metadata: Some(metadata),
                };
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let expected_updated_at = prior.updated_at;
                let (outcome, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::patch_pending_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        &expected_updated_at,
                        patch,
                        |tx, outcome, tasks| {
                            update_context.persist_task_update_outbox_in_tx(tx, outcome, tasks)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.finish_mutation(outcome, outbox)
            }
            TaskUpdateParams::Start { id } => {
                let actor = self.owner_actor(call_ctx)?;
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let (outcome, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::owner_start_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        |tx, outcome, tasks| {
                            update_context.persist_task_update_outbox_in_tx(tx, outcome, tasks)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.finish_mutation(outcome, outbox)
            }
            TaskUpdateParams::Complete { id, output } => {
                let actor = self.owner_actor(call_ctx)?;
                let output = normalize_output(output).map_err(ToolError::InvalidParams)?;
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let (outcome, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::owner_complete_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        output,
                        |tx, outcome, tasks| {
                            update_context.persist_task_update_outbox_in_tx(tx, outcome, tasks)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.finish_mutation(outcome, outbox)
            }
            TaskUpdateParams::Fail { id, reason } => {
                let actor = self.owner_actor(call_ctx)?;
                let reason = normalize_reason(reason).map_err(ToolError::InvalidParams)?;
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let (outcome, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::owner_fail_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        reason,
                        |tx, outcome, tasks| {
                            update_context.persist_task_update_outbox_in_tx(tx, outcome, tasks)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.finish_mutation(outcome, outbox)
            }
            TaskUpdateParams::Cancel { id, reason } => {
                let actor = self.graph_actor(call_ctx)?;
                let reason = normalize_reason(reason).map_err(ToolError::InvalidParams)?;
                let prior = self.read_task(&id).await?;
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let expected_updated_at = prior.updated_at;
                let (outcome, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::cancel_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        &expected_updated_at,
                        reason,
                        |tx, outcome, tasks| {
                            update_context.persist_task_update_outbox_in_tx(tx, outcome, tasks)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.finish_mutation(outcome, outbox)
            }
            TaskUpdateParams::CancelAndReplace {
                id,
                reason,
                replacement,
            } => {
                let actor = self.graph_actor(call_ctx)?;
                let reason = normalize_reason(reason).map_err(ToolError::InvalidParams)?;
                let prior = self.read_task(&id).await?;
                let replacement = self.replacement_params(replacement)?;
                let update_context = Arc::clone(&self.ctx);
                let run_id = self.ctx.org_context.run_id.clone();
                let expected_updated_at = prior.updated_at;
                let (outcome, replacement, outbox) = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::cancel_and_replace_with_transactional_effects(
                        actor,
                        &run_id,
                        &id,
                        &expected_updated_at,
                        reason,
                        replacement,
                        |tx, outcome, replacement, tasks| {
                            let mut outbox = update_context
                                .persist_task_update_outbox_in_tx(tx, outcome, tasks)?;
                            let created = update_context.persist_created_tasks_outbox_in_tx(
                                tx,
                                std::slice::from_ref(replacement),
                                tasks,
                            )?;
                            merge_outbox(&mut outbox, created);
                            Ok(outbox)
                        },
                    )
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                self.ctx.wake_committed_task_outbox(&outbox);
                serde_json::to_string(&json!({
                    "task": task_to_json(&outcome.current),
                    "replacement": task_to_json(&replacement),
                    "status_changed": true,
                    "replacement_created": true,
                }))
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
            }
            TaskUpdateParams::AppendProgress { id, body } => {
                self.append_owner_annotation(call_ctx, id, TaskAnnotationKind::Progress, body)
                    .await
            }
            TaskUpdateParams::AppendEvidence { id, body } => {
                self.append_owner_annotation(call_ctx, id, TaskAnnotationKind::Evidence, body)
                    .await
            }
            TaskUpdateParams::AppendAuditNote { id, body } => {
                let actor = self.graph_actor(call_ctx)?;
                let run_id = self.ctx.org_context.run_id.clone();
                let annotation = tokio::task::spawn_blocking(move || {
                    AgentOrgTaskStore::append_audit_annotation(actor, &run_id, &id, body)
                })
                .await
                .map_err(join_error)?
                .map_err(map_task_write_error)?;
                serde_json::to_string(&json!({ "annotation": annotation }))
                    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
            }
        }
    }

    fn is_read_only(&self) -> bool {
        false
    }
}

impl TaskUpdateTool {
    fn parse_model_params(&self, params_value: &mut Value) -> Result<TaskUpdateParams, Value> {
        let Some(params) = params_value.as_object_mut() else {
            return Err(task_update_correction(
                self.ctx.is_coordinator(),
                None,
                Vec::new(),
                "task_update parameters must be a JSON object",
            ));
        };
        let operation = params
            .get("operation")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(operation_name) = operation.as_deref() else {
            return Err(task_update_correction(
                self.ctx.is_coordinator(),
                None,
                Vec::new(),
                "operation is required and must be a string",
            ));
        };
        let Some(contract) = task_update_operation_contract(operation_name) else {
            return Err(task_update_correction(
                self.ctx.is_coordinator(),
                Some(operation_name),
                Vec::new(),
                "unknown task_update operation",
            ));
        };
        let expected_authority = if self.ctx.is_coordinator() {
            TaskUpdateAuthority::Coordinator
        } else {
            TaskUpdateAuthority::Owner
        };
        if contract.authority != expected_authority {
            return Err(task_update_correction(
                self.ctx.is_coordinator(),
                Some(operation_name),
                Vec::new(),
                "operation is outside this caller's persisted Task authority",
            ));
        }

        // Some providers populate every property in a portable flat schema.
        // Normalize only known fields from another operation when their value
        // is semantically empty. Fields used by the selected operation remain
        // untouched for the typed parser, and unknown or meaningful fields
        // stay fail-closed.
        let keys = params.keys().cloned().collect::<Vec<_>>();
        let mut unexpected_fields = Vec::new();
        for key in keys {
            if contract.allowed_fields.contains(&key.as_str()) {
                continue;
            }
            let removable_placeholder = params
                .get(&key)
                .is_some_and(|value| is_removable_cross_operation_placeholder(&key, value));
            if removable_placeholder {
                params.remove(&key);
            } else {
                unexpected_fields.push(key);
            }
        }
        unexpected_fields.sort();
        if !unexpected_fields.is_empty() {
            return Err(task_update_correction(
                self.ctx.is_coordinator(),
                Some(operation_name),
                unexpected_fields,
                "fields from another task_update operation are not accepted",
            ));
        }

        parse_params(params_value.take()).map_err(|error| {
            task_update_correction(
                self.ctx.is_coordinator(),
                Some(operation_name),
                Vec::new(),
                &error.to_string(),
            )
        })
    }

    fn graph_actor(&self, call_ctx: &CallContext) -> Result<TaskGraphWriterAdmin, ToolError> {
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "This task_update operation requires the Coordinator graph writer".to_string(),
            ));
        }
        TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
            .map_err(ToolError::InvalidParams)
    }

    fn owner_actor(&self, call_ctx: &CallContext) -> Result<TaskOwnerExecution, ToolError> {
        if self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "Coordinator cannot execute an Owner lifecycle operation".to_string(),
            ));
        }
        TaskOwnerExecution::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
            .map_err(ToolError::InvalidParams)
    }

    async fn read_task(
        &self,
        id: &str,
    ) -> Result<crate::coordination::agent_org_tasks::Task, ToolError> {
        let run_id = self.ctx.org_context.run_id.clone();
        let task_id = id.to_string();
        tokio::task::spawn_blocking(move || AgentOrgTaskStore::get(&run_id, &task_id))
            .await
            .map_err(join_error)?
            .map_err(ToolError::ExecutionFailed)?
            .ok_or_else(|| ToolError::InvalidParams(format!("task_not_found: {id}")))
    }

    fn replacement_params(
        &self,
        replacement: ReplacementTaskParams,
    ) -> Result<CreatePendingTaskParams, ToolError> {
        validate_freeform_task_metadata(replacement.metadata.as_ref())
            .map_err(ToolError::InvalidParams)?;
        let owner = replacement
            .owner_member_id
            .as_deref()
            .map(|owner| self.ctx.resolve_owner_member_id(owner))
            .transpose()
            .map_err(ToolError::InvalidParams)?;
        reject_coordinator_owner(owner.as_deref())?;
        let eligible_member_ids = replacement
            .eligible_member_ids
            .map(|ids| self.ctx.resolve_eligible_member_ids(ids))
            .transpose()
            .map_err(ToolError::InvalidParams)?;
        if owner.is_none() && eligible_member_ids.as_ref().is_none_or(Vec::is_empty) {
            return Err(ToolError::InvalidParams(
                "ownerless replacement requires eligible_member_ids".to_string(),
            ));
        }
        let metadata = merge_graph_metadata(
            None,
            replacement.metadata,
            eligible_member_ids,
            replacement.required_role,
        )?;
        Ok(CreatePendingTaskParams {
            id: replacement
                .id
                .filter(|id| !id.trim().is_empty())
                .unwrap_or_else(crate::coordination::agent_org_tasks::new_task_id),
            org_run_id: self.ctx.org_context.run_id.clone(),
            subject: replacement.subject,
            description: replacement.description.unwrap_or_default(),
            active_form: replacement.active_form,
            owner,
            execution_mode: TaskExecutionMode::from_wire(&replacement.execution_mode)
                .map_err(ToolError::InvalidParams)?,
            blocked_by: replacement.blocked_by,
            metadata,
            originating_message_id: None,
            replaces_task_id: None,
        })
    }

    async fn append_owner_annotation(
        &self,
        call_ctx: &CallContext,
        id: String,
        kind: TaskAnnotationKind,
        body: String,
    ) -> Result<String, ToolError> {
        let actor = self.owner_actor(call_ctx)?;
        let run_id = self.ctx.org_context.run_id.clone();
        let annotation = tokio::task::spawn_blocking(move || {
            AgentOrgTaskStore::append_owner_annotation(actor, &run_id, &id, kind, body)
        })
        .await
        .map_err(join_error)?
        .map_err(map_task_write_error)?;
        serde_json::to_string(&json!({ "annotation": annotation }))
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
    }

    fn finish_mutation(
        &self,
        outcome: crate::coordination::agent_org_tasks::TaskMutationOutcome,
        outbox: TaskOutboxCommit,
    ) -> Result<String, ToolError> {
        self.ctx.wake_committed_task_outbox(&outbox);
        serde_json::to_string(&json!({
            "task": task_to_json(&outcome.current),
            "owner_changed": outcome.owner_changed,
            "status_changed": outcome.status_changed,
            "task_assigned_dispatched": outbox.task_assigned_ids.contains(&outcome.current.id),
            "unblocked_task_assigned_ids": outbox.unblocked_task_assigned_ids,
            "assignment_required_task_ids": outbox.assignment_required_task_ids,
            "task_completed_notified": outbox.task_completed_notified,
            "remaining_open_task_count": outbox.remaining_open_task_count,
        }))
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
    }
}

fn normalize_output(output: TaskOutputParams) -> Result<TaskOutputInput, String> {
    let summary = output.summary.trim();
    if summary.is_empty() {
        return Err("Task output requires a non-empty summary".to_string());
    }
    let content = output
        .content
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty());
    let mut artifact_ids = Vec::new();
    for artifact_id in output.artifact_ids {
        let artifact_id = artifact_id.trim();
        if !artifact_id.is_empty() && !artifact_ids.iter().any(|existing| existing == artifact_id) {
            artifact_ids.push(artifact_id.to_string());
        }
    }
    Ok(TaskOutputInput {
        summary: summary.to_string(),
        content,
        artifact_ids,
    })
}

fn normalize_reason(reason: TaskReasonParams) -> Result<TaskTerminalReason, String> {
    let code = reason.code.trim();
    let message = reason.message.trim();
    if code.is_empty() || message.is_empty() {
        return Err("Task reason requires non-empty code and message".to_string());
    }
    Ok(TaskTerminalReason {
        code: code.to_string(),
        message: message.to_string(),
    })
}

fn merge_graph_metadata(
    existing: Option<Value>,
    patch: Option<Value>,
    eligible_member_ids: Option<Vec<String>>,
    required_role: Option<String>,
) -> Result<Option<Value>, ToolError> {
    let mut object = match existing {
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(ToolError::ExecutionFailed(
                "persisted task metadata is not an object".to_string(),
            ))
        }
        None => Map::new(),
    };
    if let Some(patch) = patch {
        let patch = patch.as_object().ok_or_else(|| {
            ToolError::InvalidParams("metadata patch must be an object".to_string())
        })?;
        for (key, value) in patch {
            if value.is_null() {
                object.remove(key);
            } else {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(ids) = eligible_member_ids {
        object.insert("eligible_member_ids".to_string(), json!(ids));
    }
    if let Some(role) = required_role {
        let role = role.trim();
        if role.is_empty() {
            object.remove("required_role");
        } else {
            object.insert("required_role".to_string(), Value::String(role.to_string()));
        }
    }
    Ok((!object.is_empty()).then_some(Value::Object(object)))
}

fn reject_coordinator_owner(owner: Option<&str>) -> Result<(), ToolError> {
    if owner == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID) {
        Err(ToolError::InvalidParams(
            "Coordinator cannot be a formal Task Owner".to_string(),
        ))
    } else {
        Ok(())
    }
}

fn merge_outbox(target: &mut TaskOutboxCommit, incoming: TaskOutboxCommit) {
    target.task_assigned_ids.extend(incoming.task_assigned_ids);
    target
        .unblocked_task_assigned_ids
        .extend(incoming.unblocked_task_assigned_ids);
    target.task_completed_notified |= incoming.task_completed_notified;
    target.remaining_open_task_count = incoming.remaining_open_task_count;
    target
        .assignment_required_task_ids
        .extend(incoming.assignment_required_task_ids);
    target.wake_member_ids.extend(incoming.wake_member_ids);
    target.task_assigned_ids.sort();
    target.task_assigned_ids.dedup();
    target.assignment_required_task_ids.sort();
    target.assignment_required_task_ids.dedup();
    target.wake_member_ids.sort();
    target.wake_member_ids.dedup();
}

fn join_error(error: tokio::task::JoinError) -> ToolError {
    ToolError::ExecutionFailed(format!("task_update worker failed: {error}"))
}
