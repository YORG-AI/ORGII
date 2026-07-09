//! PTY (Pseudo-Terminal) Module
//!
//! Provides integrated terminal functionality using native PTY on each platform.
//! Sessions are managed server-side and stream output to the frontend via Tauri events.
//!
//! # Architecture
//!
//! ```text
//! Frontend (React)                    Backend (Rust)
//! ┌─────────────────┐                ┌─────────────────┐
//! │  Terminal UI    │◄──events─────-─│   PtySession    │
//! │  (xterm.js)     │                │  ┌───────────┐  │
//! │                 │───invoke──────►│  │ PTY Master│  │
//! │                 │  write_pty     │  └─────┬─────┘  │
//! └─────────────────┘                │        │        │
//!                                    │  ┌─────▼─────┐  │
//!                                    │  │   Shell   │  │
//!                                    │  │ (zsh/bash)│  │
//!                                    │  └───────────┘  │
//!                                    └─────────────────┘
//! ```
//!
//! # Events
//!
//! - `pty-output-{session_id}`: Emitted when the PTY produces output (JSON: `{ bytes: number[], byte_count: number }`)
//! - `pty-exit-{session_id}`: Emitted when the PTY session terminates
//!
//! # Session Lifecycle
//!
//! 1. Frontend calls `create_pty` with session ID, dimensions, and optional shell/cwd
//! 2. Backend spawns PTY with shell process and starts output reader task
//! 3. Frontend sends keystrokes via `write_pty`
//! 4. Backend streams output back via `pty-output-{session_id}` events
//! 5. Frontend calls `close_pty` or session ends when shell exits
//!
//! # Platform Support
//!
//! - **macOS/Linux**: Uses `zsh` as default shell with `-il` flags (interactive login)
//! - **Windows**: Uses `powershell.exe` as default shell

use chrono::{DateTime, Utc};
use portable_pty::{PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufReader, Read, Write},
    sync::{
        atomic::{AtomicU32, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{async_runtime::Mutex as AsyncMutex, AppHandle, State};
use tokio::sync::{broadcast, Notify};

use super::shells::ShellKind;

// ============================================
// Request Types
// ============================================

/// Request payload for creating a new PTY session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePtyRequest {
    /// Unique identifier for this terminal session (e.g., "terminal-pty-1768913809817")
    pub session_id: String,
    /// Number of rows (height) for the terminal
    pub rows: u16,
    /// Number of columns (width) for the terminal
    pub cols: u16,
    /// Working directory to start the shell in (optional)
    pub cwd: Option<String>,
    /// Shell executable to use (optional, defaults to zsh/powershell)
    pub shell: Option<String>,
    /// Shell arguments (overrides default `-il` for Unix shells)
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Custom environment variables to set in the terminal
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// When true, do NOT inherit the parent process environment.
    /// Only `env` vars + TERM will be set.
    #[serde(default)]
    pub strict_env: Option<bool>,
    /// User-assigned display name for this terminal (e.g., "Dev Server")
    #[serde(default)]
    pub name: Option<String>,
}

/// Request payload for resizing an existing PTY session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResizePtyRequest {
    /// Session ID of the terminal to resize
    pub session_id: String,
    /// New number of rows
    pub rows: u16,
    /// New number of columns
    pub cols: u16,
}

// ============================================
// Session State
// ============================================

