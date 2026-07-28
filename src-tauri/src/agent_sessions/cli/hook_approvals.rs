//! Pending-approval registry for Claude Code `PermissionRequest` hook
//! long-polls from managed (GUI-launched) shell-out sessions.
//!
//! Mirrors the oneshot pattern in `parsers::acp_common::PENDING_APPROVALS`,
//! but keyed by a per-request id instead of the session id, because the
//! request originates outside the session runner (an axum route parks it).
//!
//! ## Flow
//!
//! 1. The managed `claude` child fires the `PermissionRequest` hook; the
//!    `org2 --session-provenance-hook claude` subprocess POSTs to
//!    `POST /hooks/agent-approval` (see `api::agent_approval_ingest`) and
//!    blocks on the HTTP response.
//! 2. The route handler calls [`park_hook_approval`], which:
//!    - auto-resolves [`HookApprovalDecision::Passthrough`] unless the
//!      session was launched in `Manual` permission mode (AutoEdit /
//!      FullPermission / Plan launch flags already encode the user's
//!      intent — Claude's own flags decide, the GUI must not double-gate);
//!    - otherwise broadcasts a `permission:request` wire event (same shape
//!      the Rust-agent `AgentPermissionManager` emits, plus
//!      `origin: "cli_hook"`) so the frontend `PermissionCard` renders it,
//!      and parks on a oneshot with a timeout.
//! 3. The user clicks Approve/Deny → `cli_agent_approval_response` →
//!    [`resolve_hook_approval`] → the HTTP response unblocks → the hook
//!    prints the verified `hookSpecificOutput.decision` JSON to stdout.
//!
//! Timeout or any failure resolves `Passthrough`: the hook prints nothing
//! and Claude falls back to its own permission flow (deny-in-headless),
//! never hanging the tool call forever.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use super::session_runner::launch_profiles::CliPermissionMode;
use crate::api::websocket_handler;

/// How long the desktop parks a hook approval before giving up and letting
/// Claude's own permission flow decide. The hook-side HTTP read timeout and
/// the installed hook `timeout` are both above this (130s / 300s) so the
/// desktop always answers first.
pub const HOOK_APPROVAL_PARK_TIMEOUT: Duration = Duration::from_secs(120);

/// Outcome of a parked hook approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookApprovalDecision {
    /// User approved — hook prints `decision.behavior: "allow"`.
    Allow,
    /// User denied — hook prints `decision.behavior: "deny"`.
    Deny,
    /// No GUI decision (non-Manual session, timeout, shutdown). The hook
    /// prints nothing and Claude's own permission flow applies.
    Passthrough,
}

impl HookApprovalDecision {
    /// Wire string returned to the hook subprocess in the HTTP response body.
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Passthrough => "none",
        }
    }
}

struct PendingHookApproval {
    session_id: String,
    sender: oneshot::Sender<HookApprovalDecision>,
}

/// Pending hook approvals keyed by `request_id`.
static PENDING_HOOK_APPROVALS: LazyLock<Mutex<HashMap<String, PendingHookApproval>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Permission mode each running managed CLI session was launched with,
/// registered by the session runner at spawn time (keyed by the ORGII
/// session id that rides in `ORGII_SESSION_ID`). In-memory only: after an
/// app restart the map is empty and approvals pass through — fail-open to
/// Claude's own defaults, never a stale blocking prompt.
static SESSION_PERMISSION_MODES: LazyLock<Mutex<HashMap<String, CliPermissionMode>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record the launch permission mode for a managed session.
pub fn register_session_permission_mode(session_id: &str, mode: CliPermissionMode) {
    if let Ok(mut map) = SESSION_PERMISSION_MODES.lock() {
        map.insert(session_id.to_string(), mode);
    }
}

/// Drop launch state and cancel any parked approvals when a session ends.
/// Dropping the oneshot sender wakes the parked route with `Passthrough`.
pub fn unregister_session(session_id: &str) {
    if let Ok(mut map) = SESSION_PERMISSION_MODES.lock() {
        map.remove(session_id);
    }
    if let Ok(mut pending) = PENDING_HOOK_APPROVALS.lock() {
        pending.retain(|_, entry| entry.session_id != session_id);
    }
}

fn session_permission_mode(session_id: &str) -> Option<CliPermissionMode> {
    SESSION_PERMISSION_MODES
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).copied())
}

