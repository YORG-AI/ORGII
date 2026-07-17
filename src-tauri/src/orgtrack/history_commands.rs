use std::{collections::HashSet, path::Path};

use database::db::get_connection;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::{
    db as cursor_db, disk_reads as cursor_disk_reads, history as cursor_db_history,
};
use orgtrack_core::sources::imported_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;
use orgtrack_core::pricing;
use session_persistence::CachedTurnSummary;

use super::external_cli_detection::{self, ExternalCliSourceProbe};

fn open_cache_conn() -> Result<rusqlite::Connection, String> {
    get_connection().map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))
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
            status: "completed".to_string(),
            interrupted: false,
            modified_files: round.modified_files,
            resource_interactions: round.resource_interactions,
            git_artifacts: round.git_artifacts,
        })
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
        if let Some(chunks) =
            imported_history::load_activity_chunks_for_session(&conn, &transcript_session_id)?
        {
            let projected =
                orgtrack_core::projectors::turn_metadata::project_activity_chunks(&chunks);
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
    Ok(imported_history::recent_paths_from_paths(&paths))
}

/// Force a full rescan of a single external history source.
///
/// Clears every cached metadata row for `source` from
/// `imported_history_session_cache`. The next sidebar/list load re-reads the
/// source's on-disk store from scratch (no cached signatures means the
/// delta-sync treats every session as new) and repopulates the cache.
#[tauri::command]
pub async fn external_history_rescan_source(source: String, clear: bool) -> Result<(), String> {
    if !imported_history::metadata::is_imported_history_source(&source) {
        return Err(format!("Unknown external history source: {source}"));
    }
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        // `clear`: wipe the source's cached rows so every session is re-parsed
        // from scratch (drops stale rows / forces a full re-parse even when
        // file signatures are unchanged). Otherwise this is an incremental
        // "update" — only sessions whose signature changed are re-parsed.
        if clear {
            imported_history::cache::prune_missing_records_from_conn(&conn, &source, &[])?;
        }
        // Always re-read the on-disk store and repopulate the cache. The old
        // behavior only pruned, leaving the count at 0 until a later lazy load.
        crate::agent_sessions::session_directory::aggregation::resync_external_history_source(
            &mut conn, &source,
        )
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
) -> Result<(), String> {
    let mut seen_sources = HashSet::with_capacity(sources.len());
    for source in &sources {
        if !seen_sources.insert(source.as_str()) {
            return Err(format!("Duplicate external history source: {source}"));
        }
        if !imported_history::metadata::is_imported_history_source(source) {
            return Err(format!("Unknown external history source: {source}"));
        }
    }

    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        for source in sources {
            if clear {
                imported_history::cache::prune_missing_records_from_conn(&conn, &source, &[])?;
            }
            crate::agent_sessions::session_directory::aggregation::resync_external_history_source(
                &mut conn, &source,
            )?;
        }
        Ok(())
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
        cursor_db_history::load_initial_window_for_session(&mut conn, &session_id, recent_limit)
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
pub async fn codex_app_chunks(
    session_id: String,
) -> Result<Vec<core_types::activity::ActivityChunk>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        codex_app::load_codex_app_for_session(&conn, &session_id)
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
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscriptStat {
    pub mtime_ms: i64,
    pub size_bytes: u64,
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
                },
            ),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Source-agnostic freshness probe for the replay auto-refresh: resolves the
/// session's transcript path from the imported-history cache and stats it
/// (folding in the SQLite `-wal` sibling for WAL-mode stores, whose main db
/// mtime doesn't move between checkpoints). `None` when the session is
/// uncached or the file is missing — the frontend then falls back to the
/// full refresh, which re-syncs the cache.
#[tauri::command]
pub async fn imported_history_stat(
    source_id: String,
    session_id: String,
) -> Result<Option<ImportedTranscriptStat>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        Ok(
            imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
                &conn, &source_id, &session_id,
            )?
            .map(|(mtime_ms, size_bytes)| ImportedTranscriptStat {
                mtime_ms,
                size_bytes,
            }),
        )
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

/// Number of hidden sub-agent sessions cached for an importable source — Cursor's
/// sub-agent composers, which are folded under a parent and excluded from the
/// normal list queries. 0 for every other source today. Surfaced as its own
/// column in the Data Sources panel next to the top-level session count.
#[tauri::command]
pub async fn imported_history_subagent_count(source: String) -> Result<usize, String> {
    if !imported_history::metadata::is_imported_history_source(&source) {
        return Ok(0);
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        let (_sessions, subagents) =
            imported_history::cache::source_session_counts_from_conn(&conn, &source)?;
        Ok(subagents)
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
}
