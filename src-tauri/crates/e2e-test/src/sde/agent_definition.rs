//! Agent definition runtime contract scenarios.
//!
//! These scenarios intentionally assert the session-scoped effective-tools
//! endpoint. That endpoint reads the live `SessionRuntime` and applies the
//! same policy-filtered tool surface used when building the prompt, so it is
//! the single source of truth for runtime tool availability.

use agent_core::definitions::builtin::ADE_MANAGER_ID;
use agent_core::definitions::{OS_AGENT_ID, SDE_AGENT_ID};
use agent_core::tools::names::{
    ASK_USER_QUESTIONS, CONTROL_BROWSER_WITH_PLAYWRIGHT, CONTROL_DESKTOP_WITH_PEEKABOO,
    CONTROL_ORGII, EDIT_FILE, MANAGE_AGENT_DEF, MANAGE_SESSION, READ_FILE, RUN_SHELL,
};

use super::tmp_workspace_path;
use crate::config::Config;
use crate::harness;

const MANAGEMENT_TOOLS: [&str; 2] = [MANAGE_SESSION, MANAGE_AGENT_DEF];

pub async fn agent_definition_sde_endpoint_rejects_missing_explicit_definition(
    cfg: &Config,
) -> bool {
    let session_id = format!("{}-agent-def-missing-definition", cfg.session_prefix);
    let workspace = tmp_workspace_path("agent-def-missing-definition");
    let result = harness::send_sde_message_with_opts(
        cfg,
        "This should fail before any model call.",
        &session_id,
        "build",
        &workspace,
        &harness::SdeMessageOpts {
            agent_definition_id: Some("custom:missing-agent-definition-e2e"),
            no_cleanup: true,
            ..Default::default()
        },
    )
    .await;
    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    let error = result
        .as_ref()
        .err()
        .map(String::as_str)
        .unwrap_or_default();
    harness::print_result(
        "SDE endpoint rejects missing explicit agent_definition_id",
        error,
        &[
            ("missing explicit definition is rejected", result.is_err()),
            (
                "error names agent_definition_id resolution",
                error.contains("Failed to resolve agent_definition_id"),
            ),
            (
                "error includes requested definition id",
                error.contains("custom:missing-agent-definition-e2e"),
            ),
        ],
    )
}

