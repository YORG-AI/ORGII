//! Bounded stdout/stderr pumping and durable shell-replay completion barriers.

use std::path::PathBuf;
use std::time::Duration;

use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, watch};
use tracing::warn;

use super::super::shell_replay::{
    complete_terminal_prefix_len, mark_writer_task_failure, ShellReplayStream, ShellReplayTarget,
    ShellReplayWriter, SHELL_REPLAY_FRAME_MAX_BYTES,
};
use super::{broadcast_exec_output, ExecIdentity};

pub(crate) const OUTPUT_READ_BUFFER_BYTES: usize = 16 * 1024;
pub(crate) const OUTPUT_CHANNEL_CAPACITY: usize = 16;
/// Two reader buffers + UTF-8 carries, the bounded channel, writer/active
/// previews, 30 KiB summary, one in-flight frame, and BufWriter capacity.
#[cfg(test)]
pub(crate) const ESTIMATED_RETAINED_OUTPUT_BYTES: usize = (2
    * (OUTPUT_READ_BUFFER_BYTES + OUTPUT_READ_BUFFER_BYTES + 4))
    + (OUTPUT_CHANNEL_CAPACITY * OUTPUT_READ_BUFFER_BYTES)
    + (2 * super::super::shell_replay::SHELL_REPLAY_PREVIEW_BYTES)
    + super::super::shell_replay::SHELL_REPLAY_SUMMARY_HEAD_BYTES
    + super::super::shell_replay::SHELL_REPLAY_SUMMARY_TAIL_BYTES
    + OUTPUT_READ_BUFFER_BYTES
    + (8 * 1024);

enum ReplayInput {
    Chunk {
        stream: ShellReplayStream,
        bytes: Vec<u8>,
    },
    ReaderError {
        stream: ShellReplayStream,
        error: String,
    },
}

pub(super) struct OutputRuntime {
    pub(super) stdout_task: tokio::task::JoinHandle<()>,
    pub(super) stderr_task: tokio::task::JoinHandle<()>,
    pub(super) writer_task: tokio::task::JoinHandle<ReplayDrain>,
    pub(super) failure_rx: watch::Receiver<Option<String>>,
    pub(super) log_path: Option<PathBuf>,
    pub(super) replay_target: ShellReplayTarget,
    pub(super) app_handle: Option<AppHandle>,
}

pub(super) struct ReplayDrain {
    pub(super) replay: ShellReplayWriter,
    pub(super) write_error: Option<String>,
}

async fn pump_output<R>(mut reader: R, stream: ShellReplayStream, tx: mpsc::Sender<ReplayInput>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; OUTPUT_READ_BUFFER_BYTES];
    let mut pending = Vec::with_capacity(OUTPUT_READ_BUFFER_BYTES + 4);
    loop {
        debug_assert!(pending.len() < SHELL_REPLAY_FRAME_MAX_BYTES);
        let read_capacity = SHELL_REPLAY_FRAME_MAX_BYTES.saturating_sub(pending.len());
        match reader.read(&mut buffer[..read_capacity]).await {
            Ok(0) => {
                if !pending.is_empty() {
                    let _ = tx
                        .send(ReplayInput::Chunk {
                            stream,
                            bytes: std::mem::take(&mut pending),
                        })
                        .await;
                }
                break;
            }
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                let prefix = complete_terminal_prefix_len(&pending);
                if prefix == 0 {
                    continue;
                }
                let bytes: Vec<u8> = pending.drain(..prefix).collect();
                if tx.send(ReplayInput::Chunk { stream, bytes }).await.is_err() {
                    break;
                }
            }
            Err(err) => {
                let _ = tx
                    .send(ReplayInput::ReaderError {
                        stream,
                        error: err.to_string(),
                    })
                    .await;
                break;
            }
        }
    }
}

