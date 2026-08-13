//! Canonical Rust-agent launch service.
//!
//! This module is the single runtime entry point for creating a Rust-native
//! agent session and optionally starting its first turn. Tauri commands,
//! WorkItem orchestration, Routine fires, and debug probes should adapt their
//! wire/domain DTOs into `AgentRunLaunchRequest` instead of duplicating session
//! creation or first-turn startup logic.

mod launch_helpers;
mod launch_org;
#[cfg(test)]
mod launch_tests;
mod launch_workspace;

use std::collections::HashMap;

use tauri::Manager;

use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    COORDINATOR_MEMBER_ID,
};
use crate::definitions::orgs::{AgentOrgsStore, OrgMemberLaunchOverride};
use crate::init::launch_spec::AgentLaunchSpec;
use crate::session::persistence;
use crate::session::IdeContext;
use crate::state::AgentAppState;
use project_management::projects::types as project_types;

use launch_helpers::{
    apply_member_launch_overrides_to_snapshot, derive_name, handle_background_launch_failure,
    provenance_fields, provenance_lock_reason, validate_launch_agent_definitions,
};
use launch_org::{
    cleanup_session_after_org_run_create_failure, send_initial_turn,
    spawn_agent_org_member_materialization,
};
use launch_workspace::{
    acquire_work_item_execution_lock, prepare_rust_agent_workspace_for_launch,
    release_work_item_execution_lock_if_present,
};

pub(crate) const MAX_AUTO_NAME_LEN: usize = 80;

