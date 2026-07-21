//! Pending-approval registry and `session/request_permission` helpers.
//!
//! Parks each ACP permission request on a oneshot channel keyed by an
//! `acpperm-*` request id, broadcasts the interactive wire event, and
//! resolves the option id the agent expects back.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{oneshot, Mutex};

use super::AcpAgentAdapter;

/// Pending approval response: approved (true) or denied (false).
pub struct ApprovalResponse {
    pub approved: bool,
    pub always_allow: bool,
}

/// A parked ACP `session/request_permission`, keyed by `request_id`
/// (`acpperm-*`) in [`PENDING_APPROVALS`]. `session_id` is kept so the
/// Tauri command can also resolve without a request id — the protocol
/// loop blocks on one permission at a time per session.
struct PendingAcpApproval {
    session_id: String,
    sender: oneshot::Sender<ApprovalResponse>,
}

type PendingApprovalsMap = HashMap<String, PendingAcpApproval>;

/// Global registry of pending approval requests (request_id → parked entry).
/// When the frontend approves/denies, the Tauri command resolves the channel
/// via [`resolve_approval`] — external callers never touch the map directly.
static PENDING_APPROVALS: std::sync::LazyLock<Arc<Mutex<PendingApprovalsMap>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// How long an ACP permission request waits for the user before the
/// legacy auto-approve fallback fires.
pub const ACP_APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Resolve a pending approval request.
/// Called by the Tauri command when the user approves or denies.
///
/// Looks up by `request_id` when given (the `acpperm-*` id from the
/// `permission:request` wire event); otherwise falls back to the
/// session's only pending entry — mirrors
/// `hook_approvals::resolve_hook_approval`.
pub async fn resolve_approval(
    session_id: &str,
    request_id: Option<&str>,
    approved: bool,
    always_allow: bool,
) -> Result<(), String> {
    let entry = {
        let mut pending = PENDING_APPROVALS.lock().await;
        let key = match request_id {
            Some(request_id) if pending.contains_key(request_id) => Some(request_id.to_string()),
            _ => pending
                .iter()
                .find(|(_, entry)| entry.session_id == session_id)
                .map(|(key, _)| key.clone()),
        };
        let key = key.ok_or_else(|| format!("No pending approval for session {}", session_id))?;
        pending.remove(&key).expect("key was just found")
    };
    entry
        .sender
        .send(ApprovalResponse {
            approved,
            always_allow,
        })
        .map_err(|_| "Approval channel closed".to_string())
}

/// Park a new approval entry for a session. Returns the generated
/// `acpperm-*` request id (broadcast to the frontend) and the receiver
/// the protocol loop awaits on.
pub(super) async fn register_acp_approval(
    session_id: &str,
) -> (String, oneshot::Receiver<ApprovalResponse>) {
    let request_id = format!("acpperm-{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel::<ApprovalResponse>();
    PENDING_APPROVALS.lock().await.insert(
        request_id.clone(),
        PendingAcpApproval {
            session_id: session_id.to_string(),
            sender: tx,
        },
    );
    (request_id, rx)
}

/// Await a parked approval. On timeout or a dropped sender the legacy
/// behavior applies: auto-approve (allow once) and clean up the entry.
pub(super) async fn await_acp_approval(
    request_id: &str,
    rx: oneshot::Receiver<ApprovalResponse>,
    timeout: std::time::Duration,
) -> ApprovalResponse {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(resp)) => resp,
        _ => {
            tracing::info!("[ACP] Approval timed out or channel closed — auto-approving");
            PENDING_APPROVALS.lock().await.remove(request_id);
            ApprovalResponse {
                approved: true,
                always_allow: false,
            }
        }
    }
}

// ============================================
// Permission Request Helpers
// ============================================

