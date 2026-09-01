use super::*;

use super::projection::{
    cursor_turns_to_projected, imported_transcript_signature, open_cache_conn,
    remember_imported_turn_projection, ProjectionQuality,
};

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
