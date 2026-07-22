//! Tauri commands for CLI agent session management.

use super::launch_profile_store;
use super::persistence::{self, CliHistoryMutation, CodeSession, CreateCodeSessionParams};
use super::session_runner;
use super::session_runner::launch_profiles::{
    CliLaunchProfileUpdate, CliLaunchProfileView, CliPermissionMode,
};
use super::types::{KeySource, SessionStatus};
use agent_core::session::IdeContext;
use agent_core::state::control_flow::CancelReason;
use core_types::session::CLI_SESSION_PREFIX;
use core_types::worktree::{MergeStrategy, WorktreeMergeResult};
use git::worktree;
use settings;
use std::collections::HashMap;

const WORKTREE_MAX_COUNT_SETTING: &str = "git.worktree.maxCount";

#[tauri::command]
pub fn cli_launch_profile_get(agent_name: String) -> Result<CliLaunchProfileView, String> {
    launch_profile_store::cli_launch_profile_get(agent_name)
}

#[tauri::command]
pub fn cli_launch_profile_update(
    agent_name: String,
    permission_mode: CliPermissionMode,
    command_override: Option<String>,
    args_override: Option<Vec<String>>,
    env_override: Option<HashMap<String, String>>,
) -> Result<CliLaunchProfileView, String> {
    launch_profile_store::cli_launch_profile_update(CliLaunchProfileUpdate {
        agent_name,
        permission_mode,
        command_override,
        args_override,
        env_override,
        // Experimental app-server transport opt-in is not exposed in the
        // settings UI; `None` preserves whatever the store already holds.
        transport: None,
    })
}

#[tauri::command]
pub fn cli_launch_profile_reset(agent_name: String) -> Result<CliLaunchProfileView, String> {
    launch_profile_store::cli_launch_profile_reset(agent_name)
}

/// Prepend IDE context (open files, git status, etc.) to the user prompt
/// so external CLI agents are aware of the user's IDE state.
fn inject_ide_context_into_prompt(user_input: &str, ide_context: Option<&IdeContext>) -> String {
    let Some(ctx) = ide_context else {
        return user_input.to_string();
    };

    let section = agent_core::core::session::prompt::ide_context::format_ide_context(ctx);
    if section.is_empty() {
        return user_input.to_string();
    }

    format!(
        "<ide_context>\n{}\n</ide_context>\n\n{}",
        section, user_input
    )
}

