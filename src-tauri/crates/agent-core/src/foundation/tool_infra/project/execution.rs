//! Work Item Execution - launching agent sessions for work items.

use project_management::projects::{io, types::*};

use super::helpers::run_blocking;

/// Build a project-specific task prompt from work item content.
pub(crate) fn build_project_prompt(
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
) -> String {
    let mut parts = Vec::new();
    parts.push(format!("Implement the following work item: {}", short_id));
    parts.push(format!("\n## Title\n{}", frontmatter.title));
    if !body.is_empty() {
        parts.push(format!("\n## Description\n{}", body));
    }
    if !frontmatter.todos.is_empty() {
        parts.push("\n## Acceptance Criteria".to_string());
        for todo in &frontmatter.todos {
            let check = if todo.status == super::helpers::TODO_STATUS_COMPLETED {
                "x"
            } else {
                " "
            };
            parts.push(format!("- [{}] {}", check, todo.content));
        }
    }
    parts.push(format!(
        "\n## Instructions\n\
         - Create a feature branch for this work item if one does not already exist\n\
         - Implement all changes needed to satisfy the description and acceptance criteria above\n\
         - Write or update tests where appropriate\n\
         - Run tests and lint to verify your changes\n\
         - Commit your changes with clear messages referencing {}",
        short_id
    ));
    parts.join("\n")
}

/// Build a generic agent task prompt (no project-specific instructions).
///
/// The agent's `soul_content` defines its behavior; this prompt only provides
/// the work item context (title, description, acceptance criteria).
pub(crate) fn build_agent_prompt(
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
) -> String {
    let mut parts = Vec::new();
    parts.push(format!("Execute the following work item: {}", short_id));
    parts.push(format!("\n## Title\n{}", frontmatter.title));
    if !body.is_empty() {
        parts.push(format!("\n## Description\n{}", body));
    }
    if !frontmatter.todos.is_empty() {
        parts.push("\n## Acceptance Criteria".to_string());
        for todo in &frontmatter.todos {
            let check = if todo.status == super::helpers::TODO_STATUS_COMPLETED {
                "x"
            } else {
                " "
            };
            parts.push(format!("- [{}] {}", check, todo.content));
        }
    }
    parts.join("\n")
}

fn parse_agent_defs_for_execution(
    content: &str,
    path: &std::path::Path,
) -> Result<Vec<crate::definitions::AgentDefinition>, String> {
    serde_json::from_str(content).map_err(|err| {
        format!(
            "parse agent definitions for work-item launch from {}: {}",
            path.display(),
            err
        )
    })
}

fn parse_agent_orgs_for_execution(
    content: &str,
    path: &std::path::Path,
) -> Result<Vec<crate::definitions::orgs::OrgDefinition>, String> {
    serde_json::from_str(content).map_err(|err| {
        format!(
            "parse agent organizations for work-item launch from {}: {}",
            path.display(),
            err
        )
    })
}

/// `#[doc(hidden)]` — only the `app::api::agent::test::core` debug
/// route calls this, via the `agent_core::tool_infra::*` re-export.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn debug_parse_work_item_launch_sources(kind: &str, content: &str) -> Result<usize, String> {
    match kind {
        "agent_definitions" => parse_agent_defs_for_execution(
            content,
            std::path::Path::new("work-item-agent-definitions-test.json"),
        )
        .map(|items| items.len()),
        "agent_orgs" => parse_agent_orgs_for_execution(
            content,
            std::path::Path::new("work-item-agent-orgs-test.json"),
        )
        .map(|items| items.len()),
        _ => Err(format!("unknown work-item launch source kind: {kind}")),
    }
}

