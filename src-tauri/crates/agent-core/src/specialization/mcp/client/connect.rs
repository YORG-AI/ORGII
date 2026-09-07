//! MCP handshake (`connect`) and tool discovery (`refresh_tools`).

use reqwest::header::{HeaderName, HeaderValue};
use rmcp::transport::auth::{AuthClient, AuthorizationManager, CredentialStore};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

/// Keep at most this many trailing stderr lines from a stdio MCP child so a
/// failed handshake can surface the server's actual diagnostic (missing dep,
/// traceback, "command not found") instead of an opaque timeout/init error.
const STDERR_RING_LINES: usize = 32;

/// Drain a child's stderr into a bounded ring buffer of the most recent lines.
/// Returns a handle the caller reads after a spawn / handshake failure.
fn spawn_stderr_drain(stderr: tokio::process::ChildStderr) -> Arc<StdMutex<Vec<String>>> {
    let ring: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
    let ring_writer = Arc::clone(&ring);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut buf) = ring_writer.lock() {
                buf.push(line);
                let len = buf.len();
                if len > STDERR_RING_LINES {
                    buf.drain(0..len - STDERR_RING_LINES);
                }
            }
        }
    });
    ring
}

/// Snapshot the captured stderr tail as a single string, or `None` if empty.
fn stderr_tail(ring: &Arc<StdMutex<Vec<String>>>) -> Option<String> {
    let buf = ring.lock().ok()?;
    if buf.is_empty() {
        return None;
    }
    Some(buf.join("\n"))
}

/// Append the captured stderr tail to a connection error so the surfaced
/// message is actionable instead of opaque.
fn with_stderr(mut err: String, ring: &Arc<StdMutex<Vec<String>>>) -> String {
    if let Some(tail) = stderr_tail(ring) {
        err.push_str("\n--- server stderr ---\n");
        err.push_str(&tail);
    }
    err
}

use super::{resolve_connect_timeout, McpClient, McpToolDef, ServerCapabilities};
use crate::specialization::mcp::config::{McpServerConfig, McpTransportType};
use crate::specialization::mcp::handler::{AgentClientHandler, HandlerEvent};
use crate::specialization::mcp::notification::ServerNotification;
use crate::specialization::mcp::oauth_store::FileCredentialStore;

/// Convert user-configured `headers` (already env-expanded) into the typed
/// header map rmcp's streamable-HTTP transport sends with every request.
/// Header values are never echoed in errors — they routinely hold secrets.
fn build_custom_headers(
    headers: &HashMap<String, String>,
) -> Result<HashMap<HeaderName, HeaderValue>, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|err| format!("invalid MCP header name '{}': {}", name, err))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| format!("invalid MCP header value for '{}'", name))?;
        out.insert(header_name, header_value);
    }
    Ok(out)
}

/// Mirror of rmcp's private `default_http_client`: idle pooling is disabled
/// to avoid TCP Delayed-ACK stalls when a response body wasn't fully
/// consumed before connection reuse.
fn default_transport_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .expect("failed to build default reqwest client")
}

/// Build an [`AuthClient`] from OAuth credentials persisted by a prior
/// `mcp__<server>__authenticate` flow, so reconnects attach (and refresh)
/// the Authorization token instead of 401-looping back into needs-auth.
///
/// The on-disk store is checked before constructing an
/// [`AuthorizationManager`] because `initialize_from_store` performs
/// network metadata discovery — that cost is only justified when
/// credentials actually exist (most remote servers never do OAuth).
async fn load_stored_auth_client(server: &str, url: &str) -> Option<AuthClient<reqwest::Client>> {
    let store = FileCredentialStore::new(server);
    match CredentialStore::load(&store).await {
        Ok(Some(creds)) if creds.token_response.is_some() => {}
        Ok(_) => return None,
        Err(err) => {
            warn!(
                "[mcp:client] '{}' could not read stored OAuth credentials: {}",
                server, err
            );
            return None;
        }
    }

    let mut manager = match AuthorizationManager::new(url).await {
        Ok(manager) => manager,
        Err(err) => {
            warn!(
                "[mcp:client] '{}' has stored OAuth credentials but the auth manager failed to build: {} — connecting unauthenticated",
                server, err
            );
            return None;
        }
    };
    manager.set_credential_store(store);
    match manager.initialize_from_store().await {
        Ok(true) => Some(AuthClient::new(default_transport_http_client(), manager)),
        Ok(false) => None,
        Err(err) => {
            warn!(
                "[mcp:client] '{}' has stored OAuth credentials but initialization failed: {} — connecting unauthenticated",
                server, err
            );
            None
        }
    }
}

