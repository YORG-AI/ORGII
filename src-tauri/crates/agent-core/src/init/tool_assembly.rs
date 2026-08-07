//! Two-stage tool registry build for a session.
//!
//! Stage 1 (caller-side, in `mod.rs`): the *base* registry is constructed by
//! `session_factory::build_session_runtime`. It holds the LLM-callable tools that
//! don't reference the registry itself — exec, read/write files, web search,
//! plugin tools, MCP tools, and so on.
//!
//! Stage 2 (this module): the *overlay* registry. These tools take a snapshot
//! of the completed base registry and either dispatch into it (`AgentTool` for
//! Delegate/Shadow worker launching) or query it (`ToolSearchTool` for deferred discovery).
//! They cannot be registered in the first stage because they need the base
//! registry as a fully-finished `Arc` to clone into spawned Delegate/Shadow workers.
//!
//! The overlay is wired with `with_fallback(base)` so a tool dispatch that
//! misses the overlay layer transparently falls through to base. From the
//! turn executor's perspective there is a single `Arc<ToolRegistry>` —
//! callers don't see the two-phase split.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use core_types::providers::NativeHarnessType;

use crate::coordination::agent_org_runs::{AgentOrgRunStore, COORDINATOR_MEMBER_ID};
use crate::core::definitions::resolved::ResolvedAgent;
use crate::providers::traits::LLMProvider;
use crate::state::{AgentAppState, AgentSession};
use crate::tools::impls::meta::tool_search::ToolSearchTool;
use crate::tools::impls::orchestration::agent::{AgentTool, AgentToolConfig};
use crate::tools::impls::orchestration::agent_tasks::{
    TaskCreateTool, TaskGetTool, TaskListTool, TaskToolsContext, TaskUpdateTool,
};
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::member_shutdown::AppHandleSelfAbortHook;
use crate::tools::impls::orchestration::org_send_message::{
    InboxWakeHook, NoopInboxWakeHook, NoopSelfAbortHook, OrgSendMessageTool, SelfAbortHook,
};
use crate::tools::impls::orchestration::suggest_mode_switch::{
    ModeSwitchToolContext, SuggestModeSwitchTool,
};
use crate::tools::names;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

/// Inputs needed to materialize the overlay tools. Bundled so the call site
/// in `mod.rs` doesn't pass a 12-argument function.
pub(super) struct OverlayContext<'a> {
    pub state: &'a AgentAppState,
    pub session: &'a AgentSession,
    pub session_id: &'a str,
    pub resolved: &'a ResolvedAgent,
    pub model: &'a str,
    /// The session's account id, resolved by `init_session` (same value the
    /// provider was built with). Threaded into the `AgentTool` config so
    /// sub-agents inherit the parent session's account — never the global.
    pub account_id: &'a str,
    pub workspace_dir: PathBuf,
    pub workspace: crate::session::workspace::SessionWorkspace,
    pub scratchpad_dir: Option<PathBuf>,
    pub agent_org_context: Option<&'a crate::coordination::agent_org_runs::AgentOrgRunContext>,
    pub provider: Arc<dyn LLMProvider>,
    pub native_harness_type: Option<NativeHarnessType>,
    pub policy_arc: Arc<ResolvedToolPolicy>,
    pub disabled_set: &'a HashSet<String>,
    /// The session's single `SecurityPolicy` instance, shared with the
    /// subagent AgentTool config.
    pub exec_security_policy: Arc<crate::foundation::security::SecurityPolicy>,
}

