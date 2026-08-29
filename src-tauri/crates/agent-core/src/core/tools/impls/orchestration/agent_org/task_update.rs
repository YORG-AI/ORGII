use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::OptionalExtension;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_task_handoffs::{
    CreateTaskExecutionHandoff, HandoffRuntimeEvidence, TaskExecutionHandoffReceipt,
    TaskExecutionHandoffState,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreatePendingTaskParams, PendingTaskGraphPatch, TaskAnnotationKind,
    TaskCancelAndReplaceInput, TaskExecutionMode, TaskGraphWriterAdmin, TaskOutputInput,
    TaskOwnerExecution, TaskStatus, TaskTerminalReason,
};
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{parse_params, CallContext, Tool, ToolError};

use super::{
    classify_task_receipt_error, merge_task_metadata, task_to_json,
    validate_freeform_task_metadata, TaskOutboxCommit, TaskToolsContext,
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
    #[serde(default)]
    pub source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplacementTaskParams {
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

const GRAPH_OPERATIONS: &[&str] = &[
    "patch_pending",
    "cancel",
    "cancel_and_replace",
    "append_audit_note",
];
const OWNER_OPERATIONS: &[&str] = &[
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
const TASK_REASON_FIELDS: &[&str] = &["code", "message", "source_event_id"];
const REPLACEMENT_TASK_FIELDS: &[&str] = &[
    // Historical provider-expanded placeholders may still contain an empty
    // id even though durable replacement ids are no longer model-facing.
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
    Graph,
    Owner,
}

struct TaskUpdateOperationContract {
    authority: TaskUpdateAuthority,
    allowed_fields: &'static [&'static str],
}

fn task_update_operation_contract(operation: &str) -> Option<TaskUpdateOperationContract> {
    Some(match operation {
        "patch_pending" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Graph,
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
            authority: TaskUpdateAuthority::Graph,
            allowed_fields: &["operation", "id", "reason"],
        },
        "cancel_and_replace" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Graph,
            allowed_fields: &["operation", "id", "reason", "replacement"],
        },
        "append_progress" | "append_evidence" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Owner,
            allowed_fields: &["operation", "id", "body"],
        },
        "append_audit_note" => TaskUpdateOperationContract {
            authority: TaskUpdateAuthority::Graph,
            allowed_fields: &["operation", "id", "body"],
        },
        _ => return None,
    })
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

fn task_update_correction(
    allowed_operations: &[&str],
    operation: Option<&str>,
    unexpected_fields: Vec<String>,
    reason: &str,
) -> Value {
    let allowed_fields = operation
        .and_then(task_update_operation_contract)
        .map(|contract| contract.allowed_fields)
        .unwrap_or(&[]);
    json!({
        "needs_correction": true,
        "tool": tool_names::TASK_UPDATE,
        "operation": operation,
        "reason": reason,
        "unexpected_fields": unexpected_fields,
        "allowed_operations": allowed_operations,
        "allowed_fields": allowed_fields,
        "guidance": "Retry once using only fields allowed for the selected operation. Empty fields from other operations are ignored for provider compatibility; meaningful or unknown fields fail closed."
    })
}

fn task_update_parameters(allow_graph: bool, allow_owner: bool) -> Value {
    let operations = GRAPH_OPERATIONS
        .iter()
        .copied()
        .filter(|_| allow_graph)
        .chain(OWNER_OPERATIONS.iter().copied().filter(|_| allow_owner))
        .collect::<Vec<_>>();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["operation", "id"],
        "properties": {
            "operation": { "type": "string", "enum": operations },
            "id": { "type": "string" },
            "subject": { "type": "string" },
            "description": { "type": "string" },
            "active_form": { "type": "string" },
            "clear_active_form": { "type": "boolean" },
            "owner_member_id": { "type": "string" },
            "clear_owner": { "type": "boolean" },
            "execution_mode": { "type": "string", "enum": ["plan", "build"] },
            "blocked_by": { "type": "array", "items": { "type": "string" } },
            "metadata": { "type": "object", "additionalProperties": true },
            "eligible_member_ids": { "type": "array", "items": { "type": "string" } },
            "required_role": { "type": "string" },
            "body": { "type": "string" },
            "output": {
                "type": "object",
                "additionalProperties": false,
                "required": ["summary"],
                "properties": {
                    "summary": { "type": "string" },
                    "content": { "type": "string" },
                    "artifact_ids": { "type": "array", "items": { "type": "string" } }
                }
            },
            "reason": {
                "type": "object",
                "additionalProperties": false,
                "required": ["code", "message"],
                "properties": {
                    "code": { "type": "string" },
                    "message": { "type": "string" },
                    "source_event_id": { "type": "string" }
                }
            },
            "replacement": {
                "type": "object",
                "additionalProperties": false,
                "required": ["subject", "execution_mode"],
                "properties": {
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
            }
        }
    })
}

