//! Unified session initialization.
//!
//! Single `ensure_session_initialized` entry point. Behavior is driven by
//! `AgentDefinition.capabilities` (what the agent *can* do) and
//! `ResolvedAgent` (the immutable snapshot of the agent's runtime
//! parameters — model, timeouts, policy). App-level cross-agent settings
//! (web-search API key, exec defaults) live on
//! `IntegrationsConfig`; per-session mutables (workspace, label, animate)
//! live on `SessionOverrides`.
//!
//! the initialization placement (design doc §11.2) placement:
//! - `ResolvedAgent`: agent-intrinsic (`selected_model_id`, `max_tokens`,
//!   `temperature`, `policy`, `tools`, `sub_agents`, …).
//! - `IntegrationsConfig`: app-level (`nodes`, `web_search`, `databases`,
//!   `exec`).
//! - `SessionOverrides`: per-session (`workspace`, `label`, `animate`).
//!
//! Submodule layout (each name = one concern):
//! - `agent_definition_loader` — reads `agent_definition_id` → soul + skills
//! - `capabilities`            — pure derivation of capability flags + per-agent resources
//! - `fast_path`               — re-entrant init shortcut
//! - `mcp_wiring`              — MCP server connect + tool registration
//! - `runtime_assemble`        — `SessionRuntime` finalization + side-effects
//! - `session_factory`         — provider + base tool registry + policy assembly
//! - `tool_assembly`           — overlay registry build (AgentTool, ToolSearchTool, etc.)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tracing::info;

use core_types::providers::NativeHarnessType;

use crate::core::definitions::resolved::{ResolveError, ResolvedAgent};
use crate::core::definitions::resolver;
use crate::core::definitions::AgentDefinition;
use crate::core::session::overrides::SessionOverrides;
use crate::init::launch_spec::AgentLaunchSpec;
use crate::integrations::config::IntegrationsConfig;
use crate::state::{AgentAppState, SessionRuntime};
use crate::tools::registration::ToolDeps;

mod agent_definition_loader;
mod capabilities;
mod fast_path;
pub mod launch_spec;
mod mcp_wiring;
mod runtime_assemble;
mod session_factory;
mod tool_assembly;

// `mcp_wiring::*` and `session_factory::*` are reached only by sibling
// submodules (`session_factory.rs` calls `super::mcp_wiring::*`,
// `mod.rs` itself uses `build_session_runtime` via the local
// `session_factory::*` path). They don't need to be flattened onto
// `init::*`.
use session_factory::build_session_runtime;

fn build_policy_context_activator(
    workspace_root: &Path,
    agent_id: &str,
    // Whether to load the OS-agent (workspace-independent) policy set instead
    // of the workspace-scoped one. Driven by `cap_flags.has_gateway` at the
    // call site: gateway-capable agents run without a meaningful workspace
    // root, so their policies must come from the OS-agent set. Named for the
    // decision it drives, not the capability that happens to feed it (the
    // prior `is_channel_session` name asserted a message-source dimension it
    // was never actually given — see architecture audit S5).
    use_os_agent_policy_set: bool,
    sovereign_prompt: bool,
) -> Option<Arc<crate::policies::activation::SessionScopedContextActivator>> {
    let policy_set = if use_os_agent_policy_set || sovereign_prompt {
        crate::policies::load_enabled_policy_set_for_os_agent(agent_id)
    } else {
        crate::policies::load_enabled_policy_set(workspace_root, agent_id)
    };
    let activator = crate::policies::activation::SessionScopedContextActivator::from_policy_set(
        PathBuf::from(workspace_root),
        policy_set,
    );
    if activator.is_empty() {
        None
    } else {
        Some(Arc::new(activator))
    }
}

/// Request to initialize a session via the unified entry point.
///
/// Internal-only: external callers go through [`init_session`], which
/// builds this request after resolving the agent definition + integrations
/// snapshot.
struct UnifiedInitRequest<'a> {
    state: &'a AgentAppState,
    session_id: &'a str,
    account_id: Option<&'a str>,
    definition: AgentDefinition,
    /// Immutable runtime snapshot of the agent. Workspace is embedded on
    /// `resolved.workspace` (resolved by `ResolvedAgent::resolve` from
    /// `overrides.workspace > personal_workspace()`).
    resolved: ResolvedAgent,
    /// App-level integrations — nodes, web_search, plugins, databases,
    /// exec defaults. Typically a snapshot of `state.integrations.snapshot()`.
    integrations: IntegrationsConfig,
    /// Per-session overrides. Read-only inside `ensure_session_initialized`
    /// (the resolved workspace/animate/label are already baked into
    /// `resolved`); kept in the request so the future SessionRuntime can
    /// hold the original override set for later read-back.
    overrides: SessionOverrides,
    /// Model override. If None, uses `resolved.selected_model_id`.
    model_override: Option<&'a str>,
    /// Provider override for subscription-bound native harness sessions.
    native_harness_type: Option<NativeHarnessType>,
}

