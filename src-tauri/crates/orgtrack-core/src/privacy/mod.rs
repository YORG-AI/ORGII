use serde::{Deserialize, Serialize};

pub const ORGTRACK_SCHEMA_VERSION: u32 = 1;
pub const ORGTRACK_DIR_NAME: &str = ".orgtrack";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgtrackTier {
    Meta,
    Details,
    Trajectory,
}

impl OrgtrackTier {
    pub fn from_optional_str(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("meta") {
            "meta" => Ok(Self::Meta),
            "details" => Ok(Self::Details),
            "trajectory" => Ok(Self::Trajectory),
            other => Err(format!("Unsupported orgtrack tier: {}", other)),
        }
    }

    pub fn includes_details(self) -> bool {
        matches!(self, Self::Details | Self::Trajectory)
    }

    pub fn includes_trajectory(self) -> bool {
        matches!(self, Self::Trajectory)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct RedactionPolicy {
    pub include_raw_prompts: bool,
    pub include_tool_args: bool,
    pub include_tool_results: bool,
    pub include_file_contents: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyConfig {
    pub schema_version: u32,
    pub default_tier: OrgtrackTier,
    pub tracked_tiers: Vec<OrgtrackTier>,
    pub redaction_policy: RedactionPolicy,
    pub trajectory_gitignore_recommended: bool,
    pub derived_indexes_rebuildable: bool,
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            default_tier: OrgtrackTier::Meta,
            tracked_tiers: vec![OrgtrackTier::Meta],
            redaction_policy: RedactionPolicy::default(),
            trajectory_gitignore_recommended: true,
            derived_indexes_rebuildable: true,
        }
    }
}
