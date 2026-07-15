//! Agent Org orchestration tools — persistent inter-agent coordination.
//!
//! This sub-module owns the two Agent Org tools that deal with **persistent,
//! multi-turn collaboration** between org members, distinct from the
//! one-shot subagent spawning in [`super::agent`]:
//!
//! - [`send_message`] — `org_send_message`: typed inbox messages between org participants
//! - [`tasks`]        — `task_graph_create` / `task_create` / `task_update` / `task_list` / `task_get`
//!
//! The split from the top-level `orchestration/` flat file layout clarifies
//! the conceptual boundary: `agent/` spawns ephemeral workers; `agent_org/`
//! drives persistent collaborative workflows.

pub mod send_message;
pub mod tasks;

pub use send_message::{NoopInboxWakeHook, NoopSelfAbortHook, OrgSendMessageTool};
pub use tasks::{
    TaskCreateTool, TaskGetTool, TaskGraphCreateTool, TaskListTool, TaskToolsContext,
    TaskUpdateTool,
};