/// Whether hook approvals should block for this session.
///
/// Only `Manual` launches get an interactive gate: AutoEdit /
/// FullPermission / Plan flags already tell Claude what to auto-approve,
/// and an unknown session (restarted desktop, external session that
/// spoofed the env var) must never be blocked by a GUI it can't reach.
fn session_wants_interactive_approval(session_id: &str) -> bool {
    matches!(
        session_permission_mode(session_id),
        Some(CliPermissionMode::Manual)
    )
}

fn broadcast_permission_request(
    session_id: &str,
    request_id: &str,
    tool_name: &str,
    tool_args: &serde_json::Value,
) {
    // Flat shape: top-level `session_id` both routes the message to this
    // session's IPC channel (websocket_handler::extract_session_id) and
    // passes the cliAdapter's top-level session filter. Field names match
    // the Rust-agent `permission:request` payload so the frontend
    // PermissionCard renders it unchanged; `origin` routes the response
    // back to this registry instead of the ACP/agent-core paths.
    let msg = serde_json::json!({
        "type": "permission:request",
        "session_id": session_id,
        "sessionId": session_id,
        "requestId": request_id,
        "toolName": tool_name,
        "toolCallId": request_id,
        "toolArgs": tool_args,
        "origin": "cli_hook",
    });
    websocket_handler::broadcast(msg.to_string());
}

/// Park a hook approval until the user answers, the timeout lapses, or the
/// session turns out not to want interactive approvals at all.
pub async fn park_hook_approval(
    session_id: &str,
    tool_name: &str,
    tool_args: serde_json::Value,
    timeout: Duration,
) -> HookApprovalDecision {
    if !session_wants_interactive_approval(session_id) {
        return HookApprovalDecision::Passthrough;
    }

    let request_id = format!("hookperm-{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel::<HookApprovalDecision>();
    match PENDING_HOOK_APPROVALS.lock() {
        Ok(mut pending) => {
            pending.insert(
                request_id.clone(),
                PendingHookApproval {
                    session_id: session_id.to_string(),
                    sender: tx,
                },
            );
        }
        Err(_) => return HookApprovalDecision::Passthrough,
    }

    broadcast_permission_request(session_id, &request_id, tool_name, &tool_args);
    tracing::info!(
        session_id = %session_id,
        request_id = %request_id,
        tool = %tool_name,
        "[HookApproval] Waiting for user decision"
    );

    let decision = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(decision)) => decision,
        // Timeout or dropped sender (session ended): fall through to
        // Claude's own permission behavior instead of hanging the hook.
        _ => HookApprovalDecision::Passthrough,
    };
    if let Ok(mut pending) = PENDING_HOOK_APPROVALS.lock() {
        pending.remove(&request_id);
    }
    tracing::info!(
        session_id = %session_id,
        request_id = %request_id,
        decision = decision.as_wire_str(),
        "[HookApproval] Resolved"
    );
    decision
}

/// Resolve a parked hook approval from the Tauri approval-response command.
///
/// Looks up by `request_id` when given; otherwise resolves the (single)
/// pending approval for the session. Returns `Err` when nothing is parked —
/// callers use that to fall back to the ACP registry.
pub fn resolve_hook_approval(
    session_id: &str,
    request_id: Option<&str>,
    approved: bool,
) -> Result<(), String> {
    let entry = {
        let mut pending = PENDING_HOOK_APPROVALS
            .lock()
            .map_err(|_| "Hook approval registry lock is poisoned".to_string())?;
        let key = match request_id {
            Some(request_id) if pending.contains_key(request_id) => Some(request_id.to_string()),
            // No (or unknown) request id: fall back to the session's only
            // pending entry — Claude blocks on one permission at a time.
            _ => pending
                .iter()
                .find(|(_, entry)| entry.session_id == session_id)
                .map(|(key, _)| key.clone()),
        };
        let key =
            key.ok_or_else(|| format!("No pending hook approval for session {session_id}"))?;
        pending.remove(&key).expect("key was just found")
    };

    let decision = if approved {
        HookApprovalDecision::Allow
    } else {
        HookApprovalDecision::Deny
    };
    entry
        .sender
        .send(decision)
        .map_err(|_| "Hook approval channel closed".to_string())
}

