//! Prompt section registry — the single declarative source of truth
//! for which sections appear in the unified system prompt, in what
//! order, under what conditions, and from what source.
//!
//! ## Why this exists
//!
//! The legacy [`builder::build_unified_system_prompt`] hardcoded an
//! ~18-step assembly pipeline as a flat sequence of `if`/`else if`
//! branches that pushed strings onto a `Vec<String>`. Every change —
//! adding a section, gating one on a different config flag, moving its
//! position, exposing it for override — required editing the same
//! ~270-line function and stitching new branches into existing ones.
//! Sovereign-prompt agents (`builtin:gateway`) had to be implemented as
//! a wholly separate fast-path function with its own copy of the
//! identity / system-meta / rules / learnings logic.
//!
//! The registry lifts the **policy** (which sections, in what order,
//! gated how) out of the **mechanism** (the actual rendering). Every
//! prompt section is a struct that implements [`PromptSection`].
//! [`build_unified_system_prompt`] iterates the registry, filters by
//! `applies(ctx)`, sorts by `order_hint()`, and joins the rendered
//! bodies. Sovereign sessions reuse the same registry — they just hand
//! it a stricter `applies` predicate via [`PromptCtx::sovereign`].
//!
//! ## Design notes
//!
//! - Sections are zero-sized marker structs so the registry vector is
//!   `Vec<&'static dyn PromptSection>` and dispatch is purely virtual
//!   (no allocations for the section objects themselves).
//! - Section `id`s are short snake_case strings. They double as
//!   stable identifiers for the dev-only `prompt_dump` RPC and the
//!   future `~/.orgii/personal/prompts/<id>.md` override hook.
//! - Order hints are i32s spaced ten apart so insertions can land
//!   between existing sections without renumbering. The ordering used
//!   by the original builder is preserved verbatim.
//! - `applies(ctx)` returns a structured [`AppliesDecision`] rather
//!   than a bare `bool` so `prompt_dump` can explain *why* a section
//!   was kept or skipped (essential for debugging "my custom rule
//!   isn't showing up" reports).
//! - `render(ctx)` returns `Option<String>`; `None` means the section
//!   produced no content (e.g. an empty rule list) and should be
//!   omitted from the assembled prompt.
//!
//! Markdown body externalization (moving the inline `format!("…")`
//! strings out to `src-tauri/prompts/*.md` and adding a
//! per-section `override_path()` hook reading
//! `~/.orgii/personal/prompts/*.md`) is intentionally deferred to a
//! follow-up PR. The trait surface already accommodates both: an
//! externalized section just becomes a `PromptSection` whose `render()`
//! reads the template, and `PromptSource` already carries the
//! `OverrideFile` variant.

use std::path::PathBuf;

use super::cache::{
    LearningsPromptCache, LearningsPromptCacheKey, PromptCachePolicy, SessionPromptCache,
};
use crate::session::types::{SystemPromptConfig, ToolSummary};

// ---------------------------------------------------------------------
// PromptCtx — the resolved context every section sees
// ---------------------------------------------------------------------

/// All inputs a [`PromptSection`] is allowed to read when deciding
/// whether to render and how. Built once per `build_unified_system_prompt`
/// call and threaded through the iteration loop.
///
/// `tool_names` is precomputed so each section's `applies()` doesn't
/// have to re-scan `ToolSummary`s; sections that need the full
/// `ToolSummary` array (e.g. `channel_environment`) get it from the
/// `tool_summaries` field directly.
pub struct PromptCtx<'a> {
    /// The originating session id.
    pub _session_id: &'a str,
    pub config: &'a SystemPromptConfig,
    pub tool_summaries: &'a [ToolSummary],
    pub tool_names: Vec<&'a str>,
    /// `true` for channel sessions (OS Agent on Telegram / Discord /
    /// CLI / Inbox). Equivalent to `config.channel.is_some()` but
    /// computed once.
    pub is_channel_session: bool,
    /// `true` for the SDE/coding path (workspace present, not channel).
    pub _is_workspace_session: bool,
    /// Mirrors `config.sovereign_prompt`. Sovereign sessions filter the
    /// registry to a small whitelist (see [`PromptSection::sovereign_safe`]).
    pub sovereign: bool,
}

impl<'a> PromptCtx<'a> {
    pub fn new(
        session_id: &'a str,
        config: &'a SystemPromptConfig,
        tool_summaries: &'a [ToolSummary],
    ) -> Self {
        let tool_names: Vec<&'a str> = tool_summaries.iter().map(|ts| ts.name.as_str()).collect();
        let is_channel_session = config.channel.is_some();
        let is_workspace_session = !is_channel_session && config.workspace.is_some();
        Self {
            _session_id: session_id,
            config,
            tool_summaries,
            tool_names,
            is_channel_session,
            _is_workspace_session: is_workspace_session,
            sovereign: config.sovereign_prompt,
        }
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tool_names.contains(&name)
    }
}

