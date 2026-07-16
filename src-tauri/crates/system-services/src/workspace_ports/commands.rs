//! Tauri commands for workspace port scanning.

use super::advertised_urls;
use super::scanner;
use super::types::{
    WorkspacePortIngestAdvertisedUrlRequest, WorkspacePortIngestAdvertisedUrlResult,
    WorkspacePortKillRequest, WorkspacePortKillResult, WorkspacePortScanRequest,
    WorkspacePortScanResult,
};

/// Scan local listening TCP ports and attribute them to workspace folders.
#[tauri::command]
pub async fn workspace_ports_scan(
    request: WorkspacePortScanRequest,
) -> Result<WorkspacePortScanResult, String> {
    tokio::task::spawn_blocking(move || scanner::scan_workspace_ports(&request.folders))
        .await
        .map_err(|error| format!("Task join error: {error}"))
}

/// Stop a workspace-owned listening process after re-verifying ownership.
#[tauri::command]
pub async fn workspace_ports_kill(
    request: WorkspacePortKillRequest,
) -> Result<WorkspacePortKillResult, String> {
    tokio::task::spawn_blocking(move || scanner::kill_workspace_port(&request))
        .await
        .map_err(|error| format!("Task join error: {error}"))
}

/// Ingest an advertised URL from terminal output into the port URL cache.
#[tauri::command]
pub async fn workspace_ports_ingest_advertised_url(
    request: WorkspacePortIngestAdvertisedUrlRequest,
) -> Result<WorkspacePortIngestAdvertisedUrlResult, String> {
    tokio::task::spawn_blocking(move || {
        match advertised_urls::ingest_advertised_url(&request.folder_id, &request.origin) {
            Some((accepted, port)) => WorkspacePortIngestAdvertisedUrlResult {
                accepted,
                port: Some(port),
            },
            None => WorkspacePortIngestAdvertisedUrlResult {
                accepted: false,
                port: None,
            },
        }
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))
}
