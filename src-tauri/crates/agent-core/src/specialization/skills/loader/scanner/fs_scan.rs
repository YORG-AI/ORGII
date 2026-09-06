//! Filesystem discovery and scanning for skill directories.
//!
//! Walks the workspace `skills/` dir, builtin dir, extra source dirs, and
//! auto-discovered per-agent source roots (`.cursor/skills`, `.claude/skills`,
//! ...), turning each `SKILL.md` found into a [`SkillInfo`].

use std::fs;
use std::path::{Path, PathBuf};

use super::super::helpers::{collect_bundled_files, estimate_summary_line_tokens, estimate_tokens};
use super::super::types::{DescriptionQuality, SkillInfo};
use super::SkillsLoader;
use crate::skills::provenance::{
    content_digest, identity_digest, read_provenance, schema_digest, schema_value, SkillOrigin,
};

const DISCOVERED_SKILL_ROOT_MAX_DEPTH: usize = 4;
const DISCOVERED_SKILL_ROOT_MAX_ENTRIES: usize = 500;
const IGNORED_HIDDEN_SKILL_ROOTS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".cargo",
    ".rustup",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".bun",
    ".venv",
    ".vscode",
    ".idea",
    ".vs",
    ".next",
    ".turbo",
];

impl SkillsLoader {
    pub(super) fn scan_skills_uncached(&self) -> Vec<SkillInfo> {
        let mut skills = Vec::new();

        let workspace_skills_dir = self.workspace.join("skills");
        if self.load_workspace_resources && workspace_skills_dir.exists() {
            self.scan_skills_dir(&workspace_skills_dir, "workspace", &mut skills);
        }

        if self.load_workspace_resources {
            for source_dir in self.default_workspace_skill_source_dirs() {
                if source_dir.exists() {
                    self.scan_supplemental_dir_recursive(
                        &source_dir,
                        "external-source",
                        &mut skills,
                    );
                }
            }
        }

        if let Some(ref builtin_dir) = self.builtin_dir {
            if builtin_dir.exists() {
                self.scan_supplemental_dir(builtin_dir, "builtin", &mut skills);
            }
        }

        for source_dir in &self.extra_source_dirs {
            if source_dir.exists() {
                self.scan_supplemental_dir_recursive(source_dir, "agent-source", &mut skills);
            }
        }

        // Org-shared materializations load last and never shadow a local
        // copy of the same name — the sharer keeps editing their original.
        let org_root = app_paths::org_skills_root();
        if org_root.exists() {
            let mut seen: std::collections::HashSet<String> =
                skills.iter().map(|skill| skill.name.clone()).collect();
            let mut org_shared = Vec::new();
            self.scan_supplemental_dir_recursive(&org_root, "org-shared", &mut org_shared);
            for skill in org_shared {
                if seen.insert(skill.name.clone()) {
                    skills.push(skill);
                }
            }
        }

        skills
    }

    /// Resolve one effective skill using the same source precedence as a full
    /// catalog scan. This is the dispatch-time consent path: a WorkItemRun
    /// already carries the names it can use, so re-hashing every unrelated
    /// bundle would add filesystem work without strengthening that boundary.
    pub(crate) fn find_skill_fresh(&self, name: &str) -> Option<SkillInfo> {
        let name = name.trim();
        let path = Path::new(name);
        if name.is_empty()
            || name.contains(['/', '\\'])
            || path.components().count() != 1
            || !matches!(
                path.components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return None;
        }

        let workspace_skills_dir = self.workspace.join("skills");
        let mut found = self
            .load_workspace_resources
            .then(|| self.load_named_skill_dir(&workspace_skills_dir.join(name), "workspace"))
            .flatten()
            .or_else(|| {
                self.load_workspace_resources.then(|| {
                    self.default_workspace_skill_source_dirs()
                        .into_iter()
                        .find_map(|dir| {
                            self.find_named_skill_recursive(&dir, name, "external-source")
                        })
                })?
            })
            .or_else(|| {
                self.builtin_dir
                    .as_ref()
                    .and_then(|dir| self.load_named_skill_dir(&dir.join(name), "builtin"))
            })
            .or_else(|| {
                self.extra_source_dirs
                    .iter()
                    .find_map(|dir| self.find_named_skill_recursive(dir, name, "agent-source"))
            })
            .or_else(|| {
                self.find_named_skill_recursive(&app_paths::org_skills_root(), name, "org-shared")
            })
            .or_else(|| {
                super::super::super::builtin::list_builtin_skills()
                    .into_iter()
                    .find(|skill| skill.name == name)
            })?;

        if self.disabled_skills.contains(&found.name) {
            found.enabled = false;
        }
        Some(found)
    }

