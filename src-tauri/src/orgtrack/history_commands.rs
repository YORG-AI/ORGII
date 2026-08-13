use std::{
    collections::{HashSet, VecDeque},
    path::Path,
    sync::{Mutex, OnceLock},
};

use database::db::get_connection;
use orgtrack_core::pricing;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app;
use orgtrack_core::sources::copilot::history as copilot_history;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::{
    db as cursor_db, disk_reads as cursor_disk_reads, history as cursor_db_history,
};
use orgtrack_core::sources::imported_history;
use orgtrack_core::sources::kimi::history as kimi_history;
use orgtrack_core::sources::mimo_code::history as mimo_code_history;
use orgtrack_core::sources::omp::history as omp_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::pi::history as pi_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::qoder_cli::history as qoder_cli_history;
use orgtrack_core::sources::qwen_code::history as qwen_code_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;
use session_persistence::CachedTurnSummary;

use super::external_cli_detection::{self, ExternalCliSourceProbe};
use super::history_scan_coordinator::{
    ExternalHistoryScanCoordinator, ExternalHistoryScanJob, ExternalHistoryScanMode,
    ExternalHistorySourceScanOutcome, ExternalHistorySourceScanResult,
};

fn open_cache_conn() -> Result<rusqlite::Connection, String> {
    get_connection().map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))
}

fn external_history_scan_coordinator() -> &'static ExternalHistoryScanCoordinator {
    static COORDINATOR: OnceLock<ExternalHistoryScanCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(ExternalHistoryScanCoordinator::default)
}

const IMPORTED_TURN_PROJECTION_CACHE_CAPACITY: usize = 8;
const IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION: usize = 4_096;
const CODEX_INITIAL_RECENT_TURN_COUNT: usize = 1;
const IMPORTED_INITIAL_RECENT_TURN_COUNT: usize = 1;
const IMPORTED_CLOUD_TURN_WINDOW_LIMIT: usize = 50;

/// Fidelity of a projection entering the cache. Window pre-warms are built
/// without parsing every round body (empty `modified_files`, fabricated
/// statuses, placeholder counts) — `Reduced`. Projections computed from the
/// complete chunk stream are `Full`. The ordering matters: a `Reduced`
/// pre-warm must never replace a `Full` entry, and readers that need full
/// fidelity treat `Reduced` hits as misses — otherwise per-round metadata
/// quality would depend on whether the replay opened before or after the
/// metadata index was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ProjectionQuality {
    Reduced,
    Full,
}

#[derive(Debug)]
struct ImportedTurnProjectionCacheEntry {
    session_id: String,
    signature: (i64, u64),
    quality: ProjectionQuality,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
}

#[derive(Debug, Default)]
struct ImportedTurnProjectionCache {
    entries: VecDeque<ImportedTurnProjectionCacheEntry>,
}

impl ImportedTurnProjectionCache {
    fn get(
        &mut self,
        session_id: &str,
        signature: (i64, u64),
        min_quality: ProjectionQuality,
    ) -> Option<Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.session_id == session_id)?;
        let entry = self.entries.remove(index)?;
        if entry.signature != signature {
            // A stale caller must miss without evicting the newer projection
            // that another reader already cached for this session.
            self.entries.push_back(entry);
            return None;
        }
        if entry.quality < min_quality {
            // Keep the entry (a lower-fidelity reader may still use it); the
            // caller recomputes at full fidelity and its insert upgrades us.
            self.entries.push_back(entry);
            return None;
        }
        let projected = entry.projected.clone();
        self.entries.push_back(entry);
        Some(projected)
    }

    fn insert(
        &mut self,
        session_id: String,
        signature: (i64, u64),
        quality: ProjectionQuality,
        projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
    ) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.session_id == session_id)
        {
            let existing = &self.entries[index];
            if existing.signature == signature && existing.quality > quality {
                // Never downgrade: a Reduced window pre-warm must not
                // replace the Full projection for the same transcript state.
                let existing = self.entries.remove(index).expect("indexed entry");
                self.entries.push_back(existing);
                return;
            }
            self.entries.remove(index);
        }
        let projected = if projected.len() > IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION {
            projected
                .into_iter()
                .rev()
                .take(IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            projected
        };
        self.entries.push_back(ImportedTurnProjectionCacheEntry {
            session_id,
            signature,
            quality,
            projected,
        });
        while self.entries.len() > IMPORTED_TURN_PROJECTION_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

fn imported_turn_projection_cache() -> &'static Mutex<ImportedTurnProjectionCache> {
    static CACHE: OnceLock<Mutex<ImportedTurnProjectionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ImportedTurnProjectionCache::default()))
}

