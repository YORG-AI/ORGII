use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum DiagnosticsLevel {
    Off,
    PerformanceOnly,
    #[default]
    Default,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsServiceConfig {
    #[serde(default)]
    pub diagnostics_level: DiagnosticsLevel,
    #[serde(default)]
    pub offline_mode: bool,
}

impl Default for DiagnosticsServiceConfig {
    fn default() -> Self {
        Self {
            diagnostics_level: DiagnosticsLevel::Default,
            offline_mode: false,
        }
    }
}

impl DiagnosticsServiceConfig {
    pub fn uploads_enabled(&self) -> bool {
        !self.offline_mode
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRuntimeSummary {
    pub total: u64,
    pub success: u64,
    pub failure: u64,
    #[serde(default)]
    pub by_operation: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsUsageSnapshot {
    pub schema_version: u32,
    pub diagnostics_level: DiagnosticsLevel,
    pub captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    pub app_launch_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_usage_duration_bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_profile: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_resource_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_models_by_run_count: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rust_agent_top_sessions_by_duration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_tools: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_languages: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc: Option<DiagnosticsRuntimeSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<DiagnosticsRuntimeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsQueueRecord {
    pub id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
    pub snapshot: DiagnosticsUsageSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsFlushStatus {
    pub endpoint_configured: bool,
    pub attempted: bool,
    pub uploaded: usize,
    pub queued_unsent: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsUploadPayload {
    pub schema_version: u32,
    pub install_id: String,
    pub generated_at: String,
    pub records: Vec<DiagnosticsQueueRecord>,
}
