//! Sections describing how the agent talks to other actors: messaging, silent
//! replies, ATC, Agent Org run context, task routing, and sub-agent
//! delegation.

use crate::core::session::prompt::cache::PromptCachePolicy;
use crate::core::session::prompt::registry::{
    order, AppliesDecision, PromptCtx, PromptSection, PromptSource,
};
use crate::core::session::prompt::section_builders::*;

use crate::tools::names as tool_names;

// ---------------------------------------------------------------------
// 110. Messaging (when send_message tool is available)
// ---------------------------------------------------------------------

pub struct MessagingSection;

impl PromptSection for MessagingSection {
    fn id(&self) -> &'static str {
        "messaging"
    }
    fn order_hint(&self) -> i32 {
        order::MESSAGING
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.has_tool(tool_names::SEND_MESSAGE) {
            AppliesDecision::Apply {
                reason: "send_message_tool_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_send_message_tool",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_messaging_section())
    }
}

// ---------------------------------------------------------------------
// 120. Silent replies — paired with messaging
// ---------------------------------------------------------------------

pub struct SilentRepliesSection;

impl PromptSection for SilentRepliesSection {
    fn id(&self) -> &'static str {
        "silent_replies"
    }
    fn order_hint(&self) -> i32 {
        order::SILENT_REPLIES
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.has_tool(tool_names::SEND_MESSAGE) {
            AppliesDecision::Apply {
                reason: "send_message_tool_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_send_message_tool",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_silent_replies_section())
    }
}

// ---------------------------------------------------------------------
// 130. ATC (Air Traffic Control) — when manage_atc tool is available
// ---------------------------------------------------------------------

pub struct AtcSection;

impl PromptSection for AtcSection {
    fn id(&self) -> &'static str {
        "atc"
    }
    fn order_hint(&self) -> i32 {
        order::ATC
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.has_tool("manage_atc") {
            AppliesDecision::Apply {
                reason: "manage_atc_tool_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_manage_atc_tool",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_atc_section())
    }
}

// ---------------------------------------------------------------------
// 140. Agent Org context — cross-agent coordination
// ---------------------------------------------------------------------

pub struct AgentOrgContextSection;

impl PromptSection for AgentOrgContextSection {
    fn id(&self) -> &'static str {
        "agent_org_context"
    }
    fn order_hint(&self) -> i32 {
        order::AGENT_ORG_CONTEXT
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.agent_org_context.is_some() {
            AppliesDecision::Apply {
                reason: "agent_org_context_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_agent_org_context",
            }
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "agent_org_context",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        ctx.config.agent_org_context.as_ref().map(|context| {
            build_agent_org_context_section(
                context,
                &ctx.config.agent_id,
                ctx.config.agent_org_current_member_id.as_deref(),
            )
        })
    }
}

// ---------------------------------------------------------------------
// 150. Task routing — when `agent` tool is available
// ---------------------------------------------------------------------

pub struct TaskRoutingSection;

impl PromptSection for TaskRoutingSection {
    fn id(&self) -> &'static str {
        "task_routing"
    }
    fn order_hint(&self) -> i32 {
        order::TASK_ROUTING
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.has_tool(tool_names::AGENT) {
            AppliesDecision::Apply {
                reason: "agent_tool_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_agent_tool",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        Some(build_task_routing_section(
            ctx.config.product_mode.as_deref() == Some("project"),
        ))
    }
}

// ---------------------------------------------------------------------
// 160. Sub-agent delegation — when `agent` tool is available
// ---------------------------------------------------------------------

pub struct SubAgentDelegationSection;

impl PromptSection for SubAgentDelegationSection {
    fn id(&self) -> &'static str {
        "sub_agent_delegation"
    }
    fn order_hint(&self) -> i32 {
        order::SUB_AGENT_DELEGATION
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.has_tool(tool_names::AGENT) {
            AppliesDecision::Apply {
                reason: "agent_tool_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_agent_tool",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_sub_agent_delegation_section())
    }
}
