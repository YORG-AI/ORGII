use std::{collections::HashSet, path::Path, sync::OnceLock};

use database::db::get_connection;
use orgtrack_core::pricing;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::db as cursor_db;
use orgtrack_core::sources::imported_history;
use orgtrack_core::sources::imported_history::replay::{self, ImportedHistorySourceId};
use orgtrack_core::sources::mimo_code::history as mimo_code_history;
use orgtrack_core::sources::omp::history as omp_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::qoder_cli::history as qoder_cli_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;
use session_persistence::CachedTurnSummary;

use super::external_cli_detection::{self, ExternalCliSourceProbe};

fn open_cache_conn() -> Result<rusqlite::Connection, String> {
    get_connection().map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))
}

static EXTERNAL_HISTORY_SCAN_QUEUE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

async fn acquire_external_history_scan_permit(
) -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    EXTERNAL_HISTORY_SCAN_QUEUE
        .get_or_init(|| tokio::sync::Semaphore::new(1))
        .acquire()
        .await
        .map_err(|_| "External history scan queue closed".to_string())
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

fn metadata_cache_miss_requires_sync(source: ImportedHistorySourceId) -> bool {
    !matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    )
}

/// Unified per-round metadata read surface. Native SDE sessions keep using the
/// versioned local turn cache. Imported and managed CLI sessions project only
/// visible turns from the compact replay index and never hydrate a transcript.
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
        // Managed native-transcript sessions project from the CLI's own
        // store: remap the managed id to its imported transcript id first.
        let transcript_session_id =
            crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
                &session_id,
            )
            .unwrap_or_else(|| session_id.clone());
        if let Some(source) = ImportedHistorySourceId::from_session_id(&transcript_session_id) {
            let cached = {
                let conn = open_cache_conn()?;
                replay::project_cached_turn_metadata(
                    &conn,
                    source,
                    &transcript_session_id,
                    turn_ids.as_deref(),
                )?
            };
            if let Some(projected) = cached {
                return Ok(projected_rounds_to_cached_turns(&session_id, projected));
            }
            // Cursor/Windsurf materialize old KV turn bodies lazily. A
            // metadata-only caller must wait for the foreground compact index
            // instead of taking the application writer lock and hydrating the
            // requested body as a cache-miss fallback.
            if !metadata_cache_miss_requires_sync(source) {
                return Ok(Vec::new());
            }
            let projected = database::db::with_sessions_writer(|| {
                let mut conn = open_cache_conn()?;
                replay::project_turn_metadata(
                    &mut conn,
                    source,
                    &transcript_session_id,
                    turn_ids.as_deref(),
                )
            })?;
            return Ok(projected_rounds_to_cached_turns(&session_id, projected));
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
    database::db::with_sessions_writer(|| {
        let mut conn = open_cache_conn()?;
        let mut paths = Vec::new();
        for source in ImportedHistorySourceId::ALL {
            imported_history::catalog::refresh_source(&mut conn, source)?;
            paths.extend(
                imported_history::cache::query_imported_recent_paths_from_conn(
                    &conn,
                    source.as_str(),
                    0,
                )?,
            );
        }
        Ok(imported_history::recent_paths_from_paths(&paths))
    })
}

