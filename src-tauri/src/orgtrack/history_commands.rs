use std::path::Path;

use database::db::get_connection;
use orgtrack_core::sources::claude_code::{db as claude_code_db, history as claude_code_history};
use orgtrack_core::sources::cli_session_db::{self, CliSession};
use orgtrack_core::sources::codex::app as codex_app;
use orgtrack_core::sources::cursor_ide::{db as cursor_db, history as cursor_db_history};
use orgtrack_core::sources::imported_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;

fn open_cache_conn() -> Result<rusqlite::Connection, String> {
    get_connection().map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))
}

fn imported_recent_paths() -> Result<Vec<imported_history::ImportedHistoryRecentPath>, String> {
    let mut conn = open_cache_conn()?;
    let mut paths = codex_app::list_codex_app_recent_paths(&mut conn, 0)?;
    paths.extend(claude_code_history::list_claude_code_recent_paths(
        &mut conn, 0,
    )?);
    paths.extend(opencode_history::list_opencode_recent_paths(&mut conn, 0)?);
    paths.extend(windsurf_history::list_windsurf_recent_paths(&mut conn, 0)?);
    paths.extend(workbuddy_history::list_workbuddy_recent_paths(
        &mut conn, 0,
    )?);
    Ok(imported_history::recent_paths_from_paths(&paths))
}

#[tauri::command]
pub async fn orgtrack_get_cursor_sessions(
    start_date: String,
    end_date: String,
) -> Result<Vec<cursor_db::CursorSession>, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        cursor_db::get_cursor_sessions(&mut conn, &start_date, &end_date)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn orgtrack_get_claude_sessions(
    start_date: String,
    end_date: String,
) -> Result<Vec<claude_code_db::ClaudeCodeSession>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        claude_code_db::get_claude_sessions(&conn, &start_date, &end_date)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn orgtrack_get_cli_sessions(
    tool: Option<String>,
    start_date: String,
    end_date: String,
) -> Result<Vec<CliSession>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_conn()?;
        cli_session_db::get_cli_sessions(&conn, tool.as_deref(), &start_date, &end_date)
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
pub async fn cursor_ide_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<cursor_db_history::CursorIdeSessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        cursor_db_history::list_cursor_ide_sessions_paginated(&mut conn, limit, offset)
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
pub async fn codex_app_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<codex_app::CodexAppSessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        codex_app::list_codex_app_sessions_paginated(&mut conn, limit, offset)
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

#[tauri::command]
pub async fn claude_code_history_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<claude_code_history::ClaudeCodeHistorySessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        claude_code_history::list_claude_code_history_sessions_paginated(&mut conn, limit, offset)
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
pub async fn opencode_history_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<opencode_history::OpenCodeHistorySessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        opencode_history::list_opencode_history_sessions_paginated(&mut conn, limit, offset)
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
pub async fn windsurf_history_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<windsurf_history::WindsurfHistorySessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        windsurf_history::list_windsurf_history_sessions_paginated(&mut conn, limit, offset)
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
pub async fn workbuddy_history_list_sessions(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<workbuddy_history::WorkBuddyHistorySessionPage, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        let mut conn = open_cache_conn()?;
        workbuddy_history::list_workbuddy_history_sessions_paginated(&mut conn, limit, offset)
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
