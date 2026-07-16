//! Type definitions for cross-system session aggregation.
//!
//! Contains the unified record types, filter options, statistics structures,
//! and response types used across the session aggregation API.

use serde::{Deserialize, Serialize};

use core_types::key_source::KeySource;

// ============================================================================
// Core Types
// ============================================================================

/// One row in the cross-system session list (merged view for the frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAggregateRecord {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    /// Session category: "cli", "agent" (Coding), or "os"
    pub category: SessionCategory,
    /// Imported external-history source subtype, when this row comes from an external DB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_history_source: Option<String>,
    /// User input / task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
    /// Repository path (CLI sessions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// Path to the file or directory where this session's persisted data lives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    /// Repository name (derived from path)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    /// Git branch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// LLM model used
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Code account ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// CLI agent type (cursor_cli, claude_code, codex, etc.)
    #[serde(rename = "cliAgentType", skip_serializing_if = "Option::is_none")]
    pub cli_agent_type: Option<String>,
    /// Key source: own_key or hosted_key
    pub key_source: KeySource,
    /// Price tier for market sessions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// Process ID if running
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    /// Total tokens used
    #[serde(default)]
    pub total_tokens: i64,
    /// Worktree path for isolated sessions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Branch inside the worktree
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// Base branch the worktree was created from
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// Merge status: pending, merged, conflict, skipped
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_status: Option<String>,
    /// Whether this session runs in background mode
    #[serde(default)]
    pub background: bool,
    /// Owning project/collaboration org ID for this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Linked project ID, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Linked project display name, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// Linked project slug, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    /// Linked work item short ID, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    /// Work item agent role, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    /// Whether this session is currently active (running, pending, etc.)
    pub is_active: bool,
    /// Display label for UI (truncated name or user_input, pill references stripped)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
    /// Parent/root session id for child sessions such as Agent Org member sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Agent Org roster member id for org member session rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_member_id: Option<String>,
    /// Agent Org definition id for root/coordinator rows launched from an org.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_org_id: Option<String>,
    /// Agent Org display name for root/coordinator rows launched from an org.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_org_name: Option<String>,
    /// Agent definition ID for Rust-native sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_definition_id: Option<String>,
    /// Agent icon ID resolved by Rust from the agent definition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_icon_id: Option<String>,
    /// Agent display name resolved by Rust from the agent definition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_display_name: Option<String>,
    /// Per-session execution mode for Rust-native and CLI agent sessions.
    ///
    /// `None` means the user has never explicitly set a mode for this
    /// session — frontend `ModePill` falls back to
    /// `creatorDefaultExecModeAtom` until the first `session_patch`
    /// commits a value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_exec_mode: Option<String>,
    /// Per-session unsent draft text. The contents the user has
    /// typed into the chat composer for this session but not yet sent.
    /// Persisted across navigation and app restarts. `None` means "no
    /// draft" — the composer renders empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_text: Option<String>,
    /// Per-session reply target event id. The agent_messages /
    /// chunk id the user has currently pinned via the chat item's
    /// "Reply" action. `None` means no reply banner is open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_target_event_id: Option<String>,
    /// Whether this session is pinned to the top of the sidebar.
    #[serde(default)]
    pub pinned: bool,

    /// Source-impact files touched by this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<i64>,
    /// Source-impact added lines when cheaply available from tool metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<i64>,
    /// Source-impact removed lines when cheaply available from tool metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<i64>,
    /// Source-impact touched file paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub touched_files: Option<Vec<String>>,
    /// Channel origin for OS Agent sessions (e.g. "feishu", "telegram", "discord").
    /// `None` for non-channel sessions (CLI, SDE, local GUI OS Agent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

/// Session category enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCategory {
    /// CLI agent session (Cursor, Claude Code, Codex, etc.)
    Cli,
    /// SDE Agent session (built-in SDE Agent)
    Agent,
    /// OS Agent session (external channels)
    Os,
}

impl SessionCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Agent => "agent",
            Self::Os => "os",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "cli" => Ok(Self::Cli),
            "agent" => Ok(Self::Agent),
            "os" => Ok(Self::Os),
            other => Err(format!("Unknown session category: {other}")),
        }
    }
}

// ============================================================================
// Statistics Types
// ============================================================================

