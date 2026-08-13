//! Unified session launch command.
//!
//! This file only adapts the frontend Tauri DTO into either the canonical
//! Rust-agent launch service or the CLI launch bridge.

use key_vault::{AuthMethod, ModelType};
use project_management::projects::types::{
    EnqueueWorkItemRunRequest, WorkItemRunTarget, WorkItemRunTargetSnapshot, WorkItemRunTrigger,
    WorkspaceExecutionMode, PERSONAL_ORG_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::definitions::orgs::{AgentOrgsStore, OrgMemberLaunchOverride};
use crate::session::launch::{
    launch_rust_agent_run, AgentRunLaunchRequest, AgentRunTarget, LaunchOrgContext,
    LaunchProvenance, LaunchResourceSelection, WorkspaceLaunchTarget,
};
use crate::session::IdeContext;
use crate::state::AgentAppState;

const MAX_AUTO_NAME_LEN: usize = 80;

/// Wire value for `SessionLaunchParams.category` selecting the Rust-native
/// agent stack (OS / SDE / Custom / Gateway). Frontend mirror lives in
/// `src/api/tauri/session/dispatchTypes.ts` (`DispatchCategory`).
pub const SESSION_CATEGORY_RUST_AGENT: &str = "rust_agent";

/// Wire value for `SessionLaunchParams.category` selecting an external CLI
/// process (Cursor CLI, Claude Code, Codex, Gemini, …).
pub const SESSION_CATEGORY_CLI_AGENT: &str = "cli_agent";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunchParams {
    /// "rust_agent" or "cli_agent"
    pub category: String,
    /// User message content
    pub content: String,
    /// Project / repo path
    pub workspace_path: Option<String>,

    // Model / Key / provider override
    pub key_source: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub native_harness_type: Option<String>,

    // CLI-specific
    /// CLI agent type (wire name: `platform`)
    pub platform: Option<String>,
    pub branch: Option<String>,
    pub worktree_base_ref: Option<String>,

    // Market-specific
    pub hosted_token: Option<String>,
    pub tier: Option<String>,

    // Optional
    pub name: Option<String>,
    #[serde(default)]
    pub background: bool,
    pub images: Option<Vec<String>>,
    pub ide_context: Option<IdeContext>,
    pub agent_definition_id: Option<String>,
    pub agent_org_id: Option<String>,
    #[serde(default)]
    pub agent_org_member_overrides: HashMap<String, OrgMemberLaunchOverride>,
    #[serde(default)]
    pub apply_agent_org_member_overrides_for_future: bool,
    #[serde(default)]
    pub isolate: bool,
    pub mode: Option<String>,
    /// Product mode (`orgtrack/v1` §5.2): `build | plan | ask | project`.
    /// Distinct from `mode` (the runtime exec mode) — the launch-from-
    /// work/routine resolver overrides this with `project` server-side.
    #[serde(default)]
    pub product_mode: Option<String>,

    // Project/collaboration org + work-item fields
    pub org_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    pub worktree_path: Option<String>,
    pub project_slug: Option<String>,
    pub parent_session_id: Option<String>,

    /// Internal durable Work Item Run identity. Ordinary frontend launches
    /// omit this; `session_launch_impl` creates and claims the Run before
    /// materializing the Session. Recovery deliveries set it explicitly so
    /// they never enqueue a second episode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durable_run_id: Option<String>,

    /// Extra workspace folders granted at launch time (multi-root IDE
    /// workspaces). Each path is injected into the session's
    /// `SessionWorkspace.additional_directories` with
    /// [`DirectorySource::Session`] scope before the first turn runs,
    /// so file tools honouring `effective_roots()` see them from turn 1.
    ///
    /// Empty for single-repo launches. Absolute, canonicalised paths
    /// are expected; the frontend is responsible for filtering out the
    /// primary folder (which is passed via `workspace_path`).
    #[serde(default, alias = "additional_directories")]
    pub additional_directories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunchResult {
    pub session_id: String,
    pub category: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub user_input: String,
    pub workspace_path: Option<String>,
    pub branch: Option<String>,
    #[serde(default)]
    pub background: bool,
    pub model: Option<String>,
    pub cli_agent_type: Option<String>,
    pub account_id: Option<String>,
    pub agent_org_id: Option<String>,
    pub agent_org_run_id: Option<String>,
    pub org_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    pub product_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub base_ref: Option<String>,
}

pub async fn session_launch_impl(
    state: &AgentAppState,
    org_store: Option<&AgentOrgsStore>,
    mut params: SessionLaunchParams,
) -> Result<SessionLaunchResult, String> {
    validate_workspace_launch_fields(
        params.isolate,
        params.workspace_path.as_deref(),
        params.worktree_path.as_deref(),
        params.worktree_base_ref.as_deref(),
    )?;
    let auto_name = derive_name(params.name.as_deref(), &params.content);

    if params.work_item_id.is_some() && params.durable_run_id.is_none() {
        let work_item_id = params.work_item_id.clone().unwrap_or_default();
        let org_id = params
            .org_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| PERSONAL_ORG_ID.to_string());
        let mut target_snapshot =
            WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
                account_id: params.account_id.clone(),
                model_id: params.model.clone(),
            });
        target_snapshot.workspace_path = params.workspace_path.clone();
        target_snapshot.workspace_mode = Some(
            if params.isolate
                || params
                    .worktree_path
                    .as_deref()
                    .is_some_and(|path| !path.trim().is_empty())
            {
                WorkspaceExecutionMode::Worktree
            } else {
                WorkspaceExecutionMode::LocalWorkspace
            },
        );
        target_snapshot.agent_definition_id = params.agent_definition_id.clone();
        target_snapshot.agent_org_id = params.agent_org_id.clone();
        let launch_snapshot = serde_json::to_value(&params)
            .map_err(|err| format!("manual Work Item launch snapshot: {err}"))?;
        let run = project_management::work_run_service::enqueue_for_inline_dispatch(
            EnqueueWorkItemRunRequest {
                project_slug: params.project_slug.clone(),
                org_id,
                work_item_id,
                trigger: WorkItemRunTrigger::Manual,
                target_snapshot,
                input: serde_json::json!({
                    "content": params.content.clone(),
                    "displayText": params.content.clone(),
                    "sessionLaunchParams": launch_snapshot,
                }),
                idempotency_key: format!("manual-launch:{}", uuid::Uuid::new_v4().simple()),
                max_attempts: 3,
                parent_run_id: None,
            },
        )?;
        let worker_id = format!("inline_session_{}", uuid::Uuid::new_v4().simple());
        let lease = project_management::work_run_service::claim_dispatch_for_run(
            &run.id, &worker_id, 30_000,
        )?;
        params.durable_run_id = Some(run.id);

        let result = match params.category.as_str() {
            SESSION_CATEGORY_RUST_AGENT => {
                launch_rust_agent(state, org_store, params, auto_name).await
            }
            SESSION_CATEGORY_CLI_AGENT => launch_cli_agent(params, auto_name).await,
            other => Err(format!("Unknown session category: {other}")),
        };
        return match result {
            Ok(result) => {
                project_management::work_run_service::acknowledge_dispatch_started(
                    &lease.dispatch_id,
                    &lease.lease_token,
                    &result.session_id,
                )?;
                Ok(result)
            }
            Err(err) => {
                let _ = project_management::work_run_service::record_dispatch_failure(
                    &lease.dispatch_id,
                    &lease.lease_token,
                    &err,
                );
                Err(err)
            }
        };
    }

    match params.category.as_str() {
        SESSION_CATEGORY_RUST_AGENT => launch_rust_agent(state, org_store, params, auto_name).await,
        SESSION_CATEGORY_CLI_AGENT => launch_cli_agent(params, auto_name).await,
        other => Err(format!("Unknown session category: {other}")),
    }
}