// ---------------------------------------------------------------------
// AppliesDecision — bool + reason, for prompt_dump
// ---------------------------------------------------------------------

/// Per-section decision about whether to render. Carries a short
/// reason string so the dev-only `prompt_dump` RPC can explain
/// "section X was skipped because no_workspace" without each section
/// having to invent its own log line.
#[derive(Debug, Clone)]
pub enum AppliesDecision {
    /// Render this section. The reason describes the matched
    /// condition (e.g. `"channel_session"`, `"sde_workspace"`) so the
    /// dump consumer can see *why* it was kept.
    Apply { reason: &'static str },
    /// Skip this section. The reason describes the failed condition
    /// (e.g. `"no_workspace"`, `"sovereign_filter"`).
    Skip { reason: &'static str },
}

impl AppliesDecision {
    pub fn is_apply(&self) -> bool {
        matches!(self, AppliesDecision::Apply { .. })
    }

    pub fn reason(&self) -> &'static str {
        match self {
            AppliesDecision::Apply { reason } | AppliesDecision::Skip { reason } => reason,
        }
    }
}

// ---------------------------------------------------------------------
// PromptSource — provenance, for prompt_dump
// ---------------------------------------------------------------------

/// Where a rendered section's content originated. Surfaced via
/// `prompt_dump` so debuggers can tell at a glance whether they're
/// looking at the bundled default, a user-authored override file, or
/// computed-at-runtime content (the common case today: every section
/// is `Builtin` until PR 2.5 lands the override hook).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptSource {
    /// Hardcoded markdown literal in `sections.rs` or its callees.
    Builtin,
    /// User-authored override file at the section's `override_path()`.
    /// Reserved for the PR 2.5 follow-up; no section returns this
    /// variant yet.
    OverrideFile { path: PathBuf },
    /// Content assembled at runtime from data sources outside the
    /// prompt module (e.g. enabled rule list, learnings injection,
    /// conventions file, IDE context). The string identifies the
    /// upstream subsystem so the dump consumer can chase the source.
    Computed { upstream: &'static str },
}

// ---------------------------------------------------------------------
// PromptSection trait
// ---------------------------------------------------------------------

/// One declarative entry in the system-prompt registry.
///
/// Implementations are expected to be ZSTs (zero-sized marker structs).
/// All per-call state lives on [`PromptCtx`]; the trait object itself
/// is `&'static dyn PromptSection` and the [`registry()`] vector is
/// constructed once per call.
pub trait PromptSection: Send + Sync {
    /// Stable identifier — short snake_case. Used for:
    /// - the dev-only `prompt_dump` RPC's `section_id` field
    /// - the future per-section override path
    ///   (`~/.orgii/personal/prompts/<id>.md`)
    /// - test assertions ("expect identity to come before system_meta")
    ///
    /// Must be unique across the registry; uniqueness is asserted in
    /// `registry::tests::ids_are_unique`.
    fn id(&self) -> &'static str;

    /// Stable ordering hint. The unified builder sorts the matched
    /// sections by this value before joining them. Values are spaced
    /// ten apart so a future section can land between two existing
    /// ones (e.g. `identity` (10) → `system_meta` (20) leaves room
    /// for an 11–19 insertion) without renumbering downstream.
    fn order_hint(&self) -> i32;

    /// Predicate: should this section appear in the final prompt?
    /// Returning [`AppliesDecision::Skip`] is the canonical way to
    /// gate sections (do NOT return `Some("")` from `render()`).
    ///
    /// Sovereign filtering is a separate concern: sections that should
    /// survive a sovereign session override this AND set
    /// `sovereign_safe()` to `true`.
    fn applies(&self, ctx: &PromptCtx) -> AppliesDecision;

    /// Whether this section is allowed to render in a sovereign
    /// session. Sovereign agents (e.g. `builtin:gateway`) declare
    /// their `soul_content` as a complete role definition and want a
    /// minimal frame around it. Default: `false` — most sections are
    /// SDE/coding-flavored and would conflict with a router persona.
    ///
    /// Sections that ARE sovereign-safe (identity, system_meta,
    /// available_tools, rules, learnings) override this and return
    /// `true`. The unified builder applies this filter BEFORE
    /// `applies()`, so a sovereign-unsafe section never even runs its
    /// gate predicate in a sovereign session.
    fn sovereign_safe(&self) -> bool {
        false
    }

