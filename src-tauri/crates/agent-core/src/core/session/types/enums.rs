//! Session enums — SessionStatus, AgentExecMode.

use serde::{Deserialize, Serialize};

// ============================================
// Session Status
// ============================================

/// Current status of an agent session (application level).
///
/// This is the full-fidelity status used by the application layer for:
/// - UI display
/// - Session lifecycle management
/// - Frontend state synchronization
///
/// ## Relationship with `AgentSessionStatus`
///
/// The `AgentSessionStatus` in `persistence::db_helpers` is a simplified subset
/// (5 states vs 11 here) used for database storage. This design:
/// - Reduces DB schema complexity
/// - Maps detailed states (Pending, WaitingForUser, etc.) to coarser DB states
/// - Allows application-level state transitions without DB migrations
///
/// When persisting, application code should map this to `AgentSessionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Session is pending, not yet started.
    Pending,
    /// Session is idle, waiting for input (default state after completion).
    #[default]
    Idle,
    /// Session is actively processing a message.
    Running,
    /// Session is waiting for user input (question/permission).
    WaitingForUser,
    /// Session is waiting for funds (billing pause).
    WaitingForFunds,
    /// Session is paused by user.
    Paused,
    /// Session completed its last task successfully.
    Completed,
    /// Session failed with an error.
    Failed,
    /// Session was cancelled by user.
    Cancelled,
    /// Session was abandoned (disconnected/timeout without explicit cancel).
    Abandoned,
    /// Session timed out.
    Timeout,
    /// Session was archived by an idle-reset or compact-fork
    ///. Content is preserved but the session is hidden
    /// from normal list views. Hermes parallel: `db.end_session(..., "session_reset")`
    /// in `gateway/session.py:761`.
    Archived,
}

impl SessionStatus {
    /// States that mean a turn or user-owned interaction is still in flight.
    /// Startup cleanup and terminal-marker reconciliation must use this one
    /// typed set so a future waiting state cannot drift between paths.
    pub const IN_FLIGHT: [Self; 3] = [Self::Running, Self::WaitingForUser, Self::WaitingForFunds];

    /// Persisted states from which an Agent Org background Wake may start a
    /// fresh Rust turn. Paused/Pending/active/Archived are deliberately absent.
    pub const AGENT_ORG_WAKEABLE: [Self; 6] = [
        Self::Idle,
        Self::Completed,
        Self::Failed,
        Self::Cancelled,
        Self::Abandoned,
        Self::Timeout,
    ];

    /// Returns the string representation for database storage.
    pub const fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Pending => "pending",
            SessionStatus::Idle => "idle",
            SessionStatus::Running => "running",
            SessionStatus::WaitingForUser => "waiting_for_user",
            SessionStatus::WaitingForFunds => "waiting_for_funds",
            SessionStatus::Paused => "paused",
            SessionStatus::Completed => "completed",
            SessionStatus::Failed => "failed",
            SessionStatus::Cancelled => "cancelled",
            SessionStatus::Abandoned => "abandoned",
            SessionStatus::Timeout => "timeout",
            SessionStatus::Archived => "archived",
        }
    }

    /// Parses from database / wire string.
    ///
    /// Returns `None` for unknown variants. Callers MUST decide whether to
    /// reject the input (frontend wire payload, DB column read) or fall
    /// back to a documented default — the previous catch-all that mapped
    /// any unknown status to `Idle` made stuck-state rows invisible (a row
    /// stuck in a malformed terminal state would silently look idle).
    pub fn parse(status: &str) -> Option<Self> {
        match status {
            "pending" => Some(SessionStatus::Pending),
            "idle" => Some(SessionStatus::Idle),
            "running" => Some(SessionStatus::Running),
            "waiting_for_user" => Some(SessionStatus::WaitingForUser),
            "waiting_for_funds" => Some(SessionStatus::WaitingForFunds),
            "paused" => Some(SessionStatus::Paused),
            "completed" => Some(SessionStatus::Completed),
            "failed" => Some(SessionStatus::Failed),
            "cancelled" => Some(SessionStatus::Cancelled),
            "abandoned" => Some(SessionStatus::Abandoned),
            "timeout" => Some(SessionStatus::Timeout),
            "archived" => Some(SessionStatus::Archived),
            _ => None,
        }
    }

    /// Returns true if this is a terminal state (session won't change further).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            SessionStatus::Completed
                | SessionStatus::Failed
                | SessionStatus::Cancelled
                | SessionStatus::Abandoned
                | SessionStatus::Timeout
                | SessionStatus::Archived
        )
    }

    /// Returns true if the session is actively working.
    pub fn is_active(&self) -> bool {
        matches!(self, SessionStatus::Running)
    }

    pub fn is_in_flight(self) -> bool {
        Self::IN_FLIGHT.contains(&self)
    }

    pub fn is_agent_org_wakeable(self) -> bool {
        Self::AGENT_ORG_WAKEABLE.contains(&self)
    }
}

