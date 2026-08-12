//! Routine direct-run commands.

use crate::definitions::builtin::SDE_AGENT_ID;
use crate::definitions::orgs::AgentOrgsStore;
use crate::session::launch::{
    launch_rust_agent_run, AgentRunLaunchRequest, AgentRunTarget, LaunchOrgContext,
    LaunchProvenance, LaunchResourceSelection, WorkspaceLaunchTarget,
};
use crate::state::AgentAppState;
use project_management::projects::{io, types};

const ROUTINE_CREATED_BY: &str = "routine";
const WORK_ITEM_ASSIGNEE_AGENT: &str = "agent";
const WORK_ITEM_PRIORITY_NONE: &str = "none";

#[tauri::command]
pub async fn project_fire_routine(
    state: tauri::State<'_, AgentAppState>,
    org_store: tauri::State<'_, std::sync::Arc<AgentOrgsStore>>,
    app: tauri::AppHandle,
    routine_id: String,
) -> Result<types::RoutineFireResult, String> {
    let routine_id_for_read = routine_id.clone();
    let routine = tokio::task::spawn_blocking(move || io::read_routine(&routine_id_for_read))
        .await
        .map_err(|err| format!("Task join error: {}", err))??;

    if !routine.enabled {
        return Err(format!("Routine is disabled: {routine_id}"));
    }
    fire_routine_internal(state.inner(), org_store.inner(), &app, &routine, None).await
}

/// Create a fire for `routine` (respecting its concurrency policy) and execute
/// it according to the output policy. Shared by the `project_fire_routine`
/// command (manual "Fire Now") and the routine scheduler.
///
/// `idempotency_key` dedupes scheduler-originated fires across restarts; the
/// manual path passes `None`.
pub async fn fire_routine_internal(
    state: &AgentAppState,
    org_store: &AgentOrgsStore,
    app: &tauri::AppHandle,
    routine: &types::RoutineDefinition,
    idempotency_key: Option<String>,
) -> Result<types::RoutineFireResult, String> {
    let routine_id_for_fire = routine.id.clone();
    let output_policy_for_fire = routine.output_policy.clone();
    let key_for_fire = idempotency_key.clone();
    let pending_fire = tokio::task::spawn_blocking(move || {
        io::create_routine_fire_for_policy_with_key(
            &routine_id_for_fire,
            &output_policy_for_fire,
            key_for_fire.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))??;

    if !matches!(pending_fire.status, types::RoutineFireStatus::Pending) {
        return Ok(types::RoutineFireResult {
            fire: pending_fire,
            session_id: None,
            agent_org_run_id: None,
        });
    }

    execute_pending_fire(state, org_store, app, routine, &pending_fire).await
}

/// Execute an already-Pending fire according to the routine's output policy.
/// Also the entry point for dequeued (Queued → Pending) fires.
pub async fn execute_pending_fire(
    state: &AgentAppState,
    org_store: &AgentOrgsStore,
    app: &tauri::AppHandle,
    routine: &types::RoutineDefinition,
    pending_fire: &types::RoutineFire,
) -> Result<types::RoutineFireResult, String> {
    let result = match &routine.output_policy.mode {
        types::RoutineOutputMode::DirectSession => {
            launch_routine_direct_session(state, org_store, routine, pending_fire).await
        }
        types::RoutineOutputMode::CreateWorkItem => {
            match create_work_item_from_routine(routine, pending_fire, app).await {
                Ok(result) => Ok(result),
                Err(err) => {
                    let fire_id = pending_fire.id.clone();
                    let error = err.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        io::mark_routine_fire_failed(&fire_id, &error)
                    })
                    .await;
                    Err(err)
                }
            }
        }
        types::RoutineOutputMode::UpdateExistingWorkItem => {
            match update_existing_work_item_from_routine(routine, pending_fire, app).await {
                Ok(result) => Ok(result),
                Err(err) => {
                    let fire_id = pending_fire.id.clone();
                    let error = err.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        io::mark_routine_fire_failed(&fire_id, &error)
                    })
                    .await;
                    Err(err)
                }
            }
        }
    };

    emit_routine_changed(
        app,
        &routine.id,
        Some(&pending_fire.id),
        match &result {
            Ok(fire_result) => fire_status_str(&fire_result.fire.status),
            Err(_) => "failed",
        },
    );

    result
}

