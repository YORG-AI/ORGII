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
//! - `pty-output-{session_id}`: Emitted when the PTY produces output
//!   (JSON: `{ b64, byte_count, seq }`)
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
use portable_pty::{Child, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufReader, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
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
    /// Shell's `start_time` (seconds since boot, sysinfo convention). Captured
    /// once at spawn and used by the app-exit sweep to tell our shell apart
    /// from a later PID-reuse holder. Meaningful on Unix; 0 and unused on
    /// Windows (whose sweep tree is shell+conhost only).
    pub start_time: u64,
    /// Owning handle to the spawned shell process. Held so `close_session`
    /// and `Drop` can kill it explicitly — dropping the PTY master alone does
    /// NOT reliably terminate the child on Windows ConPTY
    /// (`ClosePseudoConsole` only signals), which orphaned `conhost.exe` and
    /// the shell across app restarts. It is atomically `take()`n by either
    /// the reaper after a natural exit or `Drop`; the latter terminates and
    /// reaps it.
    pub child: Arc<Mutex<Option<Box<dyn Child + Send>>>>,
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
    /// True while no webview listener is attached. The reader skips event
    /// emission and does not grow `unacked_bytes`; output still accrues in
    /// `redacted_output` for the next attach.
    pub detached: Arc<AtomicBool>,
    /// Total PTY bytes represented in `redacted_output` (stream offset of its
    /// end). Read/written only while holding the `redacted_output` lock so
    /// snapshot text and offset stay consistent.
    pub covers_seq: Arc<AtomicU64>,
    /// Bytes read while detached since the last attach; tells the frontend
    /// whether its client-side buffer missed output.
    pub missed_while_detached: Arc<AtomicUsize>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Kill the spawned shell so it (and, on Windows, its ConPTY conhost
        // host) cannot outlive the session. `close_session` and the reader's
        // natural-exit path take() the child first; if either already did,
        // this is a no-op. Dropping the PTY master alone does NOT reliably
        // kill the child on Windows ConPTY — `ClosePseudoConsole` only
        // signals — so an explicit kill is required to avoid orphaned
        // conhost/shell processes accumulating across app restarts.
        let child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();

        if let Some(mut child) = child {
            // Termination must happen synchronously: when the app is exiting,
            // detached threads are not joined and may never get scheduled.
            // Session-removal paths move the session out of the map before
            // Drop, so portable-pty's Unix grace period does not hold the
            // session-map lock. Reaping may block, and is safe to defer.
            let _ = child.kill();
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

impl PtySession {
    /// Terminate a PTY child and wait until it has been reaped.
    ///
    /// Callers must invoke this outside the session-map lock. It may briefly
    /// block on Unix while portable-pty escalates from SIGHUP to SIGKILL.
    pub(crate) fn terminate_and_reap(mut child: Box<dyn Child + Send>) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Process-global registry of Unix session-leader PIDs (= shell PIDs, since
/// spawn calls `setsid()`) that must be swept on app exit.
///
/// Deliberately a process-global static, not a field on `PtyState`: a shell's
/// PID must remain sweepable AFTER its `PtySession` leaves the sessions map,
/// which happens in two paths that both predate app exit — the reader's
/// natural-EOF removal (shell exited, e.g. right after launching a backgrounded
/// `nohup` job) and `close_session` (user closed the tab). In both cases the
/// shell PID vanishes from the map, but HUP-immune descendants in its session
/// keep running until logout. Only the app-exit sweep is contracted to kill
/// them, so the SID must outlive the session.
///
/// Reached from `create_session` — where both creation paths (the user-facing
/// `create_pty` command and the OS-agent path) converge and where neither
/// agent call site has access to `PtyState` — by a single insert, and
/// consumed by `shutdown_kill_all`. PTY cleanup is inherently process-global
/// (one app process owns one set of descendants to sweep), so a static carries
/// no isolation risk that `PtyState`'s Tauri-managed singleton would not.
///
/// Lifetime: entries are added at shell spawn and removed only by the
/// app-exit sweep (`shutdown_kill_all` clears the whole registry). There is
/// intentionally NO `unregister` on natural session removal — removing an
/// entry the moment its shell exits would discard exactly the SID needed to
/// sweep that shell's still-living HUP-immune descendants, reintroducing the
/// leak this registry exists to close. A safe unregister would require
/// proving no live descendants remain, which cannot be done without a
/// process scan at removal time. Entries are 12 bytes each and bounded by
/// the app's lifetime terminal churn, so unbounded growth is not a concern.
///
/// Each entry pairs the PID with the shell's `start_time` (seconds since
/// boot). On app-exit sweep, a registered PID is treated as a sweep candidate
/// only if its current holder either no longer exists (shell dead, PID not
/// reused — its orphaned descendants are safe to sweep) or still has the
/// recorded `start_time` (our shell is still alive). If the PID now exists
/// with a different `start_time`, the OS reused it for an unrelated process
/// and we drop the candidate rather than risk killing the wrong session.
/// This closes the most direct PID-reuse mis-kill path; it is NOT a complete
/// proof — see [`shutdown_kill_all`] for the residual window.
#[cfg(unix)]
fn pending_exit_session_leaders() -> &'static std::sync::Mutex<std::collections::HashMap<u32, u64>>
{
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, u64>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Record a spawned shell's PID (== Unix session-leader id) together with its
/// `start_time`, so the app-exit sweep can still find its descendants after
/// the session leaves the map AND can tell the shell apart from a later
/// PID-reuse holder. `start_time` is seconds since boot (sysinfo convention);
/// callers obtain it from a fresh `System` snapshot taken immediately after
/// spawn so it reflects this shell, not a racing reuse.
#[cfg(unix)]
pub(crate) fn register_session_leader(pid: u32, start_time: u64) {
    if let Ok(mut reg) = pending_exit_session_leaders().lock() {
        reg.insert(pid, start_time);
    }
}

/// Decide whether a registered session leader is still a safe sweep
/// candidate given its current holder. Pure (no I/O) so it is unit-testable.
///
/// - `None` → the PID has no current holder: our shell died without the PID
///   being reused, so its orphaned descendants (still reporting `SID = pid`)
///   are safe to sweep.
/// - `Some(holder_start)` → the PID exists. If `holder_start` matches the
///   shell's recorded start_time it is still our shell; otherwise the OS
///   recycled the number and we refuse the candidate (prefer leaking a known
///   orphan over killing a stranger's session).
#[cfg(unix)]
fn leader_is_sweep_candidate(registered_start: u64, holder_start: Option<u64>) -> bool {
    match holder_start {
        None => true,
        Some(start) => start == registered_start,
    }
}

/// PIDs whose Unix sessions should be swept on app exit. Tracked (in-map)
/// and registered (already-removed) leaders are run through the SAME
/// `leader_is_sweep_candidate` identity check: an in-map session's shell may
/// already have been reaped (freeing its PID for reuse) while the reader
/// task still holds the session, so a live map entry is not proof its PID is
/// still ours.
///
/// `holder_start` resolves a PID to its current holder's start_time, so the
/// predicate sees the same view the sweep loop is about to iterate. It is a
/// closure (not `&System`) so unit tests can inject a synthetic holder map.
#[cfg(unix)]
fn collect_sweep_sids(
    tracked: impl Iterator<Item = (u32, u64)>,
    holder_start: impl Fn(u32) -> Option<u64>,
) -> std::collections::HashSet<u32> {
    let mut sids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    if let Ok(reg) = pending_exit_session_leaders().lock() {
        for (&pid, &registered_start) in reg.iter() {
            if leader_is_sweep_candidate(registered_start, holder_start(pid)) {
                sids.insert(pid);
            }
        }
    }
    for (pid, registered_start) in tracked {
        if leader_is_sweep_candidate(registered_start, holder_start(pid)) {
            sids.insert(pid);
        }
    }
    sids
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

    /// Kill every tracked PTY shell together with its entire Unix process
    /// session, then drop all sessions.
    ///
    /// App-exit only. Closing a single tab kills just the shell — a user may
    /// deliberately leave `nohup`-style descendants running. Once the app
    /// exits, though, nothing can manage those descendants: the kernel's
    /// SIGHUP on PTY close is only a polite notice, so HUP-immune processes
    /// would leak until logout.
    ///
    /// Also sweeps descendants of shells that already left the sessions map
    /// (tab closed, or shell exited naturally after launching a backgrounded
    /// job): their PIDs were registered at spawn and retained precisely so
    /// this exit sweep can still find the session. See
    /// [`pending_exit_session_leaders`].
    ///
    /// Must be called from a non-runtime thread (it blocks on the session
    /// map lock); the Tauri run-loop exit handler qualifies.
    ///
    /// Thread-safety: `self.sessions.blocking_lock()` calls
    /// `tokio::future::block_on`, which panics if the current thread is a
    /// tokio runtime worker. This is safe only because the sole caller is the
    /// `RunEvent::ExitRequested` callback, which Tauri runs synchronously on
    /// the main (wry/tao event-loop) thread — NOT a tokio async_runtime
    /// worker (those live in a separate thread pool). Do NOT call this from
    /// an `async fn`, a `spawn`/`spawn_blocking` task, or any context where
    /// a tokio runtime guard is entered; move it to a fresh `std::thread`
    /// before blocking on the lock.
    pub fn shutdown_kill_all(&self) {
        let drained: Vec<PtySession> = {
            let mut map = self.sessions.blocking_lock();
            map.drain().map(|(_, session)| session).collect()
        };

        // The shell was spawned via setsid(), so its PID is the session ID
        // of every descendant that has not detached into a session of its
        // own (a daemon's deliberate double-fork escape is respected). Sweep
        // by session, not by process group: an interactive shell's job
        // control puts each job in its own group, so killpg on the shell's
        // group would miss `bash -c ...`-style jobs entirely.
        //
        // Residual risk: the start_time guard on registered leaders closes
        // the most direct PID-reuse mis-kill path (a live process now holds
        // a recycled shell PID). It is NOT a complete proof. If the OS
        // recycled a dead shell's PID to a process Q that called setsid()
        // and forked descendants, and Q itself died before app exit, Q's
        // descendants still report `SID = <recycled PID>` while the PID is
        // currently free — indistinguishable from our dead shell. In that
        // daemon / session-launcher pattern we may mis-kill Q's orphans.
        // The policy is deliberate: when we cannot tell our orphans apart
        // from a stranger's, prefer leaking a known orphan over killing an
        // unrelated process's session.
        #[cfg(unix)]
        {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

            let mut sys = System::new();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );

            // Union live sessions with the registry of shells already removed
            // (closed tab / natural exit). BOTH paths run through the same
            // start_time identity check: an in-map session may already have
            // been reaped and its PID recycled, so neither is trusted blindly.
            let sids = collect_sweep_sids(
                drained
                    .iter()
                    .filter_map(|s| s.pid.map(|p| (p, s.start_time))),
                |pid| {
                    sys.process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.start_time())
                },
            );
            if !sids.is_empty() {
                let own_pid = std::process::id();
                for (pid, process) in sys.processes() {
                    let pid = pid.as_u32();
                    // Shells still in `drained` die via Drop below, which also
                    // reaps them; skip their own PIDs to avoid a redundant
                    // signal to a process we are about to own the exit of.
                    if pid == own_pid || sids.contains(&pid) {
                        continue;
                    }
                    if process
                        .session_id()
                        .is_some_and(|sid| sids.contains(&sid.as_u32()))
                    {
                        // SIGKILL directly: anything still here already
                        // ignored the kernel's SIGHUP, and a per-process
                        // grace period would block app exit.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                }
            }
            // Registry consumed by this exit sweep.
            if let Ok(mut reg) = pending_exit_session_leaders().lock() {
                reg.clear();
            }
        }

        // Drop kills each shell synchronously (required at app exit, where
        // detached threads are never joined). Windows tree cleanup beyond
        // the shell/conhost pair would need Job Objects; not covered here.
        drop(drained);
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

/// Response for `attach_pty_stream`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachPtyStream {
    /// Bounded, redacted snapshot of recent output (restore base).
    pub output: String,
    /// Stream offset covered by `output`. Live `pty-output` chunks whose
    /// `seq` is below this are already contained in the snapshot and must
    /// not be written again.
    pub covers_seq: u64,
    /// True when output was produced while no listener was attached — the
    /// frontend's client-side buffer (if any) is missing data and the
    /// snapshot must be used instead.
    pub missed_output: bool,
}

/// Attach the webview's event stream to a PTY session.
///
/// Called by the frontend after it has registered its `pty-output` listener
/// and before it writes the restore snapshot. Atomically:
/// - clears detached mode (event emission resumes),
/// - resets the flow-control window (a fresh listener starts with no debt —
///   this is what un-parks a reader stalled by ACKs lost to a dead listener),
/// - returns the snapshot together with the stream offset it covers.
#[tauri::command]
pub async fn attach_pty_stream(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<AttachPtyStream, String> {
    let sessions = state.inner().sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    // Resume emission before snapshotting: chunks emitted from here on are
    // deduplicated by covers_seq, whereas chunks read after a
    // snapshot-then-attach ordering would be in neither the snapshot nor the
    // event stream (lost).
    session.detached.store(false, Ordering::Relaxed);
    let missed_output = session.missed_while_detached.swap(0, Ordering::Relaxed) > 0;
    session.unacked_bytes.store(0, Ordering::Relaxed);
    session.ack_notify.notify_one();

    let (output, covers_seq) = {
        let snapshot = session
            .redacted_output
            .lock()
            .expect("redacted_output mutex poisoned");
        (snapshot.clone(), session.covers_seq.load(Ordering::Relaxed))
    };

    Ok(AttachPtyStream {
        output,
        covers_seq,
        missed_output,
    })
}

/// Detach the webview's event stream from a PTY session.
///
/// Called by the frontend when the terminal component unmounts while the
/// session keeps running. The reader stops emitting events (nobody is
/// listening) and stops accounting flow-control debt, so a background CLI
/// can keep producing output indefinitely without stalling on a window that
/// nothing will ever ACK. Missing a detach (e.g. webview hot reload) is
/// self-healing: the reader force-detaches after a stall timeout.
#[tauri::command]
pub async fn detach_pty_stream(
    session_id: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.inner().sessions.lock().await;
    // A detach may race session exit — silently succeed if already gone.
    if let Some(session) = sessions.get(&session_id) {
        session.detached.store(true, Ordering::Relaxed);
        session.unacked_bytes.store(0, Ordering::Relaxed);
        // Wake a parked reader so it observes detached mode and resumes.
        session.ack_notify.notify_one();
    }
    Ok(())
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

#[cfg(all(test, unix))]
mod tests {
    use super::{collect_sweep_sids, leader_is_sweep_candidate, pending_exit_session_leaders};
    use std::collections::HashMap;

    // The session-leader registry is a process-global static shared across
    // tests; this helper drains it so each case starts from a known state.
    fn reset_registry() {
        pending_exit_session_leaders()
            .lock()
            .expect("registry poisoned")
            .clear();
    }

    #[test]
    fn sweep_candidate_when_shell_dead_and_pid_not_reused() {
        // Shell PID gone, no holder: orphaned descendants are safe to sweep.
        assert!(leader_is_sweep_candidate(1000, None));
    }

    #[test]
    fn sweep_candidate_when_pid_still_held_by_our_shell() {
        // PID exists with the same start_time: still our shell.
        assert!(leader_is_sweep_candidate(1000, Some(1000)));
    }

    #[test]
    fn not_a_sweep_candidate_when_pid_reused_by_a_different_process() {
        // PID exists but start_time differs: the OS recycled the number to an
        // unrelated process. We refuse the candidate to avoid killing the
        // wrong session.
        assert!(!leader_is_sweep_candidate(1000, Some(2000)));
    }

    // The P2 race: an in-map session whose shell was already reaped AND whose
    // PID was recycled to a different process must NOT be swept blindly. This
    // is the exact scenario the reviewer flagged — tracked_pids used to bypass
    // the start_time check. Both tracked and registered paths must reject it.
    #[test]
    fn collect_sweep_sids_rejects_reused_pid_in_both_tracked_and_registered() {
        reset_registry();
        // Registered leader: shell exited, OS reused its PID for a process
        // with a different start_time.
        super::register_session_leader(100, 1000);
        // Tracked (in-map) session: shell reaped, PID recycled to a different
        // start_time while the reader still holds the session.
        let tracked = [(200u32, 2000u64)];

        // Synthetic holder map: PID 100 and 200 now exist but with different
        // start_times than the ones we registered — simulating PID reuse.
        let holders: HashMap<u32, u64> = [(100, 9999u64), (200, 8888u64)].into_iter().collect();
        let holder_start = |pid: u32| holders.get(&pid).copied();

        let sids = collect_sweep_sids(tracked.into_iter(), holder_start);

        assert!(
            !sids.contains(&100),
            "registered leader with reused PID must be excluded"
        );
        assert!(
            !sids.contains(&200),
            "tracked session with reused PID must be excluded (the P2 race)"
        );

        reset_registry();
    }

    #[test]
    fn collect_sweep_sids_keeps_shells_with_matching_or_absent_holder() {
        reset_registry();
        // Registered leader whose shell is still alive (start_time matches).
        super::register_session_leader(100, 1000);
        // Tracked session whose shell died without PID reuse (holder absent).
        let tracked = [(200u32, 2000u64)];

        // PID 100 still ours (start_time 1000); PID 200 gone.
        let holders: HashMap<u32, u64> = [(100, 1000u64)].into_iter().collect();
        let holder_start = |pid: u32| holders.get(&pid).copied();

        let sids = collect_sweep_sids(tracked.into_iter(), holder_start);
        assert!(sids.contains(&100), "live shell still ours is a candidate");
        assert!(
            sids.contains(&200),
            "dead shell with no PID reuse is a candidate (orphan sweep)"
        );

        reset_registry();
    }
}
