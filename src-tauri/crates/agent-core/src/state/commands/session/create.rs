//! Session creation logic.

use crate::definitions::prefix_lookup::PENDING_SESSION_PLACEHOLDER;
use crate::session::persistence as session_persistence;
use core_types::key_source::KeySource;
use core_types::providers::NativeHarnessType;
use project_management::projects::types::PERSONAL_ORG_ID;

/// Default agent type when none is provided by the caller.
const DEFAULT_AGENT_TYPE: &str = "sde";

/// Map session context to a session ID prefix.
///
/// When an explicit agent definition is provided we look it up in the
/// `BUILTIN_PREFIX_REGISTRY`; otherwise we fall back to the legacy
/// heuristic (workspace_path → SDE, no workspace_path → OS).
pub(super) fn resolve_session_prefix(
    agent_definition_id: Option<&str>,
    has_workspace_path: bool,
) -> &'static str {
    crate::definitions::prefix_lookup::session_prefix_for_launch(
        agent_definition_id,
        has_workspace_path,
    )
}

/// Helper: build a fresh Rust-agent session row + `SessionRuntime`.
///
/// Called from `session_launch_impl` (the unified create + send Tauri
/// command). The retired `agent_create_session` command used to be the
/// other caller before the unified launch landed — see commit history.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_session_impl(
    agent_type: Option<String>,
    workspace_path: String,
    model: Option<String>,
    account_id: Option<String>,
    name: Option<String>,
    org_id: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
    work_item_id: Option<String>,
    agent_role: Option<String>,
    worktree_path: Option<String>,
    project_slug: Option<String>,
    agent_definition_id: Option<String>,
    key_source: Option<String>,
    agent_exec_mode: Option<String>,
    product_mode: Option<String>,
    native_harness_type: Option<String>,
    parent_session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    // Trace the incoming key_source so drift between frontend and
    // backend posture is visible in logs. The field is now persisted
    // end-to-end on the rust-agent path (`agent_sessions.key_source`
    // column + typed `UnifiedSessionRecord.key_source`), wired below.
    if let Some(ref ks) = key_source {
        tracing::debug!(key_source = %ks, "[session] create_session_impl key_source");
    }

    // Wire-typo guard for `key_source` — same fail-closed posture as the
    // CLI session create path. Accepting an unvalidated string here would
    // leave us with two failure modes downstream: either the row mapper
    // would reject the row at every read (session "created but
    // unloadable") or — pre-typed-mapper — the value would silently
    // default to `own_key` and mis-bill a market session.
    let resolved_key_source = match key_source.as_deref().filter(|s| !s.is_empty()) {
        Some(raw) => KeySource::parse(raw).ok_or_else(|| format!("Unknown key_source: {raw:?}"))?,
        None => KeySource::default(),
    };

    let resolved_native_harness_type =
        match native_harness_type.as_deref().filter(|s| !s.is_empty()) {
            Some(raw) => Some(
                NativeHarnessType::parse(raw)
                    .ok_or_else(|| format!("Unknown native_harness_type: {raw:?}"))?
                    .as_str()
                    .to_string(),
            ),
            None => None,
        };

    let has_project = !workspace_path.is_empty();
    let effective_agent_type = match agent_type.as_deref().filter(|s| !s.is_empty()) {
        Some(t) => t,
        None => {
            let default = if has_project {
                DEFAULT_AGENT_TYPE
            } else {
                session_persistence::session_type::DESKTOP
            };
            tracing::debug!(
                "[session] No agent_type provided, defaulting to '{}'",
                default
            );
            default
        }
    };
    let prefix = resolve_session_prefix(agent_definition_id.as_deref(), has_project);
    let session_id = format!("{}{}", prefix, uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let effective_model = match model {
        Some(m) if !m.is_empty() => m,
        _ => return Err("model is required when creating a session".into()),
    };

    let resolved_org_id = org_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PERSONAL_ORG_ID.to_string());
    let wid_for_link = work_item_id.clone();
    let slug_for_link = project_slug.clone();

    let session = session_persistence::UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: name.unwrap_or_else(|| "New coding session".to_string()),
        status: crate::session::SessionStatus::Idle.as_str().to_owned(),
        model: Some(effective_model.clone()),
        account_id,
        workspace_path: Some(workspace_path.clone()),
        org_id: Some(resolved_org_id),
        project_id,
        project_name,
        user_input: None,
        total_tokens: 0,
        created_at: now.clone(),
        updated_at: now,
        session_type: effective_agent_type.to_string(),
        work_item_id,
        agent_role,
        worktree_path,
        project_slug,
        agent_definition_id,
        parent_session_id,
        key_source: resolved_key_source,
        // Persist the user's launch-time mode choice (from `SessionLaunchParams.mode`)
        // so the row reflects the ModePill selection from the very first turn,
        // instead of staying NULL until the user clicks the in-session pill.
        // Empty/whitespace strings are treated as "no choice" so we don't trip
        // the dispatcher's mode parser with an empty value.
        agent_exec_mode: agent_exec_mode.filter(|m| !m.trim().is_empty()),
        // Product-mode resolver (orgtrack/v1 frozen decisions §1), fixed
        // precedence: launched from a WorkItem/Routine → project; the
        // user's explicit launch-time choice; else NULL (= build). Never
        // inferred from exec mode, query length or agent judgment.
        product_mode: if wid_for_link.is_some() {
            Some("project".to_string())
        } else {
            product_mode.filter(|m| {
                matches!(m.as_str(), "build" | "plan" | "ask" | "project")
            })
        },
        native_harness_type: resolved_native_harness_type,
        ..Default::default()
    };

    tokio::task::spawn_blocking(move || session_persistence::upsert_session(&session))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    tracing::info!("[agent_session] Created session: {}", session_id);

    if let Some(ref wid) = wid_for_link {
        let sid = session_id.clone();
        let wid = wid.clone();
        let slug = slug_for_link;
        let link_result = tokio::task::spawn_blocking(move || {
            use project_management::orchestrator::state_machine;
            use project_management::projects::io as projects_io;

            let replace_pending = |project_slug: &str| -> Result<(), String> {
                state_machine::mutate_work_item(project_slug, &wid, |fm| {
                    if let Some(pending) = fm
                        .linked_sessions
                        .iter_mut()
                        .rev()
                        .find(|ls| ls.session_id == PENDING_SESSION_PLACEHOLDER)
                    {
                        pending.session_id = sid.clone();
                    }
                    state_machine::TransitionResult::Completed
                })?;
                Ok(())
            };

            if let Some(ref slug) = slug {
                replace_pending(slug)
            } else {
                let projects = projects_io::read_all_projects()
                    .map_err(|err| format!("Failed to read projects: {}", err))?;
                for project in &projects {
                    let items = projects_io::read_all_work_items(&project.slug).map_err(|err| {
                        format!("Failed to read work items for {}: {}", project.slug, err)
                    })?;
                    if items.iter().any(|wi| wi.frontmatter.short_id == wid) {
                        return replace_pending(&project.slug);
                    }
                }
                Err("Work item not found in any project".to_string())
            }
        })
        .await;
        match link_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::error!(
                    "[agent_session] Failed to replace pending session link: {}",
                    err
                );
            }
            Err(err) => {
                tracing::error!(
                    "[agent_session] Task panicked replacing pending link: {}",
                    err
                );
            }
        }
    }

    Ok(serde_json::json!({
        "sessionId": session_id,
        "workspacePath": workspace_path,
    }))
}