enum PreparedTaskUpdate {
    Patch {
        actor: TaskGraphWriterAdmin,
        id: String,
        patch: PendingTaskGraphPatch,
    },
    Start {
        actor: TaskOwnerExecution,
        id: String,
    },
    Complete {
        actor: TaskOwnerExecution,
        id: String,
        output: TaskOutputInput,
    },
    Fail {
        actor: TaskOwnerExecution,
        id: String,
        reason: TaskTerminalReason,
    },
    Cancel {
        actor: TaskGraphWriterAdmin,
        id: String,
        reason: TaskTerminalReason,
    },
    CancelAndReplace {
        actor: TaskGraphWriterAdmin,
        id: String,
        reason: TaskTerminalReason,
        replacement: CreatePendingTaskParams,
    },
    OwnerAnnotation {
        actor: TaskOwnerExecution,
        id: String,
        kind: TaskAnnotationKind,
        body: String,
    },
    AuditAnnotation {
        actor: TaskGraphWriterAdmin,
        id: String,
        body: String,
    },
}

impl PreparedTaskUpdate {
    fn handoff_target_id(&self) -> Option<&str> {
        match self {
            Self::Cancel { id, .. } | Self::CancelAndReplace { id, .. } => Some(id),
            _ => None,
        }
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

pub(crate) async fn prepare_handoff_runtime_evidence(
    context: &TaskToolsContext,
    task_id: &str,
) -> Result<Option<HandoffRuntimeEvidence>, String> {
    let run_id = context.org_context.run_id.clone();
    let task_id = task_id.to_string();
    let running = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        crate::coordination::agent_org_task_handoffs::running_target(&conn, &run_id, &task_id)
    })
    .await
    .map_err(|error| format!("Task handoff target worker failed: {error}"))??;
    let Some((session_id, turn_intent_id, _owner_member_id, _generation)) = running else {
        return Ok(None);
    };
    let Some(state) = context.app_state.as_ref() else {
        return Ok(None);
    };
    let Some(session) = state.get_session(&session_id).await else {
        return Ok(None);
    };
    let Some(identity) = session.runtime_turn_identity().await else {
        return Ok(None);
    };
    if identity.turn_intent_id.as_deref() != Some(turn_intent_id.as_str()) {
        return Ok(None);
    }
    Ok(Some(HandoffRuntimeEvidence {
        old_session_id: session_id,
        old_turn_intent_id: turn_intent_id,
        runtime_lease_id: identity.runtime_lease_id,
        dialog_turn_generation: identity.dialog_turn_generation,
    }))
}

