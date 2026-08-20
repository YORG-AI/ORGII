use crate::agent_sessions;

pub(crate) const DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS: u64 = 6;
pub(crate) const WORKTREE_CLEANUP_INTERVAL_SETTING: &str = "git.worktree.cleanupIntervalHours";

/// Prune stale agent worktrees whose sessions no longer exist in the DB.
pub(crate) fn prune_stale_agent_worktrees() -> Result<(), String> {
    let cli_sessions = agent_sessions::cli::persistence::list_sessions()
        .map_err(|err| format!("DB error listing CLI sessions: {}", err))?;
    let rust_sessions = agent_core::session::persistence::list_sessions(
        &agent_core::session::SessionListFilter::default(),
    )
    .map_err(|err| format!("DB error listing Rust agent sessions: {}", err))?;

    let active_ids: Vec<String> = cli_sessions
        .iter()
        .map(|session| session.session_id.clone())
        .chain(
            rust_sessions
                .iter()
                .map(|session| session.session_id.clone()),
        )
        .collect();

    // Group sessions by repo_path/workspace_path so we prune per-repo.
    let mut repos_seen = std::collections::HashSet::new();
    for session in &cli_sessions {
        if let Some(ref repo_path) = session.repo_path {
            if !repo_path.is_empty() {
                repos_seen.insert(repo_path.clone());
            }
        }
    }
    for session in &rust_sessions {
        if let Some(ref workspace_path) = session.workspace_path {
            if !workspace_path.is_empty() {
                repos_seen.insert(workspace_path.clone());
            }
        }
    }

    let mut total_pruned = 0u32;
    for repo_path in &repos_seen {
        let repo = std::path::Path::new(repo_path);
        // Recorded paths can point at directories that were never
        // repositories (e2e temp dirs); the marker check keeps prune from
        // spawning a doomed git process and warning on every launch.
        if !repo.is_dir() || !repo.join(".git").exists() {
            continue;
        }
        match git::worktree::prune_stale_worktrees(repo, &active_ids) {
            Ok(pruned) => total_pruned += pruned,
            Err(err) => tracing::warn!(
                "[worktree] Failed to prune worktrees for {}: {}",
                repo_path,
                err
            ),
        }
    }

    if total_pruned > 0 {
        tracing::info!("[worktree] Pruned {} stale agent worktrees", total_pruned);
    }

    Ok(())
}

pub(crate) fn worktree_cleanup_interval_hours() -> u64 {
    settings::file_io::read_settings()
        .ok()
        .and_then(|settings| {
            settings
                .get(WORKTREE_CLEANUP_INTERVAL_SETTING)
                .and_then(|value| value.as_u64())
        })
        .filter(|hours| *hours > 0)
        .unwrap_or(DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS)
}

pub(crate) async fn run_worktree_cleanup_loop() {
    loop {
        if let Err(err) = prune_stale_agent_worktrees() {
            tracing::warn!("[worktree] Failed to prune stale agent worktrees: {}", err);
        }

        tokio::time::sleep(std::time::Duration::from_secs(
            worktree_cleanup_interval_hours().saturating_mul(60 * 60),
        ))
        .await;
    }
}
