//! Agent Org orchestration tools — persistent inter-agent coordination.
//!
//! This sub-module owns the Agent Org tools that deal with **persistent,
//! multi-turn collaboration** between org members, distinct from the
//! one-shot subagent spawning in [`super::agent`]:
//!
//! - [`send_message`] — `org_send_message`: typed inbox messages between org participants
//! - [`tasks`]        — task-board, run-completion, and inbox-repair tools
//!
//! The split from the top-level `orchestration/` flat file layout clarifies
//! the conceptual boundary: `agent/` spawns ephemeral workers; `agent_org/`
//! drives persistent collaborative workflows.

pub mod send_message;
pub mod tasks;

pub use send_message::{NoopInboxWakeHook, NoopSelfAbortHook, OrgSendMessageTool};
pub use tasks::{
    OrgInboxRepairTool, OrgRunCompleteTool, TaskCreateTool, TaskGetTool, TaskGraphCreateTool,
    TaskListTool, TaskToolsContext, TaskUpdateTool,
};