pub(crate) async fn drive_committed_handoff(
    context: Arc<TaskToolsContext>,
    mut receipt: TaskExecutionHandoffReceipt,
) -> Result<(), ToolError> {
    if !matches!(
        receipt.state,
        TaskExecutionHandoffState::Requested | TaskExecutionHandoffState::Yielding
    ) {
        return Ok(());
    }
    let Some(state) = context.app_state.as_ref() else {
        return Ok(());
    };
    let (Some(session_id), Some(turn_intent_id), Some(runtime_lease_id), Some(dialog_generation)) = (
        receipt.old_session_id.clone(),
        receipt.old_turn_intent_id.clone(),
        receipt.runtime_lease_id.clone(),
        receipt.dialog_turn_generation.clone(),
    ) else {
        return Ok(());
    };
    let process_owner = crate::tools::call_context::TurnProcessOwner {
        session_id: session_id.clone(),
        turn_intent_id: turn_intent_id.clone(),
        runtime_lease_id: runtime_lease_id.clone(),
        dialog_turn_generation: dialog_generation.clone(),
    };
    let session = state.get_session(&session_id).await;

    let exact_live_turn = match session.as_ref() {
        Some(session) => session
            .runtime_turn_identity()
            .await
            .is_some_and(|identity| {
                identity.runtime_lease_id == runtime_lease_id
                    && identity.dialog_turn_generation == dialog_generation
                    && identity.turn_intent_id.as_deref() == Some(turn_intent_id.as_str())
            }),
        None => false,
    };
    if !exact_live_turn {
        let run_id = receipt.org_run_id.clone();
        let persisted_session_id = session_id.clone();
        let persisted_turn_id = turn_intent_id.clone();
        let terminal = tokio::task::spawn_blocking(move || {
            let conn = database::db::get_connection().map_err(|error| error.to_string())?;
            let status: Option<String> = conn
                .query_row(
                    "SELECT status FROM session_turn_intents
                     WHERE session_id=?1 AND turn_intent_id=?2 AND org_run_id=?3",
                    rusqlite::params![persisted_session_id, persisted_turn_id, run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(status.is_some_and(|status| {
                matches!(
                    status.as_str(),
                    "completed" | "failed" | "cancelled" | "abandoned"
                )
            }))
        })
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
        .map_err(ToolError::ExecutionFailed)?;
        if !terminal
            || !crate::tools::impls::coding::exec::registry::owned_jobs_are_terminal(&process_owner)
        {
            let receipt_id = receipt.id.clone();
            let local_effect_count =
                crate::coordination::agent_org_task_execution_fence::active_effect_count(
                    &receipt.org_run_id,
                    &receipt.old_task_id,
                );
            tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_task_handoffs::mark_unknown(
                    &receipt_id,
                    local_effect_count,
                )
            })
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
            .map_err(ToolError::ExecutionFailed)?;
            return Ok(());
        }
    }

    if receipt.state == TaskExecutionHandoffState::Requested {
        let receipt_id = receipt.id.clone();
        receipt = tokio::task::spawn_blocking(move || {
            crate::coordination::agent_org_task_handoffs::mark_yielding(&receipt_id)
        })
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
        .map_err(ToolError::ExecutionFailed)?;
    }

    if let Some(session) = session.as_ref().filter(|_| exact_live_turn) {
        session
            .cancel_active_turn(crate::state::control_flow::CancelReason::OrgTaskHandoff)
            .await;
        let (turn_released, jobs_released) = tokio::join!(
            session.wait_for_turn_end(&turn_intent_id, Duration::from_secs(5)),
            crate::tools::impls::coding::exec::registry::cancel_and_await_jobs_for_owner(
                &process_owner,
                Duration::from_secs(5),
            )
        );
        if !turn_released || jobs_released.is_err() {
            let receipt_id = receipt.id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_task_handoffs::mark_slo_missed(&receipt_id)
            })
            .await;
            let (turn_released, jobs_released) = tokio::join!(
                session.wait_for_turn_end(&turn_intent_id, Duration::from_secs(5)),
                crate::tools::impls::coding::exec::registry::cancel_and_await_jobs_for_owner(
                    &process_owner,
                    Duration::from_secs(5),
                )
            );
            if !turn_released || jobs_released.is_err() {
                let receipt_id = receipt.id.clone();
                let local_effect_count =
                    crate::coordination::agent_org_task_execution_fence::active_effect_count(
                        &receipt.org_run_id,
                        &receipt.old_task_id,
                    );
                tokio::task::spawn_blocking(move || {
                    crate::coordination::agent_org_task_handoffs::mark_timeout(
                        &receipt_id,
                        local_effect_count,
                    )
                })
                .await
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
                .map_err(ToolError::ExecutionFailed)?;
                return Ok(());
            }
        }

        let released_runtime = session
            .release_runtime_if_current(&runtime_lease_id, &dialog_generation)
            .await
            || session
                .release_yielded_runtime_if_idle(&runtime_lease_id)
                .await;
        if !released_runtime
            && session
                .runtime_lease_identity()
                .await
                .is_some_and(|identity| identity.runtime_lease_id == runtime_lease_id)
        {
            let receipt_id = receipt.id.clone();
            tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_task_handoffs::mark_unknown(&receipt_id, 0)
            })
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
            .map_err(ToolError::ExecutionFailed)?;
            return Ok(());
        }
    }

    let local_effect_count =
        crate::coordination::agent_org_task_execution_fence::active_effect_count(
            &receipt.org_run_id,
            &receipt.old_task_id,
        );
    if local_effect_count != 0 {
        let receipt_id = receipt.id.clone();
        tokio::task::spawn_blocking(move || {
            crate::coordination::agent_org_task_handoffs::mark_unknown(
                &receipt_id,
                local_effect_count,
            )
        })
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
        .map_err(ToolError::ExecutionFailed)?;
        return Ok(());
    }

    let receipt_id = receipt.id.clone();
    let release_context = Arc::clone(&context);
    let outbox = tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| -> Result<_, String> {
            let conn = database::db::get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let current = crate::coordination::agent_org_task_handoffs::load_with_connection(
                &tx,
                &receipt_id,
            )?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
            let tasks = AgentOrgTaskStore::list_with_connection(&tx, &current.org_run_id)?;
            let mut outbox = TaskOutboxCommit::default();
            if let Some(replacement_task_id) = current.replacement_task_id.as_deref() {
                let replacement = tasks
                    .iter()
                    .find(|task| task.id == replacement_task_id)
                    .ok_or_else(|| {
                        format!("task_execution_handoff_replacement_missing:{replacement_task_id}")
                    })?;
                if replacement.status != TaskStatus::Pending {
                    return Err(format!(
                        "task_execution_handoff_replacement_not_pending:{}",
                        replacement.status.as_wire()
                    ));
                }
                outbox = release_context.persist_created_tasks_outbox_in_tx(
                    &tx,
                    std::slice::from_ref(replacement),
                    &tasks,
                    None,
                )?;
            }
            crate::coordination::agent_org_task_handoffs::mark_released_in_tx(&tx, &receipt_id, 0)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(outbox)
        })
    })
    .await
    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
    .map_err(ToolError::ExecutionFailed)?;
    context.wake_committed_task_outbox(&outbox);
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
        &context.org_context.run_id,
    );
    Ok(())
}