    /// Provenance label. Defaults to `Builtin`; sections whose
    /// content comes from a runtime subsystem (rules loader,
    /// learnings, conventions, IDE context) override this to return
    /// the canonical upstream name so `prompt_dump` is honest about
    /// where the bytes came from.
    fn source(&self) -> PromptSource {
        PromptSource::Builtin
    }

    /// Cache behavior for this section. Defaults to volatile so new sections
    /// cannot accidentally freeze live runtime state. Sections must opt in to
    /// session caching once their inputs are known to be session-stable.
    fn cache_policy(&self) -> PromptCachePolicy {
        PromptCachePolicy::Volatile
    }

    /// Render the section's body. `None` means "this section had
    /// nothing meaningful to say in this context" (e.g. an empty rule
    /// list, a conventions file that didn't exist) and the assembler
    /// will drop it from the prompt with no separator. `Some("")`
    /// also drops the section but is treated as a bug — every
    /// concrete section should return either `None` or a non-empty
    /// string.
    fn render(&self, ctx: &PromptCtx) -> Option<String>;
}

// ---------------------------------------------------------------------
// SectionTrace — what `prompt_dump` returns per section
// ---------------------------------------------------------------------

/// Per-section trace returned by `prompt_dump`. Captures the section
/// id, why it was kept or skipped, where its content came from, and
/// the rendered body (only when applies). Surfaced as a Tauri command
/// in `prompt_dump`; never serialized into the live system prompt.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SectionTrace {
    pub section_id: &'static str,
    pub order_hint: i32,
    pub applies: bool,
    pub reason: &'static str,
    pub source: PromptSource,
    pub sovereign_safe: bool,
    pub cache_policy: &'static str,
    /// Rendered body, or `None` when the section was skipped. Empty
    /// string means the section opted out of rendering at runtime
    /// (e.g. empty additional-dirs block); we still include the trace
    /// row so the dump shows a complete picture of the registry.
    pub content: Option<String>,
}

// ---------------------------------------------------------------------
// Assembly entry point
// ---------------------------------------------------------------------

/// Assemble the full system prompt + trace by walking the registry
/// once. The trace is always built (it's cheap — just metadata) so
/// `prompt_dump` and the live builder can share a single code path.
///
/// Returns `(prompt, traces)`:
/// - `prompt` is what you'd pass to the LLM
/// - `traces` is the full per-section breakdown for `prompt_dump`
pub fn assemble(ctx: &PromptCtx) -> (String, Vec<SectionTrace>) {
    assemble_with_cache(ctx, None, None)
}

/// Assemble the full system prompt using a session cache for sections that
/// explicitly opt in via [`PromptSection::cache_policy`]. Passing `None`
/// preserves the uncached behavior used by prompt dumps and unit tests.
fn render_revision_keyed_section(
    section: &'static dyn PromptSection,
    ctx: &PromptCtx,
    learnings_cache: Option<&mut LearningsPromptCache>,
) -> Option<String> {
    if section.id() != "learnings" {
        return section.render(ctx).filter(|body| !body.is_empty());
    }

    let def_id = ctx.config.agent_definition_id.as_ref()?;
    let scope = format!("agent:{}", def_id);
    let Some((row_count, revision)) = crate::memory::learnings::learning_prompt_revision(&scope)
    else {
        return section.render(ctx).filter(|body| !body.is_empty());
    };
    let key = LearningsPromptCacheKey::new(scope, row_count, revision);
    let Some(cache) = learnings_cache else {
        return section.render(ctx).filter(|body| !body.is_empty());
    };

    match cache.get(&key) {
        Some(cached) => cached,
        None => {
            let rendered = section.render(ctx).filter(|body| !body.is_empty());
            cache.insert(key, rendered.clone());
            rendered
        }
    }
}

