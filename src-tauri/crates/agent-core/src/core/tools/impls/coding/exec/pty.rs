//! PTY execution path: persistent terminal for interactive commands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::AppHandle;
use tokio::sync::broadcast;
use tracing::info;

type TapSender = broadcast::Sender<Arc<[u8]>>;
type TapReceiver = broadcast::Receiver<Arc<[u8]>>;

use crate::tools::traits::ToolError;
use ::terminal::pty_commands::pty::PtySession;

/// Prefix for agent-owned persistent terminal PTY IDs.
pub const AGENT_PTY_SESSION_PREFIX: &str = "agent-pty-";

/// PTY resources (optional — only needed when interactive mode is used).
pub struct PtyResources {
    pub sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    pub app_handle: AppHandle,
    pub initialized_sessions: Arc<parking_lot::Mutex<HashSet<String>>>,
}

impl PtyResources {
    pub fn new(
        sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
        app_handle: AppHandle,
    ) -> Self {
        Self {
            sessions,
            app_handle,
            initialized_sessions: Arc::new(parking_lot::Mutex::new(HashSet::new())),
        }
    }
}

pub fn pty_session_id_for_agent(session_key: &str) -> String {
    format!("{AGENT_PTY_SESSION_PREFIX}{session_key}")
}

/// Initialize the PTY session (lazy, on first interactive command).
pub async fn ensure_pty_initialized(
    pty: &PtyResources,
    pty_session_id: &str,
    agent_session_id: &str,
    working_dir: &Path,
) -> Result<TapSender, String> {
    {
        let mut sessions = pty.sessions.lock().await;
        if let Some(session) = sessions.get(pty_session_id) {
            pty.initialized_sessions
                .lock()
                .insert(pty_session_id.to_string());
            if let Some(output_tap) = session.output_tap.clone() {
                return Ok(output_tap);
            }
        }

        sessions.remove(pty_session_id);
    }

    {
        let mut initialized = pty.initialized_sessions.lock();
        initialized.remove(pty_session_id);
    }

    info!("[ExecTool] Initializing PTY session: {}", pty_session_id);

    let output_tap = crate::tool_infra::terminal::create_agent_session(
        pty_session_id.to_string(),
        Some(working_dir.to_string_lossy().to_string()),
        pty.app_handle.clone(),
        pty.sessions.clone(),
    )
    .await?;

    ::terminal::agent_tool::write_to_session(
        pty_session_id,
        "unsetopt BANG_HIST 2>/dev/null\nset +H 2>/dev/null\n",
        pty.sessions.clone(),
    )
    .await?;

    pty.initialized_sessions
        .lock()
        .insert(pty_session_id.to_string());

    crate::bus::broadcast_event(
        "agent:terminal_created",
        serde_json::json!({
            "sessionId": agent_session_id,
            "ptySessionId": pty_session_id,
        }),
    );

    tokio::time::sleep(Duration::from_millis(500)).await;

    Ok(output_tap)
}

/// Execute a command in the persistent PTY session.
///
/// When `wait_secs` is `Some(N)`, spawns `exec_in_pty` as a background task
/// and collects partial output via a parallel broadcast subscriber.
pub async fn execute_via_pty(
    pty: &PtyResources,
    command: &str,
    work_dir: Option<&PathBuf>,
    timeout_secs: u64,
    wait_secs: Option<u64>,
    working_dir: &Path,
    agent_session_id: &str,
) -> Result<String, ToolError> {
    let pty_session_id = pty_session_id_for_agent(agent_session_id);
    let output_tap = ensure_pty_initialized(pty, &pty_session_id, agent_session_id, working_dir)
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("PTY init failed: {}", err)))?;

    if wait_secs.is_none() {
        let mut output_rx: TapReceiver = output_tap.subscribe();
        let timeout = Duration::from_secs(timeout_secs);

        match crate::tool_infra::terminal::exec_in_pty(
            command,
            work_dir,
            &pty_session_id,
            pty.sessions.clone(),
            &mut output_rx,
            timeout,
        )
        .await
        {
            Ok((output, exit_code)) => {
                if exit_code != 0 {
                    Ok(format!("{}\n[exit code: {}]", output, exit_code))
                } else if output.is_empty() {
                    Ok("(no output)".to_string())
                } else {
                    Ok(output)
                }
            }
            Err(_) => Ok(format!(
                "[command still running in terminal after {}s]\n\
                    The command continues in the interactive terminal (visible to user).\n\
                    Call run_shell again later to run a follow-up command.",
                timeout_secs,
            )),
        }
    } else {
        let effective_wait = wait_secs.unwrap_or(timeout_secs);

        let mut partial_rx: TapReceiver = output_tap.subscribe();

        let output_tap_clone = output_tap.clone();
        let sessions = pty.sessions.clone();
        let pty_session_id_for_task = pty_session_id.clone();
        let cmd = command.to_string();
        let wd = work_dir.cloned();
        let full_timeout = Duration::from_secs(timeout_secs);

        let exec_handle = tokio::spawn(async move {
            let mut rx: TapReceiver = output_tap_clone.subscribe();
            crate::tool_infra::terminal::exec_in_pty(
                &cmd,
                wd.as_ref(),
                &pty_session_id_for_task,
                sessions,
                &mut rx,
                full_timeout,
            )
            .await
        });

        let mut partial_output = String::new();
        let wait_deadline = tokio::time::Instant::now() + Duration::from_secs(effective_wait);

        loop {
            if exec_handle.is_finished() {
                let result = exec_handle
                    .await
                    .map_err(|err| {
                        ToolError::ExecutionFailed(format!("PTY task panicked: {}", err))
                    })?
                    .map_err(ToolError::ExecutionFailed)?;
                let (output, exit_code) = result;

                if exit_code != 0 {
                    return Ok(format!("{}\n[exit code: {}]", output, exit_code));
                } else if output.is_empty() {
                    return Ok("(no output)".to_string());
                } else {
                    return Ok(output);
                }
            }

            let remaining = wait_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                exec_handle.abort();

                let cleaned = crate::tool_infra::terminal::clean_pty_output(&partial_output);
                let truncated = crate::tool_infra::terminal::truncate_output(&cleaned);

                return Ok(format!(
                    "{}\n\n\
                    [command still running in terminal after {}s]\n\
                    The command continues in the interactive terminal (visible to user).\n\
                    Call run_shell again later to run a follow-up command.",
                    if truncated.is_empty() {
                        "(no output yet)".to_string()
                    } else {
                        truncated
                    },
                    effective_wait,
                ));
            }

            match tokio::time::timeout(remaining.min(Duration::from_millis(500)), partial_rx.recv())
                .await
            {
                Ok(Ok(chunk)) => {
                    partial_output.push_str(&String::from_utf8_lossy(&chunk));
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    partial_output.push_str("[...some output lost...]\n");
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {}
            }
        }

        Err(ToolError::ExecutionFailed(
            "PTY broadcast channel closed unexpectedly".to_string(),
        ))
    }
}