/// Load a full AgentDefinition by its ID (for account/model resolution).
fn load_agent_def(def_id: &str) -> Result<crate::definitions::AgentDefinition, String> {
    let store = crate::definitions::definitions_store();
    if crate::definitions::builtin::is_builtin_agent(def_id) {
        return crate::definitions::resolve_definition_by_id(def_id, Some(&store));
    }

    let defs_path = app_paths::agent_definitions();
    if !defs_path.exists() {
        return Err(format!(
            "agent definition '{}' is referenced by the work item but {} does not exist",
            def_id,
            defs_path.display()
        ));
    }
    let content = std::fs::read_to_string(&defs_path).map_err(|err| {
        format!(
            "read agent definitions for work-item launch from {}: {}",
            defs_path.display(),
            err
        )
    })?;
    let defs = parse_agent_defs_for_execution(&content, &defs_path)?;
    defs.into_iter()
        .find(|definition| definition.id == def_id)
        .ok_or_else(|| {
            format!(
                "agent definition '{}' is referenced by the work item but was not found in {}",
                def_id,
                defs_path.display()
            )
        })
}

/// Resolve agent_definition_id from assignee when not explicitly set in config.
fn resolve_agent_def_id_from_assignee(
    frontmatter: &WorkItemFrontmatter,
) -> Result<Option<String>, String> {
    match frontmatter.assignee_type.as_deref() {
        Some("agent") => Ok(frontmatter.assignee.clone().filter(|s| !s.is_empty())),
        Some("org") => {
            let Some(org_id) = frontmatter.assignee.as_deref().filter(|s| !s.is_empty()) else {
                return Ok(None);
            };
            let orgs_path = app_paths::agent_orgs();
            if !orgs_path.exists() {
                return Err(format!(
                    "agent organization '{}' is referenced by the work item but {} does not exist",
                    org_id,
                    orgs_path.display()
                ));
            }
            let content = std::fs::read_to_string(&orgs_path).map_err(|err| {
                format!(
                    "read agent organizations for work-item launch from {}: {}",
                    orgs_path.display(),
                    err
                )
            })?;
            let orgs = parse_agent_orgs_for_execution(&content, &orgs_path)?;
            let org = orgs
                .iter()
                .find(|org| org.id == org_id)
                .ok_or_else(|| {
                    format!(
                        "agent organization '{}' is referenced by the work item but was not found in {}",
                        org_id,
                        orgs_path.display()
                    )
                })?;
            if org.agent_id.is_empty() {
                return Err(format!(
                    "agent organization '{}' has an empty agent_id and cannot launch a work item",
                    org_id
                ));
            }
            Ok(Some(org.agent_id.clone()))
        }
        _ => Ok(None),
    }
}

/// Resolved launch context shared by initial starts and phase launches
/// (review / fix / retry).
struct LaunchContext {
    data: WorkItemData,
    project_description: Option<String>,
    config: OrchestratorConfig,
    agent_def_id: Option<String>,
    agent_def: Option<crate::definitions::AgentDefinition>,
    account_id: String,
    model_id: String,
    worktree_path: String,
    workspace_mode: project_management::projects::types::WorkspaceExecutionMode,
    linked_repos: Vec<String>,
    repository: Option<String>,
    repository_ref: Option<String>,
    default_branch: Option<String>,
}