pub async fn agent_definition_management_tools_follow_effective_tools_source(cfg: &Config) -> bool {
    harness::reset_agent_config(cfg, SDE_AGENT_ID).await;
    harness::reset_agent_config(cfg, OS_AGENT_ID).await;

    let sde_session_id = format!("{}-agent-def-sde-management-boundary", cfg.session_prefix);
    let os_session_id = format!("{}-agent-def-os-management-boundary", cfg.session_prefix);
    let sde_project = tmp_workspace_path("agent-def-sde-management-boundary");
    let os_project = tmp_workspace_path("agent-def-os-management-boundary");
    let sde_launch = harness::launch_seed_only_with_opts(
        cfg,
        &sde_project,
        &[],
        &harness::LaunchSeedOnlyOpts {
            session_id_hint: Some(&sde_session_id),
            agent_definition_id: Some(SDE_AGENT_ID),
            agent_exec_mode: Some("build"),
            initialize_runtime: true,
        },
    )
    .await;
    let sde_runtime_session_id = sde_launch
        .as_ref()
        .ok()
        .and_then(|launch| launch.session_id.as_deref())
        .unwrap_or(&sde_session_id);
    let sde_effective_tools =
        harness::fetch_effective_tools(cfg, sde_runtime_session_id, "build").await;

    let os_launch = harness::launch_seed_only_with_opts(
        cfg,
        &os_project,
        &[],
        &harness::LaunchSeedOnlyOpts {
            session_id_hint: Some(&os_session_id),
            agent_definition_id: Some(OS_AGENT_ID),
            agent_exec_mode: Some("build"),
            initialize_runtime: true,
        },
    )
    .await;
    let os_runtime_session_id = os_launch
        .as_ref()
        .ok()
        .and_then(|launch| launch.session_id.as_deref())
        .unwrap_or(&os_session_id);
    let os_effective_tools =
        harness::fetch_effective_tools(cfg, os_runtime_session_id, "build").await;

    let _ = harness::cleanup_sde_session(cfg, sde_runtime_session_id).await;
    let _ = harness::cleanup_sde_session(cfg, os_runtime_session_id).await;
    harness::reset_agent_config(cfg, SDE_AGENT_ID).await;
    harness::reset_agent_config(cfg, OS_AGENT_ID).await;

    let sde_prompt_tools = sde_effective_tools
        .as_ref()
        .map(|tools| tools.prompt_tool_names.as_slice())
        .unwrap_or(&[]);
    let os_prompt_tools = os_effective_tools
        .as_ref()
        .map(|tools| tools.prompt_tool_names.as_slice())
        .unwrap_or(&[]);

    let sde_registered_tools = sde_effective_tools
        .as_ref()
        .map(|tools| tools.registered_tool_names.as_slice())
        .unwrap_or(&[]);
    let os_registered_tools = os_effective_tools
        .as_ref()
        .map(|tools| tools.registered_tool_names.as_slice())
        .unwrap_or(&[]);

    let sde_prompt_excludes_management = MANAGEMENT_TOOLS
        .iter()
        .all(|tool_name| !contains_tool(sde_prompt_tools, tool_name));
    let sde_registry_excludes_management = MANAGEMENT_TOOLS
        .iter()
        .all(|tool_name| !contains_tool(sde_registered_tools, tool_name));
    let os_prompt_includes_management = MANAGEMENT_TOOLS
        .iter()
        .all(|tool_name| contains_tool(os_prompt_tools, tool_name));
    let os_registry_includes_management = MANAGEMENT_TOOLS
        .iter()
        .all(|tool_name| contains_tool(os_registered_tools, tool_name));
    let os_management_metadata_is_canonical = os_effective_tools.as_ref().is_ok_and(|tools| {
        MANAGEMENT_TOOLS.iter().all(|tool_name| {
            required_capability_for(&tools.prompt_tools, tool_name) == Some("management")
        })
    });

    let sde_mode = sde_effective_tools
        .as_ref()
        .map(|tools| tools.agent_exec_mode.as_str())
        .unwrap_or_default();
    let os_mode = os_effective_tools
        .as_ref()
        .map(|tools| tools.agent_exec_mode.as_str())
        .unwrap_or_default();

    harness::print_result(
        "Agent definition management tools follow effective-tools source",
        &format!(
            "sde_prompt={:?}\nos_prompt={:?}",
            management_presence(sde_prompt_tools),
            management_presence(os_prompt_tools)
        ),
        &[
            (
                "SDE seed-only launch initialized runtime",
                sde_launch.as_ref().is_ok_and(|launch| launch.ok),
            ),
            (
                "OS seed-only launch initialized runtime",
                os_launch.as_ref().is_ok_and(|launch| launch.ok),
            ),
            (
                "SDE effective-tools HTTP succeeded",
                sde_effective_tools.is_ok(),
            ),
            (
                "OS effective-tools HTTP succeeded",
                os_effective_tools.is_ok(),
            ),
            ("SDE effective mode is build", sde_mode == "build"),
            ("OS effective mode is build", os_mode == "build"),
            (
                "SDE prompt excludes management tools",
                sde_prompt_excludes_management,
            ),
            (
                "SDE registry excludes management tools",
                sde_registry_excludes_management,
            ),
            (
                "OS prompt includes management tools",
                os_prompt_includes_management,
            ),
            (
                "OS registry includes management tools",
                os_registry_includes_management,
            ),
            (
                "OS management prompt metadata carries canonical management capability",
                os_management_metadata_is_canonical,
            ),
        ],
    )
}