fn validate_workspace_launch_fields(
    isolate: bool,
    workspace_path: Option<&str>,
    worktree_path: Option<&str>,
    worktree_base_ref: Option<&str>,
) -> Result<(), String> {
    let has_existing_worktree = worktree_path.is_some_and(|path| !path.trim().is_empty());
    let has_base_ref = worktree_base_ref.is_some_and(|base| !base.trim().is_empty());

    if (isolate || has_existing_worktree)
        && workspace_path.is_none_or(|path| path.trim().is_empty())
    {
        return Err("Worktree mode requires workspacePath".to_string());
    }
    if isolate && has_existing_worktree {
        return Err("isolate and worktreePath are mutually exclusive".to_string());
    }
    if has_base_ref && !isolate {
        return Err("worktreeBaseRef requires isolate=true".to_string());
    }
    Ok(())
}

async fn launch_rust_agent(
    state: &AgentAppState,
    org_store: Option<&AgentOrgsStore>,
    params: SessionLaunchParams,
    name: String,
) -> Result<SessionLaunchResult, String> {
    let content = params.content.clone();
    let model = params.model.clone();
    let account_id = params.account_id.clone();
    let session_branch = params.branch.clone();
    let background = params.background;
    let target = match params
        .agent_org_id
        .clone()
        .filter(|id| !id.trim().is_empty())
    {
        Some(agent_org_id) => AgentRunTarget::AgentOrg {
            agent_org_id,
            agent_definition_id: params.agent_definition_id.clone(),
            member_overrides: params.agent_org_member_overrides.clone(),
            apply_member_overrides_for_future: params.apply_agent_org_member_overrides_for_future,
        },
        None => AgentRunTarget::AgentDefinition {
            agent_definition_id: params.agent_definition_id.clone(),
        },
    };
    let workspace_path = params
        .workspace_path
        .clone()
        .filter(|path| !path.is_empty())
        .unwrap_or_default();
    let workspace = if params.isolate
        || params
            .worktree_path
            .as_deref()
            .is_some_and(|path| !path.is_empty())
    {
        WorkspaceLaunchTarget::Worktree {
            workspace_path,
            worktree_path: params.worktree_path.clone(),
            branch: params.worktree_base_ref.clone(),
            create_isolated: params.isolate,
            additional_directories: params.additional_directories.clone(),
        }
    } else {
        WorkspaceLaunchTarget::LocalWorkspace {
            workspace_path,
            additional_directories: params.additional_directories.clone(),
        }
    };
    let org_context = LaunchOrgContext {
        org_id: params
            .org_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| PERSONAL_ORG_ID.to_string()),
        project_id: params.project_id.clone(),
        project_name: params.project_name.clone(),
    };
    let provenance = match params.work_item_id.clone() {
        Some(work_item_id) => LaunchProvenance::WorkItem {
            project_slug: params.project_slug.clone(),
            work_item_id,
            agent_role: params.agent_role.clone(),
            lock_reason:
                project_management::projects::types::WorkItemExecutionLockReason::ManualStart,
        },
        None => LaunchProvenance::UserSession,
    };

    let result = launch_rust_agent_run(
        state,
        org_store,
        AgentRunLaunchRequest {
            durable_run_id: params.durable_run_id.clone(),
            content: params.content,
            target,
            resources: LaunchResourceSelection {
                key_source: params.key_source,
                account_id: params.account_id,
                model: params.model,
                native_harness_type: params.native_harness_type,
            },
            workspace,
            org_context,
            provenance,
            mode: params.mode,
            product_mode: params.product_mode,
            name: Some(name.clone()),
            images: params.images,
            ide_context: params.ide_context,
            parent_session_id: params.parent_session_id,
            sub_agent_ids: Vec::new(),
        },
    )
    .await?;

    Ok(SessionLaunchResult {
        session_id: result.session_id,
        category: SESSION_CATEGORY_RUST_AGENT.to_string(),
        name,
        status: result.status.session_status().as_str().to_string(),
        created_at: result.created_at,
        user_input: content,
        workspace_path: result.workspace_path,
        branch: result.worktree_branch.clone().or(session_branch),
        background,
        model,
        cli_agent_type: None,
        account_id,
        agent_org_id: result.agent_org_id,
        agent_org_run_id: result.agent_org_run_id,
        org_id: Some(result.org_id),
        project_id: result.project_id,
        project_name: result.project_name,
        project_slug: result.project_slug,
        work_item_id: result.work_item_id,
        agent_role: result.agent_role,
        product_mode: result.product_mode,
        worktree_path: result.worktree_path,
        worktree_branch: result.worktree_branch,
        base_ref: result.base_ref,
    })
}