async fn resolve_launch_context(
    project_slug: &str,
    short_id: &str,
    session_account_id: Option<&str>,
    session_model_id: Option<&str>,
    execution_snapshot: Option<&project_management::projects::types::WorkItemRunTargetSnapshot>,
) -> Result<LaunchContext, String> {
    let slug = project_slug.to_string();
    let sid = short_id.to_string();

    let mut data = run_blocking("start_read_work_item", {
        let slug = slug.clone();
        let sid = sid.clone();
        move || io::read_work_item(&slug, &sid)
    })
    .await?;

    if let Some(snapshot) = execution_snapshot {
        if let Some(title) = snapshot.work_item_title.as_ref() {
            data.frontmatter.title = title.clone();
        }
        if let Some(body) = snapshot.work_item_body.as_ref() {
            data.body = body.clone();
        }
    }

    let config = data
        .frontmatter
        .orchestrator_config
        .clone()
        .unwrap_or_default();

    let agent_def_id = match config.agent_definition_id.clone().filter(|s| !s.is_empty()) {
        Some(definition_id) => Some(definition_id),
        None => resolve_agent_def_id_from_assignee(&data.frontmatter)?,
    };

    let agent_def = match agent_def_id.as_ref() {
        Some(definition_id) => Some(tokio::task::block_in_place(|| {
            load_agent_def(definition_id)
        })?),
        None => None,
    };

    let config_account = config.selected_account_id.clone();
    let config_model = config.selected_model_id.clone();

    let (account_id, model_id) = if let Some(session_acct) =
        session_account_id.filter(|s| !s.is_empty())
    {
        let from_session = session_model_id.filter(|s| !s.is_empty());
        let from_agent_def = agent_def
            .as_ref()
            .and_then(|d| d.selected_model_id.as_ref())
            .filter(|s| !s.is_empty());
        let from_item = config_model.as_ref().filter(|s| !s.is_empty());
        let model_id = if let Some(m) = from_session {
            m.to_string()
        } else if let Some(m) = from_agent_def {
            m.clone()
        } else if let Some(m) = from_item {
            m.clone()
        } else {
            return Err(
                "Cannot start: session has a code account but no model. \
                 Set the agent model in settings or configure selected_model_id on the work item."
                    .to_string(),
            );
        };
        (session_acct.to_string(), model_id)
    } else {
        let def_account = agent_def
            .as_ref()
            .and_then(|d| d.selected_account_id.clone())
            .filter(|s| !s.is_empty());
        let def_model = agent_def
            .as_ref()
            .and_then(|d| d.selected_model_id.clone())
            .filter(|s| !s.is_empty());

        let account_id = def_account.or(config_account).ok_or(
            "Cannot start: no selected_account_id. Configure a code account on the agent definition or in Agent Settings.",
        )?;
        let model_id = def_model
            .or(config_model.filter(|s| !s.is_empty()))
            .ok_or(
                "Cannot start: selected_model_id is missing. \
                 Set a model on the agent definition or use update_item to set one on the work item.",
            )?;
        (account_id, model_id)
    };

    // Resolve host repo: config.worktree_path → linked_repos first valid dir.
    let project_data = {
        let slug_for_read = slug.clone();
        run_blocking("read_project_meta", move || {
            io::read_project(&slug_for_read)
        })
        .await?
    };

    let linked_repos: Vec<String> = execution_snapshot
        .filter(|snapshot| !snapshot.linked_repositories.is_empty())
        .map(|snapshot| snapshot.linked_repositories.clone())
        .unwrap_or_else(|| {
            project_data
                .meta
                .linked_repos
                .iter()
                .filter(|repo| !repo.is_empty())
                .cloned()
                .collect()
        });

    let snapshotted_path = execution_snapshot
        .and_then(|snapshot| snapshot.workspace_path.as_ref())
        .filter(|path| !path.trim().is_empty());
    let has_configured_workspace = config
        .worktree_path
        .as_deref()
        .is_some_and(|path| !path.is_empty() && std::path::Path::new(path).is_dir());
    let worktree_path = if let Some(path) = snapshotted_path {
        if !std::path::Path::new(path).is_dir() {
            return Err(format!(
                "Cannot start: snapshotted workspace '{}' is no longer available",
                path
            ));
        }
        path.clone()
    } else {
        config
            .worktree_path
            .as_ref()
            .filter(|p| !p.is_empty() && std::path::Path::new(p).is_dir())
            .cloned()
            .or_else(|| {
                linked_repos
                    .iter()
                    .find(|r| std::path::Path::new(r).is_dir())
                    .cloned()
            })
            .ok_or(
                "Cannot start: no host repo. Set the project's linked_repos or the work item's worktree_path."
                    .to_string(),
            )?
    };
    let default_workspace_mode = if has_configured_workspace {
        project_management::projects::types::WorkspaceExecutionMode::Worktree
    } else {
        project_management::projects::types::WorkspaceExecutionMode::LocalWorkspace
    };
    let workspace_mode = execution_snapshot
        .and_then(|snapshot| snapshot.workspace_mode)
        .or(config.workspace_mode)
        .unwrap_or(default_workspace_mode);

    Ok(LaunchContext {
        data,
        project_description: execution_snapshot
            .and_then(|snapshot| snapshot.project_description.clone())
            .or_else(|| {
                (!project_data.description.trim().is_empty()).then_some(project_data.description)
            }),
        config,
        agent_def_id,
        agent_def,
        account_id,
        model_id,
        worktree_path,
        workspace_mode,
        linked_repos,
        repository: execution_snapshot.and_then(|snapshot| snapshot.repository.clone()),
        repository_ref: execution_snapshot.and_then(|snapshot| snapshot.repository_ref.clone()),
        default_branch: execution_snapshot.and_then(|snapshot| snapshot.default_branch.clone()),
    })
}

