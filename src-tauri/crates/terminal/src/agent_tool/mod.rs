//! Shared terminal service: PTY session creation, command execution, and I/O.
//!
//! Used by:
//! - Tauri commands (`create_pty`, `write_pty`) for frontend terminal UI
//! - Agent `ExecTool` for persistent PTY-based command execution
//!
//! The agent's PTY session is visible in the frontend terminal UI,
//! enabling real-time command viewing and user takeover.

mod exec;

pub use exec::exec_in_pty;
#[cfg(test)]
pub(crate) use exec::{extract_done_marker, strip_command_echo, ExecPhase};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{async_runtime::Mutex as AsyncMutex, AppHandle, Emitter};
use tokio::sync::{broadcast, Notify};
use tokio::task;
use tracing::warn;

use crate::pty_commands::pty::PtySession;
use crate::pty_commands::shell_integration;
use crate::pty_commands::shells::ShellKind;
use crate::redaction::append_redacted_bounded;

// ============================================
// Constants
// ============================================

/// Runaway guard on a single stream's formatted output (200K chars).
///
/// Deliberately far above the exec tool's 30K per-result budget: the turn
/// executor's truncate-or-persist layer governs what the model sees (and
/// persists the full result to disk retrievably). This cap only bounds
/// pathological output (e.g. a process spewing gigabytes) before it reaches
/// that layer.
const MAX_OUTPUT_CHARS: usize = 200_000;
const MAX_REDACTED_SNAPSHOT_CHARS: usize = 80_000;

/// Default PTY dimensions for agent sessions (no visible terminal yet).
const DEFAULT_AGENT_ROWS: u16 = 40;
const DEFAULT_AGENT_COLS: u16 = 120;
const AGENT_OUTPUT_TAP_CAPACITY: usize = 8192;

/// npm injects these into any process it spawns (e.g. when ORGII is launched via
/// `npm run tauri:dev`). They leak into PTY shells through env inheritance and
/// trigger spurious nvm warnings ("nvm is not compatible with npm_config_prefix").
/// Strip them so the embedded shell sees the same env a user's interactive
/// terminal would.
const NPM_LEAKED_ENV_VARS: &[&str] = &[
    "npm_config_prefix",
    "npm_config_globalconfig",
    "npm_config_global_prefix",
    "npm_config_local_prefix",
    "npm_config_userconfig",
    "npm_config_cache",
    "npm_config_node_gyp",
    "npm_config_init_module",
    "npm_config_legacy_peer_deps",
    "npm_config_loglevel",
    "npm_config_noproxy",
    "npm_config_npm_version",
    "npm_config_user_agent",
    "npm_command",
    "npm_execpath",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_node_execpath",
    "npm_package_json",
    "npm_package_name",
    "npm_package_version",
    "INIT_CWD",
];

/// When unacknowledged bytes exceed this, pause the reader loop.
/// Raised from 100 KB to 512 KB to prevent the reader from sleeping too
/// aggressively during agent TUI floods (e.g. htop, cargo build progress bars).
pub(crate) const HIGH_WATERMARK: usize = 512_000;
/// Resume reading when unacknowledged bytes drop below this.
/// Raised from 5 KB to 64 KB so recovery is less jerky after a pause.
/// Exported so ack_pty_data can decide whether to notify the waker.
pub(crate) const LOW_WATERMARK: usize = 64_000;
/// Maximum time to wait for an ACK before re-checking session existence.
/// Replaces the busy-poll BACKPRESSURE_SLEEP_MS loop.
const BACKPRESSURE_TIMEOUT_MS: u64 = 200;
/// Grace period before dropping a session in `close_session` to let
/// the reader flush remaining output.
const CLOSE_FLUSH_MS: u64 = 250;
/// Safety valve: if the reader has been parked on backpressure this long
/// with no ACK progress, the listener is presumed dead (webview reloaded,
/// listener torn down without a detach). Force-detach so the child process
/// is never left blocked on a full PTY buffer; the next attach resyncs from
/// the snapshot. A healthy frontend ACKs even when it drops backlog, so it
/// never trips this.
const STALL_FORCE_DETACH_MS: u64 = 10_000;
/// PTY read buffer. Larger reads mean fewer, bigger events under floods
/// (the frontend scheduler re-chunks adaptively for rendering).
const PTY_READ_BUFFER_BYTES: usize = 64 * 1024;

