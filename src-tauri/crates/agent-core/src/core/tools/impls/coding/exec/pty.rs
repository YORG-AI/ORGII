//! PTY execution path: persistent terminal for interactive commands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::AppHandle;
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tracing::info;

use super::shell_replay::{
    complete_terminal_prefix_len, mark_writer_task_failure, ShellReplayStream, ShellReplayTarget,
    ShellReplayWriter, SHELL_REPLAY_FRAME_MAX_BYTES,
};
use super::subprocess::{broadcast_exec_output, broadcast_system_output, ExecIdentity};

type TapSender = broadcast::Sender<Arc<[u8]>>;
type TapReceiver = broadcast::Receiver<Arc<[u8]>>;

const PTY_COMPLETION_SAFETY_TIMEOUT_SECS: u64 = 60 * 60;

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

/// Inputs for one interactive execution. Keeping these together makes the
/// call boundary explicit as replay/cancellation concerns evolve.
pub(super) struct PtyExecutionRequest<'a> {
    pub command: &'a str,
    pub work_dir: Option<&'a PathBuf>,
    pub timeout_secs: u64,
    pub wait_secs: Option<u64>,
    pub working_dir: &'a Path,
    pub agent_session_id: &'a str,
    pub identity: &'a ExecIdentity,
    pub replay_root: &'a Path,
    pub cancel_flag: Option<Arc<AtomicBool>>,
}

#[derive(Clone)]
struct PtyCaptureFailureContext {
    pty_session_id: String,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    identity: ExecIdentity,
    replay_target: ShellReplayTarget,
    replay_path: PathBuf,
    app_handle: Option<AppHandle>,
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

/// Ensures dropping the outer tool future cannot detach an unrecorded PTY
/// command. Normal completion disarms the guard. Cancellation/drop marks the
/// exact replay incomplete synchronously and closes the agent-owned PTY from
/// the current runtime, which stops both detached tasks.
struct PtyReplaySupervisorGuard {
    armed: bool,
    replay_target: ShellReplayTarget,
    replay_path: PathBuf,
    app_handle: Option<AppHandle>,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    pty_session_id: String,
    exec_abort: Option<tokio::task::AbortHandle>,
    capture_abort: Option<tokio::task::AbortHandle>,
}

impl PtyReplaySupervisorGuard {
    fn new(
        replay_target: ShellReplayTarget,
        replay_path: PathBuf,
        app_handle: Option<AppHandle>,
        sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
        pty_session_id: String,
    ) -> Self {
        Self {
            armed: true,
            replay_target,
            replay_path,
            app_handle,
            sessions,
            pty_session_id,
            exec_abort: None,
            capture_abort: None,
        }
    }

