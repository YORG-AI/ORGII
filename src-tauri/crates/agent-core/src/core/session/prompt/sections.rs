//! `PromptSection` trait implementations.
//!
//! Each section is a zero-sized marker struct. Per-call state flows through
//! `PromptCtx`. Ordering, sovereign-safety, and gating are declared on the
//! trait impl so a contributor can read one block and see the full policy.
//!
//! String builders for section content live in `section_builders`.

use std::path::Path;

use super::cache::PromptCachePolicy;
use super::helpers::load_conventions;
use super::registry::{order, AppliesDecision, PromptCtx, PromptSection, PromptSource};
use super::section_builders::*;

pub use super::section_builders::build_agent_org_context_section;
pub(crate) use super::section_builders::build_agent_org_context_section_with_task_snapshot;

use crate::skills::loader::SkillsLoader;
use crate::tools::names as tool_names;

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

// ---------------------------------------------------------------------
// 60. Behavioral rules — channel vs SDE
// ---------------------------------------------------------------------

pub struct BehavioralRulesSection;

impl PromptSection for BehavioralRulesSection {
    fn id(&self) -> &'static str {
        "behavioral_rules"
    }
    fn order_hint(&self) -> i32 {
        order::BEHAVIORAL_RULES
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Apply {
                reason: "channel_session",
            }
        } else if ctx.config.workspace.is_some() {
            AppliesDecision::Apply {
                reason: "sde_workspace",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_workspace_or_channel",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        if ctx.is_channel_session {
            // Only Project sessions may mutate the work system through
            // `org2-pm`; the guidance tracks that application-boundary
            // gate rather than a tool surface.
            Some(build_channel_behavioral_rules(
                ctx.config,
                ctx.config.product_mode.as_deref() == Some("project"),
            ))
        } else if ctx.config.workspace.is_some() {
            Some(sde_behavioral_rules())
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------
// 70. Project conventions — `.orgii/agent-rules.md`
// ---------------------------------------------------------------------

pub struct ProjectConventionsSection;

impl PromptSection for ProjectConventionsSection {
    fn id(&self) -> &'static str {
        "project_conventions"
    }
    fn order_hint(&self) -> i32 {
        order::PROJECT_CONVENTIONS
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            return AppliesDecision::Skip {
                reason: "channel_session_no_conventions",
            };
        }
        if ctx.config.workspace.is_none() {
            return AppliesDecision::Skip {
                reason: "no_workspace",
            };
        }
        AppliesDecision::Apply {
            reason: "workspace_session",
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "workspace/.orgii/agent-rules.md",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let ws = ctx.config.workspace.as_ref()?;
        // Single authoritative cap: `load_conventions` already enforces its
        // 40KB budget; a second cap here would silently halve it.
        let conventions = load_conventions(ws.working_dir())?;
        Some(format!("## Project Conventions\n\n{}", conventions))
    }
}

// ---------------------------------------------------------------------
// 80. Rules — `.orgii/rules/` + per-agent personal rules
// ---------------------------------------------------------------------

/// Channel/OS Agent: load from `~/.orgii/personal/rules/` only.
/// SDE/CLI: load from global `~/.orgii/rules/` + project `.orgii/rules/`.
/// `applies()` returns `Apply` whenever there's any chance of rules to
/// load; `render()` returns `None` when the loaded list is empty so the
/// section drops silently.
pub struct RulesSection;

impl PromptSection for RulesSection {
    fn id(&self) -> &'static str {
        "rules"
    }
    fn order_hint(&self) -> i32 {
        order::RULES
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session || ctx.config.workspace.is_some() {
            AppliesDecision::Apply {
                reason: "rule_loader_runnable",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_workspace_or_channel",
            }
        }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "policies::load_enabled_policies",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let enabled_rules: Vec<(String, String)> = if ctx.is_channel_session {
            crate::specialization::policies::load_enabled_unconditional_policies_for_os_agent(
                &ctx.config.agent_id,
            )
        } else if let Some(ref ws) = ctx.config.workspace {
            crate::specialization::policies::load_enabled_unconditional_policies_with_workspace_scope(
                ws.working_dir(),
                &ctx.config.agent_id,
                ctx.config.load_workspace_rules,
            )
        } else if ctx.sovereign {
            // Sovereign agents reuse the OS-agent rule loader so personal
            // rules apply to gateway-style agents as well.
            crate::specialization::policies::load_enabled_unconditional_policies_for_os_agent(
                &ctx.config.agent_id,
            )
        } else {
            Vec::new()
        };
        if enabled_rules.is_empty() {
            None
        } else {
            Some(build_rules_section(&enabled_rules))
        }
    }
}

