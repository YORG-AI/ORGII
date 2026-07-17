//! Session-runtime factory: creates the LLM provider, base tool registry,
//! and resolved tool policy used by every agent turn.
//!
//! This is the canonical "build a session's runtime parts" entry point.
//! The caller (`init::ensure_session_initialized`) assembles `ToolDeps`
//! and policy config; this factory turns those into a usable runtime
//! triple (provider + tool_registry + policy) plus the MCP auto-approve
//! list.
//!
//! Called from:
//! - `init::ensure_session_initialized` (production path)
//! - `crates/e2e-test/src/sde/workspace.rs` (E2E tests)
//! - `api/agent/test/sde.rs` (debug-only test endpoint)

use std::collections::HashSet;
use std::sync::Arc;

use crate::config::ReliabilityConfig;
use crate::providers::traits::LLMProvider;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registration::{self, ToolDeps};
use crate::tools::registry::ToolRegistry;
use core_types::providers::NativeHarnessType;

use super::mcp_wiring::register_mcp_tools_from_app;

/// Output bundle from [`build_session_runtime`].
pub(super) struct SessionRuntimeSpec {
    pub(super) provider: Arc<dyn LLMProvider>,
    pub(super) tool_registry: ToolRegistry,
    pub(super) policy: ResolvedToolPolicy,
    pub(super) mcp_auto_approved: Vec<String>,
}

/// Build the runtime parts for a session: LLM provider, base tool registry
/// (every category registered + MCP), and the resolved tool policy.
///
/// `tool_deps` is the fully-assembled dependency bag the caller assembles
/// from `IntegrationsConfig` + `SessionRuntime` + per-session resources.
/// Policy overlays (access mode, mode-specific allow/deny) are applied by
/// the caller after this returns.
// Seven tightly-coupled inputs all describe the same session-runtime
// build: the chosen model + account, the tool dependency bundle, three
// disjoint disabled-name sets (builtins, MCP servers, MCP tools), and a
// logging prefix. Bundling them into a struct would force every call
// site to spell out a builder for one caller — `agent_core::init::mod.rs`
// — and obscure the fact that all of these values come from the same
// `ResolvedAgent`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn build_session_runtime(
    model: &str,
    account_id: Option<&str>,
    reliability: &ReliabilityConfig,
    native_harness_type: Option<NativeHarnessType>,
    tool_deps: ToolDeps,
    disabled_tools: &HashSet<String>,
    disabled_mcp_servers: &HashSet<String>,
    disabled_mcp_tools: &HashSet<String>,
    load_workspace_resources: bool,
    log_prefix: &str,
) -> Result<SessionRuntimeSpec, String> {
    let workspace_snapshot = tool_deps.workspace.read().clone();
    let workspace_root = workspace_snapshot.working_dir().to_path_buf();
    let llm_session_id = tool_deps.session_id.clone();
    let provider = crate::providers::factory::create_provider_with_native_harness_preflight(
        model,
        account_id,
        reliability,
        native_harness_type,
        Some(workspace_snapshot),
        Some(&llm_session_id),
    )
    .await
    .map_err(|err| format!("Failed to create LLM provider: {}", err))?;

    let mut tool_registry = ToolRegistry::new();

    registration::coding::register(&mut tool_registry, &tool_deps, disabled_tools);
    registration::web::register(&mut tool_registry, &tool_deps, disabled_tools).await;
    registration::desktop::register(&mut tool_registry, &tool_deps, disabled_tools);
    registration::agent_ops::register(&mut tool_registry, &tool_deps, disabled_tools);
    registration::channel::register(&mut tool_registry, &tool_deps, disabled_tools);
    registration::plan_mode::register(&mut tool_registry, &tool_deps, disabled_tools);

    let mcp_auto_approved = register_mcp_tools_from_app(
        tool_deps.app_handle.as_ref(),
        &mut tool_registry,
        Some(&workspace_root),
        if disabled_mcp_tools.is_empty() {
            None
        } else {
            Some(disabled_mcp_tools)
        },
        if disabled_mcp_servers.is_empty() {
            None
        } else {
            Some(disabled_mcp_servers)
        },
        load_workspace_resources,
        log_prefix,
    )
    .await?;

    let provider_arc: Arc<dyn LLMProvider> = Arc::from(provider);

    let policy = ResolvedToolPolicy::permissive();

    Ok(SessionRuntimeSpec {
        provider: provider_arc,
        tool_registry,
        policy,
        mcp_auto_approved,
    })
}
