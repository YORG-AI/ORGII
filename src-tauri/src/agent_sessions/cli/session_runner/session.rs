//! Core session execution — spawns CLI agent, parses stdout, broadcasts events.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent_sessions::cli::parsers::copilot;
use crate::agent_sessions::cli::parsers::kiro;
use crate::api::websocket_handler;
use key_vault::key_store::{KeyService, ModelType, KEY_SERVICE};

use super::super::launch_profile_store::resolve_cli_launch_profile;
use super::super::persistence;
use super::super::types::{KeySource, SessionStatus};
use super::command::{
    build_command_with_launch_profile, create_parser, launch_profile_env, CliCommandBuildRequest,
};
use super::helpers::{
    clear_live_status, emit_chunk, flush_and_broadcast, persist_attached_images,
    snapshot_cli_file_edit, strip_ide_context,
};
use super::oauth_setup::{
    is_cli_chunk_replay_unsafe, is_cli_oauth_failure_message, is_cli_oauth_stderr_retry_candidate,
    is_retryable_cli_oauth_failure_chunk, is_retryable_overloaded_chunk,
    refresh_cli_oauth_for_retry, sanitize_cli_oauth_env_for_child,
};
use super::plan_approval::{
    create_plan_content_from_chunk, is_successful_mode_tool, plan_candidate_path_from_chunk,
    register_cli_plan_approval, register_synthetic_cli_plan_approval,
};

const SPAWN_RETRY_ATTEMPTS: usize = 3;
const SPAWN_RETRY_BASE_DELAY_MS: u64 = 250;
const CLI_PLAN_GATE_NATURAL_EXIT_GRACE_SECS: u64 = 45;

#[allow(clippy::too_many_arguments)]
async fn persist_round_token_usage(
    session_id: String,
    model: Option<String>,
    account_id: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_tokens: i64,
) {
    let result = tokio::task::spawn_blocking(move || {
        session_persistence::token_usage::insert_token_usage_record(
            &session_id,
            "code",
            model.as_deref(),
            account_id.as_deref(),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            0,
            None,
        )
    })
    .await;
    if let Err(err) = result
        .map_err(|join_err| join_err.to_string())
        .and_then(|db_result| db_result.map_err(|db_err| db_err.to_string()))
    {
        tracing::warn!("[CodeSession] Failed to insert per-round token usage: {err}");
    }
}

fn is_transient_spawn_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) || transient_spawn_os_error(err)
}

#[cfg(unix)]
fn transient_spawn_os_error(err: &io::Error) -> bool {
    err.raw_os_error().is_some_and(|code| code == libc::EAGAIN)
}

#[cfg(not(unix))]
fn transient_spawn_os_error(_err: &io::Error) -> bool {
    false
}

