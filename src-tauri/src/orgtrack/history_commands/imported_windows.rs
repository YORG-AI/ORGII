use super::*;

use super::projection::{
    imported_transcript_signature, open_cache_conn, remember_imported_turn_projection,
    ProjectionQuality, IMPORTED_CLOUD_TURN_WINDOW_LIMIT, IMPORTED_INITIAL_RECENT_TURN_COUNT,
};

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
