use super::{
    list_page, mark_all_read, mark_read, mark_unread, unread_count, TeamInboxCursor,
    TeamInboxFilter, TeamInboxListOptions, TeamInboxPage,
};

#[tauri::command]
pub async fn team_inbox_list_page(
    viewer_member_ids: Vec<String>,
    filter: Option<TeamInboxFilter>,
    cursor: Option<TeamInboxCursor>,
    limit: Option<usize>,
) -> Result<TeamInboxPage, String> {
    tokio::task::spawn_blocking(move || {
        list_page(TeamInboxListOptions {
            viewer_member_ids,
            filter: filter.unwrap_or_default(),
            cursor,
            limit: limit.unwrap_or(50),
        })
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
pub async fn team_inbox_unread_count(
    viewer_member_ids: Vec<String>,
    filter: Option<TeamInboxFilter>,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || unread_count(viewer_member_ids, filter.unwrap_or_default()))
        .await
        .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
pub async fn team_inbox_mark_read(
    viewer_member_ids: Vec<String>,
    item_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || mark_read(viewer_member_ids, &item_id))
        .await
        .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
pub async fn team_inbox_mark_all_read(
    viewer_member_ids: Vec<String>,
    filter: Option<TeamInboxFilter>,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        mark_all_read(viewer_member_ids, filter.unwrap_or_default())
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
pub async fn team_inbox_mark_unread(
    viewer_member_ids: Vec<String>,
    item_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || mark_unread(viewer_member_ids, &item_id))
        .await
        .map_err(|error| format!("Task join error: {error}"))?
}
