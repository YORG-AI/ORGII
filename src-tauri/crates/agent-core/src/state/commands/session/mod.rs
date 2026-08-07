//! Unified session commands.
//!
//! These commands work with any agent type. A single code path handles
//! session creation, messaging, and lifecycle. Routing is driven by
//! `AgentDefinition` and the presence of a workspace_path, not by agent type strings.
//!
//! Heavy logic lives in sub-modules; this file keeps the `#[tauri::command]`
//! wrappers thin so Tauri's code-gen can resolve them at `commands::*`.

pub mod channel;
mod coding;
pub(crate) mod common;
mod compaction;
pub(crate) mod create;
pub mod debug;
mod gateway_cmds;
mod housekeeper;
pub(crate) mod identity;
mod interaction;
pub mod launch;
pub mod message;
pub mod org_tasks;
pub mod persistence;
mod workspace;

pub use coding::*;
pub use compaction::*;
pub use housekeeper::*;
pub use interaction::*;
pub use persistence::*;
// The three named functions are re-exported under stable, unambiguous
// names because callers in other modules (test endpoints, orchestration
// channel tools) reach them through `commands::session::workspace_*`.
// `AdditionalDirectoryView` / `SessionWorkspaceView` stay scoped to
// `workspace::` — only this file's internal `agent_session_list_workspaces`
// command uses them, via the deeper `workspace::SessionWorkspaceView`
// path.
pub use workspace::{
    add_directory as workspace_add_directory, apply_worktree as workspace_apply_worktree,
    delete_worktree as workspace_delete_worktree, emit_workspace_changed,
    enter_worktree as workspace_enter_worktree, list_workspaces as workspace_list,
    remove_directory as workspace_remove_directory,
};

use crate::definitions::orgs::AgentOrgsStore;
use crate::persistence::AgentResponse;
use crate::state::control_flow::CancelReason;
use crate::state::AgentAppState;
use gateway_cmds::GatewayStatus;

pub use common::SessionInfo;

// ═══════════════════════════════════════════════════════════════
// Session Management Commands
// ═══════════════════════════════════════════════════════════════

/// List all active sessions.
#[tauri::command]
pub async fn agent_session_list(
    state: tauri::State<'_, AgentAppState>,
) -> Result<Vec<String>, String> {
    Ok(state.list_sessions().await)
}

/// Cancel an active session using an explicit control-flow reason.
#[tauri::command]
pub async fn agent_session_cancel(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    reason: CancelReason,
) -> Result<bool, String> {
    Ok(state.cancel_session(&session_id, reason).await)
}

