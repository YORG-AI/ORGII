//! Inbound stdio pumps: the stderr drain task and the framed stdout
//! listener that correlates responses and dispatches
//! `textDocument/publishDiagnostics`.

use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::types::*;
use super::lifecycle::LspServer;
use super::transport::drain_pending_on_close;

impl LspServer {
    /// Start listening to stdout and emit diagnostic events.
    ///
    /// Consumes the pre-taken `self.stdout` (taken in `new_with_binary` to
    /// avoid pipe-fill deadlocks during `initialize`). Also spawns a
    /// background task to drain `self.stderr` into `log::warn!` so noisy
    /// servers (gopls, pyright) don't block on a full stderr pipe.
    pub fn start_listening(
        &mut self,
        _app_handle: tauri::AppHandle,
        language: String,
    ) -> Result<(), String> {
        let stdout = self
            .stdout
            .take()
            .ok_or_else(|| "LSP stdout already consumed".to_string())?;

        if let Some(stderr) = self.stderr.take() {
            let lang_for_stderr = language.clone();
            let stderr_log = self.log_buffer.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end();
                            if !trimmed.is_empty() {
                                log::warn!("[LSP {} stderr] {}", lang_for_stderr, trimmed);
                                stderr_log.push(crate::log_buffer::IoKind::StdErr, trimmed);
                            }
                        }
                        Err(err) => {
                            log::debug!(
                                "[LSP] stderr drain for {} stopped: {}",
                                lang_for_stderr,
                                err
                            );
                            break;
                        }
                    }
                }
            });
        }

        log::info!("[LSP] Starting stdout listener for {} server", language);

        let cache = self.diagnostics_cache.clone();
        let pending = self.pending_requests.clone();
        let stdout_log = self.log_buffer.clone();

        // Spawn task to read stdout. We drive the LSP framing layer
        // through `tokio_util::codec::FramedRead<LspCodec>`, which
        // owns the read buffer and hands us one body's worth of bytes
        // at a time. The previous hand-rolled loop revalidated UTF-8
        // on every poll and did O(n) `buffer.drain(..consumed)` shifts;
        // the codec works on `BytesMut` slices directly and only
        // touches header bytes (always 7-bit ASCII).
        tokio::spawn(async move {
            use crate::codec::LspCodec;
            use futures::StreamExt;
            use tokio_util::codec::FramedRead;

            let mut framed = FramedRead::with_capacity(stdout, LspCodec::new(), 8 * 1024);

            while let Some(frame) = framed.next().await {
                let body = match frame {
                    Ok(body) => body,
                    Err(err) => {
                        // Codec errors are unrecoverable — a server
                        // emitting malformed framing means it's in a
                        // bad state. Log loudly and end the listener
                        // so `drain_pending_on_close` runs.
                        log::error!("[LSP] {} stdout framing error: {}", language, err);
                        break;
                    }
                };

                let value: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(value) => value,
                    Err(err) => {
                        log::warn!(
                            "[LSP] {} sent unparseable JSON-RPC message: {}",
                            language,
                            err
                        );
                        // Still log the raw bytes so the user can see
                        // what the server actually printed when it
                        // emitted unparseable JSON.
                        let lossy = String::from_utf8_lossy(&body).to_string();
                        stdout_log.push(crate::log_buffer::IoKind::StdOut, lossy);
                        continue;
                    }
                };

                // Push the parsed body into the log buffer. We use the
                // already-validated UTF-8 bytes from the codec rather
                // than re-serializing `value` so the log preserves
                // exactly what the server sent.
                let lossy_body = String::from_utf8_lossy(&body).to_string();
                stdout_log.push(crate::log_buffer::IoKind::StdOut, lossy_body);

                // Response correlation. A JSON-RPC response has `id`
                // and no `method`. We resolve the matching `oneshot`
                // sender; the sync `parking_lot::Mutex` critical
                // section is intentionally short (no `.await`).
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    if value.get("method").is_none() {
                        let removed = pending.lock().remove(&id);
                        if let Some(sender) = removed {
                            let result = value
                                .get("result")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let _ = sender.send(result);
                            log::debug!("[LSP] Resolved response for request {}", id);
                        }
                    }
                }

                // Notification dispatch. Today we only act on
                // `textDocument/publishDiagnostics`; everything else
                // (window/logMessage, $/progress, …) is ignored at
                // this layer.
                if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                    if method == "textDocument/publishDiagnostics" {
                        log::debug!("[LSP] Received publishDiagnostics for {}", language);

                        // Typed cache update — see Phase 9. Caching
                        // the typed payload means downstream readers
                        // (post-edit hook, query_lsp) never walk raw
                        // JSON.
                        if let Some(params_value) = value.get("params") {
                            match serde_json::from_value::<PublishDiagnosticsParams>(
                                params_value.clone(),
                            ) {
                                Ok(parsed) => {
                                    let uri_str = parsed.uri.to_string();
                                    let mut diag_cache = cache.write().await;
                                    diag_cache.upsert(uri_str, parsed);
                                }
                                Err(err) => {
                                    log::warn!(
                                        "[LSP] {} sent unparseable publishDiagnostics payload: {}",
                                        language,
                                        err
                                    );
                                }
                            }
                        }

                        // WebSocket fan-out keeps the raw JSON-RPC
                        // payload for the frontend, since the IDE
                        // renderer expects the full envelope.
                        let message = serde_json::json!({
                            "type": "lsp:diagnostics",
                            "language": language,
                            "data": value,
                            "timestamp": std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64,
                        });
                        crate::broadcast::send(message.to_string());
                    }
                }
            }

            log::debug!("[LSP] {} server stdout closed", language);

            // Server stdout has ended (clean shutdown or crash). Drain any
            // pending requests so awaiters get an immediate `Canceled`
            // instead of waiting the full per-request timeout.
            drain_pending_on_close(&pending, &language).await;

            log::info!("[LSP] {} server stdout listener stopped", language);
        });

        Ok(())
    }
}
