//! Private helpers for skills loading.

use std::fs;
use std::path::{Path, PathBuf};

use super::commands::global_skills_dir;
use crate::skills::provenance::{PROVENANCE_FILENAME, SKILLS_SH_DETAIL_CACHE_FILENAME};

/// Count tokens in a string using the shared BPE tokenizer.
pub(super) fn estimate_tokens(text: &str) -> usize {
    crate::model_context::tokenizer::count_tokens(text)
}

/// Count tokens for a skill's summary line in the prompt.
pub(super) fn estimate_summary_line_tokens(name: &str, description: &str) -> usize {
    let line = format!("- **{}** (source): {} [status]", name, description);
    crate::model_context::tokenizer::count_tokens(&line)
}

/// Recursively collect relative paths of all files in a skill directory
/// (excluding SKILL.md itself).
pub(super) fn collect_bundled_files(skill_dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_bundled_files_recursive(skill_dir, skill_dir, &mut files);
    files.sort();
    files
}

fn collect_bundled_files_recursive(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_bundled_files_recursive(base, &path, out);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name != "SKILL.md"
                    && name != PROVENANCE_FILENAME
                    && name != SKILLS_SH_DETAIL_CACHE_FILENAME
            })
        {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
}

const BINARY_FILE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "psd", "heic", "avif", "mp3",
    "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "aiff", "mp4", "mov", "avi", "mkv", "webm",
    "wmv", "flv", "m4v", "mpg", "mpeg", "zip", "tar", "gz", "bz2", "7z", "rar", "xz", "tgz", "jar",
    "war", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers",
    "key", "pdf", "ttf", "otf", "woff", "woff2", "eot", "exe", "dll", "so", "dylib", "bin", "app",
    "deb", "rpm", "msi", "dmg", "pkg", "apk",
];

/// Whether a relative path looks like a binary attachment based on its
/// extension. Used to skip bundled files that would otherwise fail a
/// UTF-8 text read when sharing a skill to an org.
pub(super) fn is_binary_by_extension(relative_path: &str) -> bool {
    Path::new(relative_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| BINARY_FILE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// Resolve the skill directory for a given name, checking project then global.
pub(super) fn resolve_skill_dir(
    name: &str,
    workspace_path: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(pp) = workspace_path {
        let project_dir = PathBuf::from(pp).join(".orgii/skills").join(name);
        if project_dir.exists() {
            return Ok(project_dir);
        }
    }
    let global_dir = global_skills_dir().join(name);
    if global_dir.exists() {
        return Ok(global_dir);
    }
    Err(format!("Skill '{}' not found", name))
}

/// Validate a relative path is safe (no `..` or absolute paths).
pub(super) fn validate_relative_path(relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("File path cannot be empty".to_string());
    }
    if relative_path.contains("..") || Path::new(relative_path).is_absolute() {
        return Err("File path must be relative and cannot contain '..'".to_string());
    }
    if relative_path == "SKILL.md" {
        return Err("Use skills_update to modify SKILL.md".to_string());
    }
    Ok(())
}
