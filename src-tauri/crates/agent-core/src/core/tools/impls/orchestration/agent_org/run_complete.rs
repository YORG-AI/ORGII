use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_org_run_completion::{RunCompletionCandidate, RunCompletionOutcome};
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
    /// Candidate only; the certificate owner independently validates it.
    pub candidate_outcome: RunCompletionOutcome,
    /// Concise user-facing summary of what the Agent Org delivered.
    pub summary: String,
    /// Optional validator hints. These ids cannot create or replace evidence.
    #[serde(default)]
    pub evidence_task_ids: Vec<String>,
}

/// Coordinator-only explicit completion intent.
///
/// This does not force a terminal state. The database validates the current
/// generation/revision, TaskOutput closure, replacement chains and every
/// durable blocker before writing the sole certificate that Quiescence trusts.
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
        "Submit a delivered, cancelled, or failed outcome candidate for the current Agent Org run. Coordinator-only. The database writes a certificate only after it proves the current Task/TaskOutput closure and every durable blocker; summary text and evidence ids cannot manufacture success. Pure Q&A with no formal Tasks does not create a certificate."
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
        call_ctx.require_tool_authority(self.name())?;
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "org_run_complete is coordinator-only".to_string(),
            ));
        }
        let canonical_params = params_value.clone();
        let params: OrgRunCompleteParams = parse_params(params_value)?;
        let run_id = self.ctx.org_context.run_id.clone();
        let summary = params.summary;
        let candidate_outcome = params.candidate_outcome;
        let evidence_task_ids = params.evidence_task_ids;
        let actor =
            TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
                .map_err(ToolError::InvalidParams)?;
        let receipt_key = AgentOrgToolReceiptKey::from_call_context(run_id.clone(), call_ctx)?;
        let request_id = call_ctx.call_id.clone();
        let request_digest =
            crate::coordination::agent_org_task_handoffs::canonical_request_digest(
                &canonical_params,
            )
            .map_err(ToolError::ExecutionFailed)?;
        let coordinator_session_id = call_ctx.session_id.clone();
        let coordinator_turn_intent_id = call_ctx.turn_intent_id.clone();
        let projected_inbox_ids = call_ctx.projected_inbox_ids.clone();
        let (receipt, recorded) = tokio::task::spawn_blocking({
            let run_id = run_id.clone();
            move || {
                let mut recorded = false;
                let receipt = AgentOrgToolReceiptStore::execute(
                    receipt_key,
                    tool_names::ORG_RUN_COMPLETE,
                    "certify_completion",
                    &canonical_params,
                    |tx| {
                        if let Err(error) = actor.validate_canonical_coordinator(tx, &run_id) {
                            return match classify_task_receipt_error(error) {
                                Ok(error) => Ok(Err(error)),
                                Err(abort) => Err(abort),
                            };
                        }
                        match crate::coordination::agent_org_run_completion::certify_in_tx(
                            tx,
                            &run_id,
                            RunCompletionCandidate {
                                request_id: &request_id,
                                request_digest: &request_digest,
                                outcome: candidate_outcome,
                                summary: &summary,
                                evidence_task_ids: &evidence_task_ids,
                                coordinator_session_id: &coordinator_session_id,
                                coordinator_turn_intent_id: &coordinator_turn_intent_id,
                                projected_inbox_ids: &projected_inbox_ids,
                            },
                        ) {
                            Ok(certificate) => {
                                recorded = true;
                                serde_json::to_string(&json!({
                                    "outcome": "certified",
                                    "org_run_id": run_id,
                                    "certificate": certificate,
                                    "guidance": "The candidate passed the database closure check. Finish this coordinator turn normally; only the typed certificate can project the final outcome."
                                }))
                                    .map(Ok)
                                    .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)
                            }
                            Err(error) => {
                                let quiescence = crate::coordination::agent_org_runs::AgentOrgRunStore::quiescence_assessment_with_connection(
                                    tx,
                                    &run_id,
                                );
                                let blockers = quiescence.as_ref().map_err(|failure| failure.clone()).and_then(
                                    |quiescence| {
                                        if candidate_outcome == RunCompletionOutcome::Delivered {
                                            let candidate = crate::coordination::agent_org_run_completion::assess_delivered_candidate_from_quiescence_with_connection(
                                                tx,
                                                &run_id,
                                                &coordinator_session_id,
                                                &coordinator_turn_intent_id,
                                                &projected_inbox_ids,
                                                quiescence,
                                            );
                                            crate::coordination::agent_org_run_blockers::build_from_candidate_with_connection(
                                                tx,
                                                &run_id,
                                                &candidate,
                                            )
                                        } else {
                                            crate::coordination::agent_org_run_blockers::build_with_connection(
                                                tx,
                                                &run_id,
                                                quiescence,
                                            )
                                        }
                                    },
                                );
                                match blockers {
                                    Ok(mut blockers) => {
                                        crate::coordination::agent_org_run_blockers::append_completion_failure(
                                            &mut blockers,
                                            &error,
                                        );
                                        tracing::warn!(
                                            org_run_id = %run_id,
                                            reason_code = error.split(':').next().unwrap_or("run_completion_blocked"),
                                            blocker_kinds = ?blockers.iter().map(|blocker| blocker.kind).collect::<Vec<_>>(),
                                            "Agent Org completion blocked by canonical typed details"
                                        );
                                        serde_json::to_string(&json!({
                                        "outcome": "blocked",
                                        "org_run_id": run_id,
                                        "reason_code": error.split(':').next().unwrap_or("run_completion_blocked"),
                                        "blockers": blockers,
                                        "guidance": "Resolve the typed blockers, then submit a new completion candidate."
                                    }))
                                    .map(Ok)
                                    .map_err(crate::coordination::agent_org_tool_receipts::AgentOrgToolReceiptAbort::storage)
                                    },
                                    Err(_) => match classify_task_receipt_error(error) {
                                        Ok(error) => Ok(Err(error)),
                                        Err(abort) => Err(abort),
                                    },
                                }
                            }
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
            tracing::debug!(
                org_run_id = %run_id,
                request_id = %call_ctx.call_id,
                candidate_outcome = candidate_outcome.as_wire(),
                "[agent_org_metric] run_completion_certified"
            );
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        }
        receipt.result
    }
}