    fn load_named_skill_dir(&self, dir: &Path, source: &str) -> Option<SkillInfo> {
        let mut found = Vec::with_capacity(1);
        self.scan_skill_dir(dir, source, &mut found);
        found.pop()
    }

    fn find_named_skill_recursive(
        &self,
        dir: &Path,
        name: &str,
        source: &str,
    ) -> Option<SkillInfo> {
        let direct = dir.join(name);
        if let Some(skill) = self.load_named_skill_dir(&direct, source) {
            return Some(skill);
        }
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) || path == direct {
                continue;
            }
            // Match the catalog scanner: a directory containing SKILL.md is
            // one bundle boundary, so nested assets are never another skill.
            if path.join("SKILL.md").exists() {
                continue;
            }
            if let Some(skill) = self.find_named_skill_recursive(&path, name, source) {
                return Some(skill);
            }
        }
        None
    }

    pub(super) fn default_workspace_skill_source_dirs(&self) -> Vec<PathBuf> {
        let is_orgii_workspace = self
            .workspace
            .file_name()
            .is_some_and(|name| name == ".orgii");
        let workspace_root = is_orgii_workspace
            .then(|| self.workspace.parent())
            .flatten()
            .unwrap_or(&self.workspace);
        let is_home_root = dirs::home_dir()
            .as_deref()
            .is_some_and(|home| workspace_root == home);
        let mut dirs = vec![
            workspace_root.join(".cursor").join("skills"),
            workspace_root.join(".claude").join("skills"),
            workspace_root.join(".codex").join("skills"),
            workspace_root.join(".opencode").join("skills"),
            workspace_root.join(".agents").join("skills"),
        ];
        if is_home_root {
            dirs.push(workspace_root.join(".cursor").join("skills-cursor"));
            dirs.push(
                workspace_root
                    .join(".gemini")
                    .join("antigravity-cli")
                    .join("skills"),
            );
            dirs.push(workspace_root.join(".hermes").join("skills"));
            dirs.push(workspace_root.join(".openclaw").join("skills"));
        } else if is_orgii_workspace {
            dirs.push(workspace_root.join("skills"));
        }
        dirs.extend(self.discover_skill_source_dirs(workspace_root, is_home_root));
        dirs.sort();
        dirs.dedup();
        dirs
    }

    fn discover_skill_source_dirs(&self, root: &Path, include_home_roots: bool) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if !file_type.is_dir() {
                    return None;
                }
                let name = entry.file_name();
                let name = name.to_str()?;
                if name == "skills" {
                    return (!include_home_roots && self.skill_root_has_skill_md(&entry.path()))
                        .then(|| entry.path());
                }
                if !include_home_roots
                    && (!name.starts_with('.') || IGNORED_HIDDEN_SKILL_ROOTS.contains(&name))
                {
                    return None;
                }
                if include_home_roots
                    && (!name.starts_with('.')
                        || name == ".orgii"
                        || IGNORED_HIDDEN_SKILL_ROOTS.contains(&name))
                {
                    return None;
                }
                let skills_dir = entry.path().join("skills");
                self.skill_root_has_skill_md(&skills_dir)
                    .then_some(skills_dir)
            })
            .collect()
    }

    fn skill_root_has_skill_md(&self, root: &Path) -> bool {
        if !root.is_dir() {
            return false;
        }
        let mut visited_entries = 0;
        Self::skill_root_has_skill_md_inner(root, 0, &mut visited_entries)
    }

    fn skill_root_has_skill_md_inner(
        root: &Path,
        depth: usize,
        visited_entries: &mut usize,
    ) -> bool {
        if depth > DISCOVERED_SKILL_ROOT_MAX_DEPTH
            || *visited_entries >= DISCOVERED_SKILL_ROOT_MAX_ENTRIES
        {
            return false;
        }
        let Ok(entries) = fs::read_dir(root) else {
            return false;
        };
        for entry in entries.filter_map(Result::ok) {
            *visited_entries += 1;
            if *visited_entries >= DISCOVERED_SKILL_ROOT_MAX_ENTRIES {
                return false;
            }
            let path = entry.path();
            if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
                return true;
            }
            if entry.file_type().is_ok_and(|file_type| file_type.is_dir())
                && Self::skill_root_has_skill_md_inner(&path, depth + 1, visited_entries)
            {
                return true;
            }
        }
        false
    }

    pub(super) fn apply_disabled_skills(&self, skills: &mut [SkillInfo]) {
        for skill in skills {
            if self.disabled_skills.contains(&skill.name) {
                skill.enabled = false;
            }
        }
    }

    fn scan_supplemental_dir(&self, dir: &Path, source: &str, skills: &mut Vec<SkillInfo>) {
        let existing_names: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
        let mut supplemental_skills = Vec::new();
        self.scan_skills_dir(dir, source, &mut supplemental_skills);
        for skill in supplemental_skills {
            if !existing_names.contains(&skill.name) {
                skills.push(skill);
            }
        }
    }

    fn scan_supplemental_dir_recursive(
        &self,
        dir: &Path,
        source: &str,
        skills: &mut Vec<SkillInfo>,
    ) {
        let existing_names: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
        let mut supplemental_skills = Vec::new();
        self.scan_skills_dir_recursive(dir, source, &mut supplemental_skills);
        for skill in supplemental_skills {
            if !existing_names.contains(&skill.name) {
                skills.push(skill);
            }
        }
    }

    fn scan_skills_dir(&self, dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            self.scan_skill_dir(&path, source, out);
        }
    }

    fn scan_skills_dir_recursive(&self, dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.join("SKILL.md").exists() {
                self.scan_skill_dir(&path, source, out);
                continue;
            }
            self.scan_skills_dir_recursive(&path, source, out);
        }
    }

    fn scan_skill_dir(&self, path: &Path, source: &str, out: &mut Vec<SkillInfo>) {
        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() {
            return;
        }

        let Some(name) = path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .map(str::to_string)
        else {
            tracing::warn!("Skipping skill dir with non-UTF8 name: {}", path.display());
            return;
        };

        let content = match fs::read_to_string(&skill_file) {
            Ok(text) => text,
            Err(err) => {
                tracing::warn!(
                    "Failed to read SKILL.md for {} at {}: {}",
                    name,
                    skill_file.display(),
                    err
                );
                return;
            }
        };
        let meta = self.parse_skill_metadata(&content);
        if !self.skill_metadata_applies_to_agent(&meta) {
            return;
        }

        let (requirements_available, m_bins, m_env) =
            self.check_requirements(&meta.required_bins, &meta.required_env);

        let full_content_tokens = estimate_tokens(&content);
        let estimated_tokens = estimate_summary_line_tokens(&name, &meta.description);

        let description_quality = if meta.description.is_empty() {
            DescriptionQuality::Missing
        } else if meta.description.len() < 20 {
            DescriptionQuality::Short
        } else {
            DescriptionQuality::Good
        };

        let bundled_files = collect_bundled_files(path);

        let schema = match schema_value(path) {
            Ok(schema) => schema,
            Err(err) => {
                tracing::warn!("Skipping skill {} with unreadable schema: {}", name, err);
                return;
            }
        };
        let live_content_digest = match content_digest(path) {
            Ok(digest) => digest,
            Err(err) => {
                tracing::warn!("Skipping skill {} with unreadable bundle: {}", name, err);
                return;
            }
        };
        let live_schema_digest = schema_digest(&schema);
        let (provenance, provenance_record_valid) = match read_provenance(path) {
            Ok(Some(record)) => {
                if record.name != name || record.id.trim().is_empty() {
                    tracing::warn!(
                        "Skill provenance identity mismatch at {}: expected name {}, got id={} name={}",
                        path.display(),
                        name,
                        record.id,
                        record.name
                    );
                }
                (Some(record), true)
            }
            Ok(None) => (None, true),
            Err(err) => {
                tracing::warn!("Skill provenance is invalid at {}: {}", path.display(), err);
                (None, false)
            }
        };
        let id = provenance
            .as_ref()
            .map(|record| record.id.clone())
            .unwrap_or_else(|| format!("{source}:{name}"));
        let origin = provenance.as_ref().map(|record| record.origin.clone());
        let effective_origin = origin.clone().unwrap_or_else(|| SkillOrigin {
            provider: "local".to_string(),
            locator: source.to_string(),
        });
        let live_identity_digest = identity_digest(&id, &name, &effective_origin);
        let consent_valid = provenance_record_valid
            && provenance.as_ref().is_none_or(|record| {
                record.name == name
                    && !record.id.trim().is_empty()
                    && record.consent.identity_digest == live_identity_digest
                    && record.consent.content_digest == live_content_digest
                    && record.consent.schema_digest == live_schema_digest
            });
        let available = requirements_available && consent_valid;

        out.push(SkillInfo {
            id,
            name,
            path: skill_file,
            source: source.to_string(),
            origin,
            identity_digest: live_identity_digest,
            content_digest: live_content_digest,
            schema_digest: live_schema_digest,
            consent_valid,
            always: meta.always,
            available,
            enabled: true,
            required_bins: meta.required_bins,
            required_env: meta.required_env,
            description: meta.description,
            estimated_tokens,
            full_content_tokens,
            description_quality,
            version: meta.version,
            license: meta.license,
            compatibility: meta.compatibility,
            missing_bins: m_bins,
            missing_env: m_env,
            bundled_files,
        });
    }
}
