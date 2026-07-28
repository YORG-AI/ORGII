//! Git-derived context: authoring branch metadata and commit reachability.

use std::path::Path;

use git::util::run_git;

use crate::orgtrack::paths;
use crate::orgtrack::types::{
    OrgtrackBranchContext, OrgtrackReachability, OrgtrackReachabilityState,
};

pub(super) fn branch_context_for(repo_path: &Path) -> OrgtrackBranchContext {
    OrgtrackBranchContext {
        authoring_branch: git_output(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        authoring_head_sha: git_output(repo_path, &["rev-parse", "HEAD"]),
        authoring_base_branch: default_branch(repo_path),
        authoring_base_sha: default_branch(repo_path)
            .and_then(|branch| git_output(repo_path, &["merge-base", "HEAD", &branch])),
        default_branch: default_branch(repo_path),
        worktree_path_hash: Some(paths::path_hash(&repo_path.to_string_lossy())),
    }
}

pub(super) fn reachability_for(repo_path: &Path, commit_sha: Option<&str>) -> OrgtrackReachability {
    let checked_at_head = git_output(repo_path, &["rev-parse", "HEAD"]);
    let Some(commit_sha) = commit_sha.filter(|value| !value.trim().is_empty()) else {
        return OrgtrackReachability {
            state: OrgtrackReachabilityState::Uncommitted,
            checked_at_head,
            is_reachable_from_current_head: Some(false),
            is_reachable_from_default_branch: None,
            first_reachable_commit_sha: None,
            current_file_contains_attributed_range: Some("unknown".to_string()),
        };
    };
    let reachable_from_head = git_success(
        repo_path,
        &["merge-base", "--is-ancestor", commit_sha, "HEAD"],
    );
    let reachable_from_default = default_branch(repo_path).as_deref().map(|branch| {
        git_success(
            repo_path,
            &["merge-base", "--is-ancestor", commit_sha, branch],
        )
    });

    OrgtrackReachability {
        state: if reachable_from_head {
            OrgtrackReachabilityState::ReachableExact
        } else {
            OrgtrackReachabilityState::LinkedUnreachable
        },
        checked_at_head,
        is_reachable_from_current_head: Some(reachable_from_head),
        is_reachable_from_default_branch: reachable_from_default,
        first_reachable_commit_sha: reachable_from_head.then(|| commit_sha.to_string()),
        current_file_contains_attributed_range: Some("unknown".to_string()),
    }
}

fn default_branch(repo_path: &Path) -> Option<String> {
    git_output(repo_path, &["symbolic-ref", "refs/remotes/origin/HEAD"])
        .and_then(|value| {
            value
                .strip_prefix("refs/remotes/origin/")
                .map(str::to_string)
        })
        .or_else(|| Some("main".to_string()))
}

fn git_output(repo_path: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(repo_path, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_success(repo_path: &Path, args: &[&str]) -> bool {
    run_git(repo_path, args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(super) fn short_sha(commit_sha: &str) -> String {
    commit_sha.chars().take(8).collect()
}
