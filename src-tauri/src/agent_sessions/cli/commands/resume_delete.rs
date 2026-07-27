//! `cli_agent_resume` and `cli_agent_delete` — restarting an interrupted
//! session and tearing one down (process, proxy, config dir, worktree, DB row).

use super::super::persistence;
use super::super::session_runner;
use super::super::types::SessionStatus;
use git::worktree;

/// Resume an interrupted session.
///
/// Loads the session's user_input and CLI session ID from the DB and re-launches
/// the CLI agent with the resume flag, continuing the previous conversation.
#[tauri::command]
pub async fn cli_agent_resume(session_id: String) -> Result<(), String> {
    // Load session to get the original user_input, current stage, and CLI session ID
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    // Only resume sessions that were running or failed (not completed/cancelled)
    if !session.status.is_resumable() {
        return Err(format!(
            "Cannot resume session in '{}' state. Only running/failed/pending sessions can be resumed.",
            session.status
        ));
    }

    let user_input = session.user_input.unwrap_or_default();
    if user_input.is_empty() {
        return Err("No user input found for session — cannot resume.".to_string());
    }

    let cli_resume_id =
        persistence::get_cli_session_id_for_account(&session_id, session.account_id.as_deref())
            .map_err(|err| format!("DB error: {}", err))?
            .or(session.cli_session_id);

    // Guard before expensive cleanup. Do not hold the global RUNNING_SESSIONS
    // mutex across process/proxy/DB awaits: one slow resume cleanup must not
    // block unrelated CLI sessions or Agent Org members from starting.
    {
        let mut sessions = session_runner::RUNNING_SESSIONS.lock().await;
        if let Some(handle) = sessions.get(&session_id) {
            if !handle.is_finished() {
                return Err(format!(
                    "Session {} already has a running agent. Cancel it first.",
                    session_id
                ));
            }
            sessions.remove(&session_id);
        }
    }

    // All guards passed — now safe to mutate state.

    // Kill any stale OS process from a previous run. After an app crash/restart,
    // RUNNING_SESSIONS is empty but the CLI agent (identified by PID in DB) may
    // still be alive. Without this, resume would spawn a second agent in the same repo.
    if session.status == super::super::types::SessionStatus::Running {
        if let Some(pid) = session.pid {
            tracing::info!(
                "[CodeSession] Killing stale process PID/group {} before resume",
                pid
            );
            session_runner::terminate_process_tree(pid, &session_id).await;
        }
    }

    // Stop any stale per-session proxy from a previous run
    integrations::proxy::server::stop_session_proxy(&session_id).await;

    // Reset status to pending
    persistence::update_status(&session_id, SessionStatus::Pending)
        .map_err(|e| format!("DB error: {}", e))?;

    let sid = session_id.clone();
    let input = user_input.clone();

    let handle = tokio::spawn(async move {
        if let Err(e) =
            session_runner::run_session(sid.clone(), input, cli_resume_id, None, None).await
        {
            tracing::error!("[CodeSession] Resume of {} failed: {}", sid, e);
            // Same fail-loud principle as the create path above: log the
            // persistence failure so a stuck Running row is traceable.
            if let Err(persist_err) =
                persistence::update_status_with_error(&sid, SessionStatus::Failed, &e)
            {
                tracing::error!(
                    "[CodeSession] failed to mark resumed session {} as Failed: {}",
                    sid,
                    persist_err
                );
            }
            integrations::proxy::server::stop_session_proxy(&sid).await;
            session_runner::release_proxy_token_for_session_pub(&sid).await;
        }
        session_runner::RUNNING_SESSIONS.lock().await.remove(&sid);
    });

    {
        let mut sessions = session_runner::RUNNING_SESSIONS.lock().await;
        if let Some(existing) = sessions.get(&session_id) {
            if !existing.is_finished() {
                handle.abort();
                return Err(format!(
                    "Session {} already has a running agent. Cancel it first.",
                    session_id
                ));
            }
            sessions.remove(&session_id);
        }
        sessions.insert(session_id, handle);
    }

    Ok(())
}

/// Delete a session and all its chunks.
///
/// Also kills any running agent (OS process + proxy), releases the proxy token,
/// cleans up the persistent Cursor config directory, and removes any worktree.
#[tauri::command]
pub async fn cli_agent_delete(session_id: String) -> Result<bool, String> {
    // Kill the agent process, Tokio task, and per-session proxy
    session_runner::kill_running_agent(&session_id).await;

    // Release proxy token BEFORE deleting the DB row — after deletion,
    // release_proxy_token_for_session can't find the session to read the token.
    session_runner::release_proxy_token_for_session_pub(&session_id).await;

    // Clean up persistent Cursor config dir (contains chat session data for --resume)
    session_runner::cleanup_cursor_config_dir(&session_id);

    // Clean up worktree if session had isolation enabled
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    if let Some(ref session) = session {
        // Only `base_branch`-bearing worktrees are session-owned isolation.
        // A reused linked worktree is borrowed and must survive deletion.
        if session.base_branch.is_some() {
            if let Some(ref rp) = session.repo_path {
                let repo = std::path::Path::new(rp).to_path_buf();
                let sid = session.session_id.clone();
                match tokio::task::spawn_blocking(move || {
                    worktree::remove_session_worktree(&repo, &sid, true)
                })
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => {
                        return Err(format!(
                            "Worktree cleanup failed; session was kept for retry: {err}"
                        ))
                    }
                    Err(join_err) => {
                        return Err(format!(
                            "Worktree cleanup task failed; session was kept for retry: {join_err}"
                        ))
                    }
                }
            }
        }
    }

    let sid = session_id.clone();
    tokio::task::spawn_blocking(move || {
        persistence::delete_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
