use super::{
    list_page, mark_all_read, mark_read, mark_unread, TeamInboxCursor,
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

#[tauri::command]
pub async fn team_inbox_archive(
    viewer_member_ids: Vec<String>,
    item_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        crate::team_inbox::set_archived(&viewer_member_ids, &item_id, true)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn team_inbox_unarchive(
    viewer_member_ids: Vec<String>,
    item_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        crate::team_inbox::set_archived(&viewer_member_ids, &item_id, false)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn team_inbox_list_muted_kinds(recipient_id: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        crate::work_item_features::subscriptions::list_muted_kinds(&recipient_id)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn team_inbox_set_kind_muted(
    recipient_id: String,
    kind: String,
    muted: bool,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        crate::work_item_features::subscriptions::set_kind_muted(&recipient_id, &kind, muted)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