/// Represents an active PTY session with its I/O handles.
///
/// Each session owns:
/// - The PTY master/slave pair
/// - A writer for sending input to the shell
/// - A buffered reader for receiving output from the shell
pub struct PtySession {
    /// The PTY master/slave pair (platform-specific implementation)
    pub pty_pair: Arc<AsyncMutex<PtyPair>>,
    /// Writer handle for sending input to the PTY (keystrokes, commands)
    pub writer: Arc<AsyncMutex<Box<dyn Write + Send>>>,
    /// Buffered reader for receiving output from the PTY
    pub reader: Arc<AsyncMutex<BufReader<Box<dyn Read + Send>>>>,
    /// Process ID of the shell (derived from session ID for display purposes)
    pub pid: Option<u32>,
    /// Shell executable being used (e.g., "/bin/zsh", "powershell.exe")
    pub shell: String,
    /// Detected shell kind for profile display
    pub shell_kind: ShellKind,
    /// Working directory the shell was started in
    pub cwd: Option<String>,
    /// User-assigned display name (e.g., "Dev Server")
    pub name: Option<String>,
    /// Optional broadcast channel for tapping raw PTY output bytes (used by OS agent).
    /// When present, the reader task sends output here in addition to byte-stream Tauri events.
    /// Callers decode UTF-8 lazily only when they need text.
    pub output_tap: Option<broadcast::Sender<Arc<[u8]>>>,
    /// Bytes emitted to the frontend but not yet acknowledged.
    /// Used for backpressure: reader pauses when this exceeds HIGH_WATERMARK.
    pub unacked_bytes: Arc<AtomicUsize>,
    /// Notifier woken by ack_pty_data so the reader task can resume immediately
    /// without busy-sleeping. Replaces the fixed BACKPRESSURE_SLEEP_MS polling loop.
    pub ack_notify: Arc<Notify>,
    /// Latest render time reported by the frontend ACK (milliseconds, rounded).
    /// The reader uses this to emit smaller PTY chunks when the renderer is slow.
    pub frontend_render_ms: Arc<AtomicU32>,
    /// UTC timestamp when the PTY session was created.
    pub created_at: DateTime<Utc>,
    /// UTC timestamp of the latest PTY output chunk observed by the reader task.
    pub last_output_at: Arc<Mutex<Option<DateTime<Utc>>>>,
    /// Bounded redacted text snapshot of recent PTY output for agent inspection.
    pub redacted_output: Arc<Mutex<String>>,
}

/// Global state container for all PTY sessions.
///
/// Managed by Tauri and accessed via `State<PtyState>` in command handlers.
/// Sessions are stored in a HashMap keyed by session ID.
pub struct PtyState {
    /// Map of session_id -> PtySession
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
}

impl PtyState {
    /// Create a new empty PTY state container.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }

    /// Get a shared reference to the sessions map.
    ///
    /// Used to share the sessions between `PtyState` (Tauri managed state)
    /// and the OS agent's `ExecTool` (which needs direct access for PTY operations).
    pub fn sessions_arc(&self) -> Arc<AsyncMutex<HashMap<String, PtySession>>> {
        self.sessions.clone()
    }
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================
// Tauri Commands
// ============================================

/// Create a new PTY session and start the shell process.
///
/// Delegates to `tool_service::terminal::create_session()` — the shared
/// implementation used by both this Tauri command and the OS agent.
///
/// # Events Emitted
///
/// - `pty-output-{session_id}`: Streamed continuously as the shell produces output
/// - `pty-exit-{session_id}`: Emitted once when the session terminates
#[tauri::command]
pub async fn create_pty(
    request: serde_json::Value,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    // Handle both { request: {...} } and direct {...} formats
    let req: CreatePtyRequest = if request.get("request").is_some() {
        serde_json::from_value(request["request"].clone())
            .map_err(|err| format!("Failed to parse request: {}", err))?
    } else {
        serde_json::from_value(request)
            .map_err(|err| format!("Failed to parse request: {}", err))?
    };

    crate::agent_tool::create_session(crate::agent_tool::CreateSessionParams {
        session_id: req.session_id,
        rows: req.rows,
        cols: req.cols,
        cwd: req.cwd,
        shell: req.shell,
        args: req.args,
        env: req.env,
        strict_env: req.strict_env.unwrap_or(false),
        name: req.name,
        app_handle: app,
        sessions: state.inner().sessions_arc(),
        output_tap: None,
    })
    .await
}

/// Write data (keystrokes, commands) to an existing PTY session.
///
/// Delegates to `tool_service::terminal::write_to_session()`.
#[tauri::command]
pub async fn write_pty(
    session_id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    crate::agent_tool::write_to_session(&session_id, &data, state.inner().sessions_arc()).await
}

/// Resize an existing PTY session.
///
/// Called when the terminal UI is resized. Updates the PTY dimensions
/// so the shell can correctly wrap output and handle cursor positioning.
#[tauri::command]
pub async fn resize_pty(
    request: serde_json::Value,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    // Handle both { request: {...} } and direct {...} formats
    let req: ResizePtyRequest = if request.get("request").is_some() {
        serde_json::from_value(request["request"].clone())
            .map_err(|e| format!("Failed to parse request: {}", e))?
    } else {
        serde_json::from_value(request).map_err(|e| format!("Failed to parse request: {}", e))?
    };

    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&req.session_id)
        .ok_or_else(|| format!("Session {} not found", req.session_id))?;

