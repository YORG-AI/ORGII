//! Agent orchestration tools — Delegate/Shadow dispatch, session lifecycle, and
//! interactive controls that block the parent turn waiting for the user.
//!
//! - [`agent`]       — Delegate/Shadow worker invocation (`agent` tool modes)
//! - [`agent_org`]   — Agent Org persistent coordination sub-system:
//!   - [`agent_org::send_message`] — typed org messaging
//!   - [`agent_org::tasks`]   — `task_graph_create` / `task_create` / `task_update` / `task_list` / `task_get`
//! - [`ask_user_questions`]   — `ask_user_questions` (structured Q&A, blocks until user answers)
//! - [`channel`]              — channel-attached workspace tools (subfolder)
//! - [`inbox_wake`]           — production `InboxWakeHook` for `org_send_message`
//! - [`manage_session`]       — `manage_session` (session lifecycle CRUD)
//! - [`member_idle`]          — production `MemberIdleHook` for the post-turn member-idle notification
//! - [`member_shutdown`]      — production `MemberShutdownHook` for the inbox-drain shutdown side effect
//! - [`suggest_mode_switch`]  — `suggest_mode_switch` (Plan-mode entry suggestion)
//!
//! Helpers:
//! - [`context_builders`]     — shared context-builder helpers used by orchestration tools
//! - [`subagent_handler`]     — shared Agent-worker event handler for Delegate/Shadow runs (used by `agent`)
//! - [`subagent_wake`]        — process-wide hook to wake an idle parent when a background subagent completes

pub mod agent;
pub mod agent_org;
pub mod ask_user_questions;
pub mod channel;
pub mod context_builders;
pub mod inbox_wake;
pub mod manage_secrets;
pub mod manage_session;
pub mod member_idle;
pub mod member_shutdown;
pub mod subagent_handler;
pub mod subagent_wake;
pub mod suggest_mode_switch;

pub mod org_send_message {
    pub use super::agent_org::send_message::*;
}
pub mod agent_tasks {
    pub use super::agent_org::tasks::*;
}
