//! Typed enums and constants for code sessions.
//!
//! All domain values that were previously scattered as string literals
//! are centralized here. This prevents typos, enables exhaustive matching,
//! and gives the compiler the ability to catch invalid states.

use std::fmt;

use serde::{Deserialize, Serialize};

// ============================================
// Session Status
// ============================================

/// Lifecycle states for a code session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Pending,
    Running,
    /// Session is idle — waiting for the next dispatch (non-terminal).
    /// Used for Agent Org member sessions after each successful turn so
    /// `reconcile_if_terminal` does not prematurely end the run.
    Idle,
    Completed,
    Failed,
    Cancelled,
}

impl SessionStatus {
    /// Parse from a DB/JSON string. Returns `None` for unrecognized values.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "idle" => Some(Self::Idle),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// Whether this status is a terminal state (no further transitions expected).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Whether the session can be resumed from this status.
    pub fn is_resumable(self) -> bool {
        matches!(self, Self::Running | Self::Failed | Self::Pending)
    }
}

impl fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Idle => "idle",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        };
        f.write_str(value)
    }
}

impl AsRef<str> for SessionStatus {
    fn as_ref(&self) -> &str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Idle => "idle",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

// ============================================
// Session Runner
// ============================================

/// Who/what executes the code session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRunner {
    /// Local CLI agent running on this machine.
    Local,
    /// Interactive TUI hosted in an app terminal pane. The session row
    /// carries orchestration metadata (worktree, attribution) but no managed
    /// child process — `session_runner` never spawns for it; status comes
    /// from lifecycle hooks (`orgtrack::agent_live_status`).
    Tui,
}

impl SessionRunner {
    /// Parses from a wire/DB string. Returns `None` for unknown values
    /// instead of silently coercing them to `Local`. The previous
    /// `_ => Self::Local` catch-all was a fake fallback (the enum has
    /// only one variant today, so it was tautologically correct), but
    /// adding a second variant later would have turned it into a silent
    /// footgun: a remote runner string would have read back as `Local`,
    /// dispatching the session against the wrong execution backend.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "tui" => Some(Self::Tui),
            _ => None,
        }
    }
}

impl fmt::Display for SessionRunner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_ref())
    }
}

impl AsRef<str> for SessionRunner {
    fn as_ref(&self) -> &str {
        match self {
            Self::Local => "local",
            Self::Tui => "tui",
        }
    }
}

// ============================================
// Session flow (stored column)
// ============================================

/// Default `flow` column value when the client omits `flow` on create.
pub const DEFAULT_CODE_SESSION_FLOW: &str = "quick";

// ============================================
// Default Session Name
// ============================================

/// Default names for sessions when no user input is available.
pub mod session_defaults {
    /// Default name for code sessions.
    pub const CODE_SESSION_NAME: &str = "Code Session";
    /// Maximum length for session names derived from user input.
    pub const MAX_NAME_LENGTH: usize = 80;
}

// ============================================
// Key Source
// ============================================

pub const PERSONAL_ORG_ID: &str = project_management::projects::types::PERSONAL_ORG_ID;

pub use core_types::key_source::KeySource;

// Proxy environment variable name constants moved to `core_types::proxy_env`
// (shared between agent_sessions::cli — which sets them on child processes —
// and integrations::proxy — which is the server registering them).
pub use core_types::proxy_env;

#[cfg(test)]
#[path = "tests/types_tests.rs"]
mod tests;