/// Get session info.
#[tauri::command]
pub async fn agent_session_info(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<Option<SessionInfo>, String> {
    let session = state.get_session(&session_id).await;
    Ok(session.map(|s| SessionInfo {
        session_id: s.id.clone(),
        agent_id: s.definition.id.clone(),
        agent_name: s.definition.name.clone(),
        is_singleton: s.is_singleton(),
    }))
}

/// Remove a session (cleanup).
#[tauri::command]
pub async fn agent_session_remove(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<(), String> {
    state.remove_session(&session_id).await;
    Ok(())
}

/// Check if the global agent is running.
#[tauri::command]
pub async fn agent_is_running(state: tauri::State<'_, AgentAppState>) -> Result<bool, String> {
    Ok(state.is_running())
}

// ═══════════════════════════════════════════════════════════════
// Gateway Commands (thin wrappers)
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn gateway_is_running(state: tauri::State<'_, AgentAppState>) -> Result<bool, String> {
    gateway_cmds::gateway_is_running_impl(&state).await
}

#[tauri::command]
pub async fn gateway_start(state: tauri::State<'_, AgentAppState>) -> Result<(), String> {
    gateway_cmds::gateway_start_impl(&state).await
}

#[tauri::command]
pub async fn gateway_stop(state: tauri::State<'_, AgentAppState>) -> Result<(), String> {
    gateway_cmds::gateway_stop_impl(&state).await
}

#[tauri::command]
pub async fn gateway_status(
    state: tauri::State<'_, AgentAppState>,
) -> Result<GatewayStatus, String> {
    gateway_cmds::gateway_status_impl(&state).await
}

// ═══════════════════════════════════════════════════════════════
// Status (replaces the retired blob-based config commands — RPC contract §13)
// ═══════════════════════════════════════════════════════════════

/// Lightweight agent running-status snapshot. Retained because the
/// frontend status bar polls it every second; the retired
/// `agent_get_config` / `agent_update_config` surface has been replaced
/// by `agent_def_get` / `agent_def_update_patch` and
/// `integrations_get` / `integrations_update_patch` (see
/// `core::definitions::commands`).
#[tauri::command]
pub async fn agent_get_status(
    state: tauri::State<'_, AgentAppState>,
) -> Result<serde_json::Value, String> {
    let session_ids = state.list_sessions().await;
    let gateway_running = state.is_gateway_running();
    let agent_running = state.is_running();

    Ok(serde_json::json!({
        "running": agent_running,
        "gatewayRunning": gateway_running,
        "activeSessions": session_ids.len(),
        "sessionIds": session_ids,
    }))
}

// ═══════════════════════════════════════════════════════════════
// Session Send Message (thin wrapper)
// ═══════════════════════════════════════════════════════════════
//
// `agent_create_session` was retired (commit Apr 2026): the only
// production entry point for fresh sessions is the unified
// `session_launch` (create + send) — the frontend never invoked
// `agent_create_session` directly. The backing `create_session_impl`
// is still used inside `session_launch::session_launch_impl`.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_send_message(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    content: String,
    #[allow(non_snake_case)] displayText: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    workspace_path: Option<String>,
    mode: Option<String>,
    images: Option<Vec<String>>,
    ide_context: Option<crate::session::IdeContext>,
    #[allow(non_snake_case)] isResume: Option<bool>,
    #[allow(non_snake_case)] clientMessageId: Option<String>,
    #[allow(non_snake_case)] turnIntentId: Option<String>,
    #[allow(non_snake_case)] turnIntentSource: Option<String>,
) -> Result<AgentResponse, String> {
    // Lifecycle source: FE may declare whether this dispatch is a queued
    // flush, force-send, or plain submit so the lifecycle log records the
    // origin. Unknown / absent values fall back to UserSubmit.
    let source = turnIntentSource
        .as_deref()
        .and_then(|s| match s {
            "user_submit" => {
                Some(crate::foundation::session_bridge::TurnIntentBridgeSource::UserSubmit)
            }
            "queue" => Some(crate::foundation::session_bridge::TurnIntentBridgeSource::Queue),
            "force_send" => {
                Some(crate::foundation::session_bridge::TurnIntentBridgeSource::ForceSend)
            }
            "resume" => Some(crate::foundation::session_bridge::TurnIntentBridgeSource::Resume),
            _ => None,
        })
        .unwrap_or(crate::foundation::session_bridge::TurnIntentBridgeSource::UserSubmit);
    message::send_message_impl(
        &state,
        session_id,
        content,
        displayText,
        identity::IdentityOverrides {
            model,
            account_id,
            workspace_root: workspace_path,
            native_harness_type: None,
        },
        mode,
        images,
        ide_context,
        isResume.unwrap_or(false),
        true,
        clientMessageId,
        turnIntentId,
        source,
    )
    .await
}

// ═══════════════════════════════════════════════════════════════
// Unified Session Launch (create + send in one call)
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn session_launch(
    state: tauri::State<'_, AgentAppState>,
    org_store: tauri::State<'_, std::sync::Arc<AgentOrgsStore>>,
    params: launch::SessionLaunchParams,
) -> Result<launch::SessionLaunchResult, String> {
    launch::session_launch_impl(&state, Some(org_store.inner()), params).await
}

// ═══════════════════════════════════════════════════════════════
// Session Workspace Mutators
// ═══════════════════════════════════════════════════════════════

use crate::session::workspace::DirectorySource;
use std::path::PathBuf;

#[tauri::command]
pub async fn agent_session_add_directory(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    path: String,
    source: Option<DirectorySource>,
) -> Result<bool, String> {
    workspace::add_directory(
        &state,
        &session_id,
        PathBuf::from(path),
        source.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn agent_session_remove_directory(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    path: String,
) -> Result<bool, String> {
    let pb = PathBuf::from(path);
    workspace::remove_directory(&state, &session_id, pb.as_path()).await
}

#[tauri::command]
pub async fn agent_session_list_workspaces(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<workspace::SessionWorkspaceView, String> {
    workspace::list_workspaces(&state, &session_id).await
}

#[tauri::command]
pub async fn agent_session_enter_worktree(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    branch: Option<String>,
) -> Result<workspace::SessionWorkspaceView, String> {
    workspace::enter_worktree(&state, &session_id, branch).await
}

#[tauri::command]
pub async fn agent_session_apply_worktree(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    strategy: Option<String>,
) -> Result<git::worktree::WorktreeMergeResult, String> {
    workspace::apply_worktree(&state, &session_id, strategy).await
}

#[tauri::command]
pub async fn agent_session_delete_worktree(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<workspace::SessionWorkspaceView, String> {
    workspace::delete_worktree(&state, &session_id).await
}

// ═══════════════════════════════════════════════════════════════
// Wingman Mode Commands
// ═══════════════════════════════════════════════════════════════

/// Start Wingman mode on an existing session.
///
/// Spawns a background observation loop that wakes every 30 s, captures a
/// screenshot, samples `FlowStore`, and enqueues a synthetic Wingman turn.
/// The agent's response is broadcast as both `agent:complete` (normal chat
/// stream) and `wingman:observation` (overlay-only event).
///
/// `mission` is the user's stated goal for this Wingman session, e.g.
/// "Watch me implement the auth flow and tell me if I'm doing anything wrong".
#[tauri::command]
pub async fn wingman_start(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    mission: String,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    crate::session::wingman::start(&state, session_id, mission, monitor_index).await
}

/// List connected displays so the UI can show a "pick a screen" modal
/// before opening Wingman windows on a specific monitor.
#[tauri::command]
pub async fn wingman_list_monitors(
    state: tauri::State<'_, AgentAppState>,
) -> Result<Vec<crate::session::wingman::WingmanMonitorInfo>, String> {
    let handle = state
        .app_handle
        .as_ref()
        .ok_or_else(|| "[wingman] AppHandle not available".to_string())?;
    Ok(crate::session::wingman::list_monitors(handle))
}

/// Stop the Wingman observation loop for the given session.
///
/// No-op if Wingman is not currently running.
#[tauri::command]
pub async fn wingman_stop(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<(), String> {
    crate::session::wingman::stop(&state, &session_id).await
}

/// Close Wingman UI surfaces.
///
/// Used when the user clicks Stop / Close without a live session. If a
/// session is active, prefer `wingman_stop` which also tears down the loop.
#[tauri::command]
pub async fn wingman_close_windows(state: tauri::State<'_, AgentAppState>) -> Result<(), String> {
    let handle = state
        .app_handle
        .as_ref()
        .ok_or_else(|| "[wingman] AppHandle not available".to_string())?;
    crate::session::wingman::close_wingman_windows(handle);
    Ok(())
}

/// Show the desktop-control visibility test surface without opening a WebView panel.
#[tauri::command]
pub async fn wingman_show_desktop_control_test(
    state: tauri::State<'_, AgentAppState>,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    let handle = state
        .app_handle
        .as_ref()
        .ok_or_else(|| "[wingman] AppHandle not available".to_string())?;
    crate::tools::impls::desktop::show_desktop_operation_visibility_test(handle, monitor_index);
    Ok(())
}
