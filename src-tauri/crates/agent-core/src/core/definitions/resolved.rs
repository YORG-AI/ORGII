//! `ResolvedAgent` — the runtime-only, immutable snapshot of an agent.
//!
//! # Role
//!
//! Every session pipeline (processor, turn executor, memory consolidation,
//! active learning, tools) consumes `ResolvedAgent`, **never** `AgentDefinition`
//! directly. `ResolvedAgent` is produced exactly once per session, at session
//! launch, by walking the definition's `inherits_from` chain and then filling
//! in every default so the resulting struct contains **no `Option<T>` fields
//! for config-derived values** (§3 invariants I-RESOLVED-ONCE and
//! I-NO-OPTION-AT-RUNTIME).
//!
//! The two legitimate `Option<T>` fields are called out explicitly:
//!
//! - `selected_account_id` — "no account chosen yet" is a real state.
//! - `delegation_config` — feature gate; absent ≠ default-and-disabled.
//!
//! # Where it lives
//!
//! Owned by `AgentSession` as a cloned snapshot. It is `pub(crate)`-readable
//! but intentionally not mutable — mutating an agent's definition at runtime
//! does **not** affect an already-running session (that is what
//! `SessionOverrides` is for).

use super::capabilities::CapabilitySet;
use super::schema::{
    default_max_tool_use_concurrency, AgentDefinition, AgentLearningsConfig, AgentPolicy,
    AgentSkillsConfig, AgentToolSelection, CompactionConfig, DelegationConfig, SessionModel,
    SubAgentRef,
};
use super::store::AgentDefinitionsStore;
use crate::core::config::ReliabilityConfig;
use crate::core::session::overrides::SessionOverrides;
use crate::integrations::config::ExecutionMode;
use crate::tools::names as tool_names;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;

/// Skills subsystem parameters. Previously `AgentSkillsConfig` with mixed
/// `Option<bool>` / lists — resolved to concrete defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsParams {
    pub enabled: bool,
    /// Whitelist: when non-empty, ONLY these skills are listed/loaded.
    /// Carried through the resolver so `resolved.skills` is the single
    /// runtime source of truth (previously `include` survived only on a
    /// parallel `SessionRuntime.skills_config` cache).
    #[serde(default)]
    pub include: Vec<String>,
    pub disabled: Vec<String>,
    pub source_dirs: Vec<String>,
}

impl Default for SkillsParams {
    fn default() -> Self {
        Self {
            enabled: true,
            include: Vec::new(),
            disabled: Vec::new(),
            source_dirs: Vec::new(),
        }
    }
}

/// Resolved tool selection — merges template chain restrict/exclude lists
/// and deduplicates, so callers do not re-run merging logic at read time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedToolSelection {
    /// Strict tool subset. Empty vec = "use capability-derived defaults".
    pub restrict_to: Vec<String>,
    /// Tools excluded (user UI toggle-offs + definition overrides).
    pub excluded: Vec<String>,
    /// MCP servers explicitly blocked.
    pub disabled_mcp_servers: Vec<String>,
    /// Individual MCP tool-paths explicitly blocked.
    pub disabled_mcp_tools: Vec<String>,
}

const GLOBAL_BASELINE_TOOLS: &[&str] = &[tool_names::INSPECT_TERMINALS];

