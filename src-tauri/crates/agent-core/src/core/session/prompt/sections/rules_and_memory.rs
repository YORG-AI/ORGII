//! Sections carrying instruction and knowledge payloads: behavioral rules,
//! project conventions, policy rules, the always-on skills manifest,
//! cross-session learnings, and the workspace memory protocol.

use std::path::Path;

use crate::core::session::prompt::cache::PromptCachePolicy;
use crate::core::session::prompt::helpers::load_conventions;
use crate::core::session::prompt::registry::{
    order, AppliesDecision, PromptCtx, PromptSection, PromptSource,
};
use crate::core::session::prompt::section_builders::*;

use crate::skills::loader::SkillsLoader;

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
