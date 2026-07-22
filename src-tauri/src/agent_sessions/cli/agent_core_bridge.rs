//! Wire-side adapter for `agent_core::foundation::session_bridge::launch_cli_agent`.
//!
//! Rebuilds the full `CreateCodeSessionParams` from the lean `CliLaunchParams`
//! projection that agent_core hands in, calls `cli_agent_create` to
//! materialize the session row, and then fires `cli_agent_run` to spawn the
//! background runner. Mirrors the previous `state::commands::session::launch::
//! launch_cli_agent` body, just with the back-edge inverted: agent_core no
//! longer imports `agent_sessions::cli::*`; the wire crate registers this
//! adapter at startup instead.

use std::pin::Pin;

use agent_core::foundation::session_bridge::{
    self, CliLaunchOutcome, CliLaunchParams, CliPlanApprovalResponseParams, CliToolsSnapshot,
};
use agent_core::interaction::plan_approval::{self, PlanResolution};
use agent_core::session::AgentExecMode;
use agent_core::tools::names as tool_names;

use super::commands::{cli_agent_create, cli_agent_message, cli_agent_run};
use super::persistence::{self, CreateCodeSessionParams};

fn run(
    params: CliLaunchParams,
) -> Pin<Box<dyn std::future::Future<Output = Result<CliLaunchOutcome, String>> + Send>> {
    Box::pin(async move {
        let create_params = CreateCodeSessionParams {
            name: params.name,
            flow: None,
            runner: None,
            cli_agent_type: params.cli_agent_type,
            model: params.model,
            tier: params.tier,
            account_id: params.account_id,
            repo_path: params.repo_path,
            branch: params.branch,
            proxy_token: None,
            proxy_url: None,
            hosted_token: params.hosted_token,
            proxy_session_id: None,
            isolate: if params.isolate { Some(true) } else { None },
            worktree_path: params.worktree_path,
            background: if params.background { Some(true) } else { None },
            key_source: params.key_source,
            additional_directories: params.additional_directories,
            parent_session_id: params.parent_session_id,
            org_member_id: params.org_member_id,
            org_id: Some(params.org_id),
            project_id: params.project_id,
            project_name: params.project_name,
            project_slug: params.project_slug,
            work_item_id: params.work_item_id,
            agent_role: params.agent_role,
        };

        let session = cli_agent_create(create_params).await?;
        let session_id = session.session_id.clone();
        let created_at = session.created_at.clone();

        if !params.user_input.trim().is_empty() {
            cli_agent_run(
                session_id.clone(),
                params.user_input,
                None,
                params.ide_context,
                params.mode,
                params.images,
            )
            .await
            .map_err(|err| {
                tracing::warn!(
                    "[cli::agent_core_bridge] cli_agent_run failed for {}: {}",
                    session_id,
                    err
                );
                err
            })?;
        }

        Ok(CliLaunchOutcome {
            session_id,
            created_at,
        })
    })
}

fn tools_snapshot(session_id: &str) -> Result<Option<CliToolsSnapshot>, String> {
    let session = persistence::get_session(session_id)
        .map_err(|err| format!("DB error loading CLI session {session_id}: {err}"))?;
    let Some(session) = session else {
        return Ok(None);
    };

    let mode = session
        .agent_exec_mode
        .as_deref()
        .and_then(AgentExecMode::parse)
        .unwrap_or(AgentExecMode::Build);
    let mut registered_tool_names = cli_registered_tool_names();
    registered_tool_names.sort();
    registered_tool_names.dedup();

    let deny = mode
        .policy_layer()
        .map(|layer| layer.deny)
        .unwrap_or_default();
    let mut prompt_tool_names: Vec<String> = registered_tool_names
        .iter()
        .filter(|tool_name| !deny.iter().any(|denied| denied == *tool_name))
        .cloned()
        .collect();
    prompt_tool_names.sort();
    prompt_tool_names.dedup();

    Ok(Some(CliToolsSnapshot {
        session_id: session.session_id,
        cli_agent_type: session.cli_agent_type.unwrap_or_default(),
        agent_exec_mode: mode.as_str().to_string(),
        registered_tool_names,
        prompt_tool_names,
    }))
}

