//! Lightweight git-status runner with timeout and output parsing
//!
//! Provides both async (for Tauri commands) and sync (for the event processor)
//! variants. All subprocess calls go through `crate::util` for
//! pre-exec FD safety.
use std::collections::HashSet;
use std::path::Path;
use std::process::Output;
use std::time::Duration;
use tokio::time::timeout;

use super::types::{GitStatus, GitStatusFile};
use crate::types::WorkingDirectoryFile;
use crate::util::run_git_status_with_retry;

const GIT_TIMEOUT_SECONDS: u64 = 5;

// ============================================
// Local wrapper for git status commands
// ============================================

/// Spawn a git command with retry logic for status operations.
/// Delegates to shared git_util module with --no-optional-locks flag.
fn spawn_git_with_retry(args: &[&str], cwd: &Path, max_retries: u32) -> Result<Output, String> {
    run_git_status_with_retry(cwd, args, max_retries)
}

/// Detect unstaged moves that Git's porcelain status reports as a deleted
/// tracked file plus an unrelated untracked file. Unlike the status command,
/// libgit2 can compare untracked content with deleted index entries when
/// `for_untracked` rename detection is enabled.
fn detect_unstaged_renames(repo_path: &Path) -> Result<Vec<(String, String)>, String> {
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository for rename detection: {}", e))?;

    let mut diff_options = git2::DiffOptions::new();
    diff_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let mut diff = repo
        .diff_index_to_workdir(None, Some(&mut diff_options))
        .map_err(|e| format!("Failed to diff index against worktree: {}", e))?;

    let mut find_options = git2::DiffFindOptions::new();
    find_options.renames(true).for_untracked(true);
    diff.find_similar(Some(&mut find_options))
        .map_err(|e| format!("Failed to detect unstaged renames: {}", e))?;

    Ok(diff
        .deltas()
        .filter(|delta| delta.status() == git2::Delta::Renamed)
        .filter_map(|delta| {
            let original_path = delta.old_file().path()?.to_string_lossy().into_owned();
            let path = delta.new_file().path()?.to_string_lossy().into_owned();
            Some((original_path, path))
        })
        .collect())
}

fn coalesce_git_status_renames(
    files: &mut Vec<GitStatusFile>,
    renames: &[(String, String)],
) -> u32 {
    let mut coalesced = 0;

    for (original_path, path) in renames {
        let deleted_index = files
            .iter()
            .position(|file| !file.staged && file.status == "D" && file.path == *original_path);
        let untracked_index = files
            .iter()
            .position(|file| !file.staged && file.status == "?" && file.path == *path);

        if let (Some(deleted_index), Some(untracked_index)) = (deleted_index, untracked_index) {
            files[untracked_index].status = "R".to_string();
            files[untracked_index].original_path = Some(original_path.clone());
            files.remove(deleted_index);
            coalesced += 1;
        }
    }

    coalesced
}

fn coalesce_working_directory_renames(
    files: &mut Vec<WorkingDirectoryFile>,
    renames: &[(String, String)],
) {
    for (original_path, path) in renames {
        let deleted_index = files
            .iter()
            .position(|file| !file.staged && file.status == "D" && file.path == *original_path);
        let untracked_index = files
            .iter()
            .position(|file| !file.staged && file.status == "?" && file.path == *path);

        if let (Some(deleted_index), Some(untracked_index)) = (deleted_index, untracked_index) {
            files[untracked_index].status = "R".to_string();
            files[untracked_index].original_path = Some(original_path.clone());
            files.remove(deleted_index);
        }
    }
}