fn fire_status_str(status: &types::RoutineFireStatus) -> &'static str {
    match status {
        types::RoutineFireStatus::Pending => "pending",
        types::RoutineFireStatus::Started => "started",
        types::RoutineFireStatus::Succeeded => "succeeded",
        types::RoutineFireStatus::Failed => "failed",
        types::RoutineFireStatus::Skipped => "skipped",
        types::RoutineFireStatus::Coalesced => "coalesced",
        types::RoutineFireStatus::Queued => "queued",
    }
}

/// Emit the fine-grained routine event so the Routines page can refresh
/// without a full `orgii-data-changed` reload.
pub fn emit_routine_changed(
    app: &tauri::AppHandle,
    routine_id: &str,
    fire_id: Option<&str>,
    status: &str,
) {
    use tauri::Emitter;
    let _ = app.emit(
        project_management::projects::events::ROUTINE_CHANGED_EVENT,
        serde_json::json!({
            "routineId": routine_id,
            "fireId": fire_id,
            "status": status,
        }),
    );
}

async fn launch_routine_direct_session(
    state: &AgentAppState,
    org_store: &AgentOrgsStore,
    routine: &types::RoutineDefinition,
    pending_fire: &types::RoutineFire,
) -> Result<types::RoutineFireResult, String> {
    let launch_request = routine_to_launch_request(routine, &pending_fire.id);
    let launch_result = match launch_rust_agent_run(state, Some(org_store), launch_request).await {
        Ok(result) => result,
        Err(err) => {
            let fire_id = pending_fire.id.clone();
            let error = err.clone();
            let _ =
                tokio::task::spawn_blocking(move || io::mark_routine_fire_failed(&fire_id, &error))
                    .await;
            return Err(err);
        }
    };

    let fire_id = pending_fire.id.clone();
    let session_id = launch_result.session_id.clone();
    let agent_org_run_id = launch_result.agent_org_run_id.clone();
    let fire = tokio::task::spawn_blocking(move || {
        io::mark_routine_fire_started(&fire_id, &session_id, agent_org_run_id.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))??;

    Ok(types::RoutineFireResult {
        fire,
        session_id: Some(launch_result.session_id),
        agent_org_run_id: launch_result.agent_org_run_id,
    })
}

async fn create_work_item_from_routine(
    routine: &types::RoutineDefinition,
    pending_fire: &types::RoutineFire,
    _app: &tauri::AppHandle,
) -> Result<types::RoutineFireResult, String> {
    let routine_owned = routine.clone();
    let pending_fire_owned = pending_fire.clone();
    let (project_slug, short_id) = tokio::task::spawn_blocking(move || {
        let routine = routine_owned;
        let pending_fire = pending_fire_owned;
        let project_slug = routine
            .output_policy
            .create_work_item_project_slug
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);
        let short_id = if let Some(project_slug) = project_slug.as_deref() {
            io::allocate_short_id(project_slug)?
        } else {
            io::allocate_standalone_short_id(None)?
        };
        let now = chrono::Utc::now().to_rfc3339();
        let title = routine
            .output_policy
            .create_work_item_title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                routine
                    .run_template
                    .name
                    .clone()
                    .unwrap_or_else(|| routine.name.clone())
            });
        let body = routine
            .output_policy
            .create_work_item_body
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| routine.run_template.prompt.clone());

        let frontmatter = types::WorkItemFrontmatter {
            stage: None,
            id: short_id.clone(),
            short_id: short_id.clone(),
            title,
            project: None,
            status: routine.output_policy.create_work_item_status.clone(),
            priority: WORK_ITEM_PRIORITY_NONE.to_string(),
            assignee: None,
            assignee_type: Some(WORK_ITEM_ASSIGNEE_AGENT.to_string()),
            labels: Vec::new(),
            milestone: None,
            parent: None,
            start_date: None,
            target_date: None,
            created_by: Some(ROUTINE_CREATED_BY.to_string()),
            created_at: now.clone(),
            updated_at: now.clone(),
            deleted_at: None,
            starred: false,
            todos: Vec::new(),
            comments: Vec::new(),
            history: Vec::new(),
            delegations: Vec::new(),
            linked_sessions: Vec::new(),
            handoff: None,
            proof_of_work: None,
            orchestrator_config: Some(routine_to_orchestrator_config(&routine)),
            orchestrator_state: None,
            follow_up_items: Vec::new(),
            schedule: None,
            routine_source: Some(types::WorkItemRoutineSource {
                routine_id: routine.id.clone(),
                routine_fire_id: pending_fire.id.clone(),
                routine_name: routine.name.clone(),
                fired_at: pending_fire.fired_at.clone(),
            }),
            execution_lock: None,
            close_out: None,
            work_products: Vec::new(),
        };

        if let Some(project_slug) = project_slug.as_deref() {
            io::write_work_item(project_slug, &short_id, &frontmatter, &body)?;
        } else {
            io::write_standalone_work_item(None, &short_id, &frontmatter, &body)?;
        }
        Ok::<_, String>((project_slug, short_id))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))??;

    // auto_start only applies to project-scoped items: start_work_item
    // requires a project slug (standalone items cannot run the orchestrator).
    if routine.output_policy.auto_start {
        if let Some(slug) = project_slug.as_deref() {
            match enqueue_routine_work_item_run(routine, pending_fire, slug, &short_id).await {
                Ok(_) => {
                    let fire_id = pending_fire.id.clone();
                    let short_id_for_mark = short_id.clone();
                    let fire = tokio::task::spawn_blocking(move || {
                        io::mark_routine_fire_work_item_started(&fire_id, &short_id_for_mark, None)
                    })
                    .await
                    .map_err(|err| format!("Task join error: {}", err))??;
                    return Ok(types::RoutineFireResult {
                        fire,
                        session_id: None,
                        agent_org_run_id: None,
                    });
                }
                Err(err) => {
                    tracing::warn!(
                        "[routine] auto_start of {} failed, leaving item in backlog: {}",
                        short_id,
                        err
                    );
                }
            }
        }
    }

    let fire_id = pending_fire.id.clone();
    let short_id_for_mark = short_id.clone();
    let fire = tokio::task::spawn_blocking(move || {
        io::mark_routine_fire_work_item_created(&fire_id, &short_id_for_mark)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))??;
    Ok(types::RoutineFireResult {
        fire,
        session_id: None,
        agent_org_run_id: None,
    })
}