pub fn assemble_with_cache(
    ctx: &PromptCtx,
    mut cache: Option<&mut SessionPromptCache>,
    mut learnings_cache: Option<&mut LearningsPromptCache>,
) -> (String, Vec<SectionTrace>) {
    let registry = registry();
    let mut traces: Vec<SectionTrace> = Vec::with_capacity(registry.len());
    let mut bodies: Vec<(i32, String)> = Vec::with_capacity(registry.len());

    for section in registry.iter() {
        let sovereign_safe = section.sovereign_safe();
        let cache_policy = section.cache_policy();

        // Sovereign filter wins over per-section applies(): a
        // sovereign session never even asks an unsafe section whether
        // it would have applied. The trace explains the skip so dumps
        // stay honest.
        let decision = if ctx.sovereign && !sovereign_safe {
            AppliesDecision::Skip {
                reason: "sovereign_filter",
            }
        } else {
            section.applies(ctx)
        };

        let mut content: Option<String> = None;
        if decision.is_apply() {
            let section_id = section.id();
            content = if cache_policy.is_cacheable() {
                if let Some(cache_ref) = cache.as_deref_mut() {
                    match cache_ref.get(section_id) {
                        Some(cached) => cached,
                        None => {
                            let rendered = section.render(ctx).filter(|body| !body.is_empty());
                            cache_ref.insert(section_id, rendered.clone());
                            rendered
                        }
                    }
                } else {
                    section.render(ctx).filter(|body| !body.is_empty())
                }
            } else if matches!(cache_policy, PromptCachePolicy::RevisionKeyed) {
                render_revision_keyed_section(*section, ctx, learnings_cache.as_deref_mut())
            } else {
                section.render(ctx).filter(|body| !body.is_empty())
            };
            if let Some(ref body) = content {
                bodies.push((section.order_hint(), body.clone()));
            }
        }

        traces.push(SectionTrace {
            section_id: section.id(),
            order_hint: section.order_hint(),
            applies: decision.is_apply(),
            reason: decision.reason(),
            source: section.source(),
            sovereign_safe,
            cache_policy: cache_policy.as_str(),
            content,
        });
    }

    bodies.sort_by_key(|(order, _)| *order);

    let prompt_body = bodies
        .into_iter()
        .map(|(_, body)| body)
        .collect::<Vec<_>>()
        .join("\n\n");

    (prompt_body, traces)
}