fn serialize_tool_input_schema<T: Serialize>(
    server_name: &str,
    tool_name: &str,
    schema: &T,
) -> Result<Value, String> {
    serde_json::to_value(schema).map_err(|err| {
        format!(
            "serialize input schema for MCP tool '{}::{}': {}",
            server_name, tool_name, err
        )
    })
}

impl McpClient {
    pub async fn connect(name: &str, config: &McpServerConfig) -> Result<Self, String> {
        if config.contains_redacted_secret_sentinel() {
            return Err(format!(
                "MCP server '{}' contains an unresolved redacted secret sentinel",
                name
            ));
        }

        // Expand `${VAR}` / `${VAR:-default}` on a clone so the stored config
        // still reflects what the user wrote on disk (we never overwrite
        // their secrets). If expansion fails (e.g. a referenced env var is
        // missing), surface it as a connection error rather than connecting
        // with a half-substituted command line.
        let mut expanded = config.clone();
        crate::specialization::mcp::env_expansion::expand_server_config(&mut expanded)
            .map_err(|err| err.to_string())?;

        let (notif_tx, notif_rx) = mpsc::channel::<ServerNotification>(64);
        let (event_tx, mut event_rx) = mpsc::channel::<HandlerEvent>(64);
        let handler = AgentClientHandler::new(event_tx);

        let connect_timeout = resolve_connect_timeout(&expanded);

        let serve_future = async {
            match expanded.transport_type {
                McpTransportType::Stdio => {
                    let command = expanded
                        .command
                        .as_deref()
                        .ok_or_else(|| "stdio transport requires a 'command' field".to_string())?;
                    let args = expanded.args.as_deref().unwrap_or(&[]);

                    // Resolve the command to an absolute path against the
                    // (startup-augmented) PATH. A bare name like `npx` /
                    // `uvx` / `codegraph` otherwise fails with an opaque
                    // ENOENT when it lives in a dir the login-shell PATH
                    // probe missed (pipx/uv/cargo/`~/.local/bin`). On miss,
                    // return an actionable "not found in PATH" error.
                    let resolved_command = which::which(command).map_err(|_| {
                            format!(
                                "command '{}' not found in PATH (is the MCP server installed and on your PATH?)",
                                command
                            )
                        })?;

                    let mut cmd = TokioCommand::new(&resolved_command);
                    cmd.args(args);
                    if let Some(cwd) = expanded.cwd.as_deref() {
                        // Validate cwd before handing it to the spawn —
                        // a missing/invalid working dir otherwise fails the
                        // spawn with an unhelpful error.
                        let cwd_path = std::path::Path::new(cwd);
                        if !cwd_path.is_dir() {
                            return Err(format!(
                                    "stdio MCP working directory '{}' does not exist or is not a directory",
                                    cwd
                                ));
                        }
                        cmd.current_dir(cwd_path);
                    }
                    if let Some(env) = expanded.env.as_ref() {
                        for (k, v) in env {
                            cmd.env(k, v);
                        }
                    }

                    // Windows: stdio MCP servers are console programs; without
                    // this each one would flash a console window on spawn.
                    #[cfg(windows)]
                    cmd.creation_flags(app_platform::CREATE_NO_WINDOW);

                    // Capture the child's stderr so a failed handshake can
                    // surface the server's real diagnostic instead of an
                    // opaque "MCP initialize failed" / timeout message.
                    let (child, stderr) = TokioChildProcess::builder(cmd)
                        .stderr(Stdio::piped())
                        .spawn()
                        .map_err(|err| format!("Failed to spawn '{}': {}", command, err))?;
                    let stderr_ring = stderr.map(spawn_stderr_drain).unwrap_or_default();

                    handler.serve(child).await.map_err(|err| {
                        with_stderr(
                            format!("MCP initialize failed for '{}': {}", name, err),
                            &stderr_ring,
                        )
                    })
                }
                McpTransportType::StreamableHttp | McpTransportType::Sse => {
                    let url = expanded
                        .url
                        .as_deref()
                        .ok_or_else(|| "HTTP/SSE transport requires a 'url' field".to_string())?;

                    let mut transport_config =
                        StreamableHttpClientTransportConfig::with_uri(url.to_string());
                    let mut has_explicit_authorization = false;
                    if let Some(headers) = expanded.headers.as_ref() {
                        if !headers.is_empty() {
                            has_explicit_authorization = headers
                                .keys()
                                .any(|key| key.eq_ignore_ascii_case("authorization"));
                            transport_config =
                                transport_config.custom_headers(build_custom_headers(headers)?);
                        }
                    }

                    // An explicit `Authorization` entry in config.headers
                    // wins over stored OAuth credentials so users can pin a
                    // static bearer token; otherwise attach the persisted
                    // OAuth token (with per-request refresh) via AuthClient.
                    let auth_client = if has_explicit_authorization {
                        None
                    } else {
                        load_stored_auth_client(name, url).await
                    };

                    match auth_client {
                        Some(auth) => {
                            let transport =
                                StreamableHttpClientTransport::with_client(auth, transport_config);
                            handler.serve(transport).await.map_err(|err| {
                                format!("MCP initialize failed for '{}': {}", name, err)
                            })
                        }
                        None => {
                            let transport = StreamableHttpClientTransport::with_client(
                                default_transport_http_client(),
                                transport_config,
                            );
                            handler.serve(transport).await.map_err(|err| {
                                format!("MCP initialize failed for '{}': {}", name, err)
                            })
                        }
                    }
                }
            }
        };

        let service = tokio::time::timeout(connect_timeout, serve_future)
            .await
            .map_err(|_| {
                format!(
                    "MCP connect to '{}' timed out after {:?} (set MCP_TIMEOUT to override)",
                    name, connect_timeout
                )
            })??;

        let server_info = service.peer_info().cloned();
        // `InitializeResult.instructions` is the server's usage guidance for
        // the model (tool ordering, batching, safety rules). Captured here so
        // the manager can publish it into the `mcp_instructions` prompt section.
        let instructions = server_info
            .as_ref()
            .and_then(|info| info.instructions.as_deref())
            .and_then(crate::specialization::mcp::instructions::normalize);
        let mut caps = ServerCapabilities::default();
        if let Some(info) = &server_info {
            if let Some(tools) = info.capabilities.tools.as_ref() {
                caps.has_tools = true;
                caps.tools_list_changed = tools.list_changed.unwrap_or(false);
            }
            if let Some(resources) = info.capabilities.resources.as_ref() {
                caps.has_resources = true;
                caps.resources_subscribe = resources.subscribe.unwrap_or(false);
                caps.resources_list_changed = resources.list_changed.unwrap_or(false);
            }
            if let Some(prompts) = info.capabilities.prompts.as_ref() {
                caps.has_prompts = true;
                caps.prompts_list_changed = prompts.list_changed.unwrap_or(false);
            }
        }

        // Fan out HandlerEvents → ServerNotification channel so `McpManager`'s
        // existing notification listener keeps working unchanged.
        let fanout_tx = notif_tx.clone();
        tokio::spawn(async move {
            while let Some(ev) = event_rx.recv().await {
                let (method, params): (&str, Option<Value>) = match ev {
                    HandlerEvent::ToolListChanged => ("notifications/tools/list_changed", None),
                    HandlerEvent::PromptListChanged => ("notifications/prompts/list_changed", None),
                    HandlerEvent::ResourceListChanged => {
                        ("notifications/resources/list_changed", None)
                    }
                    HandlerEvent::ResourceUpdated(uri) => (
                        "notifications/resources/updated",
                        Some(serde_json::json!({ "uri": uri })),
                    ),
                };
                let _ = fanout_tx
                    .send(ServerNotification {
                        method: method.to_string(),
                        params,
                    })
                    .await;
            }
        });

        let connected_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let client = Self {
            name: name.to_string(),
            config: config.clone(),
            instructions,
            service: Mutex::new(Some(service)),
            tools: Mutex::new(Vec::new()),
            last_error: Mutex::new(None),
            capabilities: Mutex::new(caps),
            notification_rx: Mutex::new(Some(notif_rx)),
            #[cfg(debug_assertions)]
            notification_tx: notif_tx,
            #[cfg(not(debug_assertions))]
            _notification_tx: notif_tx,
            alive: AtomicBool::new(true),
            consecutive_terminal_errors: AtomicUsize::new(0),
            connected_at_ms: AtomicI64::new(connected_at_ms),
        };

        client.refresh_tools().await?;

        info!(
            "[mcp:client] Connected to '{}' — {} tools discovered",
            name,
            client.tools.lock().await.len()
        );
        Ok(client)
    }