/// UpdateExistingWorkItem mode: reset the target item's orchestrator phase,
/// record the trigger in its history, then run it. Each run's linked session
/// stays on the item, so the tracking history accumulates.
async fn update_existing_work_item_from_routine(
    routine: &types::RoutineDefinition,
    pending_fire: &types::RoutineFire,
    _app: &tauri::AppHandle,
) -> Result<types::RoutineFireResult, String> {
    let short_id = routine
        .output_policy
        .update_work_item_short_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Routine output policy is missing update_work_item_short_id")?;
    let project_slug = routine
        .output_policy
        .update_work_item_project_slug
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Routine output policy is missing update_work_item_project_slug")?;

    let routine_name = routine.name.clone();
    let routine_id = routine.id.clone();
    let fire_id = pending_fire.id.clone();
    let fired_at = pending_fire.fired_at.clone();
    {
        let slug = project_slug.clone();
        let sid = short_id.clone();
        tokio::task::spawn_blocking(move || {
            io::update_work_item_atomic(&slug, &sid, |frontmatter, _body| {
                use project_management::projects::types::OrchestratorPhase;
                if let Some(ref lock) = frontmatter.execution_lock {
                    if lock.active_session_id.is_some() {
                        return Err(format!(
                            "Work item {sid} already has a running session; \
                             cannot re-trigger from routine"
                        ));
                    }
                }
                if let Some(ref mut state) = frontmatter.orchestrator_state {
                    state.current_phase = OrchestratorPhase::Idle;
                    state.interrupted = false;
                    state.interrupted_phase = None;
                }
                frontmatter.status = "planned".to_string();
                frontmatter.routine_source = Some(types::WorkItemRoutineSource {
                    routine_id: routine_id.clone(),
                    routine_fire_id: fire_id.clone(),
                    routine_name: routine_name.clone(),
                    fired_at: fired_at.clone(),
                });
                frontmatter.history.push(types::WorkItemHistoryEvent {
                    id: format!("routine-trigger-{}", fire_id),
                    action: types::WorkItemHistoryAction::Updated,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    actor_id: Some(routine_id.clone()),
                    actor_name: Some(ROUTINE_CREATED_BY.to_string()),
                    changes: Vec::new(),
                    summary: Some(format!(
                        "Triggered by routine \"{}\" at {}",
                        routine_name, fired_at
                    )),
                });
                frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
                Ok(())
            })
        })
        .await
        .map_err(|err| format!("Task join error: {}", err))??;
    }

    enqueue_routine_work_item_run(routine, pending_fire, &project_slug, &short_id).await?;

    let fire_id = pending_fire.id.clone();
    let short_id_for_mark = short_id.clone();
    let fire = tokio::task::spawn_blocking(move || {
        io::mark_routine_fire_work_item_started(&fire_id, &short_id_for_mark, None)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))??;

    Ok(types::RoutineFireResult {
        fire,
        session_id: None,
        agent_org_run_id: None,
    })
}

