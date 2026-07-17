//! Type definitions for cross-system session aggregation.
//!
//! Contains the unified record types, filter options, statistics structures,
//! and response types used across the session aggregation API.

use serde::{Deserialize, Serialize};

use core_types::key_source::KeySource;
use orgtrack_core::sources::imported_history::ImportedHistorySidebarRow;

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
// Filter Types
// ============================================================================

/// Filter options for session listing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    /// Return only these canonical session IDs. Used by deep-link surfaces
    /// that must hydrate an older row without walking sidebar pagination.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
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
    /// Filter imported external history rows by source subtype.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_history_source: Option<String>,
    /// External history sources the user has disabled — skipped entirely when
    /// loading imported history so their sessions never surface (no disk read).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_external_history_sources: Option<Vec<String>>,
    /// Only include sessions created at or after this epoch millisecond.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after_ms: Option<i64>,
    /// Only include sessions created at or before this epoch millisecond.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_before_ms: Option<i64>,
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
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalHistorySidebarDateBucket {
    Today,
    Yesterday,
    ThisWeek,
    Older,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySidebarBucketRequest {
    pub bucket: ExternalHistorySidebarDateBucket,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySidebarSourceRequest {
    pub source: String,
    pub buckets: Vec<ExternalHistorySidebarBucketRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySidebarBucketPage {
    pub bucket: ExternalHistorySidebarDateBucket,
    pub sessions: Vec<ImportedHistorySidebarRow>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySidebarResponse {
    pub source: String,
    pub buckets: Vec<ExternalHistorySidebarBucketPage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistorySidebarBatchResponse {
    pub sources: Vec<ExternalHistorySidebarResponse>,
}