impl ResolvedToolSelection {
    /// Merge the three tool-selection axes
    /// (`system_restrict_to_tools` + `user_allowed_tools` + `excluded_tools`)
    /// plus the capability-derived default-OFF set into the single
    /// `restrict_to` / `excluded` shape consumed by `derive_disabled_tools`.
    ///
    /// Rules:
    /// - When `system_restrict_to_tools` is `None`, the agent has no
    ///   role-pinned allow-list; `restrict_to` stays empty (= unrestricted).
    ///   `user_allowed_tools` does not widen the set, but still wins over
    ///   accidental duplicate entries in `excluded_tools` when the capability
    ///   boundary allows that tool.
    /// - When `system_restrict_to_tools` is `Some(sys)`, the resolved
    ///   `restrict_to` is the union of `sys`, global baseline tools, and
    ///   capability-allowed `user_allowed_tools`.
    /// - `excluded` is the union of the stored `excluded_tools` and the
    ///   capability-derived default-OFF set
    ///   (`default_excluded_tools_for_capabilities`). User additions may
    ///   restore tools hidden by `system_restrict_to_tools`, but they do
    ///   not override capability boundaries; stale on-disk overlays cannot
    ///   re-enable tools the agent's capabilities do not satisfy.
    pub(crate) fn from_schema(sel: &AgentToolSelection, capabilities: &CapabilitySet) -> Self {
        let capability_blocked: HashSet<String> =
            crate::tools::defaults::default_excluded_tools_for_capabilities(capabilities)
                .into_iter()
                .collect();
        let user_allowed: HashSet<&str> = sel
            .user_allowed_tools
            .iter()
            .map(String::as_str)
            .filter(|tool_name| !capability_blocked.contains(*tool_name))
            .collect();

        let restrict_to = match &sel.system_restrict_to_tools {
            None => Vec::new(),
            Some(sys) => {
                let mut merged: Vec<String> = sys
                    .iter()
                    .map(String::as_str)
                    .chain(GLOBAL_BASELINE_TOOLS.iter().copied())
                    .chain(user_allowed.iter().copied())
                    .map(str::to_string)
                    .collect();
                merged.sort();
                merged.dedup();
                merged
            }
        };

        let mut excluded: Vec<String> = sel
            .excluded_tools
            .iter()
            .chain(capability_blocked.iter())
            .filter(|tool| !user_allowed.contains(tool.as_str()))
            .cloned()
            .collect();
        excluded.sort();
        excluded.dedup();

        let mut disabled_mcp_servers = sel.disabled_mcp_servers.clone();
        disabled_mcp_servers.sort();
        disabled_mcp_servers.dedup();

        let mut disabled_mcp_tools = sel.disabled_mcp_tools.clone();
        disabled_mcp_tools.sort();
        disabled_mcp_tools.dedup();

        Self {
            restrict_to,
            excluded,
            disabled_mcp_servers,
            disabled_mcp_tools,
        }
    }
}

/// Errors that can occur during resolution.
#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("template inheritance failed: {0}")]
    Inheritance(String),
    #[error("agent '{0}' has no selected_model_id after resolve; builtins must set one")]
    MissingModel(String),
}

/// Runtime snapshot of an agent. I-RESOLVED-ONCE and I-NO-OPTION-AT-RUNTIME
/// hold: every field below is a concrete value (defaults applied at resolve
/// time), except the two legitimate `Option`s at the bottom.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgent {
    pub agent_id: String,
    pub name: String,
    pub capabilities: CapabilitySet,
    pub session_model: SessionModel,
    pub policy: AgentPolicy,
    pub animate: bool,
    /// Workspace directory. Resolved at session launch from
    /// `SessionOverrides.workspace > personal_workspace()`.
    /// `PathBuf` (not `Option<PathBuf>`) per I-NO-OPTION-AT-RUNTIME — there
    /// is always a workspace, even if it is just `cwd`.
    pub workspace: PathBuf,
    pub execution_mode: ExecutionMode,
    /// Per-agent shell/subprocess timeout (seconds). Resolved from
    /// `AgentDefinition.exec_timeout`; defaults to 60s when unset.
    pub exec_timeout: u64,
    /// Per-turn concurrent read-only tool/sub-agent tool-use hard cap.
    pub max_tool_use_concurrency: u32,
    // NOTE: there used to be a `restrict_to_workspace: bool` field here
    // mirroring the now-removed `AgentDefinition.restrict_to_workspace`.
    // The single source of truth is `policy.workspace_only` — read it
    // directly when wiring tools (see `init/mod.rs::tool_deps`).
    pub reliability: ReliabilityConfig,
    pub learnings: AgentLearningsConfig,
    pub selected_model_id: String,
    pub max_tokens: u64,
    pub context_window: u64,
    /// True when `context_window` came from an agent definition/override rather
    /// than the resolver default. Skipped on the wire; runtime code uses it to
    /// distinguish "custom context window" from "auto by model/account".
    #[serde(default, skip_serializing)]
    pub context_window_configured: bool,
    pub temperature: f64,
    pub compaction: CompactionConfig,
    pub load_workspace_resources: bool,
    pub load_workspace_rules: bool,
    pub skills: SkillsParams,
    pub tools: ResolvedToolSelection,
    pub sub_agents: Vec<SubAgentRef>,
    pub soul_content: String,
    pub sovereign_prompt: bool,
    /// Feature-gated auto-continue for the turn loop (default `false`).
    /// Resolved from `AgentDefinition.auto_continue`.
    #[serde(default)]
    pub auto_continue: bool,

    // Legit `Option`s — see module docs.
    pub selected_account_id: Option<String>,
    pub delegation_config: Option<DelegationConfig>,
}