fn imported_transcript_signature(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let Some((source, cached)) =
        imported_history::cache::query_cached_session_by_session_id_including_superseded_from_conn(
            conn, session_id,
        )?
    else {
        return Ok(None);
    };
    imported_transcript_signature_for_cached(conn, &source, &cached, session_id)
}

fn imported_transcript_signature_for_cached(
    conn: &rusqlite::Connection,
    source: &str,
    cached: &imported_history::cache::ImportedHistoryCachedSession,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    match source {
        imported_history::metadata::SOURCE_CURSOR_IDE => {
            let composer_id = session_id
                .strip_prefix(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
                .unwrap_or(session_id);
            Ok(
                cursor_disk_reads::cursor_composer_last_updated_at(composer_id)?
                    .map(|updated_at| (updated_at, 0)),
            )
        }
        imported_history::metadata::SOURCE_OPENCODE
        | imported_history::metadata::SOURCE_ZCODE
        | imported_history::metadata::SOURCE_MIMO_CODE => {
            imported_history::paths::sqlite_session_activity_signature(
                Path::new(&cached.source_path),
                &cached.source_record_key,
                source,
            )
            // Provider schema drift must not turn a cheap freshness probe into
            // a permanent error/reload loop. The file signature is broader
            // (unrelated sessions can invalidate it) but remains correct.
            .or_else(|_| {
                imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
                    conn, source, session_id,
                )
            })
        }
        imported_history::metadata::SOURCE_WINDSURF => {
            windsurf_history::windsurf_session_activity_signature(
                Path::new(&cached.source_path),
                &cached.source_record_key,
            )
            .or_else(|_| {
                imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
                    conn, source, session_id,
                )
            })
        }
        _ => imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
            conn, source, session_id,
        ),
    }
}

fn remember_imported_turn_projection(
    session_id: &str,
    signature_before: Option<(i64, u64)>,
    signature_after: Option<(i64, u64)>,
    quality: ProjectionQuality,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
) {
    let (Some(before), Some(after)) = (signature_before, signature_after) else {
        return;
    };
    // Do not cache a parse that raced a transcript append. The next read will
    // parse the now-stable file instead of treating an incomplete projection
    // as current.
    if before != after {
        return;
    }
    imported_turn_projection_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.to_string(), after, quality, projected);
}

fn load_projected_turn_metadata(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>>, String> {
    // Claude's index pass deliberately projects user rows only (no full-body
    // parse), so Reduced is its native fidelity; every other source computes
    // from the complete chunk stream and must not serve a window pre-warm.
    let is_claude_code =
        session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX);
    let required_quality = if is_claude_code {
        ProjectionQuality::Reduced
    } else {
        ProjectionQuality::Full
    };
    let signature_before = imported_transcript_signature(conn, session_id)?;
    if let Some(signature) = signature_before {
        if let Some(projected) = imported_turn_projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id, signature, required_quality)
        {
            return Ok(Some(projected));
        }
    }

    if is_claude_code {
        let projected =
            claude_code_history::load_claude_code_turn_index_for_session(conn, session_id)?;
        let signature_after = imported_transcript_signature(conn, session_id)?;
        remember_imported_turn_projection(
            session_id,
            signature_before,
            signature_after,
            ProjectionQuality::Reduced,
            projected.clone(),
        );
        return Ok(Some(projected));
    }

    let Some(chunks) = imported_history::load_activity_chunks_for_session(conn, session_id)? else {
        return Ok(None);
    };
    let projected = orgtrack_core::projectors::turn_metadata::project_activity_chunks(&chunks);
    let signature_after = imported_transcript_signature(conn, session_id)?;
    remember_imported_turn_projection(
        session_id,
        signature_before,
        signature_after,
        ProjectionQuality::Full,
        projected.clone(),
    );
    Ok(Some(projected))
}

fn projected_rounds_to_cached_turns(
    session_id: &str,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
) -> Vec<CachedTurnSummary> {
    let turn_boundaries = projected
        .iter()
        .map(|round| (round.turn_id.clone(), round.start_sequence))
        .collect::<Vec<_>>();
    projected
        .into_iter()
        .enumerate()
        .map(|(index, round)| CachedTurnSummary {
            session_id: session_id.to_string(),
            turn_id: round.turn_id.clone(),
            start_sequence: round.start_sequence,
            end_sequence: turn_boundaries
                .get(index + 1)
                .map(|(_, sequence)| *sequence),
            next_turn_id: turn_boundaries
                .get(index + 1)
                .map(|(turn_id, _)| turn_id.clone()),
            started_at: round.started_at,
            ended_at: round.ended_at,
            duration_ms: None,
            user_event_ids: vec![round.turn_id],
            user_preview: round.user_preview,
            event_count: round.event_count,
            body_event_count: round.body_event_count,
            interrupted: round.status == "interrupted",
            status: round.status,
            modified_files: round.modified_files,
            resource_interactions: round.resource_interactions,
            git_artifacts: round.git_artifacts,
        })
        .collect()
}

