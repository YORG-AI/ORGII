//! Process lifecycle: the `LspServer` type itself, spawning, the
//! `initialize` handshake, and the shutdown / `Drop` teardown path.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

use super::super::types::*;
use super::diagnostics::DiagnosticsCache;
use super::transport::drain_pending_on_close;

/// Time we give a server to respond to `initialize` before we abort
/// startup. Some servers (rust-analyzer cold-start on a fresh workspace,
/// pyright with a large monorepo) genuinely need 20–30s here, so we
/// pick a generous bound rather than the per-request default.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);

/// Time we give a server to acknowledge `shutdown` before we send `exit`
/// and SIGTERM the process.
const SHUTDOWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Time we wait for the child to actually exit after SIGTERM before
/// escalating to SIGKILL.
const PROCESS_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// LSP Server instance managing a single language server process.
///
/// `process` and `stdin` are wrapped in `Option` so `shutdown` can `take()`
/// them and drive a clean async kill+wait sequence. `Drop` is a sync
/// best-effort fallback that only sends SIGKILL — the canonical cleanup
/// path is `LspServer::shutdown(self).await`, called by `LspManager`.
pub struct LspServer {
    /// Language identifier (e.g., "typescript", "python")
    pub(super) language: String,

    /// Child process handle. `None` after `shutdown()` consumes it.
    pub(super) process: Option<Child>,

    /// Stdin for sending requests/notifications. `None` after `shutdown()`
    /// drops the writer to flush EOF to the server.
    pub(super) stdin: Arc<Mutex<Option<ChildStdin>>>,

    /// Stdout pipe — taken from the child in `new_with_binary` BEFORE
    /// `initialize` writes anything, then consumed by `start_listening`.
    /// Pre-taking matters: rust-analyzer / json-language-server serialize
    /// large schemas during initialize, and if the OS pipe fills before
    /// anyone is reading stdout, the server blocks on its first write
    /// and `initialize` hangs forever.
    pub(super) stdout: Option<ChildStdout>,

    /// Stderr pipe — drained by a background task right after spawn so
    /// servers that log heavily on startup (gopls, pyright) don't fill
    /// their stderr pipe and block. The drained lines are also forwarded
    /// to `log::warn!` for diagnostics.
    pub(super) stderr: Option<ChildStderr>,

    /// Monotonically-increasing JSON-RPC request ID. Atomic so we can
    /// allocate IDs without taking a lock — every outbound request hits
    /// this counter and contention here directly bounds throughput.
    pub(super) next_request_id: Arc<AtomicU64>,

    /// Pending requests — maps request ID to a oneshot sender for the response.
    /// The stdout listener resolves these when a response with a matching ID arrives.
    /// On EOF (server crashed) the listener drains this map so awaiters get an
    /// immediate `Canceled` instead of waiting the per-request timeout.
    ///
    /// Uses `parking_lot::Mutex` (sync) rather than `tokio::sync::Mutex`
    /// because the critical sections are short HashMap mutations that
    /// never `.await` while holding the guard.
    pub(super) pending_requests:
        Arc<parking_lot::Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,

    /// Bounded cache of diagnostics from `textDocument/publishDiagnostics`.
    /// Capped at `MAX_DIAGNOSTIC_FILES` URIs with FIFO eviction so the
    /// cache cannot grow unboundedly in long-lived sessions.
    pub(super) diagnostics_cache: Arc<tokio::sync::RwLock<DiagnosticsCache>>,

    /// Server capabilities advertised in the `initialize` response.
    /// `None` until `initialize_with_options` succeeds. Wrapped in
    /// `RwLock` so the typical "every reader after init" path is
    /// lock-free with no writer contention.
    pub(super) capabilities: Arc<RwLock<Option<ServerCapabilities>>>,

    /// Bounded ring buffer of recent stdio activity. Outbound writes,
    /// inbound JSON-RPC method tags, and stderr lines are pushed here
    /// for the `LanguageServersPage` log drawer to surface. See
    /// `crate::log_buffer` for the cap (`MAX_LOG_LINES = 500`) and
    /// per-line truncation rules.
    pub(super) log_buffer: crate::log_buffer::LogBuffer,
}

impl LspServer {
    /// Create and spawn a new LSP server process
    pub fn new(
        language: &str,
        command: &str,
        args: Vec<&str>,
        root_path: &str,
    ) -> Result<Self, String> {
        Self::new_with_binary(
            language,
            &std::path::PathBuf::from(command),
            args.into_iter().map(String::from).collect(),
            root_path,
            HashMap::new(),
        )
    }

