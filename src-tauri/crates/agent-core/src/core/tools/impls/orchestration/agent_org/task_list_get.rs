use std::sync::Arc;

use async_trait::async_trait;
use database::db::get_connection;
use rusqlite::TransactionBehavior;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_payload_limits::validate_task_identifier;
use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::tools::names as tool_names;
use crate::tools::traits::{
    params_schema, parse_params, CallContext, Tool, ToolError, ToolExecuteResult,
};

use super::{compact_task_summary_to_json, parse_status, task_to_json, TaskToolsContext};

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskListParams {
    /// When `true`, only include tasks owned by the calling org member.
    /// Defaults to `false` (every task in the run).
    #[serde(default)]
    pub mine_only: bool,
    /// When set, only include tasks in this status.
    #[serde(default)]
    pub status: Option<String>,
    /// When set, only include tasks owned by this exact member_id.
    #[serde(default)]
    pub owner_member_id: Option<String>,
    /// Maximum summaries returned in this page. Defaults to 50 and is capped
    /// at 200 so a large historical board cannot flood one model turn.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Continue strictly after this durable task id in board order. Use the
    /// `next_cursor` returned by the previous page.
    #[serde(default)]
    pub after_task_id: Option<String>,
}

pub struct TaskListTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskListTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn name(&self) -> &str {
        tool_names::TASK_LIST
    }

    fn description(&self) -> &str {
        concat!(
            "List tasks on the org run's task board. Returns the array in insertion ",
            "order (`created_at` ascending). ",
            "Filter with `mine_only=true` to see only the tasks you own, `status` to ",
            "narrow by `pending` / `in_progress` / `completed` / `failed` / `cancelled`, or `owner_member_id` ",
            "to query a sibling's queue. Combining filters AND-merges them. The response ",
            "returns compact task summaries with a bounded description; when ",
            "`description_truncated=true`, call task_get for the complete durable description. ",
            "Call task_get for raw metadata and full output content. The response always includes an unfiltered `run_summary` ",
            "so a filtered view cannot make the coordinator falsely conclude that the whole run ",
            "is complete. ",
            "Large boards are paginated: pass `limit` (max 200) and feed the returned ",
            "`next_cursor` back as `after_task_id`. ",
            "For the Coordinator, run_summary.completion_candidate is a read-only assessment ",
            "from the same owner that validates org_run_complete. It is never a completion ",
            "certificate or proof of delivery. completion_candidate.state=ready means call ",
            "org_run_complete directly; do not refresh task_list again. ",
            "run_summary.quiescence_decision and current_quiescence_blockers describe whether ",
            "the run may become Idle after a certificate is published, not whether a certificate ",
            "may be requested. ",
            "Zero open tasks alone is not final while a member, inbox delivery, intervention, ",
            "plan approval, or queued worker turn remains active. Only the backend certificate ",
            "returned by org_run_complete can authorize Delivered. Read-only."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn llm_description(&self) -> Option<String> {
        Some(format!(
            "{}\n\nAllowed owner_member_id filter values for this Agent Org run: {}\nUse only `owner_member_id`; do not pass agent_id or display name as ownership.",
            self.description(),
            self.ctx.owner_member_id_catalog()
        ))
    }

    fn parameters(&self) -> Value {
        params_schema::<TaskListParams>()
    }

    async fn execute(
        &self,
        params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<ToolExecuteResult, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        if self.ctx.is_coordinator() {
            let run_id = self.ctx.org_context.run_id.clone();
            let session_id = call_ctx.session_id.clone();
            let turn_intent_id = call_ctx.turn_intent_id.clone();
            let gate = tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_turn_contexts::gate_coordinator_task_list(
                    &run_id,
                    &session_id,
                    &turn_intent_id,
                )
            })
            .await
            .map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "Coordinator observation check worker failed: {error}"
                ))
            })?
            .map_err(ToolError::ExecutionFailed)?;
            match gate {
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskListGate::ReadCurrentSnapshot => {}
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskListGate::InitialEmptyTaskListBypass => {
                    tracing::debug!(
                        org_run_id = %self.ctx.org_context.run_id,
                        session_id = %call_ctx.session_id,
                        turn_intent_id = %call_ctx.turn_intent_id,
                        observation = "initial_empty_task_list_bypass",
                        "[agent_org_metric] coordinator_task_list_bypass"
                    );
                }
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskListGate::WaitForEvent => {
                    tracing::debug!(
                        org_run_id = %self.ctx.org_context.run_id,
                        session_id = %call_ctx.session_id,
                        turn_intent_id = %call_ctx.turn_intent_id,
                        observation = "task_list_repeat",
                        "[agent_org_metric] coordinator_no_progress"
                    );
                    return Ok(ToolExecuteResult::end_turn(
                        serde_json::json!({
                            "code": "coordinator_no_new_work_facts",
                            "terminal_reason": "waiting_for_org_event",
                            "guidance": "The prompt already contains the authoritative Task snapshot for this durable trigger and revision. End this Turn now; a committed Team event will wake the Coordinator."
                        })
                        .to_string(),
                    ));
                }
            }
        }
        self.execute_text(params_value, call_ctx)
            .await
            .map(ToolExecuteResult::text)
    }

    async fn execute_text(
        &self,
        params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        let params: TaskListParams = parse_params(params_value)?;
        let normalized_status = params
            .status
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let status_filter = match normalized_status {
            None => None,
            Some(value) => Some(parse_status(value).map_err(ToolError::InvalidParams)?),
        };
        let owner_filter: Option<String> = if params.mine_only {
            Some(self.ctx.caller_owner_member_id())
        } else {
            match params
                .owner_member_id
                .as_deref()
                .filter(|owner_member_id| !owner_member_id.trim().is_empty())
            {
                Some(owner_member_id) => Some(
                    self.ctx
                        .resolve_owner_member_id(owner_member_id)
                        .map_err(ToolError::InvalidParams)?,
                ),
                None => None,
            }
        };

        let limit = params.limit.unwrap_or(50).clamp(1, 200) as usize;
        let after_task_id = params
            .after_task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(after_task_id) = after_task_id.as_deref() {
            validate_task_identifier("task_list.after_task_id", after_task_id)
                .map_err(ToolError::InvalidParams)?;
        }

        // Task summaries and Team Quiescence facts must describe the same
        // database moment. Use one deferred read transaction and project only
        // bounded columns; routine task_list calls never deserialize full
        // descriptions, raw metadata, or output content for the entire board.
        let run_id = self.ctx.org_context.run_id.clone();
        let read_owner_filter = owner_filter.clone();
        let read_after_task_id = after_task_id.clone();
        let dispatching_session_id = call_ctx.session_id.clone();
        let turn_intent_id = call_ctx.turn_intent_id.clone();
        let projected_inbox_ids = call_ctx.projected_inbox_ids.clone();
        let (
            completion,
            completion_candidate,
            page,
            open_task_ids_preview,
            open_task_ids_truncated,
        ) = tokio::task::spawn_blocking(move || {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .map_err(|err| err.to_string())?;
            let completion = AgentOrgRunStore::quiescence_assessment_with_connection(&tx, &run_id)?;
            let completion_candidate = crate::coordination::agent_org_run_completion::assess_delivered_candidate_from_quiescence_with_connection(
                &tx,
                &run_id,
                &dispatching_session_id,
                &turn_intent_id,
                &projected_inbox_ids,
                &completion,
            );
            let page = AgentOrgTaskStore::list_summary_page_with_connection(
                &tx,
                &run_id,
                status_filter,
                read_owner_filter.as_deref(),
                read_after_task_id.as_deref(),
                limit,
            )?;
            let (open_task_ids_preview, open_task_ids_truncated) =
                AgentOrgTaskStore::open_task_ids_preview_with_connection(&tx, &run_id, 200)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok::<_, String>((
                completion,
                completion_candidate,
                page,
                open_task_ids_preview,
                open_task_ids_truncated,
            ))
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("task_list snapshot worker failed: {err}"))
        })?
        .map_err(|error| {
            if error.starts_with("task_list after_task_id '") {
                ToolError::InvalidParams(error)
            } else {
                ToolError::ExecutionFailed(error)
            }
        })?;

        let active_member_ids = completion.facts.active_member_ids();
        let body = json!({
            "tasks": page.tasks.iter().map(compact_task_summary_to_json).collect::<Vec<_>>(),
            "total": page.tasks.len(),
            "filtered_total": page.filtered_total,
            "page": {
                "limit": limit,
                "after_task_id": after_task_id,
                "has_more": page.has_more,
                "next_cursor": page.next_cursor,
            },
            "filters_applied": {
                "mine_only": params.mine_only,
                "status": normalized_status,
                "owner_member_id": owner_filter,
            },
            "run_summary": {
                "run_status": completion.facts.run_status.map(|status| status.as_str()),
                "total": completion.facts.task_count,
                "open": completion.facts.unresolved_task_count,
                "pending": completion.facts.pending_task_count,
                "in_progress": completion.facts.in_progress_task_count,
                "completed": completion.facts.completed_task_count,
                "corrupt_task_count": completion.facts.corrupt_task_count,
                "open_task_ids": open_task_ids_preview,
                "open_task_ids_truncated": open_task_ids_truncated,
                "active_member_ids": active_member_ids,
                "pending_worker_turn_intent_count": completion.facts.in_flight_turn_intent_count,
                "unread_inbox_count": completion.facts.unread_inbox_count,
                "pending_plan_approval_count": completion.facts.pending_plan_approval_count,
                "completion_candidate": completion_candidate,
                "quiescence_decision": completion.decision,
                "current_quiescence_blockers": &completion.blockers,
            },
            "org_run_id": self.ctx.org_context.run_id,
        });
        serde_json::to_string(&body).map_err(|err| {
            ToolError::ExecutionFailed(format!("task_list: failed to serialize result: {err}"))
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskGetParams {
    /// Task UUID to fetch.
    pub id: String,
}

pub struct TaskGetTool {
    ctx: Arc<TaskToolsContext>,
}

impl TaskGetTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for TaskGetTool {
    fn name(&self) -> &str {
        tool_names::TASK_GET
    }

    fn description(&self) -> &str {
        concat!(
            "Fetch one task by its durable identifier. Returns the full row (subject, description, ",
            "active_form, owner, status, execution mode, dependencies, metadata, provenance, ",
            "replacement link, and the status-matched output/failure/cancel result). ",
            "Read-only. Errors if the task does not exist in the current org run."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        params_schema::<TaskGetParams>()
    }

    async fn execute(
        &self,
        params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<ToolExecuteResult, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        if self.ctx.is_coordinator() {
            let params: TaskGetParams = parse_params(params_value.clone())?;
            let task_id = params.id.trim().to_string();
            if task_id.is_empty() {
                return Err(ToolError::InvalidParams(
                    "task_get requires a non-empty `id`".into(),
                ));
            }
            validate_task_identifier("task_get.id", &task_id).map_err(ToolError::InvalidParams)?;
            let observed_task_id = task_id.clone();
            let run_id = self.ctx.org_context.run_id.clone();
            let session_id = call_ctx.session_id.clone();
            let turn_intent_id = call_ctx.turn_intent_id.clone();
            let observation = tokio::task::spawn_blocking(move || {
                crate::coordination::agent_org_turn_contexts::claim_coordinator_task_observation(
                    &run_id,
                    &session_id,
                    &turn_intent_id,
                    &task_id,
                )
            })
            .await
            .map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "Coordinator Task observation worker failed: {error}"
                ))
            })?
            .map_err(ToolError::ExecutionFailed)?;
            match observation {
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskObservation::First => {}
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskObservation::Repeat => {
                    tracing::debug!(
                        org_run_id = %self.ctx.org_context.run_id,
                        session_id = %call_ctx.session_id,
                        turn_intent_id = %call_ctx.turn_intent_id,
                        task_id = %observed_task_id,
                        observation = "task_get_repeat",
                        "[agent_org_metric] coordinator_no_progress"
                    );
                    return Ok(ToolExecuteResult::end_turn(
                        serde_json::json!({
                            "code": "coordinator_no_new_work_facts",
                            "terminal_reason": "waiting_for_org_event",
                            "guidance": "This Task was already read at the current durable revision. End this Turn; a committed Team event will wake the Coordinator."
                        })
                        .to_string(),
                    ));
                }
                crate::coordination::agent_org_turn_contexts::CoordinatorTaskObservation::NewTriggerPending => {
                    tracing::debug!(
                        org_run_id = %self.ctx.org_context.run_id,
                        session_id = %call_ctx.session_id,
                        turn_intent_id = %call_ctx.turn_intent_id,
                        task_id = %observed_task_id,
                        observation = "follow_up_pending",
                        "[agent_org_metric] coordinator_no_progress"
                    );
                    return Ok(ToolExecuteResult::end_turn(
                        serde_json::json!({
                            "code": "coordinator_new_trigger_pending",
                            "guidance": "A newer durable Team event arrived. End this Turn so the scheduler can start one follow-up with a fresh atomic snapshot."
                        })
                        .to_string(),
                    ));
                }
            }
        }
        self.execute_text(params_value, call_ctx)
            .await
            .map(ToolExecuteResult::text)
    }

    async fn execute_text(
        &self,
        params_value: Value,
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        let params: TaskGetParams = parse_params(params_value)?;
        let task_id = params.id.trim().to_string();
        if task_id.is_empty() {
            return Err(ToolError::InvalidParams(
                "task_get requires a non-empty `id`".into(),
            ));
        }
        validate_task_identifier("task_get.id", &task_id).map_err(ToolError::InvalidParams)?;
        let run_id = self.ctx.org_context.run_id.clone();
        let read_task_id = task_id.clone();
        let task =
            tokio::task::spawn_blocking(move || AgentOrgTaskStore::get(&run_id, &read_task_id))
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("task_get snapshot worker failed: {err}"))
                })?
                .map_err(ToolError::ExecutionFailed)?
                .ok_or_else(|| {
                    ToolError::ExecutionFailed(format!(
                        "task_get: task '{task_id}' not found in run '{}'",
                        self.ctx.org_context.run_id
                    ))
                })?;
        let body = json!({ "task": task_to_json(&task) });
        serde_json::to_string(&body).map_err(|err| {
            ToolError::ExecutionFailed(format!("task_get: failed to serialize result: {err}"))
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }
}
