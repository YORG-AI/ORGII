use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_runs::{AgentOrgRunStatus, AgentOrgRunStore};
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{parse_status, task_to_json, TaskToolsContext};

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
            "narrow by `pending` / `in_progress` / `completed`, or `owner_member_id` ",
            "to query a sibling's queue. Combining filters AND-merges them. The response ",
            "always includes an unfiltered `run_summary`, so a filtered view cannot make ",
            "the coordinator falsely conclude that the whole run is complete. Treat ",
            "run_summary.completion_ready as the completion certificate; zero open tasks ",
            "alone is not final while a member, inbox delivery, intervention, plan approval, ",
            "or queued worker turn remains active. Read-only."
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

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
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

        let completion = AgentOrgRunStore::completion_snapshot(&self.ctx.org_context.run_id)
            .map_err(ToolError::ExecutionFailed)?;
        let tasks = &completion.tasks;
        let mut filtered: Vec<&Task> = Vec::with_capacity(tasks.len());
        for task in tasks {
            if let Some(status) = status_filter {
                if task.status != status {
                    continue;
                }
            }
            if let Some(owner) = owner_filter.as_deref() {
                if task.owner.as_deref() != Some(owner) {
                    continue;
                }
            }
            filtered.push(task);
        }

        let open_task_ids = tasks
            .iter()
            .filter(|task| !task.status.is_resolved())
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        let mut completion_blockers = Vec::new();
        if tasks.is_empty() {
            completion_blockers.push("no_durable_tasks".to_string());
        }
        if !open_task_ids.is_empty() {
            completion_blockers.push("open_tasks".to_string());
        }
        if !completion.active_member_ids.is_empty() {
            completion_blockers.push("active_members".to_string());
        }
        if !completion.active_intervention_member_ids.is_empty() {
            completion_blockers.push("active_member_intervention".to_string());
        }
        if completion.pending_worker_turn_intent_count > 0 {
            completion_blockers.push("pending_worker_turn_intent".to_string());
        }
        if completion.unread_inbox_count > 0 {
            completion_blockers.push("unread_inbox".to_string());
        }
        if completion.pending_plan_approval_count > 0 {
            completion_blockers.push("pending_plan_approval".to_string());
        }
        if completion.run_status != Some(AgentOrgRunStatus::Running)
            && completion.run_status != Some(AgentOrgRunStatus::Completed)
        {
            completion_blockers.push("run_not_running_or_completed".to_string());
        }
        let completion_ready = matches!(
            completion.run_status,
            Some(AgentOrgRunStatus::Running | AgentOrgRunStatus::Completed)
        ) && completion_blockers.is_empty();
        let body = json!({
            "tasks": filtered.iter().map(|t| task_to_json(t)).collect::<Vec<_>>(),
            "total": filtered.len(),
            "filtered_total": filtered.len(),
            "filters_applied": {
                "mine_only": params.mine_only,
                "status": normalized_status,
                "owner_member_id": owner_filter,
            },
            "run_summary": {
                "run_status": completion.run_status.map(|status| status.as_str()),
                "total": tasks.len(),
                "open": open_task_ids.len(),
                "pending": tasks.iter().filter(|task| task.status == TaskStatus::Pending).count(),
                "in_progress": tasks.iter().filter(|task| task.status == TaskStatus::InProgress).count(),
                "completed": tasks.iter().filter(|task| task.status == TaskStatus::Completed).count(),
                "open_task_ids": open_task_ids,
                "active_member_ids": &completion.active_member_ids,
                "active_intervention_member_ids": &completion.active_intervention_member_ids,
                "pending_worker_turn_intent_count": completion.pending_worker_turn_intent_count,
                "unread_inbox_count": completion.unread_inbox_count,
                "pending_plan_approval_count": completion.pending_plan_approval_count,
                "completion_ready": completion_ready,
                "completion_blockers": completion_blockers,
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
            "Fetch one task by UUID. Returns the full row (subject, description, ",
            "active_form, owner, status, blocks, blocked_by, metadata, timestamps). ",
            "Read-only. Errors if the task does not exist in the current org run."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        params_schema::<TaskGetParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        let params: TaskGetParams = parse_params(params_value)?;
        let task_id = params.id.trim().to_string();
        if task_id.is_empty() {
            return Err(ToolError::InvalidParams(
                "task_get requires a non-empty `id`".into(),
            ));
        }
        let task = AgentOrgTaskStore::get(&self.ctx.org_context.run_id, &task_id)
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