// ============================================
// Session Management
// ============================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultShellPlatform {
    #[cfg(any(test, target_os = "windows"))]
    Windows,
    #[cfg(any(test, target_os = "macos"))]
    Macos,
    #[cfg(any(test, all(unix, not(target_os = "macos"))))]
    Unix,
}

pub(crate) fn resolve_default_shell_path(
    platform: DefaultShellPlatform,
    shell_env: Option<&str>,
) -> String {
    match platform {
        #[cfg(any(test, target_os = "windows"))]
        DefaultShellPlatform::Windows => "powershell.exe".to_string(),
        #[cfg(any(test, target_os = "macos"))]
        DefaultShellPlatform::Macos => shell_env
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or("zsh")
            .to_string(),
        #[cfg(any(test, all(unix, not(target_os = "macos"))))]
        DefaultShellPlatform::Unix => shell_env
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or("bash")
            .to_string(),
    }
}

fn default_shell_path() -> String {
    #[cfg(target_os = "windows")]
    {
        resolve_default_shell_path(DefaultShellPlatform::Windows, None)
    }

    #[cfg(target_os = "macos")]
    {
        resolve_default_shell_path(
            DefaultShellPlatform::Macos,
            std::env::var("SHELL").ok().as_deref(),
        )
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        resolve_default_shell_path(
            DefaultShellPlatform::Unix,
            std::env::var("SHELL").ok().as_deref(),
        )
    }
}

/// Parameters for creating a new PTY session.
pub struct CreateSessionParams {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub strict_env: bool,
    pub name: Option<String>,
    pub app_handle: AppHandle,
    pub sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    pub output_tap: Option<broadcast::Sender<Arc<[u8]>>>,
}