/// Run a code session: spawn CLI, parse stdout, broadcast events.
///
/// This is spawned as a background Tokio task.
/// When `cli_resume_id` is provided, the CLI is launched with the appropriate
/// resume flag to continue a previous conversation.
pub async fn run_session(
    session_id: String,
    user_input: String,
    cli_resume_id: Option<String>,
    mode: Option<&str>,
    images: Option<Vec<String>>,
    turn_intent_id: Option<&str>,
) -> Result<(), String> {
    let load_session_id = session_id.clone();
    let session = tokio::task::spawn_blocking(move || persistence::get_session(&load_session_id))
        .await
        .map_err(|err| format!("Task error: {err}"))?
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let cli_agent_type_str = session
        .cli_agent_type
        .as_deref()
        .ok_or("cli_agent_type is required but was not set on the session")?;
    let agent = ModelType::from_str(cli_agent_type_str).ok_or_else(|| {
        format!(
            "Unknown CLI agent type: '{}'. Supported: cursor_cli, claude_code, codex, kiro, copilot, opencode",
            cli_agent_type_str
        )
    })?;
    // When using a cross-type compatible key (e.g. moonshot_api key for claude_code),
    // the model override is injected via ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL env vars
    // in agent_env_builder. Passing --model with a provider-specific name (e.g. "kimi-for-coding")
    // triggers Claude Code's model validation and fails. Skip --model in that case.
    let mut selected_key = session
        .account_id
        .as_deref()
        .and_then(|id| key_vault::key_store::KEY_SERVICE.get_key_by_id(id));
    if session.key_source == KeySource::OwnKey {
        if let Some(account_id) = session.account_id.as_deref() {
            selected_key = match agent {
                ModelType::Codex => {
                    Some(KEY_SERVICE.ensure_codex_oauth_key_fresh(account_id).await?)
                }
                ModelType::ClaudeCode => Some(
                    KEY_SERVICE
                        .ensure_claude_code_oauth_key_fresh(account_id)
                        .await?,
                ),
                _ => selected_key,
            };
        }
    }
    let key_model_type = selected_key.as_ref().map(|key| key.model_type.clone());
    let is_cross_type_key = key_model_type.as_ref().is_some_and(|kt| kt != &agent);
    let model = if is_cross_type_key {
        None
    } else {
        session.model.as_deref()
    };
    let repo_path = session.repo_path.as_deref();
    let account_id = session.account_id.as_deref();

    if matches!(agent, ModelType::CursorCli) && session.key_source == KeySource::OwnKey {
        let has_api_key = selected_key
            .as_ref()
            .and_then(|key| key.api_key.as_deref())
            .is_some_and(|api_key| !api_key.trim().is_empty());
        let has_session_token = selected_key
            .as_ref()
            .and_then(|key| key.session_token.as_deref())
            .is_some_and(|session_token| !session_token.trim().is_empty());
        if !has_api_key {
            let reason = if has_session_token {
                "Cursor CLI agent requires a Cursor API key or Cursor Agent CLI login state. The saved native session token only works for the native/Rust Cursor provider and cannot authenticate cursor-agent directly."
            } else {
                "Cursor CLI agent requires a Cursor API key or Cursor Agent CLI login state before launching cursor-agent."
            };
            return Err(reason.to_string());
        }
    }

    // Sync skills to agent-native rules files.
    //
    // Agent resolve contract (design doc §11.4) row 17: resolve the built-in SDE agent (the CLI
    // session runner doesn't own an `agent_definition_id`; skills opts
    // are a host-wide concern carried on the SDE definition) and read
    // `skills.enabled` + `skills.disabled` off `ResolvedAgent`.
    let skills_cfg = resolve_sde_skills();
    let setup_agent = agent.clone();
    let setup_repo_path = repo_path.map(str::to_string);
    let setup_session_id = session_id.clone();
    let setup_skills_cfg = skills_cfg.clone();
    let (synced_rule_files, pre_message_snapshot_id) = tokio::task::spawn_blocking(move || {
        let mut synced_rule_files = Vec::new();
        if let Some(path) = setup_repo_path.as_deref() {
            let project = std::path::Path::new(path);
            synced_rule_files.extend(super::super::skill_sync::sync_conventions_for_agent(
                &setup_agent,
                project,
            ));
            synced_rule_files.extend(super::super::skill_sync::sync_skills_for_agent(
                &setup_agent,
                project,
                setup_skills_cfg.enabled,
                &setup_skills_cfg.disabled,
            ));
        }

        // Pre-message anchor snapshot for CLI rollback support.
        let snapshot_id = match agent_core::tools::file_history::make_snapshot(&setup_session_id) {
            Ok(snapshot_id) => {
                tracing::info!(
                    "[code_session] Pre-message anchor snapshot: {}",
                    snapshot_id
                );
                if let Err(err) = agent_core::session::persistence::save_snapshot(
                    &setup_session_id,
                    "__pre_message__",
                    &snapshot_id,
                ) {
                    tracing::warn!(
                        "[code_session] Failed to persist pre-message snapshot: {}",
                        err
                    );
                }
                Some(snapshot_id)
            }
            Err(err) => {
                tracing::warn!("[code_session] Pre-message snapshot failed: {}", err);
                None
            }
        };
        (synced_rule_files, snapshot_id)
    })
    .await
    .map_err(|err| format!("runner setup task failed: {err}"))?;

    let run_started_at = chrono::Utc::now();

    // Resolved early: the experimental codex app-server transport gate
    // changes prompt assembly (images travel as native localImage inputs)
    // as well as argv and the stdout-processing branch below.
    let launch_profile_agent = agent.clone();
    let launch_profile =
        tokio::task::spawn_blocking(move || resolve_cli_launch_profile(&launch_profile_agent))
            .await
            .map_err(|err| format!("launch profile task failed: {err}"))??;
    let use_codex_app_server =
        super::launch_profiles::uses_codex_app_server(&agent, &launch_profile);

    let image_paths = persist_attached_images(&session_id, images.as_deref()).await;

    let prompt_user_input = user_input.clone();
    let prompt_mode = mode.map(str::to_string);
    let prompt_session_id = session_id.clone();
    let prompt_agent = agent.clone();
    let prompt_image_paths = image_paths.clone();
    let prompt_repo_path = repo_path.map(str::to_string);
    let prompt_skills = skills_cfg.clone();
    let is_fresh_session = cli_resume_id.is_none();
    let effective_input = tokio::task::spawn_blocking(move || {
        super::input_assembly::build_effective_input(
            &prompt_user_input,
            prompt_mode.as_deref(),
            &prompt_session_id,
            is_fresh_session,
            &prompt_agent,
            &prompt_image_paths,
            use_codex_app_server,
            prompt_repo_path.as_deref(),
            prompt_skills.enabled,
            &prompt_skills.disabled,
        )
    })
    .await
    .map_err(|err| format!("prompt assembly task failed: {err}"))?;

    // Build CLI command
    let api_key_for_cli = if session.key_source == KeySource::HostedKey
        && (matches!(agent, ModelType::CursorCli) || agent.needs_mitm_proxy())
    {
        session.proxy_token.as_deref()
    } else if session.key_source == KeySource::OwnKey && matches!(agent, ModelType::CursorCli) {
        selected_key.as_ref().and_then(|key| key.api_key.as_deref())
    } else {
        None
    };
    let endpoint_for_cli =
        if session.key_source == KeySource::HostedKey && matches!(agent, ModelType::CursorCli) {
            session.proxy_url.as_deref()
        } else {
            None
        };
    let additional_dirs: &[String] = session.additional_directories.as_deref().unwrap_or(&[]);
    let mut cmd_parts = build_command_with_launch_profile(CliCommandBuildRequest {
        agent: &agent,
        launch_profile: &launch_profile,
        model,
        task: &effective_input,
        resume_id: cli_resume_id.as_deref(),
        api_key: api_key_for_cli,
        endpoint: endpoint_for_cli,
        mode,
        repo_path,
        additional_dirs,
    });

    if matches!(agent, ModelType::Codex) && session.key_source == KeySource::HostedKey {
        if use_codex_app_server {
            // No trailing task argument in app-server argv; `-c` is a valid
            // option after the `app-server` subcommand.
            cmd_parts.push("-c".into());
            cmd_parts.push("model_provider=\"proxy\"".into());
        } else {
            let insert_pos = cmd_parts.len() - 1;
            cmd_parts.insert(insert_pos, "-c".into());
            cmd_parts.insert(insert_pos + 1, "model_provider=\"proxy\"".into());
        }
    }

    let program = &cmd_parts[0];
    let args = &cmd_parts[1..];

    // Log the full command for debugging (redact sensitive values)
    {
        let redacted_args: Vec<String> = cmd_parts
            .iter()
            .enumerate()
            .map(|(idx, part)| {
                if idx > 0
                    && (cmd_parts[idx - 1] == "--api-key" || cmd_parts[idx - 1] == "--market-token")
                {
                    format!(
                        "{}...{}",
                        &part[..part.len().min(6)],
                        &part[part.len().saturating_sub(4)..]
                    )
                } else {
                    part.clone()
                }
            })
            .collect();
        tracing::info!(
            "[CodeSession] Command: {} (resume_id={:?})",
            redacted_args.join(" "),
            cli_resume_id,
        );
    }

    let base_working_dir = repo_path.filter(|p| !p.is_empty()).ok_or_else(|| {
        "repo_path is required — cannot run agent without a working directory".to_string()
    })?;

    let working_dir = session
        .worktree_path
        .as_deref()
        .filter(|p| !p.is_empty() && std::path::Path::new(p).is_dir())
        .unwrap_or(base_working_dir);

    if !std::path::Path::new(&working_dir).is_dir() {
        return Err(format!(
            "Working directory does not exist or is not a directory: {}",
            working_dir
        ));
    }

    let snapshot_working_dir = working_dir.to_string();

    // ── Build environment variables ──
    let mut env_vars = if session.key_source == KeySource::HostedKey {
        let proxy_token = session
            .proxy_token
            .as_deref()
            .ok_or_else(|| "proxy_token is required for market key sessions".to_string())?;
        let proxy_url = session
            .proxy_url
            .as_deref()
            .ok_or_else(|| "proxy_url is required for market key sessions".to_string())?;
        KeyService::get_proxy_env_for_agent(&agent, proxy_token, proxy_url)
    } else {
        KEY_SERVICE.get_env_for_agent(&agent, account_id)
    };

    env_vars.extend(launch_profile_env(&launch_profile));

    // Inherited by the CLI child and, transitively, by its hook subprocesses:
    // lets live-status hook posts attribute directly to this managed session
    // even before the CLI's native session id is known.
    env_vars.insert("ORGII_SESSION_ID".to_string(), session_id.clone());

    // Record the launch permission mode so a PermissionRequest hook
    // long-poll (`POST /hooks/agent-approval`) knows whether this session
    // gets an interactive approval card (Manual) or falls through to the
    // CLI's own launch flags (AutoEdit/FullPermission/Plan). Unregistered
    // on every terminal transition below.
    super::super::hook_approvals::register_session_permission_mode(
        &session_id,
        launch_profile.permission_mode,
    );

    if matches!(agent, ModelType::CursorCli) {
        env_vars.insert("CURSOR_CLI_COMPAT".to_string(), "1".to_string());
    }

    // Store user input (without IDE context)
    let display_input = strip_ide_context(&user_input);
    let input_session_id = session_id.clone();
    let persisted_display_input = display_input.clone();
    tokio::task::spawn_blocking(move || {
        let conn = session_persistence::get_connection().map_err(|e| format!("DB: {}", e))?;
        conn.execute(
            "UPDATE code_sessions SET user_input = ?2 WHERE session_id = ?1",
            rusqlite::params![input_session_id, persisted_display_input],
        )
        .map_err(|e| format!("DB: failed to store user_input: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("Task error: {err}"))??;

    // Start per-session MITM proxy if needed
    let needs_mitm = session.key_source == KeySource::HostedKey && agent.needs_mitm_proxy();

    if needs_mitm {
        super::env_setup::start_session_mitm_proxy(&session, &session_id, &mut env_vars).await?;
    }

    let profile_agent = agent.clone();
    let profile_session = session.clone();
    let profile_account_id = account_id.map(str::to_string);
    let profile_selected_key = selected_key.clone();
    let profile_session_id = session_id.clone();
    let profile_resume_id = cli_resume_id.clone();
    env_vars = tokio::task::spawn_blocking(move || {
        let mut profile_env = env_vars;
        super::env_setup::configure_agent_profile(
            &profile_agent,
            &profile_session,
            profile_account_id.as_deref(),
            profile_selected_key.as_ref(),
            &profile_session_id,
            profile_resume_id.as_deref(),
            &mut profile_env,
        )?;
        Ok::<_, String>(profile_env)
    })
    .await
    .map_err(|err| format!("agent profile setup task failed: {err}"))??;

    super::env_setup::apply_system_proxy_passthrough(&mut env_vars);

    sanitize_cli_oauth_env_for_child(&agent, &mut env_vars);

    // Log environment variables for debugging (redact token values)
    for (key, value) in &env_vars {
        let display_val = if key.to_lowercase().contains("token")
            || key.to_lowercase().contains("key")
            || key.to_lowercase().contains("secret")
        {
            format!(
                "{}...{}",
                &value[..value.len().min(6)],
                &value[value.len().saturating_sub(4)..]
            )
        } else {
            value.clone()
        };
        tracing::info!("[CodeSession] env {}={}", key, display_val);
    }

    super::env_setup::setup_codex_hosted_proxy(&agent, &session, &env_vars).await;

    super::env_setup::setup_opencode_sse_sanitizer(&agent, &mut env_vars).await;

    // ── Spawn subprocess ──
    let is_acp_agent = matches!(
        agent,
        ModelType::Copilot | ModelType::Kiro | ModelType::OpenCode
    );

    const MAX_STDERR_LINES: usize = 20;
    let mut stderr_lines: Arc<Mutex<VecDeque<String>>>;
    let mut exit_code: i32;
    let mut oauth_retry_used = false;
    let mut suppressed_oauth_error: Option<String> = None;
    let mut overload_retry_count: u32 = 0;
    const MAX_OVERLOAD_RETRIES: u32 = 3;
    const OVERLOAD_RETRY_BASE_DELAY_SECS: u64 = 2;

    let sequence_session_id = session_id.clone();
    let base_sequence: i64 = tokio::task::spawn_blocking(move || {
        persistence::max_chunk_sequence(&sequence_session_id).unwrap_or(-1) + 1
    })
    .await
    .map_err(|err| format!("Task error: {err}"))?;

    // Emit user_message chunk
    {
        let now = chrono::Utc::now();
        let now_str = now.to_rfc3339();
        let user_chunk = core_types::activity::ActivityChunk {
            chunk_id: format!("user-input-{}-{}", session_id, now.timestamp_millis()),
            session_id: session_id.clone(),
            action_type: "raw".to_string(),
            function: "user_message".to_string(),
            args: serde_json::json!({}),
            result: {
                let mut res = serde_json::json!({
                    "type": "user",
                    "message": { "content": display_input, "role": "user" }
                });
                if !image_paths.is_empty() {
                    res["images"] = serde_json::json!(image_paths);
                }
                res
            },
            created_at: now_str,
            thread_id: None,
            process_id: None,
            broadcast_only: false,
        };
        // Native-transcript sessions skip both the DB insert and the
        // broadcast: the frontend's synthetic event already renders the user
        // bubble instantly, and the CLI's native store is the transcript of
        // record. Broadcasting here too would render a duplicate bubble.
        let persist_session_id = session_id.clone();
        let persist_user_chunk = user_chunk.clone();
        let persisted_user_chunk = tokio::task::spawn_blocking(move || {
            if !persistence::session_persists_chunks(&persist_session_id) {
                return Ok(false);
            }
            persistence::insert_chunk(&persist_user_chunk, base_sequence)
                .map_err(|err| err.to_string())?;
            Ok::<bool, String>(true)
        })
        .await
        .map_err(|err| format!("Task error: {err}"))?;
        match persisted_user_chunk {
            Err(err) => {
                tracing::error!(
                    "[CodeSession] Failed to persist user_message chunk: {}",
                    err
                );
            }
            Ok(false) => {}
            Ok(true) => {
                let ws_msg = serde_json::json!({
                    "type": "code_session.activity",
                    "session_id": session_id,
                    "chunk": user_chunk,
                });
                websocket_handler::broadcast(ws_msg.to_string());
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Agent-specific stdout processing
    // ═══════════════════════════════════════════════════════════
    let mut sequence: i64 = base_sequence + 1;
    #[allow(unused_assignments)]
    let mut timed_out = false;

    let mut cli_session_id_out: Option<String> = None;
    let mut cli_plan_approval_gate_reached = false;
    // App-server transport: whether the turn reached a non-failed
    // `turn/completed` (drives final status like exit_code does for exec).
    let mut codex_app_server_turn_ok = false;

    let session_timeout = tokio::time::Duration::from_secs(4 * 60 * 60);

    loop {
        let attempt_stderr_lines: Arc<Mutex<VecDeque<String>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(MAX_STDERR_LINES)));
        stderr_lines = Arc::clone(&attempt_stderr_lines);
        let mut spawn_cmd = Command::new(program);
        spawn_cmd
            .args(args)
            .envs(&env_vars)
            .current_dir(working_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if is_acp_agent || use_codex_app_server {
            spawn_cmd.stdin(Stdio::piped());
        } else {
            spawn_cmd.stdin(Stdio::null());
        }
        #[cfg(unix)]
        {
            spawn_cmd.process_group(0);
        }
        // Windows: launch the agent CLI without flashing a console window.
        #[cfg(windows)]
        spawn_cmd.creation_flags(app_platform::CREATE_NO_WINDOW);

        let mut child = {
            let mut attempt = 0usize;
            loop {
                match spawn_cmd.spawn() {
                    Ok(child) => break child,
                    Err(err)
                        if attempt + 1 < SPAWN_RETRY_ATTEMPTS && is_transient_spawn_error(&err) =>
                    {
                        attempt += 1;
                        let delay_ms = SPAWN_RETRY_BASE_DELAY_MS * attempt as u64;
                        tracing::warn!(
                            "[CodeSession] Transient spawn failure for {} (attempt {}/{}): {}; retrying in {}ms",
                            program,
                            attempt,
                            SPAWN_RETRY_ATTEMPTS,
                            err,
                            delay_ms
                        );
                        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
                    }
                    Err(err) => {
                        if needs_mitm {
                            integrations::proxy::server::stop_session_proxy(&session_id).await;
                        }
                        return Err(format!("Failed to spawn {}: {}", program, err));
                    }
                }
            }
        };

        if let Some(pid) = child.id() {
            let pid_session_id = session_id.clone();
            let pid_result =
                tokio::task::spawn_blocking(move || persistence::update_pid(&pid_session_id, pid))
                    .await;
            if let Err(err) = pid_result
                .map_err(|join_err| join_err.to_string())
                .and_then(|result| result.map_err(|db_err| db_err.to_string()))
            {
                tracing::warn!("[CodeSession] Failed to store PID: {}", err);
            }
        }

        let stderr = child.stderr.take().expect("stderr was piped");
        let stderr_session_id = session_id.clone();
        let stderr_lines_writer = Arc::clone(&attempt_stderr_lines);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::warn!("[CodeSession][stderr][{}] {}", stderr_session_id, line);
                let mut buf = stderr_lines_writer.lock().await;
                if buf.len() >= MAX_STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        });

        let mut retryable_oauth_message: Option<String> = None;
        let mut retryable_overload_message: Option<String> = None;
        let mut replay_unsafe_output_seen = false;

        if use_codex_app_server {
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
                model: super::command::codex_app_server_thread_model(model),
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
                            let binding_session_id = session_id.clone();
                            let binding_account_id = account_id.map(str::to_string);
                            let binding_thread_id = tid.clone();
                            let binding_result = tokio::task::spawn_blocking(move || {
                                persistence::update_cli_session_id_for_account(
                                    &binding_session_id,
                                    binding_account_id.as_deref(),
                                    &binding_thread_id,
                                )
                            })
                            .await;
                            if let Err(err) = binding_result
                                .map_err(|join_err| join_err.to_string())
                                .and_then(|result| result.map_err(|db_err| db_err.to_string()))
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
                        snapshot_cli_file_edit(&session_id, snap_id, &chunk, &snapshot_working_dir)
                            .await;
                    }
                    emit_chunk(&chunk, &session_id, &mut sequence).await;
                }
            })
            .await;
            timed_out = timeout_result.is_err();

            match app_server_handle.await {
                Ok(Ok(result)) => {
                    cli_session_id_out = Some(result.thread_id);
                    codex_app_server_turn_ok = result.turn_status != "failed";
                    if let Some(ref usage) = result.usage {
                        persist_round_token_usage(
                            session_id.clone(),
                            usage.model.clone().or_else(|| model.map(str::to_string)),
                            account_id.map(str::to_string),
                            usage.input_tokens as i64,
                            usage.output_tokens as i64,
                            usage.cache_read_tokens as i64,
                            usage.cache_write_tokens as i64,
                            usage.total_tokens as i64,
                        )
                        .await;
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
                super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
            } else {
                let _ = child.kill().await;
            }
            let status = child
                .wait()
                .await
                .map_err(|err| format!("Wait error: {}", err))?;
            exit_code = status.code().unwrap_or(-1);
        } else if is_acp_agent {
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
                        snapshot_cli_file_edit(&session_id, snap_id, &chunk, &snapshot_working_dir)
                            .await;
                    }
                    emit_chunk(&chunk, &session_id, &mut sequence).await;
                }
            })
            .await;
            timed_out = timeout_result.is_err();

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
                super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
            } else {
                let _ = child.kill().await;
            }
            let status = child
                .wait()
                .await
                .map_err(|err| format!("Wait error: {}", err))?;
            exit_code = status.code().unwrap_or(-1);

            // Clean stale lock files left by the killed kiro-cli process
            if matches!(agent, ModelType::Kiro) {
                if let Some(home) = env_vars.get("HOME") {
                    let lock_dir = std::path::Path::new(home).join(".kiro/sessions/cli");
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(entries) = std::fs::read_dir(&lock_dir) {
                            for entry in entries.flatten() {
                                if entry.path().extension().is_some_and(|e| e == "lock") {
                                    let _ = std::fs::remove_file(entry.path());
                                }
                            }
                        }
                    })
                    .await;
                }
            }
        } else {
            // ── Standard agents: read stdout line by line through CliAgentParser ──
            let mut parser = create_parser(&agent, &session_id);
            let stdout = child.stdout.take().expect("stdout was piped");
            let mut reader = BufReader::new(stdout);
            let mut line_buf = Vec::with_capacity(4096);
            let mut last_plan_candidate_path: Option<PathBuf> = None;
            let mut cli_plan_active = mode == Some("plan");
            let mut cli_plan_registered_this_turn = false;
            let mut cli_plan_approval_gate_triggered = false;
            let mut cli_plan_gate_announced = false;
            let mut cli_plan_drain_timed_out = false;

            let read_result = tokio::time::timeout(session_timeout, async {
                use tokio::io::AsyncBufReadExt;
                loop {
                    line_buf.clear();
                    let read_next_line = reader.read_until(b'\n', &mut line_buf);
                    let read_next_line = if cli_plan_approval_gate_triggered {
                        match tokio::time::timeout(
                            tokio::time::Duration::from_secs(CLI_PLAN_GATE_NATURAL_EXIT_GRACE_SECS),
                            read_next_line,
                        )
                        .await
                        {
                            Ok(result) => result,
                            Err(_) => {
                                cli_plan_drain_timed_out = true;
                                tracing::warn!(
                                    "[CodeSession] CLI plan gate reached for {}; stdout did not close within {}s",
                                    session_id,
                                    CLI_PLAN_GATE_NATURAL_EXIT_GRACE_SECS
                                );
                                break;
                            }
                        }
                    } else {
                        read_next_line.await
                    };
                    match read_next_line {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&line_buf).trim_end().to_string();
                            if line.is_empty() {
                                continue;
                            }

                            let chunks = parser.parse_line(&line);
                            // Bind the CLI's native conversation id as soon
                            // as the parser sees it (Claude emits it in the
                            // "system" init event) instead of only after
                            // exit: native-transcript replay, dedup, and
                            // live-status attribution all key on it, and a
                            // crash mid-turn must not orphan the transcript.
                            if cli_session_id_out.is_none() {
                                if let Some(cli_sid) = parser.cli_session_id() {
                                    cli_session_id_out = Some(cli_sid.clone());
                                    let binding_session_id = session_id.clone();
                                    let binding_account_id = account_id.map(str::to_string);
                                    let binding_cli_session_id = cli_sid.clone();
                                    let binding_result = tokio::task::spawn_blocking(move || {
                                        persistence::update_cli_session_id_for_account(
                                            &binding_session_id,
                                            binding_account_id.as_deref(),
                                            &binding_cli_session_id,
                                        )
                                    })
                                    .await;
                                    if let Err(err) = binding_result
                                        .map_err(|join_err| join_err.to_string())
                                        .and_then(|result| result.map_err(|db_err| db_err.to_string()))
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
                                            "cli_session_id": cli_sid,
                                        })
                                        .to_string(),
                                    );
                                }
                            }
                            for chunk in chunks {
                                if cli_plan_approval_gate_triggered {
                                    continue;
                                }
                                if !replay_unsafe_output_seen {
                                    if let Some(message) = is_retryable_cli_oauth_failure_chunk(
                                        &agent,
                                        session.key_source,
                                        &chunk,
                                    ) {
                                        retryable_oauth_message = Some(message);
                                        break;
                                    }
                                }

                                if let Some(message) = is_retryable_overloaded_chunk(&chunk) {
                                    retryable_overload_message = Some(message);
                                    break;
                                }

                                if is_cli_chunk_replay_unsafe(&chunk) {
                                    replay_unsafe_output_seen = true;
                                }

                                if let Some(snap_id) = &pre_message_snapshot_id {
                                    snapshot_cli_file_edit(
                                        &session_id,
                                        snap_id,
                                        &chunk,
                                        &snapshot_working_dir,
                                    )
                                    .await;
                                }
                                if is_successful_mode_tool(&chunk, "enter_plan_mode") {
                                    cli_plan_active = true;
                                }
                                // Plan registration accepts only explicit signals:
                                // a plan-shaped tool call (e.g. Cursor's plan tool),
                                // a successful write to a plan markdown file, or
                                // exit_plan_mode. The former assistant-text
                                // heuristic (keyword-sniffing normal replies into
                                // synthetic plan cards) produced false-positive
                                // cards and was removed.
                                if cli_plan_active && !cli_plan_registered_this_turn {
                                    if let Some(plan_text) = create_plan_content_from_chunk(&chunk)
                                    {
                                        match register_synthetic_cli_plan_approval(
                                            &session_id,
                                            &plan_text,
                                            &chunk.chunk_id,
                                            sequence,
                                        )
                                        .await
                                        {
                                            Ok(plan_chunk) => {
                                                emit_chunk(&plan_chunk, &session_id, &mut sequence)
                                                    .await;
                                                cli_plan_registered_this_turn = true;
                                                cli_plan_approval_gate_triggered = true;
                                            }
                                            Err(err) => {
                                                tracing::warn!(
                                                    "[CodeSession] Failed to register synthetic CLI plan approval for {}: {}",
                                                    session_id,
                                                    err
                                                );
                                            }
                                        }
                                    }
                                }
                                if let Some(candidate_path) =
                                    plan_candidate_path_from_chunk(&chunk, Path::new(&snapshot_working_dir))
                                {
                                    last_plan_candidate_path = Some(candidate_path);
                                    if cli_plan_active
                                        && !cli_plan_registered_this_turn
                                    {
                                        match register_cli_plan_approval(
                                            &session_id,
                                            &chunk,
                                            last_plan_candidate_path.as_ref().unwrap(),
                                        )
                                        .await
                                        {
                                            Ok(plan_chunk) => {
                                                emit_chunk(&plan_chunk, &session_id, &mut sequence)
                                                    .await;
                                                cli_plan_registered_this_turn = true;
                                                cli_plan_approval_gate_triggered = true;
                                            }
                                            Err(err) => {
                                                tracing::warn!(
                                                    "[CodeSession] Failed to register CLI plan approval for {}: {}",
                                                    session_id,
                                                    err
                                                );
                                            }
                                        }
                                    }
                                }
                                if is_successful_mode_tool(&chunk, "exit_plan_mode") {
                                    if !cli_plan_registered_this_turn {
                                        if let Some(plan_path) = last_plan_candidate_path.as_ref() {
                                            match register_cli_plan_approval(
                                                &session_id,
                                                &chunk,
                                                plan_path,
                                            )
                                            .await
                                            {
                                                Ok(plan_chunk) => {
                                                    emit_chunk(
                                                        &plan_chunk,
                                                        &session_id,
                                                        &mut sequence,
                                                    )
                                                    .await;
                                                    cli_plan_registered_this_turn = true;
                                                    cli_plan_approval_gate_triggered = true;
                                                }
                                                Err(err) => {
                                                    tracing::warn!(
                                                        "[CodeSession] Failed to register CLI plan approval for {}: {}",
                                                        session_id,
                                                        err
                                                    );
                                                }
                                            }
                                        } else {
                                            tracing::warn!(
                                                "[CodeSession] exit_plan_mode succeeded without a plan file candidate for {}",
                                                session_id
                                            );
                                        }
                                    }
                                    cli_plan_active = false;
                                }
                                emit_chunk(&chunk, &session_id, &mut sequence).await;
                                if cli_plan_approval_gate_triggered && !cli_plan_gate_announced {
                                    cli_plan_gate_announced = true;
                                    tracing::info!(
                                        "[CodeSession] CLI plan approval gate reached for {}; draining child output until natural exit",
                                        session_id
                                    );
                                    // Terminal-at-sentinel: the plan card is the only thing
                                    // awaiting the user now. Unlock the composer immediately
                                    // instead of holding Stop for up to the 45s drain window
                                    // while the child process winds down. The final
                                    // status_changed after child exit is idempotent.
                                    flush_and_broadcast(&session_id).await;
                                    // The plan card supersedes any hook-derived
                                    // waiting/working entry for this turn.
                                    clear_live_status(
                                        &agent,
                                        &session_id,
                                        cli_session_id_out.as_deref(),
                                    );
                                    let plan_session_id = session_id.clone();
                                    let plan_turn_intent_id = turn_intent_id.map(str::to_string);
                                    let plan_persist_result = tokio::task::spawn_blocking(move || {
                                        persistence::update_cli_turn_lifecycle(
                                            &plan_session_id,
                                            SessionStatus::Completed,
                                            None,
                                            plan_turn_intent_id.as_deref().map(|turn_intent_id| {
                                                (
                                                    turn_intent_id,
                                                session_persistence::turn_intents::TurnIntentStatus::Completed,
                                                )
                                            }),
                                            )
                                    })
                                    .await;
                                    if let Err(err) = plan_persist_result
                                        .map_err(|join_err| join_err.to_string())
                                        .and_then(|result| result)
                                    {
                                        tracing::warn!(
                                            "[CodeSession] Failed to persist plan-gate completed status for {}: {}",
                                            session_id,
                                            err
                                        );
                                    }
                                    let mut plan_status_message = serde_json::json!({
                                            "type": "code_session.status_changed",
                                            "session_id": session_id,
                                            "status": SessionStatus::Completed.as_ref(),
                                            "plan_gate": true,
                                        });
                                    if let Some(turn_intent_id) = turn_intent_id {
                                        plan_status_message["turn_intent_id"] =
                                            serde_json::Value::String(turn_intent_id.to_string());
                                    }
                                    websocket_handler::broadcast(plan_status_message.to_string());
                                }
                            }
                            if retryable_oauth_message.is_some()
                                || retryable_overload_message.is_some()
                            {
                                break;
                            }
                        }
                        Err(err) => {
                            tracing::error!("[CodeSession] stdout read error: {}", err);
                            break;
                        }
                    }
                    if retryable_oauth_message.is_some() || retryable_overload_message.is_some() {
                        break;
                    }
                }
            })
            .await;
            timed_out = read_result.is_err();
            cli_plan_approval_gate_reached = cli_plan_approval_gate_triggered;

            let kill_for_oauth_retry = retryable_oauth_message.is_some() && !timed_out;
            let kill_for_overload_retry = retryable_overload_message.is_some() && !timed_out;
            if kill_for_oauth_retry || kill_for_overload_retry {
                if let Some(pid) = child.id() {
                    super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
                } else if let Err(err) = child.start_kill() {
                    tracing::warn!(
                        "[CodeSession] Failed to start retry kill for {}: {}",
                        session_id,
                        err
                    );
                }
            }
            let pre_exit_status = if kill_for_oauth_retry || kill_for_overload_retry {
                tokio::time::timeout(tokio::time::Duration::from_secs(2), child.wait())
                    .await
                    .map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "CLI child wait timed out after retry kill",
                        )
                    })
            } else if cli_plan_approval_gate_triggered && !timed_out {
                if cli_plan_drain_timed_out {
                    tracing::warn!(
                        "[CodeSession] CLI plan gate reached for {}; child did not exit naturally after stdout drain, killing",
                        session_id
                    );
                    if let Some(pid) = child.id() {
                        super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
                    } else if let Err(err) = child.start_kill() {
                        tracing::warn!(
                            "[CodeSession] Failed to start plan-gate kill for {}: {}",
                            session_id,
                            err
                        );
                    }
                    tokio::time::timeout(tokio::time::Duration::from_secs(2), child.wait())
                        .await
                        .map_err(|_| {
                            std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "CLI child wait timed out after plan-gate kill",
                            )
                        })
                } else {
                    Ok(child.wait().await)
                }
            } else {
                Ok(child.wait().await)
            };
            exit_code = pre_exit_status
                .as_ref()
                .ok()
                .and_then(|status_result| status_result.as_ref().ok())
                .and_then(|status| status.code())
                .unwrap_or(-1);

            if retryable_oauth_message.is_none()
                && is_cli_oauth_stderr_retry_candidate(
                    &agent,
                    session.key_source,
                    exit_code,
                    replay_unsafe_output_seen,
                )
            {
                let buf = attempt_stderr_lines.lock().await;
                retryable_oauth_message = buf
                    .iter()
                    .find(|line| is_cli_oauth_failure_message(line))
                    .cloned();
            }

            if retryable_oauth_message.is_none()
                && retryable_overload_message.is_none()
                && !cli_plan_approval_gate_triggered
            {
                let exit_chunks = parser.on_exit(exit_code);
                for chunk in &exit_chunks {
                    if !replay_unsafe_output_seen {
                        if let Some(message) =
                            is_retryable_cli_oauth_failure_chunk(&agent, session.key_source, chunk)
                        {
                            retryable_oauth_message = Some(message);
                            break;
                        }
                    }
                    if let Some(message) = is_retryable_overloaded_chunk(chunk) {
                        retryable_overload_message = Some(message);
                        break;
                    }
                    if let Some(snap_id) = &pre_message_snapshot_id {
                        snapshot_cli_file_edit(&session_id, snap_id, chunk, &snapshot_working_dir)
                            .await;
                    }
                    emit_chunk(chunk, &session_id, &mut sequence).await;
                }
            }

            if retryable_oauth_message.is_none() && retryable_overload_message.is_none() {
                // Keep an early-bound id when a retried attempt's fresh
                // parser never saw one (don't clobber Some with None).
                if let Some(cli_sid) = parser.cli_session_id() {
                    cli_session_id_out = Some(cli_sid);
                }

                if let Some(ref usage) = parser.token_usage() {
                    persist_round_token_usage(
                        session_id.clone(),
                        usage.model.clone().or_else(|| model.map(str::to_string)),
                        account_id.map(str::to_string),
                        usage.input_tokens as i64,
                        usage.output_tokens as i64,
                        usage.cache_read_tokens as i64,
                        usage.cache_write_tokens as i64,
                        usage.total_tokens as i64,
                    )
                    .await;
                }
            }
        }

        if timed_out {
            tracing::error!(
                "[CodeSession] Session {} timed out after 4 hours",
                session_id
            );
            break;
        }

        if let Some(message) = retryable_oauth_message {
            if oauth_retry_used {
                suppressed_oauth_error = Some(message);
                break;
            }
            oauth_retry_used = true;
            suppressed_oauth_error = Some(message.clone());
            tracing::warn!(
                "[CodeSession] {} OAuth failed before replay-unsafe output; refreshing and retrying once",
                agent.as_str()
            );
            match refresh_cli_oauth_for_retry(&agent, account_id, &mut env_vars).await {
                Ok(true) => {
                    continue;
                }
                Ok(false) => {
                    suppressed_oauth_error = Some(
                        "This account needs to be signed in again before the agent can continue."
                            .to_string(),
                    );
                    break;
                }
                Err(err) => {
                    suppressed_oauth_error = Some(format!(
                        "Automatic account refresh failed. Please sign in again. {}",
                        err
                    ));
                    break;
                }
            }
        }

        if let Some(ref message) = retryable_overload_message {
            if overload_retry_count >= MAX_OVERLOAD_RETRIES {
                tracing::warn!(
                    "[CodeSession] {} API overloaded after {} retries; giving up: {}",
                    agent.as_str(),
                    MAX_OVERLOAD_RETRIES,
                    message,
                );
                break;
            }
            let delay_secs = OVERLOAD_RETRY_BASE_DELAY_SECS * (1u64 << overload_retry_count);
            overload_retry_count += 1;
            tracing::warn!(
                "[CodeSession] {} API overloaded (attempt {}/{}); retrying in {}s: {}",
                agent.as_str(),
                overload_retry_count,
                MAX_OVERLOAD_RETRIES,
                delay_secs,
                message,
            );
            tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)).await;
            continue;
        }

        break;
    }

    // ═══════════════════════════════════════════════════════════
    // Post-run: final status, error surfacing, resource teardown
    // ═══════════════════════════════════════════════════════════

    super::finalize::finalize_session_run(
        &session,
        &agent,
        &env_vars,
        run_started_at,
        needs_mitm,
        use_codex_app_server,
        is_acp_agent,
        &synced_rule_files,
        turn_intent_id,
        super::finalize::SessionRunOutcome {
            exit_code,
            cli_session_id_out,
            cli_plan_approval_gate_reached,
            codex_app_server_turn_ok,
            suppressed_oauth_error,
            stderr_lines,
        },
    )
    .await;

    Ok(())
}

