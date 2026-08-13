//! Shared tool-related Tauri commands.
//!
//! These are agent-type-agnostic commands for tool metadata, key checking,
//! and frontend registry initialization.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::mcp::bridge::build_mcp_tool_name;
use crate::mcp::commands::McpState;
use crate::state::commands::session::message::resolve_agent_mode;
use crate::state::AgentAppState;
use crate::tools::builtin_tools;
use crate::tools::ui_metadata::{
    AgentKind, ChatBlock, SimulatorApp, ToolDisplayBehavior, ToolInfo,
};

fn builtin_tool_info() -> Vec<ToolInfo> {
    builtin_tools::builtin_tool_entries("builtin".to_string())
}

fn builtin_tool_info_by_name() -> std::collections::HashMap<String, ToolInfo> {
    builtin_tool_info()
        .into_iter()
        .map(|tool| (tool.name.clone(), tool))
        .collect()
}

/// Check whether credentials are available for a given model.
#[tauri::command]
pub async fn agent_check_keys(model: String) -> Result<serde_json::Value, String> {
    match crate::providers::check_credentials_available(&model) {
        Ok((spec, _provider)) => Ok(serde_json::json!({
            "found": true,
            "provider": spec.display_name,
            "providerName": spec.name,
        })),
        Err(err) => {
            let guessed = crate::providers::registry::guess_provider_by_model(&model);
            Ok(serde_json::json!({
                "found": false,
                "provider": guessed.map(|spec| spec.display_name),
                "providerName": guessed.map(|spec| spec.name),
                "error": err.to_string(),
            }))
        }
    }
}

/// Build the static portion of the unified tool list (built-in only).
///
/// Kept sync and state-free so `init_tool_registry`, `list_all_tools`, and
/// tests can all share it. MCP tools are not included here because they're
/// a runtime-only projection of whichever servers are currently connected —
/// see [`append_mcp_tools`].
fn static_tool_list() -> Vec<ToolInfo> {
    builtin_tool_info()
}

/// Append one [`ToolInfo`] per MCP tool advertised by any currently-connected
/// server to `tools`.
///
/// Tool `name` uses the bridge's fully-qualified format (`mcp__<server>__<tool>`)
/// so it round-trips through `excluded_tools` / `register_mcp_tools`. The MCP
/// bridge is agent-type-agnostic, so `supported_agents` is `ALL`.
///
/// Only **connected** servers contribute tools. Servers that are still
/// connecting, failed, or are explicitly disabled at the server level
/// (`disabled_mcp_servers`) are silently skipped — the frontend already gets
/// separate visibility into server health via `mcp_list_servers`.
///
/// This function does not trigger a connect; it only reads the current
/// snapshot. First call after app boot may therefore see fewer tools than
/// subsequent calls, which is intentional: we don't want the tools settings
/// UI to block on `npx` cold-starts.
async fn append_mcp_tools(mcp: &McpState, tools: &mut Vec<ToolInfo>) {
    for (server_name, def) in mcp.manager.all_tools().await {
        tools.push(ToolInfo {
            name: build_mcp_tool_name(&server_name, &def.name),
            description: def.description,
            description_detail: None,
            category: "mcp".to_string(),
            source: "mcp".to_string(),
            supported_agents: AgentKind::ALL.to_vec(),
            icon_id: String::new(),
            action_icons: std::collections::HashMap::new(),
            status_icons: std::collections::HashMap::new(),
            simulator_app: SimulatorApp::default(),
            app_subtool: Default::default(),
            chat_block: ChatBlock::Fallback,
            display_behavior: ToolDisplayBehavior::WaitForResult,
            human_tool_key: None,
            hidden: false,
            label_running: String::new(),
            label_done: String::new(),
            label_failed: String::new(),
            status_labels: std::collections::HashMap::new(),
            actions: vec![],
            required_capability: String::new(),
        });
    }
}

/// List all available tools: built-in + MCP (from connected servers).
///
/// MCP tools are identified by `source == "mcp"` and `category == "mcp"`; their
/// `name` is the fully-qualified `mcp__<server>__<tool>` so that toggling them
/// off writes the correct string into `excluded_tools` (which
/// `register_mcp_tools` already honors).
#[tauri::command]
pub async fn list_all_tools(mcp: tauri::State<'_, McpState>) -> Result<Vec<ToolInfo>, String> {
    let mut tools = static_tool_list();
    append_mcp_tools(&mcp, &mut tools).await;
    Ok(tools)
}

/// Response type for `init_tool_registry` command.
#[derive(Debug, serde::Serialize)]
pub struct ToolRegistryData {
    /// Full tool info list (built-in + MCP).
    pub tools: Vec<ToolInfo>,
    /// CLI alias map: alias → (storage, ui, simulator_app, app_subtool, chat_block).
    pub cli_aliases: std::collections::HashMap<String, (String, String, String, String, String)>,
}