/// Refresh git status for a repository (async wrapper)
/// Delegates to the sync version via spawn_blocking to reuse the consolidated
/// single-call implementation with pre_exec FD fix.
pub async fn refresh_git_status(repo_path: &Path) -> Result<GitStatus, String> {
    let path = repo_path.to_path_buf();

    timeout(
        Duration::from_secs(GIT_TIMEOUT_SECONDS),
        tokio::task::spawn_blocking(move || refresh_git_status_sync(&path)),
    )
    .await
    .map_err(|_| "Git status command timed out".to_string())?
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================
// Synchronous versions (for use in std::thread)
// ============================================

/// Refresh git status synchronously (for event processor thread)
pub fn refresh_git_status_sync(repo_path: &Path) -> Result<GitStatus, String> {
    run_git_status_sync(repo_path)
}

/// Run git status synchronously and parse results
/// OPTIMIZED (Jan 24, 2026): Consolidated from 5-6 git calls to 1 git call
/// Uses `git status --porcelain=v2 -b` which provides:
/// - Branch name (# branch.head)
/// - Upstream branch (# branch.upstream)
/// - Ahead/behind counts (# branch.ab)
/// - Commit hash (# branch.oid)
/// - All file status info
///   See: docs/development/bad-file-descriptor-root-cause-0124.md
fn run_git_status_sync(repo_path: &Path) -> Result<GitStatus, String> {
    let canonical_path = repo_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize path {:?}: {}", repo_path, e))?;

    // ONE git call to get everything: branch info + file status
    let output = spawn_git_with_retry(&["status", "--porcelain=v2", "-b"], &canonical_path, 3)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse header lines for branch info
    let mut branch = String::from("main");
    let mut current_upstream_branch: Option<String> = None;
    let mut commit_hash = String::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    // Parse file status
    let mut staged = 0u32;
    let mut unstaged = 0u32;
    let mut untracked = 0u32;
    let mut conflicted = 0u32;
    let mut files: Vec<GitStatusFile> = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("# branch.head ") {
            // # branch.head <branch name>
            branch = line
                .strip_prefix("# branch.head ")
                .unwrap_or("main")
                .to_string();
        } else if line.starts_with("# branch.oid ") {
            // # branch.oid <commit hash>
            commit_hash = line.strip_prefix("# branch.oid ").unwrap_or("").to_string();
            // Handle "(initial)" for new repos with no commits
            if commit_hash == "(initial)" {
                commit_hash = String::new();
            }
        } else if line.starts_with("# branch.upstream ") {
            current_upstream_branch = line
                .strip_prefix("# branch.upstream ")
                .map(|value| value.to_string());
        } else if line.starts_with("# branch.ab ") {
            // # branch.ab +<ahead> -<behind>
            let ab = line.strip_prefix("# branch.ab ").unwrap_or("+0 -0");
            let parts: Vec<&str> = ab.split_whitespace().collect();
            if parts.len() >= 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with("# ") {
            // Skip other header lines (# branch.upstream, etc.)
            continue;
        } else if line.starts_with("1 ") {
            // Ordinary changed files: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = parts[8..].join(" "); // Path may contain spaces

                if xy.len() >= 2 {
                    let x = xy.chars().next().unwrap_or('.');
                    let y = xy.chars().nth(1).unwrap_or('.');

                    // Track counts
                    if x != '.' {
                        staged += 1;
                    }
                    if y != '.' {
                        unstaged += 1;
                    }

                    // Create file entries
                    if x != '.' && y != '.' {
                        files.push(GitStatusFile {
                            path: path.clone(),
                            status: x.to_string(),
                            staged: true,
                            original_path: None,
                        });
                        files.push(GitStatusFile {
                            path: path.clone(),
                            status: y.to_string(),
                            staged: false,
                            original_path: None,
                        });
                    } else if x != '.' {
                        files.push(GitStatusFile {
                            path: path.clone(),
                            status: x.to_string(),
                            staged: true,
                            original_path: None,
                        });
                    } else {
                        files.push(GitStatusFile {
                            path: path.clone(),
                            status: y.to_string(),
                            staged: false,
                            original_path: None,
                        });
                    }
                }
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied files: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>"
            // The path and origPath are separated by a tab character
            if let Some(tab_pos) = line.find('\t') {
                let before_tab = &line[..tab_pos];
                let orig_path = line[tab_pos + 1..].to_string();

                let parts: Vec<&str> = before_tab.split_whitespace().collect();
                if parts.len() >= 9 {
                    let xy = parts[1];
                    let path = parts[9..].join(" "); // Path after the score field

                    if xy.len() >= 2 {
                        let x = xy.chars().next().unwrap_or('.');
                        let y = xy.chars().nth(1).unwrap_or('.');

                        // Track counts
                        if x != '.' {
                            staged += 1;
                        }
                        if y != '.' {
                            unstaged += 1;
                        }

                        // Create file entries
                        if x != '.' && y != '.' {
                            files.push(GitStatusFile {
                                path: path.clone(),
                                status: x.to_string(),
                                staged: true,
                                original_path: Some(orig_path.clone()),
                            });
                            files.push(GitStatusFile {
                                path: path.clone(),
                                status: y.to_string(),
                                staged: false,
                                original_path: Some(orig_path),
                            });
                        } else if x != '.' {
                            files.push(GitStatusFile {
                                path: path.clone(),
                                status: x.to_string(),
                                staged: true,
                                original_path: Some(orig_path),
                            });
                        } else {
                            files.push(GitStatusFile {
                                path: path.clone(),
                                status: y.to_string(),
                                staged: false,
                                original_path: Some(orig_path),
                            });
                        }
                    }
                }
            }
        } else if line.starts_with("u ") {
            // Unmerged (conflicted) files
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 11 {
                let path = parts[10..].join(" ");
                conflicted += 1;
                files.push(GitStatusFile {
                    path,
                    status: "U".to_string(),
                    staged: false,
                    original_path: None,
                });
            }
        } else if let Some(after) = line.strip_prefix("? ") {
            // Untracked file or directory
            let path_str = after.trim();
            let full_path = canonical_path.join(path_str);

            if full_path.is_dir() {
                // Use git ls-files to list untracked files, respecting .gitignore
                if let Ok(entries) = list_untracked_in_directory(&canonical_path, path_str) {
                    for file_path in entries {
                        untracked += 1;
                        files.push(GitStatusFile {
                            path: file_path,
                            status: "?".to_string(),
                            staged: false,
                            original_path: None,
                        });
                    }
                }
            } else {
                untracked += 1;
                files.push(GitStatusFile {
                    path: path_str.to_string(),
                    status: "?".to_string(),
                    staged: false,
                    original_path: None,
                });
            }
        }
    }

    let has_deleted = files.iter().any(|file| !file.staged && file.status == "D");
    let has_untracked = files.iter().any(|file| !file.staged && file.status == "?");
    if has_deleted && has_untracked {
        match detect_unstaged_renames(&canonical_path) {
            Ok(renames) => {
                let coalesced = coalesce_git_status_renames(&mut files, &renames);
                untracked = untracked.saturating_sub(coalesced);
            }
            Err(error) => tracing::warn!(
                repo = %canonical_path.display(),
                error = %error,
                "git::status: unstaged rename detection failed; keeping delete/untracked entries"
            ),
        }
    }

    // Detect git operation states (merge, rebase, cherry-pick, etc.) - filesystem check, no git call
    let op_states = detect_git_operation_states(repo_path);

    Ok(GitStatus {
        branch,
        current_upstream_branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        last_commit_hash: commit_hash,
        last_commit_message: String::new(), // No longer fetched - not needed by frontend
        files,
        merge_in_progress: op_states.0,
        rebase_in_progress: op_states.1,
        cherry_pick_in_progress: op_states.2,
        revert_in_progress: op_states.3,
        bisect_in_progress: op_states.4,
    })
}

/// Detect git operation states by checking for special files in .git directory
/// Returns (merge, rebase, cherry_pick, revert, bisect)
fn detect_git_operation_states(repo_path: &Path) -> (bool, bool, bool, bool, bool) {
    let git_dir = repo_path.join(".git");

    // If .git is a file (worktree), read the actual git dir path.
    //
    // We've already confirmed the file exists. A read failure here
    // (permission, partial mount, etc.) and a missing `gitdir: `
    // prefix (corrupted worktree pointer) both cause us to fall
    // back to using `.git` itself as the operation-state dir,
    // which silently produces "no operation in progress" while a
    // merge/rebase may actually be running. Warn so the cause is
    // visible — the UI will still render, but the operator will
    // know why the merge/rebase indicator is missing.
    let actual_git_dir = if git_dir.is_file() {
        match std::fs::read_to_string(&git_dir) {
            Ok(content) => {
                if let Some(path) = content.strip_prefix("gitdir: ") {
                    std::path::PathBuf::from(path.trim())
                } else {
                    tracing::warn!(
                        path = %git_dir.display(),
                        "git::watch::detect_git_operation_states: .git file is missing the 'gitdir: ' prefix; operation-state detection will be incorrect"
                    );
                    git_dir
                }
            }
            Err(err) => {
                tracing::warn!(
                    path = %git_dir.display(),
                    error = %err,
                    "git::watch::detect_git_operation_states: .git file read failed; operation-state detection will be incorrect"
                );
                git_dir
            }
        }
    } else {
        git_dir
    };

    let merge_in_progress = actual_git_dir.join("MERGE_HEAD").exists();

    // Rebase can be in rebase-merge (interactive) or rebase-apply (am/plain)
    let rebase_in_progress = actual_git_dir.join("rebase-merge").exists()
        || actual_git_dir.join("rebase-apply").exists();

    let cherry_pick_in_progress = actual_git_dir.join("CHERRY_PICK_HEAD").exists();

    let revert_in_progress = actual_git_dir.join("REVERT_HEAD").exists();

    let bisect_in_progress = actual_git_dir.join("BISECT_LOG").exists();

    (
        merge_in_progress,
        rebase_in_progress,
        cherry_pick_in_progress,
        revert_in_progress,
        bisect_in_progress,
    )
}

// ============================================
// Detailed File Status (for API responses)
// ============================================

/// Collapse a `GitStatus` file list into the one-entry-per-path form the HTTP
/// API returns, without spawning git again.
///
/// `refresh_git_status_sync` emits TWO entries for a file with both staged and
/// unstaged changes (`XY` where neither is `.`) — a staged entry carrying `X`
/// followed by an unstaged entry carrying `Y`. `get_detailed_file_status_sync`
/// instead emits ONE, preferring the staged side. Because the staged entry is
/// always pushed first, taking the first entry per path reproduces that
/// preference exactly.
///
/// NOTE: the two representations genuinely differ, and both are live — the
/// WebSocket `repo:status_updated` payload carries the two-entry form while
/// this HTTP route returns the one-entry form. This helper preserves the
/// existing HTTP shape; it does not reconcile the two.
pub fn collapse_to_working_directory_files(files: &[GitStatusFile]) -> Vec<WorkingDirectoryFile> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut collapsed = Vec::with_capacity(files.len());

    for file in files {
        if !seen.insert(file.path.as_str()) {
            continue;
        }
        collapsed.push(WorkingDirectoryFile {
            path: file.path.clone(),
            status: file.status.clone(),
            staged: file.staged,
            original_path: file.original_path.clone(),
        });
    }

    collapsed
}

