//! Canonical file-resource path resolution for provenance records.
//!
//! This adapter is deliberately host-side: it resolves filesystem aliases and
//! Git worktree roots, then returns only normalized metadata to Orgtrack.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use orgtrack_core::repo_sync::paths::record_id;

/// Per-cwd cache of the git resolution (workspace root + repository id).
///
/// Resolution shells out to `git rev-parse` twice, and callers like the
/// historical backfill resolve EVERY file interaction of a session — all of
/// which share the same cwd. Without this cache a 500-interaction session
/// spawned ~1000 git subprocesses that all returned the same answer, which
/// dominated the backfill's CPU cost. Worktree roots don't move while the
/// process runs, so a process-lifetime cache is safe.
const RESOLUTION_CACHE_MAX_ENTRIES: usize = 1024;

#[derive(Clone)]
struct CachedRepoResolution {
    workspace: PathBuf,
    /// `record_id` derived from the git common dir; `None` when cwd is not
    /// inside a git repository.
    repository_record_id: Option<String>,
}

static RESOLUTION_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRepoResolution>>> = OnceLock::new();

fn resolve_repo_for_cwd(cwd_path: &Path) -> CachedRepoResolution {
    let cache = RESOLUTION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.get(cwd_path) {
            return hit.clone();
        }
    }

    let discovered = discover_git_repo(cwd_path);
    let resolution = match discovered {
        Some(repo) => CachedRepoResolution {
            workspace: repo.worktree_root,
            repository_record_id: Some(record_id(&[
                "git_repository",
                &repo.common_dir.to_string_lossy(),
            ])),
        },
        None => CachedRepoResolution {
            workspace: cwd_path.to_path_buf(),
            repository_record_id: None,
        },
    };

    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= RESOLUTION_CACHE_MAX_ENTRIES {
            guard.clear();
        }
        guard.insert(cwd_path.to_path_buf(), resolution.clone());
    }
    resolution
}

struct DiscoveredGitRepo {
    worktree_root: PathBuf,
    /// The repository's common `.git` directory — shared across all linked
    /// worktrees, so it is a stable identity for the repository itself.
    common_dir: PathBuf,
}

/// Filesystem equivalent of `git rev-parse --show-toplevel` +
/// `--git-common-dir`, without spawning a subprocess: walk up from `start`
/// until a `.git` entry is found, then resolve the worktree/submodule
/// `gitdir:` pointer file and the linked-worktree `commondir` file (both
/// plain text) to the shared `.git` directory. Bare repositories (a cwd
/// inside a repo with no worktree) are not detected — same outcome as the
/// old subprocess path failing: caller falls back to cwd-as-workspace.
fn discover_git_repo(start: &Path) -> Option<DiscoveredGitRepo> {
    let mut dir = start;
    loop {
        let dot_git = dir.join(".git");
        let git_dir = if dot_git.is_dir() {
            Some(dot_git.clone())
        } else if dot_git.is_file() {
            // Linked worktree or submodule: `.git` is a one-line pointer
            // file of the form `gitdir: <path>` (possibly relative).
            fs::read_to_string(&dot_git)
                .ok()
                .and_then(|content| {
                    content.lines().find_map(|line| {
                        line.strip_prefix("gitdir:")
                            .map(str::trim)
                            .map(String::from)
                    })
                })
                .map(|pointer| absolute_lexical_path(Path::new(&pointer), Some(dir)))
        } else {
            None
        };

        if let Some(git_dir) = git_dir {
            let git_dir = canonicalize_existing_prefix(&git_dir);
            // Linked worktrees carry a `commondir` file pointing (usually
            // relatively) at the repository's shared `.git` directory.
            let common_dir = fs::read_to_string(git_dir.join("commondir"))
                .ok()
                .map(|content| {
                    canonicalize_existing_prefix(&absolute_lexical_path(
                        Path::new(content.trim()),
                        Some(&git_dir),
                    ))
                })
                .unwrap_or(git_dir);
            return Some(DiscoveredGitRepo {
                worktree_root: dir.to_path_buf(),
                common_dir,
            });
        }

        dir = dir.parent()?;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedFileResource {
    pub(crate) repository_id: Option<String>,
    pub(crate) workspace_path: String,
    pub(crate) repo_relative_path: String,
    pub(crate) display_path: String,
}

pub(crate) fn resolve_file_resource(cwd: &str, file_path: &str) -> ResolvedFileResource {
    // Resolve aliases such as macOS `/tmp` -> `/private/tmp` on both sides
    // before comparing them. For create/delete events the leaf may not exist,
    // so canonicalize the longest existing prefix and reattach the tail.
    let cwd_path = canonicalize_existing_prefix(&absolute_lexical_path(Path::new(cwd), None));
    let file_path = canonicalize_existing_prefix(&absolute_lexical_path(
        Path::new(file_path),
        Some(&cwd_path),
    ));
    let resolution = resolve_repo_for_cwd(&cwd_path);
    let workspace = resolution.workspace;
    let within_workspace = file_path.strip_prefix(&workspace).ok();
    let repository_id = within_workspace.and_then(|_| resolution.repository_record_id.clone());
    let relative = within_workspace
        .unwrap_or(&file_path)
        .to_string_lossy()
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/");
    ResolvedFileResource {
        repository_id,
        workspace_path: workspace.to_string_lossy().into_owned(),
        display_path: relative.clone(),
        repo_relative_path: relative,
    }
}

fn absolute_lexical_path(path: &Path, base: Option<&Path>) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.map(Path::to_path_buf)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub(crate) fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let lexical = absolute_lexical_path(path, None);
    let mut cursor = lexical.clone();
    let mut missing_tail = Vec::new();
    loop {
        match fs::canonicalize(&cursor) {
            Ok(mut canonical) => {
                for component in missing_tail.iter().rev() {
                    canonical.push(component);
                }
                return absolute_lexical_path(&canonical, None);
            }
            Err(_) => {
                let Some(component) = cursor.file_name().map(|name| name.to_os_string()) else {
                    return lexical;
                };
                missing_tail.push(component);
                if !cursor.pop() {
                    return lexical;
                }
            }
        }
    }
}
