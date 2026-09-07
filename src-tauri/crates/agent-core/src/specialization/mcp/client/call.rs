//! Tool dispatch (`call_tool_typed`, `call_tool_typed_with_progress`) and the
//! consecutive-error counter.

use futures::StreamExt;
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, ClientRequest, Meta, ProgressNotificationParam,
    ServerResult,
};
use rmcp::service::PeerRequestOptions;
use serde_json::Value;
use std::sync::atomic::Ordering;
use tracing::warn;

use super::{
    extract_content_blocks, render_content, resolve_tool_timeout, McpClient,
    MAX_ERRORS_BEFORE_RECONNECT,
};
use crate::specialization::mcp::errors::McpCallError;
use crate::specialization::mcp::result::{maybe_persist_large_payload, McpCallResult};

impl McpClient {
    /// Structured tool call — preferred entry point for code that wants
    /// to act on error classification, `_meta` pass-through, or
    /// `structured_content`.
    ///
    /// The `request_meta` argument carries values like
    /// `{ 'orgii/toolUseId': toolUseId }`. Pass `None` from contexts that
    /// don't have a tool use id yet; rmcp will omit the `_meta` field on
    /// the wire.
    ///
    /// Content flattening: text → joined, image/audio → `[mime (N bytes
    /// base64)]`, resource → inline text or URI reference, resource_link
    /// → URI, unknown → no-op. When every block is dropped we fall back
    /// to `structured_content` so the agent still has *something* to
    /// read.
    ///
    /// `isError: true` becomes [`McpCallError::ToolError`] (not
    /// terminal). Transport / timeout / auth / session-expired failures
    /// are classified by [`McpCallError::classify_service_error`] and
    /// bump the reconnect counter.
    pub(crate) async fn call_tool_typed(
        &self,
        tool_name: &str,
        arguments: Value,
        request_meta: Option<Value>,
    ) -> Result<McpCallResult, McpCallError> {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| McpCallError::Transport {
                server: self.name.clone(),
                message: format!("MCP '{}' has no live service", self.name),
            })?;

        let mut params = CallToolRequestParams::new(tool_name.to_string());
        params.arguments = arguments.as_object().cloned();
        if let Some(meta_value) = request_meta {
            if let Some(obj) = meta_value.as_object() {
                params.meta = Some(Meta(obj.clone()));
            } else {
                warn!(
                    "[mcp:client] request_meta for '{}/{}' was not a JSON object; ignoring",
                    self.name, tool_name
                );
            }
        }

        let tool_timeout = resolve_tool_timeout();
        let call_future = service.call_tool(params);
        let result = match tokio::time::timeout(tool_timeout, call_future).await {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => {
                let classified = McpCallError::classify_service_error(&err, &self.name, tool_name)
                    .redact_config_secrets(&self.config);
                self.record_error(&classified);
                return Err(classified);
            }
            Err(_) => {
                let err = McpCallError::Timeout {
                    server: self.name.clone(),
                    tool: tool_name.to_string(),
                    duration_ms: tool_timeout.as_millis(),
                };
                self.record_error(&err);
                return Err(err);
            }
        };

        // Transport round-tripped fine → reset the reconnect counter
        // even if the tool itself returned isError:true (the server is
        // clearly responsive).
        self.consecutive_terminal_errors.store(0, Ordering::SeqCst);

        let is_error = result.is_error.unwrap_or(false);
        let structured_content = result.structured_content.clone();
        let meta = result.meta.as_ref().map(|m| Value::Object(m.0.clone()));
        let content_blocks = extract_content_blocks(&result.content);
        let mut text = render_content(&result.content, &structured_content);

