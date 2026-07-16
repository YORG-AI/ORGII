//! Wire types for workspace port scanning.

use serde::{Deserialize, Serialize};

/// Folder probe used to attribute listening ports to a workspace root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortProbe {
    pub id: String,
    pub repo_id: String,
    pub display_name: String,
    pub path: String,
}

/// How confidently a port was attributed to a workspace folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePortAttributionConfidence {
    Cwd,
    Command,
    None,
}

/// Workspace folder that owns a listening port.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortOwner {
    pub folder_id: String,
    pub repo_id: String,
    pub display_name: String,
    pub path: String,
    pub confidence: WorkspacePortAttributionConfidence,
}

/// Protocol inferred for open/copy actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePortProtocol {
    Http,
    Https,
    Unknown,
}

/// Classification of a listening port relative to open workspace folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePortKind {
    Workspace,
    Container,
    External,
}

/// A single listening TCP port discovered on the host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePort {
    pub id: String,
    /// Address reported by the OS listener. May be a wildcard bind.
    pub bind_host: String,
    /// Address the UI should copy/open. Wildcard binds normalize to localhost.
    pub connect_host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    pub protocol: WorkspacePortProtocol,
    pub kind: WorkspacePortKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<WorkspacePortOwner>,
    /// Origin captured from terminal output (e.g. Vite Local URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advertised_url: Option<String>,
}

/// Request body for a workspace port scan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortScanRequest {
    #[serde(default)]
    pub folders: Vec<WorkspacePortProbe>,
}

/// Result of a workspace port scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortScanResult {
    pub platform: String,
    pub scanned_at: u64,
    pub ports: Vec<WorkspacePort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// Request to stop a workspace-owned listening process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortKillRequest {
    #[serde(default)]
    pub folders: Vec<WorkspacePortProbe>,
    pub pid: u32,
    pub port: u16,
}

/// Result of a kill attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortKillResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Request to store an advertised URL from terminal output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortIngestAdvertisedUrlRequest {
    pub folder_id: String,
    pub origin: String,
}

/// Result of ingesting an advertised URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePortIngestAdvertisedUrlResult {
    /// True when a new or changed `{folderId, port, origin}` was stored.
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}