/// Create a new PTY session and start the shell process.
///
/// This is the shared implementation used by both:
/// - The `create_pty` Tauri command (for frontend terminal tabs)
/// - The agent's `ExecTool` (for persistent agent shell)
///
/// When `output_tap` is provided, the reader task also sends all PTY output
/// to the broadcast channel, allowing the caller to capture command output.
pub async fn create_session(params: CreateSessionParams) -> Result<(), String> {
    let CreateSessionParams {
        session_id,
        rows,
        cols,
        cwd,
        shell,
        args,
        env,
        strict_env,
        name,
        app_handle,
        sessions,
        output_tap,
    } = params;

    let pty_system = native_pty_system();

    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("Failed to create PTY: {}", err))?;

    // Determine shell to use
    let shell_path = shell.unwrap_or_else(default_shell_path);

    let shell_kind = ShellKind::from_shell_path(&shell_path);

    // Resolve shell integration config for supported shells
    let integration = shell_integration::integration_config(&shell_kind);

    // Set up shell command — use CommandBuilder::new for inherited env,
    // or from_argv for strict (isolated) mode
    let mut cmd = if strict_env {
        let default_args = shell_kind.default_args();
        let shell_args = args.as_deref().unwrap_or(&default_args);
        let mut argv = vec![shell_path.clone().into()];
        argv.extend(shell_args.iter().map(std::ffi::OsString::from));
        CommandBuilder::from_argv(argv)
    } else {
        let mut builder = CommandBuilder::new(&shell_path);

        // Integration may prepend args (e.g. --init-file for bash)
        if let Some(ref cfg) = integration {
            for arg in &cfg.prepend_args {
                builder.arg(arg);
            }
        }

        // Apply shell arguments: use provided args or fall back to defaults
        if let Some(ref custom_args) = args {
            for arg in custom_args {
                builder.arg(arg);
            }
        } else {
            let default_args = shell_kind.default_args();
            let strip_login = integration.as_ref().is_some_and(|cfg| cfg.strip_login_args);
            for arg in &default_args {
                if strip_login && (arg == "--login" || arg == "-l" || arg == "-il") {
                    // Bash: --login prevents --init-file from working;
                    // replace -il with just -i for interactive mode.
                    if arg == "-il" {
                        builder.arg("-i");
                    }
                    continue;
                }
                builder.arg(arg);
            }
        }

        // Strip npm-injected env vars that would otherwise leak into the
        // interactive shell when ORGII is launched via `npm run tauri:dev`.
        // These are launch-time artifacts of the npm CLI, not user intent.
        for var in NPM_LEAKED_ENV_VARS {
            builder.env_remove(var);
        }

        builder
    };

    // Set TERM environment variable
    #[cfg(target_os = "windows")]
    cmd.env("TERM", "cygwin");

    #[cfg(not(target_os = "windows"))]
    cmd.env("TERM", "xterm-256color");

    // Apply shell integration environment variables (ZDOTDIR, etc.)
    if let Some(ref cfg) = integration {
        for (key, value) in &cfg.env_vars {
            cmd.env(key, value);
        }
    }

    // Apply custom environment variables (after integration, so user can override)
    if let Some(ref env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    // Set working directory if provided
    if let Some(ref working_dir) = cwd {
        cmd.cwd(working_dir);
    }

    // Spawn the shell
    let mut child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("Failed to spawn shell: {}", err))?;

    // Get the actual child process ID
    let pid: Option<u32> = child.process_id();

    // Spawn a thread to wait for the child process (prevents zombie processes)
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Failed to clone PTY reader: {}", err))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|err| format!("Failed to take PTY writer: {}", err))?;

    let unacked_bytes = Arc::new(AtomicUsize::new(0));
    let ack_notify = Arc::new(Notify::new());
    let frontend_render_ms = Arc::new(AtomicU32::new(0));
    let last_output_at = Arc::new(Mutex::new(None));
    let redacted_output = Arc::new(Mutex::new(String::new()));
    let detached = Arc::new(AtomicBool::new(false));
    let covers_seq = Arc::new(AtomicU64::new(0));
    let missed_while_detached = Arc::new(AtomicUsize::new(0));

    let session = PtySession {
        pty_pair: Arc::new(AsyncMutex::new(pty_pair)),
        writer: Arc::new(AsyncMutex::new(writer)),
        reader: Arc::new(AsyncMutex::new(BufReader::with_capacity(
            PTY_READ_BUFFER_BYTES,
            reader,
        ))),
        pid,
        shell: shell_path.clone(),
        shell_kind,
        cwd: cwd.clone(),
        name,
        output_tap: output_tap.clone(),
        unacked_bytes: unacked_bytes.clone(),
        ack_notify: ack_notify.clone(),
        frontend_render_ms: frontend_render_ms.clone(),
        created_at: Utc::now(),
        last_output_at: last_output_at.clone(),
        redacted_output: redacted_output.clone(),
        detached: detached.clone(),
        covers_seq: covers_seq.clone(),
        missed_while_detached: missed_while_detached.clone(),
    };

    // Clone the reader Arc before storing the session
    let reader_arc = session.reader.clone();

    // Store session
    {
        let mut session_map = sessions.lock().await;
        session_map.insert(session_id.clone(), session);
    }

    // Start reading from PTY and emitting events
    let event_session_id = session_id.clone();
    let app_clone = app_handle.clone();
    let sessions_clone = sessions.clone();

    task::spawn(async move {
        // Pre-allocate event names to avoid repeated string formatting
        let output_event = format!("pty-output-{}", event_session_id);
        let exit_event = format!("pty-exit-{}", event_session_id);

        // Track consecutive empty reads for adaptive sleep
        let mut empty_reads: u32 = 0;
        // Stream offset (total bytes read); mirrors covers_seq and stamps
        // each emitted chunk so the frontend can align snapshot and stream.
        let mut stream_seq: u64 = 0;

        loop {
            // Backpressure state machine with proper async waker.
            //
            // Old approach: busy-poll with tokio::time::sleep(10ms) — wastes a
            // Tokio thread and adds up to 10ms latency after each ACK.
            //
            // New approach: suspend on `ack_notify.notified()` so the task is
            // parked with zero CPU until ack_pty_data() fires notify_one().
            // A BACKPRESSURE_TIMEOUT_MS timeout lets us check session liveness
            // without holding a lock continuously.
            //
            // A detached session never parks: unacked_bytes is frozen at 0 and
            // nothing will ACK, so parking would block the child forever.
            if !detached.load(Ordering::Relaxed)
                && unacked_bytes.load(Ordering::Relaxed) >= HIGH_WATERMARK
            {
                let parked_at = Instant::now();
                loop {
                    if detached.load(Ordering::Relaxed)
                        || unacked_bytes.load(Ordering::Relaxed) < LOW_WATERMARK
                    {
                        break;
                    }

                    // Listener presumed dead after a long stall with no ACK
                    // progress — force-detach rather than leave the child
                    // blocked on a full PTY buffer.
                    if parked_at.elapsed() >= Duration::from_millis(STALL_FORCE_DETACH_MS) {
                        warn!(
                            "[terminal] No ACK progress for {}ms on {}; detaching stream",
                            STALL_FORCE_DETACH_MS, event_session_id
                        );
                        detached.store(true, Ordering::Relaxed);
                        unacked_bytes.store(0, Ordering::Relaxed);
                        break;
                    }

                    // Wait for an ACK (notify_one) or timeout after 200ms.
                    tokio::select! {
                        _ = ack_notify.notified() => {}
                        _ = tokio::time::sleep(Duration::from_millis(BACKPRESSURE_TIMEOUT_MS)) => {}
                    }

                    // Check session still exists (under lock, but we hold it briefly).
                    let exists = {
                        let map = sessions_clone.lock().await;
                        map.contains_key(&event_session_id)
                    };
                    if !exists {
                        if let Err(err) = app_clone.emit(&exit_event, ()) {
                            warn!(
                                "[terminal] Failed to emit exit event {}: {}",
                                exit_event, err
                            );
                        }
                        return;
                    }
                }
            }

            // Check session existence less frequently (every 100 iterations when idle)
            if empty_reads > 0 && empty_reads % 100 == 0 {
                let session_exists = {
                    let session_map = sessions_clone.lock().await;
                    session_map.contains_key(&event_session_id)
                };
                if !session_exists {
                    break;
                }
            }

            let mut reader_lock = reader_arc.lock().await;

            match reader_lock.fill_buf() {
                Ok(data) => {
                    if !data.is_empty() {
                        // Preserve the PTY output as bytes for the frontend. UTF-8 codepoints
                        // can be split across arbitrary PTY reads; decoding each `fill_buf()`
                        // chunk with `from_utf8_lossy` would permanently turn split box-drawing
                        // chars (e.g. `─` = E2 94 80) into U+FFFD. The xterm UI decodes this
                        // byte stream incrementally with `TextDecoder`, matching VS Code/Cursor.
                        //
                        // Adaptive emit cap: when the frontend reports slow render times
                        // (render_ms > 8), limit the bytes we consume per read so the
                        // frontend scheduler's adaptive chunk sizing has room to work.
                        // At render_ms == 0 (no telemetry yet) we use the full buffer.
                        let render_ms = frontend_render_ms.load(Ordering::Relaxed);
                        let emit_cap: usize = if render_ms > 8 {
                            // Slow renderer — cap at 16 KB per PTY read
                            16 * 1024
                        } else if render_ms > 4 {
                            // Medium load — cap at 64 KB
                            64 * 1024
                        } else {
                            // Fast renderer or no telemetry — no cap (use full buffer)
                            usize::MAX
                        };

                        // Avoid a heap allocation when the full buffer fits
                        // within the emit cap — the common case for a fast renderer.
                        let emit_slice = if data.len() <= emit_cap {
                            data
                        } else {
                            &data[..emit_cap]
                        };
                        let data_len = emit_slice.len();
                        let seq_start = stream_seq;

                        *last_output_at
                            .lock()
                            .expect("last_output_at mutex poisoned") = Some(Utc::now());

                        if detached.load(Ordering::Relaxed) {
                            // No listener: skip emission and flow-control
                            // accounting. Output still accrues in the snapshot
                            // below, and the next attach reports it as missed.
                            missed_while_detached.fetch_add(data_len, Ordering::Relaxed);
                        } else {
                            // base64 body instead of a JSON integer array: the
                            // webview parses ~1.33x the raw size instead of a
                            // 3-5x digits-and-commas payload per chunk.
                            match app_clone.emit(
                                &output_event,
                                serde_json::json!({
                                    "b64": BASE64_STANDARD.encode(emit_slice),
                                    "byte_count": data_len,
                                    "seq": seq_start,
                                }),
                            ) {
                                // Only delivered bytes count toward the
                                // flow-control window — a failed emit is never
                                // ACKed and would shrink the window forever.
                                Ok(()) => {
                                    unacked_bytes.fetch_add(data_len, Ordering::Relaxed);
                                }
                                Err(err) => {
                                    warn!(
                                        "[terminal] Failed to emit output event {}: {}",
                                        output_event, err
                                    );
                                }
                            }
                        }

                        // from_utf8_lossy borrows for valid UTF-8 (no alloc) — used only
                        // for the redacted snapshot and only when needed.
                        let data_text = String::from_utf8_lossy(emit_slice);
                        {
                            let mut snapshot = redacted_output
                                .lock()
                                .expect("redacted_output mutex poisoned");
                            append_redacted_bounded(
                                &mut snapshot,
                                &data_text,
                                MAX_REDACTED_SNAPSHOT_CHARS,
                            );
                            // covers_seq is only touched under this lock so
                            // snapshot text and covered offset stay consistent
                            // for attach_pty_stream.
                            covers_seq.store(seq_start + data_len as u64, Ordering::Relaxed);
                        }
                        stream_seq += data_len as u64;

                        // Send raw bytes through the tap channel. Arc<[u8]> clone is O(1);
                        // the receiver decodes UTF-8 lazily when it needs text. A SendError
                        // just means no receivers are currently subscribed, which is valid.
                        if let Some(ref tap) = output_tap {
                            let chunk: Arc<[u8]> = Arc::from(emit_slice);
                            if tap.send(chunk).is_err() {
                                tracing::trace!("[terminal] output_tap has no subscribers");
                            }
                        }

                        reader_lock.consume(data_len);
                        drop(reader_lock);

                        empty_reads = 0;
                    } else {
                        drop(reader_lock);
                        empty_reads = empty_reads.saturating_add(1);

                        let sleep_ms = match empty_reads {
                            0..=5 => 1,
                            6..=20 => 5,
                            21..=100 => 16,
                            _ => 50,
                        };
                        tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
                    }
                }
                Err(_) => {
                    break;
                }
            }
        }

        if let Err(err) = app_clone.emit(&exit_event, ()) {
            warn!(
                "[terminal] Failed to emit exit event {}: {}",
                exit_event, err
            );
        }
    });

    Ok(())
}

