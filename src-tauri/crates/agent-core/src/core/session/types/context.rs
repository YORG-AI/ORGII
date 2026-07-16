//! Processing context and result types, IDE context, system prompt builder.

use serde::{Deserialize, Serialize};

use super::enums::AgentExecMode;
use crate::core::session::workspace::SessionWorkspace;

// ============================================
// Processing Context
// ============================================

/// Context passed to message processing.
///
/// Contains optional type-specific data that affects how the message
/// is processed.
#[derive(Debug, Clone, Default)]
pub struct ProcessingContext {
    /// Images attached to the message.
    pub images: Option<Vec<String>>,
    /// Whether this call is a user-initiated "Resume" after an earlier
    /// failed turn. When true, the processor uses deletion-based
    /// orphan `tool_use` filtering instead of the injection-based
    /// `repair_interrupted_history` used for crash recovery — the user
    /// is sending a fresh prompt, so we must not inject a synthetic
    /// continuation user message that would duplicate theirs.
    pub is_resume: bool,
    /// Pill-format display text from the frontend composer (e.g.
    /// `"create-skill [skill:/create-skill]"`). When present, stored as
    /// the event's `display_text` so editing a historical message
    /// re-populates the pill rather than the expanded YAML content.
    pub display_text: Option<String>,
    /// Stable logical turn id assigned by `AgentSession::begin_turn`.
    pub turn_id: Option<String>,
    /// Canonical user-intent id. One per "user wants the agent to take a
    /// turn now" event — minted at the user-intent boundary (ChatPanel
    /// submit, queue enqueue, force-send, resume, mobile-remote,
    /// agent-org inbox) and propagated through the wire layer, scheduler,
    /// and persisted user_message events so the turn indexer can collapse
    /// synthetic + backend rows that share the same intent. Defaults to
    /// an empty string only on the rare turn paths that intentionally
    /// skip user-message persistence (resume with empty content); every
    /// persistence call site treats an empty id as "no canonical id
    /// available, fall back to per-row identity".
    pub turn_intent_id: String,
}

/// Behavior stance — the closed set of runtime semantics a presence mode
/// maps to. The mode itself (id + label + guidance) is open-ended data
/// authored by the user; the stance is one of three code-defined behavior
/// classes. New custom modes pick a stance; new stances require code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStance {
    /// User at the keyboard — ask freely, confirm destructive actions,
    /// blocking interactions wait indefinitely.
    Interactive,
    /// User stepped away — work first, batch questions, hold
    /// irreversible actions until they're back.
    DeferAndBatch,
    /// Goal mode — never ask, auto-resolve blockers, keep working until
    /// the goal is met.
    Autonomous,
}

impl Default for PresenceStance {
    fn default() -> Self {
        PresenceStance::Interactive
    }
}

impl PresenceStance {
    pub fn as_str(&self) -> &'static str {
        match self {
            PresenceStance::Interactive => "interactive",
            PresenceStance::DeferAndBatch => "defer_and_batch",
            PresenceStance::Autonomous => "autonomous",
        }
    }
}

/// Well-known built-in mode ids. Custom modes use `role:<slug>`.
pub mod presence_mode_ids {
    pub const ONLINE: &str = "online";
    pub const INVISIBLE: &str = "invisible";
    pub const AWAY: &str = "away";
}

/// Snapshot of the user's current presence — set in the sidebar, shipped
/// with every turn so the agent knows whether the human is watching.
///
/// The frontend resolves the active mode's full spec (label + guidance +
/// stance + policy numbers) before sending, so the backend never needs to
/// know about settings or custom-role storage. Old wire payloads that
/// carry only `mode` still deserialize — [`crate::interaction::presence_policy::PresencePolicy::resolve`]
/// derives built-in defaults for the missing fields.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserPresence {
    /// Mode id: `online` / `invisible` / `away` / `role:<slug>`.
    pub mode: String,
    /// Display label of the mode ("Online", "Angry", …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// ISO-8601 timestamp the user expects to be back (only meaningful for
    /// `away`). Omitted when there is no scheduled return.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub back_at: Option<String>,
    /// Optional per-mode prompt addendum the user configured in Settings →
    /// My Role. When present, the agent should treat this as authoritative
    /// guidance for the current presence mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    /// Runtime behavior class. `None` on old wire payloads — resolved from
    /// the mode id's built-in defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stance: Option<PresenceStance>,
    /// Seconds until pending `ask_user_questions` batches auto-skip. 0 = off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_auto_resolve_secs: Option<u32>,
    /// Seconds until pending plan approvals auto-approve. 0 = off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_auto_approve_secs: Option<u32>,
    /// Whether pending mode-switch suggestions auto-switch to Plan on timeout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_switch_auto_plan: Option<bool>,
    /// Goal continuation loop budget (Ralph loop). 0 = disabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_max_turns: Option<u32>,
}

impl UserPresence {
    /// Display label with fallback to the raw mode id.
    pub fn display_label(&self) -> &str {
        self.label.as_deref().unwrap_or(self.mode.as_str())
    }
}

/// Snapshot of the user's self-described profile from Settings → My Role.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tech_savvy: Option<String>,
    #[serde(default)]
    pub job_roles: Vec<String>,
    #[serde(default)]
    pub familiar_tech_stacks: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Unified IDE context for all agent sessions.