/// Materialize the overlay tool layer on top of `base_registry` and return
/// the combined registry as a single `Arc`.
///
/// Each tool is gated by both:
///   - the resolved capability/disabled set (`disabled_set`), and
///   - the existence of the relevant manager on the session (e.g.
///     `mode_switch_manager` is `None` for agents without that capability).
///
/// Both gates must agree before a tool is added — the disabled set is the
/// agent definition's negative list, the manager presence is the session's
/// proof that the runtime can actually serve the tool.
pub(super) fn assemble_overlay(
    base_registry: Arc<ToolRegistry>,
    ctx: OverlayContext<'_>,
) -> Arc<ToolRegistry> {
    let mut overlay = ToolRegistry::with_fallback(Arc::clone(&base_registry));

    // Shared slot for `AgentTool::parent_registry`. We keep a writer
    // handle here so we can swap in the fully-assembled overlay
    // registry after every overlay tool has been registered. Without
    // this, Delegate and Shadow workers launched via Path A inherit only the
    // `base_registry` and miss every overlay tool — for example,
    // `org_send_message` would be invisible to a Delegate or Shadow worker that
    // needs to report back to its coordinator.
    let agent_tool_registry_slot: Arc<parking_lot::RwLock<Arc<ToolRegistry>>> =
        Arc::new(parking_lot::RwLock::new(Arc::clone(&base_registry)));

    if !ctx.disabled_set.contains(names::AGENT) {
        overlay.register(Box::new(build_agent_tool(
            &ctx,
            Arc::clone(&agent_tool_registry_slot),
        )));
    }

    if !ctx.disabled_set.contains(names::TOOL_SEARCH) {
        overlay.register(Box::new(ToolSearchTool::with_policy(
            Arc::clone(&base_registry),
            Arc::clone(&ctx.policy_arc),
        )));
    }

    if let Some(ref msm) = ctx.session.mode_switch_manager {
        if !ctx.disabled_set.contains(names::SUGGEST_MODE_SWITCH) {
            let mode_ctx = Arc::new(ModeSwitchToolContext::new(Arc::clone(msm)));
            overlay.register(Box::new(SuggestModeSwitchTool::new(mode_ctx)));
        }
    }

    // Register `org_send_message` for inter-agent typed messaging.
    //
    // Visibility is gated by the session-level org-participation
    // predicate (`agent_org_context.is_some()`), NOT by the agent
    // definition's `CapabilitySet`. The `required_capability: CapOrch`
    // marker on agent definitions only advertises which agent kinds
    // *can* participate in orgs (consumed by `supported_agents_for()`
    // and the settings UI). At session-launch time, the authoritative
    // question is "is this session participating in an org run?",
    // and the only correct answer comes from `agent_org_context`.
    //
    // Routing this through the capability-derived `disabled_set` was
    // the original mistake — built-in members like `builtin:general`
    // and `builtin:explore` lack `Orchestration` capability, so a
    // coordinator built on `builtin:general` could not see
    // `org_send_message` even though its session was clearly
    // participating in an org.
    //
    // `agent_org_context` is populated by `load_agent_org_context`,
    // which walks `agent_sessions.parent_session_id` upward until it
    // finds an ancestor that anchors an `agent_org_runs` row. This
    // means materialized member sessions and ad-hoc Delegate/Shadow workers (e.g.
    // `builtin:explore` spawned via the `agent` tool) inherit the
    // org just like the root coordinator. Only materialized roster
    // members own stable `member_id` identity rows; ad-hoc Delegate/Shadow workers do
    // not appear in the org roster.
    //
    // Sender ≠ recipient is enforced inside
    // `OrgSendMessageTool::resolve_recipient`, so a single-
    // coordinator org with no workers still registers safely — the
    // addressable set is empty and the tool returns clean "no
    // recipient" errors instead of silently dropping calls.
    //
    // The instance registered here is bound to the canonical roster
    // member id for this runtime. Delegate/Shadow workers do not own
    // stable roster member ids, so the `agent` tool shadows this tool
    // with a disabled implementation for those ad-hoc workers. The
    // coordinator → ad-hoc sub-agent direction is intentionally
    // unsupported: Delegate/Shadow workers are short-lived foreground /
    // background tasks, not persistent named workers.
    if let Some(org_context) = ctx.agent_org_context {
        // Production wake hook when the session was launched
        // through Tauri (i.e. has an `app_handle`); fall back
        // to the no-op for headless / test contexts. The
        // `app_handle.try_state::<AgentAppState>()` lookup
        // inside `AppHandleInboxWakeHook::wake_one` adds a
        // second safety net.
        let wake_hook: Arc<dyn InboxWakeHook> = match ctx.state.app_handle.clone() {
            Some(handle) => AppHandleInboxWakeHook::new(handle),
            None => Arc::new(NoopInboxWakeHook),
        };
        // Self-abort hook for `shutdown_response{accepted=true}`.
        // Same gating as `wake_hook`: production impl when `app_handle`
        // is present, no-op otherwise.
        let self_abort_hook: Arc<dyn SelfAbortHook> = match ctx.state.app_handle.clone() {
            Some(handle) => AppHandleSelfAbortHook::new(handle),
            None => Arc::new(NoopSelfAbortHook),
        };
        let persisted_session = crate::session::persistence::get_session(ctx.session_id)
            .ok()
            .flatten();
        let caller_member_id = if org_context.run_id.is_empty() {
            None
        } else if AgentOrgRunStore::is_root_session(&org_context.run_id, ctx.session_id)
            .unwrap_or(false)
        {
            Some(COORDINATOR_MEMBER_ID.to_string())
        } else {
            persisted_session.and_then(|record| record.org_member_id)
        };
        if let Some(caller_member_id) = caller_member_id {
            let org_context_arc = Arc::new(org_context.clone());
            overlay.register(Box::new(OrgSendMessageTool::with_hooks(
                Arc::clone(&org_context_arc),
                caller_member_id.clone(),
                Arc::clone(&wake_hook),
                self_abort_hook,
            )));

            // Agent team task board tools. Available to canonical Agent Org
            // participants only: the root coordinator session and materialized
            // roster member sessions with a persisted `member_id` identity.
            let task_tools_ctx = Arc::new(TaskToolsContext {
                org_context: Arc::clone(&org_context_arc),
                caller_agent_id: ctx.resolved.agent_id.clone(),
                caller_member_id,
                wake_hook: Arc::clone(&wake_hook),
            });
            if !ctx.disabled_set.contains(names::TASK_CREATE) {
                overlay.register(Box::new(TaskCreateTool::new(Arc::clone(&task_tools_ctx))));
            }
            if !ctx.disabled_set.contains(names::TASK_UPDATE) {
                overlay.register(Box::new(TaskUpdateTool::new(Arc::clone(&task_tools_ctx))));
            }
            if !ctx.disabled_set.contains(names::TASK_LIST) {
                overlay.register(Box::new(TaskListTool::new(Arc::clone(&task_tools_ctx))));
            }
            if !ctx.disabled_set.contains(names::TASK_GET) {
                overlay.register(Box::new(TaskGetTool::new(Arc::clone(&task_tools_ctx))));
            }
        } else {
            tracing::warn!(
                session_id = %ctx.session_id,
                run_id = %org_context.run_id,
                "[tool_assembly] skipping Agent Org tools for non-roster session without member_id"
            );
        }
    }

    let final_registry = Arc::new(overlay);

    // Swap the overlay-aware registry into the slot held by the
    // already-registered `AgentTool` instance. After this write, every
    // Delegate/Shadow worker launch — Path A inherit, Path B fresh-fallback, shadow,
    // and background — will see overlay tools (`org_send_message`,
    // `tool_search`, `suggest_mode_switch`) when
    // it snapshots the parent registry. Order matters: this MUST happen
    // after the last `overlay.register(...)` call above, since the
    // slot's `Arc` clones must be issued from the same `final_registry`
    // that the turn executor pulls tool definitions from.
    *agent_tool_registry_slot.write() = Arc::clone(&final_registry);

    final_registry
}