/// Assemble the system prompt split into a **stable** body (sections whose
/// bytes are session-stable — cacheable as a provider prompt-cache prefix)
/// and a **volatile** body (sections whose bytes can change between turns:
/// environment date/branch, IDE context, user presence/profile, mode
/// suffix, flow awareness, agent-org task board). Keeping the volatile
/// body OUT of the cached prefix is what lets the provider prompt cache
/// survive across turns and days.
pub fn assemble_split_with_cache(
    ctx: &PromptCtx,
    mut cache: Option<&mut SessionPromptCache>,
    mut learnings_cache: Option<&mut LearningsPromptCache>,
) -> (String, String, Vec<SectionTrace>) {
    let registry = registry();
    let mut traces: Vec<SectionTrace> = Vec::with_capacity(registry.len());
    let mut stable_bodies: Vec<(i32, String)> = Vec::with_capacity(registry.len());
    let mut volatile_bodies: Vec<(i32, String)> = Vec::new();

    for section in registry.iter() {
        let sovereign_safe = section.sovereign_safe();
        let cache_policy = section.cache_policy();

        let decision = if ctx.sovereign && !sovereign_safe {
            AppliesDecision::Skip {
                reason: "sovereign_filter",
            }
        } else {
            section.applies(ctx)
        };

        let mut content: Option<String> = None;
        if decision.is_apply() {
            let section_id = section.id();
            content = if cache_policy.is_cacheable() {
                if let Some(cache_ref) = cache.as_deref_mut() {
                    match cache_ref.get(section_id) {
                        Some(cached) => cached,
                        None => {
                            let rendered = section.render(ctx).filter(|body| !body.is_empty());
                            cache_ref.insert(section_id, rendered.clone());
                            rendered
                        }
                    }
                } else {
                    section.render(ctx).filter(|body| !body.is_empty())
                }
            } else if matches!(cache_policy, PromptCachePolicy::RevisionKeyed) {
                render_revision_keyed_section(*section, ctx, learnings_cache.as_deref_mut())
            } else {
                section.render(ctx).filter(|body| !body.is_empty())
            };
            if let Some(ref body) = content {
                if matches!(cache_policy, PromptCachePolicy::Volatile) {
                    volatile_bodies.push((section.order_hint(), body.clone()));
                } else {
                    stable_bodies.push((section.order_hint(), body.clone()));
                }
            }
        }

        traces.push(SectionTrace {
            section_id: section.id(),
            order_hint: section.order_hint(),
            applies: decision.is_apply(),
            reason: decision.reason(),
            source: section.source(),
            sovereign_safe,
            cache_policy: cache_policy.as_str(),
            content,
        });
    }

    stable_bodies.sort_by_key(|(order, _)| *order);
    volatile_bodies.sort_by_key(|(order, _)| *order);

    let join = |bodies: Vec<(i32, String)>| {
        bodies
            .into_iter()
            .map(|(_, body)| body)
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    (join(stable_bodies), join(volatile_bodies), traces)
}

// ---------------------------------------------------------------------
// Section ordering — single declarative source of truth
// ---------------------------------------------------------------------
//
// Centralized so a reader can see the whole prompt skeleton at a
// glance, instead of chasing every `order_hint()` impl. Spacing of
// 10 leaves room for a future section to land between two existing
// ones (e.g. between `IDENTITY` (10) and `SYSTEM_META` (20)) without
// renumbering downstream.

pub mod order {
    pub const IDENTITY: i32 = 10;
    pub const SYSTEM_META: i32 = 20;
    pub const ENVIRONMENT: i32 = 30;
    pub const MODEL_IDENTITY: i32 = 40;
    pub const AVAILABLE_TOOLS: i32 = 50;
    pub const MCP_INSTRUCTIONS: i32 = 55;
    pub const BEHAVIORAL_RULES: i32 = 60;
    pub const PROJECT_CONVENTIONS: i32 = 70;
    pub const RULES: i32 = 80;
    pub const ALWAYS_SKILLS: i32 = 90;
    pub const LEARNINGS: i32 = 100;
    pub const SCOPE_PRESETS: i32 = 102;
    pub const MEMORY_PROTOCOL: i32 = 105;
    pub const MESSAGING: i32 = 110;
    pub const SILENT_REPLIES: i32 = 120;
    pub const ATC: i32 = 130;
    pub const AGENT_ORG_CONTEXT: i32 = 140;
    pub const TASK_ROUTING: i32 = 150;
    pub const SUB_AGENT_DELEGATION: i32 = 160;
    pub const COMMAND_APPROVAL: i32 = 170;
    pub const FUNCTION_RESULT_CLEARING: i32 = 180;
    pub const IDE_CONTEXT: i32 = 190;
    pub const USER_PROFILE: i32 = 192;
    pub const USER_PRESENCE: i32 = 195;
    pub const AGENT_MODE_SUFFIX: i32 = 200;
    pub const FLOW_AWARENESS: i32 = 210;
    pub const RUNTIME_LINE: i32 = 220;
}

// ---------------------------------------------------------------------
// Registry — the static section list
// ---------------------------------------------------------------------

/// Fresh registry vector. Each call returns a new `Vec` of trait
/// references (cheap — the underlying section objects are zero-sized
/// statics). Kept as a function rather than a `Lazy<Vec<…>>` so a
/// future section can be appended without touching any global state.
pub fn registry() -> Vec<&'static dyn PromptSection> {
    use super::sections::*;

    vec![
        &IdentitySection,
        &SystemMetaSection,
        &EnvironmentSection,
        &ModelIdentitySection,
        &AvailableToolsSection,
        &McpInstructionsSection,
        &BehavioralRulesSection,
        &ProjectConventionsSection,
        &RulesSection,
        &AlwaysSkillsSection,
        &LearningsSection,
        &ScopedPromptPresetsSection,
        &WorkspaceMemoryProtocolSection,
        &MessagingSection,
        &SilentRepliesSection,
        &AtcSection,
        &AgentOrgContextSection,
        &TaskRoutingSection,
        &SubAgentDelegationSection,
        &CommandApprovalSection,
        &FunctionResultClearingSection,
        &IdeContextSection,
        &UserProfileSection,
        &UserPresenceSection,
        &AgentModeSuffixSection,
        &FlowAwarenessSection,
        &RuntimeLineSection,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique() {
        let mut seen: HashSet<&'static str> = HashSet::new();
        for section in registry() {
            assert!(
                seen.insert(section.id()),
                "duplicate section id: {}",
                section.id()
            );
        }
    }

    #[test]
    fn cache_policy_matrix_matches_conversation_snapshot_audit() {
        for section in registry() {
            let expected = match section.id() {
                "environment"
                | "agent_org_context"
                | "ide_context"
                | "user_profile"
                | "user_presence"
                | "agent_mode_suffix"
                | "flow_awareness"
                | "project_conventions"
                | "mcp_instructions"
                | "scoped_prompt_presets" => PromptCachePolicy::Volatile,
                "learnings" => PromptCachePolicy::RevisionKeyed,
                "identity"
                | "memory_protocol"
                | "system_meta"
                | "model_identity"
                | "available_tools"
                | "behavioral_rules"
                | "rules"
                | "always_skills"
                | "messaging"
                | "silent_replies"
                | "atc"
                | "task_routing"
                | "sub_agent_delegation"
                | "command_approval"
                | "function_result_clearing"
                | "runtime_line" => PromptCachePolicy::StableUntilClear,
                other => panic!(
                    "section `{}` is missing from the prompt cache policy audit matrix",
                    other
                ),
            };
            assert_eq!(
                section.cache_policy(),
                expected,
                "section `{}` has a cache policy that no longer matches the audited matrix",
                section.id()
            );
        }
    }

    #[test]
    fn registry_is_declared_in_prompt_order() {
        let sections = registry();
        let ids: Vec<&'static str> = sections.iter().map(|section| section.id()).collect();
        assert_eq!(
            ids,
            vec![
                "identity",
                "system_meta",
                "environment",
                "model_identity",
                "available_tools",
                "mcp_instructions",
                "behavioral_rules",
                "project_conventions",
                "rules",
                "always_skills",
                "learnings",
                "scoped_prompt_presets",
                "memory_protocol",
                "messaging",
                "silent_replies",
                "atc",
                "agent_org_context",
                "task_routing",
                "sub_agent_delegation",
                "command_approval",
                "function_result_clearing",
                "ide_context",
                "user_profile",
                "user_presence",
                "agent_mode_suffix",
                "flow_awareness",
                "runtime_line"
            ]
        );

        for pair in sections.windows(2) {
            let current = pair[0];
            let next = pair[1];
            assert!(
                current.order_hint() < next.order_hint(),
                "registry order drift: `{}` ({}) must be before `{}` ({})",
                current.id(),
                current.order_hint(),
                next.id(),
                next.order_hint()
            );
        }
    }

    #[test]
    fn order_constants_match_registered_sections() {
        let actual: Vec<(&'static str, i32)> = registry()
            .iter()
            .map(|section| (section.id(), section.order_hint()))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("identity", order::IDENTITY),
                ("system_meta", order::SYSTEM_META),
                ("environment", order::ENVIRONMENT),
                ("model_identity", order::MODEL_IDENTITY),
                ("available_tools", order::AVAILABLE_TOOLS),
                ("mcp_instructions", order::MCP_INSTRUCTIONS),
                ("behavioral_rules", order::BEHAVIORAL_RULES),
                ("project_conventions", order::PROJECT_CONVENTIONS),
                ("rules", order::RULES),
                ("always_skills", order::ALWAYS_SKILLS),
                ("learnings", order::LEARNINGS),
                ("scoped_prompt_presets", order::SCOPE_PRESETS),
                ("memory_protocol", order::MEMORY_PROTOCOL),
                ("messaging", order::MESSAGING),
                ("silent_replies", order::SILENT_REPLIES),
                ("atc", order::ATC),
                ("agent_org_context", order::AGENT_ORG_CONTEXT),
                ("task_routing", order::TASK_ROUTING),
                ("sub_agent_delegation", order::SUB_AGENT_DELEGATION),
                ("command_approval", order::COMMAND_APPROVAL),
                ("function_result_clearing", order::FUNCTION_RESULT_CLEARING),
                ("ide_context", order::IDE_CONTEXT),
                ("user_profile", order::USER_PROFILE),
                ("user_presence", order::USER_PRESENCE),
                ("agent_mode_suffix", order::AGENT_MODE_SUFFIX),
                ("flow_awareness", order::FLOW_AWARENESS),
                ("runtime_line", order::RUNTIME_LINE),
            ]
        );
    }

    #[test]
    fn order_hints_are_unique() {
        // Distinct order hints make the assembled prompt deterministic
        // even if `sort_by_key` is not stable. (`Vec::sort_by_key` IS
        // stable today, so this is a defense-in-depth invariant.)
        let mut seen: HashSet<i32> = HashSet::new();
        for section in registry() {
            assert!(
                seen.insert(section.order_hint()),
                "duplicate order_hint {} on section {}",
                section.order_hint(),
                section.id()
            );
        }
    }

    #[test]
    fn ids_are_snake_case() {
        for section in registry() {
            let id = section.id();
            assert!(!id.is_empty(), "section id is empty");
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "section id `{}` is not snake_case",
                id
            );
            assert!(
                !id.starts_with('_') && !id.ends_with('_'),
                "section id `{}` has leading/trailing underscore",
                id
            );
        }
    }

    // ------------------------------------------------------------------
    // Registry-level integration tests — exercise `assemble()` end to end.
    //
    // These run with the real registry (not a mock) so a regression in
    // the policy of any individual section will trip them. The fixtures
    // below are deliberately minimal; they prove the *filter / order /
    // sovereign* contract, not section content (section content is
    // tested in `prompt::sections::tests` and the integration specs).
    // ------------------------------------------------------------------

    use crate::session::types::SystemPromptConfig;

    /// SDE / coding-flow fixture. Builds a `SystemPromptConfig` with
    /// `workspace = Some(...)` so workspace-gated sections apply, and
    /// no channel set so channel-gated sections skip.
    fn sde_config() -> SystemPromptConfig {
        SystemPromptConfig {
            model: "test-model".to_string(),
            agent_id: "test-agent".to_string(),
            agent_definition_id: Some("test-agent-def".to_string()),
            agent_soul: Some("You are test agent.".to_string()),
            load_workspace_resources: true,
            load_workspace_rules: true,
            // Empty workspace path means the conventions / rules
            // loaders gracefully return empty content; we just need
            // `workspace.is_some()` to flip the workspace branch on.
            workspace: Some(crate::session::SessionWorkspace::new(
                std::path::PathBuf::from("/tmp/registry_test_workspace"),
            )),
            ..Default::default()
        }
    }

    /// Channel / OS-Agent fixture. Sets `channel = Some(...)` so
    /// `is_channel_session = true`; no workspace.
    fn channel_config() -> SystemPromptConfig {
        SystemPromptConfig {
            model: "test-model".to_string(),
            agent_id: "test-agent".to_string(),
            agent_definition_id: Some("test-agent-def".to_string()),
            agent_soul: Some("You are channel agent.".to_string()),
            channel: Some("telegram".to_string()),
            ..Default::default()
        }
    }

    /// Sovereign fixture. Same as channel but flips
    /// `sovereign_prompt = true` so the registry strips every
    /// non-sovereign-safe section.
    fn sovereign_config() -> SystemPromptConfig {
        SystemPromptConfig {
            sovereign_prompt: true,
            ..channel_config()
        }
    }

    /// Collect the section IDs that ended up in the rendered prompt
    /// (i.e. `applies && content.is_some()`), in the order they
    /// appear. Used to assert ordering and inclusion in one shot.
    fn rendered_ids(traces: &[SectionTrace]) -> Vec<&'static str> {
        let mut ids: Vec<(&i32, &'static str)> = traces
            .iter()
            .filter(|t| t.applies && t.content.is_some())
            .map(|t| (&t.order_hint, t.section_id))
            .collect();
        ids.sort_by_key(|(o, _)| *o);
        ids.into_iter().map(|(_, id)| id).collect()
    }

    #[test]
    fn assemble_sde_includes_identity_and_command_approval_excludes_runtime_line() {
        let cfg = sde_config();
        let ctx = PromptCtx::new("sess-sde", &cfg, &[]);
        let (_prompt, traces) = assemble(&ctx);

        let ids = rendered_ids(&traces);
        assert!(ids.contains(&"identity"), "identity should render in SDE");
        assert!(
            ids.contains(&"command_approval"),
            "command_approval should render in SDE (non-channel)"
        );
        // No tools wired ⇒ no `available_tools` row.
        assert!(
            !ids.contains(&"available_tools"),
            "available_tools should skip when no tools are present (got: {:?})",
            ids
        );
        // SDE is not a channel session ⇒ runtime_line skips.
        assert!(
            !ids.contains(&"runtime_line"),
            "runtime_line must skip in SDE (non-channel)"
        );
    }

    #[test]
    fn assemble_channel_includes_runtime_line_excludes_command_approval() {
        let cfg = channel_config();
        let ctx = PromptCtx::new("sess-channel", &cfg, &[]);
        let (_prompt, traces) = assemble(&ctx);

        let ids = rendered_ids(&traces);
        assert!(
            ids.contains(&"runtime_line"),
            "runtime_line should render in channel sessions"
        );
        assert!(
            !ids.contains(&"command_approval"),
            "command_approval must skip in channel sessions"
        );
        // Last rendered section must be runtime_line so the legacy
        // `\n\n---\n\n` separator lands at the very end of the prompt.
        assert_eq!(
            ids.last(),
            Some(&"runtime_line"),
            "runtime_line must be the trailing section in channel sessions (got: {:?})",
            ids
        );
    }

    #[test]
    fn sovereign_filter_strips_non_sovereign_safe_sections() {
        let cfg = sovereign_config();
        let ctx = PromptCtx::new("sess-sovereign", &cfg, &[]);
        let (_prompt, traces) = assemble(&ctx);

        // Every trace must either be sovereign-safe (kept) or carry
        // the canonical `sovereign_filter` skip reason.
        for t in &traces {
            if !t.sovereign_safe {
                assert!(
                    !t.applies,
                    "non-sovereign-safe section `{}` leaked into a sovereign session",
                    t.section_id
                );
                assert_eq!(
                    t.reason, "sovereign_filter",
                    "non-sovereign-safe section `{}` skipped for the wrong reason: `{}`",
                    t.section_id, t.reason
                );
            }
        }

        // Identity, system_meta, rules, learnings and available_tools
        // are the canonical sovereign-safe section set; identity is
        // always-on, the others are conditional but at minimum
        // identity + system_meta must render so the soul is wrapped
        // in the prompt-injection-defense frame.
        let ids = rendered_ids(&traces);
        assert!(
            ids.contains(&"identity"),
            "sovereign session must still render identity"
        );
        assert!(
            ids.contains(&"system_meta"),
            "sovereign session must still render system_meta"
        );
        assert!(
            !ids.contains(&"command_approval"),
            "command_approval must NOT render in a sovereign session"
        );
        assert!(
            !ids.contains(&"runtime_line"),
            "runtime_line must NOT render in a sovereign session"
        );
    }

    #[test]
    fn assemble_with_cache_reuses_stable_section_content() {
        let mut cfg = sde_config();
        cfg.agent_soul = Some("first soul".to_string());
        let mut cache = SessionPromptCache::default();
        {
            let ctx = PromptCtx::new("sess-cache", &cfg, &[]);
            let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
            assert!(prompt.contains("first soul"));
        }

        cfg.agent_soul = Some("second soul".to_string());
        let ctx = PromptCtx::new("sess-cache", &cfg, &[]);
        let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        assert!(prompt.contains("first soul"));
        assert!(!prompt.contains("second soul"));
        assert!(cache.len() > 0);
    }

    #[test]
    fn assemble_with_cache_recomputes_volatile_sections() {
        let mut cfg = sde_config();
        cfg.agent_mode = Some(crate::session::AgentExecMode::Plan);
        let mut cache = SessionPromptCache::default();
        let plan_suffix = {
            let ctx = PromptCtx::new("sess-volatile", &cfg, &[]);
            let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
            assert!(prompt.contains("Mode: Plan"));
            prompt
        };

        cfg.agent_mode = Some(crate::session::AgentExecMode::Build);
        let ctx = PromptCtx::new("sess-volatile", &cfg, &[]);
        let (build_suffix, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        assert_ne!(plan_suffix, build_suffix);
        assert!(build_suffix.contains("Build Mode"));
    }

    #[test]
    fn project_conventions_reloads_changed_files_between_turns() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let orgii = workspace.path().join(".orgii");
        std::fs::create_dir_all(&orgii).expect("create .orgii");
        let rules = orgii.join("agent-rules.md");
        std::fs::write(&rules, "first marker").expect("write first rules");

        let mut cfg = sde_config();
        cfg.workspace = Some(crate::session::SessionWorkspace::new(
            workspace.path().to_path_buf(),
        ));
        let mut cache = SessionPromptCache::default();

        let first = {
            let ctx = PromptCtx::new("sess-conventions", &cfg, &[]);
            let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
            prompt
        };
        assert!(first.contains("first marker"));

        std::fs::write(&rules, "second marker").expect("write second rules");
        let ctx = PromptCtx::new("sess-conventions", &cfg, &[]);
        let (second, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        assert!(second.contains("second marker"));
        assert!(!second.contains("first marker"));
    }

    #[test]
    fn assemble_orders_sections_by_order_hint() {
        let cfg = sde_config();
        let ctx = PromptCtx::new("sess-order", &cfg, &[]);
        let (_prompt, traces) = assemble(&ctx);

        let mut prev: Option<i32> = None;
        for t in traces.iter().filter(|t| t.applies && t.content.is_some()) {
            if let Some(p) = prev {
                assert!(
                    t.order_hint > p,
                    "section `{}` (order {}) appears after order {}, breaking ordering",
                    t.section_id,
                    t.order_hint,
                    p
                );
            }
            prev = Some(t.order_hint);
        }
    }

    #[test]
    fn assembled_prompt_starts_with_identity_section_body() {
        // Byte-level sanity check: identity has the lowest order
        // hint, so its body must lead the assembled prompt. This
        // catches a class of bug where a future contributor adds a
        // new section with `order_hint = 0` and accidentally
        // displaces identity.
        let cfg = sde_config();
        let ctx = PromptCtx::new("sess-prefix", &cfg, &[]);
        let (prompt, _traces) = assemble(&ctx);

        assert!(
            prompt.starts_with("You are test agent."),
            "assembled prompt must lead with the identity body; got prefix: {:?}",
            &prompt[..prompt.len().min(80)]
        );
    }
}