fn append_workspace_section(prompt: &mut String, ctx: &LaunchContext) {
    if ctx.linked_repos.is_empty() && ctx.project_description.is_none() {
        return;
    }
    prompt.push_str("\n\n## Project Workspace\n");
    if let Some(description) = ctx.project_description.as_deref() {
        prompt.push_str("Project context:\n");
        prompt.push_str(description);
        prompt.push('\n');
    }
    prompt.push_str(&format!("Primary repo: `{}`\n", ctx.worktree_path));
    if let Some(repository) = ctx.repository.as_deref() {
        prompt.push_str(&format!("Repository: `{repository}`\n"));
    }
    if let Some(repository_ref) = ctx.repository_ref.as_deref() {
        prompt.push_str(&format!("Pinned revision: `{repository_ref}`\n"));
    }
    if let Some(default_branch) = ctx.default_branch.as_deref() {
        prompt.push_str(&format!("Default branch: `{default_branch}`\n"));
    }
    if ctx.linked_repos.len() > 1
        || ctx.linked_repos.first().map(|r| r.as_str()) != Some(ctx.worktree_path.as_str())
    {
        prompt.push_str("All linked repos:\n");
        for linked_repo in &ctx.linked_repos {
            prompt.push_str(&format!("- `{}`\n", linked_repo));
        }
        prompt.push_str(
            "You can navigate to any of these repos if the task requires cross-repo work.\n",
        );
    }
}

/// Start a work item's orchestrator workflow and launch an agent session.
///
/// Does everything the frontend does in one call:
///   1. Validates orchestrator config (must have account_id)
///   2. Runs orchestrator_start (snapshot config, set phase)
///   3. Builds the agent prompt from work item content
///   4. Creates and starts an agent session in background
///
/// The host repo for the agent session is resolved from
/// `frontmatter.orchestrator_config.worktree_path` first, then from the
/// project's `linked_repos[0]`. Returns a human-readable summary with the
/// session ID.
///
/// When `session_account_id` is set (non-empty), that account is used for the
/// agent session launch even if the work item omits `selected_account_id`.
/// Model resolution: session override (`session_model_id`) if non-empty,
/// otherwise `selected_model_id` from the work item.
pub async fn start_work_item(
    project_slug: &str,
    short_id: &str,
    app: &tauri::AppHandle,
    session_account_id: Option<&str>,
    session_model_id: Option<&str>,
) -> Result<String, String> {
    start_work_item_with_reason(
        project_slug,
        short_id,
        app,
        session_account_id,
        session_model_id,
        WorkItemExecutionLockReason::ManualStart,
    )
    .await
}

