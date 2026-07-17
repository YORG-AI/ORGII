//! Blocking permission-decision bridge for managed Claude Code sessions.
//!
//! Runs inside the short-lived `org2 --session-provenance-hook claude`
//! subprocess. When Claude Code fires a `PermissionRequest` hook for a
//! GUI-launched session (`ORGII_SESSION_ID` set), this module long-polls
//! `POST /hooks/agent-approval` on the desktop's loopback server; the HTTP
//! response blocks until the user answers the PermissionCard (or the
//! desktop-side park timeout lapses). The verified decision is then printed
//! to the hook's stdout so Claude proceeds or denies.
//!
//! ## Verified hook decision contract (Claude Code 2.1.211)
//!
//! Verified against the installed CLI's docs at
//! <https://code.claude.com/docs/en/hooks> on 2026-07-17:
//!
//! - The `PermissionRequest` event fires when a permission dialog would be
//!   shown. Hook stdin carries `hook_event_name: "PermissionRequest"`,
//!   `tool_name`, `tool_input`, plus the common fields (`session_id`,
//!   `transcript_path`, `cwd`, `permission_mode`).
//! - Exit 0 with a JSON object on stdout decides the request:
//!
//!   ```json
//!   {
//!     "hookSpecificOutput": {
//!       "hookEventName": "PermissionRequest",
//!       "decision": { "behavior": "allow" }
//!     }
//!   }
//!   ```
//!
//!   `decision.behavior` is `"allow"` or `"deny"` (optionally
//!   `updatedInput` / `appliedPermissionRules` on allow — unused here).
//!   This differs from `PreToolUse`, whose output field is
//!   `hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask" |
//!   "defer"`.
//! - Exit 0 with **no output** reports no decision: the normal permission
//!   flow applies (interactive prompt in the TUI; auto-deny in headless
//!   `-p` runs). That silence is this module's fail-open path — timeout,
//!   closed desktop, non-Manual session, and every error all print nothing
//!   so the hook can never wedge or wrongly approve a tool call.
//! - The hook config `timeout` (seconds) caps the process lifetime; the
//!   installer raises it to 300 for the managed `PermissionRequest` entry
//!   so this long-poll (desktop park 120s + slack) is never killed mid-wait.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use orgtrack_core::hook_adapter::HookSource;
use serde_json::Value;

use super::status_post;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1_000);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Above the desktop's 120s park timeout (it always answers first) and
/// well below the installed 300s hook timeout (Claude never kills us
/// mid-poll).
const READ_TIMEOUT: Duration = Duration::from_secs(130);

const APPROVAL_SCHEMA_VERSION: u32 = 1;
const APPROVAL_ROUTE: &str = "/hooks/agent-approval";

fn string_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn orgii_session_id_from_env() -> Option<String> {
    std::env::var("ORGII_SESSION_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_permission_request(payload: &Value) -> bool {
    string_field(payload, &["hook_event_name", "hookEventName", "event"])
        .is_some_and(|name| name.eq_ignore_ascii_case("PermissionRequest"))
}

/// Serialize the stdout decision JSON for the verified contract above.
fn decision_stdout_json(behavior: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": { "behavior": behavior },
        }
    })
    .to_string()
}

/// Entry point from `capture_hook_stdin`. Returns the decision JSON to
/// print to stdout, or `None` when the hook should stay silent (external
/// session, non-PermissionRequest event, desktop closed, timeout, no GUI
/// decision) so Claude's own permission flow applies.
pub(super) fn maybe_block_for_permission_decision(
    source: HookSource,
    payload: &Value,
) -> Option<String> {
    // Only the Claude Code contract is verified; other Claude-family CLIs
    // keep today's fire-and-forget behavior until theirs is.
    if source != HookSource::ClaudeCode {
        return None;
    }
    if !is_permission_request(payload) {
        return None;
    }
    // External (non-GUI) sessions have no PermissionCard to answer them.
    let orgii_session_id = orgii_session_id_from_env()?;

    let body = serde_json::json!({
        "schemaVersion": APPROVAL_SCHEMA_VERSION,
        "source": source.as_source_str(),
        "orgiiSessionId": orgii_session_id,
        "toolName": string_field(payload, &["tool_name", "toolName"]),
        "toolInput": payload.get("tool_input").or_else(|| payload.get("toolInput")),
    });

    match post_approval_request(&body) {
        Some(decision) if decision == "allow" => Some(decision_stdout_json("allow")),
        Some(decision) if decision == "deny" => Some(decision_stdout_json("deny")),
        // "none" or anything unrecognized: no decision.
        _ => None,
    }
}

