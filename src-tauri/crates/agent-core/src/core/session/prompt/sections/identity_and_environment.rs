//! Sections that establish who the agent is and where it is running:
//! identity, system meta, environment, model identity, the tool listing, and
//! MCP server instructions.

use std::path::Path;

use crate::core::session::prompt::cache::PromptCachePolicy;
use crate::core::session::prompt::registry::{
    order, AppliesDecision, PromptCtx, PromptSection, PromptSource,
};
use crate::core::session::prompt::section_builders::*;

// ---------------------------------------------------------------------
// 10. Identity
// ---------------------------------------------------------------------

/// `agent_soul` (from `AgentDefinition.soul_content`) is the single
/// source of truth for the agent's role. Always present — even sovereign
/// agents render this. When `agent_soul` is empty we fall back to a
/// neutral helper string so the prompt is never literally empty.
pub struct IdentitySection;

impl PromptSection for IdentitySection {
    fn id(&self) -> &'static str {
        "identity"
    }
    fn order_hint(&self) -> i32 {
        order::IDENTITY
    }
    fn applies(&self, _ctx: &PromptCtx) -> AppliesDecision {
        AppliesDecision::Apply { reason: "always" }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "agent_definition.soul_content",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        Some(
            ctx.config
                .agent_soul
                .clone()
                .unwrap_or_else(|| "You are a helpful AI assistant.".to_string()),
        )
    }
}

// ---------------------------------------------------------------------
// 20. System meta — prompt-injection defense + compaction notice
// ---------------------------------------------------------------------

pub struct SystemMetaSection;

impl PromptSection for SystemMetaSection {
    fn id(&self) -> &'static str {
        "system_meta"
    }
    fn order_hint(&self) -> i32 {
        order::SYSTEM_META
    }
    fn applies(&self, _ctx: &PromptCtx) -> AppliesDecision {
        AppliesDecision::Apply { reason: "always" }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_system_meta_section())
    }
}

// ---------------------------------------------------------------------
// 30. Environment — channel runtime line OR project working dir
// ---------------------------------------------------------------------

pub struct EnvironmentSection;

impl PromptSection for EnvironmentSection {
    fn id(&self) -> &'static str {
        "environment"
    }
    fn order_hint(&self) -> i32 {
        order::ENVIRONMENT
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Apply {
                reason: "channel_session",
            }
        } else if ctx.config.workspace.is_some() {
            AppliesDecision::Apply {
                reason: "workspace_session",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_workspace_or_channel",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        if ctx.is_channel_session {
            return Some(build_channel_environment(ctx.config, ctx.tool_summaries));
        }
        let ws = ctx.config.workspace.as_ref()?;
        let additional_dirs: Vec<&Path> = ws
            .additional_directories
            .keys()
            .map(|p| p.as_path())
            .collect();
        Some(build_project_environment(
            ws.working_dir(),
            &additional_dirs,
        ))
    }
}

// ---------------------------------------------------------------------
// 40. Model identity (knowledge cutoff, family name)
// ---------------------------------------------------------------------

pub struct ModelIdentitySection;

impl PromptSection for ModelIdentitySection {
    fn id(&self) -> &'static str {
        "model_identity"
    }
    fn order_hint(&self) -> i32 {
        order::MODEL_IDENTITY
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if build_model_identity(&ctx.config.model).is_some() {
            AppliesDecision::Apply {
                reason: "model_known",
            }
        } else {
            AppliesDecision::Skip {
                reason: "model_unknown",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        build_model_identity(&ctx.config.model)
    }
}

// ---------------------------------------------------------------------
// 50. Available tools — name-only listing for non-channel sessions
// ---------------------------------------------------------------------
//
// Channel sessions get the detailed listing as part of
// `EnvironmentSection`. This section emits the compact name-only list
// the SDE/coding flow expects.
pub struct AvailableToolsSection;

impl PromptSection for AvailableToolsSection {
    fn id(&self) -> &'static str {
        "available_tools"
    }
    fn order_hint(&self) -> i32 {
        order::AVAILABLE_TOOLS
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Skip {
                reason: "channel_uses_environment_listing",
            }
        } else if ctx.tool_names.is_empty() {
            AppliesDecision::Skip { reason: "no_tools" }
        } else {
            AppliesDecision::Apply {
                reason: "non_channel_with_tools",
            }
        }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        if ctx.tool_names.is_empty() {
            return None;
        }
        Some(format!(
            "## Available Tools\n\nYou have access to these tools: {}",
            ctx.tool_names.join(", ")
        ))
    }
}

// ---------------------------------------------------------------------
// 55. MCP server instructions — from InitializeResult.instructions
// ---------------------------------------------------------------------

/// Usage guidance published by connected MCP servers during the initialize
/// handshake. Reads the process-global snapshot maintained by `McpManager`
/// (see `specialization::mcp::instructions`); per-session visibility is
/// enforced by only rendering servers with a `mcp__<server>__*` tool
/// registered in this session.
pub struct McpInstructionsSection;

impl PromptSection for McpInstructionsSection {
    fn id(&self) -> &'static str {
        "mcp_instructions"
    }
    fn order_hint(&self) -> i32 {
        order::MCP_INSTRUCTIONS
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.tool_names.iter().any(|name| name.starts_with("mcp__")) {
            AppliesDecision::Apply {
                reason: "mcp_tools_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_mcp_tools",
            }
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "specialization::mcp::instructions",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        // Servers reconnect (and can change instructions) mid-session.
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let entries = crate::specialization::mcp::instructions::snapshot();
        build_mcp_instructions_section(&entries, &ctx.tool_names)
    }
}
