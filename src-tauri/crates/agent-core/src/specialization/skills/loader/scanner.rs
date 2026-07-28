//! SkillsLoader — core scanning and loading logic.

use std::path::{Path, PathBuf};

use super::source_dirs::source_dir_path;

mod cache;
mod fs_scan;
mod listing;
mod loading;
mod metadata;

#[cfg(test)]
mod include_filter_tests;
#[cfg(test)]
mod listing_budget_tests;
#[cfg(test)]
mod listing_order_and_path_tests;

// Re-imported (module-private) so the listing-budget tests below can reach
// them as `super::SKILL_LISTING_CHAR_BUDGET` — the constants themselves
// live in `listing`, which owns the rendering logic that uses them.
#[cfg(test)]
use listing::{SKILL_LISTING_CHAR_BUDGET, SKILL_LISTING_MAX_DESC_CHARS};

/// Loads and manages agent skills.
pub struct SkillsLoader {
    workspace: PathBuf,
    builtin_dir: Option<PathBuf>,
    extra_source_dirs: Vec<PathBuf>,
    disabled_skills: Vec<String>,
    skills_enabled: bool,
    agent_id: Option<String>,
    load_workspace_resources: bool,
}

impl SkillsLoader {
    /// Create a new skills loader.
    ///
    /// - `workspace`: Agent workspace directory (checks `{workspace}/skills/`)
    /// - Builtin skills are optional.
    pub fn new(workspace: &Path) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            builtin_dir: None,
            extra_source_dirs: Vec::new(),
            disabled_skills: Vec::new(),
            skills_enabled: true,
            agent_id: None,
            load_workspace_resources: true,
        }
    }

    /// Set the directory for builtin skills.
    pub fn with_builtin_dir(mut self, dir: PathBuf) -> Self {
        self.builtin_dir = Some(dir);
        self
    }

    /// Add read-only skill source directories for this loader.
    pub fn with_extra_source_dirs(mut self, dirs: &[String]) -> Self {
        self.extra_source_dirs = dirs.iter().map(|dir| source_dir_path(dir)).collect();
        self.extra_source_dirs.sort();
        self.extra_source_dirs.dedup();
        self
    }

    /// Set skill names that the user has disabled.
    pub fn with_disabled_skills(mut self, disabled: Vec<String>) -> Self {
        self.disabled_skills = disabled;
        self
    }

    /// Set whether skills are globally enabled.
    pub fn with_skills_enabled(mut self, enabled: bool) -> Self {
        self.skills_enabled = enabled;
        self
    }

    pub fn with_agent_id(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id.into());
        self
    }

    pub fn with_load_workspace_resources(mut self, enabled: bool) -> Self {
        self.load_workspace_resources = enabled;
        self
    }

    /// Whether skills are globally enabled.
    pub fn is_enabled(&self) -> bool {
        self.skills_enabled
    }
}
