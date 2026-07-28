//! `org_send_message` — typed org messaging inside an Agent Org run.
//!
//! Contract:
//! - Recipient is resolved only by `recipient_member_id` against the org's
//!   participant graph. Display names and agent ids are never accepted as
//!   routing input.
//! - Validated payloads are persisted to `agent_inbox` immediately, and an
//!   in-memory live channel layered on top of the same store wakes idle
//!   recipients. The persisted row is the source of truth.
//! - The tool is registered only when the session has an
//!   `AgentOrgRunContext` and the calling agent is the coordinator (worker
//!   registration is conditional on routing direction).

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::coordination::agent_inbox::{
    is_supported_agent_org_remote_mode, AgentMessage, RequestId,
};
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanApprovalStore, AgentOrgPlanDecisionBy, AgentOrgPlanInboxDelivery,
};
use crate::coordination::agent_org_runs::{
    AgentOrgParticipant, AgentOrgRunContext, RoutingDecision, COORDINATOR_MEMBER_ID,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, Tool, ToolError};

mod hooks;
mod params;
mod persistence;
#[cfg(test)]
mod tests;

pub use hooks::{InboxWakeHook, NoopInboxWakeHook, NoopSelfAbortHook, SelfAbortHook};
pub use params::OrgSendMessageParams;
use persistence::{
    ensure_recipients_deliverable, persist_ordinary_message_if_running,
    OrdinaryMessagePersistOutcome, OrgRecipientTarget,
};

fn parse_agent_org_remote_mode(
    mode_str: &str,
    field_name: &str,
) -> Result<crate::session::AgentExecMode, String> {
    let mode = crate::session::AgentExecMode::parse(mode_str).ok_or_else(|| {
        format!(
            "field '{field_name}' got unknown mode '{mode_str}' — valid modes are: build, ask, plan"
        )
    })?;
    if !is_supported_agent_org_remote_mode(mode) {
        return Err(format!(
            "field '{field_name}' got unsupported mode '{}' — Agent Org remote mode control currently supports only: build, ask, plan",
            mode.as_str()
        ));
    }
    Ok(mode)
}

pub struct OrgSendMessageTool {
    org_context: Arc<AgentOrgRunContext>,
    sender: AgentOrgParticipant,
    wake_hook: Arc<dyn InboxWakeHook>,
    self_abort_hook: Arc<dyn SelfAbortHook>,
}

impl OrgSendMessageTool {
    pub fn new(org_context: Arc<AgentOrgRunContext>, sender_member_id: String) -> Self {
        Self::with_hooks(
            org_context,
            sender_member_id,
            Arc::new(NoopInboxWakeHook),
            Arc::new(NoopSelfAbortHook),
        )
    }

    pub fn with_hooks(
        org_context: Arc<AgentOrgRunContext>,
        sender_member_id: String,
        wake_hook: Arc<dyn InboxWakeHook>,
        self_abort_hook: Arc<dyn SelfAbortHook>,
    ) -> Self {
        let sender = org_context
            .participant_by_member_id(&sender_member_id)
            .unwrap_or_else(|| {
                panic!("sender_member_id '{sender_member_id}' is not in this Agent Org run")
            });
        Self {
            org_context,
            sender,
            wake_hook,
            self_abort_hook,
        }
    }

    fn allowed_recipient_member_ids(&self) -> Vec<String> {
        self.org_context
            .allowed_recipient_member_ids_for(&self.sender.member_id)
    }