/// Build the `(ResolvedAgent, IntegrationsConfig, SessionOverrides)` triad
/// from a session's `AgentDefinition` + app integrations + caller-supplied
/// workspace and model.
///
/// Agent resolve contract (design doc §11.4) single entry point for producing a [`ResolvedAgent`].
/// Callers like `init_project_session` no longer construct
/// resolved / integrations
/// inline — this helper performs the `resolve()` call against the app's
/// `AgentDefinitionsStore`, snapshots the live integrations, and packages
/// the per-session overrides.
///
/// `model_override` takes precedence over any `selected_model_id` baked
/// into the definition and its template chain. This matches the pre-65'
/// behaviour where callers could pin a model at session launch.
fn is_model_override_strict(
    effective_selected_model_id: Option<&str>,
    model_override: &str,
) -> bool {
    effective_selected_model_id != Some(model_override)
}

fn resolve_for_session(
    state: &AgentAppState,
    definition: &AgentDefinition,
    workspace: std::path::PathBuf,
    model_override: Option<&str>,
) -> Result<(ResolvedAgent, IntegrationsConfig, SessionOverrides), String> {
    let integrations = state.integrations.snapshot();
    let overrides = SessionOverrides::new(Some(workspace), None);
    let store = crate::definitions::definitions_store();

    // Clone so we can pin `selected_model_id` without disturbing the
    // registered in-memory definition (which might be shared across
    // sessions and must stay immutable during a live app run).
    //
    // When the caller supplies a `model_override` that differs from the
    // agent definition's effective selected model (including any inherited
    // template value), treat that as "use exactly this model" and drop
    // definition reliability fallbacks so the override is honoured strictly.
    // Session launch currently requires a `model` value even when it mirrors
    // the definition's own selected model; that mirror value must not erase
    // the Settings-authored fallback chain.
    let effective_definition =
        resolver::resolve_definition(definition, Some(&store)).map_err(|err| err.to_string())?;
    let mut pinned = definition.clone();
    if let Some(m) = model_override.filter(|s| !s.is_empty()) {
        let is_true_override =
            is_model_override_strict(effective_definition.selected_model_id.as_deref(), m);
        pinned.selected_model_id = Some(m.to_string());
        if is_true_override {
            if let Some(reliability) = pinned.reliability.as_mut() {
                reliability.fallback_models.clear();
            }
        }
    }

    let mut resolved = ResolvedAgent::resolve(&pinned, Some(&store), &overrides)
        .map_err(|err| match err {
            ResolveError::MissingModel(id) => format!(
                "agent '{}' has no selected_model_id after resolve — caller must supply a model_override",
                id
            ),
            other => other.to_string(),
        })?;
    // Effective excluded-skills set = app-global list (Extensions hub)
    // ∪ per-agent exclude (definition). The global list previously lived
    // on builtin:os's overlay, which silently failed to apply to other
    // agents.
    for skill in &integrations.excluded_skills {
        if !resolved.skills.disabled.contains(skill) {
            resolved.skills.disabled.push(skill.clone());
        }
    }
    Ok((resolved, integrations, overrides))
}

/// Combined resolve + init in a single call.
///
/// Equivalent to calling `resolve_for_session` then
/// `ensure_session_initialized` — the intermediate products
/// (`resolved`, `integrations`, `overrides`) are never inspected or
/// modified by any caller, so this wrapper eliminates the relay.
pub async fn init_session(
    state: &AgentAppState,
    spec: AgentLaunchSpec,
) -> Result<Arc<SessionRuntime>, String> {
    let AgentLaunchSpec {
        session_id,
        definition,
        workspace,
        account_id,
        model_override,
        native_harness_type,
    } = spec;
    let (resolved, integrations, overrides) =
        resolve_for_session(state, &definition, workspace, model_override.as_deref())?;
    ensure_session_initialized(UnifiedInitRequest {
        state,
        session_id: &session_id,
        account_id: account_id.as_deref(),
        definition,
        resolved,
        integrations,
        overrides,
        model_override: model_override.as_deref(),
        native_harness_type,
    })
    .await
}