// ---------------------------------------------------------------------
// 90. Always skill manifest (SkillsLoader)
// ---------------------------------------------------------------------

pub struct AlwaysSkillsSection;

impl PromptSection for AlwaysSkillsSection {
    fn id(&self) -> &'static str {
        "always_skills"
    }
    fn order_hint(&self) -> i32 {
        order::ALWAYS_SKILLS
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.skills.enabled {
            AppliesDecision::Apply {
                reason: "skills_enabled",
            }
        } else {
            AppliesDecision::Skip {
                reason: "skills_disabled",
            }
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "skills::loader",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let workspace = ctx
            .config
            .workspace
            .as_ref()
            .map(|ws| ws.working_dir())
            .unwrap_or_else(|| Path::new("."));
        let skills_dir = workspace.join(".orgii");

        let skills = &ctx.config.skills;
        let include_filter: Option<&[String]> = if skills.include.is_empty() {
            None
        } else {
            Some(skills.include.as_slice())
        };

        let mut loader = SkillsLoader::new(&skills_dir)
            .with_builtin_dir(crate::skills::loader::global_skills_dir())
            .with_agent_id(ctx.config.agent_id.clone())
            .with_load_workspace_resources(ctx.config.load_workspace_resources);
        if !skills.source_dirs.is_empty() {
            loader = loader.with_extra_source_dirs(&skills.source_dirs);
        }
        let always_manifest_sections =
            loader.build_always_skills_manifest_section(&skills.disabled, include_filter);
        if always_manifest_sections.is_empty() {
            None
        } else {
            Some(always_manifest_sections.join("\n\n"))
        }
    }
}

// ---------------------------------------------------------------------
// 100. Learnings — L3 cross-session memory injection
// ---------------------------------------------------------------------

pub struct LearningsSection;

impl PromptSection for LearningsSection {
    fn id(&self) -> &'static str {
        "learnings"
    }
    fn order_hint(&self) -> i32 {
        order::LEARNINGS
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.agent_definition_id.is_some() {
            AppliesDecision::Apply {
                reason: "agent_definition_id_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_agent_definition_id",
            }
        }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "memory::learnings",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::RevisionKeyed
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let def_id = ctx.config.agent_definition_id.as_ref()?;
        let scope = format!("agent:{}", def_id);
        let learnings_section =
            crate::memory::learnings::inject_learnings_into_prompt(&scope, None);
        if learnings_section.is_empty() {
            None
        } else {
            Some(learnings_section)
        }
    }
}

// ---------------------------------------------------------------------
// 105. Workspace memory protocol (location + save/access contract)
// ---------------------------------------------------------------------

pub struct WorkspaceMemoryProtocolSection;

impl PromptSection for WorkspaceMemoryProtocolSection {
    fn id(&self) -> &'static str {
        "memory_protocol"
    }
    fn order_hint(&self) -> i32 {
        order::MEMORY_PROTOCOL
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.workspace.is_some() {
            AppliesDecision::Apply {
                reason: "workspace_session",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_workspace",
            }
        }
    }
    fn sovereign_safe(&self) -> bool {
        true
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "memory::workspace_memory",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        // Static text keyed only by the workspace path — the recall half
        // (index + selected memories) rides the per-turn prefetch surface
        // instead. Keeping the protocol here means a zero-tool
        // conversational turn ("remember this…") still has the save
        // contract in context, which the async prefetch cannot guarantee.
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let ws = ctx.config.workspace.as_ref()?;
        Some(
            crate::memory::workspace_memory::prefetch::build_memory_protocol_section(
                ws.working_dir(),
            ),
        )
    }
}

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

