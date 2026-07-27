//! ACP transport: bidirectional JSON-RPC over stdio for Copilot, Kiro, and
//! OpenCode.

use std::collections::HashMap;

use tokio::process::Child;

use crate::agent_sessions::cli::parsers::copilot;
use crate::agent_sessions::cli::parsers::kiro;
use key_vault::key_store::ModelType;

use super::super::helpers::{emit_chunk, snapshot_cli_file_edit};

pub(super) struct AcpOutcome {
    pub(super) exit_code: i32,
    pub(super) timed_out: bool,
    pub(super) cli_session_id_out: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_acp_branch(
    mut child: Child,
    session_id: String,
    effective_input: String,
    working_dir: &str,
    cli_resume_id: Option<String>,
    agent: ModelType,
    image_paths: Vec<String>,
    session_timeout: tokio::time::Duration,
    pre_message_snapshot_id: Option<String>,
    snapshot_working_dir: String,
    mut cli_session_id_out: Option<String>,
    sequence: &mut i64,
    env_vars: &HashMap<String, String>,
) -> Result<AcpOutcome, String> {
    // ── ACP agents (Copilot, Kiro): bidirectional JSON-RPC ──
    let stdout = child.stdout.take().expect("stdout was piped");
    let stdin = child.stdin.take().expect("stdin was piped for ACP");
    let (chunk_tx, mut chunk_rx) =
        tokio::sync::mpsc::channel::<core_types::activity::ActivityChunk>(256);

    let acp_sid = session_id.clone();
    let acp_task = effective_input.clone();
    let acp_dir = working_dir.to_string();
    let acp_resume = cli_resume_id.clone();
    let acp_agent = agent.clone();
    let acp_image_paths = image_paths.clone();

    let acp_handle = tokio::spawn(async move {
        match acp_agent {
            ModelType::Kiro => {
                kiro::run_acp_protocol(
                    stdin,
                    stdout,
                    &acp_sid,
                    &acp_task,
                    &acp_dir,
                    acp_resume.as_deref(),
                    chunk_tx,
                    acp_image_paths,
                )
                .await
            }
            ModelType::OpenCode => {
                crate::agent_sessions::cli::parsers::opencode::run_acp_protocol(
                    stdin,
                    stdout,
                    &acp_sid,
                    &acp_task,
                    &acp_dir,
                    acp_resume.as_deref(),
                    chunk_tx,
                    acp_image_paths,
                )
                .await
            }
            _ => {
                copilot::run_acp_protocol(
                    stdin,
                    stdout,
                    &acp_sid,
                    &acp_task,
                    &acp_dir,
                    acp_resume.as_deref(),
                    chunk_tx,
                    acp_image_paths,
                )
                .await
            }
        }
    });

    let timeout_result = tokio::time::timeout(session_timeout, async {
        while let Some(chunk) = chunk_rx.recv().await {
            if let Some(snap_id) = &pre_message_snapshot_id {
                snapshot_cli_file_edit(&session_id, snap_id, &chunk, &snapshot_working_dir).await;
            }
            emit_chunk(&chunk, &session_id, sequence).await;
        }
    })
    .await;
    let timed_out = timeout_result.is_err();

    match acp_handle.await {
        Ok(Ok(result)) => {
            cli_session_id_out = Some(result.acp_session_id);
        }
        Ok(Err(err)) if !timed_out => {
            tracing::error!("[CodeSession] ACP protocol error: {}", err);
        }
        Err(join_err) => {
            tracing::error!("[CodeSession] ACP task panicked: {}", join_err);
        }
        _ => {}
    }

    if let Some(pid) = child.id() {
        super::super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
    } else {
        let _ = child.kill().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|err| format!("Wait error: {}", err))?;
    let exit_code = status.code().unwrap_or(-1);

    // Clean stale lock files left by the killed kiro-cli process
    if matches!(agent, ModelType::Kiro) {
        if let Some(home) = env_vars.get("HOME") {
            let lock_dir = std::path::Path::new(home).join(".kiro/sessions/cli");
            if let Ok(entries) = std::fs::read_dir(&lock_dir) {
                for entry in entries.flatten() {
                    if entry.path().extension().is_some_and(|e| e == "lock") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(AcpOutcome {
        exit_code,
        timed_out,
        cli_session_id_out,
    })
}