async fn enqueue_routine_work_item_run(
    routine: &types::RoutineDefinition,
    pending_fire: &types::RoutineFire,
    project_slug: &str,
    short_id: &str,
) -> Result<project_management::projects::types::WorkItemRun, String> {
    let (agent_definition_id, agent_org_id) = match &routine.run_template.target {
        types::RoutineRunTarget::AgentDefinition {
            agent_definition_id,
        } => (agent_definition_id.clone(), None),
        types::RoutineRunTarget::AgentOrg { agent_org_id } => (None, Some(agent_org_id.clone())),
    };
    let request = types::EnqueueWorkItemRunRequest {
        project_slug: Some(project_slug.to_string()),
        org_id: types::PERSONAL_ORG_ID.to_string(),
        work_item_id: short_id.to_string(),
        trigger: types::WorkItemRunTrigger::Routine {
            routine_id: routine.id.clone(),
            fire_id: pending_fire.id.clone(),
        },
        target_snapshot: types::WorkItemRunTargetSnapshot {
            target: types::WorkItemRunTarget::StartWorkItem {
                account_id: routine.run_template.resources.account_id.clone(),
                model_id: routine.run_template.resources.model.clone(),
            },
            work_item_revision: 0,
            work_item_title: None,
            work_item_body: None,
            project_description: None,
            workspace_path: routine_workspace_path(&routine.run_template.workspace),
            repository: None,
            repository_ref: None,
            default_branch: None,
            linked_repositories: Vec::new(),
            allow_shared_checkout: false,
            workspace_mode: routine_workspace_mode(&routine.run_template.workspace),
            agent_definition_id,
            agent_org_id,
        },
        input: serde_json::json!({
            "prompt": routine.run_template.prompt,
            "routineName": routine.name,
            "routineFireId": pending_fire.id,
        }),
        idempotency_key: format!("routine-fire:{}", pending_fire.id),
        max_attempts: 3,
        parent_run_id: None,
    };
    tokio::task::spawn_blocking(move || project_management::work_run_service::enqueue(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

fn routine_to_orchestrator_config(routine: &types::RoutineDefinition) -> types::OrchestratorConfig {
    let mut config = types::OrchestratorConfig {
        selected_account_id: routine.run_template.resources.account_id.clone(),
        selected_model_id: routine.run_template.resources.model.clone(),
        agent_mode: routine.run_template.mode.clone(),
        worktree_path: routine_workspace_path(&routine.run_template.workspace),
        workspace_mode: routine_workspace_mode(&routine.run_template.workspace),
        ..Default::default()
    };

    match &routine.run_template.target {
        types::RoutineRunTarget::AgentDefinition {
            agent_definition_id,
        } => {
            config.agent_definition_id = agent_definition_id
                .clone()
                .or_else(|| Some(SDE_AGENT_ID.to_string()));
        }
        types::RoutineRunTarget::AgentOrg { agent_org_id } => {
            config.org_id = Some(agent_org_id.clone());
        }
    }

    config
}

fn routine_workspace_mode(
    workspace: &types::RoutineWorkspaceTarget,
) -> Option<types::WorkspaceExecutionMode> {
    match workspace {
        types::RoutineWorkspaceTarget::None => None,
        types::RoutineWorkspaceTarget::LocalWorkspace { .. } => {
            Some(types::WorkspaceExecutionMode::LocalWorkspace)
        }
        types::RoutineWorkspaceTarget::Worktree { .. } => {
            Some(types::WorkspaceExecutionMode::Worktree)
        }
    }
}

fn routine_workspace_path(workspace: &types::RoutineWorkspaceTarget) -> Option<String> {
    match workspace {
        types::RoutineWorkspaceTarget::None => None,
        types::RoutineWorkspaceTarget::LocalWorkspace { workspace_path, .. } => {
            Some(workspace_path.clone())
        }
        types::RoutineWorkspaceTarget::Worktree {
            worktree_path,
            workspace_path,
            ..
        } => worktree_path
            .clone()
            .or_else(|| Some(workspace_path.clone())),
    }
}

fn routine_to_launch_request(
    routine: &types::RoutineDefinition,
    fire_id: &str,
) -> AgentRunLaunchRequest {
    let target = match &routine.run_template.target {
        types::RoutineRunTarget::AgentDefinition {
            agent_definition_id,
        } => AgentRunTarget::AgentDefinition {
            agent_definition_id: agent_definition_id.clone(),
        },
        types::RoutineRunTarget::AgentOrg { agent_org_id } => AgentRunTarget::AgentOrg {
            agent_org_id: agent_org_id.clone(),
            agent_definition_id: None,
            member_overrides: std::collections::HashMap::new(),
            apply_member_overrides_for_future: false,
        },
    };

    let workspace = match &routine.run_template.workspace {
        types::RoutineWorkspaceTarget::None => WorkspaceLaunchTarget::LocalWorkspace {
            workspace_path: String::new(),
            additional_directories: Vec::new(),
        },
        types::RoutineWorkspaceTarget::LocalWorkspace {
            workspace_path,
            additional_directories,
        } => WorkspaceLaunchTarget::LocalWorkspace {
            workspace_path: workspace_path.clone(),
            additional_directories: additional_directories.clone(),
        },
        types::RoutineWorkspaceTarget::Worktree {
            workspace_path,
            worktree_path,
            branch,
            create_isolated,
            additional_directories,
        } => WorkspaceLaunchTarget::Worktree {
            workspace_path: workspace_path.clone(),
            worktree_path: worktree_path.clone(),
            branch: branch.clone(),
            create_isolated: *create_isolated,
            additional_directories: additional_directories.clone(),
        },
    };

    AgentRunLaunchRequest {
        durable_run_id: None,
        content: routine.run_template.prompt.clone(),
        target,
        resources: LaunchResourceSelection {
            key_source: routine.run_template.resources.key_source.clone(),
            account_id: routine.run_template.resources.account_id.clone(),
            model: routine.run_template.resources.model.clone(),
            native_harness_type: routine.run_template.resources.native_harness_type.clone(),
        },
        workspace,
        org_context: LaunchOrgContext {
            org_id: types::PERSONAL_ORG_ID.to_string(),
            project_id: None,
            project_name: None,
        },
        provenance: LaunchProvenance::RoutineFire {
            routine_fire_id: fire_id.to_string(),
        },
        mode: routine.run_template.mode.clone(),
        // Non-interactive routine invokes are Project context by the
        // frozen resolver (orgtrack/v1 §5.1).
        product_mode: Some("project".to_string()),
        name: routine
            .run_template
            .name
            .clone()
            .or_else(|| Some(routine.name.clone())),
        images: None,
        ide_context: None,
        parent_session_id: None,
        sub_agent_ids: Vec::new(),
    }
}