/// Create a new code session.
///
/// When `params.isolate` is true and `repo_path` is set, creates a git worktree
/// for filesystem isolation so multiple sessions can run on the same repo.
///
/// When `key_source` is "hosted_key" and hosted_token is provided,
/// Rust automatically allocates a proxy token from the hosted service.
#[tauri::command]
pub async fn cli_agent_create(mut params: CreateCodeSessionParams) -> Result<CodeSession, String> {
    let session_id = format!(
        "{}{}-{}",
        CLI_SESSION_PREFIX,
        chrono::Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4().simple()
    );

    // Parse key_source from params.
    //
    // - Missing or empty string → default `OwnKey` (BYOK is the safe choice
    //   when the frontend has not opted into market billing).
    // - Non-empty but unknown string → reject. A typo here would otherwise
    //   silently route a market session into BYOK billing (or vice versa)
    //   for the rest of the session lifetime.
    let key_source = match params.key_source.as_deref() {
        None | Some("") => KeySource::OwnKey,
        Some(value) => {
            KeySource::parse(value).ok_or_else(|| format!("Unknown key_source: {value:?}"))?
        }
    };

    // If key_source is HostedKey, allocate proxy token internally
    if key_source == KeySource::HostedKey {
        let hosted_token = params
            .hosted_token
            .as_deref()
            .filter(|t| !t.is_empty())
            .ok_or("hosted_token required when key_source is hosted_key")?;

        let allocation = integrations::proxy::allocate_proxy_token_internal(
            &params.cli_agent_type,
            params.model.as_deref(),
            params.tier.as_deref(),
            None, // pricing_type
            hosted_token,
        )
        .await?;

        tracing::info!(
            "[CodeSession] Allocated proxy token for hosted_key session {}",
            session_id
        );

        // Update params with allocated proxy credentials
        params.proxy_token = Some(allocation.proxy_token);
        params.proxy_url = Some(allocation.proxy_url);
        params.proxy_session_id = allocation.session_id;

        // If proxy returned a model name, use it (model mapping done server-side)
        if let Some(model_name) = allocation.model_name {
            params.model = Some(model_name);
        }
    }

    let isolate = params.isolate.unwrap_or(false);
    let repo_path = params.repo_path.clone();
    let branch_for_worktree = params.branch.clone();
    let reuse_worktree_path = params.worktree_path.clone();

    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || {
            persistence::create_session(&sid, &params)
                .map_err(|e| format!("Failed to create session: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Set up worktree isolation if requested
    if isolate {
        if let Some(ref rp) = repo_path {
            if !rp.is_empty() {
                // Read the user-configured worktree limit from settings at call time.
                let max_count: Option<usize> = settings::file_io::read_settings()
                    .ok()
                    .and_then(|settings_value| {
                        settings_value
                            .get(WORKTREE_MAX_COUNT_SETTING)
                            .and_then(|count| count.as_u64())
                    })
                    .map(|count| count as usize);

                let repo = std::path::Path::new(rp);
                let wt_info = tokio::task::spawn_blocking({
                    let repo = repo.to_path_buf();
                    let sid = session_id.clone();
                    let base = branch_for_worktree.clone();
                    move || {
                        worktree::create_session_worktree(&repo, &sid, base.as_deref(), max_count)
                    }
                })
                .await
                .map_err(|e| format!("Task error: {}", e))??;

                let wt_path = wt_info.path.clone();
                let wt_branch = wt_info.branch.clone();
                let wt_base = wt_info.base_branch.clone().unwrap_or_default();

                let db_result = tokio::task::spawn_blocking({
                    let sid = session_id.clone();
                    move || {
                        persistence::update_worktree_info(
                            &sid,
                            &wt_info.path,
                            &wt_info.branch,
                            wt_info.base_branch.as_deref().unwrap_or(""),
                        )
                        .map_err(|e| format!("Failed to store worktree info: {}", e))
                    }
                })
                .await
                .map_err(|e| format!("Task error: {}", e))?;

                // If DB update fails, clean up the orphaned worktree
                if let Err(ref err) = db_result {
                    tracing::error!(
                        "[CodeSession] DB update failed, cleaning up worktree: {}",
                        err
                    );
                    let _ = worktree::remove_session_worktree(repo, &session_id, true);
                }
                db_result?;

                // Broadcast worktree creation event
                let ws_msg = serde_json::json!({
                    "type": "code_session.worktree_created",
                    "session_id": session_id,
                    "worktree_path": wt_path,
                    "branch": wt_branch,
                    "base_branch": wt_base,
                });
                crate::api::websocket_handler::broadcast(ws_msg.to_string());

                // Return the updated session with worktree info
                let updated = tokio::task::spawn_blocking({
                    let sid = session_id.clone();
                    move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
                })
                .await
                .map_err(|e| format!("Task error: {}", e))??;

                if let Some(updated_session) = updated {
                    return Ok(updated_session);
                }
            }
        }
    } else if let Some(worktree_path) = reuse_worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        // Reuse an existing worktree checkout: pin the session's cwd and
        // merge flow to it. The base ref is already baked into the checkout.
        if !std::path::Path::new(worktree_path).is_dir() {
            return Err(format!(
                "Selected worktree path does not exist: {worktree_path}"
            ));
        }
        let updated = tokio::task::spawn_blocking({
            let sid = session_id.clone();
            let path = worktree_path.to_string();
            let repo = repo_path.clone();
            move || -> Result<Option<CodeSession>, String> {
                let worktree_branch = repo
                    .as_deref()
                    .filter(|repo| !repo.is_empty())
                    .and_then(|repo| worktree::list_all_worktrees(std::path::Path::new(repo)).ok())
                    .and_then(|entries| {
                        entries
                            .into_iter()
                            .find(|entry| entry.path == path)
                            .map(|entry| entry.branch)
                    })
                    .unwrap_or_default();
                persistence::update_worktree_info(&sid, &path, &worktree_branch, "")
                    .map_err(|e| format!("Failed to store worktree info: {}", e))?;
                persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
            }
        })
        .await
        .map_err(|e| format!("Task error: {}", e))??;

        if let Some(updated_session) = updated {
            return Ok(updated_session);
        }
    }

    Ok(session)
}

/// Park a TUI-hosted session when its terminal pane goes away (PTY exit or
/// tab close). Non-TUI sessions and already-terminal rows are left alone.
#[tauri::command]
pub async fn cli_agent_tui_release(session_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || super::tui_bridge::release_tui_session(&session_id))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

/// Run a code session (spawn CLI agent in background).
#[tauri::command]
pub async fn cli_agent_run(
    session_id: String,
    user_input: String,
    cli_resume_id: Option<String>,
    ide_context: Option<IdeContext>,
    mode: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    tracing::info!(
        session_id = %session_id,
        has_resume_id = cli_resume_id.is_some(),
        mode = ?mode,
        image_count = images.as_ref().map(|items| items.len()).unwrap_or(0),
        "cli_agent_run: received run request"
    );

    if let Some(requested_mode) = mode.as_deref() {
        let sid = session_id.clone();
        let requested_mode = requested_mode.to_string();
        tokio::task::spawn_blocking(move || {
            persistence::update_agent_exec_mode(&sid, &requested_mode)
                .map_err(|err| format!("DB error: {}", err))
        })
        .await
        .map_err(|err| format!("Task error: {}", err))??;
    }

    // Hold lock across check + spawn + insert to prevent duplicate agents from
    // concurrent calls (e.g., double-click). tokio::spawn returns immediately so
    // the lock is held only briefly.
    let mut sessions = session_runner::RUNNING_SESSIONS.lock().await;

    // Guard: prevent duplicate parallel agents for the same session
    if let Some(handle) = sessions.get(&session_id) {
        if !handle.is_finished() {
            return Err(format!(
                "Session {} already has a running agent. Cancel it first.",
                session_id
            ));
        }
    }

    let sid = session_id.clone();
    let cli_input = inject_ide_context_into_prompt(&user_input, ide_context.as_ref());
    let resume_id = cli_resume_id.clone();
    let agent_mode = mode.clone();

    tracing::info!(session_id = %session_id, "cli_agent_run: spawning background runner");

    // Spawn as background task
    let handle = tokio::spawn(async move {
        if let Err(e) = session_runner::run_session(
            sid.clone(),
            cli_input,
            resume_id,
            agent_mode.as_deref(),
            images,
        )
        .await
        {
            tracing::error!("[CodeSession] Session {} failed: {}", sid, e);
            session_runner::flush_cli_streams_for_session(&sid);
            // Best-effort: if marking the row as Failed itself fails, log
            // it explicitly rather than silently dropping the persistence
            // error — the session row may be left in `Running` until the
            // health checker repairs it on next pass.
            if let Err(persist_err) =
                persistence::update_status_with_error(&sid, SessionStatus::Failed, &e)
            {
                tracing::error!(
                    "[CodeSession] failed to mark session {} as Failed: {}",
                    sid,
                    persist_err
                );
            }
            integrations::proxy::server::stop_session_proxy(&sid).await;
            session_runner::release_proxy_token_for_session_pub(&sid).await;
        }
        // Remove finished entry from RUNNING_SESSIONS to prevent unbounded growth
        session_runner::RUNNING_SESSIONS.lock().await.remove(&sid);
    });

    sessions.insert(session_id.clone(), handle);
    tracing::info!(session_id = %session_id, "cli_agent_run: background runner registered");

    persistence::update_status(&session_id, SessionStatus::Running)
        .map_err(|err| format!("DB error updating status: {err}"))?;
    let running_msg = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": "running",
    });
    crate::api::websocket_handler::broadcast(running_msg.to_string());

    Ok(())
}