/// Session statistics summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub total: usize,
    /// Active sessions: idle, running, waiting_for_user, waiting_for_funds, paused
    pub active: usize,
    /// Completed sessions
    pub completed: usize,
    /// Failed sessions: failed, cancelled, abandoned, timeout
    pub failed: usize,
    /// Sessions by category
    pub by_category: CategoryStats,
    /// Sessions by key source
    pub by_key_source: KeySourceStats,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStats {
    pub cli: usize,
    pub agent: usize,
    pub os: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySourceStats {
    pub own_key: usize,
    pub hosted_key: usize,
}

/// Aggregate statistics for market/billing analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateStats {
    /// Total cost in USD (estimated from tokens)
    pub total_cost_usd: f64,
    /// Total input tokens
    pub total_tokens_input: i64,
    /// Total output tokens
    pub total_tokens_output: i64,
    /// Total tokens (combined)
    pub total_tokens: i64,
    /// Count of ongoing sessions
    pub ongoing_count: usize,
    /// Count of completed sessions
    pub completed_count: usize,
    /// Count of failed sessions
    pub failed_count: usize,
}

// ============================================================================
// Filter Types
// ============================================================================

/// Filter options for session listing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    /// Filter by category: "cli", "agent", "os"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Filter by status (comma-separated for multiple)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Filter by key source: "own_key", "hosted_key"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_source: Option<String>,
    /// Filter by repo path prefix
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// Filter by owning project/collaboration org ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Filter by linked project slug
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    /// Filter by linked work item short ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    /// Maximum number of sessions to return
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Skip first N sessions (for pagination)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    /// Text search query (searches name, user_input, repo_name — case-insensitive)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_query: Option<String>,
    /// Sort field: "updated_at", "created_at", "name" (default: "updated_at")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    /// Sort order: "asc" or "desc" (default: "desc")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<String>,
    /// Include imported external history rows when loading CLI-category sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_external_history: Option<bool>,
    /// Include aggregate stats in the response. Defaults to true for existing callers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_stats: Option<bool>,
    /// Filter imported external history rows by source subtype.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_history_source: Option<String>,
    /// Only include sessions created at or after this epoch millisecond.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after_ms: Option<i64>,
    /// Only include sessions created at or before this epoch millisecond.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_before_ms: Option<i64>,
    #[serde(skip)]
    pub skip_orgtrack_upsert: bool,
    /// Only return active (ongoing) sessions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_only: Option<bool>,
}

// ============================================================================
// Response Types
// ============================================================================

/// Response from session_aggregate_list command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResponse {
    pub sessions: Vec<SessionAggregateRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<SessionStats>,
}

// ============================================================================
// Health Types
// ============================================================================

/// Session health status for stale detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealthStatus {
    pub is_in_progress: bool,
    pub is_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
}

// ============================================================================
// History Types
// ============================================================================

/// History session record — matches frontend's ApiSessionData shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionRecord {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub repo_name: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub model: Option<String>,
    pub total_tokens: i64,
    pub added_lines: i64,
    pub deleted_lines: i64,
    pub pr_link: Option<String>,
    pub is_active: bool,
    pub category: SessionCategory,
}

/// History metrics — aggregate statistics for the history page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryMetrics {
    pub total_sessions: usize,
    pub total_tokens: i64,
    pub total_added_lines: i64,
    pub total_deleted_lines: i64,
    pub starred_count: usize,
    pub ongoing_count: usize,
    pub completed_count: usize,
}

/// Response from session_get_history command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResponse {
    pub sessions: Vec<HistorySessionRecord>,
    pub metrics: SessionHistoryMetrics,
}

// ============================================================================
// Usage History Types
// ============================================================================

/// Filter for the session_usage_list command (Dev Record > Sessions tab).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFilter {
    /// ISO date "YYYY-MM-DD" — include sessions on or after this date
    pub start_date: Option<String>,
    /// ISO date "YYYY-MM-DD" — include sessions on or before this date
    pub end_date: Option<String>,
    /// cli_agent_type or agent variant to filter by (e.g. "cursor_cli", "sde_agent")
    pub provider: Option<String>,
}

/// One row in the usage history list.
///
/// Mirrors the frontend `UsageItem` shape (minus the `dayjs` wrapper).
/// Returned by `session_usage_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub name: String,
    /// "local" (own_key) or "pooling" (hosted_key)
    pub source: String,
    /// cli_agent_type or "sde_agent" / "os_agent"
    pub provider: String,
    pub model: String,
    pub tokens: i64,
    pub cost: f64,
    pub status: String,
    pub created_at: String,
}