async fn ensure_cli_account_key_fresh(
    platform: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    if platform != ModelType::ClaudeCode.as_str() && platform != ModelType::Codex.as_str() {
        return Ok(());
    }
    let Some(account_id) = account_id else {
        return Ok(());
    };
    let Some(key) = key_vault::key_store::KEY_SERVICE.get_key_by_id(account_id) else {
        return Ok(());
    };
    if key.auth_method != AuthMethod::Oauth {
        return Ok(());
    }

    match key.model_type {
        ModelType::ClaudeCode => {
            key_vault::key_store::KEY_SERVICE
                .ensure_claude_code_oauth_key_fresh(account_id)
                .await?;
        }
        ModelType::Codex => {
            key_vault::key_store::KEY_SERVICE
                .ensure_codex_oauth_key_fresh(account_id)
                .await?;
        }
        _ => {}
    }
    Ok(())
}

async fn launch_cli_agent(
    params: SessionLaunchParams,
    name: String,
) -> Result<SessionLaunchResult, String> {
    use crate::foundation::session_bridge::{launch_cli_agent, CliLaunchParams};

    let platform = params
        .platform
        .clone()
        .unwrap_or_else(|| "claude_code".to_string());
    let content = params.content.clone();
    let model = params.model.clone();
    let account_id = params.account_id.clone();
    let background = params.background;
    let session_branch = params.branch.clone();
    let workspace_path = params.workspace_path.clone();

    let org_id = params
        .org_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PERSONAL_ORG_ID.to_string());
    let project_id = params.project_id.clone();
    let project_name = params.project_name.clone();
    let project_slug = params.project_slug.clone();
    let work_item_id = params.work_item_id.clone();
    let agent_role = params.agent_role.clone();

    let extras = if params.additional_directories.is_empty() {
        None
    } else {
        Some(params.additional_directories.clone())
    };

    ensure_cli_account_key_fresh(&platform, account_id.as_deref()).await?;

    let bridge_params = CliLaunchParams {
        name: Some(name.clone()),
        cli_agent_type: platform.clone(),
        model: params.model,
        tier: params.tier,
        account_id: params.account_id,
        repo_path: params.workspace_path,
        branch: params.branch,
        worktree_path: params.worktree_path,
        worktree_base_ref: params.worktree_base_ref,
        hosted_token: params.hosted_token,
        isolate: params.isolate,
        background: params.background,
        key_source: params.key_source,
        additional_directories: extras,
        parent_session_id: params.parent_session_id,
        org_member_id: None,
        org_id: org_id.clone(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        project_slug: project_slug.clone(),
        work_item_id: work_item_id.clone(),
        agent_role: agent_role.clone(),
        product_mode: params.product_mode.clone(),
        durable_run_id: params.durable_run_id.clone(),
        user_input: params.content,
        ide_context: params.ide_context,
        mode: params.mode,
        images: params.images,
    };

    let outcome = launch_cli_agent(bridge_params).await?;
    let session_id = outcome.session_id;
    let created_at = outcome.created_at;
    let workspace_path = outcome.workspace_path.or(workspace_path);
    let worktree_path = outcome.worktree_path;
    let worktree_branch = outcome.worktree_branch;
    let base_ref = outcome.base_ref;

    Ok(SessionLaunchResult {
        session_id,
        category: SESSION_CATEGORY_CLI_AGENT.to_string(),
        name,
        status: crate::session::SessionStatus::Pending.as_str().to_string(),
        created_at,
        user_input: content,
        workspace_path,
        branch: worktree_branch.clone().or(session_branch),
        background,
        model,
        cli_agent_type: Some(platform),
        account_id,
        agent_org_id: None,
        agent_org_run_id: None,
        org_id: Some(org_id),
        project_id,
        project_name,
        project_slug,
        work_item_id,
        agent_role,
        product_mode: params.product_mode,
        worktree_path,
        worktree_branch,
        base_ref,
    })
}