    fn set_abort_handles(
        &mut self,
        exec_abort: tokio::task::AbortHandle,
        capture_abort: tokio::task::AbortHandle,
    ) {
        self.exec_abort = Some(exec_abort);
        self.capture_abort = Some(capture_abort);
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PtyReplaySupervisorGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Abort both owners before cleanup so neither detached task can keep
        // executing or publish a later running watermark after the caller's
        // future has disappeared.
        if let Some(abort) = self.exec_abort.take() {
            abort.abort();
        }
        if let Some(abort) = self.capture_abort.take() {
            abort.abort();
        }
        let _ = mark_writer_task_failure(
            &self.replay_target,
            Some(&self.replay_path),
            self.app_handle.as_ref(),
            "PTY execution supervisor was dropped before completion".to_string(),
        );
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let sessions = self.sessions.clone();
            let pty_session_id = self.pty_session_id.clone();
            runtime.spawn(async move {
                let _ = ::terminal::agent_tool::close_session(&pty_session_id, sessions).await;
            });
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
    request: PtyExecutionRequest<'_>,
) -> Result<String, ToolError> {
    let PtyExecutionRequest {
        command,
        work_dir,
        timeout_secs,
        wait_secs,
        working_dir,
        agent_session_id,
        identity,
        replay_root,
        cancel_flag,
    } = request;
    let pty_session_id = pty_session_id_for_agent(agent_session_id);
    let replay = ShellReplayWriter::create(
        replay_root,
        ShellReplayTarget::new(&identity.session_id, &identity.call_id),
        command,
        work_dir.map_or(working_dir, PathBuf::as_path),
        Some(pty.app_handle.clone()),
    )
    .map_err(|err| {
        ToolError::ExecutionFailed(format!(
            "Interactive command was not started because replay preflight failed: {err}"
        ))
    })?;
    let mut supervisor_guard = PtyReplaySupervisorGuard::new(
        replay.target(),
        replay.path().to_path_buf(),
        Some(pty.app_handle.clone()),
        pty.sessions.clone(),
        pty_session_id.clone(),
    );
    let output_tap =
        match ensure_pty_initialized(pty, &pty_session_id, agent_session_id, working_dir).await {
            Ok(tap) => tap,
            Err(err) => {
                let mut replay = replay;
                replay.mark_incomplete(format!("PTY init failed: {err}"));
                supervisor_guard.disarm();
                return Err(ToolError::ExecutionFailed(format!(
                    "PTY init failed: {err}"
                )));
            }
        };

    // Discard shell-startup/prompt bytes that predate this command. The
    // command executor performs its own stale drain before writing as well.
    let mut replay_rx = output_tap.subscribe();
    let drain_deadline = tokio::time::Instant::now() + Duration::from_millis(60);
    while let Ok(Ok(_)) = tokio::time::timeout(
        drain_deadline.saturating_duration_since(tokio::time::Instant::now()),
        replay_rx.recv(),
    )
    .await
    {
        if tokio::time::Instant::now() >= drain_deadline {
            break;
        }
    }

    let capture_identity = identity.clone();
    let replay_target = replay.target();
    let replay_path = replay.path().to_path_buf();
    let capture_failure_context = PtyCaptureFailureContext {
        pty_session_id: pty_session_id.clone(),
        sessions: pty.sessions.clone(),
        identity: identity.clone(),
        replay_target: replay_target.clone(),
        replay_path: replay_path.clone(),
        app_handle: Some(pty.app_handle.clone()),
    };
    let (stop_tx, stop_rx) = oneshot::channel();
    let mut capture = tokio::spawn(capture_pty_replay(
        replay_rx,
        replay,
        capture_identity,
        stop_rx,
    ));

    let output_tap_clone = output_tap.clone();
    let sessions = pty.sessions.clone();
    let command = command.to_string();
    let work_dir = work_dir.cloned();
    let pty_session_id_for_task = pty_session_id.clone();
    let mut exec_handle = tokio::spawn(async move {
        let mut rx = output_tap_clone.subscribe();
        crate::tool_infra::terminal::exec_in_pty(
            &command,
            work_dir.as_ref(),
            &pty_session_id_for_task,
            sessions,
            &mut rx,
            Duration::from_secs(PTY_COMPLETION_SAFETY_TIMEOUT_SECS),
        )
        .await
    });
    supervisor_guard.set_abort_handles(exec_handle.abort_handle(), capture.abort_handle());

    let effective_wait = wait_secs.unwrap_or(timeout_secs);
    let wait = tokio::time::sleep(Duration::from_secs(effective_wait));
    tokio::pin!(wait);
    let outcome = tokio::select! {
        exec_result = &mut exec_handle => {
            finish_pty_replay(
                exec_result,
                stop_tx,
                capture,
                identity.clone(),
                replay_target,
                replay_path,
                Some(pty.app_handle.clone()),
            ).await
        }
        capture_result = &mut capture => {
            fail_pty_after_capture_exit(
                capture_result,
                exec_handle,
                capture_failure_context.clone(),
            ).await
        }
        _ = wait_for_cancel(cancel_flag.clone()) => {
            cancel_running_pty(
                exec_handle,
                stop_tx,
                capture,
                &pty_session_id,
                pty.sessions.clone(),
                identity.clone(),
                replay_target,
                replay_path,
                Some(pty.app_handle.clone()),
                "Interactive command cancelled by user".to_string(),
            ).await
        }
        _ = &mut wait => {
            let preview = super::shell_replay::active_state(
                &identity.session_id,
                &identity.call_id,
            )
            .map(|state| state.terminal_preview)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "(no output yet)".to_string());
            let identity = identity.clone();
            let pty_session_id = pty_session_id.clone();
            let sessions = pty.sessions.clone();
            let app_handle = pty.app_handle.clone();
            let background_cancel = cancel_flag.clone();
            let mut background_guard = PtyReplaySupervisorGuard::new(
                replay_target.clone(),
                replay_path.clone(),
                Some(app_handle.clone()),
                sessions.clone(),
                pty_session_id.clone(),
            );
            background_guard.set_abort_handles(
                exec_handle.abort_handle(),
                capture.abort_handle(),
            );
            tokio::spawn(async move {
                let result = tokio::select! {
                    exec_result = &mut exec_handle => {
                        finish_pty_replay(
                            exec_result,
                            stop_tx,
                            capture,
                            identity.clone(),
                            replay_target,
                            replay_path,
                            Some(app_handle),
                        ).await
                    }
                    capture_result = &mut capture => {
                        fail_pty_after_capture_exit(
                            capture_result,
                            exec_handle,
                            capture_failure_context.clone(),
                        ).await
                    }
                    _ = wait_for_cancel(background_cancel) => {
                        cancel_running_pty(
                            exec_handle,
                            stop_tx,
                            capture,
                            &pty_session_id,
                            sessions,
                            identity.clone(),
                            replay_target,
                            replay_path,
                            Some(app_handle),
                            "Background interactive command cancelled by user".to_string(),
                        ).await
                    }
                };
                if let Err(err) = result {
                    tracing::warn!(
                        session_id = %identity.session_id,
                        call_id = %identity.call_id,
                        error = %err,
                        "background PTY replay finalized incomplete"
                    );
                }
                background_guard.disarm();
            });
            Ok(format!(
                "{preview}\n\n[command still running in terminal after {effective_wait}s]\n\
                 The command continues in the interactive terminal and its Session Replay is still recording."
            ))
        }
    };
    supervisor_guard.disarm();
    outcome
}

async fn wait_for_cancel(cancel_flag: Option<Arc<AtomicBool>>) {
    let Some(cancel_flag) = cancel_flag else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn interrupt_pty_command(
    exec_handle: &mut tokio::task::JoinHandle<Result<(String, i32), String>>,
    pty_session_id: &str,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
) {
    let _ =
        ::terminal::agent_tool::write_to_session(pty_session_id, "\u{3}", sessions.clone()).await;
    if tokio::time::timeout(Duration::from_secs(2), &mut *exec_handle)
        .await
        .is_err()
    {
        let _ = ::terminal::agent_tool::close_session(pty_session_id, sessions).await;
        exec_handle.abort();
        let _ = exec_handle.await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn cancel_running_pty(
    mut exec_handle: tokio::task::JoinHandle<Result<(String, i32), String>>,
    stop_tx: oneshot::Sender<()>,
    capture: tokio::task::JoinHandle<(ShellReplayWriter, Option<String>)>,
    pty_session_id: &str,
    sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
    identity: ExecIdentity,
    replay_target: ShellReplayTarget,
    replay_path: PathBuf,
    app_handle: Option<AppHandle>,
    reason: String,
) -> Result<String, ToolError> {
    interrupt_pty_command(&mut exec_handle, pty_session_id, sessions).await;
    let _ = stop_tx.send(());
    match capture.await {
        Ok((replay, capture_error)) => {
            let final_reason = capture_error
                .map(|capture_error| format!("{reason}; {capture_error}"))
                .unwrap_or_else(|| reason.clone());
            let _ = replay.finalize(
                core_types::session_event::ShellReplayStatus::Incomplete,
                Some(final_reason),
            );
        }
        Err(error) => {
            mark_writer_task_failure(
                &replay_target,
                Some(&replay_path),
                app_handle.as_ref(),
                format!("{reason}; PTY replay writer task panicked: {error}"),
            )
            .map_err(|mark_error| {
                ToolError::ExecutionFailed(format!(
                    "{reason}; failed to mark cancelled PTY replay incomplete: {mark_error}"
                ))
            })?;
        }
    }
    broadcast_system_output(&identity, "[interactive command cancelled]");
    Err(ToolError::ExecutionFailed(reason))
}

async fn fail_pty_after_capture_exit(
    capture_result: Result<(ShellReplayWriter, Option<String>), tokio::task::JoinError>,
    mut exec_handle: tokio::task::JoinHandle<Result<(String, i32), String>>,
    context: PtyCaptureFailureContext,
) -> Result<String, ToolError> {
    let failure = match &capture_result {
        Ok((_, Some(error))) => error.clone(),
        Ok((_, None)) => "PTY replay capture ended before the command completed".to_string(),
        Err(error) => format!("PTY replay writer task panicked: {error}"),
    };

    // Stop the foreground command immediately. If Ctrl-C cannot make the
    // marker task finish promptly, close this agent-owned PTY so an unrecorded
    // command cannot continue running in the background.
    interrupt_pty_command(&mut exec_handle, &context.pty_session_id, context.sessions).await;

    match capture_result {
        Ok((replay, _)) => {
            let _ = replay.finalize(
                core_types::session_event::ShellReplayStatus::Incomplete,
                Some(failure.clone()),
            );
        }
        Err(_) => {
            mark_writer_task_failure(
                &context.replay_target,
                Some(&context.replay_path),
                context.app_handle.as_ref(),
                failure.clone(),
            )
            .map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "{failure}; failed to mark PTY replay incomplete: {error}"
                ))
            })?;
        }
    }
    broadcast_system_output(
        &context.identity,
        "[interactive command stopped because Session Replay became incomplete]",
    );
    Err(ToolError::ExecutionFailed(format!(
        "Interactive command stopped because Session Replay is incomplete: {failure}"
    )))
}

