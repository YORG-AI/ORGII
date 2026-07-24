//! Codex app-server transport: long-lived JSON-RPC turn over stdio.
//!
//! Experimental; gated by the launch-profile transport="app-server" setting
//! (see `super::super::launch_profiles::uses_codex_app_server`).

use tokio::process::Child;

use crate::api::websocket_handler;

use super::super::super::persistence;
use super::super::helpers::{emit_chunk, snapshot_cli_file_edit};
use super::super::launch_profiles::ResolvedCliLaunchProfile;

pub(super) struct AppServerOutcome {
    pub(super) exit_code: i32,
    pub(super) timed_out: bool,
    pub(super) cli_session_id_out: Option<String>,
    pub(super) codex_app_server_turn_ok: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_codex_app_server_branch(
    mut child: Child,
    session_id: String,
    account_id: Option<&str>,
    effective_input: String,
    working_dir: &str,
    cli_resume_id: Option<String>,
    model: Option<&str>,
    launch_profile: &ResolvedCliLaunchProfile,
    image_paths: Vec<String>,
    session_timeout: tokio::time::Duration,
    pre_message_snapshot_id: Option<String>,
    snapshot_working_dir: String,
    mut cli_session_id_out: Option<String>,
    sequence: &mut i64,
    mut codex_app_server_turn_ok: bool,
) -> Result<AppServerOutcome, String> {
    // ── Codex app-server: long-lived JSON-RPC over stdio ──
    // (experimental; gate = launch-profile transport="app-server").
    // Same CODEX_HOME / auth env as the exec shell-out — the spawn
    // above already carries env_vars.
    use crate::agent_sessions::cli::parsers::codex_app_server;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stdin = child.stdin.take().expect("stdin was piped for app-server");
    let (chunk_tx, mut chunk_rx) =
        tokio::sync::mpsc::channel::<core_types::activity::ActivityChunk>(256);

    let turn = codex_app_server::CodexAppServerTurn {
        session_id: session_id.clone(),
        task: effective_input.clone(),
        working_dir: working_dir.to_string(),
        resume_thread_id: cli_resume_id.clone(),
        model: super::super::command::codex_app_server_thread_model(model),
        permission_mode: launch_profile.permission_mode,
        image_paths: image_paths.clone(),
    };
    let app_server_handle = tokio::spawn(async move {
        codex_app_server::run_app_server_turn(stdin, stdout, turn, chunk_tx).await
    });

    let timeout_result = tokio::time::timeout(session_timeout, async {
        while let Some(chunk) = chunk_rx.recv().await {
            // Bind the rollout-compatible thread id as soon as the
            // session_start chunk carries it (mirrors the parser
            // early-binding in the exec branch below): native
            // transcript replay, managed-mirror dedup, and
            // live-status attribution all key on it, and a crash
            // mid-turn must not orphan the rollout.
            if cli_session_id_out.is_none() {
                if let Some(ref tid) = chunk.thread_id {
                    cli_session_id_out = Some(tid.clone());
                    if let Err(err) =
                        persistence::update_cli_session_id_for_account(&session_id, account_id, tid)
                    {
                        tracing::warn!(
                            "[CodeSession] Failed to bind early cli_session_id: {}",
                            err
                        );
                    }
                    websocket_handler::broadcast(
                        serde_json::json!({
                            "type": "code_session.cli_session_bound",
                            "session_id": session_id,
                            "cli_session_id": tid,
                        })
                        .to_string(),
                    );
                }
            }
            if let Some(snap_id) = &pre_message_snapshot_id {
                snapshot_cli_file_edit(&session_id, snap_id, &chunk, &snapshot_working_dir);
            }
            emit_chunk(&chunk, &session_id, sequence);
        }
    })
    .await;
    let timed_out = timeout_result.is_err();

    match app_server_handle.await {
        Ok(Ok(result)) => {
            cli_session_id_out = Some(result.thread_id);
            codex_app_server_turn_ok = result.turn_status != "failed";
            if let Some(ref usage) = result.usage {
                let round_model = usage.model.as_deref().or(model);
                if let Err(err) = session_persistence::token_usage::insert_token_usage_record(
                    &session_id,
                    "code",
                    round_model,
                    account_id,
                    usage.input_tokens as i64,
                    usage.output_tokens as i64,
                    usage.cache_read_tokens as i64,
                    usage.cache_write_tokens as i64,
                    usage.total_tokens as i64,
                    0,
                    None,
                ) {
                    tracing::warn!(
                        "[CodeSession] Failed to insert per-round token usage: {}",
                        err
                    );
                }
            }
        }
        Ok(Err(err)) if !timed_out => {
            tracing::error!("[CodeSession] app-server protocol error: {}", err);
        }
        Err(join_err) => {
            tracing::error!("[CodeSession] app-server task panicked: {}", join_err);
        }
        _ => {}
    }

    // The app-server process is long-lived and never exits on its
    // own — the turn is over, so tear it down like the ACP branch.
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

    Ok(AppServerOutcome {
        exit_code,
        timed_out,
        cli_session_id_out,
        codex_app_server_turn_ok,
    })
}
