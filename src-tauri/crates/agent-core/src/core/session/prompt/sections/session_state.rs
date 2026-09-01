//! Sections projecting live session state into the prompt: IDE context, user
//! profile and presence, the agent mode suffix, flow awareness, and the
//! channel runtime line.

use crate::core::session::prompt::cache::PromptCachePolicy;
use crate::core::session::prompt::registry::{
    order, AppliesDecision, PromptCtx, PromptSection, PromptSource,
};
use crate::core::session::prompt::section_builders::*;

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
        let body = crate::core::session::prompt::ide_context::format_ide_context(ide_ctx);
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
