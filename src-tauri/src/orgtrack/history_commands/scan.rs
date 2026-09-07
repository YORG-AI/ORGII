use super::*;

use super::projection::open_cache_conn;

fn external_history_scan_coordinator() -> &'static ExternalHistoryScanCoordinator {
    static COORDINATOR: OnceLock<ExternalHistoryScanCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(ExternalHistoryScanCoordinator::default)
}
pub(super) fn imported_recent_paths(
) -> Result<Vec<imported_history::ImportedHistoryRecentPath>, String> {
    let mut conn = open_cache_conn()?;
    let mut paths = codex_app::list_codex_app_recent_paths(&mut conn, 0)?;
    paths.extend(claude_code_history::list_claude_code_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(cursor_cli_history::list_cursor_cli_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(opencode_history::list_opencode_recent_paths(&mut conn, 0)?);
    paths.extend(windsurf_history::list_windsurf_recent_paths(&mut conn, 0)?);
    paths.extend(workbuddy_history::list_workbuddy_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(trae_history::list_trae_recent_paths(&mut conn, 0)?);
    paths.extend(cline_history::list_cline_recent_paths(&mut conn, 0)?);
    paths.extend(warp_history::list_warp_recent_paths(&mut conn, 0)?);
    paths.extend(zcode_history::list_zcode_recent_paths(&mut conn, 0)?);
    paths.extend(qoder_history::list_qoder_recent_paths(&mut conn, 0)?);
    paths.extend(mimo_code_history::list_mimo_code_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(omp_history::list_omp_recent_paths(&mut conn, 0)?);
    paths.extend(pi_history::list_pi_recent_paths(&mut conn, 0)?);
    paths.extend(qoder_cli_history::list_qoder_cli_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(qwen_code_history::list_qwen_code_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(kimi_history::list_kimi_recent_paths(&mut conn, 0)?);
    Ok(imported_history::recent_paths_from_paths(&paths))
}

/// Rescan one external history source.
///
/// The default path incrementally parses records whose stored signature
/// changed. `clear = true` first removes the source cache, forcing a complete
/// rebuild.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistoryScanResultWire {
    pub changed_sources: Vec<String>,
    /// Whole-source cache signatures for every rescanned source, changed or
    /// not. Concurrent callers for the same source share one scan flight and
    /// therefore receive the same change result. Other surfaces (kanban,
    /// usage, transcript pagers) sync the same cache between scheduler ticks,
    /// and continuation demotions applied during those foreign syncs would
    /// otherwise never look like a change here. The frontend compares these
    /// against the signatures captured at its last roster reload to decide
    /// whether the sidebar is stale.
    pub source_signatures: std::collections::HashMap<String, String>,
}

pub(super) fn external_history_scan_mode(clear: bool) -> ExternalHistoryScanMode {
    if clear {
        ExternalHistoryScanMode::Rebuild
    } else {
        ExternalHistoryScanMode::Incremental
    }
}

fn run_external_history_scan_jobs(
    coordinator: &ExternalHistoryScanCoordinator,
    jobs: Vec<ExternalHistoryScanJob>,
) -> Vec<(ExternalHistoryScanJob, ExternalHistorySourceScanOutcome)> {
    let mut conn = match open_cache_conn() {
        Ok(conn) => conn,
        Err(error) => {
            return jobs
                .into_iter()
                .map(|job| (job, Err(error.clone())))
                .collect();
        }
    };

    jobs.into_iter()
        // A rebuild can supersede one source while an already-claimed
        // scan-all batch is still parsing an earlier source.
        .filter(|job| coordinator.is_current_running_job(job))
        .map(|job| {
            let outcome = (|| {
                let changes_before = conn.total_changes();
                // Rebuild is explicit: wipe this source's cached rows so all
                // sessions are parsed again. Incremental remains the default.
                if job.mode == ExternalHistoryScanMode::Rebuild {
                    imported_history::cache::prune_missing_records_from_conn(
                        &conn,
                        &job.source,
                        &[],
                    )?;
                }
                let changed = crate::agent_sessions::session_directory::aggregation::resync_external_history_source(
                    &mut conn,
                    &job.source,
                )? || conn.total_changes() > changes_before;
                let signature =
                    imported_history::cache::query_source_cache_signature_from_conn(
                        &conn,
                        &job.source,
                    )?;
                Ok(ExternalHistorySourceScanResult { changed, signature })
            })();
            (job, outcome)
        })
        .collect()
}

fn launch_external_history_scan_jobs(jobs: Vec<ExternalHistoryScanJob>) {
    if jobs.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let coordinator = external_history_scan_coordinator();
        let _permit = match coordinator.acquire_permit().await {
            Ok(permit) => permit,
            Err(error) => {
                coordinator.fail_current_jobs(jobs, error);
                return;
            }
        };
        let jobs = coordinator.begin_current_jobs(jobs);
        if jobs.is_empty() {
            return;
        }
        let fallback_jobs = jobs.clone();
        let outcomes = match tokio::task::spawn_blocking(move || {
            run_external_history_scan_jobs(coordinator, jobs)
        })
        .await
        {
            Ok(outcomes) => outcomes,
            Err(error) => fallback_jobs
                .into_iter()
                .map(|job| (job, Err(format!("Task join error: {error}"))))
                .collect(),
        };
        coordinator.complete_jobs(outcomes);
    });
}

async fn external_history_rescan_validated_sources(
    sources: Vec<String>,
    mode: ExternalHistoryScanMode,
) -> Result<ExternalHistoryScanResultWire, String> {
    let schedule = external_history_scan_coordinator().schedule(sources.clone(), mode);
    launch_external_history_scan_jobs(schedule.jobs);
    let results = schedule.waiter.wait().await?;
    let changed_sources = sources
        .iter()
        .filter(|source| results.get(*source).is_some_and(|result| result.changed))
        .cloned()
        .collect();
    let source_signatures = results
        .into_iter()
        .map(|(source, result)| (source, result.signature))
        .collect();
    Ok(ExternalHistoryScanResultWire {
        changed_sources,
        source_signatures,
    })
}

#[tauri::command]
pub async fn external_history_rescan_source(
    source: String,
    clear: bool,
) -> Result<ExternalHistoryScanResultWire, String> {
    if !imported_history::metadata::is_imported_history_source(&source) {
        return Err(format!("Unknown external history source: {source}"));
    }
    // The normal path is signature-based incremental sync. Provider parser
    // version changes remain part of those signatures and force the affected
    // records to re-parse without clearing unrelated cached rows.
    let mode = external_history_scan_mode(clear);
    external_history_rescan_validated_sources(vec![source], mode).await
}

/// Incrementally update multiple external history sources in one IPC request.
///
/// Sources are processed through one cache connection. This is the app-startup
/// and scheduled auto-scan path; keeping it batched avoids one frontend/native
/// round trip per installed provider.
#[tauri::command]
pub async fn external_history_rescan_sources(
    sources: Vec<String>,
    clear: bool,
) -> Result<ExternalHistoryScanResultWire, String> {
    let mut seen_sources = HashSet::with_capacity(sources.len());
    for source in &sources {
        if !seen_sources.insert(source.as_str()) {
            return Err(format!("Duplicate external history source: {source}"));
        }
        if !imported_history::metadata::is_imported_history_source(source) {
            return Err(format!("Unknown external history source: {source}"));
        }
    }

    let mode = external_history_scan_mode(clear);
    external_history_rescan_validated_sources(sources, mode).await
}

/// [`orgtrack_core::sources::cli_resume::CliResumePlan`] plus the two
/// freshness checks only the desktop host can answer: whether the recorded
/// workspace directory and the source transcript/store are still on disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistoryCliResumePlanWire {
    #[serde(flatten)]
    pub plan: orgtrack_core::sources::cli_resume::CliResumePlan,
    pub display_command: String,
    pub cwd_exists: bool,
    pub source_available: bool,
}

fn external_history_cli_resume_plan_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<ExternalHistoryCliResumePlanWire>, String> {
    let Some((plan, session)) =
        orgtrack_core::sources::cli_resume::cli_resume_plan_for_cached_session(conn, session_id)?
    else {
        return Ok(None);
    };
    let cwd_exists = plan
        .cwd
        .as_deref()
        .is_some_and(|path| Path::new(path).is_dir());
    let source_available =
        !session.source_path.is_empty() && Path::new(&session.source_path).exists();
    if source_available
        && plan.source == imported_history::metadata::SOURCE_CODEX_APP
        && !orgtrack_core::sources::cli_resume::codex_cli_resume_supports_path(Path::new(
            &session.source_path,
        ))?
    {
        return Ok(None);
    }
    Ok(Some(ExternalHistoryCliResumePlanWire {
        display_command: plan.display_command(),
        plan,
        cwd_exists,
        source_available,
    }))
}

/// Plan how to reopen an imported external session in its own CLI.
/// `Ok(None)` when the session is unknown, a subagent child, or its source
/// has no CLI resume entry point (e.g. Cursor IDE composers).
#[tauri::command]
pub async fn external_history_cli_resume_plan(
    session_id: String,
) -> Result<Option<ExternalHistoryCliResumePlanWire>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        external_history_cli_resume_plan_from_conn(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Resolve the mobile-writable Codex subset for one already-bounded session
/// page. One blocking task and one cache connection serve the whole page;
/// each Codex rollout read is capped to its leading metadata prefix.
pub async fn external_history_mobile_writable_codex_session_ids(
    session_ids: Vec<String>,
) -> Result<HashSet<String>, String> {
    if session_ids.is_empty() {
        return Ok(HashSet::new());
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let mut writable = HashSet::with_capacity(session_ids.len());
        for session_id in session_ids {
            let Ok(Some(plan)) = external_history_cli_resume_plan_from_conn(&conn, &session_id)
            else {
                // One malformed/unreadable imported record must fail closed as
                // read-only without hiding the rest of the desktop Sidebar.
                continue;
            };
            if plan.plan.source == imported_history::metadata::SOURCE_CODEX_APP
                && plan.source_available
                && (!plan.plan.requires_cwd || plan.cwd_exists)
            {
                writable.insert(session_id);
            }
        }
        Ok(writable)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// [`orgtrack_core::sources::app_open::AppOpenPlan`] plus the freshness
/// check only the desktop host can answer: whether the source transcript
/// the app resolves the conversation from is still on disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistoryAppOpenPlanWire {
    #[serde(flatten)]
    pub plan: orgtrack_core::sources::app_open::AppOpenPlan,
    pub source_available: bool,
}

fn external_history_app_open_plan_from_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<ExternalHistoryAppOpenPlanWire>, String> {
    if let Some((plan, session)) =
        orgtrack_core::sources::app_open::app_open_plan_for_cached_session(conn, session_id)?
    {
        let source_available =
            !session.source_path.is_empty() && Path::new(&session.source_path).exists();
        return Ok(Some(ExternalHistoryAppOpenPlanWire {
            plan,
            source_available,
        }));
    }

    // Managed native sessions use their current account/profile binding, not
    // the append-only discovery ledger: after A -> B -> A, this must open the
    // same native conversation the next CLI turn will resume.
    let Some(session) = crate::agent_sessions::cli::persistence::get_session(session_id)
        .map_err(|error| format!("Failed to read managed session {session_id}: {error}"))?
    else {
        return Ok(None);
    };
    let Some((binding, native_id)) =
        crate::agent_sessions::cli::native_transcript::current_native_store_key_for_session(
            &session,
        )?
    else {
        return Ok(None);
    };
    let Some(plan) = orgtrack_core::sources::app_open::app_open_plan(binding.source, &native_id)
    else {
        return Ok(None);
    };
    let source_available =
        crate::agent_sessions::cli::native_materializer::native_app_transcript_path(
            &session, &native_id,
        )?
        .is_some();
    Ok(Some(ExternalHistoryAppOpenPlanWire {
        plan,
        source_available,
    }))
}

/// Plan how to reopen an imported or managed native session in the app that
/// owns it. `Ok(None)` when the session is unknown, has no current native
/// binding, is an imported subagent child, or its source has no verified
/// per-session deep link (everything but Claude Code and Codex today).
#[tauri::command]
pub async fn external_history_app_open_plan(
    session_id: String,
) -> Result<Option<ExternalHistoryAppOpenPlanWire>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        external_history_app_open_plan_from_conn(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Open an imported or managed native session in the app that owns it.
///
/// The deep link is rebuilt from the authoritative imported cache row or
/// managed native binding here instead of being accepted from the frontend,
/// so the webview never names a URL the host hands to the OS: the only links
/// this can fire are the uuid-validated vendor routes
/// [`orgtrack_core::sources::app_open`] knows how to spell.
/// That also keeps the `opener:allow-open-url` capability scope limited to
/// `http(s)`, since no custom-scheme URL ever crosses the IPC boundary.
///
/// Transcript availability is deliberately *not* re-checked here — the plan
/// command already reports it and the UI gates on it, and both apps show
/// their own "session not found" state, so duplicating the policy would
/// only add a race between the check and the launch.
#[tauri::command]
pub async fn external_history_open_in_app(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let deep_link = tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let Some(plan) = external_history_app_open_plan_from_conn(&conn, &session_id)? else {
            return Err(format!("No native app deep link for session {session_id}"));
        };
        Ok(plan.plan.deep_link)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;

    app.opener()
        .open_url(deep_link.clone(), None::<&str>)
        .map_err(|err| format!("Failed to open {deep_link}: {err}"))
}

#[cfg(test)]
mod managed_app_open_plan_tests {
    use super::*;
    use std::fs;

    use crate::agent_sessions::cli::persistence::{self, CreateCodeSessionParams};
    use crate::test_utils::test_env;

    const CLAUDE_A_UUID: &str = "11111111-1111-4111-8111-111111111111";
    const CLAUDE_B_UUID: &str = "22222222-2222-4222-8222-222222222222";
    const CODEX_UUID: &str = "33333333-3333-4333-8333-333333333333";

    fn create_managed_session(
        session_id: &str,
        cli_agent_type: &str,
        account_id: &str,
        repo_path: &Path,
    ) {
        persistence::create_session(
            session_id,
            &CreateCodeSessionParams {
                name: Some("managed app-open fixture".to_string()),
                flow: None,
                runner: None,
                cli_agent_type: cli_agent_type.to_string(),
                model: Some("test-model".to_string()),
                tier: None,
                account_id: Some(account_id.to_string()),
                repo_path: Some(repo_path.to_string_lossy().into_owned()),
                branch: None,
                worktree_path: None,
                worktree_base_ref: None,
                proxy_token: None,
                proxy_url: None,
                hosted_token: None,
                proxy_session_id: None,
                isolate: None,
                background: Some(false),
                key_source: Some("own_key".to_string()),
                additional_directories: None,
                parent_session_id: None,
                org_member_id: None,
                agent_definition_id: None,
                org_id: None,
                project_id: None,
                project_name: None,
                project_slug: None,
                work_item_id: None,
                agent_role: None,
                product_mode: None,
            },
        )
        .expect("create managed native session");
    }

    fn plan_for(session_id: &str) -> Option<ExternalHistoryAppOpenPlanWire> {
        let conn = open_cache_conn().expect("open imported-history cache");
        external_history_app_open_plan_from_conn(&conn, session_id)
            .expect("resolve native app-open plan")
    }

    fn claude_transcript_path(cwd: &Path, native_id: &str) -> std::path::PathBuf {
        let project_slug: String = cwd
            .to_string_lossy()
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '-'
                }
            })
            .collect();
        app_paths::native_transcript_home_dir()
            .join(".claude/projects")
            .join(project_slug)
            .join(format!("{native_id}.jsonl"))
    }

    fn claude_runner_transcript_path(
        account_id: &str,
        cwd: &Path,
        native_id: &str,
    ) -> std::path::PathBuf {
        let native = claude_transcript_path(cwd, native_id);
        let relative = native
            .strip_prefix(app_paths::native_transcript_home_dir().join(".claude"))
            .expect("Claude native transcript relative path");
        app_paths::claude_code_cli_profile_dir(account_id).join(relative)
    }

    fn write_file(path: &Path) {
        fs::create_dir_all(path.parent().expect("fixture parent"))
            .expect("create fixture directory");
        fs::write(path, b"{}\n").expect("write provider transcript fixture");
    }

    #[test]
    fn managed_claude_plan_uses_the_current_account_binding() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-app-open-claude";
        create_managed_session(session_id, "claude_code", "account-a", sandbox.path());
        persistence::update_cli_session_id_for_account(
            session_id,
            Some("account-a"),
            CLAUDE_A_UUID,
        )
        .expect("bind account A");

        let conn = database::db::get_connection().expect("open sessions database");
        conn.execute(
            "UPDATE code_sessions SET account_id = 'account-b' WHERE session_id = ?1",
            [session_id],
        )
        .expect("switch to account B");
        persistence::update_cli_session_id_for_account(
            session_id,
            Some("account-b"),
            CLAUDE_B_UUID,
        )
        .expect("bind account B");
        conn.execute(
            "UPDATE code_sessions SET account_id = 'account-a' WHERE session_id = ?1",
            [session_id],
        )
        .expect("switch back to account A");
        let cwd = fs::canonicalize(sandbox.path()).expect("canonical fixture workspace");
        write_file(&claude_transcript_path(&cwd, CLAUDE_A_UUID));

        let plan = plan_for(session_id).expect("managed Claude plan");
        assert_eq!(plan.plan.source, "claude_code");
        assert_eq!(plan.plan.native_session_id, CLAUDE_A_UUID);
        assert_eq!(
            plan.plan.deep_link,
            format!("claude://resume?session={CLAUDE_A_UUID}")
        );
        assert!(plan.source_available);
    }

    #[test]
    fn managed_codex_plan_addresses_the_bound_thread_uuid() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-app-open-codex";
        create_managed_session(session_id, "codex", "openai-1", sandbox.path());
        persistence::update_cli_session_id_for_account(session_id, Some("openai-1"), CODEX_UUID)
            .expect("bind Codex thread");
        write_file(
            &app_paths::native_transcript_home_dir()
                .join(".codex/sessions/2026/09/06")
                .join(format!("rollout-2026-09-06T00-00-00-{CODEX_UUID}.jsonl")),
        );

        let plan = plan_for(session_id).expect("managed Codex plan");
        assert_eq!(plan.plan.source, "codex_app");
        assert_eq!(plan.plan.native_session_id, CODEX_UUID);
        assert_eq!(plan.plan.deep_link, format!("codex://threads/{CODEX_UUID}"));
        assert!(plan.source_available);
    }

    #[test]
    fn managed_session_without_a_native_binding_has_no_plan() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-app-open-unbound";
        create_managed_session(session_id, "claude_code", "account-a", sandbox.path());

        assert!(plan_for(session_id).is_none());
    }

    #[test]
    fn managed_plan_does_not_treat_a_runner_only_alias_as_native_app_available() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-app-open-runner-only";
        create_managed_session(session_id, "claude_code", "account-a", sandbox.path());
        persistence::update_cli_session_id_for_account(
            session_id,
            Some("account-a"),
            CLAUDE_A_UUID,
        )
        .expect("bind account A");
        let cwd = fs::canonicalize(sandbox.path()).expect("canonical fixture workspace");
        write_file(&claude_runner_transcript_path(
            "account-a",
            &cwd,
            CLAUDE_A_UUID,
        ));

        let plan = plan_for(session_id).expect("managed Claude plan");
        assert!(!plan.source_available);
    }

    #[test]
    fn managed_session_with_an_unsafe_native_id_has_no_plan() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-app-open-unsafe";
        create_managed_session(session_id, "claude_code", "account-a", sandbox.path());
        persistence::update_cli_session_id_for_account(
            session_id,
            Some("account-a"),
            "not-a-uuid?launch=anything",
        )
        .expect("bind malformed provider id fixture");

        assert!(plan_for(session_id).is_none());
    }
}