///
/// Used by SDE sessions (coding context: open files, git, linter) and
/// OS sessions (active repo, branch). Callers populate only the fields
/// they care about; everything defaults to `None` / empty.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdeContext {
    // ── SDE fields ──
    /// Currently open file paths.
    #[serde(default)]
    pub open_files: Vec<String>,
    /// Path of the active/focused file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_file: Option<String>,
    /// Selected text in the editor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Cursor position — either "file:line:col" string or (line, col) tuple.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_position: Option<String>,
    /// Visible range in the editor (start_line, end_line).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_range: Option<(u32, u32)>,
    /// Terminal output/context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_context: Option<String>,
    /// Lint/diagnostic errors from LSP.
    #[serde(default)]
    pub linter_errors: Vec<String>,
    /// Current git branch name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Summary of git status (e.g. "3 modified, 1 untracked").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<String>,
    /// Changed file paths with status.
    #[serde(default)]
    pub git_changed_files: Vec<String>,
    /// All workspace folder root paths (multi-root workspace support).
    #[serde(default)]
    pub workspace_folders: Vec<String>,

    // ── OS fields ──
    /// Active repository path in the IDE.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// Repository name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,

    // ── Ambient user state ──
    /// QQ-style presence signal. Travels with `IdeContext` because both
    /// values flow through the same session-message argument and share a
    /// wire-level container, but is surfaced in the system prompt via its
    /// own dedicated section so it isn't gated on IDE-only paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_presence: Option<UserPresence>,
    /// User profile preferences and background from Settings → My Role.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_profile: Option<UserProfile>,
}

// ============================================
// Processing Result
// ============================================

/// Result from processing a message.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingResult {
    /// Stable ID of the dialog turn that produced this result.
    ///
    /// Frontend uses this to correlate `agent:complete` events with the
    /// specific turn that triggered them, enabling precise cancel/retry UX.
    pub turn_id: String,
    /// The assistant's response content.
    pub content: String,
    /// Total tokens used (prompt + completion).
    pub total_tokens: i64,
    /// Prompt tokens used.
    pub prompt_tokens: i64,
    /// Completion tokens generated.
    pub completion_tokens: i64,
    /// Number of tool calls made.
    pub tool_calls_count: u32,
    /// Whether the response was truncated.
    #[serde(default)]
    pub truncated: bool,
    /// Deprecated legacy turn completion summary. New Rust turns no longer populate this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_summary: Option<String>,
    /// Signals that compact-fork took effect during this call.
    /// When `Some(new_sid)`, the caller (message_pipeline / dispatch) must
    /// abort this result and re-dispatch the original inbound message
    /// against `new_sid`. The fork primitive has already persisted the
    /// compacted transcript, archived the old session, and rebound the
    /// chat's gateway binding — no further cleanup is required from the
    /// caller side. `None` for non-channel sessions or when the compact
    /// path stayed in-place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_redirect: Option<String>,
}

// ============================================
// Tool Summary
// ============================================

/// A single tool summary entry (name + short description).
///
/// Used by system prompt builders to describe available tools.
pub struct ToolSummary {
    pub name: String,
    pub description: String,
}

/// Configuration passed to the system-prompt builder so it can produce
/// the correct prompt without knowing about processor internals.
#[derive(Debug, Clone, Default)]
pub struct SystemPromptConfig {
    pub model: String,
    pub agent_id: String,
    pub agent_definition_id: Option<String>,
    /// The session's single resolved skills view (enabled flag, include
    /// whitelist, disabled union, extra source dirs). Replaces the three
    /// parallel fields (`skills_enabled` / `disabled_skills` /
    /// `agent_skills_config`) that could disagree.
    pub skills: crate::definitions::SkillsParams,
    pub load_workspace_resources: bool,
    pub load_workspace_rules: bool,
    pub agent_soul: Option<String>,
    pub workspace: Option<SessionWorkspace>,
    pub channel: Option<String>,
    pub chat_id: Option<String>,
    pub agent_mode: Option<AgentExecMode>,
    pub ide_context: Option<IdeContext>,
    /// User presence snapshot (online / invisible / away). Plumbed out
    /// of [`IdeContext::user_presence`] at prompt-build time so the
    /// dedicated [`crate::session::prompt::sections::UserPresenceSection`]
    /// can render it without the IDE-context gate.
    pub user_presence: Option<UserPresence>,
    /// User profile snapshot for calibrating explanations and examples.
    pub user_profile: Option<UserProfile>,
    pub agent_org_context: Option<crate::coordination::agent_org_runs::AgentOrgRunContext>,
    pub agent_org_current_member_id: Option<String>,
    /// When `true`, the unified prompt builder injects ONLY the
    /// `agent_soul` identity + a minimal frame (system meta, available
    /// tools, rules from `.orgii/`, L3 learnings) and skips every other
    /// "default" section (channel/SDE behavioral rules, runtime line,
    /// sub-agent delegation, command approval, model-identity, etc.).
    /// Mirrors `AgentDefinition.sovereign_prompt`.
    pub sovereign_prompt: bool,
}
