//! Workspace (non-channel) `## Environment` block plus the process-wide
//! git-branch cache it reads.

use std::path::Path;
use std::sync::OnceLock;

use crate::core::session::prompt::cache::GitBranchCache;

// ============================================
// Section builders
// ============================================

static GIT_BRANCH_CACHE: OnceLock<GitBranchCache> = OnceLock::new();

pub(crate) fn build_project_environment(
    workspace_path: &Path,
    additional_dirs: &[&Path],
) -> String {
    let mut ctx = String::from("## Environment\n\n");
    ctx.push_str(&format!("- Platform: {}\n", std::env::consts::OS));
    ctx.push_str(&format!(
        "- Today's date: {}\n",
        chrono::Local::now().format("%A %b %d, %Y")
    ));
    ctx.push_str(&format!(
        "- Working directory: `{}`\n",
        workspace_path.display()
    ));

    //   mirror claude_code's `computeSimpleEnvInfo` —
    // emit an "Additional working directories" block whenever the
    // session has any extras granted via `add_workspace_directory`.
    // Skipped entirely when empty so the prompt stays cache-stable
    // for sessions that never touch `/add-dir` / the Gateway
    // `add_workspace_directory` tool. Paths are rendered as Markdown
    // bullets (consistent with the rest of the `## Environment`
    // block — claude_code's simple-env variant does the same).
    if !additional_dirs.is_empty() {
        ctx.push_str("- Additional working directories:\n");
        for dir in additional_dirs {
            ctx.push_str(&format!("  - `{}`\n", dir.display()));
        }
    }

    let is_git = workspace_path.join(".git").exists();
    ctx.push_str(&format!(
        "- Git repo: {}\n",
        if is_git { "yes" } else { "no" }
    ));

    if is_git {
        let cache = GIT_BRANCH_CACHE.get_or_init(GitBranchCache::default);
        if let Some(branch) = cache.get_or_fetch(workspace_path) {
            ctx.push_str(&format!("- Git branch: `{}`\n", branch));
        }
    }

    if let Ok(entries) = std::fs::read_dir(workspace_path) {
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                !name.starts_with('.') || name == ".gitignore" || name == ".env.example"
            })
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_dir() {
                    format!("{}/", name)
                } else {
                    name
                }
            })
            .collect();
        names.sort();
        names.truncate(30);
        if !names.is_empty() {
            ctx.push_str(&format!("- Top-level files: {}\n", names.join(", ")));
        }
    }

    ctx
}