/// Send a follow-up message to a running or completed session.
///
/// Kills any existing running agent (OS process + proxy), re-allocates a fresh
/// proxy token (the previous one was released on completion), loads the CLI
/// session ID for resume, then re-runs with the new input.
///
/// If `model` or `account_id` is provided, updates the session config before
/// re-running so the CLI uses the newly selected model/key.
#[tauri::command]
pub async fn cli_agent_message(
    session_id: String,
    content: String,
    model: Option<String>,
    account_id: Option<String>,
    ide_context: Option<IdeContext>,
    mode: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    tracing::info!(
        session_id = %session_id,
        has_model_override = model.is_some(),
        has_account_override = account_id.is_some(),
        mode = ?mode,
        image_count = images.as_ref().map(|items| items.len()).unwrap_or(0),
        "cli_agent_message: received follow-up"
    );

    // Load the session for resume ID and proxy re-allocation
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    tracing::info!(
        session_id = %session_id,
        session_status = ?session.status,
        session_account_id = ?session.account_id,
        session_cli_session_id = ?session.cli_session_id,
        key_source = ?session.key_source,
        "cli_agent_message: loaded session"
    );

    let target_account_id = account_id.as_deref().or(session.account_id.as_deref());

    // If the user switched model/account, persist the change so run_session picks it up.
    if model.is_some() || account_id.is_some() {
        let sid = session_id.clone();
        let mdl = model.clone();
        let acc = account_id.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(err) =
                persistence::update_model_and_account(&sid, mdl.as_deref(), acc.as_deref())
            {
                tracing::warn!(
                    "[CodeSession] Failed to update model/account for follow-up: {}",
                    err
                );
            }
        })
        .await
        .map_err(|e| format!("Task error: {}", e))?;

        if let Some(ref new_account_id) = account_id {
            if session.account_id.as_deref() != Some(new_account_id.as_str()) {
                agent_core::lifecycle::emit_session_account_switched(
                    agent_core::interaction::plan_approval::global_app_handle(),
                    &session_id,
                    session.account_id.as_deref(),
                    new_account_id,
                    model.as_deref().or(session.model.as_deref()),
                );
            }
        }
    }

    // Kill the existing agent process, Tokio task, and per-session proxy.
    tracing::info!(session_id = %session_id, "cli_agent_message: killing existing runner");
    session_runner::kill_running_agent(&session_id).await;
    tracing::info!(session_id = %session_id, "cli_agent_message: existing runner cleanup complete");

    // Resolve the resume id AFTER the old runner is dead — a slow runner
    // can commit a fresh cli_session_id right up until the kill, so an
    // earlier read would resume one conversation-id behind (TOCTOU on
    // same-account follow-ups). Reading post-kill from a fresh row sees
    // the runner's final commit.
    let fresh_cli_session_id = {
        let sid = session_id.clone();
        tokio::task::spawn_blocking(move || persistence::get_session(&sid))
            .await
            .map_err(|e| format!("Task error: {}", e))?
            .map_err(|err| format!("DB error: {}", err))?
            .and_then(|s| s.cli_session_id)
    };
    let cli_resume_id = persistence::get_cli_session_id_for_account(&session_id, target_account_id)
        .map_err(|err| format!("DB error: {}", err))?
        .or_else(|| {
            if account_id
                .as_deref()
                .is_some_and(|new_account_id| session.account_id.as_deref() != Some(new_account_id))
            {
                None
            } else {
                fresh_cli_session_id
            }
        });

    tracing::info!(
        session_id = %session_id,
        target_account_id = ?target_account_id,
        cli_resume_id = ?cli_resume_id,
        "cli_agent_message: resolved resume state"
    );

    // For hosted_key sessions (or legacy proxy billing), allocate a fresh token.
    // The previous token was released when the last run completed (or expired
    // via the agent-proxy inactivity timeout), so we must get a new one.
    let needs_proxy = session.key_source == KeySource::HostedKey;
    if needs_proxy {
        let hosted_token = session.hosted_token.as_deref().unwrap_or("");
        if hosted_token.is_empty() {
            return Err("Cannot send follow-up: no market token stored on session".to_string());
        }

        let platform = session.cli_agent_type.as_deref().unwrap_or("");
        let mdl = model.as_deref().or(session.model.as_deref());
        let tier = session.tier.as_deref();

        let allocation = integrations::proxy::allocate_proxy_token_internal(
            platform,
            mdl,
            tier,
            None,
            hosted_token,
        )
        .await?;

        tracing::info!(
            "[CodeSession] Re-allocated proxy token for follow-up on session {}",
            session_id
        );

        // Persist new credentials so run_session reads them
        let sid = session_id.clone();
        let token = allocation.proxy_token.clone();
        let url = allocation.proxy_url.clone();
        let proxy_sid = allocation.session_id.clone();
        tokio::task::spawn_blocking(move || {
            persistence::update_proxy_credentials(&sid, &token, &url, proxy_sid.as_deref())
                .map_err(|e| format!("DB error: {}", e))
        })
        .await
        .map_err(|e| format!("Task error: {}", e))??;
    }

    // Re-run the session with the new message
    tracing::info!(session_id = %session_id, "cli_agent_message: dispatching rerun");
    cli_agent_run(
        session_id,
        content,
        cli_resume_id,
        ide_context,
        mode,
        images,
    )
    .await
}

