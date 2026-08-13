//! Shared tool registration for all agent variants (OS, SDE, Subagent).
//!
//! Each agent fills a [`ToolDeps`] with its available resources, then calls
//! the category functions ([`coding::register`], [`web::register`], [`desktop::register`], etc.)
//! to populate a `ToolRegistry`. Tools whose dependencies are `None` are
//! silently skipped, and tools in the `disabled` set are not registered.

pub mod agent_ops;
pub mod channel;
pub mod coding;
pub mod desktop;
pub mod plan_mode;
pub mod web;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;

use crate::bus::AgentMessageBus as MessageBus;
use crate::interaction::plan_approval::PlanApprovalManager;
use crate::nodes::NodeRegistry;
use crate::security::SecurityPolicy;
use crate::session::plan_mode::PlanSlotCache;
use crate::session::workspace::SessionWorkspace;
use crate::tools::impls::web::control_orgii::ActionBridge;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::Tool;
use ::terminal::pty_commands::pty::PtySession;
use shared_state::{AgentBrowserConfig, ScreenshotStore};

/// PTY sessions shared with the terminal subsystem.
pub type PtySessions = Arc<tauri::async_runtime::Mutex<HashMap<String, PtySession>>>;

/// All dependencies that tool constructors may need.
///
/// Agents fill only the fields they have — `None` deps cause the
/// corresponding tools to be silently skipped during registration.
pub struct ToolDeps {
    // ── Required ──
    /// Shared, mutable workspace state for this session.
    ///
    /// File tools (`read_file`, `list_dir`, `edit_file`) clone this
    /// `Arc` into their own state so that `/add-dir` mutator commands
    /// become visible mid-session without rebuilding the tool registry.
    /// Other tool constructors snapshot `working_dir()` via `.read()` and
    /// do not participate in hot-reload (their working directory is
    /// pinned at construction — consistent with `workspace_root` /
    /// `working_dir` being immutable today; `set_primary` will
    /// explicitly rebuild the registry per design doc §8).
    pub workspace: Arc<parking_lot::RwLock<SessionWorkspace>>,

    // ── Scratchpad (per-session temp directory, always allowed for file ops) ──
    pub scratchpad_dir: Option<PathBuf>,
    /// Extra read-only roots for `read_file`. Used for global skill bodies that
    /// are referenced from prompt manifests but live outside the project root.
    pub readonly_extra_dirs: Vec<PathBuf>,

    // ── Execution ──
    pub exec_timeout: u64,
    pub restrict_to_workspace: bool,
    pub pty_sessions: Option<PtySessions>,
    pub app_handle: Option<tauri::AppHandle>,
    pub security_policy: Option<Arc<SecurityPolicy>>,

    // ── Action dispatch (Workstation integration) ──
    pub action_bridge: Option<Arc<ActionBridge>>,
    /// Controls whether tools run locally or dispatch to the frontend.
    pub execution_mode: crate::integrations::config::ExecutionMode,

    // ── Browser / Web ──
    pub agent_browser_config: Option<AgentBrowserConfig>,
    pub screenshot_store: Option<Arc<ScreenshotStore>>,
    pub web_search_api_key: Option<String>,

    // ── Typed config fields ──
    pub desktop_enabled: bool,
    pub agent_model: String,

    // ── Session identity (used by CU lock) ──
    pub session_id: String,

    // ── Agent comms ──
    pub bus: Option<Arc<TokioMutex<MessageBus>>>,
    /// The session's own account id, snapshotted at runtime build time.
    /// An account switch invalidates + rebuilds the runtime, so this is
    /// always current for the runtime's lifetime. Never read the global
    /// `AgentAppState.current_account_id` here — that is a gateway-launch
    /// hint and leaks across sessions.
    pub session_account_id: Option<String>,

    // ── Nodes (pre-created by agent if enabled) ──
    pub node_registry: Option<Arc<TokioMutex<NodeRegistry>>>,

    // ── Question ──
    pub question_manager: Option<Arc<crate::interaction::question::QuestionManager>>,

    // ── Secret broker ──
    /// Out-of-band secret capture broker. When present, `manage_secrets`
    /// and `write_env_file` are registered. The plaintext never enters the
    /// LLM transcript — see [`crate::interaction::secret_broker`].
    pub secret_broker: Option<Arc<crate::interaction::secret_broker::SecretBroker>>,

    // ── Plan mode ──
    /// Plan-approval manager — when present, `create_plan` submits the plan
    /// for user review (broadcasts `agent:plan_ready_for_approval`) after a
    /// successful file write. None for subagents and for agents without
    /// coding capability.
    pub plan_approval_manager: Option<Arc<PlanApprovalManager>>,
    /// Plan-file slot cache. Required to register `create_plan`.
    pub plan_slot_cache: Option<PlanSlotCache>,
    /// Agent Org run context, set when the session participates in an
    /// `AgentOrgRun`. `create_plan` reads this to decide whether to
    /// surface the plan to the user (top-level / coordinator session)
    /// or to deliver it to the coordinator's inbox as a typed
    /// `PlanApprovalRequest` (org member session).
    pub agent_org_context: Option<crate::coordination::agent_org_runs::AgentOrgRunContext>,
    /// Runtime roster identity for this Agent Org participant. This is
    /// the only identity `create_plan` may use to distinguish coordinator
    /// from member; `agent_id` can be shared by multiple participants.
    pub agent_org_current_member_id: Option<String>,

    // ── Channel workspace ──
    /// Origin channel context — set for channel-attached sessions (OS agent
    /// serving external channels). Provides the source channel and chat_id
    /// to workspace-mutator tools so they can resolve the target session.
    pub channel_context: Option<ChannelContext>,
}

/// Channel origin context injected into workspace-mutator tool calls.
///
/// Workspace tools (`add_workspace_directory`, etc.) read this to resolve
/// the target session from the per-chat binding when no explicit
/// `target_session_id` is provided.
#[derive(Debug, Clone)]
pub struct ChannelContext {
    /// Source channel identifier (e.g., "telegram:default", "discord:bot").
    pub channel: String,
    /// Chat/conversation ID within that channel.
    pub chat_id: String,
    /// Sender user ID from the original inbound message.
    pub sender_id: String,
}

/// Register a tool unless its name is in the disabled set.
pub fn register_if_enabled(
    registry: &mut ToolRegistry,
    tool: Box<dyn Tool>,
    disabled: &HashSet<String>,
) {
    if !disabled.contains(tool.name()) {
        registry.register(tool);
    } else {
        tracing::info!("[tools] Skipping disabled tool: {}", tool.name());
    }
}