/// Refresh one source's compact catalog and return only grouped path rows.
/// Source-specific legacy `list_*_recent_paths` functions historically
/// rebuilt changed transcripts before answering this lightweight request;
/// routing every command through the replay registry prevents a settings or
/// spotlight view from re-reading a growing JSONL/SQLite history in full.
fn compact_recent_paths(
    source: ImportedHistorySourceId,
    limit: usize,
) -> Result<Vec<imported_history::ImportedHistoryRecentPath>, String> {
    database::db::with_sessions_writer(|| {
        let mut conn = open_cache_conn()?;
        imported_history::catalog::refresh_source(&mut conn, source)?;
        imported_history::cache::query_imported_recent_paths_from_conn(
            &conn,
            source.as_str(),
            limit,
        )
    })
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
    /// not. `changed_sources` only reports writes made by THIS call; other
    /// surfaces (kanban, usage, transcript pagers) sync the same cache
    /// between scheduler ticks, and continuation demotions applied during
    /// those foreign syncs would otherwise never look like a change here.
    /// The frontend compares these against the signatures captured at its
    /// last roster reload to decide whether the sidebar is stale.
    pub source_signatures: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub async fn external_history_rescan_source(
    source: String,
    clear: bool,
) -> Result<ExternalHistoryScanResultWire, String> {
    if !imported_history::metadata::is_imported_history_source(&source) {
        return Err(format!("Unknown external history source: {source}"));
    }
    let _permit = acquire_external_history_scan_permit().await?;
    tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| {
            let mut conn = open_cache_conn()?;
            let changes_before = conn.total_changes();
            // `clear`: wipe the source's cached rows so every session is re-parsed
            // from scratch (drops stale rows / forces a full re-parse even when
            // file signatures are unchanged). Otherwise this is an incremental
            // "update" — only sessions whose signature changed are re-parsed.
            if clear {
                imported_history::cache::prune_missing_records_from_conn(&conn, &source, &[])?;
            }
            // Always re-read the on-disk store and repopulate the compact cache.
            crate::agent_sessions::session_directory::aggregation::resync_external_history_source(
                &mut conn, &source,
            )?;
            let changed = conn.total_changes() > changes_before;
            let signature =
                imported_history::cache::query_source_cache_signature_from_conn(&conn, &source)?;
            Ok(ExternalHistoryScanResultWire {
                changed_sources: changed.then_some(source.clone()).into_iter().collect(),
                source_signatures: std::iter::once((source, signature)).collect(),
            })
        })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
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

    let _permit = acquire_external_history_scan_permit().await?;
    tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| {
            let mut conn = open_cache_conn()?;
            let mut changed_sources = Vec::new();
            let mut source_signatures = std::collections::HashMap::new();
            for source in sources {
                let changes_before = conn.total_changes();
                if clear {
                    imported_history::cache::prune_missing_records_from_conn(
                        &conn,
                        &source,
                        &[],
                    )?;
                }
                crate::agent_sessions::session_directory::aggregation::resync_external_history_source(
                    &mut conn,
                    &source,
                )?;
                let changed = conn.total_changes() > changes_before;
                source_signatures.insert(
                    source.clone(),
                    imported_history::cache::query_source_cache_signature_from_conn(
                        &conn,
                        &source,
                    )?,
                );
                if changed {
                    changed_sources.push(source);
                }
            }
            Ok(ExternalHistoryScanResultWire {
                changed_sources,
                source_signatures,
            })
        })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Source-neutral compact recent-path query used by settings and workspace
/// discovery. The source registry owns refresh semantics for all 15 adapters;
/// adding a source without a catalog adapter fails in the exhaustive Rust
/// match instead of silently falling back to a transcript loader.
#[tauri::command]
pub async fn external_history_recent_paths(
    source: String,
    limit: Option<usize>,
) -> Result<Vec<imported_history::ImportedHistoryRecentPath>, String> {
    let source = ImportedHistorySourceId::parse(&source)?;
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(source, limit))
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
pub async fn codex_app_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<codex_app::CodexAppRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        compact_recent_paths(ImportedHistorySourceId::CodexApp, limit)
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
pub async fn claude_code_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<claude_code_history::ClaudeCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        compact_recent_paths(ImportedHistorySourceId::ClaudeCode, limit)
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
        compact_recent_paths(ImportedHistorySourceId::CursorCli, limit)
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
        compact_recent_paths(ImportedHistorySourceId::OpenCode, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn warp_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<warp_history::WarpRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::Warp, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn zcode_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<zcode_history::ZCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::ZCode, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<qoder_history::QoderRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::Qoder, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn mimo_code_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<mimo_code_history::MimoCodeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        compact_recent_paths(ImportedHistorySourceId::MimoCode, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn omp_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<omp_history::OmpRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::Omp, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn qoder_cli_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<qoder_cli_history::QoderCliRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        compact_recent_paths(ImportedHistorySourceId::QoderCli, limit)
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
        compact_recent_paths(ImportedHistorySourceId::Windsurf, limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn trae_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<trae_history::TraeRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::Trae, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn cline_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<cline_history::ClineRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || compact_recent_paths(ImportedHistorySourceId::Cline, limit))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn workbuddy_recent_paths(
    limit: Option<usize>,
) -> Result<Vec<workbuddy_history::WorkBuddyRecentPath>, String> {
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || {
        compact_recent_paths(ImportedHistorySourceId::WorkBuddy, limit)
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
    fn lazy_kv_metadata_cache_misses_never_take_the_sync_fallback() {
        assert!(!metadata_cache_miss_requires_sync(
            ImportedHistorySourceId::CursorIde
        ));
        assert!(!metadata_cache_miss_requires_sync(
            ImportedHistorySourceId::Windsurf
        ));
        assert!(metadata_cache_miss_requires_sync(
            ImportedHistorySourceId::OpenCode
        ));
        assert!(metadata_cache_miss_requires_sync(
            ImportedHistorySourceId::CodexApp
        ));
    }
}