pub async fn ade_manager_has_gui_control_tools(cfg: &Config) -> bool {
    harness::reset_agent_config(cfg, ADE_MANAGER_ID).await;

    let session_id = format!("{}-ade-manager-tools", cfg.session_prefix);
    let project = tmp_workspace_path("ade-manager-tools");
    let launch = harness::launch_seed_only_with_opts(
        cfg,
        &project,
        &[],
        &harness::LaunchSeedOnlyOpts {
            session_id_hint: Some(&session_id),
            agent_definition_id: Some(ADE_MANAGER_ID),
            agent_exec_mode: Some("build"),
            initialize_runtime: true,
        },
    )
    .await;
    let runtime_session_id = launch
        .as_ref()
        .ok()
        .and_then(|launch| launch.session_id.as_deref())
        .unwrap_or(&session_id);
    let effective_tools = harness::fetch_effective_tools(cfg, runtime_session_id, "build").await;

    let _ = harness::cleanup_sde_session(cfg, runtime_session_id).await;
    harness::reset_agent_config(cfg, ADE_MANAGER_ID).await;

    let prompt_tools = effective_tools
        .as_ref()
        .map(|tools| tools.prompt_tool_names.as_slice())
        .unwrap_or(&[]);
    let registered_tools = effective_tools
        .as_ref()
        .map(|tools| tools.registered_tool_names.as_slice())
        .unwrap_or(&[]);
    let mode = effective_tools
        .as_ref()
        .map(|tools| tools.agent_exec_mode.as_str())
        .unwrap_or_default();

    harness::print_result(
        "ADE Manager has GUI control tools (control_orgii, spotlight) and excludes shell/desktop",
        &format!(
            "session={} prompt_tools={:?}",
            runtime_session_id, prompt_tools
        ),
        &[
            (
                "ADE Manager seed-only launch initialized runtime",
                launch.as_ref().is_ok_and(|launch| launch.ok),
            ),
            ("Effective-tools HTTP succeeded", effective_tools.is_ok()),
            ("Effective mode is build", mode == "build"),
            (
                "Prompt includes GUI action bridge tool",
                contains_tool(prompt_tools, CONTROL_ORGII),
            ),
            (
                "Prompt includes session bridge tool",
                contains_tool(prompt_tools, MANAGE_SESSION),
            ),
            (
                "Prompt includes ask-user tool",
                contains_tool(prompt_tools, ASK_USER_QUESTIONS),
            ),
            (
                "Prompt includes read_file",
                contains_tool(prompt_tools, READ_FILE),
            ),
            (
                "Prompt excludes shell",
                !contains_tool(prompt_tools, RUN_SHELL),
            ),
            (
                "Prompt excludes edit_file",
                !contains_tool(prompt_tools, EDIT_FILE),
            ),
            (
                "Prompt excludes desktop automation",
                !contains_tool(prompt_tools, CONTROL_DESKTOP_WITH_PEEKABOO),
            ),
            (
                "Prompt excludes browser automation",
                !contains_tool(prompt_tools, CONTROL_BROWSER_WITH_PLAYWRIGHT),
            ),
            (
                "Registry includes same GUI action bridge tool",
                contains_tool(registered_tools, CONTROL_ORGII),
            ),
            (
                "Registry includes same session bridge tool",
                contains_tool(registered_tools, MANAGE_SESSION),
            ),
            (
                "Registry excludes shell",
                !contains_tool(registered_tools, RUN_SHELL),
            ),
        ],
    )
}

fn required_capability_for<'a>(tools: &'a [serde_json::Value], tool_name: &str) -> Option<&'a str> {
    tools.iter().find_map(|tool| {
        if tool.get("name").and_then(|value| value.as_str()) == Some(tool_name) {
            tool.get("requiredCapability")
                .and_then(|value| value.as_str())
        } else {
            None
        }
    })
}

fn contains_tool(tools: &[String], tool_name: &str) -> bool {
    tools.iter().any(|name| name == tool_name)
}

fn management_presence(tools: &[String]) -> Vec<(&'static str, bool)> {
    MANAGEMENT_TOOLS
        .iter()
        .map(|tool_name| (*tool_name, contains_tool(tools, tool_name)))
        .collect()
}