/// Resolve the Agent Org run context for a session, working for both
/// the coordinator (root) session and materialized member sessions. The
/// lookup walks `agent_sessions.parent_session_id` upward from the given
/// `session_id` until it finds an ancestor that anchors an
/// `agent_org_runs` row — `root_session_id` remains the
/// single anchor for an org run (no per-member rows).
///
/// See `AgentOrgRunStore::context_for_session_with_parent_walk` for
/// the rationale and the bounded-depth + cycle guard.
fn load_agent_org_context(
    state: &AgentAppState,
    session_id: &str,
) -> Option<crate::coordination::agent_org_runs::AgentOrgRunContext> {
    let Some(handle) = state.app_handle.as_ref() else {
        tracing::debug!(
            session_id = %session_id,
            "[init] agent_org_context lookup skipped (no app_handle — headless context)"
        );
        return None;
    };
    use tauri::Manager;
    let org_store = handle.state::<std::sync::Arc<crate::definitions::orgs::AgentOrgsStore>>();
    match crate::coordination::agent_org_runs::AgentOrgRunStore::context_for_session_with_parent_walk(
        session_id,
        org_store.inner(),
    ) {
        Ok(Some(ctx)) => {
            // Surfacing this at info is intentional: the runtime visibility
            // of `org_send_message` keys off whether this function
            // returned `Some`, so when an org message call goes
            // wrong "did this session see an org context?" is the first
            // question to answer from logs.
            tracing::info!(
                session_id = %session_id,
                org_id = %ctx.org_id,
                run_id = %ctx.run_id,
                coordinator_agent_id = %ctx.coordinator_agent_id,
                member_count = ctx.members.len(),
                "[init] loaded Agent Org context"
            );
            Some(ctx)
        }
        Ok(None) => {
            tracing::debug!(
                session_id = %session_id,
                "[init] no Agent Org context for this session (parent walk found no anchored run)"
            );
            None
        }
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[init] failed to load Agent Org context"
            );
            None
        }
    }
}

