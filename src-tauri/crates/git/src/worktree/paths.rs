//! Naming and path derivation: repo hash directory names, per-session
//! worktree directories, session-id validation, and git branch names.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use core_types::session::CLI_SESSION_PREFIX;

// ============================================
// Helpers
// ============================================

/// Compute a human-readable directory name for the repo.
/// Format: `{repo-name}-{short-hash}` (e.g. `my-app-dd62a8a1`).
pub(crate) fn repo_hash(repo_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(repo_path.as_bytes());
    let result = hasher.finalize();
    let short_hash = &format!("{:x}", result)[..8];

    let repo_name = Path::new(repo_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");

    let sanitized: String = repo_name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .to_lowercase();

    let trimmed = sanitized.trim_matches('-');
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut prev_hyphen = false;
    for ch in trimmed.chars() {
        if ch == '-' {
            if !prev_hyphen {
                collapsed.push('-');
            }
            prev_hyphen = true;
        } else {
            collapsed.push(ch);
            prev_hyphen = false;
        }
    }

    let name_part = if collapsed.is_empty() {
        "repo"
    } else {
        &collapsed
    };
    format!("{}-{}", name_part, short_hash)
}

/// Root directory for agent worktrees: `~/.orgii/agent-worktrees/`.
/// Thin re-export so this module's call sites stay short; the path
/// itself is owned by the `app_paths` workspace crate.
pub(super) fn agent_worktrees_root() -> PathBuf {
    app_paths::agent_worktrees_root()
}

/// Validate session_id to prevent path traversal and invalid branch names.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    if session_id.contains("..")
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains('\0')
    {
        return Err(format!(
            "session_id contains invalid characters: {}",
            session_id
        ));
    }
    Ok(())
}

/// Worktree directory for a specific repo + session.
pub(super) fn session_worktree_dir(repo_path: &str, session_id: &str) -> PathBuf {
    let hash = repo_hash(repo_path);
    agent_worktrees_root().join(hash).join(session_id)
}

/// Branch name for a session. Strips known prefixes to keep branch names
/// concise, and sanitizes characters that are invalid in git ref names
/// (e.g. `:` from builtin agent IDs like `builtin:explore`).
pub(crate) fn session_branch_name(session_id: &str) -> String {
    let suffix = session_id
        .strip_prefix(CLI_SESSION_PREFIX)
        .unwrap_or(session_id);
    if suffix.is_empty() {
        return format!("agent/{}", sanitize_branch_chars(session_id));
    }
    format!("agent/{}", sanitize_branch_chars(suffix))
}

/// Replace characters that are invalid in git branch names with `-`.
/// Git ref format rules (git-check-ref-format): no `:`  ` ` `~` `^` `?` `*` `[` `\` + control chars.
fn sanitize_branch_chars(s: &str) -> String {
    s.chars()
        .map(|ch| {
            if ch == ':'
                || ch == ' '
                || ch == '~'
                || ch == '^'
                || ch == '?'
                || ch == '*'
                || ch == '['
                || ch == '\\'
                || ch.is_ascii_control()
            {
                '-'
            } else {
                ch
            }
        })
        .collect()
}