/// Get detailed file status with individual file entries
/// This is used by the HTTP API to return the full file list
pub fn get_detailed_file_status_sync(
    repo_path: &Path,
) -> Result<Vec<WorkingDirectoryFile>, String> {
    let canonical_path = repo_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize path {:?}: {}", repo_path, e))?;

    // Use resilient spawn helper with retries
    let output = spawn_git_with_retry(&["status", "--porcelain=v2"], &canonical_path, 3)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout.lines() {
        // Skip branch/header lines
        if line.starts_with('#') {
            continue;
        }

        if line.starts_with("1 ") {
            // Ordinary changed files: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = parts[8..].join(" "); // Path may contain spaces

                if xy.len() >= 2 {
                    let x = xy.chars().next().unwrap_or('.');
                    let y = xy.chars().nth(1).unwrap_or('.');

                    let (status, staged) = if x != '.' {
                        (x.to_string(), true)
                    } else {
                        (y.to_string(), false)
                    };

                    files.push(WorkingDirectoryFile {
                        path: path.clone(),
                        status,
                        staged,
                        original_path: None,
                    });
                }
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied files: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>"
            // The path and origPath are separated by a tab character
            if let Some(tab_pos) = line.find('\t') {
                let before_tab = &line[..tab_pos];
                let orig_path = line[tab_pos + 1..].to_string();

                let parts: Vec<&str> = before_tab.split_whitespace().collect();
                if parts.len() >= 9 {
                    let xy = parts[1];
                    let path = parts[9..].join(" "); // Path after the score field

                    if xy.len() >= 2 {
                        let x = xy.chars().next().unwrap_or('.');
                        let y = xy.chars().nth(1).unwrap_or('.');

                        let (status, staged) = if x != '.' {
                            (x.to_string(), true)
                        } else {
                            (y.to_string(), false)
                        };

                        files.push(WorkingDirectoryFile {
                            path: path.clone(),
                            status,
                            staged,
                            original_path: Some(orig_path),
                        });
                    }
                }
            }
        } else if line.starts_with("u ") {
            // Unmerged (conflicted) files: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
            // XY values: DD, AU, UD, UA, DU, AA, UU (conflict types)
            // We report these as status "U" (Unmerged) which frontend maps to "C" (Conflict)
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 11 {
                let path = parts[10..].join(" "); // Path may contain spaces

                files.push(WorkingDirectoryFile {
                    path,
                    status: "U".to_string(), // U = Unmerged/Conflict
                    staged: false,           // Conflict files are not staged
                    original_path: None,
                });
            }
        } else if let Some(after) = line.strip_prefix("? ") {
            // Untracked file or directory: "? <path>"
            let path_str = after.trim();
            let full_path = canonical_path.join(path_str);

            // Check if this is a directory - if so, use git ls-files to list contents
            if full_path.is_dir() {
                // Use git ls-files to list untracked files, respecting .gitignore
                if let Ok(entries) = list_untracked_in_directory(&canonical_path, path_str) {
                    for file_path in entries {
                        files.push(WorkingDirectoryFile {
                            path: file_path,
                            status: "?".to_string(),
                            staged: false,
                            original_path: None,
                        });
                    }
                }
            } else {
                // Regular untracked file
                files.push(WorkingDirectoryFile {
                    path: path_str.to_string(),
                    status: "?".to_string(),
                    staged: false,
                    original_path: None,
                });
            }
        }
    }

    let has_deleted = files.iter().any(|file| !file.staged && file.status == "D");
    let has_untracked = files.iter().any(|file| !file.staged && file.status == "?");
    if has_deleted && has_untracked {
        match detect_unstaged_renames(&canonical_path) {
            Ok(renames) => coalesce_working_directory_renames(&mut files, &renames),
            Err(error) => tracing::warn!(
                repo = %canonical_path.display(),
                error = %error,
                "git::status: detailed unstaged rename detection failed; keeping delete/untracked entries"
            ),
        }
    }

    Ok(files)
}

