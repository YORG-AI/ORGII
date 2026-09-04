//! Logs, the account- and session-scoped HOME/config trees handed to external
//! CLI agents, the CLI config-manager profile tree, tool-result spill dirs,
//! and the agent worktrees root.

use std::path::PathBuf;

use crate::data_root::orgii_root;
use crate::temp::sanitize_path_segment;

// ---------------------------------------------------------------------------
// Logs / per-session CLI homes / agent worktrees
// ---------------------------------------------------------------------------
//
// Misc `~/.orgii/` path helpers used by housekeeping, the per-session
// CLI runners (`agent_sessions::cli::session_runner`), and the worktree
// manager in the `git` crate. Owned here so leaf crates resolve them
// without any back-edge into the `app` crate.

/// Log directory: `~/.orgii/logs/`.
pub fn logs_dir() -> PathBuf {
    orgii_root().join("logs")
}

/// Per-session Cursor CLI config root: `~/.orgii/cursor-config/`.
pub fn cursor_config_root() -> PathBuf {
    orgii_root().join("cursor-config")
}

/// Per-session Cursor CLI config dir for one session.
pub fn cursor_config_dir(session_id: &str) -> PathBuf {
    cursor_config_root().join(session_id)
}

/// Account-scoped Cursor CLI profile root: `~/.orgii/cursor-cli-profiles/`.
pub fn cursor_cli_profile_root() -> PathBuf {
    orgii_root().join("cursor-cli-profiles")
}

/// Account-scoped Cursor CLI profile dir.
pub fn cursor_cli_profile_dir(account_id: &str) -> PathBuf {
    cursor_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped Claude Code CLI config root: `~/.orgii/claude-code-cli-profiles/`.
pub fn claude_code_cli_profile_root() -> PathBuf {
    orgii_root().join("claude-code-cli-profiles")
}

/// Account-scoped Claude Code CLI config dir.
pub fn claude_code_cli_profile_dir(account_id: &str) -> PathBuf {
    claude_code_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped Codex CLI profile root: `~/.orgii/codex-cli-profiles/`.
pub fn codex_cli_profile_root() -> PathBuf {
    orgii_root().join("codex-cli-profiles")
}

/// Account-scoped Codex CLI profile dir.
pub fn codex_cli_profile_dir(account_id: &str) -> PathBuf {
    codex_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Session-scoped Codex CLI profile root for hosted-key sessions.
pub fn codex_hosted_cli_profile_root() -> PathBuf {
    orgii_root().join("codex-hosted-cli-profiles")
}

/// Session-scoped Codex CLI profile dir for one hosted-key session.
pub fn codex_hosted_cli_profile_dir(session_id: &str) -> PathBuf {
    codex_hosted_cli_profile_root().join(sanitize_path_segment(session_id))
}

/// Account-scoped Kiro CLI profile root: `~/.orgii/kiro-cli-profiles/`.
pub fn kiro_cli_profile_root() -> PathBuf {
    orgii_root().join("kiro-cli-profiles")
}

/// Account-scoped Kiro CLI HOME dir.
pub fn kiro_cli_profile_dir(account_id: &str) -> PathBuf {
    kiro_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped OpenCode CLI profile root: `~/.orgii/opencode-cli-profiles/`.
pub fn opencode_cli_profile_root() -> PathBuf {
    orgii_root().join("opencode-cli-profiles")
}

/// Account-scoped OpenCode CLI HOME dir.
pub fn opencode_cli_profile_dir(account_id: &str) -> PathBuf {
    opencode_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// CLI config manager profile root: `~/.orgii/cli-config-profiles/`.
///
/// Holds ORGII-managed backups and generated config profiles for external CLI
/// agents whose real user config may be switched between Default and
/// ORGII-managed modes.
pub fn cli_config_profiles_root() -> PathBuf {
    orgii_root().join("cli-config-profiles")
}

/// CLI config manager profile dir for one agent.
pub fn cli_config_profile_agent_dir(agent_name: &str) -> PathBuf {
    cli_config_profiles_root().join(sanitize_path_segment(agent_name))
}

/// Default/original CLI config backup dir for one agent.
pub fn cli_config_profile_default_dir(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("default")
}

/// ORGII-generated CLI config profile dir for one agent.
pub fn cli_config_profile_orgii_dir(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("orgii")
}

/// CLI config manager manifest path for one agent.
pub fn cli_config_profile_manifest(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("manifest.json")
}

/// Oversized tool result spill root: `~/.orgii/tool-results/`.
pub fn tool_results_root() -> PathBuf {
    orgii_root().join("tool-results")
}

/// Oversized tool result spill dir for one session.
pub fn tool_results_dir(session_id: &str) -> PathBuf {
    tool_results_root().join(session_id)
}

/// Agent worktrees root: `~/.orgii/agent-worktrees/`.
///
/// Each session worktree lives under
/// `agent-worktrees/{repo-hash}/{session-id}/`; the `git` crate's
/// `worktree::create_session_worktree` builds those leaves on top of
/// this root.
pub fn agent_worktrees_root() -> PathBuf {
    orgii_root().join("agent-worktrees")
}
