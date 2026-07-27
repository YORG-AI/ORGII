use super::service::DiagnosticsService;
use super::types::{DiagnosticsFlushStatus, DiagnosticsServiceConfig, DiagnosticsUsageSnapshot};

#[tauri::command]
pub async fn diagnostics_initialize(config: DiagnosticsServiceConfig) -> Result<(), String> {
    DiagnosticsService::global().initialize(config).await
}

#[tauri::command]
pub async fn diagnostics_submit_usage_snapshot(
    snapshot: DiagnosticsUsageSnapshot,
) -> Result<DiagnosticsFlushStatus, String> {
    DiagnosticsService::global()
        .submit_usage_snapshot(snapshot)
        .await
}