/// Resolve the built-in SDE agent definition and return just its skills
/// config — the CLI runner's only consumer of `ResolvedAgent` (see §11.4
/// row 17). Failures fall back to the default skills shape (enabled,
/// nothing excluded) because the CLI session is already running; we do
/// not want a missing definitions file to break rule-sync.
fn resolve_sde_skills() -> agent_core::core::definitions::SkillsParams {
    use agent_core::core::definitions::{ResolvedAgent, SkillsParams};
    use agent_core::core::session::overrides::SessionOverrides;
    let definitions = agent_core::definitions::definitions_store();
    let Some(def) = definitions.get(agent_core::definitions::builtin::SDE_AGENT_ID) else {
        tracing::warn!(
            "[code_session] builtin:sde definition not found; using default skills config"
        );
        return SkillsParams::default();
    };
    match ResolvedAgent::resolve(&def, Some(&definitions), &SessionOverrides::default()) {
        Ok(resolved) => resolved.skills.clone(),
        Err(err) => {
            tracing::warn!(
                "[code_session] resolve builtin:sde failed ({}); using default skills config",
                err
            );
            SkillsParams::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::env_setup::{opencode_zenmux_model_id, setup_opencode_zenmux_profile};
    use super::super::input_assembly::cli_exec_mode_bridge;
    use super::super::oauth_setup::is_api_overloaded_message;
    use super::super::plan_approval::{
        looks_like_buildable_plan_body, plan_content_from_successful_write_chunk,
        synthetic_cli_plan_path,
    };
    use super::*;
    use core_types::activity::ActivityChunk;
    use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};
    use key_vault::key_store::ModelKey;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    static ORGII_HOME_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn with_temp_orgii_home<R>(run: impl FnOnce(&Path) -> R) -> R {
        let _guard = ORGII_HOME_TEST_LOCK
            .lock()
            .expect("lock ORGII_HOME test guard");
        let previous = std::env::var("ORGII_HOME").ok();
        let temp_dir = tempfile::tempdir().expect("create temp ORGII_HOME");
        std::env::set_var("ORGII_HOME", temp_dir.path());
        let result = run(temp_dir.path());
        match previous {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
        result
    }

    fn read_json(path: &Path) -> Value {
        let text = std::fs::read_to_string(path).expect("read json file");
        serde_json::from_str(&text).expect("parse json file")
    }

    #[test]
    fn opencode_zenmux_model_id_prefers_session_model() {
        let mut key = ModelKey::new(ModelType::ZenmuxApi);
        key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];
        key.available_models = vec!["deepseek/deepseek-chat".to_string()];

        assert_eq!(
            opencode_zenmux_model_id(Some("qwen/qwen3-coder-plus"), &key),
            "qwen/qwen3-coder-plus"
        );
    }

    #[test]
    fn opencode_zenmux_model_id_falls_back_to_enabled_models() {
        let mut key = ModelKey::new(ModelType::ZenmuxApi);
        key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];
        key.available_models = vec!["deepseek/deepseek-chat".to_string()];

        assert_eq!(
            opencode_zenmux_model_id(None, &key),
            "anthropic/claude-sonnet-4.5"
        );
    }

    #[test]
    fn setup_opencode_zenmux_profile_writes_config_and_auth() {
        let temp_dir = tempfile::tempdir().expect("temp opencode profile");
        let mut key = ModelKey::new(ModelType::ZenmuxApi);
        key.api_key = Some("sk-ai-v1-test".to_string());
        key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];

        setup_opencode_zenmux_profile(temp_dir.path(), &key, None).expect("setup profile");

        let config = read_json(&temp_dir.path().join(".config/opencode/opencode.json"));
        assert_eq!(
            config["provider"]["zenmux"]["npm"].as_str(),
            Some("@ai-sdk/openai-compatible")
        );
        assert_eq!(
            config["provider"]["zenmux"]["options"]["baseURL"].as_str(),
            Some("https://zenmux.ai/api/v1")
        );
        assert_eq!(
            config["provider"]["zenmux"]["options"]["apiKey"].as_str(),
            Some("{env:ZENMUX_API_KEY}")
        );
        assert_eq!(
            config["model"].as_str(),
            Some("zenmux/anthropic/claude-sonnet-4.5")
        );
        assert!(config["provider"]["zenmux"]["models"]["openai/gpt-5-codex"].is_object());

        let auth = read_json(&temp_dir.path().join(".local/share/opencode/auth.json"));
        assert_eq!(auth["zenmux"]["type"].as_str(), Some("api"));
        assert_eq!(auth["zenmux"]["key"].as_str(), Some("sk-ai-v1-test"));
    }

    #[test]
    fn cli_plan_mode_bridge_preserves_side_chat_semantics() {
        let bridge = cli_exec_mode_bridge(Some("plan")).expect("plan bridge");
        assert!(bridge.contains("draft, create, update, revise, or submit an approval plan"));
        assert!(bridge.contains("answer the question directly"));
        assert!(bridge.contains("do not create, revise, or submit a plan"));
        assert!(bridge.contains("canonicalizes the written plan file into the approval card"));
    }

    #[test]
    fn cli_plan_markdown_detection_accepts_buildable_plan_text_only() {
        assert!(looks_like_buildable_plan_body(
            "### Build Approval Plan\n\nChange: Create `artifact.md`.\n\nScope: one low-risk filesystem change.\n\nVerification: confirm the file exists and content matches."
        ));
        assert!(looks_like_buildable_plan_body(
            "# Create Acceptance Artifact\n\n1. Create `artifact.md` with exactly `ORGII_MARKER`.\n2. Make no other filesystem changes.\n3. Verify the new file contains the required content exactly."
        ));
        assert!(!looks_like_buildable_plan_body(
            "I will submit a plan soon."
        ));
        assert!(!looks_like_buildable_plan_body(
            "Here is a general explanation without any build or verification details."
        ));
    }

    #[test]
    fn create_plan_shape_extracts_cursor_cli_plan_args() {
        let mut chunk = ActivityChunk::new("session-1", "tool_call", "orgii acceptance artifact");
        chunk.args = serde_json::json!({
            "name": "ORGII acceptance artifact",
            "plan": "Build step: create `artifact.md` with the required content. Verification: confirm the file exists and no other changes were made."
        });
        chunk.result = serde_json::json!({ "success": {} });

        let content = create_plan_content_from_chunk(&chunk).expect("plan content");
        assert!(content.starts_with("# ORGII acceptance artifact"));
        assert!(content.contains("artifact.md"));
    }

    #[test]
    fn successful_write_chunk_plan_content_uses_new_body() {
        let mut chunk = ActivityChunk::new("session-1", "tool_call", "edit_file_by_replace");
        chunk.args = serde_json::json!({
            "path": "/tmp/plan.md",
            "new_string": "# New Plan\n\nCreate `new.md` and verify the file contains exactly `NEW_MARKER`."
        });
        chunk.result = serde_json::json!({ "success": { "path": "/tmp/plan.md" } });

        let content = plan_content_from_successful_write_chunk(&chunk).expect("plan content");
        assert!(content.contains("new.md"));
        assert!(!content.contains("old.md"));
    }

    #[test]
    fn enter_plan_mode_result_is_not_treated_as_assistant_plan() {
        let mut chunk = ActivityChunk::new("session-1", "tool_call", "enter_plan_mode");
        chunk.result = serde_json::json!({
            "content": "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach."
        });
        assert!(create_plan_content_from_chunk(&chunk).is_none());
    }

    #[test]
    fn synthetic_cli_plan_path_is_session_scoped() {
        with_temp_orgii_home(|root| {
            let path = synthetic_cli_plan_path("cli/session:1", 42);
            assert!(path.starts_with(root));
            assert!(path.to_string_lossy().contains("cli-session-1"));
            assert!(path.ends_with("synthetic-plan-42.md"));
        });
    }

    #[test]
    fn child_env_sanitization_keeps_runtime_tokens_out_of_subprocess_env() {
        let mut codex_env = HashMap::new();
        codex_env.insert("OPENAI_API_KEY".to_string(), "access-token".to_string());
        codex_env.insert(
            CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
            "refresh-token".to_string(),
        );
        codex_env.insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), "id-token".to_string());
        sanitize_cli_oauth_env_for_child(&ModelType::Codex, &mut codex_env);
        assert_eq!(
            codex_env.get("OPENAI_API_KEY").map(String::as_str),
            Some("access-token")
        );
        assert!(!codex_env.contains_key(CODEX_REFRESH_TOKEN_ENV_KEY));
        assert!(!codex_env.contains_key(CODEX_ID_TOKEN_ENV_KEY));
    }

    #[test]
    fn overloaded_error_detection() {
        assert!(is_api_overloaded_message("overloaded_error"));
        assert!(is_api_overloaded_message(
            "Anthropic API error: overloaded_error - API overloaded"
        ));
        assert!(is_api_overloaded_message("Error 529: API overloaded"));
        assert!(is_api_overloaded_message("429 Too Many Requests"));
        assert!(is_api_overloaded_message("Rate limit exceeded"));
        assert!(is_api_overloaded_message("too many requests"));
        assert!(!is_api_overloaded_message("Connection refused"));
        assert!(!is_api_overloaded_message("unauthorized access"));
        assert!(!is_api_overloaded_message(
            "Gemini OAuth access token expired"
        ));
    }

    #[test]
    fn overloaded_chunk_detection() {
        let make_chunk = |result: serde_json::Value| core_types::activity::ActivityChunk {
            chunk_id: "test".to_string(),
            session_id: "s".to_string(),
            action_type: "error".to_string(),
            function: "error".to_string(),
            args: serde_json::json!({}),
            result,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            thread_id: None,
            process_id: None,
            broadcast_only: false,
        };

        let overloaded = make_chunk(serde_json::json!({
            "error_message": "overloaded_error: The API is currently overloaded"
        }));
        assert!(is_retryable_overloaded_chunk(&overloaded).is_some());

        let rate_limited = make_chunk(serde_json::json!({
            "error": "429 Too Many Requests"
        }));
        assert!(is_retryable_overloaded_chunk(&rate_limited).is_some());

        let auth_error = make_chunk(serde_json::json!({
            "error_message": "401 Unauthorized: invalid api key"
        }));
        assert!(is_retryable_overloaded_chunk(&auth_error).is_none());

        let no_error = make_chunk(serde_json::json!({
            "text": "Hello world"
        }));
        assert!(is_retryable_overloaded_chunk(&no_error).is_none());
    }
}