    fn allowed_message_kinds(&self) -> Vec<&'static str> {
        if self.sender.is_coordinator {
            let mut kinds = vec!["plain", "shutdown_request"];
            if self.org_context.plan_approval_policy
                == crate::definitions::orgs::PlanApprovalPolicy::Coordinator
            {
                kinds.push("plan_approval_response");
            }
            kinds
        } else {
            vec!["plain", "shutdown_response"]
        }
    }

    fn hierarchy_mode_label(&self) -> &'static str {
        match self.org_context.hierarchy_mode {
            crate::definitions::orgs::HierarchyMode::Flat => "flat",
            crate::definitions::orgs::HierarchyMode::Soft => "soft",
            crate::definitions::orgs::HierarchyMode::Strict => "strict",
        }
    }

    fn routing_description(&self) -> &'static str {
        match self.org_context.hierarchy_mode {
            crate::definitions::orgs::HierarchyMode::Flat => {
                "flat: any participant may message any other participant except itself"
            }
            crate::definitions::orgs::HierarchyMode::Soft => {
                "soft: same routable set as flat; reports_to is advisory only"
            }
            crate::definitions::orgs::HierarchyMode::Strict => {
                "strict: coordinator may message members; members may message coordinator, manager, and direct reports only"
            }
        }
    }

    fn dynamic_llm_description(&self) -> String {
        let allowed = self.allowed_recipient_member_ids();
        let kinds = self.allowed_message_kinds();
        format!(
            "{}\n\nCurrent Agent Org routing context:\n- hierarchy_mode: {}\n- sender_member_id: {}\n- routing_rule: {}\n- recipient_member_id enum: [{}]\n- kind enum for this sender: [{}]\n\nUse exactly one recipient_member_id from the enum. Do not route by display name or agent id.\n\nFormal-work rule:\n- A `plain` message to any non-coordinator worker MUST include `related_task_id`.\n- The task must be unresolved, dependency-ready, and already owned by that recipient. Eligibility alone is not an assignment.\n- Create and explicitly assign the durable task first; a chat message cannot replace a task, assign ownerless work, or bypass dependencies.\n- Worker → coordinator status/escalation messages do not need `related_task_id`.\n\nCoordinator planning protocol:\n- Create planning work with `task_create execution_mode=\"plan\"`; the assigned Planner starts in Plan mode automatically.\n- A member's `create_plan` call creates a durable approval bound to that planning task.\n- To answer a submitted member plan, send `kind = \"plan_approval_response\"`, echo the inbox `request_id`, and set `accepted = true` to complete the planning task and unlock its dependants, or `accepted = false` with non-empty `feedback` to wake the Planner once for revision.",
            <Self as Tool>::description(self),
            self.hierarchy_mode_label(),
            self.sender.member_id,
            self.routing_description(),
            allowed.join(", "),
            kinds.join(", "),
        )
    }

    fn parameters_schema(&self) -> Value {
        let mut schema = params_schema::<OrgSendMessageParams>();
        let Some(schema_object) = schema.as_object_mut() else {
            return schema;
        };

        let required = schema_object
            .entry("required")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(required_fields) = required.as_array_mut() {
            if !required_fields
                .iter()
                .any(|field| field.as_str() == Some("recipient_member_id"))
            {
                required_fields.push(Value::String("recipient_member_id".to_string()));
            }
        }

        let Some(properties) = schema_object
            .get_mut("properties")
            .and_then(Value::as_object_mut)
        else {
            return schema;
        };

        properties.insert(
            "recipient_member_id".to_string(),
            json!({
                "type": "string",
                "description": "Stable participant member_id. Use one of the allowed member_id values listed in the tool description."
            }),
        );

        properties.insert(
            "kind".to_string(),
            json!({
                "type": "string",
                "description": "Message kind. Use one of the allowed kind values listed in the tool description."
            }),
        );

        schema
    }

    fn ensure_kind_allowed_for_sender(&self, kind: &str) -> Result<(), String> {
        if self.allowed_message_kinds().contains(&kind) {
            return Ok(());
        }
        Err(format!(
            "kind '{kind}' is not allowed for sender_member_id '{}'. Allowed kinds: {}",
            self.sender.member_id,
            self.allowed_message_kinds().join(", ")
        ))
    }

    fn resolve_recipient(
        &self,
        params: &OrgSendMessageParams,
    ) -> Result<Vec<OrgRecipientTarget>, String> {
        let recipient_member_id = params
            .recipient_member_id
            .as_deref()
            .map(str::trim)
            .filter(|member_id| !member_id.is_empty())
            .ok_or_else(|| "recipient_member_id is required".to_string())?;

        let allowed = self.allowed_recipient_member_ids();
        if !allowed
            .iter()
            .any(|member_id| member_id == recipient_member_id)
        {
            return Err(format!(
                "recipient_member_id '{recipient_member_id}' is not addressable from sender_member_id '{}'. Allowed recipient_member_id values: {}",
                self.sender.member_id,
                allowed.join(", ")
            ));
        }

        let participant = self
            .org_context
            .participant_by_member_id(recipient_member_id)
            .ok_or_else(|| {
                format!("recipient_member_id '{recipient_member_id}' is not in this Agent Org")
            })?;

        Ok(vec![OrgRecipientTarget {
            member_id: participant.member_id,
            agent_id: participant.agent_id,
        }])
    }

    fn build_message(&self, params: &OrgSendMessageParams) -> Result<AgentMessage, String> {
        let kind = params.kind.trim();
        self.ensure_kind_allowed_for_sender(kind)?;
        let request_id = || -> Result<RequestId, String> {
            params
                .request_id
                .as_deref()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
                .map(RequestId)
                .ok_or_else(|| format!("kind '{kind}' requires a non-empty request_id"))
        };

        match kind {
            "plain" => Ok(AgentMessage::Plain {
                summary: params
                    .summary
                    .clone()
                    .ok_or_else(|| "kind 'plain' requires summary".to_string())?,
                text: params
                    .text
                    .clone()
                    .ok_or_else(|| "kind 'plain' requires text".to_string())?,
            }),
            "shutdown_request" => Ok(AgentMessage::ShutdownRequest {
                request_id: request_id()?,
                reason: params.reason.clone(),
            }),
            "shutdown_response" => {
                let accepted = params.accepted.ok_or_else(|| {
                    "kind 'shutdown_response' requires accepted=true|false".to_string()
                })?;
                // A rejection that doesn't tell the coordinator *why* is
                // useless, so we require a non-empty note when
                // accepted=false. Approval (accepted=true) keeps note
                // optional.
                let note = params.note.clone();
                if !accepted && note.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                    return Err("kind 'shutdown_response' with accepted=false requires \
                         a non-empty 'note' explaining why the shutdown was \
                         rejected so the coordinator can act on the feedback"
                        .to_string());
                }
                Ok(AgentMessage::ShutdownResponse {
                    request_id: request_id()?,
                    accepted,
                    note,
                })
            }
            "plan_approval_response" => {
                // Only the coordinator may approve/reject a member's plan.
                // The sender member identity is stamped from tool context
                // (LLM cannot override it), so this is a hard check, not
                // advisory. `inbox_drain::apply_payload_side_effects` adds
                // defence-in-depth on the read side.
                if !self.sender.is_coordinator {
                    return Err(
                        "kind 'plan_approval_response' is restricted to the coordinator"
                            .to_string(),
                    );
                }
                let accepted = params.accepted.ok_or_else(|| {
                    "kind 'plan_approval_response' requires accepted=true|false".to_string()
                })?;
                if !accepted
                    && params
                        .feedback
                        .as_deref()
                        .is_none_or(|feedback| feedback.trim().is_empty())
                {
                    return Err(
                        "kind 'plan_approval_response' with accepted=false requires non-empty feedback"
                            .to_string(),
                    );
                }
                let next_mode = match params.next_mode.as_deref().map(str::trim) {
                    Some(value) if !value.is_empty() => {
                        Some(parse_agent_org_remote_mode(value, "next_mode")?)
                    }
                    _ => Some(if accepted {
                        crate::session::AgentExecMode::Build
                    } else {
                        crate::session::AgentExecMode::Plan
                    }),
                };
                Ok(AgentMessage::PlanApprovalResponse {
                    request_id: request_id()?,
                    accepted,
                    feedback: params.feedback.clone(),
                    next_mode,
                })
            }
            "plan_approval_request" => Err(
                // The `plan_approval_request` payload is written directly
                // by `create_plan` when a non-coordinator org member
                // submits a plan; allowing the LLM to forge one would let
                // any member impersonate another and inject a fake plan
                // into the coordinator's inbox.
                "kind 'plan_approval_request' is not LLM-callable — \
                 it is produced by the create_plan tool when an org \
                 member submits a plan"
                    .to_string(),
            ),
            "member_terminated" => Err(
                // `member_terminated` is the system-emitted
                // notification injected into the coordinator's inbox
                // by the inbox-drain side-effect path after it
                // observes a `ShutdownResponse{accepted=true}` and
                // cancels the member's session. Allowing the LLM to
                // forge one would let any member fake another
                // member's death — e.g. to trick the coordinator
                // into reassigning the victim's tasks. The producer
                // is hard-wired to use `SYSTEM_SENDER_ID`, so this
                // branch reflects "not LLM-callable" rather than a
                // permission check.
                "kind 'member_terminated' is not LLM-callable — \
                 it is emitted by the system when a member's session \
                 is cancelled in response to a shutdown handshake"
                    .to_string(),
            ),
            "member_idle" => Err(
                // `member_idle` is the system-emitted notification
                // produced by the coordinator-side idle hook when a
                // member session transitions to idle (turn end /
                // interrupted / failed). The producer is hard-wired
                // to `SYSTEM_SENDER_ID`. Allowing an LLM to call
                // this would let any member spoof another member's
                // completion state and trick the coordinator into
                // double-dispatching. Same logic as the
                // `member_terminated` rejection.
                "kind 'member_idle' is not LLM-callable — \
                 it is emitted by the system when a member's session \
                 transitions to idle at a turn boundary"
                    .to_string(),
            ),
            "task_assigned" => Err(
                // `task_assigned` is the inbox notification emitted
                // by `task_create`/`task_update`. The assignment row's
                // `task_id` must point at a real row in the
                // `agent_org_tasks` store and the producers go
                // through `AgentOrgTaskStore::create`/`update`,
                // which set the canonical `owner` field atomically.
                // Allowing the LLM to forge a `task_assigned` over
                // the wire would let any member fabricate
                // assignments without ever touching the task store,
                // breaking the single-source-of-truth invariant.
                "kind 'task_assigned' is not LLM-callable — \
                 it is emitted by the task tools after an explicit \
                 assignment; use task_create or task_update to \
                 (re)assign a task"
                    .to_string(),
            ),
            other => Err(format!(
                "unknown message kind '{other}' — must be one of: plain, \
                 shutdown_request, shutdown_response, plan_approval_response"
            )),
        }
    }
}

