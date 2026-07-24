//! Diff numstat operations (per-file stats, no content).

use crate::types::*;
use git2::Repository;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache TTL for combined numstat results. Prevents redundant libgit2 diff
/// walks when the sidebar re-renders rapidly without any working-tree change.
const NUMSTAT_CACHE_TTL: Duration = Duration::from_millis(500);

struct NumstatCacheEntry {
    cached_at: Instant,
    result: CombinedDiffNumstatResult,
}

/// `(repo_path_string, from_ref_string, head_sha)` → cached result.
static NUMSTAT_CACHE: std::sync::OnceLock<
    Mutex<HashMap<(String, String, String), NumstatCacheEntry>>,
> = std::sync::OnceLock::new();

fn numstat_cache() -> &'static Mutex<HashMap<(String, String, String), NumstatCacheEntry>> {
    NUMSTAT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read the HEAD SHA from `.git/HEAD` without spawning a subprocess.
/// Returns `None` if the layout is unexpected (bare repo, worktree link file, etc.).
fn read_head_sha_for_numstat(repo_path: &Path) -> Option<String> {
    let git_dir = repo_path.join(".git");
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(ref_path) = head.strip_prefix("ref: ") {
        // Try loose ref first
        let loose = git_dir.join(ref_path);
        if let Ok(sha) = std::fs::read_to_string(&loose) {
            return Some(sha.trim().to_string());
        }
        // Fall back to packed-refs
        let packed = std::fs::read_to_string(git_dir.join("packed-refs")).ok()?;
        for line in packed.lines() {
            if line.starts_with('#') {
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            if let (Some(sha), Some(name)) = (parts.next(), parts.next()) {
                if name == ref_path {
                    return Some(sha.to_string());
                }
            }
        }
        None
    } else if head.len() == 40 || head.len() == 64 {
        Some(head.to_string())
    } else {
        None
    }
}

/// Get per-file insertions/deletions without loading full diff content.
/// Much cheaper than batch file diffs for displaying change counts in the sidebar.
pub fn get_diff_numstat(
    repo_path: &Path,
    from_ref: &str,
    to_ref: Option<&str>,
    staged_only: bool,
) -> Result<DiffNumstatResult, String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let old_tree = super::ref_utils::resolve_from_ref(&repo, from_ref)?;
    let empty_base = super::ref_utils::is_empty_base(from_ref);

    let mut diff_opts = git2::DiffOptions::new();
    if empty_base {
        diff_opts.include_untracked(true);
    }

    let diff = if staged_only {
        let index = repo
            .index()
            .map_err(|e| format!("Failed to get index: {}", e))?;
        repo.diff_tree_to_index(old_tree.as_ref(), Some(&index), Some(&mut diff_opts))
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else {
        match to_ref {
            Some(ref_name) if ref_name != "WORKING" && ref_name != "WORKDIR" => {
                let obj = repo
                    .revparse_single(ref_name)
                    .map_err(|e| format!("Failed to resolve ref '{}': {}", ref_name, e))?;
                let commit = obj
                    .peel_to_commit()
                    .map_err(|e| format!("Failed to get commit: {}", e))?;
                let new_tree = commit
                    .tree()
                    .map_err(|e| format!("Failed to get tree: {}", e))?;
                repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut diff_opts))
                    .map_err(|e| format!("Failed to create diff: {}", e))?
            }
            _ => repo
                .diff_tree_to_workdir_with_index(old_tree.as_ref(), Some(&mut diff_opts))
                .map_err(|e| format!("Failed to create diff: {}", e))?,
        }
    };

    let mut files = Vec::new();
    let mut total_insertions: u32 = 0;
    let mut total_deletions: u32 = 0;

    let num_deltas = diff.deltas().len();
    for idx in 0..num_deltas {
        let delta = diff.get_delta(idx).unwrap();
        let patch = git2::Patch::from_diff(&diff, idx)
            .map_err(|e| format!("Failed to get patch: {}", e))?;

        let (ins, del) = if let Some(ref patch) = patch {
            let (_, adds, dels) = patch
                .line_stats()
                .map_err(|e| format!("Failed to get line stats: {}", e))?;
            (adds as u32, dels as u32)
        } else {
            (0, 0)
        };

        let new_file = delta.new_file();
        let path = new_file
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            git2::Delta::Renamed => "renamed",
            git2::Delta::Copied => "copied",
            _ => "modified",
        };

        let binary = delta.flags().contains(git2::DiffFlags::BINARY);

        total_insertions += ins;
        total_deletions += del;

        files.push(FileNumstat {
            path,
            status: status.to_string(),
            insertions: ins,
            deletions: del,
            binary,
        });
    }

    Ok(DiffNumstatResult {
        files,
        total_insertions,
        total_deletions,
        files_changed: num_deltas as u32,
    })
}