/// Build the recursive `AgentTool` (Delegate/Shadow worker launch). Pulled out because the
/// configuration block is long enough to drown the surrounding control flow
/// in `assemble_overlay`.
fn build_agent_tool(
    ctx: &OverlayContext<'_>,
    parent_registry_slot: Arc<parking_lot::RwLock<Arc<ToolRegistry>>>,
) -> AgentTool {
    // `resolve_sub_agent_link` only succeeds for work-item-linked sessions
    // (it conjuctively requires both `work_item_id` and `workspace_path`).
    // For Agent Org coordinator sessions and any other non-work-item
    // launches, that returns `None` — but we still need a `workspace_path`
    // so spawned Delegate/Shadow workers inherit the parent's workspace, otherwise
    // their `agent_sessions.workspace_path` row is NULL and downstream
    // identity resolution (the inbox-wake hook → `send_message_impl_for_wake`
    // → `resolve_session_identity`) errors out with
    // "Cannot resolve workspace_root … not in overrides, runtime, or DB".
    let (work_item_id, workspace_path) = match resolve_sub_agent_link(ctx.session_id) {
        Some((wid, pp)) => (Some(wid), Some(pp)),
        None => (None, Some(ctx.workspace_dir.to_string_lossy().into_owned())),
    };

    // `None` = inherit parent's full tool set; `Some(vec)` = restricted list.
    // An empty `sub_agents` array on the resolved agent is the inherit signal
    // (vs explicitly passing an empty allowlist, which would forbid every
    // sub-agent and is currently not expressible).
    //
    // Agent Org members are flat roster participants, not entries in the
    // `agent` Delegate/Shadow worker launch pool. Coordinator/member
    // collaboration uses `org_send_message` + shared task tools. The
    // `agent` tool remains a private delegation surface for ordinary
    // non-roster helpers.
    //
    // Therefore org sessions use the definition-based private sub-agent
    // allowlist after removing current roster participants. Unlike ordinary
    // non-org sessions, an org session with no private Delegate/Shadow workers gets an empty
    // allowlist instead of `None` so the LLM sees only runtime primitives
    // (`builtin:explore` / `builtin:general`) and not arbitrary custom roster
    // members. The execute-time hard reject in `agent::execute` remains the
    // second guard for coordinator/member ids and member background spawns.
    let member_id = ctx
        .agent_org_context
        .and_then(|_| {
            crate::session::persistence::get_session(ctx.session_id)
                .ok()
                .flatten()
        })
        .and_then(|record| record.org_member_id);
    let is_org_member =
        ctx.agent_org_context.is_some() && member_id.as_deref() != Some(COORDINATOR_MEMBER_ID);

    let mut definition_subagent_ids: Vec<String> = ctx
        .resolved
        .sub_agents
        .iter()
        .map(|sub_agent| sub_agent.agent_id.clone())
        .collect();
    if let Some(org_context) = ctx.agent_org_context {
        definition_subagent_ids.retain(|agent_id| {
            agent_id != &org_context.coordinator_agent_id
                && !org_context
                    .members
                    .iter()
                    .any(|member| member.agent_id == agent_id.as_str())
        });
    }
    let allowed_subagents: Option<Vec<String>> = if ctx.resolved.sub_agents.is_empty() {
        ctx.agent_org_context.map(|_| Vec::new())
    } else {
        Some(definition_subagent_ids.clone())
    };
    let configured_subagents = ctx
        .resolved
        .sub_agents
        .iter()
        .filter(|sub_agent| {
            definition_subagent_ids
                .iter()
                .any(|id| id == &sub_agent.agent_id)
        })
        .cloned()
        .collect();

    AgentTool::with_registry_slot(
        AgentToolConfig {
            workspace: ctx.workspace.clone(),
            app_handle: ctx.state.app_handle.clone(),
            session_account_id: Some(ctx.account_id.to_string()),
            agent_model: ctx.model.to_string(),
            provider: Arc::clone(&ctx.provider),
            native_harness_type: ctx.native_harness_type,
            max_tokens: ctx.resolved.max_tokens as u32,
            temperature: ctx.resolved.temperature as f32,
            work_item_id,
            workspace_path,
            allowed_subagents,
            configured_subagents,
            delegation_chain: Vec::new(),
            parent_cancel_flag: Some(Arc::clone(&ctx.session.cancel_flag)),
            scratchpad_dir: ctx.scratchpad_dir.clone(),
            exec_timeout: ctx.resolved.exec_timeout,
            restrict_to_workspace: ctx.resolved.policy.workspace_only,
            pty_sessions: ctx.state.pty_sessions.clone(),
            security_policy: Some(Arc::clone(&ctx.exec_security_policy)),
            action_bridge: Some(ctx.state.action_bridge.clone()),
            execution_mode: ctx.resolved.execution_mode,
            agent_org_context: ctx.agent_org_context.map(|c| Arc::new(c.clone())),
            is_org_member,
        },
        parent_registry_slot,
        Arc::clone(&ctx.policy_arc),
        ctx.model.to_string(),
        ctx.session_id.to_string(),
    )
}

