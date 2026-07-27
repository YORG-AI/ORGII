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

        skills
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

        let (available, m_bins, m_env) =
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

        out.push(SkillInfo {
            name,
            path: skill_file,
            source: source.to_string(),
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
