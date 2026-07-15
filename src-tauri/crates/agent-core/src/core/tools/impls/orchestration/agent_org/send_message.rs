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
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::coordination::agent_inbox::{
    is_supported_agent_org_remote_mode, AgentInboxStore, AgentMessage, InsertInboxParams, RequestId,
};
use crate::coordination::agent_org_plan_approvals::{
    enqueue_post_approval_messages, AgentOrgPlanApprovalStore, AgentOrgPlanDecisionBy,
    AgentOrgPlanInboxDelivery,
};
use crate::coordination::agent_org_runs::{
    AgentOrgParticipant, AgentOrgRunContext, AgentOrgRunStore, RoutingDecision,
    COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::core::session::SessionStatus;
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, Tool, ToolError};

use super::tasks::task_dependencies_resolved;

/// Hook the tool calls (fire-and-forget) once an inbox row has been
/// persisted, so that idle or stopped recipient sessions can be woken
/// up to drain their inbox on a fresh background turn.
///
/// The hook receives `(recipient_member_id, org_run_id)` and is expected to:
/// 1. Resolve the recipient member_id to a session_id within the org run.
/// 2. Skip statuses that must not start a second/background turn: running,
///    pending, paused, waiting-for-user, waiting-for-funds, and archived.
/// 3. Otherwise spawn a fresh turn (e.g. via `send_message_impl` with
///    empty content) so the inbox-drain hook on the turn boundary fires.
///
/// The tool itself never blocks on the wake — failures and skips are
/// logged at the hook implementation. The persisted inbox row is the
/// source of truth; if the wake never happens, the row is still drained
/// the next time the recipient session takes a turn.
pub trait InboxWakeHook: Send + Sync {
    fn wake_member(&self, member_id: &str, org_run_id: &str);
}

/// No-op hook — used by tests and by org sessions that don't have a
/// runtime AppState (e.g. the in-memory unit tests in this file).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopInboxWakeHook;

impl InboxWakeHook for NoopInboxWakeHook {
    fn wake_member(&self, _member_id: &str, _org_run_id: &str) {}
}

/// Hook the tool calls (fire-and-forget) immediately after persisting a
/// `ShutdownResponse{accepted=true}`: the sender (the worker) signals
/// its own runtime to cancel its active turn so it stops doing work
/// while the coordinator processes the acknowledgement.
///
/// We use a hook trait instead of a direct call into `AgentState` so
/// the unit tests can observe the side effect without spinning up a
/// real runtime.
///
/// Failure / no-op behaviour: the persisted inbox row + the
/// coordinator-side drain (which calls `MemberShutdownHook` on the
/// member's runtime as a second safety net) ensure shutdown still
/// converges if this self-abort silently skips. The hook is therefore
/// best-effort by design.
pub trait SelfAbortHook: Send + Sync {
    /// Cancel the sender's own member session after a `shutdown_response`
    /// (`accepted=true`) has been persisted to the coordinator's inbox.
    fn abort_self(&self, sender_member_id: &str, org_run_id: &str);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSelfAbortHook;

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

impl SelfAbortHook for NoopSelfAbortHook {
    fn abort_self(&self, _sender_member_id: &str, _org_run_id: &str) {}
}

/// Tool params. Mirrors the typed `AgentMessage` enum but exposed as a
/// flat schema so the LLM does not need to know about Rust serde tags.
///
/// Validation precedence:
/// 1. `recipient_member_id` must be set and must be one of the allowed
///    member ids derived from the org graph.
/// 2. `kind` selects which body fields are required (see field docs).
/// 3. The constructed `AgentMessage::validate` runs last as a safety net.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrgSendMessageParams {
    /// Stable participant id inside this Agent Org run. Use only values
    /// listed in the tool description's allowed `recipient_member_id` set.
    #[serde(default)]
    pub recipient_member_id: Option<String>,