impl ResolvedAgent {
    /// Resolve an agent definition into a runtime snapshot.
    ///
    /// Walks `inherits_from` via the store, then fills every default so the
    /// caller can read a fully-populated struct without matching on `Option`.
    ///
    /// Agent resolve contract (design doc §11.4) final signature. Every §11.4 rewire site constructs
    /// a `ResolvedAgent` via this single entry point:
    ///
    /// ```ignore
    /// let resolved = ResolvedAgent::resolve(
    ///     definitions.get(agent_id)?,
    ///     Some(&definitions),
    ///     &overrides,
    /// )?;
    /// ```
    ///
    /// Builtins ship with `selected_model_id = None` on purpose — the default
    /// model is an *integrations* concern (app-level, not per-agent). When
    /// `def.selected_model_id` is `None`, a definition up the inheritance
    /// chain must supply one; otherwise resolution fails with
    /// `ResolveError::MissingModel`. Workspace falls back to
    /// `personal_workspace()` when `SessionOverrides.workspace` is `None`.
    ///
    /// # Background / offline subsystems must not call this
    ///
    /// `ResolvedAgent::resolve` enforces session-launch-shaped invariants
    /// (`MissingModel`, workspace materialization, full default fill-in)
    /// that an **offline** caller — reflection, active learning, project-
    /// memory consolidation, scheduled maintenance, embedding workers —
    /// cannot satisfy: at the time those run, the session was started by
    /// some other model + workspace + overrides triple, and re-resolving
    /// from scratch may either fail (`MissingModel` for an agent whose
    /// upstream definition was edited since launch) or silently substitute
    /// a different model than the session actually used. Both outcomes are
    /// data-loss class bugs against an offline analytic.
    ///
    /// Background callers MUST instead use one of the narrow accessors:
    ///
    /// - `super::resolver::resolve_definition` / `resolve_definition_by_id`
    ///   — walks `inherits_from` only; no model strictness, no workspace
    ///   side-effect. Use this when the subsystem only needs the merged
    ///   `AgentDefinition` (capability flags, `learnings`, `skills_config`
    ///   etc.) and not a per-session runtime snapshot.
    /// - `definitions::learnings_lookup::resolve_learnings_for` — the
    ///   workspace-memory / reflection-tuned form of the above.
    /// - The session's own recorded `model` / `account_id` / `workspace`
    ///   from `UnifiedSessionRecord` — for "what did this session actually
    ///   use?" questions an offline job is almost always trying to answer.
    ///
    /// The only legitimate call sites today are
    /// `agent_core::init::resolve_for_session` (the unique session-launch
    /// path) and a small `api/agent/public::get_config` view that prefers
    /// the full resolve and falls back to `resolve_definition` on failure
    /// (already documented at the call site). Cleanup history for this
    /// invariant lives in `docs/rust-backend/agent-core-cleanup-todo--0429.md`.
    pub fn resolve(
        def: &AgentDefinition,
        store: Option<&AgentDefinitionsStore>,
        overrides: &SessionOverrides,
    ) -> Result<Self, ResolveError> {
        let merged =
            super::resolver::resolve_definition(def, store).map_err(ResolveError::Inheritance)?;

        let workspace = overrides
            .workspace
            .clone()
            .unwrap_or_else(app_paths::personal_workspace);

        let selected_model_id = merged
            .selected_model_id
            .clone()
            .ok_or_else(|| ResolveError::MissingModel(merged.id.clone()))?;

        let capabilities = merged.capabilities.clone().unwrap_or_default();
        let session_model = merged
            .session_model
            .clone()
            .unwrap_or_else(default_session_model);

        // Compiled-in builtins ship `autonomy: Full` (and `AutonomyLevel`
        // defaults to Full), so this honors a user overlay that downgrades
        // a builtin to ReadOnly — the Settings Access Mode toggle must
        // take effect at session launch.
        let policy = merged.agent_policy.clone().unwrap_or_default();

        let animate = overrides
            .animate
            .unwrap_or_else(|| merged.animate.unwrap_or(true));
        let execution_mode = merged.execution_mode.unwrap_or_default();
        let exec_timeout = merged.exec_timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_SECS);
        let max_tool_use_concurrency = merged
            .max_tool_use_concurrency
            .filter(|value| *value > 0)
            .unwrap_or_else(default_max_tool_use_concurrency);
        let reliability = merged.reliability.clone().unwrap_or_default();
        let learnings = merged.learnings.clone().unwrap_or_default();