/// Lift the simplified DB-level `AgentSessionStatus` into the
/// application-level `SessionStatus`. Direct enum mapping replaces the
/// previous `parse_str(final_status.as_ref())` round-trip, which was
/// statically guaranteed to hit one of the five known strings but
/// relied on a catch-all `_ => Idle` arm to stay sound. With the
/// catch-all retired, the conversion is now a typed total function.
impl From<crate::persistence::db_helpers::AgentSessionStatus> for SessionStatus {
    fn from(value: crate::persistence::db_helpers::AgentSessionStatus) -> Self {
        use crate::persistence::db_helpers::AgentSessionStatus as Db;
        match value {
            Db::Idle => SessionStatus::Idle,
            Db::Running => SessionStatus::Running,
            Db::Completed => SessionStatus::Completed,
            Db::Failed => SessionStatus::Failed,
            Db::Cancelled => SessionStatus::Cancelled,
        }
    }
}

// ============================================
// Agent Mode (SDE)
// ============================================

/// Agent operating mode — affects system prompt and tool availability.
///
/// This is the canonical mode enum used across the entire session layer.
///
/// User-facing picker surfaces three variants: `Build`, `Ask`, and `Plan`.
/// `Debug`, `Review`, and `Wingman` remain valid internal modes hidden from
/// the picker.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentExecMode {
    /// Default coding mode — full tool access.
    #[default]
    Build,
    /// Ask mode — read-only research / Q&A.
    Ask,
    /// Planning mode — read-only, produces a persisted plan file gated by user approval.
    Plan,
    /// Debug mode — focused on diagnostics and root-cause analysis.
    Debug,
    /// Code review mode — read code + git diff, produce review verdict (internal).
    Review,
    /// Wingman mode — passive observer that watches the screen on a timer, surfaces
    /// proactive nudges as overlay notifications, and can hand off to Build on request.
    Wingman,
}

impl AgentExecMode {
    /// Returns the string representation for database/API.
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentExecMode::Build => "build",
            AgentExecMode::Ask => "ask",
            AgentExecMode::Plan => "plan",
            AgentExecMode::Debug => "debug",
            AgentExecMode::Review => "review",
            AgentExecMode::Wingman => "wingman",
        }
    }

    /// Parses from a wire/DB string (case-insensitive on the input side;
    /// the canonical form is lowercase).
    ///
    /// Returns `None` for unknown variants. The previous catch-all that
    /// silently mapped any unrecognised mode to `Build` is a safety
    /// reversal: `Plan` / `Ask` / `Review` are read-only modes, and a typo
    /// in the wire payload would silently re-enable write tools. Callers
    /// must reject unknown modes instead.
    pub fn parse(mode: &str) -> Option<Self> {
        match mode.to_lowercase().as_str() {
            "build" => Some(AgentExecMode::Build),
            "ask" => Some(AgentExecMode::Ask),
            "plan" => Some(AgentExecMode::Plan),
            "debug" => Some(AgentExecMode::Debug),
            "review" => Some(AgentExecMode::Review),
            "wingman" => Some(AgentExecMode::Wingman),
            _ => None,
        }
    }
}