/// Write raw data to a PTY session.
///
/// Used by both the `write_pty` Tauri command and `exec_in_pty` internally.
pub async fn write_to_session(
    session_id: &str,
    data: &str,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
) -> Result<(), String> {
    let session_map = sessions.lock().await;
    let session = session_map
        .get(session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let mut writer = session.writer.lock().await;
    write!(writer, "{}", data).map_err(|err| format!("Failed to write to PTY: {}", err))?;
    writer
        .flush()
        .map_err(|err| format!("Failed to flush PTY: {}", err))?;

    Ok(())
}

/// Close and remove a PTY session.
///
/// Waits a short grace period so the reader task can flush any remaining
/// output before the session is dropped.
pub async fn close_session(
    session_id: &str,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
) -> Result<(), String> {
    tokio::time::sleep(Duration::from_millis(CLOSE_FLUSH_MS)).await;
    let mut session_map = sessions.lock().await;
    // Dropping the session closes the PTY master, terminating the child process.
    session_map.remove(session_id);
    Ok(())
}

/// Create an agent PTY session with default dimensions.
///
/// Convenience wrapper for `create_session` with agent-appropriate defaults.
pub async fn create_agent_session(
    session_id: String,
    cwd: Option<String>,
    app_handle: AppHandle,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
) -> Result<broadcast::Sender<Arc<[u8]>>, String> {
    let (output_tap, _) = broadcast::channel(AGENT_OUTPUT_TAP_CAPACITY);
    create_session(CreateSessionParams {
        session_id,
        rows: DEFAULT_AGENT_ROWS,
        cols: DEFAULT_AGENT_COLS,
        cwd,
        shell: None,
        args: None,
        env: None,
        strict_env: false,
        name: None,
        app_handle,
        sessions,
        output_tap: Some(output_tap.clone()),
    })
    .await?;
    Ok(output_tap)
}

// ============================================
// Helpers
// ============================================

/// Clean up raw PTY output by removing ANSI escape sequences
/// and trimming leading/trailing whitespace.
pub fn clean_pty_output(output: &str) -> String {
    // Strip common ANSI escape sequences
    let mut result = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Skip ESC sequence
            if let Some(&next) = chars.peek() {
                if next == '[' {
                    chars.next(); // consume '['
                                  // Skip until we hit a letter (the command terminator)
                    while let Some(&param) = chars.peek() {
                        if param.is_ascii_alphabetic() || param == '~' {
                            chars.next();
                            break;
                        }
                        chars.next();
                    }
                    continue;
                } else if next == ']' {
                    chars.next(); // consume ']'
                                  // OSC sequence — skip until BEL (\x07) or ST (\x1b\\)
                    while let Some(osc_char) = chars.next() {
                        if osc_char == '\x07' {
                            break;
                        }
                        if osc_char == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                    continue;
                }
            }
        }
        // Keep carriage returns as they may be meaningful
        result.push(ch);
    }

    result.trim().to_string()
}

/// Truncate output to max size, preserving the end. Always cuts on a UTF-8
/// char boundary so multi-byte chars (✓, emoji, CJK, etc.) never panic.
pub fn truncate_output(output: &str) -> String {
    if output.len() <= MAX_OUTPUT_CHARS {
        return output.to_string();
    }

    let mut offset = output.len() - MAX_OUTPUT_CHARS;
    while offset < output.len() && !output.is_char_boundary(offset) {
        offset += 1;
    }
    let truncated = &output[offset..];
    let start = truncated.find('\n').unwrap_or(0);
    format!(
        "[...truncated {} chars...]\n{}",
        offset,
        &truncated[start..]
    )
}

#[cfg(test)]
#[path = "../tests/agent_tool_tests.rs"]
mod tests;

/// Simple shell escape for paths (wraps in single quotes).
fn shell_escape(input: &str) -> String {
    // Replace single quotes in path with escaped version
    let escaped = input.replace('\'', "'\\''");
    format!("'{}'", escaped)
}
