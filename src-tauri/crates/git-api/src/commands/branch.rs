use super::utils::run_git;
use crate::types::*;
use git::types::BranchInfo;
/**
 * Branch Operations
 *
 * Create, delete, checkout, and list branches.
 * All operations use retry logic for transient errors.
 */
use std::path::Path;

impl From<BranchInfo> for GitBranchInfo {
    fn from(b: BranchInfo) -> Self {
        Self {
            name: b.name,
            upstream: b.upstream,
            tip_sha: b.tip_sha,
            branch_type: b.branch_type,
            ref_name: b.ref_name,
            is_current: b.is_current,
            last_commit_date: b.last_commit_date,
        }
    }
}

/// List all branches (local and remote).
///
/// Thin wrapper over the pure helper in `git::branches` that converts the
/// internal `BranchInfo` records into the utoipa-deriving `GitBranchInfo`
/// used in HTTP responses.
pub fn list_branches(repo_path: &Path) -> Result<GitBranchesData, String> {
    let data = git::branches::list_branches(repo_path)?;
    Ok(GitBranchesData {
        branches: data.branches.into_iter().map(GitBranchInfo::from).collect(),
        current_branch: data.current_branch,
    })
}

/// Create a new branch
pub fn create_branch(
    repo_path: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<(), String> {
    let mut args = vec!["branch", name];

    if let Some(sp) = start_point {
        args.push(sp);
    }

    let output = run_git(repo_path, &args)?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    if checkout {
        checkout_ref(repo_path, name, false)?;
    }

    Ok(())
}

/// Delete a branch
pub fn delete_branch(repo_path: &Path, branch_name: &str, force: bool) -> Result<(), String> {
    let delete_flag = if force { "-D" } else { "-d" };

    let output = run_git(repo_path, &["branch", delete_flag, branch_name])?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Rename a branch
///
/// If `old_name` is None, renames the current branch to `new_name`.
/// If `old_name` is Some, renames that specific branch.
/// If `force` is true, forces the rename even if the new name already exists.
pub fn rename_branch(
    repo_path: &Path,
    old_name: Option<&str>,
    new_name: &str,
    force: bool,
) -> Result<(), String> {
    let rename_flag = if force { "-M" } else { "-m" };

    let mut args = vec!["branch", rename_flag];

    if let Some(old) = old_name {
        args.push(old);
    }
    args.push(new_name);

    let output = run_git(repo_path, &args)?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Split a remote-tracking ref into the ref Git accepts and the local branch
/// name users expect to check out.
///
/// Branch lists expose short names such as `origin/feat/auth`, while callers may
/// also provide the fully-qualified `refs/remotes/origin/feat/auth` form.
fn remote_tracking_branch(ref_name: &str) -> Option<(String, String)> {
    let fully_qualified = ref_name.starts_with("refs/remotes/");
    let short_ref = ref_name.strip_prefix("refs/remotes/").unwrap_or(ref_name);
    let (remote, local_name) = short_ref.split_once('/')?;
    if !fully_qualified && !matches!(remote, "origin" | "upstream") {
        return None;
    }
    if local_name.is_empty() || local_name == "HEAD" || local_name.starts_with("HEAD ->") {
        return None;
    }
    Some((short_ref.to_string(), local_name.to_string()))
}

fn ref_exists(repo_path: &Path, full_ref: &str) -> bool {
    run_git(repo_path, &["show-ref", "--verify", "--quiet", full_ref])
        .is_ok_and(|output| output.status.success())
}

/// Checkout a branch or ref
///
/// Handles remote branches by automatically creating a local tracking branch.
/// Selecting `origin/feature-branch`, for example, checks out the local
/// `feature-branch` (creating it with upstream tracking when necessary) instead
/// of leaving the repository at a detached remote-tracking ref.
///
/// If `force` is true, uses `git checkout --force` to discard local changes.
pub fn checkout_ref(repo_path: &Path, ref_name: &str, force: bool) -> Result<(), String> {
    // An explicit remote-tracking ref is itself a valid checkout target, but
    // checking it out directly detaches HEAD. Resolve it before the generic
    // checkout attempt so branch-picker selection behaves like GitHub Desktop.
    let exact_local_ref = format!("refs/heads/{}", ref_name);
    if !ref_exists(repo_path, &exact_local_ref) {
        if let Some((remote_ref, local_name)) = remote_tracking_branch(ref_name) {
            let full_remote_ref = format!("refs/remotes/{}", remote_ref);
            if ref_exists(repo_path, &full_remote_ref) {
                let local_ref = format!("refs/heads/{}", local_name);
                let mut args = vec!["checkout"];
                if force {
                    args.push("--force");
                }

                if ref_exists(repo_path, &local_ref) {
                    args.push(&local_name);
                } else {
                    args.extend(["-b", &local_name, "--track", &remote_ref]);
                }

                let output = run_git(repo_path, &args)?;
                if output.status.success() {
                    return Ok(());
                }
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
        }
    }

    // Build checkout args based on force flag
    let checkout_args = if force {
        vec!["checkout", "--force", ref_name]
    } else {
        vec!["checkout", ref_name]
    };

    // First, try a simple checkout
    let output = run_git(repo_path, &checkout_args)?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Check if the error is because the branch doesn't exist locally
    // but might exist as a remote branch
    if stderr.contains("did not match any file")
        || stderr.contains("pathspec")
        || stderr.contains("not a commit")
    {
        // Try to find a matching remote branch (check common remotes)
        for remote in ["origin", "upstream"] {
            let remote_ref = format!("{}/{}", remote, ref_name);

            // Check if remote branch exists
            let check_output = run_git(
                repo_path,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/remotes/{}", remote_ref),
                ],
            );

            if let Ok(check) = check_output {
                if check.status.success() {
                    // Remote branch exists, create local tracking branch
                    log::info!("[GitAPI] Creating local tracking branch for {}", remote_ref);

                    let track_output = run_git(
                        repo_path,
                        &["checkout", "-b", ref_name, "--track", &remote_ref],
                    )?;

                    if track_output.status.success() {
                        return Ok(());
                    }

                    // If that failed (maybe branch already exists), try just checkout with track
                    let track_output2 = run_git(repo_path, &["checkout", "--track", &remote_ref])?;

                    if track_output2.status.success() {
                        return Ok(());
                    }
                }
            }
        }
    }

    // Return original error if we couldn't resolve it
    Err(stderr)
}

/// Get default branch
pub fn get_default_branch(repo_path: &Path, remote: Option<&str>) -> Result<String, String> {
    let remote_name = remote.unwrap_or("origin");

    // Try to get the default branch from remote HEAD
    let remote_head_ref = format!("refs/remotes/{}/HEAD", remote_name);
    if let Ok(output) = run_git(repo_path, &["symbolic-ref", &remote_head_ref]) {
        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Extract branch name from refs/remotes/origin/main -> main
            if let Some(branch) = result.split('/').next_back() {
                return Ok(branch.to_string());
            }
        }
    }

    // Fallback: try common default branch names
    for default_name in ["main", "master"] {
        let ref_path = format!("refs/remotes/{}/{}", remote_name, default_name);
        if let Ok(output) = run_git(repo_path, &["show-ref", "--verify", "--quiet", &ref_path]) {
            if output.status.success() {
                return Ok(default_name.to_string());
            }
        }
    }

    Err("Could not determine default branch".to_string())
}

#[cfg(test)]
mod tests {
    use super::remote_tracking_branch;

    #[test]
    fn parses_short_remote_tracking_branch() {
        assert_eq!(
            remote_tracking_branch("origin/feat/org2-cloud-auth"),
            Some((
                "origin/feat/org2-cloud-auth".to_string(),
                "feat/org2-cloud-auth".to_string(),
            ))
        );
    }

    #[test]
    fn parses_fully_qualified_remote_tracking_branch() {
        assert_eq!(
            remote_tracking_branch("refs/remotes/upstream/feature/auth"),
            Some((
                "upstream/feature/auth".to_string(),
                "feature/auth".to_string(),
            ))
        );
    }

    #[test]
    fn ignores_remote_head_and_plain_branch_names() {
        assert_eq!(remote_tracking_branch("refs/remotes/origin/HEAD"), None);
        assert_eq!(remote_tracking_branch("develop"), None);
    }
}

/// Get current branch with full info
pub fn get_current_branch_info(repo_path: &Path) -> Result<GitBranchInfo, String> {
    // Get all branches
    let branches_data = list_branches(repo_path)?;

    // Find and return the current branch
    branches_data
        .branches
        .into_iter()
        .find(|b| b.is_current)
        .ok_or_else(|| "Current branch not found in branch list".to_string())
}