#[async_trait]
impl Tool for TaskUpdateTool {
    fn name(&self) -> &str {
        tool_names::TASK_UPDATE
    }

    fn description(&self) -> &str {
        "Apply one exactly-once Task operation. Graph writers manage sparse pending fields, cancellation, replacement, and terminal audit notes. A Task Owner may start, complete, fail, or annotate only the Task bound to the exact persisted TaskExecution turn. A configured Writer has both sets of operations but still cannot execute another Task's Owner lifecycle."
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nYour Task authority: {}",
            self.description(),
            self.ctx.task_authority_summary()
        ))
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        task_update_parameters(self.ctx.is_task_graph_writer(), !self.ctx.is_coordinator())
    }

    async fn execute_text(
        &self,
        mut params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        let (params, canonical_params, operation) = match self.parse_model_params(&mut params_value)
        {
            Ok(parsed) => parsed,
            Err(correction) => {
                return serde_json::to_string(&correction)
                    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
            }
        };
        let prepared = self.prepare_update(params, call_ctx)?;
        let handoff_target_id = prepared.handoff_target_id().map(str::to_string);
        let handoff_guard = match handoff_target_id.as_deref() {
            Some(task_id) => Some(
                crate::coordination::agent_org_task_execution_fence::acquire_handoff(
                    &self.ctx.org_context.run_id,
                    task_id,
                )
                .await,
            ),
            None => None,
        };
        let handoff_runtime_evidence = match handoff_target_id.as_deref() {
            Some(task_id) => prepare_handoff_runtime_evidence(&self.ctx, task_id)
                .await
                .map_err(ToolError::ExecutionFailed)?,
            None => None,
        };
        let handoff_authority = handoff_guard.as_ref().map(|fence| fence.authority());
        let receipt_key = AgentOrgToolReceiptKey::from_call_context(
            self.ctx.org_context.run_id.clone(),
            call_ctx,
        )?;
        let run_id = self.ctx.org_context.run_id.clone();
        let context = Arc::clone(&self.ctx);
        let source_turn_intent_id = call_ctx.turn_intent_id.clone();
        let handoff_request_id = call_ctx.call_id.clone();
        let handoff_request_digest =
            crate::coordination::agent_org_task_handoffs::canonical_request_digest(
                &canonical_params,
            )
            .map_err(ToolError::ExecutionFailed)?;

        let (receipt, committed_outbox, did_mutate) = tokio::task::spawn_blocking(move || {
            let mut committed_outbox: Option<TaskOutboxCommit> = None;
            let mut did_mutate = false;
            let receipt = AgentOrgToolReceiptStore::execute(
                receipt_key,
                tool_names::TASK_UPDATE,
                &operation,
                &canonical_params,
                |tx| {
                    let result: Result<String, String> = match prepared {
                        PreparedTaskUpdate::Patch { actor, id, patch } => {
                            AgentOrgTaskStore::patch_pending_in_tx(
                                tx,
                                actor,
                                &run_id,
                                &id,
                                patch,
                                |tx, outcome, tasks| {
                                    context.persist_task_update_outbox_in_tx(
                                        tx,
                                        outcome,
                                        tasks,
                                        Some(&source_turn_intent_id),
                                    )
                                },
                            )
                            .and_then(|(outcome, outbox)| {
                                let response = mutation_response(&outcome, &outbox)?;
                                committed_outbox = Some(outbox);
                                did_mutate = true;
                                Ok(response)
                            })
                        }
                        PreparedTaskUpdate::Start { actor, id } => {
                            AgentOrgTaskStore::owner_start_in_tx(
                                tx,
                                actor,
                                &run_id,
                                &id,
                                |tx, outcome, tasks| {
                                    context.persist_task_update_outbox_in_tx(
                                        tx,
                                        outcome,
                                        tasks,
                                        Some(&source_turn_intent_id),
                                    )
                                },
                            )
                            .and_then(|(outcome, outbox)| {
                                let response = mutation_response(&outcome, &outbox)?;
                                did_mutate = outcome.status_changed;
                                committed_outbox = Some(outbox);
                                Ok(response)
                            })
                        }
                        PreparedTaskUpdate::Complete { actor, id, output } => {
                            AgentOrgTaskStore::owner_complete_in_tx(
                                tx,
                                actor,
                                &run_id,
                                &id,
                                output,
                                |tx, outcome, tasks| {
                                    context.persist_task_update_outbox_in_tx(
                                        tx,
                                        outcome,
                                        tasks,
                                        Some(&source_turn_intent_id),
                                    )
                                },
                            )
                            .and_then(|(outcome, outbox)| {
                                let response = mutation_response(&outcome, &outbox)?;
                                committed_outbox = Some(outbox);
                                did_mutate = true;
                                Ok(response)
                            })
                        }
                        PreparedTaskUpdate::Fail { actor, id, reason } => {
                            AgentOrgTaskStore::owner_fail_in_tx(
                                tx,
                                actor,
                                &run_id,
                                &id,
                                reason,
                                |tx, outcome, tasks| {
                                    context.persist_task_update_outbox_in_tx(
                                        tx,
                                        outcome,
                                        tasks,
                                        Some(&source_turn_intent_id),
                                    )
                                },
                            )
                            .and_then(|(outcome, outbox)| {
                                let response = mutation_response(&outcome, &outbox)?;
                                committed_outbox = Some(outbox);
                                did_mutate = true;
                                Ok(response)
                            })
                        }
                        PreparedTaskUpdate::Cancel { actor, id, reason } => {
                            let mutation = match handoff_authority.as_ref() {
                                Some(authority) => AgentOrgTaskStore::cancel_with_handoff_in_tx(
                                    tx,
                                    actor,
                                    &run_id,
                                    &id,
                                    reason,
                                    authority,
                                    |tx, outcome, tasks| {
                                    let mut outbox = context
                                        .persist_task_update_outbox_in_tx(
                                            tx,
                                            outcome,
                                            tasks,
                                            Some(&source_turn_intent_id),
                                        )?;
                                    if outcome.previous.status == TaskStatus::InProgress {
                                        outbox.execution_handoff = Some(
                                            crate::coordination::agent_org_task_handoffs::create_in_tx(
                                                tx,
                                                CreateTaskExecutionHandoff {
                                                    request_id: &handoff_request_id,
                                                    request_digest: &handoff_request_digest,
                                                    old_task: &outcome.previous,
                                                    replacement_task: None,
                                                    runtime_evidence: handoff_runtime_evidence.as_ref(),
                                                    external_effect_unknown: crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
                                                        tx,
                                                        &outcome.previous.org_run_id,
                                                        &outcome.previous.id,
                                                    )?,
                                                },
                                            )?,
                                        );
                                    }
                                    Ok(outbox)
                                    },
                                ),
                                None => Err("task_cancel_missing_handoff_authority".to_string()),
                            };
                            mutation.and_then(|(outcome, outbox)| {
                                let response = mutation_response(&outcome, &outbox)?;
                                committed_outbox = Some(outbox);
                                did_mutate = true;
                                Ok(response)
                            })
                        }
                        PreparedTaskUpdate::CancelAndReplace {
                            actor,
                            id,
                            reason,
                            mut replacement,
                        } => {
                            replacement.id = crate::coordination::agent_org_tasks::new_task_id();
                            let mutation = match handoff_authority.as_ref() {
                                Some(authority) => AgentOrgTaskStore::cancel_and_replace_with_handoff_in_tx(
                                    tx,
                                    actor,
                                    &run_id,
                                    &id,
                                    TaskCancelAndReplaceInput {
                                        reason,
                                        replacement,
                                        handoff: Some(authority),
                                    },
                                    |tx, outcome, replacement, tasks| {
                                    let mut outbox = context
                                        .persist_task_update_outbox_in_tx(
                                            tx,
                                            outcome,
                                            tasks,
                                            Some(&source_turn_intent_id),
                                        )?;
                                    if outcome.previous.status == TaskStatus::InProgress {
                                        outbox.execution_handoff = Some(
                                            crate::coordination::agent_org_task_handoffs::create_in_tx(
                                                tx,
                                                CreateTaskExecutionHandoff {
                                                    request_id: &handoff_request_id,
                                                    request_digest: &handoff_request_digest,
                                                    old_task: &outcome.previous,
                                                    replacement_task: Some(replacement),
                                                    runtime_evidence: handoff_runtime_evidence.as_ref(),
                                                    external_effect_unknown: crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
                                                        tx,
                                                        &outcome.previous.org_run_id,
                                                        &outcome.previous.id,
                                                    )?,
                                                },
                                            )?,
                                        );
                                    } else {
                                        let created = context.persist_created_tasks_outbox_in_tx(
                                            tx,
                                            std::slice::from_ref(replacement),
                                            tasks,
                                            Some(&source_turn_intent_id),
                                        )?;
                                        merge_outbox(&mut outbox, created);
                                    }
                                    Ok(outbox)
                                    },
                                ),
                                None => Err("task_replacement_missing_handoff_authority".to_string()),
                            };
                            mutation.and_then(
                                |(outcome, replacement, outbox)| {
                                    let response = serde_json::to_string(&json!({
                                        "task": task_to_json(&outcome.current),
                                        "replacement": task_to_json(&replacement),
                                        "status_changed": true,
                                        "replacement_created": true,
                                        "execution_handoff": outbox.execution_handoff,
                                    }))
                                    .map_err(|error| error.to_string())?;
                                    committed_outbox = Some(outbox);
                                    did_mutate = true;
                                    Ok(response)
                                },
                            )
                        }
                        PreparedTaskUpdate::OwnerAnnotation {
                            actor,
                            id,
                            kind,
                            body,
                        } => AgentOrgTaskStore::append_owner_annotation_in_tx(
                            tx, actor, &run_id, &id, kind, body,
                        )
                        .and_then(|annotation| {
                            did_mutate = true;
                            serde_json::to_string(&json!({ "annotation": annotation }))
                                .map_err(|error| error.to_string())
                        }),
                        PreparedTaskUpdate::AuditAnnotation { actor, id, body } => {
                            AgentOrgTaskStore::append_audit_annotation_in_tx(
                                tx, actor, &run_id, &id, body,
                            )
                            .and_then(|annotation| {
                                did_mutate = true;
                                serde_json::to_string(&json!({ "annotation": annotation }))
                                    .map_err(|error| error.to_string())
                            })
                        }
                    };
                    match result {
                        Ok(response) => Ok(Ok(response)),
                        Err(error) => match classify_task_receipt_error(error) {
                            Ok(error) => Ok(Err(error)),
                            Err(abort) => Err(abort),
                        },
                    }
                },
            )?;
            Ok::<_, ToolError>((receipt, committed_outbox, did_mutate))
        })
        .await
        .map_err(|error| {
            ToolError::ExecutionFailed(format!("task_update worker failed: {error}"))
        })??;

        // The exclusive permit protected the Task fence transaction. Release
        // it before stopping the old runtime so any late old call can wake,
        // revalidate the cancelled Task, and fail closed.
        drop(handoff_guard);

        if receipt.is_fresh() && did_mutate {
            if let Some(outbox) = committed_outbox.as_ref() {
                self.ctx.wake_committed_task_outbox(outbox);
            }
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                &self.ctx.org_context.run_id,
            );
        }
        let committed_handoff = committed_outbox
            .as_ref()
            .and_then(|outbox| outbox.execution_handoff.clone());
        let handoff = match committed_handoff {
            Some(receipt) => Some(receipt),
            None if handoff_target_id.is_some() => {
                let run_id = self.ctx.org_context.run_id.clone();
                let request_id = call_ctx.call_id.clone();
                tokio::task::spawn_blocking(move || {
                    crate::coordination::agent_org_task_handoffs::load_current_by_request(
                        &run_id,
                        &request_id,
                    )
                })
                .await
                .map_err(|error| {
                    ToolError::ExecutionFailed(format!(
                        "Task handoff replay lookup failed: {error}"
                    ))
                })?
                .map_err(ToolError::ExecutionFailed)?
            }
            None => None,
        };
        if let Some(handoff) = handoff {
            drive_committed_handoff(Arc::clone(&self.ctx), handoff).await?;
        }
        receipt.result
    }

    fn is_read_only(&self) -> bool {
        false
    }
}