/// Unified tool registry initialization command.
///
/// Single IPC entry that returns everything the frontend needs to
/// bootstrap its tool registry:
/// - `tools`: full tool info list (built-in + MCP). Each `ToolInfo`
///   already carries `simulator_app`, so the frontend doesn't need a
///   separate name → simulator-dock map.
/// - `cli_aliases`: CLI agent alias map
///   (alias → (storage, ui, simulator_app, app_subtool, chat_block)).
#[tauri::command]
pub async fn init_tool_registry(
    mcp: tauri::State<'_, McpState>,
) -> Result<ToolRegistryData, String> {
    let mut tools = static_tool_list();
    append_mcp_tools(&mcp, &mut tools).await;
    let cli_aliases = core_types::cli_alias::get_all_cli_aliases();
    Ok(ToolRegistryData { tools, cli_aliases })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveToolsRequest {
    pub session_id: String,
    #[serde(default)]
    pub agent_exec_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveToolsResponse {
    pub session_id: String,
    pub agent_exec_mode: String,
    pub registered_tool_names: Vec<String>,
    pub prompt_tool_names: Vec<String>,
    pub deferred_tool_names: Vec<String>,
    pub prompt_tools: Vec<ToolInfo>,
}

fn runtime_tool_info(runtime: &crate::state::SessionRuntime) -> Vec<ToolInfo> {
    let canonical_tools = builtin_tool_info_by_name();
    runtime
        .tool_registry
        .tool_info()
        .into_iter()
        .map(|(name, description, category)| {
            let actions = runtime.tool_registry.tool_actions(&name);
            let Some(canonical) = canonical_tools.get(&name) else {
                return ToolInfo {
                    name,
                    description,
                    description_detail: None,
                    category,
                    source: "runtime".to_string(),
                    supported_agents: AgentKind::ALL.to_vec(),
                    icon_id: String::new(),
                    action_icons: std::collections::HashMap::new(),
                    status_icons: std::collections::HashMap::new(),
                    simulator_app: SimulatorApp::default(),
                    app_subtool: Default::default(),
                    chat_block: ChatBlock::Fallback,
                    display_behavior: ToolDisplayBehavior::WaitForResult,
                    human_tool_key: None,
                    hidden: false,
                    label_running: String::new(),
                    label_done: String::new(),
                    label_failed: String::new(),
                    status_labels: std::collections::HashMap::new(),
                    actions,
                    required_capability: String::new(),
                };
            };

            let mut tool_info = canonical.clone();
            tool_info.actions = actions;
            tool_info
        })
        .collect()
}

pub async fn list_effective_tools_for_session(
    state: &AgentAppState,
    request: EffectiveToolsRequest,
) -> Result<EffectiveToolsResponse, String> {
    let session = state
        .get_session(&request.session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", request.session_id))?;
    let runtime = session
        .runtime
        .read()
        .await
        .clone()
        .ok_or_else(|| format!("session runtime not initialized: {}", request.session_id))?;

    let session_record =
        crate::session::persistence::get_session(&request.session_id).map_err(|err| {
            format!(
                "failed to load session record {}: {err}",
                request.session_id
            )
        })?;
    let mode_source = request.agent_exec_mode.as_deref().or_else(|| {
        session_record
            .as_ref()
            .and_then(|record| record.agent_exec_mode.as_deref())
    });
    let agent_exec_mode = resolve_agent_mode(mode_source)?;
    let effective_policy = runtime.policy.with_exec_mode(agent_exec_mode);

    let mut registered_tool_names = runtime.tool_registry.tool_names();
    registered_tool_names.sort();
    let prompt_tool_names = runtime.tool_registry.prompt_tool_names(&effective_policy);
    let deferred_tool_names = runtime.tool_registry.deferred_tool_names();
    let prompt_tool_name_set: HashSet<&str> =
        prompt_tool_names.iter().map(String::as_str).collect();
    let prompt_tools = runtime_tool_info(&runtime)
        .into_iter()
        .filter(|tool| prompt_tool_name_set.contains(tool.name.as_str()))
        .collect();

    Ok(EffectiveToolsResponse {
        session_id: request.session_id,
        agent_exec_mode: agent_exec_mode.as_str().to_string(),
        registered_tool_names,
        prompt_tool_names,
        deferred_tool_names,
        prompt_tools,
    })
}

/// List session-scoped effective tools from the same policy-filtered schema surface used by turns.
#[tauri::command]
pub async fn agent_list_effective_tools_for_session(
    state: tauri::State<'_, AgentAppState>,
    request: EffectiveToolsRequest,
) -> Result<EffectiveToolsResponse, String> {
    list_effective_tools_for_session(&state, request).await
}

/// List tools from any active agent session runtime.
///
/// Falls back to the static built-in list if no sessions are initialized yet.
#[tauri::command]
pub async fn agent_list_tools(
    state: tauri::State<'_, AgentAppState>,
) -> Result<Vec<ToolInfo>, String> {
    let active_runtime = {
        let sessions = state.sessions.lock().await;
        let mut found = None;
        for session in sessions.values() {
            found = session.get_runtime().await;
            if found.is_some() {
                break;
            }
        }
        found
    };

    if let Some(runtime) = active_runtime {
        return Ok(runtime_tool_info(&runtime));
    }
    Ok(builtin_tool_info())
}
