//! Loopback long-poll for interactive tool approvals from managed Claude
//! Code hook subprocesses.
//!
//! `org2 --session-provenance-hook claude` POSTs here when it receives a
//! `PermissionRequest` event for a GUI-launched session (`ORGII_SESSION_ID`
//! set) and then blocks on the HTTP response. The handler parks the request
//! on `agent_sessions::cli::hook_approvals` until the user clicks
//! Approve/Deny in the desktop `PermissionCard` (or a timeout lapses), then
//! answers `{"decision": "allow" | "deny" | "none"}`. `"none"` tells the
//! hook to print nothing so Claude's own permission flow applies.
//!
//! Authentication reuses the per-launch bearer token from
//! `agent_status_ingest` (`~/.orgii/session-provenance/status-endpoint.json`).

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::agent_sessions::cli::hook_approvals;

pub const AGENT_APPROVAL_ROUTE: &str = "/hooks/agent-approval";
/// Tool inputs ride along for the approval card preview; Claude Code caps
/// hook stdin payloads well below this.
pub const AGENT_APPROVAL_MAX_BODY_BYTES: usize = 256 * 1024;

pub const AGENT_APPROVAL_SCHEMA_VERSION: u32 = 1;

/// Request body posted by the hook subprocess (see
/// `orgtrack::session_provenance::approval_gate`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookApprovalRequestV1 {
    #[serde(default)]
    schema_version: u32,
    /// `HookSource::as_source_str()` value; only `claude_code` today.
    #[serde(default)]
    #[allow(dead_code)]
    source: String,
    /// The managed session id from `ORGII_SESSION_ID`.
    orgii_session_id: String,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_input: Option<serde_json::Value>,
}

pub async fn handle(headers: HeaderMap, body: Bytes) -> Response {
    if !super::agent_status_ingest::authorize_hook_request(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let request = match serde_json::from_slice::<HookApprovalRequestV1>(&body) {
        Ok(request) => request,
        Err(err) => {
            tracing::debug!(error = %err, "[HookApproval] Dropping unparseable approval post");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    if request.schema_version != AGENT_APPROVAL_SCHEMA_VERSION {
        // Cross-version hook binary: still answer (the wire shape is
        // versioned and serde-tolerant), matching the status-ingest policy.
        tracing::debug!(
            schema_version = request.schema_version,
            "[HookApproval] Accepting cross-version approval post"
        );
    }

    let session_id = request.orgii_session_id.trim();
    if session_id.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let decision = hook_approvals::park_hook_approval(
        session_id,
        request.tool_name.as_deref().unwrap_or("unknown_tool"),
        request.tool_input.unwrap_or(serde_json::Value::Null),
        hook_approvals::HOOK_APPROVAL_PARK_TIMEOUT,
    )
    .await;

    axum::Json(serde_json::json!({ "decision": decision.as_wire_str() })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_request_body_parses_hook_wire_shape() {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "source": "claude_code",
            "orgiiSessionId": "cli-123-abc",
            "toolName": "Bash",
            "toolInput": {"command": "cargo test"},
        });
        let parsed: HookApprovalRequestV1 =
            serde_json::from_value(body).expect("parse approval request");
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.orgii_session_id, "cli-123-abc");
        assert_eq!(parsed.tool_name.as_deref(), Some("Bash"));
        assert_eq!(
            parsed.tool_input.unwrap()["command"],
            serde_json::json!("cargo test")
        );
    }

    #[test]
    fn approval_request_body_tolerates_missing_optional_fields() {
        let parsed: HookApprovalRequestV1 =
            serde_json::from_value(serde_json::json!({ "orgiiSessionId": "cli-x" }))
                .expect("parse minimal request");
        assert_eq!(parsed.schema_version, 0);
        assert!(parsed.tool_name.is_none());
        assert!(parsed.tool_input.is_none());
    }
}
