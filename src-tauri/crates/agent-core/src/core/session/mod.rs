//! Unified Agent Session Module
//!
//! Provides session abstraction for all agent types.
//!
//! # Directory Layout
//!
//! - `prompt/`      — system prompt construction (builder, sections, helpers, IDE context)
//! - `turn/`        — per-turn execution pipeline (processor, event handler, streaming, hooks)
//! - `compaction/`  — context-window compaction (auto-fork, manual `/compact`)
//! - standalone:    scheduler, workspace, overrides, recovery, wingman, etc.
//!
//! Post-session L3 reflection lives in
//! `crate::memory::reflection`, not here.

pub mod compaction;
pub mod context_import;
pub mod exec_modes;
pub(crate) mod file_registry;
pub mod gateway_pipeline;
pub mod goal_loop;
pub mod launch;
pub mod overrides;
pub mod persistence;
pub mod plan_mode;
pub(crate) mod project_init;
// `recovery` is `#[doc(hidden)] pub` because it is only reached by the
// `app` crate's `/test/*` HTTP debug routes through
// `agent_core::debug::recovery`. The submodule itself is also gated by
// `#[cfg(debug_assertions)]`. Not part of agent_core's documented
// public API.
#[doc(hidden)]
pub mod recovery;
// `prompt` and `turn` are genuine public modules — `app::run` and
// `agent_sessions::cli::commands` call into them at runtime
// (prewarm/inbox-drain hooks, ide_context formatter). They host both
// public-API and `#[doc(hidden)]` items; the test-only items inside
// each carry their own `#[doc(hidden)]`.
pub mod prompt;
pub(crate) mod scheduler;
pub mod status_bar;
pub mod session_id;
pub mod session_memory_search;
pub(crate) mod title;
pub mod turn;
mod types;
// `wingman` is genuine public surface — the wingman_* Tauri commands live in
// `state::commands::session`.
pub mod wingman;
pub mod workspace;

// Items kept at the `session::` surface — checked one by one against real
// call sites. `SessionOverrides`, `UnifiedSessionRecord`,
// `AdditionalDirectory`, and `DirectorySource` are all consumed via the
// deeper `session::overrides::*`, `session::persistence::*`, and
// `session::workspace::*` paths, so we deliberately do NOT flatten those.
pub use project_init::init_workspace_session;
pub use scheduler::{DialogScheduler, ScheduledKind, ScheduledMessage};
pub use turn::{process_message, TurnInput};
pub use types::{
    presence_mode_ids, AgentExecMode, DialogTurn, DialogTurnState, IdeContext, PresenceStance,
    SessionListFilter, SessionStatus, SystemPromptConfig, TurnStats, UserPresence, UserProfile,
};
pub use workspace::SessionWorkspace;
