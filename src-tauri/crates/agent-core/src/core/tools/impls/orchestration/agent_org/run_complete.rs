use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_runs::{AgentOrgCompletionRequestOutcome, AgentOrgRunStore};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::TaskToolsContext;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgRunCompleteParams {
    /// Concise user-facing summary of what the Agent Org delivered.
    pub summary: String,
}

/// Coordinator-only explicit completion intent.
///
/// This does not force a terminal state. It records a durable request at the
/// current work revision; the canonical finality reconciler still waits for a
/// successful coordinator turn, resolved tasks, drained inbox, settled
/// approvals/interventions, and no in-flight turns.
pub struct OrgRunCompleteTool {
    ctx: Arc<TaskToolsContext>,
}

impl OrgRunCompleteTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for OrgRunCompleteTool {
    fn name(&self) -> &str {
        tool_names::ORG_RUN_COMPLETE
    }

    fn description(&self) -> &str {
        "Request safe completion of the current Agent Org run. Coordinator-only. Records a durable summary at the current work revision; it never bypasses open tasks or finality checks. Use it when task_list says an empty task board requires explicit completion intent."
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        params_schema::<OrgRunCompleteParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "org_run_complete is coordinator-only".to_string(),
            ));
        }
        let params: OrgRunCompleteParams = parse_params(params_value)?;
        let run_id = self.ctx.org_context.run_id.clone();
        let summary = params.summary;
        let outcome = tokio::task::spawn_blocking({
            let run_id = run_id.clone();
            move || AgentOrgRunStore::request_completion(&run_id, &summary)
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org_run_complete worker failed: {err}"))
        })?
        .map_err(ToolError::ExecutionFailed)?;

        let body = match outcome {
            AgentOrgCompletionRequestOutcome::Recorded { progress } => json!({
                "outcome": "recorded",
                "org_run_id": run_id,
                "work_revision": progress.work_revision,
                "guidance": "Completion was requested durably. Finish this coordinator turn normally; the canonical finality reconciler will close the run only after every remaining delivery and lifecycle blocker has settled."
            }),
            AgentOrgCompletionRequestOutcome::OpenTasks {
                unresolved_task_ids,
            } => json!({
                "outcome": "open_tasks",
                "org_run_id": run_id,
                "unresolved_task_ids": unresolved_task_ids,
                "guidance": "The completion request was not recorded. Resolve, cancel, or explicitly repair these durable tasks, then inspect task_list again."
            }),
        };
        serde_json::to_string(&body).map_err(|err| {
            ToolError::ExecutionFailed(format!("org_run_complete serialization failed: {err}"))
        })
    }
}