        if is_error {
            text = crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &text,
            );
            let _ = maybe_persist_large_payload(&self.name, tool_name, &mut text);
            return Err(McpCallError::ToolError {
                server: self.name.clone(),
                tool: tool_name.to_string(),
                message: text,
            });
        }

        let _ = maybe_persist_large_payload(&self.name, tool_name, &mut text);

        Ok(McpCallResult {
            text,
            content_blocks,
            meta,
            structured_content,
        })
    }

    /// Progress-aware tool call.
    ///
    /// Identical to [`Self::call_tool_typed`] except every
    /// `notifications/progress` for this request is forwarded to
    /// `on_progress` as it arrives.
    ///
    /// Implementation:
    /// 1. Build the `ClientRequest::CallToolRequest` manually and use
    ///    `send_cancellable_request` so rmcp returns the request handle
    ///    (which exposes the auto-generated `ProgressToken`).
    /// 2. Subscribe to the handler's shared `ProgressDispatcher` for
    ///    that token BEFORE awaiting the response, so we can't miss
    ///    early ticks from fast servers.
    /// 3. Drive the subscriber stream on a background task that calls
    ///    `on_progress` until the response future resolves. The task
    ///    self-terminates when the subscriber is dropped.
    ///
    /// Errors and timeouts surface the same `McpCallError` variants as
    /// `call_tool_typed`, via the same `classify_service_error` +
    /// `record_error` pipeline — progress is a pure observability
    /// addition, never a correctness change.
    pub(crate) async fn call_tool_typed_with_progress<F>(
        &self,
        tool_name: &str,
        arguments: Value,
        request_meta: Option<Value>,
        mut on_progress: F,
    ) -> Result<McpCallResult, McpCallError>
    where
        F: FnMut(ProgressNotificationParam) + Send + 'static,
    {
        let service_guard = self.service.lock().await;
        let service = service_guard
            .as_ref()
            .ok_or_else(|| McpCallError::Transport {
                server: self.name.clone(),
                message: format!("MCP '{}' has no live service", self.name),
            })?;

        let mut params = CallToolRequestParams::new(tool_name.to_string());
        params.arguments = arguments.as_object().cloned();
        if let Some(meta_value) = request_meta {
            if let Some(obj) = meta_value.as_object() {
                params.meta = Some(Meta(obj.clone()));
            } else {
                warn!(
                    "[mcp:client] request_meta for '{}/{}' was not a JSON object; ignoring",
                    self.name, tool_name
                );
            }
        }

        let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
        let dispatcher = service.service().progress_dispatcher();
        let handle = match service
            .peer()
            .send_cancellable_request(request, PeerRequestOptions::no_options())
            .await
        {
            Ok(h) => h,
            Err(err) => {
                let classified = McpCallError::classify_service_error(&err, &self.name, tool_name)
                    .redact_config_secrets(&self.config);
                self.record_error(&classified);
                return Err(classified);
            }
        };

        let subscriber = dispatcher.subscribe(handle.progress_token.clone()).await;
        let progress_task = tokio::spawn(async move {
            let mut stream = subscriber;
            while let Some(tick) = stream.next().await {
                on_progress(tick);
            }
        });

        let tool_timeout = resolve_tool_timeout();
        let response = tokio::time::timeout(tool_timeout, handle.await_response()).await;
        progress_task.abort();

        let server_result = match response {
            Ok(Ok(sr)) => sr,
            Ok(Err(err)) => {
                let classified = McpCallError::classify_service_error(&err, &self.name, tool_name)
                    .redact_config_secrets(&self.config);
                self.record_error(&classified);
                return Err(classified);
            }
            Err(_) => {
                let err = McpCallError::Timeout {
                    server: self.name.clone(),
                    tool: tool_name.to_string(),
                    duration_ms: tool_timeout.as_millis(),
                };
                self.record_error(&err);
                return Err(err);
            }
        };

        let result = match server_result {
            ServerResult::CallToolResult(r) => r,
            other => {
                let err = McpCallError::Other {
                    server: self.name.clone(),
                    message: format!(
                        "MCP '{}/{}' returned unexpected response variant: {:?}",
                        self.name, tool_name, other
                    ),
                }
                .redact_config_secrets(&self.config);
                self.record_error(&err);
                return Err(err);
            }
        };

        self.consecutive_terminal_errors.store(0, Ordering::SeqCst);

        let is_error = result.is_error.unwrap_or(false);
        let structured_content = result.structured_content.clone();
        let meta = result.meta.as_ref().map(|m| Value::Object(m.0.clone()));
        let content_blocks = extract_content_blocks(&result.content);
        let mut text = render_content(&result.content, &structured_content);

        if is_error {
            text = crate::specialization::mcp::config::redact_server_secrets_from_text(
                &self.config,
                &text,
            );
            let _ = maybe_persist_large_payload(&self.name, tool_name, &mut text);
            return Err(McpCallError::ToolError {
                server: self.name.clone(),
                tool: tool_name.to_string(),
                message: text,
            });
        }

        let _ = maybe_persist_large_payload(&self.name, tool_name, &mut text);

        Ok(McpCallResult {
            text,
            content_blocks,
            meta,
            structured_content,
        })
    }

    /// Bump the terminal-error counter and, past
    /// [`MAX_ERRORS_BEFORE_RECONNECT`], flip `alive` off so the manager
    /// reconnects on the next call. Non-terminal errors (e.g.
    /// `ToolError`, `Other`) are ignored.
    pub(super) fn record_error(&self, err: &McpCallError) {
        if !err.is_terminal() {
            return;
        }
        let previous = self
            .consecutive_terminal_errors
            .fetch_add(1, Ordering::SeqCst);
        let now = previous + 1;
        if now >= MAX_ERRORS_BEFORE_RECONNECT {
            warn!(
                "[mcp:client] '{}' hit {} consecutive terminal errors ({}); marking not alive so manager reconnects",
                self.name, now, err
            );
            self.alive.store(false, Ordering::SeqCst);
        }
    }
}
