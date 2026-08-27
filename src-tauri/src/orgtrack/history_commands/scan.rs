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

/// Plan how to reopen an imported external session in its own CLI.
/// `Ok(None)` when the session is unknown, a subagent child, or its source
/// has no CLI resume entry point (e.g. Cursor IDE composers).
#[tauri::command]
pub async fn external_history_cli_resume_plan(
    session_id: String,
) -> Result<Option<ExternalHistoryCliResumePlanWire>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let Some((plan, session)) =
            orgtrack_core::sources::cli_resume::cli_resume_plan_for_cached_session(
                &conn,
                &session_id,
            )?
        else {
            return Ok(None);
        };
        let cwd_exists = plan
            .cwd
            .as_deref()
            .is_some_and(|path| Path::new(path).is_dir());
        let source_available =
            !session.source_path.is_empty() && Path::new(&session.source_path).exists();
        Ok(Some(ExternalHistoryCliResumePlanWire {
            display_command: plan.display_command(),
            plan,
            cwd_exists,
            source_available,
        }))
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

/// Plan how to reopen an imported external session in the app that owns it.
/// `Ok(None)` when the session is unknown, a subagent child, or its source
/// has no verified per-session deep link (everything but Claude Code and
/// Codex today).
#[tauri::command]
pub async fn external_history_app_open_plan(
    session_id: String,
) -> Result<Option<ExternalHistoryAppOpenPlanWire>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let Some((plan, session)) =
            orgtrack_core::sources::app_open::app_open_plan_for_cached_session(&conn, &session_id)?
        else {
            return Ok(None);
        };
        let source_available =
            !session.source_path.is_empty() && Path::new(&session.source_path).exists();
        Ok(Some(ExternalHistoryAppOpenPlanWire {
            plan,
            source_available,
        }))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Open an imported external session in the app that owns it.
///
/// The deep link is rebuilt from the cache row here instead of being
/// accepted from the frontend, so the webview never names a URL the host
/// hands to the OS: the only links this can fire are the uuid-validated
/// vendor routes [`orgtrack_core::sources::app_open`] knows how to spell.
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
        let Some((plan, _)) =
            orgtrack_core::sources::app_open::app_open_plan_for_cached_session(&conn, &session_id)?
        else {
            return Err(format!(
                "No native app deep link for imported session {session_id}"
            ));
        };
        Ok(plan.deep_link)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;

    app.opener()
        .open_url(deep_link.clone(), None::<&str>)
        .map_err(|err| format!("Failed to open {deep_link}: {err}"))
}
