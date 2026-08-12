//! Scan-result caching for [`super::SkillsLoader::list_skills`].
//!
//! Filesystem scans walk every configured skill source (workspace,
//! builtin, extra source dirs), so results are cached per distinct loader
//! configuration and refreshed on a short TTL rather than re-scanned on
//! every call.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use super::super::types::SkillInfo;
use super::SkillsLoader;
use crate::utils::swr_cache::SwrCache;

const SKILL_SCAN_CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SkillScanKey {
    workspace: PathBuf,
    builtin_dir: Option<PathBuf>,
    extra_source_dirs: Vec<PathBuf>,
    agent_id: Option<String>,
    load_workspace_resources: bool,
}

static SKILL_SCAN_CACHE: LazyLock<Arc<SwrCache<SkillScanKey, Vec<SkillInfo>>>> =
    LazyLock::new(Arc::default);

impl SkillsLoader {
    /// List all available skills.
    ///
    /// Applies `disabled_skills` filtering: disabled skills have `enabled = false`.
    pub fn list_skills(&self) -> Vec<SkillInfo> {
        let key = SkillScanKey {
            workspace: self.workspace.clone(),
            builtin_dir: self.builtin_dir.clone(),
            extra_source_dirs: self.extra_source_dirs.clone(),
            agent_id: self.agent_id.clone(),
            load_workspace_resources: self.load_workspace_resources,
        };
        let scan_workspace = self.workspace.clone();
        let scan_builtin_dir = self.builtin_dir.clone();
        let scan_extra_source_dirs = self.extra_source_dirs.clone();
        let scan_agent_id = self.agent_id.clone();
        let scan_load_workspace_resources = self.load_workspace_resources;
        let mut skills = SKILL_SCAN_CACHE
            .get_or_refresh(key, SKILL_SCAN_CACHE_TTL, move || {
                let scanner = SkillsLoader::new(&scan_workspace)
                    .with_builtin_dir_if_some(scan_builtin_dir.clone())
                    .with_extra_source_paths(scan_extra_source_dirs.clone())
                    .with_agent_id_if_some(scan_agent_id.clone())
                    .with_load_workspace_resources(scan_load_workspace_resources);
                Ok(scanner.scan_skills_uncached())
            })
            .unwrap_or_else(|err| {
                tracing::warn!("Failed to refresh skills scan cache: {}", err);
                self.scan_skills_uncached()
            });

        self.apply_disabled_skills(&mut skills);
        skills
    }

    fn with_builtin_dir_if_some(mut self, dir: Option<PathBuf>) -> Self {
        self.builtin_dir = dir;
        self
    }

    fn with_extra_source_paths(mut self, dirs: Vec<PathBuf>) -> Self {
        self.extra_source_dirs = dirs;
        self
    }

    fn with_agent_id_if_some(mut self, agent_id: Option<String>) -> Self {
        self.agent_id = agent_id;
        self
    }

    /// Evict the scan cache for this workspace so the next `list_skills` call
    /// does a fresh synchronous scan instead of returning stale data.
    ///
    /// Call this immediately after any mutation that adds or removes skills
    /// (import, create, delete) so the UI sees the updated list right away.
    pub fn invalidate_cache(&self) {
        let key = SkillScanKey {
            workspace: self.workspace.clone(),
            builtin_dir: self.builtin_dir.clone(),
            extra_source_dirs: self.extra_source_dirs.clone(),
            agent_id: self.agent_id.clone(),
            load_workspace_resources: self.load_workspace_resources,
        };
        SKILL_SCAN_CACHE.invalidate(&key);
    }

    /// Evict all scan cache entries. Use when the caller does not have a
    /// `SkillsLoader` instance (e.g. the external-import pipeline).
    pub fn invalidate_all_caches() {
        SKILL_SCAN_CACHE.clear();
    }
}