async fn finish_pty_replay(
    exec_result: Result<Result<(String, i32), String>, tokio::task::JoinError>,
    stop_tx: oneshot::Sender<()>,
    capture: tokio::task::JoinHandle<(ShellReplayWriter, Option<String>)>,
    identity: ExecIdentity,
    replay_target: ShellReplayTarget,
    replay_path: PathBuf,
    app_handle: Option<AppHandle>,
) -> Result<String, ToolError> {
    let _ = stop_tx.send(());
    let (replay, capture_error) = match capture.await {
        Ok(capture) => capture,
        Err(err) => {
            let message = format!("PTY replay writer task panicked: {err}");
            mark_writer_task_failure(
                &replay_target,
                Some(&replay_path),
                app_handle.as_ref(),
                message.clone(),
            )
            .map_err(|mark_error| {
                ToolError::ExecutionFailed(format!(
                    "{message}; failed to mark replay incomplete: {mark_error}"
                ))
            })?;
            return Err(ToolError::ExecutionFailed(message));
        }
    };
    if let Some(error) = capture_error {
        let _ = replay.finalize(
            core_types::session_event::ShellReplayStatus::Incomplete,
            Some(error.clone()),
        );
        return Err(ToolError::ExecutionFailed(format!(
            "Interactive shell replay is incomplete: {error}"
        )));
    }

    let (_captured_tail, exit_code) = match exec_result {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            let message = format!("PTY command failed: {err}");
            let _ = replay.finalize(
                core_types::session_event::ShellReplayStatus::Incomplete,
                Some(message.clone()),
            );
            return Err(ToolError::ExecutionFailed(message));
        }
        Err(err) => {
            let message = format!("PTY task panicked: {err}");
            let _ = replay.finalize(
                core_types::session_event::ShellReplayStatus::Incomplete,
                Some(message.clone()),
            );
            return Err(ToolError::ExecutionFailed(message));
        }
    };
    broadcast_system_output(
        &identity,
        &format!("[interactive command exited with code {exit_code}]"),
    );
    let summary = replay
        .finalize(core_types::session_event::ShellReplayStatus::Complete, None)
        .map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "Interactive command finished but replay finalization failed: {err}"
            ))
        })?;
    Ok(format!(
        "{}{}",
        if summary.is_empty() {
            "(no output)".to_string()
        } else {
            summary
        },
        if exit_code == 0 {
            String::new()
        } else {
            format!("\n[exit code: {exit_code}]")
        }
    ))
}