    let pty_pair = session.pty_pair.lock().await;
    pty_pair
        .master
        .resize(PtySize {
            rows: req.rows,
            cols: req.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

/// Close and terminate a PTY session.
///
/// Delegates to `tool_service::terminal::close_session()`.
#[tauri::command]
pub async fn close_pty(session_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    crate::agent_tool::close_session(&session_id, state.inner().sessions_arc()).await
}

/// Check if a PTY session exists (for reconnection after navigation)
#[tauri::command]
pub async fn check_pty_exists(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<bool, String> {
    let sessions = state.inner().sessions.lock().await;
    Ok(sessions.contains_key(&session_id))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyInfo {
    pub session_id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub shell_kind: ShellKind,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_output_at: Option<DateTime<Utc>>,
    pub has_output_tap: bool,
    pub unacked_bytes: usize,
    pub redacted_output_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutputSnapshot {
    pub output: String,
    pub unacked_bytes: usize,
}

fn pty_info_from_session(session_id: &str, session: &PtySession) -> PtyInfo {
    PtyInfo {
        session_id: session_id.to_string(),
        pid: session.pid,
        shell: session.shell.clone(),
        shell_kind: session.shell_kind.clone(),
        cwd: session.cwd.clone(),
        name: session.name.clone(),
        created_at: session.created_at,
        last_output_at: *session
            .last_output_at
            .lock()
            .expect("last_output_at mutex poisoned"),
        has_output_tap: session.output_tap.is_some(),
        unacked_bytes: session.unacked_bytes.load(Ordering::Relaxed),
        redacted_output_chars: session
            .redacted_output
            .lock()
            .expect("redacted_output mutex poisoned")
            .chars()
            .count(),
    }
}

/// List all live PTY sessions (lightweight summary for frontend reconciliation).
///
/// Called on frontend startup to discover which PTYs survived a hot reload.
#[tauri::command]
pub async fn list_pty_sessions(state: State<'_, PtyState>) -> Result<Vec<PtyInfo>, String> {
    let sessions = state.inner().sessions.lock().await;
    Ok(sessions
        .iter()
        .map(|(id, session)| pty_info_from_session(id, session))
        .collect())
}

/// Get PTY session information (PID, shell, working directory, name)
#[tauri::command]
pub async fn get_pty_info(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<PtyInfo, String> {
    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    Ok(pty_info_from_session(&session_id, session))
}

/// Get the recent output snapshot for a live PTY session.
#[tauri::command]
pub async fn get_pty_output_snapshot(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<PtyOutputSnapshot, String> {
    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let output = session
        .redacted_output
        .lock()
        .expect("redacted_output mutex poisoned")
        .clone();
    let unacked_bytes = session.unacked_bytes.load(Ordering::Relaxed);

    Ok(PtyOutputSnapshot {
        output,
        unacked_bytes,
    })
}

// ============================================
// Live Process Inspection
// ============================================

/// Information about the foreground process running in a PTY session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForegroundProcessInfo {
    /// Name of the foreground process (e.g., "node", "cargo", "python")
    pub process_name: Option<String>,
    /// PID of the foreground process
    pub pid: Option<u32>,
    /// Current working directory of the foreground process
    pub cwd: Option<String>,
}

/// Get the foreground process running in a PTY session.
///
/// On macOS, uses `libproc` to query the foreground process group.
/// On Linux, reads `/proc/{pid}/stat` to get the foreground PID, then
/// `/proc/{fg_pid}/comm` for the name and `/proc/{fg_pid}/cwd` for directory.
#[tauri::command]
pub async fn get_pty_foreground_process(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<ForegroundProcessInfo, String> {
    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let shell_pid = session
        .pid
        .ok_or_else(|| "No PID for session".to_string())?;

    drop(sessions);

    tokio::task::spawn_blocking(move || get_foreground_process_info(shell_pid))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Get the live working directory of a PTY session's shell process.
///
/// The shell may have changed directory since creation via `cd`.
#[tauri::command]
pub async fn get_pty_cwd(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<Option<String>, String> {
    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let shell_pid = match session.pid {
        Some(pid) => pid,
        None => return Ok(session.cwd.clone()),
    };

    drop(sessions);

    tokio::task::spawn_blocking(move || get_process_cwd(shell_pid))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

// ============================================
// Platform-specific process inspection
// ============================================

/// Get information about the foreground process in a terminal session.
fn get_foreground_process_info(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    #[cfg(target_os = "macos")]
    {
        get_foreground_process_macos(shell_pid)
    }
    #[cfg(target_os = "linux")]
    {
        get_foreground_process_linux(shell_pid)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = shell_pid;
        Ok(ForegroundProcessInfo {
            process_name: None,
            pid: None,
            cwd: None,
        })
    }
}

#[cfg(target_os = "macos")]
fn get_foreground_process_macos(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    use std::process::Command;

    // Get child processes of the shell — the most recently spawned is the foreground
    let output = Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map_err(|err| format!("pgrep failed: {}", err))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let child_pids: Vec<u32> = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();

    // If no children, the shell itself is the foreground process
    let fg_pid = child_pids.last().copied().unwrap_or(shell_pid);

    let process_name = get_process_name_ps(fg_pid);
    let cwd = get_process_cwd(fg_pid).ok().flatten();

    Ok(ForegroundProcessInfo {
        process_name,
        pid: Some(fg_pid),
        cwd,
    })
}

#[cfg(target_os = "linux")]
fn get_foreground_process_linux(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    // Read /proc/{pid}/stat to get the foreground process group (field 8, tpgid)
    let stat_path = format!("/proc/{}/stat", shell_pid);
    let stat_content = std::fs::read_to_string(&stat_path)
        .map_err(|err| format!("Failed to read {}: {}", stat_path, err))?;

    let fg_pid = parse_tpgid_from_stat(&stat_content).unwrap_or(shell_pid);

    let process_name = std::fs::read_to_string(format!("/proc/{}/comm", fg_pid))
        .ok()
        .map(|name| name.trim().to_string());

    let cwd = get_process_cwd(fg_pid).ok().flatten();

    Ok(ForegroundProcessInfo {
        process_name,
        pid: Some(fg_pid),
        cwd,
    })
}

/// Parse the tpgid (terminal foreground process group ID) from /proc/{pid}/stat.
/// Field 8 (0-indexed: 7) is tpgid. Fields are space-separated but field 2 (comm)
/// is wrapped in parentheses and may contain spaces.
#[cfg(target_os = "linux")]
fn parse_tpgid_from_stat(stat_content: &str) -> Option<u32> {
    // Skip past the comm field which is in parentheses
    let after_comm = stat_content.rfind(')')?;
    let fields_after_comm: Vec<&str> = stat_content[after_comm + 2..].split_whitespace().collect();
    // After `)`, fields are: state(0), ppid(1), pgrp(2), session(3), tty_nr(4), tpgid(5)
    fields_after_comm.get(5)?.parse::<u32>().ok()
}

/// Get process name via `ps` command (portable across macOS/Linux).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn get_process_name_ps(pid: u32) -> Option<String> {
    use std::process::Command;
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        // Strip path prefix — ps may return "/usr/local/bin/node"
        Some(name.rsplit('/').next().unwrap_or(&name).to_string())
    }
}

/// Get the current working directory of a process.
fn get_process_cwd(pid: u32) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("lsof")
            .args(["-p", &pid.to_string(), "-Fn", "-d", "cwd"])
            .output()
            .map_err(|err| format!("lsof failed: {}", err))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // lsof -Fn outputs lines like "p12345\nn/path/to/cwd"
        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix('n') {
                if path != "/" && !path.is_empty() {
                    return Ok(Some(path.to_string()));
                }
            }
        }
        Ok(None)
    }
    #[cfg(target_os = "linux")]
    {
        let link = format!("/proc/{}/cwd", pid);
        match std::fs::read_link(&link) {
            Ok(path) => Ok(Some(path.to_string_lossy().to_string())),
            Err(_) => Ok(None),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = pid;
        Ok(None)
    }
}

/// Acknowledge that the frontend has processed `byte_count` bytes of PTY output.
///
/// The `queue_depth` and `render_ms` telemetry fields are optional and come
/// from the frontend scheduler. When present they allow the reader task to
/// wake immediately (via `Notify`) instead of sleeping on a fixed poll interval,
/// and let the reader adjust its emit cadence based on renderer load.
#[tauri::command]
pub async fn ack_pty_data(
    session_id: String,
    byte_count: usize,
    queue_depth: Option<usize>,
    render_ms: Option<u32>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.inner().sessions.lock().await;
    if let Some(session) = sessions.get(&session_id) {
        let prev = session.unacked_bytes.load(Ordering::Relaxed);
        let new_val = prev.saturating_sub(byte_count);
        session.unacked_bytes.store(new_val, Ordering::Relaxed);

        // Update render telemetry so the reader can adapt emit rate.
        if let Some(rms) = render_ms {
            session.frontend_render_ms.store(rms, Ordering::Relaxed);
        }

        // Only notify if we might have crossed the LOW_WATERMARK — avoids
        // spurious wakeups when the reader is not currently suspended.
        let _ = queue_depth; // captured for future use (e.g. adaptive send window)
        if new_val < crate::agent_tool::LOW_WATERMARK {
            session.ack_notify.notify_one();
        }
    }
    Ok(())
}

/// Memory usage for a single PTY session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyMemoryInfo {
    pub session_id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub memory_mb: f64,
    pub buffer_bytes: usize,
    pub scrollback_lines: usize,
}

/// Get memory usage for all active PTY sessions
#[tauri::command]
pub async fn get_pty_memory_usage(
    state: State<'_, PtyState>,
) -> Result<Vec<PtyMemoryInfo>, String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let sessions = state.inner().sessions.lock().await;

    if sessions.is_empty() {
        return Ok(vec![]);
    }

    // Collect PIDs that need to be queried
    let pids_to_query: Vec<(String, u32, String, usize)> = sessions
        .iter()
        .filter_map(|(session_id, session)| {
            session.pid.map(|pid| {
                (
                    session_id.clone(),
                    pid,
                    session.shell.clone(),
                    session.unacked_bytes.load(Ordering::Relaxed),
                )
            })
        })
        .collect();

    if pids_to_query.is_empty() {
        return Ok(sessions
            .iter()
            .map(|(session_id, session)| PtyMemoryInfo {
                session_id: session_id.clone(),
                pid: session.pid,
                shell: session.shell.clone(),
                memory_mb: 0.0,
                buffer_bytes: session.unacked_bytes.load(Ordering::Relaxed),
                scrollback_lines: 0,
            })
            .collect());
    }

    // Query memory for each PID
    let mut sys = System::new();
    let pid_list: Vec<Pid> = pids_to_query
        .iter()
        .map(|(_, pid, _, _)| Pid::from_u32(*pid))
        .collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pid_list),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let result: Vec<PtyMemoryInfo> = pids_to_query
        .iter()
        .map(|(session_id, pid, shell, buffer_bytes)| {
            let memory_mb = sys
                .process(Pid::from_u32(*pid))
                .map(|p| p.memory() as f64 / 1024.0 / 1024.0)
                .unwrap_or(0.0);

            PtyMemoryInfo {
                session_id: session_id.clone(),
                pid: Some(*pid),
                shell: shell.clone(),
                memory_mb,
                buffer_bytes: *buffer_bytes,
                scrollback_lines: 0,
            }
        })
        .collect();

    Ok(result)
}