#[async_trait]
impl Tool for OrgSendMessageTool {
    fn name(&self) -> &str {
        tool_names::ORG_SEND_MESSAGE
    }

    fn description(&self) -> &str {
        concat!(
            "Send a typed org message to exactly one coordinator/member participant inside the current Agent Org run. ",
            "The only routing parameter is recipient_member_id; use one of the allowed values listed below.\n",
            "  - 'plain' for free-form text (the common case — set summary + text).\n",
            "  - 'shutdown_request' / 'shutdown_response' for the coordinator-driven graceful-stop RPC.\n",
            "  - 'plan_approval_response' for the coordinator to approve a member plan (completes its planning task) or request a revision.\n",
            "Messages are persisted to the org inbox and surfaced to the recipient on its next turn. ",
            "Normal text output is not visible to other agents; use this tool to communicate. ",
            "Messaging permission is not task authority: every plain message to a worker requires related_task_id for an unresolved, dependency-ready task already owned by that worker. Eligibility alone is not assignment."
        )
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        self.parameters_schema()
    }

    fn llm_description(&self) -> Option<String> {
        Some(self.dynamic_llm_description())
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let params: OrgSendMessageParams = parse_params(params_value)?;
        let recipients = self
            .resolve_recipient(&params)
            .map_err(ToolError::InvalidParams)?;
        let message = self
            .build_message(&params)
            .map_err(ToolError::InvalidParams)?;
        message.validate().map_err(ToolError::InvalidParams)?;

        // Shutdown acknowledgements are part of the coordinator/member
        // handshake and must go back to the coordinator participant.
        if matches!(message, AgentMessage::ShutdownResponse { .. }) {
            for recipient in &recipients {
                if recipient.member_id != COORDINATOR_MEMBER_ID {
                    return Err(ToolError::InvalidParams(
                        "kind 'shutdown_response' must be sent to recipient_member_id 'coordinator'"
                            .to_string(),
                    ));
                }
            }
        }

        for recipient in &recipients {
            if let RoutingDecision::Blocked(hint) = self
                .org_context
                .check_routing(&self.sender.member_id, &recipient.member_id)
            {
                return Err(ToolError::InvalidParams(hint));
            }
        }
        if let AgentMessage::PlanApprovalResponse {
            request_id,
            accepted,
            feedback,
            ..
        } = &message
        {
            if !accepted {
                let deliverable_run_id = self.org_context.run_id.clone();
                let deliverable_recipients = recipients.clone();
                tokio::task::spawn_blocking(move || {
                    ensure_recipients_deliverable(&deliverable_run_id, &deliverable_recipients)
                })
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "recipient-delivery validation worker failed: {err}"
                    ))
                })??;
            }
            let lookup_run_id = self.org_context.run_id.clone();
            let lookup_request_id = request_id.as_str().to_string();
            let approval = tokio::task::spawn_blocking(move || {
                AgentOrgPlanApprovalStore::get_pending_by_request_id(
                    &lookup_run_id,
                    &lookup_request_id,
                )
            })
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("plan approval lookup worker failed: {err}"))
            })?
            .map_err(ToolError::ExecutionFailed)?
            .ok_or_else(|| {
                ToolError::InvalidParams(format!(
                    "No pending Agent Org plan approval matches request_id '{}'",
                    request_id.as_str()
                ))
            })?;
            if recipients.len() != 1 || recipients[0].member_id != approval.source_member_id {
                return Err(ToolError::InvalidParams(format!(
                    "plan_approval_response request_id '{}' must target source member '{}'",
                    request_id.as_str(),
                    approval.source_member_id
                )));
            }

            if *accepted {
                let approval_id = approval.approval_id.clone();
                let plan_revision_id = approval.plan_revision_id.clone();
                let approved = tokio::task::spawn_blocking(move || {
                    AgentOrgPlanApprovalStore::approve(
                        &approval_id,
                        &plan_revision_id,
                        AgentOrgPlanDecisionBy::Coordinator,
                        None,
                    )
                })
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("plan approval worker failed: {err}"))
                })?
                .map_err(ToolError::ExecutionFailed)?;
                let wake_member_ids = approved.wake_member_ids.clone();
                for member_id in &wake_member_ids {
                    self.wake_hook
                        .wake_member(member_id, &self.org_context.run_id);
                }
                return serde_json::to_string(&json!({
                    "kind": "plan_approval_response",
                    "request_id": request_id.as_str(),
                    "org_run_id": self.org_context.run_id,
                    "sender_member_id": self.sender.member_id,
                    "approval_id": approval.approval_id,
                    "source_task_id": approval.source_task_id,
                    "decision": "approved",
                    "woken_member_ids": wake_member_ids,
                }))
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "serialize org_send_message result failed: {err}"
                    ))
                });
            }

            let feedback = feedback
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ToolError::InvalidParams(
                        "A rejected plan requires non-empty feedback".to_string(),
                    )
                })?;
            let recipient = &recipients[0];
            let approval_id = approval.approval_id.clone();
            let plan_revision_id = approval.plan_revision_id.clone();
            let feedback = feedback.to_string();
            let delivery = AgentOrgPlanInboxDelivery {
                recipient_agent_id: recipient.agent_id.clone(),
                sender_agent_id: self.sender.agent_id.clone(),
                sender_member_id: Some(self.sender.member_id.clone()),
            };
            let (_, record) = tokio::task::spawn_blocking(move || {
                AgentOrgPlanApprovalStore::request_changes(
                    &approval_id,
                    &plan_revision_id,
                    AgentOrgPlanDecisionBy::Coordinator,
                    &feedback,
                    delivery,
                )
            })
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("plan changes-request worker failed: {err}"))
            })?
            .map_err(ToolError::ExecutionFailed)?;
            self.wake_hook
                .wake_member(&recipient.member_id, &self.org_context.run_id);
            return serde_json::to_string(&json!({
                "kind": "plan_approval_response",
                "request_id": request_id.as_str(),
                "org_run_id": self.org_context.run_id,
                "sender_member_id": self.sender.member_id,
                "approval_id": approval.approval_id,
                "source_task_id": approval.source_task_id,
                "decision": "changes_requested",
                "inbox_id": record.id,
                "woken_member_ids": [recipient.member_id.clone()],
            }))
            .map_err(|err| {
                ToolError::ExecutionFailed(format!(
                    "serialize org_send_message result failed: {err}"
                ))
            });
        }

        let persist_run_id = self.org_context.run_id.clone();
        let persist_sender = self.sender.clone();
        let persist_params = params.clone();
        let persist_message = message.clone();
        let persist_recipients = recipients.clone();
        let persist_outcome = tokio::task::spawn_blocking(move || {
            persist_ordinary_message_if_running(
                &persist_run_id,
                &persist_sender,
                &persist_params,
                &persist_message,
                &persist_recipients,
            )
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org message persistence worker failed: {err}"))
        })??;
        let delivered_rows = match persist_outcome {
            OrdinaryMessagePersistOutcome::Guidance(guidance) => return Ok(guidance),
            OrdinaryMessagePersistOutcome::Delivered(delivered_rows) => delivered_rows,
        };
        let delivered = delivered_rows
            .iter()
            .map(|(recipient_member_id, inbox_id)| {
                json!({
                    "recipient_member_id": recipient_member_id,
                    "inbox_id": inbox_id,
                })
            })
            .collect::<Vec<_>>();
        for (recipient_member_id, _) in &delivered_rows {
            self.wake_hook
                .wake_member(recipient_member_id, &self.org_context.run_id);
        }

        if let AgentMessage::ShutdownResponse { accepted: true, .. } = &message {
            if !self.sender.is_coordinator {
                self.self_abort_hook
                    .abort_self(&self.sender.member_id, &self.org_context.run_id);
            }
        }

        let result = json!({
            "kind": message.kind_tag(),
            "request_id": message.request_id().map(|r| r.as_str().to_string()),
            "related_task_id": params.related_task_id.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            "org_run_id": self.org_context.run_id,
            "sender_member_id": self.sender.member_id,
            "delivered": delivered,
            "live_channel": false,
        });
        serde_json::to_string(&result).map_err(|err| {
            ToolError::ExecutionFailed(format!("serialize org_send_message result failed: {err}"))
        })
    }

    /// Recipient resolution + JSON validation are read-only side-channel
    /// checks; only the inbox insert mutates state. Marking `false` because
    /// of the insert.
    fn is_read_only(&self) -> bool {
        false
    }
}