/// Internal entry point for session initialization. Public callers go
/// through [`init_session`], which builds the `UnifiedInitRequest` from
/// an `AgentDefinition` + workspace + model override.
///
/// Capabilities are resolved from the session's `AgentDefinition` —
/// no flavor enums, no type-specific heuristics. `IntegrationsConfig`
/// + `SessionOverrides` supply the app- and session-level parameters.
async fn ensure_session_initialized(
    request: UnifiedInitRequest<'_>,
) -> Result<Arc<SessionRuntime>, String> {
    let UnifiedInitRequest {
        state,
        session_id,
        account_id,
        definition,
        resolved,
        integrations,
        overrides,
        model_override,
        native_harness_type,
    } = request;

    let workspace_root = resolved.workspace().to_path_buf();

    // Resolve model from override → resolved agent. Deferred until after
    // the fast path so that re-entrant calls against an already-initialized
    // session (e.g. channel re-inject) don't fail when neither the caller
    // nor the resolved agent has a model — the runtime on record is the
    // source of truth in that case. `ResolvedAgent::selected_model_id` is
    // a non-Option (I-NO-OPTION-AT-RUNTIME), so we only honour an explicit
    // override here; otherwise we use the resolved value verbatim.
    let requested_model = match model_override {
        Some(m) if !m.is_empty() => Some(m.to_string()),
        _ if !resolved.selected_model_id.is_empty() => Some(resolved.selected_model_id.clone()),
        _ => None,
    };

    // Fast path: re-entrant init for an already-running session.
    if let Some(existing) = fast_path::try_reuse_existing(
        state,
        session_id,
        account_id,
        requested_model.as_deref(),
        &workspace_root,
    )
    .await
    {
        return Ok(existing);
    }

    // Slow path: we're about to (re)build a runtime — model is now required.
    let model =
        requested_model.ok_or("model is required: not provided by caller and not set in config")?;

    crate::skills::loader::source_dirs::ensure_source_dirs(&resolved.skills.source_dirs).await?;

    state.invalidate_session(session_id).await;

    if !workspace_root.exists() {
        let pr = workspace_root.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&pr))
            .await
            .map_err(|err| format!("Failed to spawn create_dir_all: {}", err))?
            .map_err(|err| format!("Failed to create workspace directory: {}", err))?;
    }

    let account_id = match account_id {
        Some(account_id) => account_id.to_string(),
        None => {
            #[cfg(debug_assertions)]
            {
                if crate::providers::e2e_fake::is_e2e_fake_provider_model(&model) {
                    "e2e-fake-provider-account".to_string()
                } else {
                    return Err(format!(
                        "account_id is required for session {} — cannot initialize provider without it",
                        session_id
                    ));
                }
            }
            #[cfg(not(debug_assertions))]
            {
                return Err(format!(
                    "account_id is required for session {} — cannot initialize provider without it",
                    session_id
                ));
            }
        }
    };

    info!(
        "[init] Initializing session {} (model={}, workspace_root={})",
        session_id,
        model,
        workspace_root.display()
    );

    // Ensure session exists in memory state. If not (e.g. created via Tauri command
    // which only writes to DB), register it now with default SDE definition.
    //
    // This is also the one-shot hook point for rehydrating per-session
    // state that was persisted during a previous app run but lives only in
    // memory at runtime (e.g. `PlanApprovalManager`). We only rehydrate on
    // the branch where the `AgentSession` object was just created —
    // otherwise the in-memory manager already reflects the live state and
    // replaying broadcasts would double-fire `agent:plan_ready_for_approval`.
    if state.get_session(session_id).await.is_none() {
        register_session_with_definition_and_rehydrate(state, session_id, definition.clone()).await;
    }

    // Single session lookup — used for cancel_flag, definition fallback, and set_runtime.
    // Capabilities and sovereign_prompt come from `resolved` (already derived from the
    // same definition chain), so we don't re-read them from session.definition.
    let session_handle = state
        .get_session(session_id)
        .await
        .ok_or_else(|| format!("Session {} missing after registration", session_id))?;

    // Capability derivation — single pass over `resolved` for all gates.
    let cap_flags = capabilities::CapabilityFlags::from_resolved(&resolved);

    let disabled_set =
        crate::tools::derive_disabled_tools(&resolved.tools.restrict_to, &resolved.tools.excluded);

    let node_registry = capabilities::build_node_registry(&cap_flags, &integrations);
    let bus = capabilities::channel_bus_for(&cap_flags, state);
    // Single SecurityPolicy instance per session — shared by ToolDeps
    // (exec tool) AND the subagent AgentTool config. This policy owns
    // command policy + path *syntax* validation only; path containment
    // is decided by the live `SessionWorkspace` (the single source of
    // truth for workspace roots and `/add-dir` grants).
    let exec_security_policy = Arc::new(resolved.policy.to_runtime_security());

    let log_prefix = if resolved.name.is_empty() {
        "agent".to_string()
    } else {
        resolved.name.clone()
    };

    let disabled_mcp_servers = capabilities::disabled_mcp_servers(&resolved);
    let disabled_mcp_tools = capabilities::disabled_mcp_tools(&resolved);

    // Hydrate workspace from DB (additional_directories from earlier /add-dir calls).
    let scratchpad_dir = app_paths::ensure_scratchpad(session_id, &workspace_root)
        .map_err(|err| {
            tracing::warn!(
                "[init] ensure_scratchpad failed for session {}: {} — scratchpad disabled",
                session_id,
                err
            );
            err
        })
        .ok();
    let workspace_state =
        tool_assembly::hydrate_workspace_state(&workspace_root, session_id, &log_prefix);
    // Runtime (re)build re-hydrated the workspace from DB — push the fresh
    // snapshot to the frontend mirror (`useSessionWorkspaceSync`).
    crate::state::commands::session::emit_workspace_changed(
        state.app_handle.as_ref(),
        session_id,
        &workspace_state.read().clone(),
    );

    // Resolve the Agent Org run context up-front so tool registrations
    // that branch on org-membership (currently `create_plan`, which routes
    // member-submitted plans to the coordinator's inbox instead of the
    // user's Build button) see the same snapshot the overlay-assembly
    // step uses below.
    let agent_org_context = load_agent_org_context(state, session_id);

    let agent_browser_config = {
        let controller = state.agent_browser.lock().await;
        controller.config()
    };

    let session_record = crate::session::persistence::get_session(session_id)
        .ok()
        .flatten();
    let agent_org_current_member_id = session_record
        .as_ref()
        .and_then(|record| record.org_member_id.clone());

    let mut readonly_extra_dirs = vec![crate::skills::loader::global_skills_dir()];
    readonly_extra_dirs.extend(
        resolved
            .skills
            .source_dirs
            .iter()
            .map(|source| crate::skills::loader::source_dirs::source_dir_path(source)),
    );

    let tool_deps = ToolDeps {
        workspace: Arc::clone(&workspace_state),
        scratchpad_dir: scratchpad_dir.clone(),
        readonly_extra_dirs,
        exec_timeout: resolved.exec_timeout,
        // Single source of truth for "restrict file/exec ops to the
        // session workspace": `AgentPolicy.workspace_only`. This was
        // previously also exposed as a top-level `restrict_to_workspace`
        // field on `AgentDefinition` / `ResolvedAgent`, but the two
        // toggles edited the same behaviour through different plumbing
        // and could drift. Collapsed onto the policy field so saving
        // either UI control mutates one fact.
        restrict_to_workspace: resolved.policy.workspace_only,
        pty_sessions: state.pty_sessions.clone(),
        app_handle: state.app_handle.clone(),
        security_policy: Some(Arc::clone(&exec_security_policy)),
        action_bridge: Some(state.action_bridge.clone()),
        execution_mode: resolved.execution_mode,
        agent_browser_config: Some(agent_browser_config),
        screenshot_store: Some(state.screenshot_store.clone()),
        web_search_api_key: if integrations.web_search.api_key.is_empty() {
            None
        } else {
            Some(integrations.web_search.api_key.clone())
        },
        desktop_enabled: cap_flags.has_desktop,
        agent_model: model.clone(),
        session_id: session_id.to_string(),
        bus,
        session_account_id: Some(account_id.clone()),
        node_registry,
        question_manager: Some(Arc::clone(&session_handle.question_manager)),
        secret_broker: Some(Arc::clone(&session_handle.secret_broker)),
        plan_approval_manager: session_handle.plan_approval_manager.clone(),
        plan_slot_cache: Some(session_handle.plan_slot_cache.clone()),
        agent_org_context: agent_org_context.clone(),
        agent_org_current_member_id: agent_org_current_member_id.clone(),
        channel_context: None,
    };

    let spec = build_session_runtime(
        &model,
        Some(&account_id),
        &resolved.reliability,
        native_harness_type,
        tool_deps,
        &disabled_set,
        &disabled_mcp_servers,
        &disabled_mcp_tools,
        resolved.load_workspace_resources,
        &log_prefix,
    )
    .await?;
    let mut tool_registry = spec.tool_registry;

    let policy_with_mode = spec
        .policy
        .with_extra_layer(crate::tools::policy::ToolPolicyLayer::deny_only(
            resolved.policy.autonomy.deny_tools(),
        ))
        .with_ask_tools(resolved.policy.autonomy.ask_tools());

    session_handle
        .permission_manager
        .set_workspace(&workspace_root)
        .await;

    // InboxTool: enabled when gateway capability is present
    if cap_flags.has_gateway {
        tool_registry.register(Box::new(
            crate::tools::impls::comms::send_to_inbox::InboxTool::new(),
        ));
    }

    let policy_arc = Arc::new(policy_with_mode);

    // Two-phase tool registry: base (just built) + overlay (sub-agent / search / mode).
    let base_registry = Arc::new(tool_registry);
    let final_registry = tool_assembly::assemble_overlay(
        Arc::clone(&base_registry),
        tool_assembly::OverlayContext {
            state,
            session: &session_handle,
            session_id,
            resolved: &resolved,
            model: &model,
            account_id: &account_id,
            workspace_dir: workspace_root.clone(),
            workspace: workspace_state.read().clone(),
            scratchpad_dir,
            agent_org_context: agent_org_context.as_ref(),
            provider: Arc::clone(&spec.provider),
            native_harness_type,
            policy_arc: Arc::clone(&policy_arc),
            disabled_set: &disabled_set,
            exec_security_policy,
        },
    );

    // Definition load with in-memory fallback for soul + def-id. Skills
    // state lives ONLY on `resolved.skills` (single source); the old
    // parallel `runtime.skills_config` capture was deleted.
    let (agent_soul, agent_definition_id) =
        runtime_assemble::load_or_recover_definition(session_id, &session_handle).await;
    let sovereign_prompt = resolved.sovereign_prompt;

    info!(
        "[init] session={} resolved_def_id={:?} agent_soul_len={} skills_enabled={}",
        session_id,
        agent_definition_id,
        agent_soul.as_deref().map(str::len).unwrap_or(0),
        resolved.skills.enabled,
    );

    let policy_context_activator = build_policy_context_activator(
        &workspace_root,
        &resolved.agent_id,
        cap_flags.has_gateway,
        resolved.sovereign_prompt,
    );

    // Captured before `resolved` moves into AssembleParams below; needed
    // for the SessionStart hook fired after runtime install.
    let load_workspace_resources = resolved.load_workspace_resources;

    let runtime = runtime_assemble::install_runtime(
        &session_handle,
        runtime_assemble::AssembleParams {
            provider: spec.provider,
            final_registry,
            policy_arc,
            model: model.clone(),
            account_id: account_id.clone(),
            native_harness_type,
            workspace_state,
            mcp_auto_approved: spec.mcp_auto_approved,
            resolved,
            integrations,
            overrides,
            agent_soul,
            sovereign_prompt,
            policy_context_activator,
            agent_org_context,
            agent_org_current_member_id,
            agent_definition_id,
        },
    )
    .await;

    runtime_assemble::mark_running_for_gateway(state, cap_flags.has_gateway, &account_id).await;
    runtime_assemble::register_in_file_registry(session_id, &log_prefix, &model, &workspace_root);
    runtime_assemble::log_init_complete(session_id, &model, &workspace_root);

    // Fire HookEvent::SessionStart — the slow path only runs when a runtime
    // is (re)built (fresh session or resume after restart), so this fires
    // once per session bring-up, never per turn (fast path returns above).
    crate::specialization::hooks::dispatch::fire_session_start(
        &workspace_root,
        load_workspace_resources,
        session_id,
        &model,
    );

    Ok(runtime)
}

