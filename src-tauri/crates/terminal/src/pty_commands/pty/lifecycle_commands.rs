//! Tauri commands driving a PTY session's life: spawn, write, resize, close,
//! and the attach/detach/ack handshake that governs output flow control.

use portable_pty::PtySize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

use super::state::PtyState;
use super::types::{AttachPtyStream, CreatePtyRequest, ResizePtyRequest};

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
