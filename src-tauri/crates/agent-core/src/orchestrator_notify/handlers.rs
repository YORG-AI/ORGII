//! Per-event handlers for `orchestrator_notify`.
//!
//! When an agent session changes state (review completes, work-item
//! finishes, error surfaces), the orchestrator wants a structured digest
//! suitable for project-management bookkeeping. Each `extract_*` /
//! `handle_*` function in this file pulls the relevant message slice out
//! of the session log and shapes it into a typed payload — the dispatch
//! site lives in `orchestrator_notify::mod`.

/// Proof-of-work facts gathered from git, decoupled from the frontmatter
/// mutation so the subprocess I/O can run OUTSIDE the work item's
/// `BEGIN IMMEDIATE` transaction. Running git inside the transaction
/// poisoned the whole store on-device: a hung `git diff` held the
/// projects.db write lock indefinitely, starving the sync worker, the
/// CLI and every later completion attempt.
pub(super) struct CollectedProofOfWork {
    branch: Option<String>,
    diff_stats: Option<project_management::projects::types::WorkItemDiffStats>,
}

/// Run the git side of proof-of-work collection. Subprocess-heavy; must
/// never be called while a DB transaction is open.
pub(super) fn collect_proof_of_work_data(repo_path: &str) -> CollectedProofOfWork {
    use std::path::Path;

    let repo = Path::new(repo_path);

    let branch = git::git_command()
        .ok()
        .and_then(|mut command| {
            command
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(repo)
                .output()
                .ok()
        })
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());

    let base_branch = detect_default_branch(repo);

    let diff_stats = match (&branch, &base_branch) {
        (Some(branch_name), Some(base)) if branch_name != base => {
            match project_management::orchestrator::diff_stats::compute_diff_stats(
                repo_path,
                base,
                branch_name,
            ) {
                Ok(stats) => Some(stats),
                Err(err) => {
                    tracing::warn!(
                        "[orchestrator] Failed to compute diff stats for {}: {}",
                        branch_name,
                        err
                    );
                    None
                }
            }
        }
        _ => None,
    };

    CollectedProofOfWork { branch, diff_stats }
}

/// Bounded wrapper: git on a sick machine can block forever (the exact
/// failure observed on-device), and the completion policy must not
/// inherit that hang. The worker thread is detached on timeout — it
/// finishes (or not) without holding anything the store cares about.
pub(super) fn collect_proof_of_work_data_bounded(
    repo_path: &str,
    timeout: std::time::Duration,
) -> Option<CollectedProofOfWork> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let repo = repo_path.to_string();
    std::thread::spawn(move || {
        let _ = sender.send(collect_proof_of_work_data(&repo));
    });
    match receiver.recv_timeout(timeout) {
        Ok(collected) => Some(collected),
        Err(_) => {
            tracing::warn!(
                "[orchestrator] proof-of-work collection timed out after {:?} for {}; \
                 completing without diff stats",
                timeout,
                repo_path
            );
            None
        }
    }
}

/// Attach precollected proof-of-work facts to the frontmatter. Pure
/// in-memory mutation — safe inside the atomic transaction.
pub(super) fn apply_proof_of_work(
    frontmatter: &mut project_management::projects::types::WorkItemFrontmatter,
    collected: &CollectedProofOfWork,
) {
    if let Some(ref branch_name) = collected.branch {
        project_management::orchestrator::proof_of_work::set_branch(frontmatter, branch_name);
    }
    if let Some(ref stats) = collected.diff_stats {
        project_management::orchestrator::proof_of_work::set_diff_stats(frontmatter, stats.clone());
    }
}

fn detect_default_branch(repo: &std::path::Path) -> Option<String> {
    for candidate in &["main", "master"] {
        let result = git::git_command().and_then(|mut command| {
            command
                .args(["rev-parse", "--verify", candidate])
                .current_dir(repo)
                .output()
                .map_err(|err| err.to_string())
        });
        if result.map(|out| out.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}
