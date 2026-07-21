//! JSON-RPC transport: framed writes to the child's stdin, request-ID
//! allocation, response correlation via `pending_requests`, and the
//! typed request/notification convenience wrappers.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use super::super::protocol::*;
use super::helpers::strip_framing_prefix;
use super::lifecycle::LspServer;

impl LspServer {
    /// Write a framed LSP message to stdin. Centralised so `Option<ChildStdin>`
    /// handling lives in exactly one place — every `send_*` path goes through
    /// this. Returns a clear error if stdin was already taken by `shutdown`.
    ///
    /// Also pushes the JSON-RPC body (without the `Content-Length`
    /// framing prefix) into the per-server log buffer so the
    /// `LanguageServersPage` log drawer can show what the host sent.
    async fn write_message(&self, message: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "LSP stdin closed (server is shutting down)".to_string())?;
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        // Strip the LSP framing prefix before logging — the user
        // doesn't care about `Content-Length: N\r\n\r\n`. The codec
        // mirror (`crate::codec::LspCodec`) does the same on the
        // inbound side.
        let body = strip_framing_prefix(message);
        self.log_buffer.push(crate::log_buffer::IoKind::StdIn, body);

        Ok(())
    }

    /// Send a request and return a receiver for the response.
    ///
    /// The returned `(id, receiver)` pair lets callers send a
    /// `$/cancelRequest` notification with the matching id when their
    /// per-request timeout fires. The receiver resolves when the stdout
    /// listener receives a JSON-RPC response with the matching request
    /// ID, or is `Canceled` if the listener drains the pending map on
    /// EOF.
    pub async fn send_request_with_response(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<(u64, oneshot::Receiver<serde_json::Value>), String> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);

        let request = JsonRpcRequest::new(id, method.to_string(), params);

        let json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let message = format_lsp_message(&json);

        log::debug!("[LSP] Sending request {}: {}", id, method);

        // Register the oneshot before writing so a fast response can never
        // race ahead of the registration.
        let (sender, receiver) = oneshot::channel();
        self.pending_requests.lock().insert(id, sender);

        if let Err(err) = self.write_message(&message).await {
            self.pending_requests.lock().remove(&id);
            return Err(err);
        }

        Ok((id, receiver))
    }

    /// Best-effort `$/cancelRequest` for a previously-sent request.
    ///
    /// Called from per-request timeout sites so the server stops
    /// computing a response we'll never read. Also evicts the pending
    /// entry locally — the server's eventual response (if any) will
    /// hit a missing pending entry and be dropped by the listener.
    ///
    /// Errors writing the cancel message are logged at `debug` and
    /// otherwise swallowed: cancellation is advisory and the timeout
    /// error path must not be masked by a write failure.
    pub(super) async fn cancel_request(&self, id: u64) {
        self.pending_requests.lock().remove(&id);
        if let Err(err) = self
            .send_notification("$/cancelRequest", Some(serde_json::json!({ "id": id })))
            .await
        {
            log::debug!(
                "[LSP] Failed to send $/cancelRequest for {} request {}: {}",
                self.language,
                id,
                err
            );
        }
    }

    /// Send a request (fire-and-forget, no awaitable response).
    /// Returns the request ID.
    pub async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<u64, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);

        let request = JsonRpcRequest::new(id, method.to_string(), params);

        let json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let message = format_lsp_message(&json);

        log::debug!("[LSP] Sending request {}: {}", id, method);

        self.write_message(&message).await?;
        Ok(id)
    }

    /// Send a notification (no response expected)
    pub async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let notification = JsonRpcNotification::new(method.to_string(), params);

        let json = serde_json::to_string(&notification)
            .map_err(|e| format!("Failed to serialize notification: {}", e))?;

        let message = format_lsp_message(&json);

        log::debug!("[LSP] Sending notification: {}", method);

        self.write_message(&message).await
    }

    /// Convenience wrapper that serializes a `lsp_types::*` payload via
    /// `serde_json::to_value` before forwarding to `send_notification`.
    /// Lets call sites stay typed without each one having to rebuild
    /// the JSON-RPC envelope.
    pub(super) async fn send_typed_notification<P: serde::Serialize>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), String> {
        let value = serde_json::to_value(params)
            .map_err(|err| format!("Failed to serialize {} params: {}", method, err))?;
        self.send_notification(method, Some(value)).await
    }

    /// Convenience wrapper that serializes a `lsp_types::*` payload via
    /// `serde_json::to_value` before forwarding to
    /// `send_request_with_response`. Returns the typed response (`R`)
    /// or a string error.
    ///
    /// `method` is `&'static str` to match `request_with_timeout`'s
    /// signature — every LSP method we send is a const string literal.
    pub(super) async fn send_typed_request<P, R>(
        &self,
        method: &'static str,
        params: &P,
        timeout: Duration,
    ) -> Result<R, String>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        let value = serde_json::to_value(params)
            .map_err(|err| format!("Failed to serialize {} params: {}", method, err))?;
        let raw = self.request_with_timeout(method, value, timeout).await?;
        serde_json::from_value(raw)
            .map_err(|err| format!("Failed to deserialize {} response: {}", method, err))
    }

    /// Send a request, await the response with a timeout, and emit
    /// `$/cancelRequest` if the timeout fires so the server stops
    /// computing a result no one will read. Pre-init (capabilities
    /// not yet stored) callers must skip this — `initialize` itself
    /// has its own bespoke timeout path.
    async fn request_with_timeout(
        &self,
        method: &'static str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let (id, receiver) = self
            .send_request_with_response(method, Some(params))
            .await?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(format!("{} response channel closed", method)),
            Err(_) => {
                self.cancel_request(id).await;
                Err(format!("{} timed out after {:?}", method, timeout))
            }
        }
    }
}

/// Drain every pending request, dropping the senders so awaiters resolve
/// with `oneshot::error::RecvError` immediately instead of waiting for the
/// per-request timeout.
pub(crate) async fn drain_pending_on_close(
    pending: &Arc<parking_lot::Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    language: &str,
) {
    let mut guard = pending.lock();
    let count = guard.len();
    if count > 0 {
        log::info!(
            "[LSP] Cancelling {} in-flight {} request(s) due to server close",
            count,
            language
        );
        guard.clear();
    }
}
