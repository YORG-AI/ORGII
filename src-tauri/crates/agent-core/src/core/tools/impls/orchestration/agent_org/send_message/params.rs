//! `OrgSendMessageParams` — the flat LLM-facing schema for
//! `org_send_message`, mirroring the typed `AgentMessage` enum without
//! exposing serde tags to the model.

use schemars::JsonSchema;
use serde::Deserialize;

/// Tool params. Mirrors the typed `AgentMessage` enum but exposed as a
/// flat schema so the LLM does not need to know about Rust serde tags.
///
/// Validation precedence:
/// 1. `recipient_member_id` must be set and must be one of the allowed
///    member ids derived from the org graph.
/// 2. `kind` selects which body fields are required (see field docs).
/// 3. The constructed `AgentMessage::validate` runs last as a safety net.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
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
