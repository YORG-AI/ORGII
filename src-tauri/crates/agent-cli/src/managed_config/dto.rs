//! Serde types shared by the managed-config manifest, status and
//! selection surfaces.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigMode {
    Default,
    OrgiiManaged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigTargetFileManifest {
    pub id: String,
    pub target_path: String,
    pub default_backup_path: String,
    pub managed_profile_path: String,
    pub original_hash: Option<String>,
    pub last_applied_hash: Option<String>,
    #[serde(default)]
    pub default_was_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigProfileManifest {
    pub agent: String,
    pub mode: CliConfigMode,
    pub target_files: Vec<CliConfigTargetFileManifest>,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub proxy_token: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigTargetFileStatus {
    pub id: String,
    pub target_path: String,
    pub default_backup_path: String,
    pub managed_profile_path: String,
    pub target_exists: bool,
    pub has_default_backup: bool,
    pub default_was_missing: bool,
    pub original_hash: Option<String>,
    pub last_applied_hash: Option<String>,
    pub current_hash: Option<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigManagedStatus {
    pub agent_name: String,
    pub supported: bool,
    pub mode: CliConfigMode,
    pub has_default_backup: bool,
    pub conflict: bool,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    pub target_files: Vec<CliConfigTargetFileStatus>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagedConfigSelection {
    pub agent_name: String,
    pub mode: CliConfigMode,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub proxy_url: Option<String>,
    pub proxy_token: Option<String>,
}

#[derive(Debug, Default)]
pub struct CliConfigShutdownRestoreReport {
    pub restored_agents: Vec<String>,
    pub failed_agents: Vec<(String, String)>,
}