fn cursor_turns_to_projected(
    turns: &[cursor_db_history::CursorIdeTurnSummary],
) -> Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata> {
    turns
        .iter()
        .map(
            |turn| orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata {
                turn_id: turn.turn_id.clone(),
                start_sequence: turn.turn_index as i64,
                started_at: turn.started_at.clone(),
                ended_at: turn.ended_at.clone(),
                status: "completed".to_string(),
                user_preview: turn.user_preview.clone(),
                event_count: turn.event_count as i64,
                body_event_count: turn.body_event_count as i64,
                modified_files: Vec::new(),
                resource_interactions: Vec::new(),
                git_artifacts: Vec::new(),
            },
        )
        .collect()
}

/// Unified per-round metadata read surface. Native/managed sessions use the
/// versioned local turn cache; read-only imported sessions are projected
/// directly from their existing provider loader and never copied into
/// `sessions.db.events`.
#[tauri::command]
pub async fn orgtrack_session_turn_metadata_index(
    session_id: String,
    turn_ids: Option<Vec<String>>,
) -> Result<Vec<CachedTurnSummary>, String> {
    tokio::task::spawn_blocking(move || {
        if turn_ids
            .as_ref()
            .is_some_and(|turn_ids| turn_ids.len() > 500)
        {
            return Err("At most 500 turn summaries can be loaded at once".to_string());
        }
        let conn = open_cache_conn()?;
        // Managed native-transcript sessions project from the CLI's own
        // store: remap the managed id to its imported transcript id first.
        let transcript_session_id =
            crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
                &session_id,
            )
            .unwrap_or_else(|| session_id.clone());
        if let Some(projected) = load_projected_turn_metadata(&conn, &transcript_session_id)? {
            let mut turns = projected_rounds_to_cached_turns(&session_id, projected);
            if let Some(turn_ids) = turn_ids.as_ref() {
                let requested = turn_ids.iter().collect::<std::collections::HashSet<_>>();
                turns.retain(|turn| requested.contains(&turn.turn_id));
            }
            return Ok(turns);
        }
        if let Some(turn_ids) = turn_ids.as_ref() {
            return session_persistence::load_turn_summaries(&session_id, turn_ids)
                .map_err(|err| err.to_string());
        }
        session_persistence::load_turn_index(&session_id).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// List-price estimate for a session that carries only a single total token
/// count with no input/output split (Cursor). Priced at a blended rate — the
/// mean of the input and output rates — which is an approximation for
/// total-only token counts.
fn estimate_cost_blended(total_tokens: i64, model: &str) -> f64 {
    let pricing = pricing::resolve_pricing(Some(model));
    total_tokens as f64 / 1e6 * (pricing.input_per_mtok + pricing.output_per_mtok) / 2.0
}

fn imported_recent_paths() -> Result<Vec<imported_history::ImportedHistoryRecentPath>, String> {
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

fn external_history_scan_mode(clear: bool) -> ExternalHistoryScanMode {
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

#[tauri::command]
pub async fn orgtrack_get_cursor_sessions(
    start_date: String,
    end_date: String,
) -> Result<Vec<cursor_db::CursorSession>, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        let mut sessions = cursor_db::get_cursor_sessions(&mut conn, &start_date, &end_date)?;
        for session in &mut sessions {
            session.estimated_cost = estimate_cost_blended(session.tokens_used, &session.model);
        }
        Ok(sessions)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_ide_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || cursor_db_history::load_history_for_session(&session_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

/// Freshness signal for an open read-only Cursor session — the frontend compares
/// snapshots to decide whether to reload chunks. Reads Cursor's `state.vscdb`.
#[tauri::command]
pub async fn cursor_ide_composer_last_updated_at(
    composer_id: String,
) -> Result<Option<i64>, String> {
    tokio::task::spawn_blocking(move || {
        cursor_disk_reads::cursor_composer_last_updated_at(&composer_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_ide_initial_window(
    session_id: String,
    recent_limit: Option<usize>,
) -> Result<cursor_db_history::CursorIdeInitialWindow, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        let signature_before = imported_transcript_signature(&conn, &session_id)?;
        let window = cursor_db_history::load_initial_window_for_session(
            &mut conn,
            &session_id,
            recent_limit,
        )?;
        let signature_after = imported_transcript_signature(&conn, &session_id)?;
        // Fabricated rows (empty modified_files, hardcoded status): pre-warm
        // only — must not displace a Full projection for this transcript.
        remember_imported_turn_projection(
            &session_id,
            signature_before,
            signature_after,
            ProjectionQuality::Reduced,
            cursor_turns_to_projected(&window.turns),
        );
        Ok(window)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_ide_full_refresh(
    session_id: String,
) -> Result<cursor_db_history::CursorIdeFullRefresh, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        cursor_db_history::load_full_refresh_for_session(&mut conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_ide_turn_window(
    session_id: String,
    user_bubble_id: String,
) -> Result<cursor_db_history::CursorIdeTurnWindow, String> {
    tokio::task::spawn_blocking(move || {
        cursor_db_history::load_turn_window_for_session(&session_id, &user_bubble_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn imported_history_initial_window(
    session_id: String,
    recent_turn_count: Option<usize>,
) -> Result<imported_history::window::ImportedHistoryInitialWindow, String> {
    let recent_turn_count = recent_turn_count
        .unwrap_or(IMPORTED_INITIAL_RECENT_TURN_COUNT)
        .clamp(1, 20);
    tokio::task::spawn_blocking(move || {
        if session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX)
            || session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
        {
            return Err(format!(
                "Session {session_id} has a source-specific initial-window loader"
            ));
        }
        let conn = open_cache_conn()?;
        let signature_before = imported_transcript_signature(&conn, &session_id)?;
        // Claude windows come from the reduced user-row index; the generic
        // path projects the complete chunk stream before windowing it.
        let (window, projection_quality) =
            if session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX) {
                (
                    claude_code_history::load_claude_code_initial_window_for_session(
                        &conn,
                        &session_id,
                        recent_turn_count,
                    )?,
                    ProjectionQuality::Reduced,
                )
            } else {
                (
                    imported_history::window::load_initial_window_for_session(
                        &conn,
                        &session_id,
                        recent_turn_count,
                    )?
                    .ok_or_else(|| format!("Unknown imported history session: {session_id}"))?,
                    ProjectionQuality::Full,
                )
            };
        let signature_after = imported_transcript_signature(&conn, &session_id)?;
        remember_imported_turn_projection(
            &session_id,
            signature_before,
            signature_after,
            projection_quality,
            window.turns.clone(),
        );
        Ok(window)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn imported_history_turn_windows(
    session_id: String,
    mut turn_ids: Vec<String>,
) -> Result<Vec<imported_history::window::ImportedHistoryTurnWindow>, String> {
    if turn_ids.len() > 50 {
        return Err("At most 50 imported history turns can be loaded at once".to_string());
    }
    if turn_ids.iter().any(|turn_id| turn_id.len() > 1_024) {
        return Err("Imported history turn id is too long".to_string());
    }
    let mut seen = HashSet::with_capacity(turn_ids.len());
    turn_ids.retain(|turn_id| seen.insert(turn_id.clone()));
    if turn_ids.is_empty() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || {
        if session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX)
            || session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
        {
            return Err(format!(
                "Session {session_id} has a source-specific turn-window loader"
            ));
        }
        let conn = open_cache_conn()?;
        if session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX) {
            claude_code_history::load_claude_code_turn_windows_for_session(
                &conn,
                &session_id,
                &turn_ids,
            )
        } else {
            imported_history::window::load_turn_windows_for_session(&conn, &session_id, &turn_ids)?
                .ok_or_else(|| format!("Unknown imported history session: {session_id}"))
        }
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHistoryCloudTurnWindow {
    pub turn_id: String,
    pub chunks: Vec<core_types::activity::ActivityChunk>,
}

/// Ordered user-turn ids for providers whose source readers can seek to one
/// turn without materializing the complete transcript. This is intentionally
/// a capability-gated surface: callers must retain the authoritative full
/// loader as the fallback for unsupported or rewritten sources.
#[tauri::command]
pub async fn imported_history_cloud_turn_ids(session_id: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        if session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX) {
            let conn = open_cache_conn()?;
            return claude_code_history::load_claude_code_turn_ids_for_session(&conn, &session_id);
        }
        if session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX) {
            let conn = open_cache_conn()?;
            return codex_app::load_codex_app_turn_ids_for_session(&conn, &session_id);
        }
        if session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX) {
            return cursor_db_history::load_turn_ids_for_session(&session_id);
        }
        Err(format!(
            "Session {session_id} does not support incremental cloud replay windows"
        ))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Load exact user-bounded turns for incremental cloud replay preparation.
/// The limit bounds one IPC response; a larger delta safely falls back to the
/// existing full authoritative loader in the frontend.
#[tauri::command]
pub async fn imported_history_cloud_turn_windows(
    session_id: String,
    mut turn_ids: Vec<String>,
    start_sequence: usize,
) -> Result<Vec<ImportedHistoryCloudTurnWindow>, String> {
    if turn_ids.len() > IMPORTED_CLOUD_TURN_WINDOW_LIMIT {
        return Err(format!(
            "At most {IMPORTED_CLOUD_TURN_WINDOW_LIMIT} cloud replay turns can be loaded at once"
        ));
    }
    if turn_ids.iter().any(|turn_id| turn_id.len() > 1_024) {
        return Err("Imported history turn id is too long".to_string());
    }
    let mut seen = HashSet::with_capacity(turn_ids.len());
    turn_ids.retain(|turn_id| seen.insert(turn_id.clone()));
    if turn_ids.is_empty() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || {
        if session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX) {
            let conn = open_cache_conn()?;
            return claude_code_history::load_claude_code_cloud_turn_windows_for_session(
                &conn,
                &session_id,
                &turn_ids,
                start_sequence,
            )
            .map(|windows| {
                windows
                    .into_iter()
                    .map(|window| ImportedHistoryCloudTurnWindow {
                        turn_id: window.turn_id,
                        chunks: window.chunks,
                    })
                    .collect()
            });
        }
        if session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX) {
            let conn = open_cache_conn()?;
            let mut next_sequence = start_sequence;
            return turn_ids
                .into_iter()
                .map(|turn_id| {
                    let chunks = codex_app::load_codex_app_cloud_turn_for_session(
                        &conn,
                        &session_id,
                        &turn_id,
                        next_sequence,
                    )?;
                    next_sequence = next_sequence.saturating_add(chunks.len());
                    Ok(ImportedHistoryCloudTurnWindow { turn_id, chunks })
                })
                .collect();
        }
        if session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX) {
            // start_sequence is intentionally unused here: Cursor chunk ids
            // come from stable bubble ids in the provider DB, not from a
            // position-derived sequence, so windows are position-independent.
            return turn_ids
                .into_iter()
                .map(|turn_id| {
                    let window =
                        cursor_db_history::load_turn_window_for_session(&session_id, &turn_id)?;
                    Ok(ImportedHistoryCloudTurnWindow {
                        turn_id,
                        chunks: window.chunks,
                    })
                })
                .collect();
        }
        Err(format!(
            "Session {session_id} does not support incremental cloud replay windows"
        ))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedContinuationStatus {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage_id: Option<String>,
    pub superseded: bool,
}

/// Continuation-family status for the cloud engine's superseded-row
/// reconciliation: which push-marked sessions the imported cache reports as
/// demoted, plus the lineage that identifies their listable winner. Ids not
/// present in the cache are OMITTED — absence means "unknown" (a rebuilding
/// cache reads empty), never "superseded".
#[tauri::command]
pub async fn imported_history_continuation_statuses(
    session_ids: Vec<String>,
) -> Result<Vec<ImportedContinuationStatus>, String> {
    if session_ids.len() > 200 {
        return Err("At most 200 continuation statuses can be resolved at once".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let mut out = Vec::with_capacity(session_ids.len());
        for session_id in session_ids {
            let Some((lineage_id, superseded)) =
                orgtrack_core::sources::imported_history::cache::cached_session_continuation_status_from_conn(
                    &conn,
                    &session_id,
                )?
            else {
                continue;
            };
            out.push(ImportedContinuationStatus {
                session_id,
                lineage_id,
                superseded,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn codex_app_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let signature_before = imported_transcript_signature(&conn, &session_id)?;
        let chunks = codex_app::load_codex_app_for_session(&conn, &session_id)?;
        let projected = orgtrack_core::projectors::turn_metadata::project_activity_chunks(&chunks);
        let signature_after = imported_transcript_signature(&conn, &session_id)?;
        remember_imported_turn_projection(
            &session_id,
            signature_before,
            signature_after,
            ProjectionQuality::Full,
            projected,
        );
        Ok(chunks)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn codex_app_initial_window(
    session_id: String,
) -> Result<codex_app::CodexAppInitialWindow, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let signature_before = imported_transcript_signature(&conn, &session_id)?;
        let window = codex_app::load_codex_app_initial_window_for_session(
            &conn,
            &session_id,
            CODEX_INITIAL_RECENT_TURN_COUNT,
        )?;
        let signature_after = imported_transcript_signature(&conn, &session_id)?;
        // Catalog-derived rows (previews + line counts, no body parse):
        // pre-warm only — must not displace a Full projection.
        remember_imported_turn_projection(
            &session_id,
            signature_before,
            signature_after,
            ProjectionQuality::Reduced,
            window.turns.clone(),
        );
        Ok(window)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn codex_app_turn_window(
    session_id: String,
    turn_id: String,
) -> Result<codex_app::CodexAppTurnWindow, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        codex_app::load_codex_app_turn_for_session(&conn, &session_id, &turn_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn codex_app_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<codex_app::CodexAppRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        codex_app::list_codex_app_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn external_cli_sources_detect() -> Result<Vec<ExternalCliSourceProbe>, String> {
    tokio::task::spawn_blocking(external_cli_detection::detect_sources)
        .await
        .map_err(|err| format!("Task join error: {err}"))
}

#[tauri::command]
pub async fn external_cli_source_probe(
    source_id: String,
) -> Result<Option<ExternalCliSourceProbe>, String> {
    tokio::task::spawn_blocking(move || external_cli_detection::probe_source_id(&source_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))
}

#[tauri::command]
pub async fn external_history_auto_import_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<git::repos::repo_db::RepoRecord>, String> {
    let limit = imported_history::effective_limit(limit.unwrap_or(20));
    let paths = tokio::task::spawn_blocking(imported_recent_paths)
        .await
        .map_err(|err| format!("Task join error: {err}"))??;

    let mut imported = Vec::new();
    for recent_path in paths.into_iter().take(limit) {
        if !Path::new(&recent_path.path).is_dir() {
            continue;
        }
        imported.push(git::repos::repo_service::import_auto(recent_path.path, None).await?);
    }

    Ok(imported)
}

#[tauri::command]
pub async fn claude_code_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        claude_code_history::load_claude_code_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Freshness snapshot of one imported transcript's source file.
///
/// `(mtime_ms, size_bytes)` is the change-detection signature and is compared
/// for equality only. For shared-SQLite session-local sources the second
/// component is a fold/hash, not bytes — `store_size_bytes` carries the real
/// on-disk footprint for size-tiered reload cooldowns there; `None` means
/// `size_bytes` already is a real byte count.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscriptStat {
    pub mtime_ms: i64,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_size_bytes: Option<u64>,
}

/// Cheap freshness probe for the replay auto-refresh: returns the transcript
/// file's `(mtime, size)` so the frontend can skip the full
/// read → parse → merge pipeline when nothing changed. `None` when the
/// source file is missing.
#[tauri::command]
pub async fn claude_code_history_stat(
    session_id: String,
) -> Result<Option<ImportedTranscriptStat>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        Ok(
            claude_code_history::stat_claude_code_history_for_session(&conn, &session_id)?.map(
                |(mtime_ms, size_bytes)| ImportedTranscriptStat {
                    mtime_ms,
                    size_bytes,
                    store_size_bytes: None,
                },
            ),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Source-agnostic freshness probe for replay auto-refresh. Shared SQLite
/// providers use a session-local row signature so writes to another session
/// do not trigger a full parse of the open replay. File-backed providers use
/// the transcript file signature (including SQLite sidecars where applicable).
#[tauri::command]
pub async fn imported_history_stat(
    source_id: String,
    session_id: String,
) -> Result<Option<ImportedTranscriptStat>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let Some((cached_source, cached)) =
            imported_history::cache::query_cached_session_by_session_id_including_superseded_from_conn(
                &conn,
                &session_id,
            )?
        else {
            return Ok(None);
        };
        if cached_source != source_id {
            return Err(format!(
                "Imported history source mismatch for {session_id}: expected {cached_source}, got {source_id}"
            ));
        }

        let signature = imported_transcript_signature_for_cached(
            &conn,
            &source_id,
            &cached,
            &session_id,
        )?;
        // Session-local signatures use a fold/hash as their second component;
        // give the cooldown tiering the store's real on-disk footprint.
        let store_size_bytes = match source_id.as_str() {
            imported_history::metadata::SOURCE_OPENCODE
            | imported_history::metadata::SOURCE_ZCODE
            | imported_history::metadata::SOURCE_MIMO_CODE
            | imported_history::metadata::SOURCE_WINDSURF
            | imported_history::metadata::SOURCE_CURSOR_IDE => {
                imported_history::paths::sqlite_store_size_bytes(Path::new(&cached.source_path))
            }
            _ => None,
        };
        Ok(signature.map(|(mtime_ms, size_bytes)| ImportedTranscriptStat {
            mtime_ms,
            size_bytes,
            store_size_bytes,
        }))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn claude_code_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<claude_code_history::ClaudeCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        claude_code_history::list_claude_code_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn copilot_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        copilot_history::load_copilot_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_cli_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        cursor_cli_history::load_cursor_cli_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Cheap freshness probe for the replay auto-refresh, folding the store's
/// `-wal` sidecar in (a WAL commit doesn't touch the main file's mtime).
#[tauri::command]
pub async fn cursor_cli_history_stat(
    session_id: String,
) -> Result<Option<ImportedTranscriptStat>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        Ok(
            cursor_cli_history::stat_cursor_cli_history_for_session(&conn, &session_id)?.map(
                |(mtime_ms, size_bytes)| ImportedTranscriptStat {
                    mtime_ms,
                    size_bytes,
                    store_size_bytes: None,
                },
            ),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cursor_cli_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<cursor_cli_history::CursorCliRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        cursor_cli_history::list_cursor_cli_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn opencode_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        opencode_history::load_opencode_history_for_session(&session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn opencode_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<opencode_history::OpenCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        opencode_history::list_opencode_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn warp_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || warp_history::load_warp_history_for_session(&session_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn warp_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<warp_history::WarpRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        warp_history::list_warp_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn zcode_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || zcode_history::load_zcode_history_for_session(&session_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn zcode_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<zcode_history::ZCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        zcode_history::list_zcode_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        qoder_history::load_qoder_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<qoder_history::QoderRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        qoder_history::list_qoder_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn mimo_code_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        mimo_code_history::load_mimo_code_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn mimo_code_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<mimo_code_history::MimoCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        mimo_code_history::list_mimo_code_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn omp_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        omp_history::load_omp_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn omp_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<omp_history::OmpRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        omp_history::list_omp_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn pi_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        pi_history::load_pi_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn pi_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<pi_history::PiRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        pi_history::list_pi_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_cli_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        qoder_cli_history::load_qoder_cli_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_cli_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<qoder_cli_history::QoderCliRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        qoder_cli_history::list_qoder_cli_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qwen_code_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        qwen_code_history::load_qwen_code_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qwen_code_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<qwen_code_history::QwenCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        qwen_code_history::list_qwen_code_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn kimi_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        kimi_history::load_kimi_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn kimi_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<kimi_history::KimiRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        kimi_history::list_kimi_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn windsurf_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        windsurf_history::load_windsurf_history_for_session(&session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn windsurf_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<windsurf_history::WindsurfRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        windsurf_history::list_windsurf_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn trae_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        trae_history::load_trae_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn trae_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<trae_history::TraeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        trae_history::list_trae_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cline_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        cline_history::load_cline_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cline_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<cline_history::ClineRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        cline_history::list_cline_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn workbuddy_history_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        workbuddy_history::load_workbuddy_history_for_session(&conn, &session_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn workbuddy_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<workbuddy_history::WorkBuddyRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        workbuddy_history::list_workbuddy_recent_paths(&mut conn, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySourceStatsWire {
    pub source_id: String,
    pub session_count: usize,
    pub subagent_count: usize,
    pub last_used_at: Option<String>,
}

/// One compact cache-only inventory read for every requested source. This
/// command never opens provider databases or walks transcript directories.
#[tauri::command]
pub async fn external_history_source_stats(
    sources: Vec<String>,
) -> Result<Vec<ExternalHistorySourceStatsWire>, String> {
    let mut seen_sources = HashSet::with_capacity(sources.len());
    for source in &sources {
        if !seen_sources.insert(source.clone()) {
            return Err(format!("Duplicate external history source: {source}"));
        }
        if !imported_history::metadata::is_imported_history_source(source) {
            return Err(format!("Unknown external history source: {source}"));
        }
    }

    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let cached = imported_history::cache::all_source_stats_from_conn(&conn)?
            .into_iter()
            .map(|stats| (stats.source.clone(), stats))
            .collect::<std::collections::HashMap<_, _>>();
        Ok(sources
            .into_iter()
            .map(|source_id| {
                let stats = cached.get(&source_id);
                ExternalHistorySourceStatsWire {
                    source_id,
                    session_count: stats.map_or(0, |row| row.session_count),
                    subagent_count: stats.map_or(0, |row| row.subagent_count),
                    last_used_at: stats
                        .and_then(|row| row.last_used_at_ms)
                        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
                        .map(|value| value.to_rfc3339()),
                }
            })
            .collect())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[cfg(test)]
mod tests {
    use orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata;

    use super::*;

    fn projected(turn_id: &str, start_sequence: i64) -> ProjectedTurnMetadata {
        ProjectedTurnMetadata {
            turn_id: turn_id.to_string(),
            start_sequence,
            started_at: format!("2026-07-15T00:00:0{start_sequence}Z"),
            ended_at: None,
            status: "completed".to_string(),
            user_preview: turn_id.to_string(),
            event_count: 2,
            body_event_count: 1,
            modified_files: Vec::new(),
            resource_interactions: Vec::new(),
            git_artifacts: Vec::new(),
        }
    }

    #[test]
    fn projected_round_mapping_preserves_boundaries_and_next_turn() {
        let turns = projected_rounds_to_cached_turns(
            "codexapp-session",
            vec![projected("user-1", 0), projected("user-2", 3)],
        );

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn_id, "user-1");
        assert_eq!(turns[0].end_sequence, Some(3));
        assert_eq!(turns[0].next_turn_id.as_deref(), Some("user-2"));
        assert_eq!(turns[1].turn_id, "user-2");
        assert_eq!(turns[1].end_sequence, None);
        assert_eq!(turns[1].next_turn_id, None);
    }

    #[test]
    fn projected_round_mapping_preserves_non_terminal_status() {
        let mut active = projected("user-active", 0);
        active.status = "pending".to_string();

        let turns = projected_rounds_to_cached_turns("codexapp-session", vec![active]);

        assert_eq!(turns[0].status, "pending");
        assert!(!turns[0].interrupted);
    }

    #[test]
    fn external_history_rebuild_requires_explicit_clear() {
        assert_eq!(
            external_history_scan_mode(false),
            ExternalHistoryScanMode::Incremental
        );
        assert_eq!(
            external_history_scan_mode(true),
            ExternalHistoryScanMode::Rebuild
        );
    }

    #[test]
    fn imported_projection_cache_is_bounded_and_rejects_stale_signatures() {
        let mut cache = ImportedTurnProjectionCache::default();
        for index in 0..=IMPORTED_TURN_PROJECTION_CACHE_CAPACITY {
            cache.insert(
                format!("codexapp-{index}"),
                (index as i64, index as u64),
                ProjectionQuality::Full,
                vec![projected(&format!("user-{index}"), index as i64)],
            );
        }

        assert_eq!(cache.entries.len(), IMPORTED_TURN_PROJECTION_CACHE_CAPACITY);
        assert!(cache
            .get("codexapp-0", (0, 0), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("codexapp-1", (999, 999), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("codexapp-2", (2, 2), ProjectionQuality::Full)
            .is_some());
    }

    #[test]
    fn imported_projection_cache_bounds_turns_per_session() {
        let mut cache = ImportedTurnProjectionCache::default();
        cache.insert(
            "codexapp-large".to_string(),
            (1, 2),
            ProjectionQuality::Full,
            (0..=IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION)
                .map(|index| projected(&format!("user-{index}"), index as i64))
                .collect(),
        );

        let projected = cache
            .get("codexapp-large", (1, 2), ProjectionQuality::Full)
            .expect("cached projection");
        assert_eq!(projected.len(), IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION);
        assert_eq!(
            projected.first().map(|turn| turn.turn_id.as_str()),
            Some("user-1")
        );
    }

    #[test]
    fn reduced_prewarm_never_displaces_full_projection_and_is_invisible_to_full_readers() {
        let mut cache = ImportedTurnProjectionCache::default();
        let full = vec![projected("user-full", 0)];
        let mut reduced_turn = projected("user-full", 0);
        reduced_turn.body_event_count = 0;
        let reduced = vec![reduced_turn];

        // A Reduced pre-warm alone: served to Reduced readers (Claude's
        // native fidelity), treated as a miss by Full readers, and NOT
        // evicted by that miss.
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Reduced,
            reduced.clone(),
        );
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Reduced)
            .is_some());

        // The Full recompute upgrades the entry in place…
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Full,
            full.clone(),
        );
        // …and a later Reduced pre-warm for the SAME signature (replay
        // opened after the metadata index ran) cannot downgrade it.
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Reduced,
            reduced,
        );
        let served = cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Full)
            .expect("full projection retained");
        assert_eq!(served[0].body_event_count, 1);

        // A NEW signature always wins regardless of quality — staleness
        // beats fidelity.
        let mut newer_reduced = projected("user-newer", 5);
        newer_reduced.body_event_count = 0;
        cache.insert(
            "cursoride-a".to_string(),
            (2, 2),
            ProjectionQuality::Reduced,
            vec![newer_reduced],
        );
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Reduced)
            .is_none());
        assert!(cache
            .get("cursoride-a", (2, 2), ProjectionQuality::Reduced)
            .is_some());
    }
}