/// Respond to a pending approval request from a CLI agent.
///
/// Two registries can be waiting on this:
/// - **Hook approvals** (managed Claude Code shell-out sessions): a parked
///   `PermissionRequest` hook long-poll keyed by `request_id`
///   (`hookperm-*`, from the `permission:request` wire event). Checked
///   first. `always_allow` maps to a plain allow — persistent rules stay
///   with Claude's own permission store.
/// - **ACP agents** (OpenCode, Copilot, Kiro): a `session/request_permission`
///   parked in `acp_common::PENDING_APPROVALS`, keyed by `request_id`
///   (`acpperm-*`, from the `permission:request` wire event with
///   `origin: "acp"`), with a session-id fallback.
#[tauri::command]
pub async fn cli_agent_approval_response(
    session_id: String,
    approved: bool,
    always_allow: Option<bool>,
    request_id: Option<String>,
) -> Result<(), String> {
    if crate::agent_sessions::cli::hook_approvals::has_pending_hook_approval(
        &session_id,
        request_id.as_deref(),
    ) {
        return crate::agent_sessions::cli::hook_approvals::resolve_hook_approval(
            &session_id,
            request_id.as_deref(),
            approved,
        );
    }
    crate::agent_sessions::cli::parsers::acp_common::resolve_approval(
        &session_id,
        request_id.as_deref(),
        approved,
        always_allow.unwrap_or(false),
    )
    .await
}