/// Register an `AgentSession` object in the in-memory state and rehydrate
/// any per-session managers whose state lives in sqlite between app runs.
///
/// Two callers:
///   1. `ensure_session_initialized` — runs before any agent turn.
///   2. `agent_plan_approval_response` — runs when the user clicks Build
///      before they have sent any message, so the agent pipeline has not
///      yet entered `ensure_session_initialized` for this window.
///
/// Both need the same behavior: create the session, pull the pending plan
/// row out of sqlite, replay `agent:plan_ready_for_approval` so the FE
/// atoms match the DB. Keeping the sequence in one place prevents the two
/// call sites from drifting — if a future manager (e.g. mode_switch) also
/// needs restart-rehydrate, it hooks in here.
pub async fn register_session_with_rehydrate(
    state: &AgentAppState,
    session_id: &str,
) -> Result<(), String> {
    let definition = crate::definitions::prefix_lookup::definition_for_session_id(session_id)
        .ok_or_else(|| {
            format!(
                "session '{}' has no in-memory definition and no builtin prefix mapping",
                session_id
            )
        })?;
    register_session_with_definition_and_rehydrate(state, session_id, definition).await;
    Ok(())
}

pub async fn register_session_with_definition_and_rehydrate(
    state: &AgentAppState,
    session_id: &str,
    definition: AgentDefinition,
) {
    use crate::state::AgentSession;

    let agent_session = AgentSession::new(session_id.to_string(), definition);
    let registered = state.register_session(agent_session).await;
    info!(
        "[init] Auto-registered session {} in memory state",
        session_id
    );

    if let Some(ref pam) = registered.plan_approval_manager {
        pam.set_app_handle(state.app_handle.clone());
        if let Err(err) = pam.rehydrate_from_db(session_id).await {
            tracing::warn!(
                "[init] plan_approval rehydrate failed for session {}: {}",
                session_id,
                err
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_model_override_strict;

    #[test]
    fn inherited_effective_model_matching_launch_model_is_not_strict_override() {
        assert!(!is_model_override_strict(
            Some("anthropic/claude-sonnet-4"),
            "anthropic/claude-sonnet-4"
        ));
    }

    #[test]
    fn launch_model_different_from_effective_model_is_strict_override() {
        assert!(is_model_override_strict(
            Some("anthropic/claude-sonnet-4"),
            "openai/gpt-4.1"
        ));
    }
}