        let max_tokens = merged.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
        let configured_context_window = merged.context_window.filter(|&v| v > 0);
        let context_window = configured_context_window.unwrap_or(DEFAULT_CONTEXT_WINDOW);
        let temperature = merged.temperature.unwrap_or(DEFAULT_TEMPERATURE);

        let compaction = session_model.compaction.clone().unwrap_or_default();

        let load_workspace_resources = merged.load_workspace_resources.unwrap_or(true);
        let load_workspace_rules = merged.load_workspace_rules.unwrap_or(true);
        let skills = skills_from_schema(merged.skills_config.as_ref());
        let tools = ResolvedToolSelection::from_schema(&merged.tools, &capabilities);

        let sub_agents = merged.sub_agents.clone().unwrap_or_default();
        let soul_content = merged.soul_content.clone().unwrap_or_default();

        Ok(Self {
            agent_id: merged.id.clone(),
            name: merged.name.clone(),
            capabilities,
            session_model,
            policy,
            animate,
            workspace,
            execution_mode,
            exec_timeout,
            max_tool_use_concurrency,
            reliability,
            learnings,
            selected_model_id,
            max_tokens,
            context_window,
            context_window_configured: configured_context_window.is_some(),
            temperature,
            compaction,
            load_workspace_resources,
            load_workspace_rules,
            skills,
            tools,
            sub_agents,
            soul_content,
            sovereign_prompt: merged.sovereign_prompt,
            auto_continue: merged.auto_continue,

            selected_account_id: merged.selected_account_id.clone(),
            delegation_config: merged.delegation_config.clone(),
        })
    }

    /// The workspace this resolved agent will run in.
    ///
    /// Resolved at session launch from the fallback chain
    /// `SessionOverrides.workspace > personal_workspace()`.
    /// Returns `PathBuf` (not `Option<PathBuf>`) — callers never branch on
    /// "workspace unset".
    pub fn workspace(&self) -> &std::path::Path {
        &self.workspace
    }
}

