use crate::projects::types::CommentEntry;

use super::{
    discussion, properties, readiness, routine_webhook, subscriptions, DiscussionPostRequest,
    DiscussionPostResult, DiscussionThreadMutation, DiscussionTriggerPreview,
    DiscussionTriggerPreviewRequest, PrReadiness, PropertyDefinition, RoutineWebhookDelivery,
    RoutineWebhookInstallInfo, RoutineWebhookStatus, SetWorkItemPropertyValueRequest,
    SubscriptionMutation, UpsertPropertyDefinitionRequest, WorkItemPropertyValue, WorkItemScope,
    WorkItemSubscription,
};

#[tauri::command]
pub async fn project_discussion_preview_trigger(
    request: DiscussionTriggerPreviewRequest,
) -> Result<DiscussionTriggerPreview, String> {
    tokio::task::spawn_blocking(move || discussion::preview(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_discussion_post_comment(
    app: tauri::AppHandle,
    request: DiscussionPostRequest,
) -> Result<DiscussionPostResult, String> {
    let result = tokio::task::spawn_blocking(move || discussion::post(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_discussion_resolve_thread(
    app: tauri::AppHandle,
    request: DiscussionThreadMutation,
) -> Result<Vec<CommentEntry>, String> {
    let result = tokio::task::spawn_blocking(move || discussion::resolve_thread(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_discussion_reopen_thread(
    app: tauri::AppHandle,
    request: DiscussionThreadMutation,
) -> Result<Vec<CommentEntry>, String> {
    let result = tokio::task::spawn_blocking(move || discussion::reopen_thread(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_subscribe_work_item(
    request: SubscriptionMutation,
) -> Result<Vec<WorkItemSubscription>, String> {
    tokio::task::spawn_blocking(move || subscriptions::subscribe(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_unsubscribe_work_item(
    request: SubscriptionMutation,
) -> Result<Vec<WorkItemSubscription>, String> {
    tokio::task::spawn_blocking(move || subscriptions::unsubscribe(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_list_work_item_subscriptions(
    scope: WorkItemScope,
) -> Result<Vec<WorkItemSubscription>, String> {
    tokio::task::spawn_blocking(move || subscriptions::list(&scope))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_get_work_item_pr_readiness(
    scope: WorkItemScope,
) -> Result<PrReadiness, String> {
    tokio::task::spawn_blocking(move || readiness::get(&scope))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_upsert_property_definition(
    app: tauri::AppHandle,
    request: UpsertPropertyDefinitionRequest,
) -> Result<PropertyDefinition, String> {
    let result = tokio::task::spawn_blocking(move || properties::upsert_definition(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_list_property_definitions(
    org_id: String,
    include_archived: Option<bool>,
) -> Result<Vec<PropertyDefinition>, String> {
    tokio::task::spawn_blocking(move || {
        properties::list_definitions(&org_id, include_archived.unwrap_or(false))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_archive_property_definition(
    app: tauri::AppHandle,
    property_id: String,
) -> Result<PropertyDefinition, String> {
    let result = tokio::task::spawn_blocking(move || properties::archive_definition(&property_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_set_work_item_property_value(
    app: tauri::AppHandle,
    request: SetWorkItemPropertyValueRequest,
) -> Result<Option<WorkItemPropertyValue>, String> {
    let result = tokio::task::spawn_blocking(move || properties::set_value(request))
        .await
        .map_err(|err| format!("Task join error: {err}"))?;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(
            crate::projects::events::DATA_CHANGED_EVENT,
            chrono::Utc::now().to_rfc3339(),
        );
    }
    result
}

#[tauri::command]
pub async fn project_list_work_item_property_values(
    scope: WorkItemScope,
) -> Result<Vec<WorkItemPropertyValue>, String> {
    tokio::task::spawn_blocking(move || properties::list_values(&scope))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_install(
    routine_name: String,
) -> Result<RoutineWebhookInstallInfo, String> {
    tokio::task::spawn_blocking(move || routine_webhook::install(&routine_name))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_rotate(
    routine_name: String,
) -> Result<RoutineWebhookInstallInfo, String> {
    tokio::task::spawn_blocking(move || routine_webhook::install(&routine_name))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_status(
    routine_name: String,
) -> Result<RoutineWebhookStatus, String> {
    tokio::task::spawn_blocking(move || routine_webhook::status(&routine_name))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_set_enabled(
    routine_name: String,
    enabled: bool,
) -> Result<RoutineWebhookStatus, String> {
    tokio::task::spawn_blocking(move || routine_webhook::set_enabled(&routine_name, enabled))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_list_deliveries(
    routine_name: String,
    limit: Option<usize>,
) -> Result<Vec<RoutineWebhookDelivery>, String> {
    tokio::task::spawn_blocking(move || {
        routine_webhook::list_deliveries(&routine_name, limit.unwrap_or(50))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_routine_webhook_replay(
    delivery_id: String,
) -> Result<RoutineWebhookDelivery, String> {
    tokio::task::spawn_blocking(move || routine_webhook::replay(&delivery_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}
