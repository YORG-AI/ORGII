//! User interaction during agent execution.
//!
//! This module handles blocking user prompts. Requests are broadcast to the
//! frontend via `broadcast_event` (Tauri IPC Channel for local sessions) and
//! responses arrive via Tauri commands that resolve a one-shot channel:
//! - [`permission`]: Tool permission requests (ask / allow / deny)
//! - [`permission_rules`]: Persistent permission rules with pattern matching
//! - [`question`]: Structured user questions during agent runs
//! - [`mode_switch`]: Mode switching confirmation (code / plan / debug)
//! - [`finalize`]: Shared primitives — cancel-aware waits with an optional
//!   auto-timeout policy, plus authoritative `agent:interaction_finalized`
//!   emission so the UI flips to "answered" at the moment the user clicks.
//!
//! # Migration status
//!
//! All three managers (`question`, `permission`, `mode_switch`) use the
//! shared finalize pattern:
//!   * They observe the session `cancel_flag` so the Stop button interrupts a
//!     pending wait.
//!   * They emit `agent:interaction_finalized` at user-action time so the UI
//!     flips immediately without waiting for the tool's `agent:tool_result`.
//!
//! `suggest_mode_switch` auto-skips after its timeout so the agent continues
//! in the current mode. Question and permission prompts still report timeout
//! explicitly.

pub mod finalize;
pub mod mode_switch;
pub mod permission;
pub mod permission_rules;
pub mod plan_approval;
pub mod presence_policy;
pub mod presence_state;
pub mod profile_state;
pub mod question;
pub mod secret_broker;

// No flat re-exports — every caller reaches into the explicit submodule
// (`interaction::permission::*`, `interaction::mode_switch::*`,
// `interaction::question::*`, `interaction::plan_approval::*`,
// `interaction::finalize::*`), so flattening anything here would be dead
// surface.
