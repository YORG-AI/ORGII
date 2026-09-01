//! Pure parser for `git worktree list --porcelain` output, kept free of any
//! process invocation so it can be unit-tested without a real repo.

use super::GeneralWorktreeEntry;

/// Parse the porcelain output of `git worktree list --porcelain`.
///
/// Extracted as a pure function so it can be unit-tested without a real repo.
pub(crate) fn parse_worktree_list_porcelain(stdout: &str) -> Vec<GeneralWorktreeEntry> {
    let mut entries = Vec::new();
    let mut is_first = true;

    for entry in stdout.split("\n\n") {
        if entry.trim().is_empty() {
            continue;
        }

        let mut wt_path = String::new();
        let mut wt_branch = String::new();
        let mut head_sha = String::new();
        let mut is_bare = false;

        for line in entry.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                wt_path = path.to_string();
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                wt_branch = branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string();
            } else if let Some(sha) = line.strip_prefix("HEAD ") {
                head_sha = sha.to_string();
            } else if line == "bare" {
                is_bare = true;
            }
        }

        if wt_path.is_empty() || is_bare {
            is_first = false;
            continue;
        }

        entries.push(GeneralWorktreeEntry {
            path: wt_path,
            branch: wt_branch,
            head_sha,
            is_main: is_first,
        });
        is_first = false;
    }

    entries
}