pub(super) fn spawn_output_runtime(
    identity: ExecIdentity,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    replay: ShellReplayWriter,
) -> OutputRuntime {
    let log_path = Some(replay.path().to_path_buf());
    let replay_target = replay.target();
    let app_handle = replay.app_handle();
    let (tx, mut rx) = mpsc::channel::<ReplayInput>(OUTPUT_CHANNEL_CAPACITY);
    let (failure_tx, failure_rx) = watch::channel::<Option<String>>(None);

    let stdout_tx = tx.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            pump_output(stdout, ShellReplayStream::Stdout, stdout_tx).await;
        }
    });
    let stderr_tx = tx.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            pump_output(stderr, ShellReplayStream::Stderr, stderr_tx).await;
        }
    });
    drop(tx);

    let writer_task = tokio::spawn(async move {
        let mut replay = replay;
        let mut write_error = None;
        let mut flush_interval = tokio::time::interval(Duration::from_millis(50));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let input = tokio::select! {
                input = rx.recv() => input,
                _ = flush_interval.tick() => {
                    if let Err(err) = replay.flush_due_state() {
                        replay.mark_incomplete(err.clone());
                        let _ = failure_tx.send(Some(err.clone()));
                        write_error = Some(err);
                        break;
                    }
                    continue;
                }
            };
            let Some(input) = input else {
                break;
            };
            let (stream, bytes) = match input {
                ReplayInput::Chunk { stream, bytes } => (stream, bytes),
                ReplayInput::ReaderError { stream, error } => {
                    let message = format!("{} reader failed: {error}", stream.as_wire_str());
                    replay.mark_incomplete(message.clone());
                    let _ = failure_tx.send(Some(message.clone()));
                    write_error = Some(message);
                    break;
                }
            };

            let append = match replay.append(stream, &bytes) {
                Ok(append) => append,
                Err(err) => {
                    replay.mark_incomplete(err.clone());
                    let _ = failure_tx.send(Some(err.clone()));
                    write_error = Some(err);
                    break;
                }
            };

            broadcast_exec_output(
                &identity,
                &String::from_utf8_lossy(&bytes),
                stream.as_wire_str(),
                append.sequence,
                append.persisted_bytes,
            );
        }

        if write_error.is_none() {
            if let Err(err) = replay.flush_running_state() {
                replay.mark_incomplete(err.clone());
                let _ = failure_tx.send(Some(err.clone()));
                write_error = Some(err);
            }
        }
        ReplayDrain {
            replay,
            write_error,
        }
    });

    OutputRuntime {
        stdout_task,
        stderr_task,
        writer_task,
        failure_rx,
        log_path,
        replay_target,
        app_handle,
    }
}

async fn join_reader(mut task: tokio::task::JoinHandle<()>, stream: &str) -> Result<(), String> {
    match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(format!("{stream} reader task failed: {err}")),
        Err(_) => {
            warn!("[subprocess] {stream} reader did not finish within 5s; aborting");
            task.abort();
            let _ = task.await;
            Err(format!(
                "{stream} reader did not drain within the 5s completion barrier"
            ))
        }
    }
}

pub(super) async fn drain_output(runtime: OutputRuntime) -> Result<ReplayDrain, String> {
    let stdout_error = join_reader(runtime.stdout_task, "stdout").await.err();
    let stderr_error = join_reader(runtime.stderr_task, "stderr").await.err();
    let mut drain = match runtime.writer_task.await {
        Ok(drain) => drain,
        Err(err) => {
            let message = format!("shell replay writer task failed: {err}");
            let mark_result = mark_writer_task_failure(
                &runtime.replay_target,
                runtime.log_path.as_deref(),
                runtime.app_handle.as_ref(),
                message.clone(),
            );
            return Err(match mark_result {
                Ok(()) => message,
                Err(mark_err) => format!("{message}; failed to mark replay incomplete: {mark_err}"),
            });
        }
    };
    if drain.write_error.is_none() {
        drain.write_error = stdout_error.or(stderr_error);
    }
    Ok(drain)
}

pub(super) fn format_summary(summary: String, exit_code: i32) -> String {
    let summary = if summary.is_empty() {
        "(no output)".to_string()
    } else {
        summary
    };
    if exit_code == 0 {
        summary
    } else {
        format!("{summary}\n[exit code: {exit_code}]")
    }
}
