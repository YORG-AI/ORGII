//! Loopback ingest for live agent-status hook posts.
//!
//! The `org2 --session-provenance-hook <source>` subprocess normalizes each
//! lifecycle payload (`orgtrack_core::status_adapter`) and POSTs it here —
//! the latency-sensitive fast path that bypasses the 15s provenance inbox
//! drain. Authentication is a per-launch bearer token published in
//! `~/.orgii/session-provenance/status-endpoint.json`; hooks re-read that
//! file on every invocation, so sessions that outlive an Orgii restart reach
//! the new server/token without reinstalling anything.

use std::sync::OnceLock;

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use orgtrack_core::status_adapter::AgentStatusEventV1;

pub const AGENT_STATUS_TOKEN_HEADER: &str = "x-orgii-hook-token";
pub const AGENT_STATUS_ROUTE: &str = "/hooks/agent-status";
pub const AGENT_STATUS_MAX_BODY_BYTES: usize = 64 * 1024;

const ENDPOINT_SCHEMA_VERSION: u32 = 1;

static HOOK_TOKEN: OnceLock<String> = OnceLock::new();

fn hook_token() -> &'static str {
    HOOK_TOKEN.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// Publish the current port/token for hook subprocesses. Called right after
/// the axum listener binds; failure is non-fatal (status degrades to the
/// mtime fallback, provenance capture is unaffected).
pub fn write_endpoint_file(port: u16) {
    let payload = serde_json::json!({
        "version": ENDPOINT_SCHEMA_VERSION,
        "port": port,
        "token": hook_token(),
        "pid": std::process::id(),
        "startedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    let Ok(bytes) = serde_json::to_vec_pretty(&payload) else {
        return;
    };
    let path = app_paths::agent_status_endpoint_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(parent) {
        tracing::warn!(error = %err, "[AgentLiveStatus] Could not create endpoint dir");
        return;
    }
    let temp_path = parent.join(format!(".status-endpoint.{}.tmp", std::process::id()));
    if let Err(err) = std::fs::write(&temp_path, bytes) {
        tracing::warn!(error = %err, "[AgentLiveStatus] Could not write endpoint file");
        return;
    }
    app_paths::set_sensitive_file_permissions(&temp_path).ok();
    if let Err(err) = std::fs::rename(&temp_path, &path) {
        let _ = std::fs::remove_file(&temp_path);
        tracing::warn!(error = %err, "[AgentLiveStatus] Could not publish endpoint file");
    }
}

/// Timing-safe token comparison: the loopback bind already scopes callers to
/// this machine, but don't leak the token through early-exit comparison.
fn token_matches(candidate: &str) -> bool {
    let expected = hook_token().as_bytes();
    let candidate = candidate.as_bytes();
    if expected.len() != candidate.len() {
        return false;
    }
    expected
        .iter()
        .zip(candidate)
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

/// Shared bearer-token check for every `/hooks/*` loopback route (status
/// ingest here, approval long-poll in `agent_approval_ingest`).
pub(crate) fn authorize_hook_request(headers: &HeaderMap) -> bool {
    headers
        .get(AGENT_STATUS_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(token_matches)
}

pub async fn handle(headers: HeaderMap, body: Bytes) -> StatusCode {
    if !authorize_hook_request(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let event = match serde_json::from_slice::<AgentStatusEventV1>(&body) {
        Ok(event) => event,
        Err(err) => {
            tracing::debug!(error = %err, "[AgentLiveStatus] Dropping unparseable status post");
            return StatusCode::BAD_REQUEST;
        }
    };
    if event.schema_version != orgtrack_core::status_adapter::AGENT_STATUS_SCHEMA_VERSION {
        // A stale hook binary from before/after this build: accept
        // best-effort — the shape is serde-tolerant and versioned.
        tracing::debug!(
            schema_version = event.schema_version,
            "[AgentLiveStatus] Accepting cross-version status post"
        );
    }
    crate::orgtrack::agent_live_status::ingest(event);
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_rejects_wrong_and_accepts_right() {
        let token = hook_token().to_string();
        assert!(token_matches(&token));
        assert!(!token_matches("nope"));
        let mut flipped = token.clone().into_bytes();
        flipped[0] = flipped[0].wrapping_add(1);
        assert!(!token_matches(std::str::from_utf8(&flipped).unwrap_or("x")));
    }
}