/// Look up the work item and workspace path for a session if it is linked to
/// one. `None` for unlinked / standalone sessions. Kept private to the
/// overlay-assembly module so it stays self-contained.
fn resolve_sub_agent_link(session_id: &str) -> Option<(String, String)> {
    let session = match crate::session::persistence::get_session(session_id) {
        Ok(Some(s)) => s,
        _ => return None,
    };
    let work_item_id = session.work_item_id.as_ref()?.clone();
    let workspace_path = session.workspace_path.clone()?;
    Some((work_item_id, workspace_path))
}

/// Hydrate the workspace state from disk.
///
/// `SessionWorkspace` has three concepts (cc-aligned): `workspace_root`
/// (stable user-visible identity), `working_dir` (where file tools cwd —
/// differs from `workspace_root` only for worktree-shadow sessions), and
/// `additional_directories` (extra dirs granted via `/add-dir`).
///
/// All three are persisted in `agent_sessions`:
/// - `workspace_path` column ↔ `workspace_root`
/// - `worktree_path` column ↔ `working_dir` (only when ≠ workspace_root,
///   i.e. worktree sessions; non-worktree rows store NULL and
///   `load_workspace` reconstructs `working_dir = workspace_root`)
/// - `workspace_additional_json` column ↔ `additional_directories`
///
/// We re-load the full `SessionWorkspace` here so a long-running session
/// keeps its complete workspace shape across cancels and crash recoveries.
/// In particular, a worktree session reloaded after restart MUST see
/// `working_dir` pointing at its shadow checkout — using
/// `SessionWorkspace::new(workspace_root)` (which collapses `working_dir`
/// onto `workspace_root`) would silently move the agent's cwd onto the
/// user's real project tree and break worktree isolation. The caller-
/// supplied `workspace_root` is only used as a fresh-session fallback when
/// no DB row has been written yet.
pub(super) fn hydrate_workspace_state(
    workspace_root: &Path,
    session_id: &str,
    log_prefix: &str,
) -> Arc<parking_lot::RwLock<crate::session::workspace::SessionWorkspace>> {
    let ws = match crate::session::persistence::load_workspace(session_id) {
        Ok(Some(stored)) => stored,
        Ok(None) => crate::session::workspace::SessionWorkspace::new(workspace_root.to_path_buf()),
        Err(err) => {
            tracing::warn!(
                "[{}] load_workspace({}) failed: {} — falling back to workspace_root only \
                 (additional_directories empty, worktree info lost if any)",
                log_prefix,
                session_id,
                err
            );
            crate::session::workspace::SessionWorkspace::new(workspace_root.to_path_buf())
        }
    };
    Arc::new(parking_lot::RwLock::new(ws))
}