/// Combined numstat result for both staged and unstaged changes.
/// Merged in Rust to avoid 2 separate IPC calls from frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedDiffNumstatResult {
    /// Per-file stats with merged staged+unstaged counts
    pub files: Vec<FileNumstat>,
    /// Total insertions (staged + unstaged)
    pub total_insertions: u32,
    /// Total deletions (staged + unstaged)
    pub total_deletions: u32,
    /// Total files changed
    pub files_changed: u32,
}

/// Get combined numstat for both staged and unstaged changes in a single call.
///
/// This is a performance optimization that replaces 2 separate API calls
/// (one for unstaged, one for staged) with a single call that returns
/// merged results.
pub fn get_diff_numstat_combined(
    repo_path: &Path,
    from_ref: &str,
) -> Result<CombinedDiffNumstatResult, String> {
    // Cache lookup: skip the libgit2 diff walk if HEAD hasn't changed and the
    // entry is fresh enough. The 500ms TTL is short enough that staged/unstaged
    // changes appearing from a git operation still propagate promptly.
    let repo_path_str = repo_path.to_string_lossy().to_string();
    let head_sha_opt = read_head_sha_for_numstat(repo_path);
    if let Some(ref head_sha) = head_sha_opt {
        let cache_key = (
            repo_path_str.clone(),
            from_ref.to_string(),
            head_sha.clone(),
        );
        if let Ok(cache) = numstat_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.cached_at.elapsed() < NUMSTAT_CACHE_TTL {
                    return Ok(entry.result.clone());
                }
            }
        }
    }

    // Get unstaged changes (working directory vs HEAD)
    let unstaged = get_diff_numstat(repo_path, from_ref, None, false)?;

    // Get staged changes (index vs HEAD)
    let staged = get_diff_numstat(repo_path, from_ref, None, true)?;

    // Merge results: combine stats for files that appear in both
    let mut file_map: HashMap<String, FileNumstat> = HashMap::new();

    // Add unstaged files first
    for file in unstaged.files {
        file_map.insert(file.path.clone(), file);
    }

    // Merge staged files
    for file in staged.files {
        if let Some(existing) = file_map.get_mut(&file.path) {
            // File exists in both: add counts
            existing.insertions += file.insertions;
            existing.deletions += file.deletions;
        } else {
            // File only in staged
            file_map.insert(file.path.clone(), file);
        }
    }

    // Convert back to Vec and sort by path
    let mut files: Vec<FileNumstat> = file_map.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // Calculate totals
    let total_insertions: u32 = files.iter().map(|f| f.insertions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();
    let files_changed = files.len() as u32;

    let result = CombinedDiffNumstatResult {
        files,
        total_insertions,
        total_deletions,
        files_changed,
    };

    // Populate cache so repeated calls within the TTL window are served instantly.
    if let Some(head_sha) = head_sha_opt {
        let cache_key = (repo_path_str, from_ref.to_string(), head_sha);
        if let Ok(mut cache) = numstat_cache().lock() {
            cache.insert(
                cache_key,
                NumstatCacheEntry {
                    cached_at: Instant::now(),
                    result: result.clone(),
                },
            );
        }
    }

    Ok(result)
}
