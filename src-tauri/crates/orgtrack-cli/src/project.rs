//! Cross-machine **project identity**.
//!
//! A session's `repo_path` is a machine-specific absolute path. This derives a
//! stable id for the *project* it belongs to from the repository's git remote,
//! so the same project lines up across machines and clones. Falls back to the
//! git-root path (then the raw path) when there's no remote.
//!
//! It's cheap and dependency-free: walk up to the git root, read `.git/config`
//! directly (no `git` subprocess), normalize the remote, and hash it. Results
//! are memoized per `repo_path` for the process, so a `list` of many sessions
//! sharing a few repos does the filesystem work once per repo.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// A stable project identity.
#[derive(Clone)]
pub(crate) struct Project {
    /// 12-hex-char id — `sha256` of the normalized remote (or path fallback).
    pub(crate) id: String,
    /// Human slug: `host/owner/repo` from the remote, else the repo dir name.
    pub(crate) slug: String,
}

thread_local! {
    static CACHE: RefCell<HashMap<String, Option<Project>>> = RefCell::new(HashMap::new());
}

/// Memoized [`identify`] — one filesystem probe per distinct `repo_path`.
pub(crate) fn identify_cached(repo_path: &str) -> Option<Project> {
    CACHE.with(|cache| {
        if let Some(hit) = cache.borrow().get(repo_path) {
            return hit.clone();
        }
        let resolved = identify(repo_path);
        cache
            .borrow_mut()
            .insert(repo_path.to_string(), resolved.clone());
        resolved
    })
}

/// Derive a project identity from a session's workspace path.
pub(crate) fn identify(repo_path: &str) -> Option<Project> {
    if repo_path.trim().is_empty() {
        return None;
    }
    let start = Path::new(repo_path);
    if let Some(root) = find_git_root(start) {
        if let Some(remote) = read_remote_url(&root) {
            let normalized = normalize_remote(&remote);
            if !normalized.is_empty() {
                return Some(Project {
                    id: hash12(&normalized),
                    slug: normalized,
                });
            }
        }
        // A git repo without a usable remote: stable within a machine only.
        let root_str = root.to_string_lossy().into_owned();
        return Some(Project {
            id: hash12(&root_str),
            slug: dir_name(&root),
        });
    }
    // Not a git repo — hash the path.
    Some(Project {
        id: hash12(repo_path),
        slug: dir_name(start),
    })
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_dir() {
        Some(start.to_path_buf())
    } else {
        start.parent().map(Path::to_path_buf)
    };
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    None
}

fn read_remote_url(git_root: &Path) -> Option<String> {
    let git = git_root.join(".git");
    let config_path = if git.is_dir() {
        git.join("config")
    } else {
        // `.git` file (worktree/submodule): `gitdir: <path>`.
        let content = std::fs::read_to_string(&git).ok()?;
        let gitdir = content.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
        Path::new(gitdir.trim()).join("config")
    };
    parse_remote_from_config(&std::fs::read_to_string(config_path).ok()?)
}

/// Prefer `[remote "origin"]`; else the first remote's url.
fn parse_remote_from_config(text: &str) -> Option<String> {
    let mut current_remote: Option<String> = None;
    let mut first_url: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current_remote = line
                .strip_prefix("[remote ")
                .map(|rest| rest.trim_matches(|c| c == '"' || c == ']' || c == ' ').to_string());
        } else if let Some(rest) = line.strip_prefix("url") {
            let url = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).trim();
            match current_remote.as_deref() {
                Some("origin") => return Some(url.to_string()),
                Some(_) if first_url.is_none() => first_url = Some(url.to_string()),
                _ => {}
            }
        }
    }
    first_url
}

/// `git@github.com:owner/repo.git` / `https://github.com/owner/repo.git` /
/// `ssh://git@host:22/owner/repo` → `host/owner/repo` (lowercased).
fn normalize_remote(url: &str) -> String {
    let mut s = url.trim().to_string();
    let had_scheme = s.contains("://");
    if let Some(pos) = s.find("://") {
        s = s[pos + 3..].to_string();
    }
    if let Some(pos) = s.find('@') {
        s = s[pos + 1..].to_string();
    }
    if had_scheme {
        // Drop a `:port` between host and path.
        if let Some(colon) = s.find(':') {
            if let Some(slash) = s[colon..].find('/') {
                s = format!("{}{}", &s[..colon], &s[colon + slash..]);
            }
        }
    } else if let Some(colon) = s.find(':') {
        // scp-like `host:path` → `host/path`.
        s.replace_range(colon..colon + 1, "/");
    }
    let trimmed = s.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    trimmed.to_lowercase()
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn hash12(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_remotes() {
        assert_eq!(normalize_remote("git@github.com:owner/repo.git"), "github.com/owner/repo");
        assert_eq!(normalize_remote("https://github.com/Owner/Repo.git"), "github.com/owner/repo");
        assert_eq!(normalize_remote("ssh://git@host.com:22/owner/repo"), "host.com/owner/repo");
        assert_eq!(normalize_remote("https://gitlab.com/g/s/p"), "gitlab.com/g/s/p");
    }

    #[test]
    fn same_remote_same_id_across_forms() {
        // https and scp forms of the same repo hash identically (cross-machine).
        let a = normalize_remote("git@github.com:owner/repo.git");
        let b = normalize_remote("https://github.com/owner/repo");
        assert_eq!(hash12(&a), hash12(&b));
    }

    #[test]
    fn parses_origin_from_config() {
        let cfg = "[remote \"upstream\"]\n\turl = https://x/u.git\n[remote \"origin\"]\n\turl = git@github.com:o/r.git\n";
        assert_eq!(parse_remote_from_config(cfg).as_deref(), Some("git@github.com:o/r.git"));
    }
}