impl TaskUpdateTool {
    fn allowed_operations(&self) -> Vec<&'static str> {
        GRAPH_OPERATIONS
            .iter()
            .copied()
            .filter(|_| self.ctx.is_task_graph_writer())
            .chain(
                OWNER_OPERATIONS
                    .iter()
                    .copied()
                    .filter(|_| !self.ctx.is_coordinator()),
            )
            .collect()
    }

    fn parse_model_params(
        &self,
        params_value: &mut Value,
    ) -> Result<(TaskUpdateParams, Value, String), Value> {
        let allowed_operations = self.allowed_operations();
        let Some(params) = params_value.as_object_mut() else {
            return Err(task_update_correction(
                &allowed_operations,
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
                &allowed_operations,
                None,
                Vec::new(),
                "operation is required and must be a string",
            ));
        };
        let Some(contract) = task_update_operation_contract(operation_name) else {
            return Err(task_update_correction(
                &allowed_operations,
                Some(operation_name),
                Vec::new(),
                "unknown task_update operation",
            ));
        };
        if !allowed_operations.contains(&operation_name) {
            return Err(task_update_correction(
                &allowed_operations,
                Some(operation_name),
                Vec::new(),
                "operation is outside this caller's frozen Task authority",
            ));
        }
        if contract.authority == TaskUpdateAuthority::Graph && !self.ctx.is_task_graph_writer() {
            return Err(task_update_correction(
                &allowed_operations,
                Some(operation_name),
                Vec::new(),
                "operation requires graph-writer authority",
            ));
        }

        // Normalize known cross-operation placeholders before both typed
        // parsing and receipt hashing. This preserves provider compatibility
        // without allowing an unknown or meaningful field through the wire
        // boundary.
        let keys = params.keys().cloned().collect::<Vec<_>>();
        let mut unexpected_fields = Vec::new();
        for key in keys {
            if contract.allowed_fields.contains(&key.as_str()) {
                continue;
            }
            if params
                .get(&key)
                .is_some_and(|value| is_removable_cross_operation_placeholder(&key, value))
            {
                params.remove(&key);
            } else {
                unexpected_fields.push(key);
            }
        }
        unexpected_fields.sort();
        if !unexpected_fields.is_empty() {
            return Err(task_update_correction(
                &allowed_operations,
                Some(operation_name),
                unexpected_fields,
                "fields from another task_update operation are not accepted",
            ));
        }
        let canonical_params = params_value.clone();
        let parsed = parse_params(canonical_params.clone()).map_err(|error| {
            task_update_correction(
                &allowed_operations,
                Some(operation_name),
                Vec::new(),
                &error.to_string(),
            )
        })?;
        Ok((parsed, canonical_params, operation_name.to_string()))
    }

    fn prepare_update(
        &self,
        params: TaskUpdateParams,
        call_ctx: &CallContext,
    ) -> Result<PreparedTaskUpdate, ToolError> {
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
                let owner = owner_member_id
                    .as_deref()
                    .map(|owner| self.ctx.resolve_owner_member_id(owner))
                    .transpose()
                    .map_err(ToolError::InvalidParams)?;
                if let Some(owner) = owner.as_ref() {
                    let denied = self
                        .ctx
                        .unauthorized_task_target_member_ids(std::slice::from_ref(owner));
                    if !denied.is_empty() {
                        return Err(ToolError::PermissionDenied(format!(
                            "Task owner is outside frozen Writer authority: {}",
                            denied.join(", ")
                        )));
                    }
                }
                let eligible_member_ids = eligible_member_ids
                    .map(|ids| self.ctx.resolve_eligible_member_ids(ids))
                    .transpose()
                    .map_err(ToolError::InvalidParams)?;
                if let Some(ids) = eligible_member_ids.as_ref() {
                    let denied = self.ctx.unauthorized_task_target_member_ids(ids);
                    if !denied.is_empty() {
                        return Err(ToolError::PermissionDenied(format!(
                            "Task eligibility is outside frozen Writer authority: {}",
                            denied.join(", ")
                        )));
                    }
                }
                Ok(PreparedTaskUpdate::Patch {
                    actor: self.graph_actor(call_ctx)?,
                    id,
                    patch: PendingTaskGraphPatch {
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
                        metadata_merge_patch: metadata,
                        eligible_member_ids,
                        required_role,
                    },
                })
            }
            TaskUpdateParams::Start { id } => Ok(PreparedTaskUpdate::Start {
                actor: self.owner_actor(call_ctx)?,
                id,
            }),
            TaskUpdateParams::Complete { id, output } => Ok(PreparedTaskUpdate::Complete {
                actor: self.owner_actor(call_ctx)?,
                id,
                output: normalize_output(output).map_err(ToolError::InvalidParams)?,
            }),
            TaskUpdateParams::Fail { id, reason } => Ok(PreparedTaskUpdate::Fail {
                actor: self.owner_actor(call_ctx)?,
                id,
                reason: normalize_reason(reason).map_err(ToolError::InvalidParams)?,
            }),
            TaskUpdateParams::Cancel { id, reason } => Ok(PreparedTaskUpdate::Cancel {
                actor: self.graph_actor(call_ctx)?,
                id,
                reason: normalize_reason(reason).map_err(ToolError::InvalidParams)?,
            }),
            TaskUpdateParams::CancelAndReplace {
                id,
                reason,
                replacement,
            } => Ok(PreparedTaskUpdate::CancelAndReplace {
                actor: self.graph_actor(call_ctx)?,
                id,
                reason: normalize_reason(reason).map_err(ToolError::InvalidParams)?,
                replacement: self.replacement_params(replacement)?,
            }),
            TaskUpdateParams::AppendProgress { id, body } => {
                Ok(PreparedTaskUpdate::OwnerAnnotation {
                    actor: self.owner_actor(call_ctx)?,
                    id,
                    kind: TaskAnnotationKind::Progress,
                    body,
                })
            }
            TaskUpdateParams::AppendEvidence { id, body } => {
                Ok(PreparedTaskUpdate::OwnerAnnotation {
                    actor: self.owner_actor(call_ctx)?,
                    id,
                    kind: TaskAnnotationKind::Evidence,
                    body,
                })
            }
            TaskUpdateParams::AppendAuditNote { id, body } => {
                Ok(PreparedTaskUpdate::AuditAnnotation {
                    actor: self.graph_actor(call_ctx)?,
                    id,
                    body,
                })
            }
        }
    }

    fn graph_actor(&self, call_ctx: &CallContext) -> Result<TaskGraphWriterAdmin, ToolError> {
        if !self.ctx.is_task_graph_writer() {
            return Err(ToolError::PermissionDenied(
                "This task_update operation requires frozen graph-writer authority".to_string(),
            ));
        }
        TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
            .map_err(ToolError::InvalidParams)
    }

    fn owner_actor(&self, call_ctx: &CallContext) -> Result<TaskOwnerExecution, ToolError> {
        if self.ctx.is_coordinator() {
            return Err(ToolError::PermissionDenied(
                "Coordinator cannot execute an Owner lifecycle operation".to_string(),
            ));
        }
        let persisted = crate::coordination::agent_org_turn_contexts::require_existing_context(
            &self.ctx.org_context.run_id,
            &call_ctx.session_id,
            &call_ctx.turn_intent_id,
        )
        .map_err(ToolError::PermissionDenied)?;
        if persisted.is_user_directed_work() {
            return Err(ToolError::PermissionDenied(
                "UserDirectedWork cannot execute a formal Task owner lifecycle operation"
                    .to_string(),
            ));
        }
        TaskOwnerExecution::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
            .map_err(ToolError::InvalidParams)
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
        if let Some(owner) = owner.as_ref() {
            let denied = self
                .ctx
                .unauthorized_task_target_member_ids(std::slice::from_ref(owner));
            if !denied.is_empty() {
                return Err(ToolError::PermissionDenied(format!(
                    "Replacement owner is outside frozen Writer authority: {}",
                    denied.join(", ")
                )));
            }
        }
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
        Ok(CreatePendingTaskParams {
            // Minted only after receipt lookup in the transaction closure.
            id: String::new(),
            org_run_id: self.ctx.org_context.run_id.clone(),
            subject: replacement.subject,
            description: replacement.description.unwrap_or_default(),
            active_form: replacement.active_form,
            owner,
            execution_mode: TaskExecutionMode::from_wire(&replacement.execution_mode)
                .map_err(ToolError::InvalidParams)?,
            blocked_by: replacement.blocked_by,
            metadata: merge_task_metadata(
                replacement.metadata,
                eligible_member_ids,
                replacement.required_role,
            ),
            originating_message_id: None,
            replaces_task_id: None,
        })
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
    let source_event_id = reason
        .source_event_id
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty());
    if code == "user_scope_removed" && source_event_id.is_none() {
        return Err("user_scope_removed requires source_event_id".to_string());
    }
    if code != "user_scope_removed" && source_event_id.is_some() {
        return Err("source_event_id is reserved for user_scope_removed".to_string());
    }
    Ok(TaskTerminalReason {
        code: code.to_string(),
        message: message.to_string(),
        source_event_id,
    })
}