/// List untracked files in a directory, respecting .gitignore rules.
/// Uses `git ls-files --others --exclude-standard` which properly handles all gitignore patterns.
///
/// This replaces the old manual walkdir approach which didn't respect .gitignore,
/// causing node_modules/ and other ignored directories to show up with 1000+ files.
fn list_untracked_in_directory(
    repo_path: &std::path::Path,
    relative_dir: &str,
) -> Result<Vec<String>, String> {
    let dir_path = relative_dir.trim_end_matches('/');

    // Use git ls-files to list untracked files, respecting .gitignore
    let output = spawn_git_with_retry(
        &["ls-files", "--others", "--exclude-standard", dir_path],
        repo_path,
        3,
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed for {}: {}", dir_path, stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect();

    Ok(files)
}

/// Get upstream tracking branch name for current branch
/// Uses spawn_git_with_retry to prevent "bad file descriptor" errors from WebView FD inheritance
pub fn get_upstream_branch(repo_path: &Path) -> Option<String> {
    let canonical_path = match repo_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return None,
    };

    // Get current branch using resilient spawn helper
    let branch_output =
        spawn_git_with_retry(&["rev-parse", "--abbrev-ref", "HEAD"], &canonical_path, 3).ok()?;

    if !branch_output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    // Get upstream for this branch using resilient spawn helper
    let upstream_ref = format!("{}@{{upstream}}", branch);
    let upstream_output = spawn_git_with_retry(
        &["rev-parse", "--abbrev-ref", &upstream_ref],
        &canonical_path,
        3,
    )
    .ok()?;

    if upstream_output.status.success() {
        let upstream = String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .to_string();
        if !upstream.is_empty() {
            return Some(upstream);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        collapse_to_working_directory_files, get_detailed_file_status_sync, refresh_git_status_sync,
    };
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    struct TempRepo(std::path::PathBuf);

    impl TempRepo {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("orgii-unstaged-rename-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temporary repository directory");
            Self(path)
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reports_unstaged_file_move_as_rename() {
        let temp_repo = TempRepo::new();
        let repo = Repository::init(&temp_repo.0).expect("initialize repository");
        let original_path = temp_repo.0.join("old/icon.svg");
        let relocated_path = temp_repo.0.join("new/icon.svg");

        fs::create_dir_all(original_path.parent().unwrap()).expect("create original directory");
        fs::write(&original_path, "<svg>same content</svg>\n").expect("write original file");

        let mut index = repo.index().expect("open index");
        index
            .add_path(Path::new("old/icon.svg"))
            .expect("add original file");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("ORGII Test", "test@orgii.local").expect("signature");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("create initial commit");
        drop(tree);
        drop(repo);

        fs::create_dir_all(relocated_path.parent().unwrap()).expect("create relocated directory");
        fs::rename(&original_path, &relocated_path).expect("relocate file");

        let status = refresh_git_status_sync(&temp_repo.0).expect("get watcher status");
        assert_eq!(status.unstaged, 1);
        assert_eq!(status.untracked, 0);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].status, "R");
        assert_eq!(status.files[0].path, "new/icon.svg");
        assert_eq!(
            status.files[0].original_path.as_deref(),
            Some("old/icon.svg")
        );

        let detailed = get_detailed_file_status_sync(&temp_repo.0).expect("get detailed status");
        assert_eq!(detailed.len(), 1);
        assert_eq!(detailed[0].status, "R");
        assert_eq!(detailed[0].path, "new/icon.svg");
        assert_eq!(detailed[0].original_path.as_deref(), Some("old/icon.svg"));

        // The HTTP status route derives its file list this way instead of
        // spawning a second `git status`.
        assert_eq!(collapse_to_working_directory_files(&status.files), detailed);
    }

    /// The one case where the two parsers genuinely disagree: a file with BOTH
    /// staged and unstaged changes. `refresh_git_status_sync` emits two entries,
    /// `get_detailed_file_status_sync` emits one (staged side). The collapse
    /// helper must reproduce the latter, since the HTTP route now uses it.
    #[test]
    fn collapse_matches_detailed_status_for_partially_staged_file() {
        let temp_repo = TempRepo::new();
        let repo = Repository::init(&temp_repo.0).expect("initialize repository");
        let tracked = temp_repo.0.join("tracked.txt");

        fs::write(&tracked, "original\n").expect("write original file");
        let mut index = repo.index().expect("open index");
        index
            .add_path(Path::new("tracked.txt"))
            .expect("add tracked file");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("ORGII Test", "test@orgii.local").expect("signature");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("create initial commit");
        drop(tree);

        // Stage one modification, then modify again without staging → "MM".
        fs::write(&tracked, "staged change\n").expect("write staged change");
        let mut index = repo.index().expect("reopen index");
        index
            .add_path(Path::new("tracked.txt"))
            .expect("stage modification");
        index.write().expect("write index");
        drop(index);
        drop(repo);
        fs::write(&tracked, "unstaged change\n").expect("write unstaged change");

        let status = refresh_git_status_sync(&temp_repo.0).expect("get watcher status");
        let detailed = get_detailed_file_status_sync(&temp_repo.0).expect("get detailed status");

        // Two entries on the watcher/WebSocket side, one on the HTTP side.
        assert_eq!(status.files.len(), 2);
        assert!(status.files[0].staged);
        assert!(!status.files[1].staged);
        assert_eq!(detailed.len(), 1);
        assert!(detailed[0].staged);

        assert_eq!(collapse_to_working_directory_files(&status.files), detailed);
    }
}