    /// Discriminator for the message body. One of:
    /// `plain | shutdown_request | shutdown_response | plan_approval_response`.
    ///
    /// Use `plain` for free-form text (the common case). The two
    /// `shutdown_*` kinds form an RPC pair: the coordinator sends
    /// `shutdown_request` to ask a worker to wind down, and the worker
    /// replies with `shutdown_response { accepted }` echoing the same
    /// `request_id`.
    ///
    /// `plan_approval_response` is the coordinator's reply to a member
    /// that previously submitted a plan via `create_plan`. The
    /// corresponding `plan_approval_request` is **not** LLM-callable —
    /// `create_plan` writes it directly into the coordinator's inbox so
    /// member sessions can never forge a plan request from a different
    /// session id. Coordinator → member: pick the `request_id` from the
    /// inbox attachment that delivered the plan. `accepted = true`
    /// completes the source planning task and unlocks dependent work;
    /// `accepted = false` plus `feedback` wakes the Planner once in Plan
    /// mode for revision.
    ///
    /// Permission and mode-switch flows live in their own user-facing
    /// systems (`interaction::permission`, `interaction::mode_switch`)
    /// and are deliberately NOT exposed as inter-agent message kinds.
    pub kind: String,

    /// Plain-message summary (≤ 200 chars). Required when `kind = "plain"`.
    #[serde(default)]
    pub summary: Option<String>,
    /// Plain-message body. Required when `kind = "plain"`.
    #[serde(default)]
    pub text: Option<String>,

    /// Durable task that gives a non-coordinator recipient authority and
    /// context to do formal work. Required for every `plain` message sent
    /// to a worker. Worker → coordinator escalation is exempt.
    #[serde(default)]
    pub related_task_id: Option<String>,

    /// Free-form note carried by `shutdown_response`.
    #[serde(default)]
    pub note: Option<String>,
    /// Reason carried by `shutdown_request`.
    #[serde(default)]
    pub reason: Option<String>,

    /// Correlation id for RPC variants. Sender-generated on the request;
    /// the responder MUST echo it back.
    #[serde(default)]
    pub request_id: Option<String>,

    /// `accepted` for `shutdown_response` and `plan_approval_response`.
    #[serde(default)]
    pub accepted: Option<bool>,

    /// Optional free-form feedback carried by `plan_approval_response`
    /// when `accepted = false`. Surfaced to the member as a user-visible
    /// message so its LLM can revise and re-submit the plan.
    #[serde(default)]
    pub feedback: Option<String>,

    /// Deprecated compatibility field for historical
    /// `plan_approval_response` rows. New Agent Org plans complete their
    /// source task on approval rather than starting a Build turn in Planner.
    #[serde(default)]
    pub next_mode: Option<String>,
}

