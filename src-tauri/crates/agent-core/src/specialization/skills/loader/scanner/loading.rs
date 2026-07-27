//! Loading a single skill's `SKILL.md` content by name.
//!
//! Tries, in order: workspace `skills/<name>/SKILL.md`, auto-discovered
//! workspace source dirs, the configured builtin dir, extra source dirs,
//! and finally the binary-embedded builtin skills.

use std::fs;
use std::path::{Path, PathBuf};

use super::SkillsLoader;

impl SkillsLoader {
    /// Load a skill's full content by name.
    pub fn load_skill(&self, name: &str) -> Option<String> {
        self.load_skill_with_path(name)
            .map(|(contents, _path)| contents)
    }

    /// Load a skill's full content plus the path of its `SKILL.md`.
    ///
    /// The path is `None` only for binary-embedded builtin skills, which
    /// have no on-disk directory for relative bundled-file references.
    pub fn load_skill_with_path(&self, name: &str) -> Option<(String, Option<PathBuf>)> {
        let workspace_path = self.workspace.join("skills").join(name).join("SKILL.md");
        if self.load_workspace_resources && workspace_path.exists() {
            match fs::read_to_string(&workspace_path) {
                Ok(contents) => {
                    let meta = self.parse_skill_metadata(&contents);
                    if self.skill_metadata_applies_to_agent(&meta) {
                        return Some((contents, Some(workspace_path)));
                    }
                    return None;
                }
                Err(err) => {
                    tracing::warn!(
                        "Failed to read workspace skill {} at {}: {}",
                        name,
                        workspace_path.display(),
                        err
                    );
                    return None;
                }
            }
        }

        if self.load_workspace_resources {
            for source_dir in self.default_workspace_skill_source_dirs() {
                if let Some((contents, path)) =
                    self.load_skill_from_source_dir(&source_dir, name, "external-source")
                {
                    return Some((contents, Some(path)));
                }
            }
        }

        if let Some(ref builtin_dir) = self.builtin_dir {
            let builtin_path = builtin_dir.join(name).join("SKILL.md");
            if builtin_path.exists() {
                match fs::read_to_string(&builtin_path) {
                    Ok(contents) => {
                        let meta = self.parse_skill_metadata(&contents);
                        if self.skill_metadata_applies_to_agent(&meta) {
                            return Some((contents, Some(builtin_path)));
                        }
                        return None;
                    }
                    Err(err) => {
                        tracing::warn!(
                            "Failed to read builtin skill {} at {}: {}",
                            name,
                            builtin_path.display(),
                            err
                        );
                        return None;
                    }
                }
            }
        }

        for source_dir in &self.extra_source_dirs {
            if let Some((contents, path)) =
                self.load_skill_from_source_dir(source_dir, name, "agent-source")
            {
                return Some((contents, Some(path)));
            }
        }

        // Final fallback: binary-embedded built-in skills (`/create-skill`,
        // `/create-rule`, `/create-orgii-agent`). They ship with the binary so
        // slash commands always work, even on a fresh install with an
        // empty `~/.orgii/skills/`.
        super::super::super::builtin::load_builtin_skill(name)
            .map(|contents| (contents.to_string(), None))
    }

    fn load_skill_from_source_dir(
        &self,
        dir: &Path,
        name: &str,
        source: &str,
    ) -> Option<(String, PathBuf)> {
        let source_path = self.find_skill_file_recursive(dir, name)?;
        match fs::read_to_string(&source_path) {
            Ok(contents) => {
                let meta = self.parse_skill_metadata(&contents);
                if self.skill_metadata_applies_to_agent(&meta) {
                    Some((contents, source_path))
                } else {
                    None
                }
            }
            Err(err) => {
                tracing::warn!(
                    "Failed to read {} skill {} at {}: {}",
                    source,
                    name,
                    source_path.display(),
                    err
                );
                None
            }
        }
    }

    fn find_skill_file_recursive(&self, dir: &Path, name: &str) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if path.file_name().and_then(|file_name| file_name.to_str()) == Some(name)
                && skill_file.exists()
            {
                return Some(skill_file);
            }
            if let Some(found) = self.find_skill_file_recursive(&path, name) {
                return Some(found);
            }
        }
        None
    }
}