    /// Create and spawn a new LSP server process with explicit binary path and env vars.
    pub fn new_with_binary(
        language: &str,
        binary_path: &std::path::Path,
        args: Vec<String>,
        root_path: &str,
        env_vars: HashMap<String, String>,
    ) -> Result<Self, String> {
        let command_str = binary_path.to_string_lossy();
        log::info!(
            "[LSP] Spawning {} server: {} {:?}",
            language,
            command_str,
            args
        );
        log::info!("[LSP] Working directory: {}", root_path);

        let mut cmd = Command::new(binary_path);
        cmd.args(&args)
            .current_dir(root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Add environment variables
        for (key, value) in &env_vars {
            cmd.env(key, value);
        }

        // Suppress console window on Windows.
        #[cfg(windows)]
        cmd.creation_flags(app_platform::CREATE_NO_WINDOW);

        let mut process = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn {} LSP server: {}. Is {} installed?",
                language, e, command_str
            )
        })?;

        let stdin = process
            .stdin
            .take()
            .ok_or_else(|| "Failed to get stdin".to_string())?;
        let stdout = process
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout".to_string())?;
        let stderr = process
            .stderr
            .take()
            .ok_or_else(|| "Failed to get stderr".to_string())?;

        log::info!(
            "[LSP] Successfully spawned {} server (PID: {:?})",
            language,
            process.id()
        );

        Ok(Self {
            language: language.to_string(),
            process: Some(process),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            stdout: Some(stdout),
            stderr: Some(stderr),
            next_request_id: Arc::new(AtomicU64::new(1)),
            pending_requests: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            diagnostics_cache: Arc::new(tokio::sync::RwLock::new(DiagnosticsCache::default())),
            capabilities: Arc::new(RwLock::new(None)),
            log_buffer: crate::log_buffer::LogBuffer::new(),
        })
    }

    /// Snapshot of the recent stdio ring buffer. Used by
    /// `lsp_get_server_log` and the agent-core `manage_lsp` tool to
    /// surface server activity in the UI.
    pub fn log_snapshot(&self) -> Vec<crate::log_buffer::LogLine> {
        self.log_buffer.snapshot()
    }

    /// Initialize the LSP server with the given initialization options
    /// and post-init workspace configuration.
    ///
    /// Both `init_options` and `workspace_config` come from the
    /// caller-resolved `ServerDef` (typically via
    /// `LspManager::start_server_with_def`). The LSP host itself is
    /// language-agnostic and does NOT inspect `self.language` here —
    /// any server-specific defaults belong on the `ServerDef` impl.
    ///
    /// On success, `result.capabilities` from the `initialize`
    /// response is parsed into `self.capabilities` so subsequent
    /// `hover` / `goto_definition` / `find_references` calls can
    /// fail fast when the feature is not advertised.
    pub async fn initialize_with_options(
        &self,
        root_path: &str,
        init_options: Option<serde_json::Value>,
        workspace_config: Option<serde_json::Value>,
    ) -> Result<(), String> {
        log::info!(
            "[LSP] Initializing {} server for workspace: {}",
            self.language,
            root_path
        );

        let final_init_options = init_options.unwrap_or_else(|| serde_json::json!({}));

        let params = serde_json::json!({
            "processId": std::process::id(),
            "rootPath": root_path,
            "rootUri": format!("file://{}", root_path),
            "capabilities": {
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": true,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "didSave": false
                    },
                    "completion": {
                        "dynamicRegistration": true,
                        "completionItem": {
                            "snippetSupport": false
                        }
                    },
                    "hover": { "dynamicRegistration": true },
                    "definition": { "dynamicRegistration": true },
                    "references": { "dynamicRegistration": true },
                    "documentSymbol": {
                        "dynamicRegistration": true,
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "documentHighlight": { "dynamicRegistration": true },
                    "publishDiagnostics": {
                        "relatedInformation": true
                    }
                },
                "workspace": {
                    "applyEdit": true,
                    "workspaceEdit": {
                        "documentChanges": true
                    },
                    "didChangeConfiguration": {
                        "dynamicRegistration": true
                    },
                    "didChangeWatchedFiles": {
                        "dynamicRegistration": true
                    },
                    "symbol": {
                        "dynamicRegistration": true
                    },
                    "configuration": true
                }
            },
            "initializationOptions": final_init_options,
            "workspaceFolders": [{
                "uri": format!("file://{}", root_path),
                "name": "workspace"
            }]
        });

        let (init_id, receiver) = self
            .send_request_with_response("initialize", Some(params))
            .await?;
        let init_result = match tokio::time::timeout(INITIALIZE_TIMEOUT, receiver).await {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => {
                return Err("initialize response channel closed".to_string());
            }
            Err(_) => {
                self.cancel_request(init_id).await;
                return Err(format!(
                    "initialize timed out after {:?} for {}",
                    INITIALIZE_TIMEOUT, self.language
                ));
            }
        };

        // Parse the full `InitializeResult` so future fields (server
        // info, offset encoding, …) become available with no extra
        // wire-walking. A malformed result is logged but not fatal —
        // we degrade to default capabilities rather than refusing to
        // start the server.
        let capabilities = match serde_json::from_value::<InitializeResult>(init_result) {
            Ok(parsed) => parsed.capabilities,
            Err(err) => {
                log::warn!(
                    "[LSP] {} returned unparseable InitializeResult ({}); \
                     falling back to default capabilities",
                    self.language,
                    err
                );
                ServerCapabilities::default()
            }
        };
        *self.capabilities.write().await = Some(capabilities);

        self.send_notification("initialized", Some(serde_json::json!({})))
            .await?;

        if let Some(settings) = workspace_config {
            self.send_notification(
                "workspace/didChangeConfiguration",
                Some(serde_json::json!({ "settings": settings })),
            )
            .await?;
        }

        log::info!("[LSP] {} server initialized successfully", self.language);
        Ok(())
    }

    /// Cleanly shut down the LSP server.
    ///
    /// This is the canonical cleanup path — call it from `LspManager::shutdown`
    /// and `stop_server_by_key`. The sequence is:
    ///   1. Send `shutdown` request and wait up to `SHUTDOWN_REQUEST_TIMEOUT`.
    ///   2. Send `exit` notification.
    ///   3. Drop stdin to flush EOF to the server.
    ///   4. SIGTERM via `start_kill`, then await the child for up to
    ///      `PROCESS_WAIT_TIMEOUT`.
    ///   5. If still alive, SIGKILL via `kill().await`.
    ///   6. Drain `pending_requests` so any racers get cancelled instead of
    ///      timing out.
    ///
    /// After this returns the child process is guaranteed to be reaped — no
    /// zombies, no leaked PIDs.
    pub async fn shutdown(mut self) {
        log::info!("[LSP] Shutting down {} server", self.language);

        // Best-effort `shutdown` request — many servers reject further work
        // after this and respond with `null`. Ignore the result; if the
        // server has already crashed the write will fail and we move on.
        if let Ok((_id, receiver)) = self.send_request_with_response("shutdown", None).await {
            let _ = tokio::time::timeout(SHUTDOWN_REQUEST_TIMEOUT, receiver).await;
        }

        // Tell the server to exit (notification, no response expected).
        let _ = self.send_notification("exit", None).await;

        // Drop stdin so the server sees EOF on its stdin and exits cleanly
        // even if it ignored our `exit` notification.
        {
            let mut guard = self.stdin.lock().await;
            *guard = None;
        }

        if let Some(mut process) = self.process.take() {
            // Queue SIGTERM (sync, returns immediately).
            if let Err(err) = process.start_kill() {
                log::warn!(
                    "[LSP] start_kill failed for {} server: {}",
                    self.language,
                    err
                );
            }

            // Reap the child within the wait timeout.
            match tokio::time::timeout(PROCESS_WAIT_TIMEOUT, process.wait()).await {
                Ok(Ok(status)) => {
                    log::info!(
                        "[LSP] {} server exited with status {:?}",
                        self.language,
                        status
                    );
                }
                Ok(Err(err)) => {
                    log::warn!("[LSP] Failed to wait for {} server: {}", self.language, err);
                }
                Err(_) => {
                    log::warn!(
                        "[LSP] {} server did not exit within {:?}, sending SIGKILL",
                        self.language,
                        PROCESS_WAIT_TIMEOUT
                    );
                    let _ = process.kill().await;
                }
            }
        }

        // Final drain in case the listener task hadn't yet observed EOF.
        drain_pending_on_close(&self.pending_requests, &self.language).await;
    }
}

impl Drop for LspServer {
    fn drop(&mut self) {
        // Best-effort sync fallback for the case where the server is dropped
        // without going through `shutdown().await` (e.g. panic unwind). We
        // can only queue SIGKILL; we cannot await `wait()` here. The
        // canonical cleanup path is `LspServer::shutdown`.
        if let Some(process) = self.process.as_mut() {
            log::warn!(
                "[LSP] {} server dropped without shutdown(); sending SIGKILL fallback",
                self.language
            );
            let _ = process.start_kill();
        }
    }
}