async fn capture_pty_replay(
    mut rx: TapReceiver,
    mut replay: ShellReplayWriter,
    identity: ExecIdentity,
    mut stop_rx: oneshot::Receiver<()>,
) -> (ShellReplayWriter, Option<String>) {
    let mut pending = Vec::with_capacity(64 * 1024 + 4);
    let mut failure = None;
    let mut flush_interval = tokio::time::interval(Duration::from_millis(50));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let next = tokio::select! {
            _ = &mut stop_rx => break,
            next = rx.recv() => next,
            _ = flush_interval.tick() => {
                if let Err(error) = replay.flush_due_state() {
                    failure = Some(error);
                    break;
                }
                continue;
            }
        };
        match next {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                if let Err(err) = append_pty_pending(&mut replay, &identity, &mut pending, false) {
                    failure = Some(err);
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                failure = Some(format!(
                    "PTY replay subscriber lagged and lost {skipped} output chunks"
                ));
                break;
            }
            Err(broadcast::error::RecvError::Closed) => {
                failure = Some("PTY replay output tap closed before completion".to_string());
                break;
            }
        }
    }
    while failure.is_none() {
        match rx.try_recv() {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                if let Err(err) = append_pty_pending(&mut replay, &identity, &mut pending, false) {
                    failure = Some(err);
                }
            }
            Err(broadcast::error::TryRecvError::Empty)
            | Err(broadcast::error::TryRecvError::Closed) => break,
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                failure = Some(format!(
                    "PTY replay subscriber lagged and lost {skipped} output chunks"
                ));
            }
        }
    }
    if failure.is_none() {
        if let Err(err) = append_pty_pending(&mut replay, &identity, &mut pending, true) {
            failure = Some(err);
        }
    }
    (replay, failure)
}

