//! Wire types for the skills.sh Skills directory API.
//!
//! Field names match the upstream JSON; `serde(rename_all = "camelCase")`
//! keeps the Rust side snake_case while honoring the wire format.

use serde::{Deserialize, Serialize};

/// A skill search result normalized from the skills.sh search response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSkillResult {
    /// skills.sh public detail path, e.g. `vercel-labs/skills/find-skills`.
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub updated_at: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub installs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSkillStats {
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub installs_all_time: u64,
    #[serde(default)]
    pub installs_current: u64,
    #[serde(default)]
    pub stars: u64,
    #[serde(default)]
    pub versions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSkillOwner {
    pub handle: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
}

/// Full skill detail returned by `skills_hub_detail`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSkillDetail {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub stats: Option<HubSkillStats>,
    #[serde(default)]
    pub owner: Option<HubSkillOwner>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<u64>,
    #[serde(default)]
    pub changelog: Option<String>,
    #[serde(default)]
    pub skill_md: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub installs: Option<u64>,
    #[serde(default)]
    pub snapshot_hash: Option<String>,
}

/// Result of installing a skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubInstallResult {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSnapshotFile {
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDownloadResponse {
    pub files: Vec<SkillSnapshotFile>,
    pub hash: String,
}

/// Info about a skill that has an available update on skills.sh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateInfo {
    pub name: String,
    pub slug: String,
    pub installed_version: String,
    pub latest_version: String,
    pub changelog: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}
