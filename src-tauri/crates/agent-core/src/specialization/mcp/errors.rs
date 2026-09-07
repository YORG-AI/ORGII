//! Typed errors for MCP tool calls.
//!
//! Three-class error taxonomy:
//!
//! - `Auth` — OAuth/401 flows, forwarded to the auth cache.
//! - `SessionExpired` — HTTP 404 with JSON-RPC `-32001` or the generic
//!   `-32000` ("Connection closed") variant on HTTP transports.
//! - `ToolError` — `isError: true` in the tool result (the server ran
//!   the tool and reported failure).
//!
//! Plus a few Rust-flavored variants:
//!
//! - `Timeout` — our `tokio::time::timeout` wrapper hit the deadline.
//! - `Transport` — connection dropped, framing error, etc. Terminal for
//!   the purposes of the reconnect counter.
//! - `Other` — catch-all so callers never have to handle non-exhaustive
//!   matches across feature upgrades.
//!
//! [`McpCallError::is_terminal`] is what `MAX_ERRORS_BEFORE_RECONNECT`
//! counts against.

use std::fmt;

use crate::specialization::mcp::config::{redact_server_secrets_from_text, McpServerConfig};

/// Typed error surfaced by `McpClient::call_tool_typed`.
///
/// Each variant carries the server name so upstream code (manager, auth
/// cache, UI status) can attribute the failure without re-parsing text.
#[derive(Debug, Clone)]
pub(crate) enum McpCallError {
    /// Server rejected the request with HTTP 401 (or equivalent auth
    /// failure). Callers should trigger the auth flow / write to the
    /// needs-auth cache.
    Auth { server: String, message: String },

    /// Session evicted server-side. HTTP 404 + JSON-RPC `-32001`
    /// ("Session not found"), or `-32000` ("Connection closed") on an
    /// HTTP proxy transport.
    SessionExpired { server: String, message: String },

    /// The tool ran but the server flagged the result with `isError: true`.
    /// `_meta` from the response is dropped on this error path; the
    /// success path plumbs it through `ToolExecuteResult.mcp_meta`.
    ToolError {
        server: String,
        tool: String,
        message: String,
    },

    /// The `MCP_TOOL_TIMEOUT` wrapper tripped before the server answered.
    /// Treated as terminal so repeated tool calls on a wedged server
    /// eventually force a reconnect.
    Timeout {
        server: String,
        tool: String,
        duration_ms: u128,
    },

    /// Transport-level failure: connection closed, framing error, stdio
    /// child died, etc. Terminal.
    Transport { server: String, message: String },

    /// Anything that does not map to the categories above (schema
    /// validation, internal invariant, etc.).
    Other { server: String, message: String },
}

