//! Workspace listening-port detection for the WorkStation status bar.

pub mod advertised_urls;
pub mod attribution;
pub mod commands;
pub mod scanner;
pub mod types;

pub use commands::{
    workspace_ports_ingest_advertised_url, workspace_ports_kill, workspace_ports_scan,
};
pub use types::{
    WorkspacePort, WorkspacePortIngestAdvertisedUrlRequest, WorkspacePortIngestAdvertisedUrlResult,
    WorkspacePortKillRequest, WorkspacePortKillResult, WorkspacePortProbe,
    WorkspacePortScanRequest, WorkspacePortScanResult,
};