fn derive_name(explicit: Option<&str>, content: &str) -> String {
    if let Some(name) = explicit {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "New session".to_string();
    }
    if trimmed.len() <= MAX_AUTO_NAME_LEN {
        return trimmed.to_string();
    }
    let mut boundary = MAX_AUTO_NAME_LEN;
    while boundary > 0 && !trimmed.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}...", &trimmed[..boundary])
}

#[cfg(test)]
mod tests {
    use super::validate_workspace_launch_fields;

    #[test]
    fn workspace_launch_rejects_fresh_and_existing_worktree_together() {
        let error =
            validate_workspace_launch_fields(true, Some("/repo"), Some("/repo/worktree"), None)
                .expect_err("fresh and existing modes must be exclusive");
        assert!(error.contains("mutually exclusive"));
    }

    #[test]
    fn workspace_launch_rejects_base_ref_without_isolation() {
        let error = validate_workspace_launch_fields(false, Some("/repo"), None, Some("develop"))
            .expect_err("a base ref only applies to fresh worktrees");
        assert!(error.contains("requires isolate=true"));
    }

    #[test]
    fn workspace_launch_accepts_all_three_supported_modes() {
        assert!(validate_workspace_launch_fields(false, Some("/repo"), None, None).is_ok());
        assert!(
            validate_workspace_launch_fields(true, Some("/repo"), None, Some("develop")).is_ok()
        );
        assert!(validate_workspace_launch_fields(
            false,
            Some("/repo"),
            Some("/repo/worktree"),
            None
        )
        .is_ok());
    }

    #[test]
    fn workspace_launch_rejects_worktree_mode_without_workspace_root() {
        let error = validate_workspace_launch_fields(true, None, None, None)
            .expect_err("worktree mode needs a repository root");
        assert!(error.contains("requires workspacePath"));
    }
}