const DEFAULT_MAX_TOKENS: u64 = 8192;
const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_TEMPERATURE: f64 = 0.7;
const DEFAULT_EXEC_TIMEOUT_SECS: u64 = 60;

fn default_session_model() -> SessionModel {
    use super::schema::SessionMode;
    SessionModel {
        mode: SessionMode::PerSession,
        compaction: None,
        processing_lock: true,
        max_iterations: 500,
    }
}

fn skills_from_schema(cfg: Option<&AgentSkillsConfig>) -> SkillsParams {
    match cfg {
        Some(cfg) => SkillsParams {
            enabled: cfg.enabled.unwrap_or(true),
            include: cfg.include.clone(),
            disabled: cfg.exclude.clone(),
            source_dirs: cfg.source_dirs.clone(),
        },
        None => SkillsParams::default(),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::definitions::builtin::get_builtin_agent;

    fn with_pinned_model(mut def: AgentDefinition) -> AgentDefinition {
        if def.selected_model_id.is_none() {
            def.selected_model_id = Some("test/default-model".into());
        }
        def
    }

    fn empty_overrides() -> SessionOverrides {
        SessionOverrides::default()
    }

    /// A resolve of a builtin agent must produce concrete values for every
    /// non-allowlisted field — no panics, no `Option` reads required.
    #[test]
    fn resolve_builtin_os_fills_defaults() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");

        assert!(!resolved.agent_id.is_empty());
        assert!(!resolved.selected_model_id.is_empty());
        assert!(resolved.max_tokens > 0);
        assert!(resolved.context_window > 0);
        assert!(resolved.temperature >= 0.0);
        assert!(resolved.session_model.max_iterations > 0);

        let _ = &resolved.selected_account_id;
        let _ = &resolved.delegation_config;
    }

    #[test]
    fn resolve_builtin_sde_fills_compaction() {
        let def = with_pinned_model(get_builtin_agent("builtin:sde").expect("sde builtin exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        assert!(resolved.compaction.enabled);
        assert!(resolved.compaction.trigger_ratio > 0.0);
        assert!(resolved.compaction.keep_ratio > 0.0);
    }

    /// I-NO-OPTION-AT-RUNTIME: the only `Option` fields are the explicit
    /// allow-list. This is a structural guard — if a future edit adds an
    /// `Option<T>` to `ResolvedAgent`, the serialized JSON will still have
    /// the field named, and this test will serve as a reminder to either
    /// (a) resolve a default, or (b) update the allow-list.
    #[test]
    fn no_option_at_runtime_except_allowlist() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        let json = serde_json::to_value(&resolved).expect("serializes");
        let obj = json.as_object().expect("is object");

        const ALLOWED_NULLABLE: &[&str] = &["selectedAccountId", "delegationConfig"];

        for (key, value) in obj.iter() {
            if value.is_null() {
                assert!(
                    ALLOWED_NULLABLE.contains(&key.as_str()),
                    "ResolvedAgent.{} is null but is not in the I-NO-OPTION-AT-RUNTIME allow-list. \
                     Either fill a default in ResolvedAgent::resolve(), or update ALLOWED_NULLABLE.",
                    key
                );
            }
        }
    }

    #[test]
    fn resolved_agent_has_no_llm_params_wrapper() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        let json = serde_json::to_value(&resolved).expect("serializes");
        let obj = json.as_object().expect("is object");

        assert!(
            !obj.contains_key("llm"),
            "ResolvedAgent must not grow a wrapper that can hide nested optional runtime fields"
        );
    }

    #[test]
    fn resolve_missing_model_fails_clean() {
        let def = AgentDefinition {
            id: "test:no-model".into(),
            name: "no model".into(),
            selected_model_id: None,
            ..Default::default()
        };
        let err = ResolvedAgent::resolve(&def, None, &empty_overrides()).unwrap_err();
        assert!(matches!(err, ResolveError::MissingModel(_)));
    }

    #[test]
    fn workspace_resource_and_rule_toggles_resolve_independently() {
        let mut def =
            with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        def.load_workspace_resources = Some(true);
        def.load_workspace_rules = Some(false);

        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");

        assert!(resolved.load_workspace_resources);
        assert!(!resolved.load_workspace_rules);
    }

    #[test]
    fn max_tool_use_concurrency_resolves_default_and_override() {
        let mut def =
            with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        def.max_tool_use_concurrency = None;
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        assert_eq!(
            resolved.max_tool_use_concurrency,
            default_max_tool_use_concurrency()
        );

        def.max_tool_use_concurrency = Some(3);
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        assert_eq!(resolved.max_tool_use_concurrency, 3);
    }

    #[test]
    fn user_allowed_tools_do_not_override_missing_capabilities() {
        let mut def =
            with_pinned_model(get_builtin_agent("builtin:sde").expect("sde builtin exists"));
        def.tools.user_allowed_tools = vec![crate::tools::names::MANAGE_SESSION.to_string()];

        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");

        assert!(
            resolved
                .tools
                .excluded
                .contains(&crate::tools::names::MANAGE_SESSION.to_string()),
            "SDE cannot regain management tools through stale or user-authored user_allowed_tools"
        );
        assert!(
            !resolved
                .tools
                .restrict_to
                .contains(&crate::tools::names::MANAGE_SESSION.to_string()),
            "capability-blocked tools must not enter strict allow-lists either"
        );
    }

    #[test]
    fn inspect_terminals_is_global_baseline_for_strict_agent_allowlists() {
        let def = with_pinned_model(get_builtin_agent("builtin:wingman").expect("wingman exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");

        assert!(
            resolved
                .tools
                .restrict_to
                .contains(&tool_names::INSPECT_TERMINALS.to_string()),
            "strict allow-list agents must still be able to inspect user terminals"
        );
    }

    #[test]
    fn explicit_exclusion_can_still_disable_inspect_terminals() {
        let mut def =
            with_pinned_model(get_builtin_agent("builtin:wingman").expect("wingman exists"));
        def.tools.excluded_tools = vec![tool_names::INSPECT_TERMINALS.to_string()];
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        let disabled = crate::tools::derive_disabled_tools(
            &resolved.tools.restrict_to,
            &resolved.tools.excluded,
        );

        assert!(disabled.contains(tool_names::INSPECT_TERMINALS));
    }

    /// The agent definition's own model always wins over defaults.
    #[test]
    fn definition_model_wins() {
        let mut def = get_builtin_agent("builtin:os").expect("os builtin exists");
        def.selected_model_id = Some("agent/pinned-model".into());
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        assert_eq!(resolved.selected_model_id, "agent/pinned-model");
    }

    /// Workspace falls back to `personal_workspace()` when overrides are empty.
    #[test]
    fn workspace_falls_back_to_personal_workspace() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &empty_overrides()).expect("resolves");
        assert_eq!(
            resolved.workspace(),
            app_paths::personal_workspace().as_path()
        );
    }

    /// Session override wins over the personal_workspace() default.
    #[test]
    fn workspace_session_override_wins() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let overrides = SessionOverrides::new(Some(PathBuf::from("/tmp/session-override")), None);
        let resolved = ResolvedAgent::resolve(&def, None, &overrides).expect("resolves");
        assert_eq!(
            resolved.workspace(),
            std::path::Path::new("/tmp/session-override")
        );
    }

    /// Session animate override flips the resolved value.
    #[test]
    fn animate_session_override_wins() {
        let def = with_pinned_model(get_builtin_agent("builtin:os").expect("os builtin exists"));
        let overrides = SessionOverrides::new(None, Some(false));
        let resolved = ResolvedAgent::resolve(&def, None, &overrides).expect("resolves");
        assert!(!resolved.animate);
    }
}

#[cfg(test)]
#[path = "tests_extended.rs"]
mod tests_extended;