impl McpCallError {
    /// Classify an `rmcp` [`ServiceError`] into our taxonomy.
    ///
    /// `rmcp` exposes the underlying JSON-RPC error code on
    /// `ServiceError::McpError(ErrorData { code, message, .. })`.
    /// Discrimination:
    ///
    /// | HTTP / JSON-RPC                      | Classified as            |
    /// | ------------------------------------ | ------------------------ |
    /// | HTTP 401                             | `Auth`                   |
    /// | HTTP 404 + JSON-RPC `-32001`         | `SessionExpired`         |
    /// | HTTP + JSON-RPC `-32000`             | `SessionExpired`         |
    /// | Everything else                      | `Transport` / `Other`    |
    ///
    /// We inspect the error's string form for HTTP status codes because
    /// `rmcp::ServiceError` keeps transport details in the `Display`
    /// impl; when rmcp starts exposing them structurally we can tighten
    /// this.
    pub(crate) fn classify_service_error(
        err: &rmcp::ServiceError,
        server: &str,
        tool: &str,
    ) -> Self {
        // rmcp exposes its own `Timeout` and `TransportClosed` variants —
        // match them structurally so we never misclassify on message drift.
        match err {
            rmcp::ServiceError::Timeout { timeout } => {
                return McpCallError::Timeout {
                    server: server.to_string(),
                    tool: tool.to_string(),
                    duration_ms: timeout.as_millis(),
                };
            }
            rmcp::ServiceError::TransportClosed => {
                return McpCallError::Transport {
                    server: server.to_string(),
                    message: "Transport closed".to_string(),
                };
            }
            _ => {}
        }

        let rendered = err.to_string();
        let lower = rendered.to_ascii_lowercase();

        // HTTP 401 → auth. Match `errorCode === 401` and any
        // "Unauthorized" prefix on fetch errors.
        if lower.contains("401") || lower.contains("unauthorized") {
            return McpCallError::Auth {
                server: server.to_string(),
                message: rendered,
            };
        }

        // HTTP 404 + session-expired codes. rmcp renders JSON-RPC errors
        // as "MCP error -32001: Session not found" — match both the code
        // and the phrase so we cover both shapes.
        let looks_session_expired = lower.contains("-32001")
            || lower.contains("session not found")
            || (lower.contains("404") && lower.contains("session"))
            || (lower.contains("-32000") && lower.contains("connection closed"));
        if looks_session_expired {
            return McpCallError::SessionExpired {
                server: server.to_string(),
                message: rendered,
            };
        }

        // Transport-level keywords. Any of them means the stream is
        // gone and callers should reconnect.
        let is_transport = [
            "econnreset",
            "etimedout",
            "epipe",
            "ehostunreach",
            "econnrefused",
            "body timeout",
            "terminated",
            "connection closed",
            "stream error",
            "broken pipe",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        if is_transport {
            return McpCallError::Transport {
                server: server.to_string(),
                message: rendered,
            };
        }

        McpCallError::Other {
            server: server.to_string(),
            message: format!("{} (tool={})", rendered, tool),
        }
    }

    /// Whether this failure should increment the reconnect counter.
    ///
    /// Auth, session-expired, transport, and timeout are all terminal.
    /// `ToolError` (server ran the tool and returned a business error)
    /// is *not* terminal — the connection is still healthy.
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            McpCallError::Auth { .. }
                | McpCallError::SessionExpired { .. }
                | McpCallError::Transport { .. }
                | McpCallError::Timeout { .. }
        )
    }

    /// Redact configured env/header values from the message-bearing variants
    /// while preserving the error classification used by auth/reconnect
    /// control flow.
    pub(crate) fn redact_config_secrets(self, config: &McpServerConfig) -> Self {
        match self {
            Self::Auth { server, message } => Self::Auth {
                server,
                message: redact_server_secrets_from_text(config, &message),
            },
            Self::SessionExpired { server, message } => Self::SessionExpired {
                server,
                message: redact_server_secrets_from_text(config, &message),
            },
            Self::ToolError {
                server,
                tool,
                message,
            } => Self::ToolError {
                server,
                tool,
                message: redact_server_secrets_from_text(config, &message),
            },
            Self::Transport { server, message } => Self::Transport {
                server,
                message: redact_server_secrets_from_text(config, &message),
            },
            Self::Other { server, message } => Self::Other {
                server,
                message: redact_server_secrets_from_text(config, &message),
            },
            timeout @ Self::Timeout { .. } => timeout,
        }
    }
}

impl fmt::Display for McpCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            McpCallError::Auth { server, message } => {
                write!(formatter, "MCP auth required for '{}': {}", server, message)
            }
            McpCallError::SessionExpired { server, message } => {
                write!(
                    formatter,
                    "MCP session expired on '{}': {}",
                    server, message
                )
            }
            McpCallError::ToolError {
                server,
                tool,
                message,
                ..
            } => {
                write!(
                    formatter,
                    "MCP tool '{}' on '{}' failed: {}",
                    tool, server, message
                )
            }
            McpCallError::Timeout {
                server,
                tool,
                duration_ms,
            } => {
                write!(
                    formatter,
                    "MCP tool '{}' on '{}' timed out after {} ms (set MCP_TOOL_TIMEOUT to override)",
                    tool, server, duration_ms
                )
            }
            McpCallError::Transport { server, message } => {
                write!(
                    formatter,
                    "MCP transport error on '{}': {}",
                    server, message
                )
            }
            McpCallError::Other { server, message } => {
                write!(formatter, "MCP error on '{}': {}", server, message)
            }
        }
    }
}