/// Get session status.
#[tauri::command]
pub async fn cli_agent_status(session_id: String) -> Result<Option<CodeSession>, String> {
    tokio::task::spawn_blocking(move || {
        persistence::get_session(&session_id).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Get the last ORGII-side history mutation that invalidated native CLI resume state.
#[tauri::command]
pub async fn cli_agent_history_mutation(
    session_id: String,
) -> Result<Option<CliHistoryMutation>, String> {
    tokio::task::spawn_blocking(move || {
        persistence::get_history_mutation(&session_id).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Cancel a running session.
#[tauri::command]
pub async fn cli_agent_cancel(
    session_id: String,
    reason: Option<CancelReason>,
) -> Result<bool, String> {
    session_runner::cancel_session(&session_id, reason.unwrap_or_default()).await
}

/// List all code sessions.
#[tauri::command]
pub async fn cli_agent_list() -> Result<Vec<CodeSession>, String> {
    tokio::task::spawn_blocking(|| {
        persistence::list_sessions().map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Where a managed session's transcript of record lives, for display
/// surfaces (session hover card storage row).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTranscriptLocation {
    /// True when the transcript lives in the CLI's native store
    /// (`code_sessions.transcript_source = 'native'`), not `sessions.db`.
    pub native: bool,
    /// Resolved native store path (e.g. a Codex rollout jsonl), when the
    /// imported-history cache already knows it. `None` for chunks-mode
    /// sessions, or for native sessions not yet scanned into the cache.
    pub path: Option<String>,
}

/// Resolve the storage location of a session's transcript of record.
/// Chunks-mode (legacy) sessions report `native: false` — the caller keeps
/// showing `sessions.db`. Native sessions report the CLI store file path when
/// the imported-history cache has it, else `native: true` with no path.
#[tauri::command]
pub async fn cli_agent_transcript_path(
    session_id: String,
) -> Result<CliTranscriptLocation, String> {
    tokio::task::spawn_blocking(move || {
        use super::native_transcript;
        let is_native = persistence::get_session(&session_id)
            .map_err(|e| format!("DB error: {}", e))?
            .is_some_and(|session| {
                session.transcript_source == native_transcript::TRANSCRIPT_SOURCE_NATIVE
            });
        if !is_native {
            return Ok(CliTranscriptLocation {
                native: false,
                path: None,
            });
        }
        // Native session with no bound CLI id yet (first turn still running,
        // or crash before bind): native, but no path to show.
        let Some((binding, cli_session_id)) =
            native_transcript::native_store_key_for_managed_session(&session_id)
        else {
            return Ok(CliTranscriptLocation {
                native: true,
                path: None,
            });
        };
        let conn = database::db::get_connection()
            .map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))?;
        // Exact match first; Codex caches key on the rollout file stem, which
        // only the `-`-bounded suffix variant matches.
        let mut path =
            orgtrack_core::sources::imported_history::cache::get_cached_source_path_from_conn(
                &conn,
                binding.source,
                &cli_session_id,
            )?;
        if path.is_none() {
            path = orgtrack_core::sources::imported_history::cache::
                get_cached_source_path_by_suffix_from_conn(&conn, binding.source, &cli_session_id)?;
        }
        Ok(CliTranscriptLocation { native: true, path })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Truncate chunks at and after a specific timestamp.
/// Used for message editing — removes chunks at or after the given timestamp,
/// kills the running agent, clears CLI resume state, and optionally restores file snapshots.
#[tauri::command]
pub async fn cli_agent_truncate_after_chunk(
    session_id: String,
    created_at: String,
    revert_files: Option<bool>,
) -> Result<i64, String> {
    // Kill any running agent first to prevent it from writing new chunks
    session_runner::kill_running_agent(&session_id).await;

    // Wipe the Cursor config dir so the agent starts fresh — legacy chunk mode
    // ONLY. Under `transcript_source = 'native'` that directory IS the
    // transcript of record (hosted-key Cursor stores its chats under the
    // per-session config dir), so deleting it would erase the whole
    // conversation instead of truncating it. The fork is driven by
    // `clear_cli_resume_state_with_tx` inside the truncate below: with no
    // resume id the CLI opens a fresh conversation, and the superseded store
    // stays on disk hidden behind the native-transcript ledger — the same
    // semantics Claude/Codex native forks already have.
    if persistence::session_persists_chunks(&session_id) {
        session_runner::cleanup_cursor_config_dir(&session_id);
    }

    let should_revert_files = revert_files.unwrap_or(true);
    if should_revert_files {
        let rewind_sid = session_id.clone();
        let rewind_ts = created_at.clone();
        let stats = tokio::task::spawn_blocking(move || {
            agent_core::tools::file_history::rewind_to_message(&rewind_sid, &rewind_ts)
        })
        .await
        .map_err(|err| format!("Task error: {}", err))?
        .map_err(|err| format!("File history rewind failed: {}", err))?;

        tracing::info!(
            "[code_session] file-history rewind at {}: restored={} deleted={} skipped={} failed={}",
            created_at,
            stats.restored,
            stats.deleted,
            stats.skipped_unchanged,
            stats.failed,
        );
    }

    let sid = session_id.clone();
    let mutation_reason = if should_revert_files {
        agent_core::foundation::session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND
    } else {
        agent_core::foundation::session_bridge::CLI_HISTORY_MUTATION_MESSAGE_TRUNCATE
    };
    tokio::task::spawn_blocking(move || {
        persistence::truncate_chunks_after_with_reason(&sid, &created_at, mutation_reason)
            .map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

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
    if session.status == super::types::SessionStatus::Running {
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
        if session.worktree_path.is_some() {
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
                        tracing::warn!("[CodeSession] worktree cleanup failed on delete: {}", err);
                    }
                    Err(join_err) => {
                        tracing::warn!(
                            "[CodeSession] worktree cleanup task panicked on delete: {}",
                            join_err
                        );
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

/// Merge a session's worktree branch back into the base branch.
#[tauri::command]
pub async fn cli_agent_merge(
    session_id: String,
    strategy: Option<String>,
) -> Result<WorktreeMergeResult, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;

    if session.worktree_path.is_none() {
        return Err("Session does not use worktree isolation".to_string());
    }

    let base_branch = session
        .base_branch
        .as_deref()
        .ok_or("Session has no base_branch recorded")?
        .to_string();

    let merge_strategy = MergeStrategy::parse(strategy.as_deref().unwrap_or("auto"));

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid = session_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        worktree::merge_session_worktree(&repo, &sid, &base_branch, merge_strategy)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Update merge status in DB
    let merge_status = if result.merged {
        "merged"
    } else if !result.conflicts.is_empty() {
        "conflict"
    } else {
        "failed"
    };
    let sid = session_id.clone();
    let ms = merge_status.to_string();
    tokio::task::spawn_blocking(move || {
        persistence::update_merge_status(&sid, &ms).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Clean up worktree after successful merge
    if result.merged {
        if let Some(ref rp) = session.repo_path {
            let repo = std::path::Path::new(rp).to_path_buf();
            let sid = session_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(err) = worktree::remove_session_worktree(&repo, &sid, true) {
                    tracing::warn!(
                        "[CodeSession] Failed to clean up worktree after merge: {}",
                        err
                    );
                }
            })
            .await;
        }
    }

    // Broadcast merge result
    let ws_msg = serde_json::json!({
        "type": "code_session.merge_result",
        "session_id": session_id,
        "status": merge_status,
        "merged": result.merged,
        "conflicts": result.conflicts,
    });
    crate::api::websocket_handler::broadcast(ws_msg.to_string());

    Ok(result)
}

/// Get diff between a session's worktree branch and its base branch.
#[tauri::command]
pub async fn cli_agent_worktree_diff(session_id: String) -> Result<String, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;
    let base_branch = session
        .base_branch
        .as_deref()
        .ok_or("Session has no base_branch")?;

    if session.worktree_path.is_none() {
        return Err("Session does not use worktree isolation".to_string());
    }

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid = session_id.clone();
    let base = base_branch.to_string();

    tokio::task::spawn_blocking(move || worktree::get_session_diff(&repo, &sid, &base))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

/// Discard a session's worktree (remove worktree and delete branch).
#[tauri::command]
pub async fn cli_agent_worktree_discard(session_id: String) -> Result<bool, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;

    if session.worktree_path.is_none() {
        return Err("Session does not use worktree isolation".to_string());
    }

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid_for_wt = session_id.clone();
    tokio::task::spawn_blocking(move || {
        worktree::remove_session_worktree(&repo, &sid_for_wt, true)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
    .map_err(|e| format!("Failed to remove worktree: {}", e))?;

    let sid = session_id.clone();
    tokio::task::spawn_blocking(move || {
        persistence::update_merge_status(&sid, "skipped").map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    Ok(true)
}
