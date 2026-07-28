//! `cli_agent_create` — session row + optional git worktree provisioning,
//! including hosted-key proxy token allocation and rollback on failure.

use super::super::persistence::{self, CodeSession, CreateCodeSessionParams};
use super::super::session_runner;
use super::super::types::KeySource;
use core_types::session::CLI_SESSION_PREFIX;
use git::worktree;
use settings;

const WORKTREE_MAX_COUNT_SETTING: &str = "git.worktree.maxCount";

async fn rollback_cli_session_after_launch_failure(session_id: &str) -> Result<(), String> {
    // The proxy release lookup needs the persisted row, so release before the
    // rollback deletes it. Release is best-effort and server TTL remains the
    // final fallback if the market cannot be reached.
    session_runner::release_proxy_token_for_session_pub(session_id).await;

    let sid = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        persistence::delete_session(&sid)
            .map(|_| ())
            .map_err(|error| format!("Failed to roll back CLI session {sid}: {error}"))
    })
    .await
    .map_err(|error| format!("CLI session rollback task failed: {error}"))?
}

async fn release_unpersisted_proxy_allocation(params: &CreateCodeSessionParams) {
    let (Some(proxy_token), Some(hosted_token)) = (
        params.proxy_token.as_deref(),
        params.hosted_token.as_deref(),
    ) else {
        return;
    };

    match integrations::proxy::release_proxy_token_internal(
        proxy_token,
        params.proxy_session_id.as_deref(),
        hosted_token,
    )
    .await
    {
        Ok(true) => tracing::info!("[CodeSession] Released unpersisted proxy allocation"),
        Ok(false) => tracing::warn!("[CodeSession] Market rejected unpersisted proxy release"),
        Err(error) => tracing::warn!(
            "[CodeSession] Failed to release unpersisted proxy allocation: {}",
            error
        ),
    }
}