fn append_pty_pending(
    replay: &mut ShellReplayWriter,
    identity: &ExecIdentity,
    pending: &mut Vec<u8>,
    flush_all: bool,
) -> Result<(), String> {
    loop {
        let prefix = if pending.len() > SHELL_REPLAY_FRAME_MAX_BYTES {
            let bounded = complete_terminal_prefix_len(&pending[..SHELL_REPLAY_FRAME_MAX_BYTES]);
            if bounded == 0 {
                SHELL_REPLAY_FRAME_MAX_BYTES
            } else {
                bounded
            }
        } else if flush_all {
            pending.len()
        } else {
            complete_terminal_prefix_len(pending)
        };
        if prefix == 0 {
            return Ok(());
        }
        let bytes: Vec<u8> = pending.drain(..prefix).collect();
        let append = replay.append(ShellReplayStream::Stdout, &bytes)?;
        broadcast_exec_output(
            identity,
            &String::from_utf8_lossy(&bytes),
            ShellReplayStream::Stdout.as_wire_str(),
            append.sequence,
            append.persisted_bytes,
        );
        if pending.is_empty() {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_types::session_event::ShellReplayStatus;

    fn empty_sessions() -> Arc<AsyncMutex<HashMap<String, PtySession>>> {
        Arc::new(AsyncMutex::new(HashMap::new()))
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pty_capture_flushes_small_quiet_output_within_fifty_ms_window() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("pty-flush-session", "pty-flush-call");
        let writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", Path::new("/tmp"), None)
                .unwrap();
        let (tap, _) = broadcast::channel(16);
        let rx = tap.subscribe();
        let (stop_tx, stop_rx) = oneshot::channel();
        let capture = tokio::spawn(capture_pty_replay(
            rx,
            writer,
            ExecIdentity::new(&target.session_id, &target.call_id),
            stop_rx,
        ));
        tap.send(Arc::from(b"quiet".as_slice())).unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;

        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.bookmark.visible_bytes, 5);
        assert_eq!(state.bookmark.visible_through_sequence, 1);

        let _ = stop_tx.send(());
        let (writer, error) = capture.await.unwrap();
        assert!(error.is_none());
        writer.finalize(ShellReplayStatus::Complete, None).unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pty_capture_write_failure_returns_immediately_and_marks_incomplete() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("pty-write-fail-session", "pty-write-fail-call");
        let mut writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", Path::new("/tmp"), None)
                .unwrap();
        writer.inject_read_only_artifact_for_test();
        let (tap, _) = broadcast::channel(16);
        let rx = tap.subscribe();
        let (_stop_tx, stop_rx) = oneshot::channel();
        let capture = tokio::spawn(capture_pty_replay(
            rx,
            writer,
            ExecIdentity::new(&target.session_id, &target.call_id),
            stop_rx,
        ));
        tap.send(Arc::from(b"cannot persist".as_slice())).unwrap();

        let (writer, error) = tokio::time::timeout(Duration::from_secs(1), capture)
            .await
            .expect("capture must fail immediately")
            .unwrap();
        let error = error.expect("capture write failure");
        assert!(error.contains("shell replay"));
        let _ = writer.finalize(ShellReplayStatus::Incomplete, Some(error));
        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn exec_ready_plus_capture_panic_marks_exact_manifest_incomplete() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("pty-panic-session", "pty-panic-call");
        let writer =
            ShellReplayWriter::create(&root, target.clone(), "emit", Path::new("/tmp"), None)
                .unwrap();
        let path = writer.path().to_path_buf();
        let (stop_tx, _stop_rx) = oneshot::channel();
        let capture = tokio::spawn(async move {
            let _owned_writer = writer;
            panic!("injected PTY capture panic");
        });
        let result = finish_pty_replay(
            Ok(Ok((String::new(), 0))),
            stop_tx,
            capture,
            ExecIdentity::new(&target.session_id, &target.call_id),
            target.clone(),
            path,
            None,
        )
        .await;
        assert!(result.is_err());
        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
        assert!(state.error.unwrap().contains("writer task panicked"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn cancel_path_finalizes_replay_incomplete() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("pty-cancel-session", "pty-cancel-call");
        let writer =
            ShellReplayWriter::create(&root, target.clone(), "sleep", Path::new("/tmp"), None)
                .unwrap();
        let path = writer.path().to_path_buf();
        let (tap, _) = broadcast::channel(16);
        let (stop_tx, stop_rx) = oneshot::channel();
        let capture = tokio::spawn(capture_pty_replay(
            tap.subscribe(),
            writer,
            ExecIdentity::new(&target.session_id, &target.call_id),
            stop_rx,
        ));
        let exec_handle = tokio::spawn(async { Ok((String::new(), 130)) });
        let result = cancel_running_pty(
            exec_handle,
            stop_tx,
            capture,
            "missing-test-pty",
            empty_sessions(),
            ExecIdentity::new(&target.session_id, &target.call_id),
            target.clone(),
            path,
            None,
            "cancelled for test".to_string(),
        )
        .await;
        assert!(result.is_err());
        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
        assert!(state.error.unwrap().contains("cancelled for test"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn dropping_supervisor_guard_never_leaves_running_manifest() {
        let _sandbox = test_helpers::test_env::sandbox();
        let root = super::super::shell_replay::resolve_replay_root();
        let target = ShellReplayTarget::new("pty-drop-session", "pty-drop-call");
        let writer =
            ShellReplayWriter::create(&root, target.clone(), "sleep", Path::new("/tmp"), None)
                .unwrap();
        let path = writer.path().to_path_buf();
        let (tap, _) = broadcast::channel(16);
        let (_stop_tx, stop_rx) = oneshot::channel();
        let capture = tokio::spawn(capture_pty_replay(
            tap.subscribe(),
            writer,
            ExecIdentity::new(&target.session_id, &target.call_id),
            stop_rx,
        ));
        let exec =
            tokio::spawn(async { std::future::pending::<Result<(String, i32), String>>().await });
        let mut guard = PtyReplaySupervisorGuard::new(
            target.clone(),
            path,
            None,
            empty_sessions(),
            "missing-test-pty".to_string(),
        );
        guard.set_abort_handles(exec.abort_handle(), capture.abort_handle());
        tap.send(Arc::from(b"before outer future drop".as_slice()))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        drop(guard);
        // A detached capture tick after the guard fires must not be able to
        // regress the durable status from incomplete back to running.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let state =
            super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
                .unwrap()
                .unwrap();
        assert_eq!(state.status, ShellReplayStatus::Incomplete);
        match capture.await {
            Ok(_) => panic!("capture task was not aborted by supervisor guard"),
            Err(error) => assert!(error.is_cancelled()),
        }
        assert!(exec.await.unwrap_err().is_cancelled());
    }
}