/// True when the session has a parked hook approval (used by the approval
/// response command to route between this registry and the ACP one).
pub fn has_pending_hook_approval(session_id: &str, request_id: Option<&str>) -> bool {
    PENDING_HOOK_APPROVALS
        .lock()
        .map(|pending| match request_id {
            Some(request_id) if pending.contains_key(request_id) => true,
            _ => pending.values().any(|entry| entry.session_id == session_id),
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_session(tag: &str) -> String {
        format!("cli-test-{}-{}", tag, uuid::Uuid::new_v4().simple())
    }

    #[tokio::test]
    async fn non_manual_session_passes_through_immediately() {
        let session = unique_session("automode");
        register_session_permission_mode(&session, CliPermissionMode::FullPermission);
        let decision = park_hook_approval(
            &session,
            "Bash",
            serde_json::json!({"command": "ls"}),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(decision, HookApprovalDecision::Passthrough);
        assert!(!has_pending_hook_approval(&session, None));
        unregister_session(&session);
    }

    #[tokio::test]
    async fn unknown_session_passes_through_immediately() {
        let session = unique_session("unknown");
        let decision = park_hook_approval(
            &session,
            "Bash",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(decision, HookApprovalDecision::Passthrough);
    }

    #[tokio::test]
    async fn manual_session_parks_and_resolves_allow() {
        let session = unique_session("manual-allow");
        register_session_permission_mode(&session, CliPermissionMode::Manual);

        let park = tokio::spawn({
            let session = session.clone();
            async move {
                park_hook_approval(
                    &session,
                    "Bash",
                    serde_json::json!({"command": "cargo test"}),
                    Duration::from_secs(10),
                )
                .await
            }
        });

        // Wait until the request is parked, then resolve by session id.
        for _ in 0..100 {
            if has_pending_hook_approval(&session, None) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(has_pending_hook_approval(&session, None));
        resolve_hook_approval(&session, None, true).expect("resolve allow");

        let decision = park.await.expect("join");
        assert_eq!(decision, HookApprovalDecision::Allow);
        assert!(!has_pending_hook_approval(&session, None));
        unregister_session(&session);
    }

    #[tokio::test]
    async fn manual_session_parks_and_resolves_deny_by_request_id() {
        let session = unique_session("manual-deny");
        register_session_permission_mode(&session, CliPermissionMode::Manual);

        let park = tokio::spawn({
            let session = session.clone();
            async move {
                park_hook_approval(
                    &session,
                    "Write",
                    serde_json::json!({"file_path": "/tmp/x"}),
                    Duration::from_secs(10),
                )
                .await
            }
        });

        let mut request_id = None;
        for _ in 0..100 {
            request_id = PENDING_HOOK_APPROVALS
                .lock()
                .unwrap()
                .iter()
                .find(|(_, entry)| entry.session_id == session)
                .map(|(key, _)| key.clone());
            if request_id.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let request_id = request_id.expect("request parked");
        resolve_hook_approval(&session, Some(&request_id), false).expect("resolve deny");

        let decision = park.await.expect("join");
        assert_eq!(decision, HookApprovalDecision::Deny);
        unregister_session(&session);
    }

    #[tokio::test]
    async fn park_times_out_to_passthrough() {
        let session = unique_session("timeout");
        register_session_permission_mode(&session, CliPermissionMode::Manual);
        let decision = park_hook_approval(
            &session,
            "Bash",
            serde_json::json!({}),
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(decision, HookApprovalDecision::Passthrough);
        assert!(!has_pending_hook_approval(&session, None));
        unregister_session(&session);
    }

    #[tokio::test]
    async fn unregister_session_cancels_parked_approval() {
        let session = unique_session("cancel");
        register_session_permission_mode(&session, CliPermissionMode::Manual);

        let park = tokio::spawn({
            let session = session.clone();
            async move {
                park_hook_approval(
                    &session,
                    "Bash",
                    serde_json::json!({}),
                    Duration::from_secs(10),
                )
                .await
            }
        });

        for _ in 0..100 {
            if has_pending_hook_approval(&session, None) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        unregister_session(&session);

        let decision = park.await.expect("join");
        assert_eq!(decision, HookApprovalDecision::Passthrough);
    }

    #[tokio::test]
    async fn resolve_without_pending_errors() {
        let session = unique_session("nopending");
        assert!(resolve_hook_approval(&session, None, true).is_err());
    }
}