// ---------------------------------------------------------------------
// 170. Command approval — non-channel only
// ---------------------------------------------------------------------

pub struct CommandApprovalSection;

impl PromptSection for CommandApprovalSection {
    fn id(&self) -> &'static str {
        "command_approval"
    }
    fn order_hint(&self) -> i32 {
        order::COMMAND_APPROVAL
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Skip {
                reason: "channel_session_no_command_approval",
            }
        } else {
            AppliesDecision::Apply {
                reason: "non_channel_session",
            }
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_command_approval_section())
    }
}

// ---------------------------------------------------------------------
// 180. Function-result clearing — context management
// ---------------------------------------------------------------------

pub struct FunctionResultClearingSection;

impl PromptSection for FunctionResultClearingSection {
    fn id(&self) -> &'static str {
        "function_result_clearing"
    }
    fn order_hint(&self) -> i32 {
        order::FUNCTION_RESULT_CLEARING
    }
    fn applies(&self, _ctx: &PromptCtx) -> AppliesDecision {
        AppliesDecision::Apply { reason: "always" }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        Some(build_function_result_clearing_section())
    }
}

// ---------------------------------------------------------------------
// 190. IDE context — non-channel only
// ---------------------------------------------------------------------

pub struct IdeContextSection;

impl PromptSection for IdeContextSection {
    fn id(&self) -> &'static str {
        "ide_context"
    }
    fn order_hint(&self) -> i32 {
        order::IDE_CONTEXT
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            return AppliesDecision::Skip {
                reason: "channel_session_no_ide",
            };
        }
        if ctx.config.ide_context.is_none() {
            return AppliesDecision::Skip {
                reason: "no_ide_context",
            };
        }
        AppliesDecision::Apply {
            reason: "ide_context_present",
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "ide_context",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let ide_ctx = ctx.config.ide_context.as_ref()?;
        let body = super::ide_context::format_ide_context(ide_ctx);
        if body.is_empty() {
            None
        } else {
            Some(body)
        }
    }
}

// ---------------------------------------------------------------------
// 192. User profile — self-described background and technical familiarity
// ---------------------------------------------------------------------

pub struct UserProfileSection;

impl PromptSection for UserProfileSection {
    fn id(&self) -> &'static str {
        "user_profile"
    }
    fn order_hint(&self) -> i32 {
        order::USER_PROFILE
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        let Some(profile) = ctx.config.user_profile.as_ref() else {
            return AppliesDecision::Skip {
                reason: "no_user_profile",
            };
        };
        if user_profile_is_empty(profile) {
            return AppliesDecision::Skip {
                reason: "empty_user_profile",
            };
        }
        AppliesDecision::Apply {
            reason: "user_profile_present",
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "user_profile",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let profile = ctx.config.user_profile.as_ref()?;
        let body = format_user_profile(profile);
        if body.is_empty() {
            None
        } else {
            Some(body)
        }
    }
}

// ---------------------------------------------------------------------
// 195. User presence — QQ-style availability the user controls in the sidebar
// ---------------------------------------------------------------------

pub struct UserPresenceSection;

impl PromptSection for UserPresenceSection {
    fn id(&self) -> &'static str {
        "user_presence"
    }
    fn order_hint(&self) -> i32 {
        order::USER_PRESENCE
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.user_presence.is_none() {
            return AppliesDecision::Skip {
                reason: "no_user_presence",
            };
        }
        AppliesDecision::Apply {
            reason: "user_presence_present",
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "user_presence",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let presence = ctx.config.user_presence.as_ref()?;
        Some(format_user_presence(presence))
    }
}

// ---------------------------------------------------------------------
// 200. Agent mode suffix
// ---------------------------------------------------------------------