impl std::error::Error for McpCallError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::specialization::mcp::config::McpTransportType;
    use std::collections::HashMap;

    /// Build a `ServiceError` from a fabricated message so we can test
    /// the classifier without a real transport. We go through
    /// `rmcp::model::ErrorData` to exercise the JSON-RPC branch.
    fn mk_mcp_error(code: i32, message: &str) -> rmcp::ServiceError {
        rmcp::ServiceError::McpError(rmcp::model::ErrorData::new(
            rmcp::model::ErrorCode(code),
            message.to_string(),
            None,
        ))
    }

    #[test]
    fn classify_auth_401() {
        let svc = mk_mcp_error(-32603, "Unauthorized: HTTP 401");
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::Auth { .. }));
        assert!(err.is_terminal());
    }

    #[test]
    fn classify_session_expired_code() {
        let svc = mk_mcp_error(-32001, "Session not found");
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::SessionExpired { .. }));
        assert!(err.is_terminal());
    }

    #[test]
    fn classify_connection_closed() {
        let svc = mk_mcp_error(-32000, "Connection closed");
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::SessionExpired { .. }));
    }

    #[test]
    fn classify_transport_econnreset() {
        let svc = mk_mcp_error(-32603, "ECONNRESET: peer dropped");
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::Transport { .. }));
        assert!(err.is_terminal());
    }

    #[test]
    fn classify_other_fallback() {
        let svc = mk_mcp_error(-32603, "Internal server error");
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::Other { .. }));
        assert!(!err.is_terminal());
    }

    #[test]
    fn tool_error_is_not_terminal() {
        let err = McpCallError::ToolError {
            server: "srv".into(),
            tool: "tool".into(),
            message: "bad input".into(),
        };
        assert!(!err.is_terminal());
    }

    #[test]
    fn redaction_preserves_error_classification_without_leaking_secret() {
        let config = McpServerConfig {
            transport_type: McpTransportType::StreamableHttp,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: Some("https://example.test/mcp".to_string()),
            headers: Some(HashMap::from([(
                "Authorization".to_string(),
                "Bearer private-token".to_string(),
            )])),
            auto_approve: None,
            disabled: false,
            timeout: 30,
        };
        let redacted = McpCallError::Auth {
            server: "srv".to_string(),
            message: "401 for Bearer private-token".to_string(),
        }
        .redact_config_secrets(&config);

        assert!(matches!(redacted, McpCallError::Auth { .. }));
        let rendered = redacted.to_string();
        assert!(rendered.contains("[REDACTED_SECRET]"));
        assert!(!rendered.contains("private-token"));
    }

    #[test]
    fn classify_rmcp_timeout() {
        let svc = rmcp::ServiceError::Timeout {
            timeout: std::time::Duration::from_millis(1500),
        };
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        match err {
            McpCallError::Timeout { duration_ms, .. } => assert_eq!(duration_ms, 1500),
            other => panic!("expected Timeout, got {:?}", other),
        }
    }

    #[test]
    fn classify_rmcp_transport_closed() {
        let svc = rmcp::ServiceError::TransportClosed;
        let err = McpCallError::classify_service_error(&svc, "srv", "tool");
        assert!(matches!(err, McpCallError::Transport { .. }));
        assert!(err.is_terminal());
    }

    #[test]
    fn display_mentions_server_and_tool() {
        let err = McpCallError::Timeout {
            server: "srv".into(),
            tool: "ping".into(),
            duration_ms: 1_234,
        };
        let rendered = format!("{}", err);
        assert!(rendered.contains("srv"));
        assert!(rendered.contains("ping"));
        assert!(rendered.contains("1234"));
    }
}