/// Tool info extracted from a `session/request_permission` params payload.
pub(super) struct PermissionRequestInfo {
    /// Cursor-normalized tool name (via the adapter's kind mapping) when
    /// the standard ACP `toolCall` shape is present; falls back to the
    /// legacy `permissions[0].tool` field, then `"unknown_tool"`.
    pub(super) tool_name: String,
    /// Human-readable description (`toolCall.title` or
    /// `permissions[0].description`).
    pub(super) description: String,
    /// Tool arguments (`toolCall.rawInput` when non-empty; otherwise a
    /// small object carrying the title/description so the frontend card
    /// has something to preview).
    pub(super) tool_args: Value,
    /// The agent's tool call id when present (`toolCall.toolCallId`),
    /// so the frontend can associate the card with the tool bubble.
    pub(super) tool_call_id: Option<String>,
}

pub(super) fn extract_permission_request_info<A: AcpAgentAdapter>(
    adapter: &A,
    params: &Value,
) -> PermissionRequestInfo {
    let tool_call = params.get("toolCall");
    let raw_input = tool_call
        .and_then(|tc| tc.get("rawInput"))
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let title = tool_call
        .and_then(|tc| tc.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool_call_id = tool_call
        .and_then(|tc| tc.get("toolCallId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Legacy shape (pre-standard agents): permissions[0].{tool,description}
    let legacy_perm = params
        .get("permissions")
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first());
    let legacy_tool = legacy_perm
        .and_then(|perm| perm.get("tool"))
        .and_then(|v| v.as_str());
    let legacy_description = legacy_perm
        .and_then(|perm| perm.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let tool_name = match tool_call
        .and_then(|tc| tc.get("kind"))
        .and_then(|v| v.as_str())
    {
        Some(kind) => adapter.map_tool_kind(kind, &raw_input),
        None => legacy_tool.unwrap_or("unknown_tool").to_string(),
    };

    let description = if !title.is_empty() {
        title.to_string()
    } else {
        legacy_description.to_string()
    };

    let tool_args = if raw_input.as_object().is_some_and(|obj| !obj.is_empty()) {
        raw_input
    } else {
        let mut obj = serde_json::Map::new();
        if !description.is_empty() {
            obj.insert(
                "description".to_string(),
                Value::String(description.clone()),
            );
        }
        Value::Object(obj)
    };

    PermissionRequestInfo {
        tool_name,
        description,
        tool_args,
        tool_call_id,
    }
}

/// Pick the `optionId` to answer a `session/request_permission` with.
///
/// Prefers the option whose `kind` matches the user's decision from the
/// request's own `options` array (the protocol expects one of the offered
/// ids). Falls back to the legacy hardcoded ids that pre-date option
/// matching, preserving behavior for agents that omit `options`.
pub(super) fn select_acp_option_id(params: &Value, approved: bool, always_allow: bool) -> String {
    let desired_kinds: &[&str] = if !approved {
        &["reject_once", "reject_always"]
    } else if always_allow {
        &["allow_always", "allow_once"]
    } else {
        &["allow_once", "allow_always"]
    };
    if let Some(options) = params.get("options").and_then(|v| v.as_array()) {
        for kind in desired_kinds {
            let matched = options
                .iter()
                .find(|opt| opt.get("kind").and_then(|v| v.as_str()) == Some(*kind));
            if let Some(id) = matched
                .and_then(|opt| opt.get("optionId"))
                .and_then(|v| v.as_str())
            {
                return id.to_string();
            }
        }
    }
    if !approved {
        "deny"
    } else if always_allow {
        "allow_always"
    } else {
        "allow_once"
    }
    .to_string()
}

/// Broadcast a `permission:request` wire event so the frontend
/// `PermissionCard` renders an interactive Approve/Deny card. Mirrors
/// `hook_approvals::broadcast_permission_request`: flat shape, top-level
/// `session_id` for per-session IPC routing, `origin` routes the
/// response back to this registry via `cli_agent_approval_response`.
pub(super) fn broadcast_acp_permission_request(
    session_id: &str,
    request_id: &str,
    tool_name: &str,
    tool_args: &Value,
    tool_call_id: Option<&str>,
) {
    let msg = serde_json::json!({
        "type": "permission:request",
        "session_id": session_id,
        "sessionId": session_id,
        "requestId": request_id,
        "toolName": tool_name,
        "toolCallId": tool_call_id.unwrap_or(request_id),
        "toolArgs": tool_args,
        "origin": "acp",
    });
    crate::api::websocket_handler::broadcast(msg.to_string());
}