    pub async fn refresh_tools(&self) -> Result<(), String> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| format!("MCP '{}' has no live service", self.name))?;

        let tools = service.list_all_tools().await.map_err(|err| {
            crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &format!("tools/list failed for '{}': {}", self.name, err),
            )
        })?;

        let converted: Vec<McpToolDef> = tools
            .into_iter()
            .map(|tool| {
                let name = tool.name.into_owned();
                let input_schema =
                    serialize_tool_input_schema(&self.name, &name, &*tool.input_schema)?;
                Ok(McpToolDef {
                    name,
                    description: tool
                        .description
                        .map(|description| description.into_owned())
                        .unwrap_or_default(),
                    input_schema,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        *self.tools.lock().await = converted;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_custom_headers, serialize_tool_input_schema, McpClient};
    use crate::specialization::mcp::config::{
        McpServerConfig, McpTransportType, MCP_SECRET_REDACTED_SENTINEL,
    };
    use serde::ser::{Error as SerError, Serializer};
    use serde::Serialize;
    use std::collections::HashMap;

    struct FailingSchema;

    impl Serialize for FailingSchema {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            Err(S::Error::custom("schema boom"))
        }
    }

    #[test]
    fn serialize_tool_input_schema_propagates_errors() {
        let err = serialize_tool_input_schema("server-a", "tool-b", &FailingSchema).unwrap_err();

        assert!(err.contains("server-a::tool-b"), "got: {err}");
        assert!(err.contains("schema boom"), "got: {err}");
    }

    #[test]
    fn build_custom_headers_converts_valid_entries() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer tok-123".to_string());
        headers.insert("X-Api-Key".to_string(), "abc".to_string());

        let converted = build_custom_headers(&headers).expect("valid headers convert");

        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted
                .get(&reqwest::header::HeaderName::from_static("authorization"))
                .and_then(|value| value.to_str().ok()),
            Some("Bearer tok-123")
        );
        assert_eq!(
            converted
                .get(&reqwest::header::HeaderName::from_static("x-api-key"))
                .and_then(|value| value.to_str().ok()),
            Some("abc")
        );
    }

    #[test]
    fn build_custom_headers_rejects_invalid_name() {
        let mut headers = HashMap::new();
        headers.insert("bad header name".to_string(), "value".to_string());

        let err = build_custom_headers(&headers).unwrap_err();
        assert!(err.contains("invalid MCP header name"), "got: {err}");
    }

    #[test]
    fn build_custom_headers_error_never_echoes_value() {
        let mut headers = HashMap::new();
        headers.insert("X-Secret".to_string(), "top\nsecret".to_string());

        let err = build_custom_headers(&headers).unwrap_err();
        assert!(err.contains("X-Secret"), "got: {err}");
        assert!(!err.contains("secret"), "header value leaked: {err}");
    }

    #[test]
    fn serialize_tool_input_schema_returns_schema_value() {
        let value = serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" }
            }
        });

        let serialized =
            serialize_tool_input_schema("server-a", "tool-b", &value).expect("schema serializes");

        assert_eq!(serialized, value);
    }

    #[tokio::test]
    async fn connect_rejects_wire_sentinel_before_spawning_transport() {
        let config = McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some(MCP_SECRET_REDACTED_SENTINEL.to_string()),
            args: None,
            cwd: None,
            env: None,
            url: None,
            headers: None,
            auto_approve: None,
            disabled: false,
            timeout: 30,
        };

        let err = match McpClient::connect("sentinel-test", &config).await {
            Ok(client) => {
                client.shutdown().await;
                panic!("wire sentinel unexpectedly reached a transport")
            }
            Err(err) => err,
        };

        assert!(err.contains("unresolved redacted secret sentinel"));
        assert!(!err.contains(MCP_SECRET_REDACTED_SENTINEL));
    }
}