pub struct AgentModeSuffixSection;

impl PromptSection for AgentModeSuffixSection {
    fn id(&self) -> &'static str {
        "agent_mode_suffix"
    }
    fn order_hint(&self) -> i32 {
        order::AGENT_MODE_SUFFIX
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.config.agent_mode.is_some() {
            AppliesDecision::Apply {
                reason: "agent_mode_present",
            }
        } else {
            AppliesDecision::Skip {
                reason: "no_agent_mode",
            }
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "agent_mode.system_prompt_suffix",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let mode = ctx.config.agent_mode.as_ref()?;
        let suffix = mode.system_prompt_suffix();
        if suffix.is_empty() {
            return None;
        }
        let mut rendered = suffix.to_string();
        // Plan-mode re-entry note (CC `plan_mode_reentry` parity): when this
        // session already resolved a plan and no newer plan is pending
        // (`mark_ready` clears the marker), point the model at the prior
        // plan file so iterative planning reconciles with it instead of
        // producing a duplicate or contradictory plan.
        if matches!(mode, crate::session::AgentExecMode::Plan) {
            if let Some(prior) = crate::session::plan_mode::last_resolved_plan(ctx._session_id) {
                let outcome = if prior.approved {
                    "an approved"
                } else {
                    "a rejected"
                };
                rendered.push_str(&format!(
                    "\n### Prior plan on file\n\
                     This session already has {outcome} plan: \"{title}\" at `{path}`. \
                     Read it first and decide whether to write a fresh plan or extend/revise it — \
                     do not duplicate or contradict it unknowingly.\n",
                    title = prior.plan_title,
                    path = prior.plan_path,
                ));
            }
        }
        Some(rendered)
    }
}

// ---------------------------------------------------------------------
// 210. Flow awareness — environment-wide running flows
// ---------------------------------------------------------------------

pub struct FlowAwarenessSection;

impl PromptSection for FlowAwarenessSection {
    fn id(&self) -> &'static str {
        "flow_awareness"
    }
    fn order_hint(&self) -> i32 {
        order::FLOW_AWARENESS
    }
    fn applies(&self, _ctx: &PromptCtx) -> AppliesDecision {
        AppliesDecision::Apply {
            reason: "always_attempt",
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "flow_awareness",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }
    fn render(&self, _ctx: &PromptCtx) -> Option<String> {
        let flow_context = crate::flow_awareness::format_flow_context(None, 50);
        if flow_context.is_empty() {
            None
        } else {
            Some(flow_context)
        }
    }
}

// ---------------------------------------------------------------------
// 220. Runtime line — channel sessions only, separator-prefixed
// ---------------------------------------------------------------------
//
// The legacy builder emitted this with a `\n\n---\n\n` separator
// AFTER the main `join("\n\n")`. We preserve byte-for-byte output by
// inlining the separator into the rendered body. The default
// `join("\n\n")` inserts the section-separator newlines for us; the
// extra `---` block is part of the section's own rendering contract.
pub struct RuntimeLineSection;

impl PromptSection for RuntimeLineSection {
    fn id(&self) -> &'static str {
        "runtime_line"
    }
    fn order_hint(&self) -> i32 {
        order::RUNTIME_LINE
    }
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision {
        if ctx.is_channel_session {
            AppliesDecision::Apply {
                reason: "channel_session",
            }
        } else {
            AppliesDecision::Skip {
                reason: "non_channel_session",
            }
        }
    }
    fn source(&self) -> PromptSource {
        PromptSource::Computed {
            upstream: "runtime_line",
        }
    }
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::StableUntilClear
    }
    fn render(&self, ctx: &PromptCtx) -> Option<String> {
        let runtime = build_runtime_line(&ctx.config.model, ctx.config.channel.as_deref());
        // Preserve the legacy `---` separator that used to be inlined
        // by the builder after `join("\n\n")`.
        Some(format!("---\n\n{}", runtime))
    }
}
