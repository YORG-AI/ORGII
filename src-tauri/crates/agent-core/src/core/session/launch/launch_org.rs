//! Org-member materialization for the agent run launch service.
//!
//! Handles spawning background tasks that create member sessions for an
//! Agent Org run, covering both Rust-native and CLI agent members.

use core_types::key_source::KeySource;

use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::definitions::orgs::{parse_cli_agent_org_reference, OrgDefinition};
use crate::session::persistence::{
    self as session_persistence, session_type, UnifiedSessionRecord,
};
use crate::session::IdeContext;
use crate::state::AgentAppState;

use super::launch_helpers::{
    flatten_org_members, member_runtime_account_id, member_runtime_key_source,
    member_runtime_model, member_runtime_native_harness_type, member_runtime_tier,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_agent_org_member_materialization(
    org_run_id: String,
    org: OrgDefinition,
    root_session_id: String,
    root_session_name: String,
    workspace_path: String,
    model: Option<String>,
    account_id: Option<String>,
    key_source: Option<String>,
    agent_exec_mode: Option<String>,
    native_harness_type: Option<String>,
    work_item_id: Option<String>,
    project_slug: Option<String>,
) {
    tokio::spawn(async move {
        if let Err(err) = materialize_org_member_sessions(
            &org_run_id,
            &org,
            &root_session_id,
            &root_session_name,
            &workspace_path,
            model,
            account_id,
            key_source,
            agent_exec_mode,
            native_harness_type,
            work_item_id,
            project_slug,
        )
        .await
        {
            tracing::warn!(
                run_id = %org_run_id,
                root_session_id = %root_session_id,
                error = %err,
                "[session_launch] failed to materialize Agent Org member sessions in background"
            );
            if let Err(mark_err) = AgentOrgRunStore::mark_failed(&org_run_id, &err) {
                tracing::warn!(
                    run_id = %org_run_id,
                    error = %mark_err,
                    "[session_launch] failed to mark Agent Org run failed after member materialization error"
                );
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn materialize_org_member_sessions(
    org_run_id: &str,
    org: &OrgDefinition,
    root_session_id: &str,
    _root_session_name: &str,
    workspace_path: &str,
    model: Option<String>,
    account_id: Option<String>,
    key_source: Option<String>,
    agent_exec_mode: Option<String>,
    native_harness_type: Option<String>,
    work_item_id: Option<String>,
    project_slug: Option<String>,
) -> Result<Vec<String>, String> {
    let flattened_members = flatten_org_members(&org.children);
    if flattened_members.is_empty() {
        return Ok(Vec::new());
    }

    let mut rust_members = Vec::new();
    let mut cli_members = Vec::new();
    for member in flattened_members {
        if parse_cli_agent_org_reference(&member.agent_id).is_some() {
            cli_members.push(member);
        } else {
            rust_members.push(member);
        }
    }

    let workspace_path = workspace_path.to_string();
    let root_session_id = root_session_id.to_string();
    let org_name = org.name.clone();
    let model = model.filter(|value| !value.trim().is_empty());
    let key_source = match key_source
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(raw) => KeySource::parse(raw).ok_or_else(|| format!("Unknown key_source: {raw:?}"))?,
        None => KeySource::default(),
    };
    let native_harness_type = native_harness_type
        .filter(|value| !value.trim().is_empty())
        .map(|raw| {
            core_types::providers::NativeHarnessType::parse(&raw)
                .ok_or_else(|| format!("Unknown native_harness_type: {raw:?}"))
                .map(|parsed| parsed.as_str().to_string())
        })
        .transpose()?;
    let agent_exec_mode = agent_exec_mode.filter(|mode| !mode.trim().is_empty());
    let org_run_id = org_run_id.to_string();
    let mut created_session_ids = Vec::with_capacity(rust_members.len() + cli_members.len());
    let mut created_rust_session_ids = Vec::new();
    let mut created_cli_session_ids = Vec::new();

    if !rust_members.is_empty() {
        let rust_workspace_path = workspace_path.clone();
        let rust_root_session_id = root_session_id.clone();
        let rust_org_name = org_name.clone();
        let rust_model = model.clone();
        let rust_account_id = account_id.clone();
        let rust_key_source = key_source.clone();
        let rust_agent_exec_mode = agent_exec_mode.clone();
        let rust_native_harness_type = native_harness_type.clone();
        let rust_work_item_id = work_item_id.clone();
        let rust_project_slug = project_slug.clone();
        let rust_org_run_id = org_run_id.clone();
        created_rust_session_ids = tokio::task::spawn_blocking(move || {
            let now = chrono::Utc::now().to_rfc3339();
            let mut created_session_ids: Vec<String> = Vec::with_capacity(rust_members.len());
            let has_workspace_path = !rust_workspace_path.is_empty();

            for member in rust_members {
                let prefix = crate::definitions::prefix_lookup::session_prefix_for_launch(
                    Some(&member.agent_id),
                    has_workspace_path,
                );
                let session_id = format!("{}{}", prefix, uuid::Uuid::new_v4());
                let member_config = member.runtime_config.as_ref();
                let member_model = member_runtime_model(member_config, &rust_model);
                let member_account_id = member_runtime_account_id(member_config, &rust_account_id);
                let member_key_source = member_runtime_key_source(member_config, &rust_key_source)
                    .map_err(|err| format!("invalid runtime config for member '{}': {}", member.name, err))?;
                let member_native_harness_type =
                    member_runtime_native_harness_type(member_config, &rust_native_harness_type)
                        .map_err(|err| format!("invalid runtime config for member '{}': {}", member.name, err))?;
                let session = UnifiedSessionRecord {
                    session_id: session_id.clone(),
                    name: format!("{} · {}", member.name, member.role),
                    status: crate::session::SessionStatus::Idle.as_str().to_string(),
                    model: member_model,
                    account_id: member_account_id,
                    workspace_path: Some(rust_workspace_path.clone()),
                    org_id: Some(project_management::projects::types::PERSONAL_ORG_ID.to_string()),
                    user_input: None,
                    total_tokens: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    session_type: session_type::ORG_MEMBER.to_string(),
                    work_item_id: rust_work_item_id.clone(),
                    agent_role: Some(member.role.clone()),
                    project_slug: rust_project_slug.clone(),
                    agent_definition_id: Some(member.agent_id.clone()),
                    org_member_id: Some(member.id.clone()),
                    parent_session_id: Some(rust_root_session_id.clone()),
                    key_source: member_key_source,
                    agent_exec_mode: rust_agent_exec_mode.clone(),
                    native_harness_type: member_native_harness_type,
                    ..Default::default()
                };
                if let Err(err) = session_persistence::upsert_session(&session) {
                    for created_session_id in &created_session_ids {
                        if let Err(cleanup_err) = session_persistence::delete_session(created_session_id)
                        {
                            tracing::warn!(
                                session_id = %created_session_id,
                                error = %cleanup_err,
                                "[session_launch] failed to clean up materialized Agent Org member session"
                            );
                        }
                    }
                    return Err(format!(
                        "failed to materialize Agent Org member '{}' for run '{}': {}",
                        member.name, rust_org_run_id, err
                    ));
                }
                created_session_ids.push(session_id);
            }

            tracing::info!(
                run_id = %rust_org_run_id,
                org_name = %rust_org_name,
                member_sessions = created_session_ids.len(),
                "[session_launch] materialized Rust Agent Org member sessions"
            );
            Ok(created_session_ids)
        })
        .await
        .map_err(|err| err.to_string())??;
        created_session_ids.extend(created_rust_session_ids.iter().cloned());
    }

    for member in cli_members {
        let cli_agent_type = parse_cli_agent_org_reference(&member.agent_id)
            .ok_or_else(|| format!("invalid CLI Agent Org reference: {}", member.agent_id))?
            .as_str()
            .to_string();
        let member_config = member.runtime_config.as_ref();
        let member_key_source = member_runtime_key_source(member_config, &key_source)?;
        let outcome = crate::foundation::session_bridge::launch_cli_agent(
            crate::foundation::session_bridge::CliLaunchParams {
                name: Some(format!("{} · {}", member.name, member.role)),
                cli_agent_type,
                model: member_runtime_model(member_config, &model),
                tier: member_runtime_tier(member_config),
                account_id: member_runtime_account_id(member_config, &account_id),
                repo_path: Some(workspace_path.clone()).filter(|path| !path.is_empty()),
                branch: None,
                hosted_token: None,
                isolate: false,
                worktree_path: None,
                background: true,
                key_source: Some(member_key_source.as_ref().to_string()),
                additional_directories: None,
                parent_session_id: Some(root_session_id.clone()),
                org_member_id: Some(member.id.clone()),
                org_id: project_management::projects::types::PERSONAL_ORG_ID.to_string(),
                project_id: None,
                project_name: None,
                project_slug: project_slug.clone(),
                work_item_id: work_item_id.clone(),
                agent_role: None,
                user_input: String::new(),
                ide_context: None,
                mode: agent_exec_mode.clone(),
                images: None,
            },
        )
        .await;
        match outcome {
            Ok(outcome) => {
                created_session_ids.push(outcome.session_id.clone());
                created_cli_session_ids.push(outcome.session_id);
            }
            Err(err) => {
                for session_id in &created_rust_session_ids {
                    if let Err(cleanup_err) = session_persistence::delete_session(session_id) {
                        tracing::warn!(
                            session_id = %session_id,
                            error = %cleanup_err,
                            "[session_launch] failed to clean up Rust Agent Org member session after CLI materialization failure"
                        );
                    }
                }
                for session_id in &created_cli_session_ids {
                    if let Err(cleanup_err) =
                        crate::foundation::session_bridge::delete_cli_session(session_id)
                    {
                        tracing::warn!(
                            session_id = %session_id,
                            error = %cleanup_err,
                            "[session_launch] failed to clean up CLI Agent Org member session"
                        );
                    }
                }
                return Err(format!(
                    "failed to materialize CLI Agent Org member '{}' for run '{}': {}",
                    member.name, org_run_id, err
                ));
            }
        }
    }

    tracing::info!(
        run_id = %org_run_id,
        org_name = %org_name,
        member_sessions = created_session_ids.len(),
        "[session_launch] materialized Agent Org member sessions"
    );
    Ok(created_session_ids)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn send_initial_turn(
    state: &AgentAppState,
    session_id: &str,
    content: String,
    model: Option<String>,
    account_id: Option<String>,
    workspace_root: String,
    native_harness_type: Option<core_types::providers::NativeHarnessType>,
    mode: Option<String>,
    images: Option<Vec<String>>,
    ide_context: Option<IdeContext>,
    agent_definition_id: Option<String>,
    sub_agent_ids: Vec<String>,
    intent_org_run_id: Option<String>,
    source: crate::foundation::session_bridge::TurnIntentBridgeSource,
) -> Result<(), String> {
    if sub_agent_ids.is_empty() {
        crate::state::commands::session::message::send_message_impl(
            state,
            session_id.to_string(),
            content,
            None,
            crate::state::commands::session::identity::IdentityOverrides {
                model,
                account_id,
                workspace_root: Some(workspace_root),
                native_harness_type,
            },
            mode,
            images,
            ide_context,
            false,
            false,
            None,
            None,
            None,
            intent_org_run_id,
            source,
        )
        .await?;
        return Ok(());
    }

    let model = model.ok_or_else(|| "model is required for sub-agent launch".to_string())?;
    let launch_spec = crate::init::launch_spec::AgentLaunchSpec::work_item_session(
        state,
        session_id,
        &model,
        account_id.as_deref().unwrap_or_default(),
        std::path::PathBuf::from(&workspace_root),
        agent_definition_id.as_deref(),
        &sub_agent_ids,
    )
    .await?;
    crate::init::init_session(state, launch_spec).await?;

    crate::state::commands::session::message::send_message_impl(
        state,
        session_id.to_string(),
        content,
        None,
        crate::state::commands::session::identity::IdentityOverrides {
            model: Some(model),
            account_id,
            workspace_root: Some(workspace_root),
            native_harness_type,
        },
        mode,
        images,
        ide_context,
        false,
        false,
        None,
        None,
        None,
        intent_org_run_id,
        crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
    )
    .await?;
    Ok(())
}

pub(super) async fn cleanup_session_after_org_run_create_failure(session_id: String) {
    let cleanup = tokio::task::spawn_blocking(move || {
        crate::session::persistence::delete_session(&session_id)
    })
    .await;

    match cleanup {
        Ok(Ok(())) => {}
        Ok(Err(err)) => tracing::warn!(
            error = %err,
            "[session_launch] failed to clean up session after Agent Org run creation failure"
        ),
        Err(err) => tracing::warn!(
            error = %err,
            "[session_launch] failed to join cleanup after Agent Org run creation failure"
        ),
    }
}