/// Tool instance. Holds the org run context so we can resolve recipients
/// and tag persisted rows with the run id without re-querying SQLite per
/// call.
///
/// **Snapshot semantics**: `org_context` is an immutable snapshot
/// captured at session-init time inside `tool_assembly::assemble_overlay`.
/// We assume the org's coordinator + member roster does not change
/// during a single run. If/when join/leave is added (likely with the
/// name registry), the tool must be re-registered or migrated to read
/// from a `RwLock<AgentOrgRunContext>` shared with the run controller.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OrgRecipientTarget {
    member_id: String,
    agent_id: String,
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

    fn ensure_recipients_deliverable(
        &self,
        recipients: &[OrgRecipientTarget],
    ) -> Result<(), ToolError> {
        for recipient in recipients {
            if recipient.member_id == COORDINATOR_MEMBER_ID {
                continue;
            }
            let Some(info) = AgentOrgRunStore::list_worker_sessions_by_member_ids(
                &self.org_context.run_id,
                std::slice::from_ref(&recipient.member_id),
            )
            .map_err(ToolError::ExecutionFailed)?
            .into_iter()
            .next() else {
                continue;
            };
            if info.status == SessionStatus::Archived {
                return Err(ToolError::InvalidParams(format!(
                    "delivery_blocked: recipient_member_id '{}' is archived/closed (session_id='{}'); reopen the member session or start a new Agent Org run before sending",
                    recipient.member_id, info.session_id
                )));
            }
        }
        Ok(())
    }

    /// A free-form message may carry details about formal work, but it may
    /// never *create* invisible work. Every worker-directed plain message is
    /// therefore bound to one durable, unresolved task for that recipient.
    fn validate_plain_work_context(
        &self,
        params: &OrgSendMessageParams,
        message: &AgentMessage,
        recipients: &[OrgRecipientTarget],
    ) -> Result<Option<String>, ToolError> {
        if !matches!(message, AgentMessage::Plain { .. })
            || recipients
                .iter()
                .all(|recipient| recipient.member_id == COORDINATOR_MEMBER_ID)
        {
            return Ok(None);
        }

        let related_task_id = params
            .related_task_id
            .as_deref()
            .map(str::trim)
            .filter(|task_id| !task_id.is_empty());
        let Some(related_task_id) = related_task_id else {
            return serde_json::to_string(&json!({
                "delivered": false,
                "requires_task": true,
                "reason": "plain_worker_message_requires_related_task",
                "guidance": "Create or assign an unresolved durable task first, then retry org_send_message with related_task_id. A plain message cannot create invisible worker work.",
                "recipient_member_ids": recipients.iter().map(|recipient| recipient.member_id.clone()).collect::<Vec<_>>(),
            }))
            .map(Some)
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()));
        };

        let all_tasks = AgentOrgTaskStore::list(&self.org_context.run_id)
            .map_err(ToolError::ExecutionFailed)?;
        let task = all_tasks.iter().find(|task| task.id == related_task_id);
        let invalid_reason = match task {
            None => Some("related_task_not_found"),
            Some(task) if task.status.is_resolved() => Some("related_task_already_completed"),
            Some(task) if !task_dependencies_resolved(&all_tasks, task) => {
                Some("related_task_dependencies_unresolved")
            }
            Some(task)
                if recipients.iter().any(|recipient| {
                    task.owner.as_deref() != Some(recipient.member_id.as_str())
                }) =>
            {
                Some("related_task_not_owned_by_recipient")
            }
            Some(_) => None,
        };
        let Some(reason) = invalid_reason else {
            return Ok(None);
        };

        serde_json::to_string(&json!({
            "delivered": false,
            "requires_task": true,
            "reason": reason,
            "related_task_id": related_task_id,
            "guidance": "Use an unresolved, dependency-ready task already owned by the recipient. If it is ownerless, the coordinator must explicitly set owner_member_id first; eligibility alone is not assignment.",
            "recipient_member_ids": recipients.iter().map(|recipient| recipient.member_id.clone()).collect::<Vec<_>>(),
        }))
        .map(Some)
        .map_err(|err| ToolError::ExecutionFailed(err.to_string()))
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
        if let Some(guidance) = self.validate_plain_work_context(&params, &message, &recipients)? {
            return Ok(guidance);
        }

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
        if !matches!(
            &message,
            AgentMessage::PlanApprovalResponse { accepted: true, .. }
        ) {
            self.ensure_recipients_deliverable(&recipients)?;
        }

        if let AgentMessage::PlanApprovalResponse {
            request_id,
            accepted,
            feedback,
            ..
        } = &message
        {
            let approval = AgentOrgPlanApprovalStore::get_pending_by_request_id(
                &self.org_context.run_id,
                request_id.as_str(),
            )
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
                let approved = AgentOrgPlanApprovalStore::approve(
                    &approval.approval_id,
                    &approval.plan_revision_id,
                    AgentOrgPlanDecisionBy::Coordinator,
                    None,
                )
                .map_err(ToolError::ExecutionFailed)?;
                let wake_member_ids = enqueue_post_approval_messages(&self.org_context, &approved)
                    .map_err(ToolError::ExecutionFailed)?;
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
            let (_, record) = AgentOrgPlanApprovalStore::request_changes(
                &approval.approval_id,
                &approval.plan_revision_id,
                AgentOrgPlanDecisionBy::Coordinator,
                feedback,
                AgentOrgPlanInboxDelivery {
                    recipient_agent_id: recipient.agent_id.clone(),
                    sender_agent_id: self.sender.agent_id.clone(),
                    sender_member_id: Some(self.sender.member_id.clone()),
                },
            )
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

        let mut delivered = Vec::with_capacity(recipients.len());
        for recipient in recipients {
            let record = AgentInboxStore::insert(InsertInboxParams {
                recipient_agent_id: recipient.agent_id.clone(),
                recipient_member_id: Some(recipient.member_id.clone()),
                sender_agent_id: self.sender.agent_id.clone(),
                sender_member_id: Some(self.sender.member_id.clone()),
                org_run_id: Some(self.org_context.run_id.clone()),
                message: message.clone(),
            })
            .map_err(ToolError::ExecutionFailed)?;
            delivered.push(json!({
                "recipient_member_id": recipient.member_id,
                "inbox_id": record.id,
            }));

            self.wake_hook
                .wake_member(&recipient.member_id, &self.org_context.run_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_runs::{AgentOrgContextMember, COORDINATOR_MEMBER_ID};
    use crate::coordination::agent_org_tasks::{
        new_task_id, AgentOrgTaskStore, CreateTaskParams, TaskStatus,
        TASK_METADATA_ELIGIBLE_MEMBER_IDS,
    };
    use crate::definitions::orgs::HierarchyMode;
    use std::sync::Mutex;

    fn context() -> Arc<AgentOrgRunContext> {
        context_with_mode(HierarchyMode::Strict)
    }

    fn context_with_mode(hierarchy_mode: HierarchyMode) -> Arc<AgentOrgRunContext> {
        Arc::new(AgentOrgRunContext {
            run_id: "run-1".to_string(),
            org_id: "org-1".to_string(),
            org_name: "Org".to_string(),
            org_role: "lead".to_string(),
            coordinator_agent_id: "agent-coord".to_string(),
            coordinator_name: "Coordinator".to_string(),
            coordinator_role: "lead".to_string(),
            members: vec![
                AgentOrgContextMember {
                    member_id: "planner".to_string(),
                    name: "Planner".to_string(),
                    role: "plan".to_string(),
                    agent_id: "agent-shared".to_string(),
                    parent_member_id: None,
                },
                AgentOrgContextMember {
                    member_id: "builder".to_string(),
                    name: "Builder".to_string(),
                    role: "build".to_string(),
                    agent_id: "agent-shared".to_string(),
                    parent_member_id: Some("planner".to_string()),
                },
            ],
            hierarchy_mode,
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            root_session_id: Some("root-1".to_string()),
        })
    }

    fn params(recipient_member_id: &str) -> serde_json::Value {
        json!({
            "recipient_member_id": recipient_member_id,
            "kind": "plain",
            "summary": "hello",
            "text": "hello"
        })
    }

    fn seed_owned_task(owner_member_id: &str) -> String {
        let task_id = new_task_id();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.clone(),
            org_run_id: "run-1".to_string(),
            subject: "Durable formal work".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some(owner_member_id.to_string()),
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(json!({
                TASK_METADATA_ELIGIBLE_MEMBER_IDS: [owner_member_id],
            })),
        })
        .expect("seed task");
        task_id
    }

    #[derive(Default, Debug)]
    struct RecordingWakeHook {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingWakeHook {
        fn snapshot(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl InboxWakeHook for RecordingWakeHook {
        fn wake_member(&self, member_id: &str, org_run_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((member_id.to_string(), org_run_id.to_string()));
        }
    }

    #[derive(Default, Debug)]
    struct RecordingSelfAbortHook {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingSelfAbortHook {
        fn snapshot(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl SelfAbortHook for RecordingSelfAbortHook {
        fn abort_self(&self, sender_member_id: &str, org_run_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((sender_member_id.to_string(), org_run_id.to_string()));
        }
    }

    fn init_inbox_schema() -> test_helpers::test_env::SandboxGuard {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().expect("test sqlite connection");
        crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
            .expect("agent sessions schema");
        crate::session::persistence::init(&conn).expect("session schema");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
        sandbox
    }

    #[test]
    fn resolves_only_recipient_member_id() {
        let tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
        let recipients = tool
            .resolve_recipient(&OrgSendMessageParams {
                recipient_member_id: Some("builder".to_string()),
                kind: "plain".to_string(),
                summary: Some("hello".to_string()),
                text: Some("hello".to_string()),
                related_task_id: None,
                note: None,
                reason: None,
                request_id: None,
                accepted: None,
                feedback: None,
                next_mode: None,
            })
            .expect("builder should be addressable");

        assert_eq!(recipients[0].member_id, "builder");
        assert_eq!(recipients[0].agent_id, "agent-shared");
    }

    #[test]
    fn rejects_unroutable_member_id_with_allowed_ids() {
        let tool = OrgSendMessageTool::new(context(), "builder".to_string());
        let error = tool
            .resolve_recipient(&OrgSendMessageParams {
                recipient_member_id: Some("ghost".to_string()),
                kind: "plain".to_string(),
                summary: Some("hello".to_string()),
                text: Some("hello".to_string()),
                related_task_id: None,
                note: None,
                reason: None,
                request_id: None,
                accepted: None,
                feedback: None,
                next_mode: None,
            })
            .expect_err("unknown member id should fail");

        assert!(error.contains("recipient_member_id 'ghost'"), "{error}");
        assert!(error.contains("coordinator"), "{error}");
        assert!(error.contains("planner"), "{error}");
    }

    #[test]
    fn schema_keeps_openai_compatible_routing_fields() {
        let tool = OrgSendMessageTool::new(context(), "builder".to_string());
        let schema = tool.parameters();

        assert_eq!(
            schema["properties"]["recipient_member_id"]["type"].as_str(),
            Some("string")
        );
        assert_eq!(
            schema["properties"]["kind"]["type"].as_str(),
            Some("string")
        );
        assert!(schema["properties"]["recipient_member_id"]
            .get("enum")
            .is_none());
        assert!(schema["properties"]["kind"].get("enum").is_none());
        assert!(schema.get("allOf").is_none());
    }

    #[test]
    fn llm_description_carries_flat_hierarchy_routing_hints() {
        let tool = OrgSendMessageTool::new(
            context_with_mode(HierarchyMode::Flat),
            "builder".to_string(),
        );
        let description = tool.llm_description().expect("description");

        assert!(description.contains("hierarchy_mode: flat"));
        assert!(description.contains("recipient_member_id enum: [coordinator, planner]"));
    }

    #[test]
    fn llm_description_recipient_hints_follow_strict_hierarchy_mode() {
        let coordinator_tool = OrgSendMessageTool::new(
            context_with_mode(HierarchyMode::Strict),
            COORDINATOR_MEMBER_ID.to_string(),
        );
        let builder_tool = OrgSendMessageTool::new(
            context_with_mode(HierarchyMode::Strict),
            "builder".to_string(),
        );

        assert!(coordinator_tool
            .llm_description()
            .expect("description")
            .contains("recipient_member_id enum: [builder, planner]"));
        assert!(builder_tool
            .llm_description()
            .expect("description")
            .contains("recipient_member_id enum: [coordinator, planner]"));
    }

    #[test]
    fn llm_description_restricts_kind_by_sender_role() {
        let coordinator_tool =
            OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
        let member_tool = OrgSendMessageTool::new(context(), "builder".to_string());

        assert!(coordinator_tool
            .llm_description()
            .expect("description")
            .contains(
                "kind enum for this sender: [plain, shutdown_request, plan_approval_response]"
            ));
        assert!(member_tool
            .llm_description()
            .expect("description")
            .contains("kind enum for this sender: [plain, shutdown_response]"));
    }

    #[test]
    fn llm_description_explains_planning_protocol() {
        let tool = OrgSendMessageTool::new(context(), COORDINATOR_MEMBER_ID.to_string());
        let description = tool.llm_description().expect("description");

        assert!(
            description.contains("Coordinator planning protocol"),
            "description must include planning protocol guidance: {description}"
        );
        assert!(
            description.contains("task_create execution_mode=\"plan\"")
                && description.contains("starts in Plan mode automatically"),
            "description must explain task-scoped Plan mode: {description}"
        );
        assert!(
            description.contains("kind = \"plan_approval_response\"")
                && description.contains("accepted = true")
                && description.contains("accepted = false"),
            "description must explain member plan approval and rejection: {description}"
        );
        assert!(
            description.contains("durable approval bound to that planning task"),
            "description must bind approval to the planning task: {description}"
        );
    }

    #[test]
    fn llm_description_lists_only_member_ids() {
        let tool = OrgSendMessageTool::new(context(), "builder".to_string());
        let description = tool.llm_description().expect("description");

        assert!(description.contains("Current Agent Org routing context"));
        assert!(description.contains("hierarchy_mode: strict"));
        assert!(description.contains("sender_member_id: builder"));
        assert!(description.contains("recipient_member_id enum: [coordinator, planner]"));
        assert!(!description.contains("recipient_agent_id"));
        assert!(!description.contains("recipient_name"));
        assert!(!description.contains("Builder"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn execute_persists_and_wakes_by_member_id() {
        let _sandbox = init_inbox_schema();
        let task_id = seed_owned_task("builder");
        let wake = Arc::new(RecordingWakeHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            COORDINATOR_MEMBER_ID.to_string(),
            wake.clone(),
            Arc::new(NoopSelfAbortHook),
        );

        let mut input = params("builder");
        input["related_task_id"] = Value::String(task_id);
        let result = tool
            .execute_text(input, &crate::tools::call_context::CallContext::default())
            .await
            .expect("send should succeed");
        let value: serde_json::Value = serde_json::from_str(&result).expect("json result");

        assert_eq!(value["sender_member_id"].as_str(), Some("coordinator"));
        assert_eq!(
            value["delivered"][0]["recipient_member_id"].as_str(),
            Some("builder")
        );
        assert!(value["delivered"][0].get("recipient_agent_id").is_none());
        assert_eq!(
            wake.snapshot(),
            vec![("builder".to_string(), "run-1".to_string())]
        );

        let rows = AgentInboxStore::list_unread_for_member("builder", "run-1").expect("inbox");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].recipient_member_id.as_deref(), Some("builder"));
        assert_eq!(rows[0].sender_member_id.as_deref(), Some("coordinator"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn plain_message_to_worker_without_task_returns_guidance_and_does_not_wake() {
        let _sandbox = init_inbox_schema();
        let wake = Arc::new(RecordingWakeHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            COORDINATOR_MEMBER_ID.to_string(),
            wake.clone(),
            Arc::new(NoopSelfAbortHook),
        );

        let result = tool
            .execute_text(
                params("builder"),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .expect("missing task is recoverable guidance, not a red tool error");
        let value: Value = serde_json::from_str(&result).expect("guidance json");

        assert_eq!(value["delivered"].as_bool(), Some(false));
        assert_eq!(value["requires_task"].as_bool(), Some(true));
        assert_eq!(
            value["reason"].as_str(),
            Some("plain_worker_message_requires_related_task")
        );
        assert!(wake.snapshot().is_empty());
        assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
            .expect("inbox")
            .is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn plain_message_cannot_turn_ownerless_eligibility_into_assignment() {
        let _sandbox = init_inbox_schema();
        let task_id = new_task_id();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.clone(),
            org_run_id: "run-1".to_string(),
            subject: "Await coordinator assignment".to_string(),
            description: String::new(),
            active_form: None,
            owner: None,
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(json!({
                TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
            })),
        })
        .expect("seed ownerless task");
        let wake = Arc::new(RecordingWakeHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            COORDINATOR_MEMBER_ID.to_string(),
            wake.clone(),
            Arc::new(NoopSelfAbortHook),
        );
        let mut input = params("builder");
        input["related_task_id"] = json!(task_id);

        let result = tool
            .execute_text(input, &crate::tools::call_context::CallContext::default())
            .await
            .expect("ownerless work returns structured guidance");
        let value: Value = serde_json::from_str(&result).expect("guidance json");
        assert_eq!(value["delivered"], false);
        assert_eq!(value["reason"], "related_task_not_owned_by_recipient");
        assert!(wake.snapshot().is_empty());
        assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
            .expect("inbox")
            .is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn plain_message_cannot_wake_worker_before_related_task_dependencies_complete() {
        let _sandbox = init_inbox_schema();
        let upstream_id = seed_owned_task("planner");
        let child_id = new_task_id();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: child_id.clone(),
            org_run_id: "run-1".to_string(),
            subject: "Review only after upstream".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("builder".to_string()),
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: vec![upstream_id],
            metadata: Some(json!({
                TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["builder"],
            })),
        })
        .expect("seed blocked child");
        let wake = Arc::new(RecordingWakeHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            COORDINATOR_MEMBER_ID.to_string(),
            wake.clone(),
            Arc::new(NoopSelfAbortHook),
        );
        let mut input = params("builder");
        input["related_task_id"] = json!(child_id);

        let result = tool
            .execute_text(input, &crate::tools::call_context::CallContext::default())
            .await
            .expect("blocked work returns guidance");
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["reason"], "related_task_dependencies_unresolved");
        assert!(wake.snapshot().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn worker_status_message_to_coordinator_does_not_require_task() {
        let _sandbox = init_inbox_schema();
        let tool = OrgSendMessageTool::new(context(), "builder".to_string());

        let result = tool
            .execute_text(
                params("coordinator"),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .expect("worker escalation to coordinator remains available");
        let value: Value = serde_json::from_str(&result).expect("result json");
        assert_eq!(
            value["delivered"][0]["recipient_member_id"].as_str(),
            Some("coordinator")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn shutdown_response_to_coordinator_self_aborts_sender_member() {
        let _sandbox = init_inbox_schema();
        let abort = Arc::new(RecordingSelfAbortHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            "builder".to_string(),
            Arc::new(NoopInboxWakeHook),
            abort.clone(),
        );

        tool.execute_text(
            json!({
                "recipient_member_id": "coordinator",
                "kind": "shutdown_response",
                "request_id": "req-1",
                "accepted": true
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .expect("shutdown response should send");

        assert_eq!(
            abort.snapshot(),
            vec![("builder".to_string(), "run-1".to_string())]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn shutdown_response_to_member_is_rejected_before_wake() {
        let _sandbox = init_inbox_schema();
        let wake = Arc::new(RecordingWakeHook::default());
        let tool = OrgSendMessageTool::with_hooks(
            context(),
            COORDINATOR_MEMBER_ID.to_string(),
            wake.clone(),
            Arc::new(NoopSelfAbortHook),
        );

        let error = tool
            .execute_text(
                json!({
                    "recipient_member_id": "builder",
                    "kind": "shutdown_response",
                    "request_id": "req-2",
                    "accepted": true
                }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .expect_err("shutdown response to non-coordinator should fail")
            .to_string();

        assert!(
            error.contains("shutdown_response") && error.contains("coordinator"),
            "{error}"
        );
        assert!(wake.snapshot().is_empty());
        assert!(AgentInboxStore::list_unread_for_member("builder", "run-1")
            .expect("inbox")
            .is_empty());
    }
}
