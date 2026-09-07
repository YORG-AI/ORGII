use crate::projects::types::CommentEntry;

use super::{
    discussion, properties, quick_actions, readiness, routine_webhook, saved_views, statuses,
    subscriptions, DiscussionDeleteRequest, DiscussionEditRequest, DiscussionPostRequest,
    DiscussionPostResult, DiscussionThreadMutation, DiscussionTriggerPreview,
    DiscussionTriggerPreviewRequest, InvokeQuickActionRequest, PrReadiness, PropertyDefinition,
    QuickAction, RoutineWebhookDelivery, RoutineWebhookInstallInfo, RoutineWebhookStatus,
    SavedView, ScopePropertyValue, SetWorkItemPropertyValueRequest, StatusDefinition,
    SubscriptionMutation, UpsertPropertyDefinitionRequest, UpsertQuickActionRequest,
    UpsertSavedViewRequest, UpsertStatusDefinitionRequest, WorkItemPropertyValue, WorkItemScope,
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
pub async fn project_discussion_edit_comment(
    app: tauri::AppHandle,
    request: DiscussionEditRequest,
) -> Result<Vec<CommentEntry>, String> {
    let result = tokio::task::spawn_blocking(move || discussion::edit(request))
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
pub async fn project_discussion_delete_comment(
    app: tauri::AppHandle,
    request: DiscussionDeleteRequest,
) -> Result<Vec<CommentEntry>, String> {
    let result = tokio::task::spawn_blocking(move || discussion::delete(request))
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

#[tauri::command]
pub async fn project_list_status_definitions(
    org_id: String,
    include_archived: Option<bool>,
) -> Result<Vec<StatusDefinition>, String> {
    tokio::task::spawn_blocking(move || {
        statuses::list_definitions(&org_id, include_archived.unwrap_or(false))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_upsert_status_definition(
    app: tauri::AppHandle,
    request: UpsertStatusDefinitionRequest,
) -> Result<StatusDefinition, String> {
    let result = tokio::task::spawn_blocking(move || statuses::upsert_definition(request))
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
pub async fn project_set_status_definition_archived(
    app: tauri::AppHandle,
    org_id: String,
    id: String,
    archived: bool,
) -> Result<StatusDefinition, String> {
    let result = tokio::task::spawn_blocking(move || {
        statuses::set_definition_archived(&org_id, &id, archived)
    })
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
pub async fn project_list_saved_views(
    org_id: String,
    project_slug: Option<String>,
) -> Result<Vec<SavedView>, String> {
    tokio::task::spawn_blocking(move || saved_views::list_views(&org_id, project_slug.as_deref()))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_upsert_saved_view(
    app: tauri::AppHandle,
    request: UpsertSavedViewRequest,
) -> Result<SavedView, String> {
    let result = tokio::task::spawn_blocking(move || saved_views::upsert_view(request))
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
pub async fn project_archive_saved_view(
    app: tauri::AppHandle,
    org_id: String,
    id: String,
) -> Result<SavedView, String> {
    let result = tokio::task::spawn_blocking(move || saved_views::archive_view(&org_id, &id))
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
pub async fn project_list_scope_property_values(
    org_id: String,
    project_slug: Option<String>,
) -> Result<Vec<ScopePropertyValue>, String> {
    tokio::task::spawn_blocking(move || {
        properties::list_values_for_scope(&org_id, project_slug.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_batch_set_work_item_property_value(
    app: tauri::AppHandle,
    org_id: String,
    project_slug: Option<String>,
    short_ids: Vec<String>,
    property_id: String,
    value: Option<serde_json::Value>,
) -> Result<usize, String> {
    let result = tokio::task::spawn_blocking(move || {
        properties::batch_set_values(org_id, project_slug, short_ids, property_id, value)
    })
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
pub async fn project_list_quick_actions(org_id: String) -> Result<Vec<QuickAction>, String> {
    tokio::task::spawn_blocking(move || quick_actions::list_actions(&org_id))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn project_upsert_quick_action(
    app: tauri::AppHandle,
    request: UpsertQuickActionRequest,
) -> Result<QuickAction, String> {
    let result = tokio::task::spawn_blocking(move || quick_actions::upsert_action(request))
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
pub async fn project_archive_quick_action(
    app: tauri::AppHandle,
    org_id: String,
    id: String,
) -> Result<QuickAction, String> {
    let result = tokio::task::spawn_blocking(move || quick_actions::archive_action(&org_id, &id))
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
pub async fn project_invoke_quick_action(
    app: tauri::AppHandle,
    request: InvokeQuickActionRequest,
) -> Result<DiscussionPostResult, String> {
    let result = tokio::task::spawn_blocking(move || quick_actions::invoke_action(request))
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
