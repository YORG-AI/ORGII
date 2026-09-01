//! Read-only Tauri commands: session listings, output snapshots, live shell
//! process/cwd lookups, and per-session memory accounting.

use std::sync::atomic::Ordering;
use tauri::State;

use super::process_inspect::{get_foreground_process_info, get_process_cwd};
use super::state::PtyState;
use super::types::{
    pty_info_from_session, ForegroundProcessInfo, PtyInfo, PtyMemoryInfo, PtyOutputSnapshot,
};

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