async fn remove_cli_session_worktree(
    repo_path: &std::path::Path,
    session_id: &str,
) -> Result<(), String> {
    let repo = repo_path.to_path_buf();
    let sid = session_id.to_string();
    tokio::task::spawn_blocking(move || worktree::remove_session_worktree(&repo, &sid, true))
        .await
        .map_err(|error| format!("Worktree cleanup task failed: {error}"))?
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

    let isolate = params.isolate.unwrap_or(false);
    let requested_worktree_path = params
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty());
    if isolate && requested_worktree_path.is_some() {
        return Err("isolate and worktreePath are mutually exclusive".to_string());
    }
    if params
        .worktree_base_ref
        .as_deref()
        .is_some_and(|base| !base.trim().is_empty())
        && !isolate
    {
        return Err("worktreeBaseRef requires isolate=true".to_string());
    }

    let repo_path = params.repo_path.clone();
    if isolate
        && !repo_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
    {
        return Err("Worktree mode requires a workspace path".to_string());
    }
    let existing_worktree = match (repo_path.as_deref(), requested_worktree_path.as_deref()) {
        (Some(repo), Some(path)) => {
            if repo.trim().is_empty() {
                return Err("Worktree mode requires a workspace path".to_string());
            }
            let repo = std::path::PathBuf::from(repo);
            let path = std::path::PathBuf::from(path);
            Some(
                tokio::task::spawn_blocking(move || {
                    worktree::validate_existing_worktree(&repo, &path)
                })
                .await
                .map_err(|err| format!("Worktree validation task failed: {err}"))??,
            )
        }
        (None, Some(_)) => {
            return Err("Worktree mode requires a workspace path".to_string());
        }
        _ => None,
    };

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

    // `branch` is session/display metadata. Only the dedicated base-ref field
    // is allowed to influence fresh worktree creation.
    let branch_for_worktree = params.worktree_base_ref.clone();

    let create_result = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        let create_params = params.clone();
        move || {
            persistence::create_session(&sid, &create_params)
                .map_err(|e| format!("Failed to create session: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))
    .and_then(|result| result);
    let session = match create_result {
        Ok(session) => session,
        Err(error) => {
            if key_source == KeySource::HostedKey {
                release_unpersisted_proxy_allocation(&params).await;
            }
            return Err(error);
        }
    };

    if let Some(existing) = existing_worktree {
        let updated_result = tokio::task::spawn_blocking({
            let sid = session_id.clone();
            let path = existing.path;
            let branch = existing.branch;
            move || {
                let updated = persistence::update_existing_worktree_info(&sid, &path, &branch)
                    .map_err(|err| format!("Failed to store existing worktree info: {err}"))?;
                if !updated {
                    return Err(format!(
                        "CLI session {sid} disappeared before worktree persistence"
                    ));
                }
                persistence::get_session(&sid).map_err(|err| format!("DB error: {err}"))
            }
        })
        .await
        .map_err(|err| format!("Task error: {err}"))
        .and_then(|result| result);

        return match updated_result {
            Ok(Some(updated)) => Ok(updated),
            Ok(None) => {
                let message =
                    format!("CLI session {session_id} disappeared after worktree persistence");
                let _ = rollback_cli_session_after_launch_failure(&session_id).await;
                Err(message)
            }
            Err(error) => {
                let rollback_error = rollback_cli_session_after_launch_failure(&session_id)
                    .await
                    .err();
                Err(match rollback_error {
                    Some(rollback_error) => format!("{error}; {rollback_error}"),
                    None => error,
                })
            }
        };
    }

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
                let worktree_result = tokio::task::spawn_blocking({
                    let repo = repo.to_path_buf();
                    let sid = session_id.clone();
                    let base = branch_for_worktree.clone();
                    move || {
                        worktree::create_session_worktree(&repo, &sid, base.as_deref(), max_count)
                    }
                })
                .await
                .map_err(|e| format!("Task error: {}", e))
                .and_then(|result| result);
                let wt_info = match worktree_result {
                    Ok(info) => info,
                    Err(error) => {
                        let rollback_error = rollback_cli_session_after_launch_failure(&session_id)
                            .await
                            .err();
                        return Err(match rollback_error {
                            Some(rollback_error) => format!("{error}; {rollback_error}"),
                            None => error,
                        });
                    }
                };

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
                .map_err(|e| format!("Task error: {}", e))
                .and_then(|result| result);

                // If DB update fails, clean up the orphaned worktree
                if let Err(error) = db_result {
                    tracing::error!(
                        "[CodeSession] DB update failed, cleaning up worktree: {}",
                        error
                    );
                    let cleanup_error = remove_cli_session_worktree(repo, &session_id).await.err();
                    let rollback_error = rollback_cli_session_after_launch_failure(&session_id)
                        .await
                        .err();
                    return Err(format!(
                        "{error}{}{}",
                        cleanup_error
                            .map(|error| format!("; worktree cleanup failed: {error}"))
                            .unwrap_or_default(),
                        rollback_error
                            .map(|error| format!("; {error}"))
                            .unwrap_or_default()
                    ));
                }

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
                let updated_result = tokio::task::spawn_blocking({
                    let sid = session_id.clone();
                    move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
                })
                .await
                .map_err(|e| format!("Task error: {}", e))
                .and_then(|result| result);

                let launch_error = match updated_result {
                    Ok(Some(updated_session)) => return Ok(updated_session),
                    Ok(None) => {
                        format!("CLI session {session_id} disappeared after worktree persistence")
                    }
                    Err(error) => error,
                };

                let cleanup_error = remove_cli_session_worktree(repo, &session_id)
                    .await
                    .err()
                    .map(|error| error.to_string());
                let rollback_error = rollback_cli_session_after_launch_failure(&session_id)
                    .await
                    .err();
                return Err(format!(
                    "{launch_error}{}{}",
                    cleanup_error
                        .map(|error| format!("; worktree cleanup failed: {error}"))
                        .unwrap_or_default(),
                    rollback_error
                        .map(|error| format!("; {error}"))
                        .unwrap_or_default()
                ));
            }
        }
    }

    Ok(session)
}