fn respond_plan_approval(
    params: CliPlanApprovalResponseParams,
) -> Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
        let resolution =
            match params.choice.as_str() {
                "approve" => PlanResolution::Approved { edited: None },
                "approve_with_edits" => PlanResolution::Approved {
                    edited: Some(params.edited_content.ok_or_else(|| {
                        "approve_with_edits requires `edited_content`".to_string()
                    })?),
                },
                "reject" => PlanResolution::Rejected,
                other => return Err(format!("Invalid plan-approval choice: {other}")),
            };
        let rejected = params.choice == "reject";
        let edited = params.choice == "approve_with_edits";

        let snapshot = plan_approval::resolve_pending(&params.session_id, resolution, None)
            .await
            .ok_or_else(|| {
                format!(
                    "No pending CLI plan approval for session {}",
                    params.session_id
                )
            })?;

        let restore_mode = AgentExecMode::Build;
        persistence::update_agent_exec_mode(&params.session_id, restore_mode.as_str())
            .map_err(|err| format!("Failed to persist restored CLI agent exec mode: {err}"))?;

        agent_core::bus::broadcast_event(
            "agent:exit_plan_mode",
            serde_json::json!({
                "sessionId": &params.session_id,
                "planPath": &snapshot.plan_path,
                "planTitle": &snapshot.plan_title,
                "toolCallId": &snapshot.tool_call_id,
                "planId": &snapshot.plan_id,
                "planRevisionId": &snapshot.plan_revision_id,
                "originToolCallId": &snapshot.origin_tool_call_id,
                "restoreMode": restore_mode.as_str(),
                "edited": edited,
                "rejected": rejected,
            }),
        );

        if rejected {
            return Ok(());
        }

        let plan_body = std::fs::read_to_string(&snapshot.plan_path)
            .map_err(|err| format!("Failed to read approved CLI plan: {err}"))?;
        let synthetic_content = format!(
            "[Plan approved{edited_marker}] Implement the approved plan now.\n\n\
             Execute the approved plan directly. Use the available coding tools to make the requested changes. \
             Do not enter plan mode again and do not create another plan.\n\n\
             ## Approved plan\n\n{plan_body}",
            edited_marker = if edited { " (edited)" } else { "" },
        );

        cli_agent_message(
            params.session_id,
            synthetic_content,
            params.model,
            params.account_id,
            None,
            Some(AgentExecMode::Build.as_str().to_string()),
            None,
            None,
            None,
        )
        .await
        .map(|_| ())
    })
}

fn cli_registered_tool_names() -> Vec<String> {
    vec![
        tool_names::READ_FILE,
        tool_names::LIST_DIR,
        tool_names::CODE_SEARCH,
        tool_names::WEB_SEARCH,
        tool_names::WEB_FETCH,
        tool_names::CREATE_PLAN,
        tool_names::EDIT_FILE,
        tool_names::DELETE_FILE,
        tool_names::RUN_SHELL,
        tool_names::AWAIT_OUTPUT,
        tool_names::MANAGE_TODO,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Register CLI adapters into agent_core's session bridge slots.
pub fn register() {
    session_bridge::register_launch_cli_agent(run);
    session_bridge::register_delete_cli_session(|session_id| {
        persistence::delete_session(session_id).map_err(|err| format!("DB error: {err}"))
    });
    session_bridge::register_get_cli_tools_snapshot(tools_snapshot);
    session_bridge::register_respond_cli_plan_approval(respond_plan_approval);
    session_bridge::register_clear_cli_resume_state(persistence::clear_cli_resume_state);
}