/// [`start_work_item`] with an explicit execution-lock reason so
/// scheduler/routine-originated starts are attributed correctly.
pub async fn start_work_item_with_reason(
    project_slug: &str,
    short_id: &str,
    app: &tauri::AppHandle,
    session_account_id: Option<&str>,
    session_model_id: Option<&str>,
    lock_reason: WorkItemExecutionLockReason,
) -> Result<String, String> {
    let started = start_work_item_session_with_reason(StartWorkItemSessionRequest {
        project_slug,
        short_id,
        app,
        session_account_id,
        session_model_id,
        lock_reason,
        durable_run_id: None,
        execution_snapshot: None,
    })
    .await?;

    Ok(format!(
        "Started work item {} execution.\n\
         Session: {}\n\
         Agent: {}\n\
         Model: {}\n\
         Account: {}\n\n\
         The agent is now running in the background. \
         Use session(action=\"list\") or session(action=\"get_status\") to check progress.",
        short_id, started.session_id, started.agent_role, started.model_id, started.account_id
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedWorkItemSession {
    pub session_id: String,
    pub agent_role: String,
    pub model_id: String,
    pub account_id: String,
}

/// Complete, immutable input to a Work Item session launch. Keeping the
/// durable identity and execution snapshot beside the human-selected runtime
/// fields makes dispatcher redelivery harder to call with a mismatched set of
/// arguments.
pub struct StartWorkItemSessionRequest<'a> {
    pub project_slug: &'a str,
    pub short_id: &'a str,
    pub app: &'a tauri::AppHandle,
    pub session_account_id: Option<&'a str>,
    pub session_model_id: Option<&'a str>,
    pub lock_reason: WorkItemExecutionLockReason,
    pub durable_run_id: Option<&'a str>,
    pub execution_snapshot:
        Option<&'a project_management::projects::types::WorkItemRunTargetSnapshot>,
}

/// Typed durable launch entry point used by the dispatch worker. A stable
/// Run id makes both Session creation and first-turn acceptance idempotent.
pub async fn start_work_item_session_with_reason(
    request: StartWorkItemSessionRequest<'_>,
) -> Result<StartedWorkItemSession, String> {
    use project_management::orchestrator::state_machine;

    let StartWorkItemSessionRequest {
        project_slug,
        short_id,
        app,
        session_account_id,
        session_model_id,
        lock_reason,
        durable_run_id,
        execution_snapshot,
    } = request;

    let slug = project_slug.to_string();
    let sid = short_id.to_string();

    let ctx = resolve_launch_context(
        project_slug,
        short_id,
        session_account_id,
        session_model_id,
        execution_snapshot,
    )
    .await?;

    let (agent_role, mut prompt) = if let Some(ref definition) = ctx.agent_def {
        let prompt = build_agent_prompt(&sid, &ctx.data.frontmatter, &ctx.data.body);
        (definition.name.clone(), prompt)
    } else {
        (
            "sde".to_string(),
            build_project_prompt(&sid, &ctx.data.frontmatter, &ctx.data.body),
        )
    };

    append_workspace_section(&mut prompt, &ctx);

    let linked_role = if ctx.agent_def_id.is_some() {
        AgentRole::Custom
    } else {
        AgentRole::Coding
    };
    let durable_redelivery = durable_run_id.is_some();

    run_blocking("orchestrator_start", {
        let slug = slug.clone();
        let sid = sid.clone();
        move || {
            io::update_work_item_atomic(&slug, &sid, |frontmatter, _body| {
                let current_phase = frontmatter
                    .orchestrator_state
                    .as_ref()
                    .map(|s| &s.current_phase)
                    .unwrap_or(&OrchestratorPhase::Idle);

                let is_durable_dispatch = durable_redelivery
                    && matches!(
                        current_phase,
                        OrchestratorPhase::Coding
                            | OrchestratorPhase::Failed
                            | OrchestratorPhase::Completed
                            | OrchestratorPhase::AwaitingUser
                    );
                if !matches!(current_phase, OrchestratorPhase::Idle) && !is_durable_dispatch {
                    return Err(format!(
                        "Cannot start: orchestrator is in phase '{:?}', expected idle",
                        current_phase
                    ));
                }

                let needs_new_episode = matches!(current_phase, OrchestratorPhase::Idle)
                    || (is_durable_dispatch && !matches!(current_phase, OrchestratorPhase::Coding));
                if needs_new_episode {
                    state_machine::snapshot_config(frontmatter);
                    state_machine::add_linked_session(
                        frontmatter,
                        "pending",
                        linked_role,
                        LinkedSessionType::Native,
                    );
                }
                frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
                Ok(())
            })
        }
    })
    .await?;

    {
        use tauri::Emitter;
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = app.emit(
            project_management::projects::events::DATA_CHANGED_EVENT,
            &ts,
        );
    }

    let session_id = crate::session::launch::launch_agent_session(
        app,
        crate::session::launch::WorkItemLaunchRequest {
            durable_run_id,
            workspace_path: &ctx.worktree_path,
            prompt: &prompt,
            model: &ctx.model_id,
            account_id: &ctx.account_id,
            work_item_id: &sid,
            project_slug: &slug,
            worktree_path: matches!(
                ctx.workspace_mode,
                project_management::projects::types::WorkspaceExecutionMode::Worktree
            )
            .then_some(ctx.worktree_path.as_str()),
            agent_definition_id: ctx.agent_def_id.as_deref(),
            agent_role: &agent_role,
            sub_agent_ids: ctx.config.sub_agent_ids.as_slice(),
            lock_reason,
        },
    )
    .await?;

    Ok(StartedWorkItemSession {
        session_id,
        agent_role,
        model_id: ctx.model_id,
        account_id: ctx.account_id,
    })
}

/// Which post-transition session the orchestrator needs launched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseLaunch {
    /// Coding failed and auto-retry is on; phase is already back at Coding —
    /// relaunch the owner agent.
    Retry,
}

/// Launch the session demanded by an orchestrator transition (RetryAgent).
/// Unlike [`start_work_item`] this does NOT run `snapshot_config` or phase
/// validation: the state machine has already performed the transition; we
/// only materialize the session.
pub async fn launch_phase_session(
    project_slug: &str,
    short_id: &str,
    app: &tauri::AppHandle,
    phase: PhaseLaunch,
) -> Result<String, String> {
    let PhaseLaunch::Retry = phase;
    let ctx = resolve_launch_context(project_slug, short_id, None, None, None).await?;

    let mut prompt = if ctx.agent_def.is_some() {
        build_agent_prompt(short_id, &ctx.data.frontmatter, &ctx.data.body)
    } else {
        build_project_prompt(short_id, &ctx.data.frontmatter, &ctx.data.body)
    };
    let agent_role = ctx
        .agent_def
        .as_ref()
        .map(|d| d.name.clone())
        .unwrap_or_else(|| "sde".to_string());

    append_workspace_section(&mut prompt, &ctx);

    let agent_definition_id = ctx.agent_def_id.clone();

    let session_id = crate::session::launch::launch_agent_session(
        app,
        crate::session::launch::WorkItemLaunchRequest {
            durable_run_id: None,
            workspace_path: &ctx.worktree_path,
            prompt: &prompt,
            model: &ctx.model_id,
            account_id: &ctx.account_id,
            work_item_id: short_id,
            project_slug,
            worktree_path: matches!(
                ctx.workspace_mode,
                project_management::projects::types::WorkspaceExecutionMode::Worktree
            )
            .then_some(ctx.worktree_path.as_str()),
            agent_definition_id: agent_definition_id.as_deref(),
            agent_role: &agent_role,
            sub_agent_ids: ctx.config.sub_agent_ids.as_slice(),
            lock_reason: WorkItemExecutionLockReason::FollowUp,
        },
    )
    .await?;

    {
        use tauri::Emitter;
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = app.emit(
            project_management::projects::events::DATA_CHANGED_EVENT,
            &ts,
        );
    }

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::{parse_agent_defs_for_execution, parse_agent_orgs_for_execution};

    #[test]
    fn parse_agent_defs_for_execution_reports_invalid_json() {
        let err = parse_agent_defs_for_execution("{ invalid", std::path::Path::new("agents.json"))
            .unwrap_err();

        assert!(
            err.contains("parse agent definitions for work-item launch"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_agent_orgs_for_execution_reports_invalid_json() {
        let err = parse_agent_orgs_for_execution("{ invalid", std::path::Path::new("orgs.json"))
            .unwrap_err();

        assert!(
            err.contains("parse agent organizations for work-item launch"),
            "got: {err}"
        );
    }
}
