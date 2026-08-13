use serde::{Deserialize, Serialize};

use super::super::types::KeySource;
use super::super::types::SessionStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliSessionStatusSnapshot {
    pub session_id: String,
    pub status: SessionStatus,
    pub updated_at: String,
}

/// A code generation session record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSession {
    pub session_id: String,
    pub name: String,
    pub status: SessionStatus,
    pub flow: String,
    pub runner: String,
    /// The CLI agent type (e.g. "claude_code", "cursor_cli").
    pub cli_agent_type: Option<String>,
    pub model: Option<String>,
    pub tier: Option<String>,
    pub account_id: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub user_input: Option<String>,
    pub proxy_token: Option<String>,
    pub proxy_url: Option<String>,
    pub hosted_token: Option<String>,
    pub error_message: Option<String>,
    /// Computed sum of total_tokens from session_token_usage (per-round records).
    pub total_tokens: i64,
    pub pid: Option<i64>,
    pub cli_session_id: Option<String>,
    /// Proxy-side session ID (sess_xxx) for billing context and release.
    pub proxy_session_id: Option<String>,
    /// Worktree path for isolated parallel sessions.
    pub worktree_path: Option<String>,
    /// Branch name inside the worktree (e.g. `agent/abc123`).
    pub worktree_branch: Option<String>,
    /// Base branch the worktree was created from.
    pub base_branch: Option<String>,
    /// Merge status: pending, merged, conflict, skipped.
    pub merge_status: Option<String>,
    /// Whether this session was launched in "fire and forget" background mode.
    pub background: bool,
    /// Key source: own_key (BYOK) or hosted_key (market proxy).
    pub key_source: KeySource,
    /// Per-session execution mode. Mirrors `agent_sessions.agent_exec_mode`
    /// so CLI sessions can participate in the same Plan/Build UI and queue
    /// semantics as Rust-native agents.
    pub agent_exec_mode: Option<String>,
    /// Per-session unsent draft text. Mirror of the field on
    /// `agent_sessions`; written via `session_patch` from the chat
    /// composer. `None` means no draft.
    pub draft_text: Option<String>,
    /// Per-session reply target event id. Mirror of the field on
    /// `agent_sessions`. `None` means no reply banner is open.
    pub reply_target_event_id: Option<String>,
    /// Whether this session is pinned to the top of the sidebar.
    pub pinned: bool,
    /// Extra workspace folders granted at launch time (multi-root IDE
    /// workspaces). `None` or empty for single-repo launches. Stored as
    /// a JSON array of absolute paths; for `claude_code` and `codex`,
    /// each entry is forwarded as `--add-dir <path>` when the CLI is
    /// spawned.
    pub additional_directories: Option<Vec<String>>,
    pub parent_session_id: Option<String>,
    pub org_member_id: Option<String>,
    pub org_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    /// Where the transcript of record lives: `chunks` (legacy
    /// `code_session_chunks`) or `native` (the CLI's own store via the
    /// imported-history loaders). Frozen at creation time.
    pub transcript_source: String,
    /// Product-mode axis (orgtrack/v1 §5.2); `Some("project")` gates the
    /// WorkItem/Routine mutation surface, mirroring `agent_sessions`.
    pub product_mode: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHistoryMutation {
    pub session_id: String,
    pub epoch: i64,
    pub reason: String,
    pub mutated_at: String,
}

/// Parameters for creating a new code session.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCodeSessionParams {
    pub name: Option<String>,
    pub flow: Option<String>,
    pub runner: Option<String>,
    /// CLI agent type. Deserialized from the `platform` JSON key for wire compat.
    #[serde(rename = "platform")]
    pub cli_agent_type: String,
    pub model: Option<String>,
    pub tier: Option<String>,
    pub account_id: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    /// Existing registered linked worktree to reuse for execution.
    pub worktree_path: Option<String>,
    /// Git base ref used only when `isolate` creates a fresh worktree.
    pub worktree_base_ref: Option<String>,
    pub proxy_token: Option<String>,
    pub proxy_url: Option<String>,
    pub hosted_token: Option<String>,
    /// Proxy-side session ID (sess_xxx) for billing context and release.
    pub proxy_session_id: Option<String>,
    /// Request worktree isolation for parallel execution.
    #[serde(default)]
    pub isolate: Option<bool>,
    /// Launch in background mode ("fire and forget" with completion notification).
    #[serde(default)]
    pub background: Option<bool>,
    /// Key source: "own_key" (BYOK) or "hosted_key" (market proxy).
    /// Defaults to "own_key" if not provided.
    pub key_source: Option<String>,
    /// Extra workspace folders granted at launch time (multi-root IDE
    /// workspaces). Empty / omitted for single-repo launches; for
    /// `claude_code` / `codex` each entry is forwarded as `--add-dir`.
    #[serde(default)]
    pub additional_directories: Option<Vec<String>>,
    pub parent_session_id: Option<String>,
    pub org_member_id: Option<String>,
    pub org_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    /// Product-mode axis (orgtrack/v1 §5.2); `Some("project")` gates the
    /// WorkItem/Routine mutation surface, mirroring `agent_sessions`.
    pub product_mode: Option<String>,
}
