use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_runs::{AgentOrgCompletionRequestOutcome, AgentOrgRunStore};
use crate::coordination::agent_org_tasks::TaskGraphWriterAdmin;
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{classify_task_receipt_error, TaskToolsContext};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgRunCompleteParams {
    /// Concise user-facing summary of what the Agent Org delivered.
    pub summary: String,
}

/// Coordinator-only explicit completion intent.
///
/// This does not force a terminal state. It records a durable request at the
/// current work revision; the canonical Quiescence reconciler still waits for a
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
        "Request safe completion of the current Agent Org run. Coordinator-only. Records a durable summary at the current work revision; it never bypasses open tasks or Quiescence checks. Use it when task_list says an empty task board requires explicit completion intent."
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
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "org_run_complete is coordinator-only".to_string(),
            ));
        }
        let canonical_params = params_value.clone();
        let params: OrgRunCompleteParams = parse_params(params_value)?;
        let run_id = self.ctx.org_context.run_id.clone();
        let summary = params.summary;
        let actor =
            TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
                .map_err(ToolError::InvalidParams)?;
        let receipt_key = AgentOrgToolReceiptKey::from_call_context(run_id.clone(), call_ctx)?;
        let (receipt, recorded) = tokio::task::spawn_blocking({
            let run_id = run_id.clone();
            move || {
                let mut recorded = false;
                let receipt = AgentOrgToolReceiptStore::execute(
                    receipt_key,
                    tool_names::ORG_RUN_COMPLETE,
                    "request_completion",
                    &canonical_params,
                    |tx| {
                        if let Err(error) = actor.validate_canonical_coordinator(tx, &run_id) {
                            return match classify_task_receipt_error(error) {
                                Ok(error) => Ok(Err(error)),
                                Err(abort) => Err(abort),
                            };
                        }
                        match AgentOrgRunStore::request_completion_in_tx(tx, &run_id, &summary) {
                            Ok(outcome) => {
                                recorded = matches!(
                                    outcome,
                                    AgentOrgCompletionRequestOutcome::Recorded { .. }
                                );
                                let body = match outcome {
                                    AgentOrgCompletionRequestOutcome::Recorded { progress } => json!({
                                        "outcome": "recorded",
                                        "org_run_id": run_id,
                                        "work_revision": progress.work_revision,
                                        "guidance": "Completion was requested durably. Finish this coordinator turn normally; Quiescence will move the Team to Idle only after every blocker settles."
                                    }),
                                    AgentOrgCompletionRequestOutcome::OpenTasks { unresolved_task_ids } => json!({
                                        "outcome": "open_tasks",
                                        "org_run_id": run_id,
                                        "unresolved_task_ids": unresolved_task_ids,
                                        "guidance": "The completion request was not recorded. Resolve or cancel these durable Tasks first."
                                    }),
                                };
                                serde_json::to_string(&body)
                                    .map(Ok)
                                    .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)
                            }
                            Err(error) => match classify_task_receipt_error(error) {
                                Ok(error) => Ok(Err(error)),
                                Err(abort) => Err(abort),
                            },
                        }
                    },
                )?;
                Ok::<_, ToolError>((receipt, recorded))
            }
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org_run_complete worker failed: {err}"))
        })??;
        if receipt.is_fresh() && recorded {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        }
        receipt.result
    }
}