fn mutation_response(
    outcome: &crate::coordination::agent_org_tasks::TaskMutationOutcome,
    outbox: &TaskOutboxCommit,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "task": task_to_json(&outcome.current),
        "owner_changed": outcome.owner_changed,
        "status_changed": outcome.status_changed,
        "task_assigned_dispatched": outbox.task_assigned_ids.contains(&outcome.current.id),
        "unblocked_task_assigned_ids": outbox.unblocked_task_assigned_ids,
        "assignment_required_task_ids": outbox.assignment_required_task_ids,
        "task_completed_notified": outbox.task_completed_notified,
        "task_terminal_notified": outbox.task_terminal_notified,
        "remaining_open_task_count": outbox.remaining_open_task_count,
    }))
    .map_err(|error| error.to_string())
}

fn merge_outbox(target: &mut TaskOutboxCommit, incoming: TaskOutboxCommit) {
    target.task_assigned_ids.extend(incoming.task_assigned_ids);
    target
        .unblocked_task_assigned_ids
        .extend(incoming.unblocked_task_assigned_ids);
    target.task_completed_notified |= incoming.task_completed_notified;
    target.task_terminal_notified |= incoming.task_terminal_notified;
    target.remaining_open_task_count = incoming.remaining_open_task_count;
    target
        .assignment_required_task_ids
        .extend(incoming.assignment_required_task_ids);
    target.wake_member_ids.extend(incoming.wake_member_ids);
    if target.execution_handoff.is_none() {
        target.execution_handoff = incoming.execution_handoff;
    }
    target.task_assigned_ids.sort();
    target.task_assigned_ids.dedup();
    target.assignment_required_task_ids.sort();
    target.assignment_required_task_ids.dedup();
    target.wake_member_ids.sort();
    target.wake_member_ids.dedup();
}