#[derive(Debug, Clone)]
pub(crate) struct AgentRunLaunchRequest {
    /// Stable WorkItemRun id used for deterministic Session and turn ids.
    /// `None` preserves the ordinary user-launch behavior.
    pub durable_run_id: Option<String>,
    pub content: String,
    pub target: AgentRunTarget,
    pub resources: LaunchResourceSelection,
    pub workspace: WorkspaceLaunchTarget,
    pub org_context: LaunchOrgContext,
    pub provenance: LaunchProvenance,
    pub mode: Option<String>,
    /// Product mode (`orgtrack/v1` §5.2). Launch-from-work/routine
    /// resolves to `project` server-side regardless of this value.
    pub product_mode: Option<String>,
    pub name: Option<String>,
    pub images: Option<Vec<String>>,
    pub ide_context: Option<IdeContext>,
    pub parent_session_id: Option<String>,
    pub sub_agent_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum AgentRunTarget {
    AgentDefinition {
        agent_definition_id: Option<String>,
    },
    AgentOrg {
        agent_org_id: String,
        agent_definition_id: Option<String>,
        member_overrides: HashMap<String, OrgMemberLaunchOverride>,
        apply_member_overrides_for_future: bool,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct LaunchOrgContext {
    pub org_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LaunchResourceSelection {
    pub key_source: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub native_harness_type: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum WorkspaceLaunchTarget {
    LocalWorkspace {
        workspace_path: String,
        additional_directories: Vec<String>,
    },
    Worktree {
        workspace_path: String,
        worktree_path: Option<String>,
        branch: Option<String>,
        create_isolated: bool,
        additional_directories: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub(crate) enum LaunchProvenance {
    UserSession,
    WorkItem {
        /// Project scope for the Work Item. `None` is a first-class
        /// standalone Work Item, not a reason to discard the linkage.
        project_slug: Option<String>,
        work_item_id: String,
        agent_role: Option<String>,
        lock_reason: project_types::WorkItemExecutionLockReason,
    },
    RoutineFire {
        routine_fire_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchReturnStatus {
    Idle,
    FirstTurnStarted,
}

impl LaunchReturnStatus {
    pub(crate) fn session_status(self) -> crate::session::SessionStatus {
        match self {
            Self::Idle => crate::session::SessionStatus::Idle,
            Self::FirstTurnStarted => crate::session::SessionStatus::Running,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRunLaunchResult {
    pub session_id: String,
    pub status: LaunchReturnStatus,
    pub created_at: String,
    pub workspace_path: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub base_ref: Option<String>,
    pub agent_org_id: Option<String>,
    pub agent_org_run_id: Option<String>,
    pub org_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    pub product_mode: Option<String>,
}

/// Write the fail-closed session-context marker (design M6) into the
/// session workspace: `org2-pm` locks its identity to this file when
/// present, so an agent inside the workspace can never act as a human
/// or as another session.
pub fn write_agent_session_marker(
    workspace_path: &str,
    session_id: &str,
    agent_definition_id: Option<&str>,
    product_mode: Option<&str>,
    project_slug: Option<&str>,
    org_id: Option<&str>,
) {
    if workspace_path.trim().is_empty() {
        return;
    }
    let agent = agent_definition_id
        .unwrap_or("os")
        .trim_start_matches("builtin:");
    // Historical rows may store NULL for ordinary Build, but the marker is a
    // fail-closed authority boundary and must always carry an explicit mode.
    // Otherwise `org2-pm --mode project` could elevate a Build session.
    let product_mode = product_mode.unwrap_or("build");
    let capabilities: Vec<&str> = if product_mode == "project" {
        vec![
            "work.read",
            "work.mutate",
            "routine.invoke",
            "project.mutate",
        ]
    } else {
        vec!["work.read"]
    };
    let marker = serde_json::json!({
        "apiVersion": "orgtrack/v1",
        "sessionRef": format!("org2:{session_id}"),
        "actor": format!("agent:{agent}"),
        "productMode": product_mode,
        "scope": project_slug,
        "org": project_management::projects::io::resolve_local_org_scope(org_id),
        "capabilities": capabilities,
        "issuedAt": chrono::Utc::now().to_rfc3339(),
    });
    let dir = std::path::Path::new(workspace_path).join(".orgii");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("agent_session_context.json");
    if let Ok(raw) = serde_json::to_string_pretty(&marker) {
        let _ = std::fs::write(path, raw);
    }
}

async fn generate_title_before_first_turn(
    state: &AgentAppState,
    session_id: &str,
    workspace_path: std::path::PathBuf,
    account_id: Option<String>,
    model: Option<String>,
    native_harness_type: Option<core_types::providers::NativeHarnessType>,
    content: &str,
) {
    if content.trim().is_empty() {
        return;
    }

    let launch_spec = match AgentLaunchSpec::from_session_sources(
        state,
        session_id,
        workspace_path,
        account_id,
        model,
        native_harness_type,
    )
    .await
    {
        Ok(spec) => spec,
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[session_title] failed to resolve launch spec before first turn"
            );
            return;
        }
    };

    let runtime = match crate::init::init_session(state, launch_spec).await {
        Ok(runtime) => runtime,
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[session_title] failed to initialize runtime before first turn"
            );
            return;
        }
    };

    let title = crate::session::title::generate_and_persist_session_title(
        session_id,
        runtime.provider.as_ref(),
        &runtime.model,
        runtime.account_id.as_deref(),
        content,
    )
    .await;

    crate::lifecycle::emit_session_renamed(state.app_handle.as_ref(), session_id, &title);
}

/// Spawn session-title generation as an independent fire-and-forget task.
///
/// Title generation is a `side_query` that runs a full LLM round-trip. It
/// MUST NOT block `send_initial_turn`: doing so makes any slowness/failure in
/// the auxiliary call (provider 400s, retry backoff, network) directly delay
/// the user's first turn — the very "a side query stalls the main turn"
/// coupling this decoupling removes. The title task persists the name and
/// emits `session:renamed` when it finishes; the first turn proceeds
/// concurrently regardless of when (or whether) the title resolves.
fn spawn_session_title_generation(
    state: AgentAppState,
    session_id: String,
    workspace_path: std::path::PathBuf,
    account_id: Option<String>,
    model: Option<String>,
    native_harness_type: Option<core_types::providers::NativeHarnessType>,
    content: String,
) {
    tokio::spawn(async move {
        generate_title_before_first_turn(
            &state,
            &session_id,
            workspace_path,
            account_id,
            model,
            native_harness_type,
            &content,
        )
        .await;
    });
}

/// Create and start an agent session linked to a work item.
///
/// This remains as the public WorkItem-facing adapter for existing callers;
/// all actual launch behavior is delegated to `launch_rust_agent_run`.
pub struct WorkItemLaunchRequest<'a> {
    pub durable_run_id: Option<&'a str>,
    pub workspace_path: &'a str,
    pub prompt: &'a str,
    pub model: &'a str,
    pub account_id: &'a str,
    pub work_item_id: &'a str,
    pub project_slug: &'a str,
    pub worktree_path: Option<&'a str>,
    pub agent_definition_id: Option<&'a str>,
    pub agent_role: &'a str,
    pub sub_agent_ids: &'a [String],
    pub lock_reason: project_types::WorkItemExecutionLockReason,
}

pub async fn launch_agent_session(
    app: &tauri::AppHandle,
    request: WorkItemLaunchRequest<'_>,
) -> Result<String, String> {
    let state: tauri::State<'_, AgentAppState> = app.state();
    let WorkItemLaunchRequest {
        durable_run_id,
        workspace_path,
        prompt,
        model,
        account_id,
        work_item_id,
        project_slug,
        worktree_path,
        agent_definition_id,
        agent_role,
        sub_agent_ids,
        lock_reason,
    } = request;

    let workspace = match worktree_path.filter(|path| !path.is_empty()) {
        Some(path) => WorkspaceLaunchTarget::Worktree {
            workspace_path: workspace_path.to_string(),
            worktree_path: Some(path.to_string()),
            branch: None,
            create_isolated: false,
            additional_directories: Vec::new(),
        },
        None => WorkspaceLaunchTarget::LocalWorkspace {
            workspace_path: workspace_path.to_string(),
            additional_directories: Vec::new(),
        },
    };

    let result = launch_rust_agent_run(
        &state,
        None,
        AgentRunLaunchRequest {
            durable_run_id: durable_run_id.map(str::to_string),
            content: prompt.to_string(),
            target: AgentRunTarget::AgentDefinition {
                agent_definition_id: agent_definition_id.map(str::to_string),
            },
            resources: LaunchResourceSelection {
                key_source: Some(
                    core_types::key_source::KeySource::OwnKey
                        .as_ref()
                        .to_string(),
                ),
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                native_harness_type: None,
            },
            workspace,
            org_context: LaunchOrgContext {
                org_id: project_management::projects::types::PERSONAL_ORG_ID.to_string(),
                project_id: None,
                project_name: None,
            },
            provenance: LaunchProvenance::WorkItem {
                project_slug: Some(project_slug.to_string()),
                work_item_id: work_item_id.to_string(),
                agent_role: Some(agent_role.to_string()),
                lock_reason,
            },
            mode: Some(crate::session::AgentExecMode::Build.as_str().to_string()),
            // Launch-from-WorkItem is Project mode by the frozen resolver
            // (orgtrack/v1 decisions §1, precedence rule 1).
            product_mode: Some("project".to_string()),
            name: Some(format!("{}: {}", agent_role, work_item_id)),
            images: None,
            ide_context: None,
            parent_session_id: None,
            sub_agent_ids: sub_agent_ids.to_vec(),
        },
    )
    .await?;

    Ok(result.session_id)
}

pub(crate) async fn launch_rust_agent_run(
    state: &AgentAppState,
    org_store: Option<&AgentOrgsStore>,
    request: AgentRunLaunchRequest,
) -> Result<AgentRunLaunchResult, String> {
    let (workspace_path, branch, isolate, existing_worktree_path, additional_directories) =
        match &request.workspace {
            WorkspaceLaunchTarget::LocalWorkspace {
                workspace_path,
                additional_directories,
            } => (
                workspace_path.clone(),
                None,
                false,
                None,
                additional_directories.clone(),
            ),
            WorkspaceLaunchTarget::Worktree {
                workspace_path,
                worktree_path,
                branch,
                create_isolated,
                additional_directories,
            } => (
                workspace_path.clone(),
                branch.clone(),
                *create_isolated,
                worktree_path.clone(),
                additional_directories.clone(),
            ),
        };
    let (
        agent_org_id,
        coordinator_agent_id,
        agent_definition_id,
        org_definition,
        member_overrides,
        apply_member_overrides_for_future,
    ) = match &request.target {
        AgentRunTarget::AgentOrg {
            agent_org_id,
            agent_definition_id,
            member_overrides,
            apply_member_overrides_for_future,
        } => {
            let store = org_store.ok_or_else(|| {
                "Agent Org launch requires AgentOrgsStore, but none was provided".to_string()
            })?;
            let org = store.get(agent_org_id)?;
            let resolved = org.agent_id.trim();
            if resolved.is_empty() {
                return Err(format!(
                    "Agent Org '{}' has no coordinator agent configured",
                    org.name
                ));
            }
            if let Some(requested_agent_id) = agent_definition_id.as_deref() {
                if requested_agent_id != resolved {
                    return Err(format!(
                        "Agent Org '{}' coordinator '{}' conflicts with requested agent definition '{}'",
                        agent_org_id, resolved, requested_agent_id
                    ));
                }
            }
            (
                Some(agent_org_id.clone()),
                Some(resolved.to_string()),
                Some(resolved.to_string()),
                Some(org),
                member_overrides.clone(),
                *apply_member_overrides_for_future,
            )
        }
        AgentRunTarget::AgentDefinition {
            agent_definition_id,
        } => (
            None,
            None,
            agent_definition_id.clone(),
            None,
            HashMap::new(),
            false,
        ),
    };
    let effective_org_definition = org_definition
        .as_ref()
        .map(|org| {
            let mut effective_org = org.clone();
            apply_member_launch_overrides_to_snapshot(
                &mut effective_org.children,
                &member_overrides,
            )
            .map(|()| effective_org)
        })
        .transpose()?;
    validate_launch_agent_definitions(
        agent_definition_id.as_deref(),
        effective_org_definition.as_ref(),
    )?;

    let (project_slug, work_item_id, agent_role, routine_fire_id) =
        provenance_fields(&request.provenance);
    let name = request
        .name
        .clone()
        .unwrap_or_else(|| derive_name(None, &request.content));

    // Existing worktrees can be validated before a session id exists. Do it
    // before creating any DB/org records so an invalid or cross-repo path can
    // never surface as a briefly successful background launch.
    let registered_existing_worktree = if let Some(path) = existing_worktree_path.as_deref() {
        let repo = std::path::PathBuf::from(&workspace_path);
        let path = std::path::PathBuf::from(path);
        Some(
            tokio::task::spawn_blocking(move || {
                git::worktree::validate_existing_worktree(&repo, &path)
            })
            .await
            .map_err(|err| format!("worktree validation task failed: {err}"))??,
        )
    } else {
        None
    };
    let existing_worktree_path = registered_existing_worktree
        .as_ref()
        .map(|entry| entry.path.clone());
    let existing_worktree_branch = registered_existing_worktree
        .as_ref()
        .map(|entry| entry.branch.clone());

    let create_result = crate::state::commands::session::create::create_session_impl(
        None,
        workspace_path.clone(),
        request.resources.model.clone(),
        request.resources.account_id.clone(),
        Some(name.clone()),
        Some(request.org_context.org_id.clone()),
        request.org_context.project_id.clone(),
        request.org_context.project_name.clone(),
        work_item_id.clone(),
        agent_role.clone(),
        existing_worktree_path.clone(),
        project_slug.clone(),
        agent_definition_id.clone(),
        request.resources.key_source.clone(),
        request.mode.clone(),
        request.product_mode.clone(),
        request.resources.native_harness_type.clone(),
        request.parent_session_id.clone(),
        request.durable_run_id.clone(),
    )
    .await?;

    let session_id = create_result
        .get("sessionId")
        .and_then(|value| value.as_str())
        .ok_or("create_session_impl did not return sessionId")?
        .to_string();
    let resolved_product_mode = create_result
        .get("productMode")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    if let (Some(project_slug_value), Some(work_item_id_value)) =
        (project_slug.as_deref(), work_item_id.as_deref())
    {
        if let Err(err) = acquire_work_item_execution_lock(
            project_slug_value,
            work_item_id_value,
            &session_id,
            agent_role.as_deref(),
            provenance_lock_reason(&request.provenance),
        )
        .await
        {
            cleanup_session_after_org_run_create_failure(session_id.clone()).await;
            return Err(err);
        }
    }

    let agent_org_run_id = match (agent_org_id.as_ref(), coordinator_agent_id.as_ref()) {
        (Some(org_id), Some(coordinator_id)) => {
            let org_snapshot = effective_org_definition
                .as_ref()
                .ok_or("Agent Org launch is missing resolved org definition")?
                .clone();
            let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
                org_id: org_id.clone(),
                coordinator_agent_id: coordinator_id.clone(),
                root_session_id: Some(session_id.clone()),
                org_snapshot,
                entry_mode: AgentOrgRunEntryMode::StandaloneSession,
                status: AgentOrgRunStatus::Running,
                work_item_id: work_item_id.clone(),
                project_slug: project_slug.clone(),
                routine_fire_id,
            });
            match run {
                Ok(record) => {
                    persistence::update_org_member_id(&session_id, COORDINATOR_MEMBER_ID)
                        .map_err(|err| format!("failed to persist coordinator member_id: {err}"))?;
                    if let Some(org) = effective_org_definition.as_ref() {
                        spawn_agent_org_member_materialization(
                            record.id.clone(),
                            org.clone(),
                            session_id.clone(),
                            name.clone(),
                            workspace_path.clone(),
                            request.resources.model.clone(),
                            request.resources.account_id.clone(),
                            request.resources.key_source.clone(),
                            request.mode.clone(),
                            request.resources.native_harness_type.clone(),
                            work_item_id.clone(),
                            project_slug.clone(),
                        );
                    }
                    if apply_member_overrides_for_future {
                        if let Some(store) = org_store {
                            store.apply_member_launch_overrides(org_id, &member_overrides)?;
                        }
                    }
                    Some(record.id)
                }
                Err(err) => {
                    cleanup_session_after_org_run_create_failure(session_id.clone()).await;
                    return Err(err);
                }
            }
        }
        _ => None,
    };

    let created_at = chrono::Utc::now().to_rfc3339();
    let has_initial_content = !request.content.trim().is_empty();
    let native_harness_type_for_send = request
        .resources
        .native_harness_type
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| {
            core_types::providers::NativeHarnessType::parse(value)
                .ok_or_else(|| format!("Unknown native_harness_type: {value:?}"))
        })
        .transpose()?;

    if agent_org_run_id.is_some() {
        let state_for_background = state.clone();
        let session_id_for_background = session_id.clone();
        let workspace_path_for_background = workspace_path.clone();
        let branch_for_background = branch.clone();
        let existing_worktree_path_for_background = existing_worktree_path.clone();
        let additional_directories_for_background = additional_directories.clone();
        let content_for_send = request.content.clone();
        let model_for_send = request.resources.model.clone();
        let account_id_for_send = request.resources.account_id.clone();
        let mode_for_send = request.mode.clone();
        let images_for_send = request.images.clone();
        let ide_context_for_send = request.ide_context.clone();
        let sub_agent_ids_for_send = request.sub_agent_ids.clone();
        let agent_definition_id_for_send = agent_definition_id.clone();
        let agent_org_run_id_for_background = agent_org_run_id.clone();
        let durable_run_id_for_background = request.durable_run_id.clone();
        let project_slug_for_background = project_slug.clone();
        let work_item_id_for_background = work_item_id.clone();
        let app_handle_for_background = state.app_handle.clone();

        tokio::spawn(async move {
            let prepared_workspace = match prepare_rust_agent_workspace_for_launch(
                &session_id_for_background,
                &workspace_path_for_background,
                branch_for_background.as_deref(),
                isolate,
                existing_worktree_path_for_background.as_deref(),
                &additional_directories_for_background,
            )
            .await
            {
                Ok(path) => path,
                Err(err) => {
                    let message = format!(
                        "[session_launch] workspace preparation failed for {}: {}",
                        session_id_for_background, err
                    );
                    handle_background_launch_failure(
                        &session_id_for_background,
                        agent_org_run_id_for_background.as_deref(),
                        project_slug_for_background.as_deref(),
                        work_item_id_for_background.as_deref(),
                        app_handle_for_background.as_ref(),
                        &message,
                        "[session_launch] failed to mark Agent Org run failed after workspace preparation error",
                        "[session_launch] failed to mark session failed after workspace preparation error",
                    )
                    .await;
                    return;
                }
            };

            if !has_initial_content {
                return;
            }

            let workspace_path_for_send = prepared_workspace
                .worktree_path
                .clone()
                .unwrap_or_else(|| workspace_path_for_background.clone());
            // Title generation runs concurrently — it must not delay the
            // first turn. See `spawn_session_title_generation`.
            spawn_session_title_generation(
                state_for_background.clone(),
                session_id_for_background.clone(),
                std::path::PathBuf::from(&workspace_path_for_send),
                account_id_for_send.clone(),
                model_for_send.clone(),
                native_harness_type_for_send,
                content_for_send.clone(),
            );
            let send_result = send_initial_turn(
                &state_for_background,
                &session_id_for_background,
                content_for_send,
                model_for_send,
                account_id_for_send,
                workspace_path_for_send,
                native_harness_type_for_send,
                mode_for_send,
                images_for_send,
                ide_context_for_send,
                agent_definition_id_for_send,
                sub_agent_ids_for_send,
                agent_org_run_id_for_background.clone(),
                durable_run_id_for_background,
                crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
            )
            .await;

            if let Err(err) = send_result {
                let message = format!(
                    "[session_launch] send_message failed for {}: {}",
                    session_id_for_background, err
                );
                handle_background_launch_failure(
                    &session_id_for_background,
                    agent_org_run_id_for_background.as_deref(),
                    project_slug_for_background.as_deref(),
                    work_item_id_for_background.as_deref(),
                    app_handle_for_background.as_ref(),
                    &message,
                    "[session_launch] failed to mark Agent Org run failed",
                    "[session_launch] failed to mark session failed after first-message error",
                )
                .await;
            }
        });

        return Ok(AgentRunLaunchResult {
            session_id,
            status: if has_initial_content {
                LaunchReturnStatus::FirstTurnStarted
            } else {
                LaunchReturnStatus::Idle
            },
            created_at,
            workspace_path: Some(workspace_path).filter(|path| !path.is_empty()),
            worktree_path: existing_worktree_path,
            worktree_branch: existing_worktree_branch,
            base_ref: None,
            agent_org_id,
            agent_org_run_id,
            org_id: request.org_context.org_id.clone(),
            project_id: request.org_context.project_id.clone(),
            project_name: request.org_context.project_name.clone(),
            project_slug,
            work_item_id,
            agent_role,
            product_mode: resolved_product_mode.clone(),
        });
    }

    let prepared_workspace = match prepare_rust_agent_workspace_for_launch(
        &session_id,
        &workspace_path,
        branch.as_deref(),
        isolate,
        existing_worktree_path.as_deref(),
        &additional_directories,
    )
    .await
    {
        Ok(path) => path,
        Err(err) => {
            release_work_item_execution_lock_if_present(
                project_slug.as_deref(),
                work_item_id.as_deref(),
                &session_id,
                state.app_handle.as_ref(),
            )
            .await;
            // The session row was already created by `create_session_impl`
            // above. Workspace preparation failing (e.g. empty workspace_path
            // for a non personal-workspace agent) means this session can never
            // run — delete it so we don't leave a workspace-less orphan that
            // would fail again on its first message.
            cleanup_session_after_org_run_create_failure(session_id.clone()).await;
            return Err(err);
        }
    };

    write_agent_session_marker(
        &prepared_workspace
            .worktree_path
            .clone()
            .unwrap_or_else(|| workspace_path.clone()),
        &session_id,
        agent_definition_id.as_deref(),
        resolved_product_mode.as_deref(),
        project_slug.as_deref(),
        Some(request.org_context.org_id.as_str()),
    );

    let durable_turn_already_accepted = match request.durable_run_id.as_deref() {
        // Any persisted status proves this exact durable intent was accepted
        // previously. Never enqueue it twice. The dispatcher reconciles
        // terminal/pre-durable statuses into Run finality.
        Some(run_id) => {
            crate::foundation::session_bridge::get_turn_intent_status(&session_id, run_id).is_some()
        }
        None => false,
    };

    if has_initial_content && !durable_turn_already_accepted {
        let state_for_send = state.clone();
        let session_id_for_send = session_id.clone();
        let workspace_path_for_send = prepared_workspace
            .worktree_path
            .clone()
            .unwrap_or_else(|| workspace_path.clone());
        let content_for_send = request.content.clone();
        let model_for_send = request.resources.model.clone();
        let account_id_for_send = request.resources.account_id.clone();
        let mode_for_send = request.mode.clone();
        let images_for_send = request.images.clone();
        let ide_context_for_send = request.ide_context.clone();
        let sub_agent_ids_for_send = request.sub_agent_ids.clone();
        let agent_definition_id_for_send = agent_definition_id.clone();
        let agent_org_run_id_for_send = agent_org_run_id.clone();
        let durable_run_id_for_send = request.durable_run_id.clone();
        let project_slug_for_send = project_slug.clone();
        let work_item_id_for_send = work_item_id.clone();
        let app_handle_for_send = state.app_handle.clone();

        let send_task = async move {
            // Title generation runs concurrently — it must not delay the
            // first turn. See `spawn_session_title_generation`.
            spawn_session_title_generation(
                state_for_send.clone(),
                session_id_for_send.clone(),
                std::path::PathBuf::from(&workspace_path_for_send),
                account_id_for_send.clone(),
                model_for_send.clone(),
                native_harness_type_for_send,
                content_for_send.clone(),
            );

            // A plain (non-org) launch's first message IS the user's real
            // request — UserSubmit so downstream consumers (goal loop,
            // org-task resume) treat it as user intent. Org-run launches
            // keep the AgentOrg source.
            let send_result = send_initial_turn(
                &state_for_send,
                &session_id_for_send,
                content_for_send,
                model_for_send,
                account_id_for_send,
                workspace_path_for_send,
                native_harness_type_for_send,
                mode_for_send,
                images_for_send,
                ide_context_for_send,
                agent_definition_id_for_send,
                sub_agent_ids_for_send,
                agent_org_run_id_for_send.clone(),
                durable_run_id_for_send,
                crate::foundation::session_bridge::TurnIntentBridgeSource::UserSubmit,
            )
            .await;

            if let Err(err) = send_result {
                let message = format!(
                    "[session_launch] send_message failed for {}: {}",
                    session_id_for_send, err
                );
                handle_background_launch_failure(
                    &session_id_for_send,
                    agent_org_run_id_for_send.as_deref(),
                    project_slug_for_send.as_deref(),
                    work_item_id_for_send.as_deref(),
                    app_handle_for_send.as_ref(),
                    &message,
                    "[session_launch] failed to mark Agent Org run failed",
                    "[session_launch] failed to mark session failed after first-message error",
                )
                .await;
                return Err(message);
            }
            Ok::<(), String>(())
        };

        if request.durable_run_id.is_some() {
            // Durable delivery is acknowledged only after the turn has been
            // accepted by the scheduler. Returning before this await would
            // leave a crash window where the outbox says delivered but no
            // executable turn exists.
            send_task.await?;
        } else {
            tokio::spawn(async move {
                let _ = send_task.await;
            });
        }
    }

    Ok(AgentRunLaunchResult {
        session_id,
        status: if has_initial_content {
            LaunchReturnStatus::FirstTurnStarted
        } else {
            LaunchReturnStatus::Idle
        },
        created_at,
        workspace_path: Some(workspace_path).filter(|path| !path.is_empty()),
        worktree_path: prepared_workspace.worktree_path,
        worktree_branch: prepared_workspace.worktree_branch,
        base_ref: prepared_workspace.base_ref,
        agent_org_id,
        agent_org_run_id,
        org_id: request.org_context.org_id,
        project_id: request.org_context.project_id,
        project_name: request.org_context.project_name,
        project_slug,
        work_item_id,
        agent_role,
        product_mode: resolved_product_mode,
    })
}
