//! Session ID prefixes and pure-data filter shapes shared across all
//! agent subsystems.
//!
//! Frontend mirrors these in `src/util/session/sessionCategory.ts`.

/// OS Agent (workspace-isolated subagent host) sessions.
pub const OS_SESSION_PREFIX: &str = "osagent-";

/// SDE Agent (software-development-engineer) sessions.
pub const SDE_SESSION_PREFIX: &str = "sdeagent-";

/// DS Agent (data scientist) sessions.
pub const DS_SESSION_PREFIX: &str = "dsagent-";

/// CLI agent sessions (Cursor, Claude Code, Codex, …).
pub const CLI_SESSION_PREFIX: &str = "cliagent-";

/// Wingman (single-tab assistant) sessions.
pub const WINGMAN_SESSION_PREFIX: &str = "wingman-";

/// Subagent (delegate-mode) session ID prefix.
///
/// Used by the unified `agent` tool when launching a child agent. The full
/// shape is `agent-<agent_id>-<uuid>` (see
/// `core/tools/impls/orchestration/agent/helpers.rs::looks_like_valid_subagent_session_id`).
pub const SUBAGENT_SESSION_PREFIX: &str = "agent-";

/// Shadow (clone-of-parent) subagent session ID prefix.
///
/// Used by the unified `agent` tool when `mode = "shadow"`. The full
/// shape is `shadow-<agent_id>-<uuid>`.
pub const SHADOW_SUBAGENT_SESSION_PREFIX: &str = "shadow-";

/// Placeholder session ID used before the real session ID is generated.
pub const PENDING_SESSION_PLACEHOLDER: &str = "pending";

// ── List filter ──────────────────────────────────────────────────────

/// Filter criteria for `list_sessions()` DB queries.
///
/// Pure data; lives in `core_types` so non-`agent_core` crates (e.g.
/// `project_management`'s orchestrator recovery) can construct one
/// without forming a reverse dependency on `agent_core`. The
/// `agent_core::session::SessionListFilter` symbol re-exports this type.
///
/// `status` is stored as the wire/DB string (e.g. `"running"`,
/// `"archived"`) — `agent_core` parses it back into its typed
/// `SessionStatus` enum at the SQL boundary. Keeping the typed enum out
/// of `core_types` avoids dragging the larger `SessionStatus` surface
/// (with its impls keyed on `agent_core::persistence::db_helpers`)
/// down into the shared crate.
///
/// Not to be confused with `unified_stats::SessionFilter`, which is the
/// richer frontend-facing filter (sorting, text search, key source, etc.).
#[derive(Debug, Clone, Default)]
pub struct SessionListFilter {
    /// Filter by session type name ("os", "sde", "custom").
    pub type_name: Option<String>,
    /// Filter by status — wire/DB string form (e.g. `"running"`).
    pub status: Option<String>,
    /// Filter by channel (OS sessions only).
    pub channel: Option<String>,
    /// Filter by workspace path prefix (SDE sessions only).
    pub workspace_path_prefix: Option<String>,
    /// Maximum number of results.
    pub limit: Option<usize>,
    /// Offset for pagination.
    pub offset: Option<usize>,
}