/// Blocking loopback POST that long-polls the desktop for a decision.
/// Every failure returns `None` — the caller stays silent (fail-open to
/// Claude's own default behavior), mirroring `status_post`'s philosophy
/// but with a read timeout sized for a human answering a card.
fn post_approval_request(body: &Value) -> Option<String> {
    let endpoint = status_post::read_endpoint()?;
    let body = serde_json::to_vec(body).ok()?;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok();
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
    let request = format!(
        "POST {route} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         X-Orgii-Hook-Token: {token}\r\n\
         Connection: close\r\n\r\n",
        route = APPROVAL_ROUTE,
        port = endpoint.port,
        length = body.len(),
        token = endpoint.token,
    );
    stream.write_all(request.as_bytes()).ok()?;
    stream.write_all(&body).ok()?;

    // Connection: close — read to EOF (bounded by the read timeout).
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    parse_decision_response(&response)
}

/// Extract `{"decision": "..."}` from a raw HTTP/1.1 response. Tolerant of
/// header casing and trailing bytes; anything non-200 or unparseable is a
/// no-decision.
fn parse_decision_response(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?;
    let (status_line, _) = text.split_once("\r\n")?;
    if !status_line.contains(" 200") {
        return None;
    }
    // Header block ends at the first blank line — searched in the full
    // response so a header-less reply ("status\r\n\r\nbody") still parses.
    let (_head, body) = text.split_once("\r\n\r\n")?;
    let json_start = body.find('{')?;
    let parsed: Value = serde_json::from_str(body[json_start..].trim()).ok()?;
    parsed
        .get("decision")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_decision_matches_verified_permission_request_schema() {
        let json = decision_stdout_json("allow");
        let parsed: Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(
            parsed["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(parsed["hookSpecificOutput"]["decision"]["behavior"], "allow");
        // The verified contract nests the decision under `decision` (unlike
        // PreToolUse's flat `permissionDecision`); make sure we never emit
        // the PreToolUse field by accident.
        assert!(parsed["hookSpecificOutput"]
            .get("permissionDecision")
            .is_none());
    }

    #[test]
    fn deny_decision_matches_verified_permission_request_schema() {
        let parsed: Value =
            serde_json::from_str(&decision_stdout_json("deny")).expect("valid JSON");
        assert_eq!(parsed["hookSpecificOutput"]["decision"]["behavior"], "deny");
    }

    #[test]
    fn permission_request_event_detection_accepts_claude_field_names() {
        assert!(is_permission_request(&serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
        })));
        assert!(is_permission_request(&serde_json::json!({
            "hookEventName": "PermissionRequest"
        })));
        assert!(!is_permission_request(&serde_json::json!({
            "hook_event_name": "PreToolUse"
        })));
        assert!(!is_permission_request(&serde_json::json!({})));
    }

    #[test]
    fn decision_response_parsing_reads_allow_deny_and_rejects_errors() {
        let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 20\r\n\r\n{\"decision\":\"allow\"}";
        assert_eq!(parse_decision_response(ok).as_deref(), Some("allow"));

        let deny = b"HTTP/1.1 200 OK\r\n\r\n{\"decision\":\"deny\"}";
        assert_eq!(parse_decision_response(deny).as_deref(), Some("deny"));

        let none = b"HTTP/1.1 200 OK\r\n\r\n{\"decision\":\"none\"}";
        assert_eq!(parse_decision_response(none).as_deref(), Some("none"));

        let unauthorized = b"HTTP/1.1 401 Unauthorized\r\n\r\n";
        assert_eq!(parse_decision_response(unauthorized), None);

        let garbage = b"not-http";
        assert_eq!(parse_decision_response(garbage), None);
    }
}
