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
    AgentOrgPlanDecisionBy, AgentOrgPlanDecisionDelivery, AgentOrgPlanRevisionStore,
    ApprovePlanRevisionInTxParams,
};
use crate::coordination::agent_org_runs::{
    AgentOrgParticipant, AgentOrgRunContext, RoutingDecision, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptAbort, AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

mod hooks;
mod params;
mod persistence;
#[cfg(test)]
mod tests;

pub use hooks::{
    InboxWakeHook, NoopInboxWakeHook, NoopSelfAbortHook, SelfAbortHook, UserDirectedWake,
};
pub use params::{MemberCoordinationPurpose, OrgSendMessageParams};
use persistence::{
    ensure_recipients_deliverable_in_tx, persist_ordinary_message_in_tx,
    persist_user_directed_coordinator_message_in_tx, persist_user_directed_member_message_in_tx,
    user_directed_link_allowed_in_tx, OrdinaryMessagePersistOutcome, OrgRecipientTarget,
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

fn classify_message_string_error(
    error: String,
) -> Result<Result<String, ToolError>, AgentOrgToolReceiptAbort> {
    match super::tasks::classify_task_receipt_error(error) {
        Ok(error) => Ok(Err(error)),
        Err(abort) => Err(abort),
    }
}

fn classify_message_tool_error(
    error: ToolError,
) -> Result<Result<String, ToolError>, AgentOrgToolReceiptAbort> {
    match error {
        ToolError::ExecutionFailed(message) => classify_message_string_error(message),
        other => Ok(Err(other)),
    }
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
            .user_directed_recipient_member_ids_for(&self.sender.member_id)
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

    fn routing_description(&self) -> &'static str {
        if self.sender.is_coordinator {
            "coordinator may message any member"
        } else {
            "member schema includes the coordinator and immutable-snapshot linked peers; the exact persisted Turn narrows execution permission"
        }
    }

    fn dynamic_llm_description(&self) -> String {
        let allowed = self.allowed_recipient_member_ids();
        let kinds = self.allowed_message_kinds();
        let direction_rule = if self.sender.is_coordinator {
            "Coordinator → Member rule:\n- For `kind=plain`, include the exact unresolved `related_task_id` already owned by the recipient.\n- Do not include `purpose`; that field exists only in the Member → Coordinator schema.\n- Reply to a Member's blocker/risk with a normal plain message. A message retry is not a reason to cancel or replace the active Task."
        } else {
            "Member routing is decided from the exact persisted Turn:\n- During UserDirectedWork, send exactly one `kind=plain` message to the Coordinator or a snapshot-linked peer; omit related_task_id and purpose. This creates a bounded child side quest, not a formal Task.\n- During TaskExecution, routine progress is NOT a message or assistant reply: call the next tool directly instead of narrating progress or retries. Record progress in Task state and completion once in TaskOutput.\n- A TaskExecution member may send `kind=plain` only to the Coordinator when action is needed. Include the exact current `related_task_id` and one purpose: `blocker | decision_required | material_change | risk | requested_reply`."
        };
        let planning_rule = if self.sender.is_coordinator {
            "\n\nCoordinator planning protocol:\n- Create planning work with `task_create execution_mode=\"plan\"`; the assigned Planner starts in Plan mode automatically.\n- A member's `create_plan` call creates a durable approval bound to that planning task.\n- To answer a submitted member plan, send `kind = \"plan_approval_response\"`, echo the inbox `request_id`, and set `accepted = true` to complete the planning task and unlock its dependants, or `accepted = false` with non-empty `feedback` to wake the Planner once for revision."
        } else {
            ""
        };
        format!(
            "{}\n\nCurrent Agent Org routing context:\n- sender_member_id: {}\n- routing_rule: {}\n- recipient_member_id enum: [{}]\n- kind enum for this sender: [{}]\n\nUse exactly one recipient_member_id from the enum. Do not route by display name or agent id.\n\nFormal-work rule:\n- A `plain` message to any non-coordinator worker MUST include `related_task_id`.\n- The task must be unresolved, dependency-ready, and already owned by that recipient. Eligibility alone is not an assignment.\n- Create and explicitly assign the durable task first; a chat message cannot replace a task, assign ownerless work, or bypass dependencies.\n\n{}{}",
            <Self as Tool>::description(self),
            self.sender.member_id,
            self.routing_description(),
            allowed.join(", "),
            kinds.join(", "),
            direction_rule,
            planning_rule,
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
                "enum": self.allowed_recipient_member_ids(),
                "description": "Stable participant member_id. Use one of the allowed member_id values listed in the tool description."
            }),
        );

        properties.insert(
            "kind".to_string(),
            json!({
                "type": "string",
                "enum": self.allowed_message_kinds(),
                "description": "Message kind. Use one of the allowed kind values listed in the tool description."
            }),
        );

        if self.sender.is_coordinator {
            properties.remove("purpose");
        } else {
            properties.insert(
                "purpose".to_string(),
                json!({
                    "type": "string",
                    "enum": ["blocker", "decision_required", "material_change", "risk", "requested_reply"],
                    "description": "Required only for kind=plain from a TaskExecution Member to the Coordinator. Omit for UserDirectedWork linked side quests."
                }),
            );
        }

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

        if recipient_member_id == self.sender.member_id {
            return Err("linked_inbox_self_send: a Member cannot send work to itself".to_string());
        }

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
            "plan_decision_committed" => Err(
                "kind 'plan_decision_committed' is not LLM-callable — it is emitted only by the immutable Plan decision transaction for Coordinator observation"
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
                // by typed Task graph mutations. The assignment row's
                // `task_id` must point at a real canonical Task row and
                // the producer goes through the actor-gated Store
                // transaction, which sets `owner` atomically.
                // Allowing the LLM to forge a `task_assigned` over
                // the wire would let any member fabricate
                // assignments without ever touching the task store,
                // breaking the single-source-of-truth invariant.
                "kind 'task_assigned' is not LLM-callable — \
                 it is emitted by the task tools after an explicit \
                 assignment; use task_create or the pending graph-patch \
                 operation, or cancel-and-replace active work"
                    .to_string(),
            ),
            "task_assignment_committed" => Err(
                "kind 'task_assignment_committed' is not LLM-callable — it is emitted only by the atomic Task assignment transaction for Coordinator observation"
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
            "The persisted current Turn decides authority. During UserDirectedWork, a Member may send one plain child side quest to the Coordinator or a snapshot-linked peer without task fields; depth, delivery budget, FIFO, and link checks are server-owned. ",
            "During formal TaskExecution, messaging is not task authority: a Member may message only the Coordinator for an actionable reason using the exact related_task_id and purpose, and a Coordinator message to a worker requires that worker's already-owned unresolved task."
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
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        let canonical_params = params_value.clone();
        let raw_member_coordination_request = !self.sender.is_coordinator
            && params_value
                .get("recipient_member_id")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim() == COORDINATOR_MEMBER_ID)
            && params_value
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim() == "plain");
        let params: OrgSendMessageParams = match parse_params(params_value) {
            Ok(params) => params,
            Err(error) => {
                if raw_member_coordination_request {
                    tracing::debug!(
                        org_run_id = self.org_context.run_id,
                        member_id = self.sender.member_id,
                        outcome = "rejected",
                        reason = "parameter_validation",
                        "[agent_org_metric] member_coordination_message"
                    );
                }
                return Err(error);
            }
        };
        if self.sender.is_coordinator && params.purpose.is_some() {
            return Err(ToolError::InvalidParams(
                "Coordinator → Member messages do not accept 'purpose'. Remove purpose and retry the same kind=plain message with the exact related_task_id. Nothing was delivered, and no Task or handoff state changed."
                    .to_string(),
            ));
        }
        let metric_task_id = params
            .related_task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let metric_purpose = params.purpose;
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

        let run_id = self.org_context.run_id.clone();
        let sender = self.sender.clone();
        let org_context = Arc::clone(&self.org_context);
        let receipt_key = AgentOrgToolReceiptKey::from_call_context(run_id.clone(), call_ctx)?;
        let call_session_id = call_ctx.session_id.clone();
        let call_turn_intent_id = call_ctx.turn_intent_id.clone();
        let operation = message.kind_tag();
        let (receipt, wake_member_ids, user_directed_wakes, abort_sender_after_commit) =
            tokio::task::spawn_blocking(move || {
                let mut wake_member_ids = Vec::new();
                let mut user_directed_wakes = Vec::new();
                let mut abort_sender_after_commit = false;
                let receipt = AgentOrgToolReceiptStore::execute(
                    receipt_key,
                    tool_names::ORG_SEND_MESSAGE,
                    operation,
                    &canonical_params,
                    |tx| {
                        let context = crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                            tx,
                            &call_session_id,
                            &call_turn_intent_id,
                        )
                        .map_err(|error| {
                            AgentOrgToolReceiptAbort::rejected(ToolError::InvalidParams(error))
                        })?;
                        if context.org_run_id != run_id
                            || context.participant_id != sender.member_id
                        {
                            return Err(AgentOrgToolReceiptAbort::rejected(
                                ToolError::PermissionDenied(
                                    "org_send_message caller does not match the persisted Agent Org Turn"
                                        .to_string(),
                                ),
                            ));
                        }

                        if context.is_user_directed_work() {
                            if sender.is_coordinator {
                                return Err(AgentOrgToolReceiptAbort::rejected(
                                    ToolError::PermissionDenied(
                                        "Coordinator formal tools cannot impersonate Member UserDirectedWork"
                                            .to_string(),
                                    ),
                                ));
                            }
                            if recipients.len() != 1 {
                                return Err(AgentOrgToolReceiptAbort::rejected(
                                    ToolError::InvalidParams(
                                        "UserDirectedWork must target exactly one participant"
                                            .to_string(),
                                    ),
                                ));
                            }
                            let recipient = &recipients[0];
                            if recipient.member_id == sender.member_id {
                                return Err(AgentOrgToolReceiptAbort::rejected(
                                    ToolError::InvalidParams(
                                        "linked_inbox_self_send: a Member cannot send work to itself"
                                            .to_string(),
                                    ),
                                ));
                            }
                            let link_allowed = match user_directed_link_allowed_in_tx(
                                tx,
                                &run_id,
                                &sender.member_id,
                                &recipient.member_id,
                            ) {
                                Ok(allowed) => allowed,
                                Err(error) => return classify_message_tool_error(error),
                            };
                            if !link_allowed {
                                return Err(AgentOrgToolReceiptAbort::rejected(
                                    ToolError::PermissionDenied(format!(
                                        "linked_inbox_link_denied: {} cannot message {} in the frozen Team snapshot",
                                        sender.member_id, recipient.member_id
                                    )),
                                ));
                            }
                            let child_result = if recipient.member_id == COORDINATOR_MEMBER_ID {
                                persist_user_directed_coordinator_message_in_tx(
                                    tx, &run_id, &sender, &context, &params, &message, recipient,
                                )
                            } else {
                                persist_user_directed_member_message_in_tx(
                                    tx, &run_id, &sender, &context, &params, &message, recipient,
                                )
                            };
                            let child = match child_result {
                                Ok(child) => child,
                                // Linked delivery validation and allocation share this
                                // receipt transaction with the source Inbox insert. Any
                                // rejection must abort the transaction so a failed depth,
                                // budget, target, or queue check cannot leave an orphan
                                // Inbox row or consume a root ordinal.
                                Err(error) => {
                                    return Err(AgentOrgToolReceiptAbort::rejected(error));
                                }
                            };
                            user_directed_wakes.push(UserDirectedWake {
                                org_run_id: run_id.clone(),
                                recipient_member_id: child.recipient_member_id.clone(),
                                recipient_session_id: child.recipient_session_id.clone(),
                                turn_intent_id: child.turn_intent_id.clone(),
                                content: child.content.clone(),
                                display_text: child.display_text.clone(),
                                images: None,
                            });
                            return serde_json::to_string(&json!({
                                "kind": "plain",
                                "org_run_id": run_id,
                                "sender_member_id": sender.member_id,
                                "delivered": [{
                                    "recipient_member_id": child.recipient_member_id,
                                    "inbox_id": child.inbox_id,
                                    "turn_intent_id": child.turn_intent_id,
                                    "member_dispatch_sequence": child.member_dispatch_sequence,
                                    "root_authority_turn_id": context.root_authority_turn_id,
                                }],
                                "user_directed": true,
                                "live_channel": false,
                            }))
                            .map(Ok)
                            .map_err(AgentOrgToolReceiptAbort::storage);
                        }

                        for recipient in &recipients {
                            if let RoutingDecision::Blocked(hint) = org_context
                                .check_routing(&sender.member_id, &recipient.member_id)
                            {
                                return Err(AgentOrgToolReceiptAbort::rejected(
                                    ToolError::InvalidParams(hint),
                                ));
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
                                if let Err(error) = ensure_recipients_deliverable_in_tx(
                                    tx,
                                    &run_id,
                                    &recipients,
                                ) {
                                    return classify_message_tool_error(error);
                                }
                            }
                            let revision = match AgentOrgPlanRevisionStore::get_pending_by_request_id_with_connection(
                                tx,
                                &run_id,
                                request_id.as_str(),
                            ) {
                                Ok(Some(approval)) => approval,
                                Ok(None) => {
                                    return Ok(Err(ToolError::InvalidParams(format!(
                                        "No pending Agent Org plan approval matches request_id '{}'",
                                        request_id.as_str()
                                    ))));
                                }
                                Err(error) => return classify_message_string_error(error),
                            };
                            if recipients.len() != 1
                                || recipients[0].member_id != revision.source_member_id
                            {
                                return Ok(Err(ToolError::InvalidParams(format!(
                                    "plan_approval_response request_id '{}' must target source member '{}'",
                                    request_id.as_str(),
                                    revision.source_member_id
                                ))));
                            }

                            if *accepted {
                                let approved = match AgentOrgPlanRevisionStore::approve_in_tx(
                                    tx,
                                    ApprovePlanRevisionInTxParams {
                                        approval_id: &revision.approval_id,
                                        plan_revision_id: &revision.plan_revision_id,
                                        source_task_id: &revision.source_task_id,
                                        source_turn_intent_id: &revision.source_turn_intent_id,
                                        decision_by: AgentOrgPlanDecisionBy::Coordinator,
                                        decision_source_session_id: &call_session_id,
                                        decision_source_turn_intent_id: Some(
                                            &context.turn_intent_id,
                                        ),
                                    },
                                ) {
                                    Ok(approved) => approved,
                                    Err(error) => return classify_message_string_error(error),
                                };
                                wake_member_ids = approved.wake_member_ids.clone();
                                return serde_json::to_string(&json!({
                                    "kind": "plan_approval_response",
                                    "request_id": request_id.as_str(),
                                    "org_run_id": run_id,
                                    "sender_member_id": sender.member_id,
                                    "approval_id": revision.approval_id,
                                    "source_task_id": revision.source_task_id,
                                    "decision": "approved",
                                    "woken_member_ids": wake_member_ids,
                                }))
                                .map(Ok)
                                .map_err(AgentOrgToolReceiptAbort::storage);
                            }

                            let feedback = feedback
                                .as_deref()
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .ok_or_else(|| {
                                    AgentOrgToolReceiptAbort::rejected(ToolError::InvalidParams(
                                        "A rejected plan requires non-empty feedback".to_string(),
                                    ))
                                })?;
                            let recipient = &recipients[0];
                            let delivery = AgentOrgPlanDecisionDelivery {
                                recipient_agent_id: recipient.agent_id.clone(),
                                sender_agent_id: sender.agent_id.clone(),
                                sender_member_id: Some(sender.member_id.clone()),
                            };
                            let (_, record) = match AgentOrgPlanRevisionStore::request_changes_in_tx(
                                tx,
                                crate::coordination::agent_org_plan_approvals::RequestPlanChangesParams {
                                    approval_id: &revision.approval_id,
                                    plan_revision_id: &revision.plan_revision_id,
                                    source_task_id: &revision.source_task_id,
                                    source_turn_intent_id: &revision.source_turn_intent_id,
                                    decision_by: AgentOrgPlanDecisionBy::Coordinator,
                                    decision_source_turn_intent_id: Some(&context.turn_intent_id),
                                    feedback,
                                    delivery,
                                },
                            ) {
                                Ok(result) => result,
                                Err(error) => return classify_message_string_error(error),
                            };
                            wake_member_ids.push(recipient.member_id.clone());
                            return serde_json::to_string(&json!({
                                "kind": "plan_approval_response",
                                "request_id": request_id.as_str(),
                                "org_run_id": run_id,
                                "sender_member_id": sender.member_id,
                                "approval_id": revision.approval_id,
                                "source_task_id": revision.source_task_id,
                                "decision": "changes_requested",
                                "inbox_id": record.id,
                                "woken_member_ids": wake_member_ids,
                            }))
                            .map(Ok)
                            .map_err(AgentOrgToolReceiptAbort::storage);
                        }

                        let persist_outcome = match persist_ordinary_message_in_tx(
                            tx,
                            &run_id,
                            &sender,
                            &context,
                            &params,
                            &message,
                            &recipients,
                        ) {
                            Ok(outcome) => outcome,
                            Err(error) => return classify_message_tool_error(error),
                        };
                        let delivered_rows = match persist_outcome {
                            OrdinaryMessagePersistOutcome::Guidance(guidance) => {
                                return Ok(Ok(guidance));
                            }
                            OrdinaryMessagePersistOutcome::Delivered { rows } => rows,
                        };
                        wake_member_ids.extend(
                            delivered_rows
                                .iter()
                                .map(|(recipient_member_id, _)| recipient_member_id.clone()),
                        );
                        abort_sender_after_commit = matches!(
                            message,
                            AgentMessage::ShutdownResponse { accepted: true, .. }
                        ) && !sender.is_coordinator;
                        let delivered = delivered_rows
                            .iter()
                            .map(|(recipient_member_id, inbox_id)| {
                                json!({
                                    "recipient_member_id": recipient_member_id,
                                    "inbox_id": inbox_id,
                                })
                            })
                            .collect::<Vec<_>>();
                        serde_json::to_string(&json!({
                            "kind": message.kind_tag(),
                            "request_id": message.request_id().map(|r| r.as_str().to_string()),
                            "related_task_id": params.related_task_id.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                            "purpose": params.purpose.map(MemberCoordinationPurpose::as_str),
                            "org_run_id": run_id,
                            "sender_member_id": sender.member_id,
                            "delivered": delivered,
                            "live_channel": false,
                        }))
                        .map(Ok)
                        .map_err(AgentOrgToolReceiptAbort::storage)
                    },
                )?;
                Ok::<_, ToolError>((
                    receipt,
                    wake_member_ids,
                    user_directed_wakes,
                    abort_sender_after_commit,
                ))
            })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org message persistence worker failed: {err}"))
        })??;
        if receipt.is_fresh() {
            if raw_member_coordination_request {
                let (outcome, reason) = match &receipt.result {
                    Ok(result) => serde_json::from_str::<Value>(result)
                        .ok()
                        .map(|value| {
                            if value.get("delivered").is_some_and(Value::is_array) {
                                ("delivered", "none".to_string())
                            } else {
                                (
                                    "guidance",
                                    value
                                        .get("reason")
                                        .and_then(Value::as_str)
                                        .unwrap_or("guidance")
                                        .to_string(),
                                )
                            }
                        })
                        .unwrap_or_else(|| ("rejected", "invalid_result".to_string())),
                    Err(_) => ("rejected", "tool_error".to_string()),
                };
                tracing::debug!(
                    org_run_id = self.org_context.run_id,
                    member_id = self.sender.member_id,
                    task_id = metric_task_id.as_deref().unwrap_or("none"),
                    purpose = metric_purpose
                        .map(MemberCoordinationPurpose::as_str)
                        .unwrap_or("none"),
                    outcome,
                    reason = reason.as_str(),
                    "[agent_org_metric] member_coordination_message"
                );
            }
            for member_id in &wake_member_ids {
                self.wake_hook
                    .wake_member(member_id, &self.org_context.run_id);
            }
            for wake in user_directed_wakes {
                self.wake_hook.wake_user_directed_member(wake);
            }
            if abort_sender_after_commit {
                self.self_abort_hook
                    .abort_self(&self.sender.member_id, &self.org_context.run_id);
            }
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                &self.org_context.run_id,
            );
        }
        receipt.result
    }

    /// Recipient resolution + JSON validation are read-only side-channel
    /// checks; only the inbox insert mutates state. Marking `false` because
    /// of the insert.
    fn is_read_only(&self) -> bool {
        false
    }
}
