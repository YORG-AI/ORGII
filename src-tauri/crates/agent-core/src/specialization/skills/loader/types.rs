//! Skill types and metadata structures.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::skills::provenance::SkillOrigin;

/// Quality rating for a skill's description.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DescriptionQuality {
    Good,
    Short,
    Missing,
}

/// Metadata for a skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Stable ORGII identity. Remote refresh never replaces this value.
    #[serde(default)]
    pub id: String,
    /// Skill name (directory name).
    pub name: String,
    /// Full path to SKILL.md.
    pub path: PathBuf,
    /// Source: "workspace", "builtin", "external-source", "agent-source", or "embedded_builtin".
    pub source: String,
    /// Import provenance when the skill was installed from a refreshable or
    /// externally managed source. Local authored skills leave this empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<SkillOrigin>,
    /// Digests of the currently effective identity, complete bundle, and
    /// parsed discovery schema. These are copied into WorkItemRun snapshots;
    /// the full skill body is intentionally not pinned there.
    #[serde(default)]
    pub identity_digest: String,
    #[serde(default)]
    pub content_digest: String,
    #[serde(default)]
    pub schema_digest: String,
    /// `false` when a remotely installed bundle no longer matches the last
    /// explicit install/refresh consent record. Such a skill is not runnable.
    #[serde(default = "default_true")]
    pub consent_valid: bool,
    /// Whether the skill is always loaded into context.
    pub always: bool,
    /// Whether all requirements (binaries, env vars) are met.
    pub available: bool,
    /// Whether the user has enabled this skill (not in `disabledSkills`).
    pub enabled: bool,
    /// Required binaries.
    pub required_bins: Vec<String>,
    /// Required environment variables.
    pub required_env: Vec<String>,
    /// Short description (first non-header line).
    pub description: String,
    /// Estimated tokens this skill adds to the prompt manifest.
    /// Full SKILL.md content is loaded on demand through `read_file`.
    pub estimated_tokens: usize,
    /// Estimated tokens for the full SKILL.md content.
    /// Always set regardless of `always` flag, so the UI can show file size.
    pub full_content_tokens: usize,
    /// Quality of the skill description for agent discovery.
    pub description_quality: DescriptionQuality,
    /// Skill version from frontmatter (empty if not specified).
    #[serde(default)]
    pub version: String,
    /// License from frontmatter (empty if not specified).
    #[serde(default)]
    pub license: String,
    /// Compatibility notes from frontmatter (empty if not specified).
    #[serde(default)]
    pub compatibility: String,
    /// Which required binaries are not found on PATH.
    #[serde(default)]
    pub missing_bins: Vec<String>,
    /// Which required env vars are not set.
    #[serde(default)]
    pub missing_env: Vec<String>,
    /// Relative paths of bundled files (scripts, references, assets) in the skill directory.
    #[serde(default)]
    pub bundled_files: Vec<String>,
}

/// One entry of the per-request skill listing. Kept as structured fields
/// (not a pre-rendered line) so the render step can apply per-entry and
/// total character budgets to descriptions without corrupting the markup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillListingEntry {
    pub name: String,
    /// Source label ("workspace", "builtin", "external-source", ...).
    pub source: String,
    /// Raw description; caps are applied at render time.
    pub description: String,
    pub available: bool,
}

/// Intermediate result from parsing SKILL.md frontmatter.
#[derive(Default)]
pub(super) struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub always: bool,
    pub version: String,
    pub license: String,
    pub compatibility: String,
    pub required_bins: Vec<String>,
    pub required_env: Vec<String>,
    pub include_agents: Vec<String>,
    pub exclude_agents: Vec<String>,
}

fn default_true() -> bool {
    true
}
