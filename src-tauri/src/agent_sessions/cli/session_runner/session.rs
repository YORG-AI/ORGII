//! Core session execution — spawns CLI agent, parses stdout, broadcasts events.
//!
//! The stdout-processing loop is split by CLI transport into sibling
//! submodules (see `session/`):
//! - `transport_app_server` — Codex app-server JSON-RPC turn
//! - `transport_acp`        — ACP agents (Copilot, Kiro, OpenCode)
//! - `transport_standard`   — line-oriented `CliAgentParser` transport
//! - `spawn_retry`          — transient subprocess-spawn retry helpers
//! - `skills_resolve`       — built-in SDE agent skills-config resolution

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::api::websocket_handler;
use agent_core::session::AgentExecMode;
use key_vault::key_store::{KeyService, ModelType, KEY_SERVICE};

use super::super::launch_profile_store::resolve_cli_launch_profile;
use super::super::persistence;
use super::super::types::KeySource;
use super::command::{
    build_command_with_launch_profile, launch_profile_env, CliCommandBuildRequest,
};
use super::helpers::{emit_chunk, persist_attached_images, strip_ide_context};
use super::oauth_setup::{
    is_cli_oauth_retry_eligible, refresh_cli_oauth_for_retry, sanitize_cli_oauth_env_for_child,
};

mod skills_resolve;
mod spawn_retry;
mod transport_acp;
mod transport_app_server;
mod transport_standard;

use skills_resolve::resolve_sde_skills;
use spawn_retry::{is_transient_spawn_error, SPAWN_RETRY_ATTEMPTS, SPAWN_RETRY_BASE_DELAY_MS};

const MAX_OVERLOAD_RETRIES: u32 = 3;
const OVERLOAD_RETRY_BASE_DELAY_SECS: u64 = 2;

const MAX_STDERR_LINES: usize = 20;

/// How long to keep waiting for the stderr reader once the child is gone. A
/// CLI that hands its stderr to a surviving grandchild keeps the pipe open
/// forever, and no diagnostic is worth hanging the turn on.
const STDERR_DRAIN_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(3);

/// The child's stderr, collected by a background reader.
///
/// The reader must be drained before the buffer is read. A child exiting only
/// closes the write end of the pipe; it says nothing about whether the reader
/// task has been scheduled to pick up what is still sitting in it. Reading
/// straight after `wait()` is how a session that failed loudly on stderr ends
/// up reporting no reason at all.
struct CliStderrCollector {
    lines: Arc<Mutex<VecDeque<String>>>,
    reader: Option<tokio::task::JoinHandle<()>>,
}

impl CliStderrCollector {
    fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_STDERR_LINES))),
            reader: None,
        }
    }

    /// The buffer itself, for readers that have already drained (or that run
    /// after the turn, once draining is guaranteed).
    fn lines(&self) -> Arc<Mutex<VecDeque<String>>> {
        Arc::clone(&self.lines)
    }

    fn attach(&mut self, stderr: tokio::process::ChildStderr, session_id: String) {
        let sink = Arc::clone(&self.lines);
        self.reader = Some(tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::warn!("[CodeSession][stderr][{}] {}", session_id, line);
                let mut buf = sink.lock().await;
                if buf.len() >= MAX_STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        }));
    }

    /// Wait for the reader to hit EOF so the buffer holds everything the child
    /// wrote. Idempotent — every consumer may call it, and only the first one
    /// pays. Whatever was collected before the deadline stays in the buffer.
    ///
    /// On timeout the reader is aborted rather than abandoned: dropping a
    /// `JoinHandle` only detaches the task. A reader parked on a pipe that a
    /// surviving grandchild still holds would then keep itself, the
    /// `ChildStderr` fd and a buffer handle alive for as long as that
    /// grandchild lives — once per attempt, for the life of the process.
    async fn drain(&mut self) {
        let Some(mut reader) = self.reader.take() else {
            return;
        };
        if tokio::time::timeout(STDERR_DRAIN_TIMEOUT, &mut reader)
            .await
            .is_err()
        {
            tracing::warn!(
                "[CodeSession] stderr still open {}s after the child exited; using what was collected so far",
                STDERR_DRAIN_TIMEOUT.as_secs()
            );
            reader.abort();
            // Awaited so the fd is closed by the time the caller reads the
            // buffer, not whenever the cancelled task happens to be dropped.
            let _ = reader.await;
        }
    }
}

fn terminal_cli_error_from_chunk(chunk: &core_types::activity::ActivityChunk) -> Option<String> {
    let is_error = chunk.action_type == "error" || chunk.function == "error";
    let is_failed_session_end = (chunk.action_type == "session_end"
        || chunk.function == "session_end")
        && chunk
            .result
            .get("success")
            .and_then(serde_json::Value::as_bool)
            == Some(false);
    if !is_error && !is_failed_session_end {
        return None;
    }

    ["error", "error_message", "observation"]
        .iter()
        .find_map(|field| {
            let value = chunk.result.get(*field)?;
            value
                .as_str()
                .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
        })
        .map(super::super::parsers::canonicalize_cli_error_message)
        .filter(|message| !message.is_empty())
}

fn record_terminal_cli_error(
    current: &mut Option<String>,
    chunk: &core_types::activity::ActivityChunk,
) {
    let Some(message) = terminal_cli_error_from_chunk(chunk) else {
        return;
    };
    let is_failed_session_end = (chunk.action_type == "session_end"
        || chunk.function == "session_end")
        && chunk
            .result
            .get("success")
            .and_then(serde_json::Value::as_bool)
            == Some(false);
    if current.is_none() || is_failed_session_end {
        *current = Some(message);
    }
}

fn is_app_overload_retry_eligible(agent: &ModelType) -> bool {
    !matches!(agent, ModelType::Codex)
}

fn exhausted_overload_error_chunk(
    session_id: &str,
    overload_retry_count: u32,
    message: &str,
) -> Option<(String, core_types::activity::ActivityChunk)> {
    if overload_retry_count < MAX_OVERLOAD_RETRIES {
        return None;
    }

    let message = super::super::parsers::canonicalize_cli_error_message(message);
    let mut chunk = core_types::activity::ActivityChunk::new(session_id, "error", "error");
    chunk.result = serde_json::json!({
        "observation": message,
        "error": message,
        "success": false,
    });
    Some((message, chunk))
}

fn resolve_session_model(
    agent: &ModelType,
    key_model_type: Option<&ModelType>,
    session_model: Option<&str>,
) -> Option<String> {
    let is_cross_type_key = key_model_type.is_some_and(|key_type| key_type != agent);
    if is_cross_type_key && matches!(agent, ModelType::ClaudeCode) {
        None
    } else {
        session_model.map(|model| {
            if matches!(agent, ModelType::Codex) {
                if let Some(provider) = key_model_type {
                    return super::env_setup::normalize_codex_provider_model_id(model, provider);
                }
            }
            model.to_string()
        })
    }
}

fn resolve_cli_effective_mode(
    product_mode: Option<&str>,
    requested_mode: Option<&str>,
    persisted_mode: Option<&str>,
) -> AgentExecMode {
    if product_mode == Some("project") {
        AgentExecMode::Build
    } else {
        requested_mode
            .and_then(AgentExecMode::parse)
            .or_else(|| persisted_mode.and_then(AgentExecMode::parse))
            .unwrap_or(AgentExecMode::Build)
    }
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
    let session = persistence::get_session(&session_id)
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
    // Claude Code cross-type providers inject their model through ANTHROPIC_MODEL
    // and reject provider-specific values passed to --model. Other compatible
    // agents retain the user's selected model; their generated provider profile
    // handles the routing.
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
    let oauth_retry_eligible =
        is_cli_oauth_retry_eligible(&agent, session.key_source, selected_key.as_ref());
    // Codex custom providers retain bounded request/stream retries inside the
    // same process. Do not multiply those by replaying the entire turn here.
    let overload_retry_eligible = is_app_overload_retry_eligible(&agent);
    let model = resolve_session_model(&agent, key_model_type.as_ref(), session.model.as_deref());
    let repo_path = session.repo_path.as_deref();
    let account_id = session.account_id.as_deref();
    let effective_mode = resolve_cli_effective_mode(
        session.product_mode.as_deref(),
        mode,
        session.agent_exec_mode.as_deref(),
    );
    if session.agent_exec_mode.as_deref() != Some(effective_mode.as_str()) {
        persistence::update_agent_exec_mode(&session_id, effective_mode.as_str())
            .map_err(|err| format!("normalize CLI session mode: {err}"))?;
    }
    let effective_mode_str = effective_mode.as_str();
    let base_working_dir = repo_path.filter(|path| !path.is_empty()).ok_or_else(|| {
        "repo_path is required — cannot run agent without a working directory".to_string()
    })?;
    let working_dir = session
        .worktree_path
        .as_deref()
        .filter(|path| !path.is_empty() && std::path::Path::new(path).is_dir())
        .unwrap_or(base_working_dir);
    if !std::path::Path::new(working_dir).is_dir() {
        return Err(format!(
            "Working directory does not exist or is not a directory: {working_dir}"
        ));
    }

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

    // Sync .orgii/agent-rules.md → agent-native rules file
    let mut synced_rule_files: Vec<std::path::PathBuf> = Vec::new();
    let active_workspace = std::path::Path::new(working_dir);
    synced_rule_files.extend(super::super::skill_sync::sync_conventions_for_agent(
        &agent,
        active_workspace,
    ));

    // Sync skills to agent-native rules files.
    //
    // Agent resolve contract (design doc §11.4) row 17: resolve the built-in SDE agent (the CLI
    // session runner doesn't own an `agent_definition_id`; skills opts
    // are a host-wide concern carried on the SDE definition) and read
    // `skills.enabled` + `skills.disabled` off `ResolvedAgent`.
    let skills_cfg = resolve_sde_skills();
    synced_rule_files.extend(super::super::skill_sync::sync_skills_for_agent(
        &agent,
        active_workspace,
        skills_cfg.enabled,
        &skills_cfg.disabled,
    ));

    // Pre-message anchor snapshot for CLI rollback support.
    // `snapshot_cli_file_edit` populates this snapshot with git-HEAD bytes of
    // each file the agent touches, filling the gap that SDE Agent closes via
    // `UnifiedEventHandler::take_snapshot` (which fires before the tool runs).
    let pre_message_snapshot_id = match agent_core::tools::file_history::make_snapshot(&session_id)
    {
        Ok(snapshot_id) => {
            tracing::info!(
                "[code_session] Pre-message anchor snapshot: {}",
                snapshot_id
            );
            if let Err(err) = agent_core::session::persistence::save_snapshot(
                &session_id,
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

    let run_started_at = chrono::Utc::now();

    // Resolved early: the experimental codex app-server transport gate
    // changes prompt assembly (images travel as native localImage inputs)
    // as well as argv and the stdout-processing branch below.
    let launch_profile = resolve_cli_launch_profile(&agent)?;
    let use_codex_app_server =
        super::launch_profiles::uses_codex_app_server(&agent, &launch_profile);

    let image_paths = persist_attached_images(&session_id, images.as_deref()).await;

    let lifecycle_hook_context = super::harness_hooks::prepare_turn(
        &session_id,
        &agent,
        model.as_deref(),
        Some(working_dir),
        &user_input,
        cli_resume_id.is_none(),
    )
    .await;

    let mut effective_input = super::input_assembly::build_effective_input(
        &user_input,
        Some(effective_mode_str),
        session.product_mode.as_deref(),
        session.project_slug.as_deref(),
        session.work_item_id.as_deref(),
        &session_id,
        cli_resume_id.is_none(),
        &agent,
        &image_paths,
        use_codex_app_server,
        Some(working_dir),
        skills_cfg.enabled,
        &skills_cfg.disabled,
    );
    if let Some(context) = lifecycle_hook_context {
        effective_input = format!(
            "<orgii_hook_context event=\"session_start\">\n{}\n</orgii_hook_context>\n\n{}",
            context, effective_input
        );
    }

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
        model: model.as_deref(),
        task: &effective_input,
        resume_id: cli_resume_id.as_deref(),
        api_key: api_key_for_cli,
        endpoint: endpoint_for_cli,
        mode: Some(effective_mode_str),
        repo_path: Some(working_dir),
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
    {
        let conn = session_persistence::get_connection().map_err(|e| format!("DB: {}", e))?;
        conn.execute(
            "UPDATE code_sessions SET user_input = ?2 WHERE session_id = ?1",
            rusqlite::params![session_id, display_input],
        )
        .map_err(|e| format!("DB: failed to store user_input: {}", e))?;
    }

    // Start per-session MITM proxy if needed
    let needs_mitm = session.key_source == KeySource::HostedKey && agent.needs_mitm_proxy();

    if needs_mitm {
        super::env_setup::start_session_mitm_proxy(&session, &session_id, &mut env_vars).await?;
    }

    super::env_setup::configure_agent_profile(
        &agent,
        &session,
        account_id,
        selected_key.as_ref(),
        &session_id,
        cli_resume_id.as_deref(),
        &mut env_vars,
    )?;

    super::env_setup::apply_system_proxy_passthrough(&mut env_vars);

    super::env_setup::inject_orgtrack_environment(
        &session,
        &session_id,
        working_dir,
        &mut env_vars,
    );

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

    super::env_setup::setup_opencode_sse_sanitizer(&agent, &mut env_vars).await;

    // ── Spawn subprocess ──
    let is_acp_agent = matches!(
        agent,
        ModelType::Copilot | ModelType::Kiro | ModelType::OpenCode
    );

    let mut stderr_lines: Arc<Mutex<VecDeque<String>>>;
    let mut exit_code: i32;
    let mut oauth_retry_used = false;
    let mut terminal_oauth_error: Option<String> = None;
    let mut terminal_error_message: Option<String> = None;
    let mut overload_retry_count: u32 = 0;

    let base_sequence: i64 = persistence::max_chunk_sequence(&session_id).unwrap_or(-1) + 1;

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
        if persistence::session_persists_chunks(&session_id) {
            if let Err(err) = persistence::insert_chunk(&user_chunk, base_sequence) {
                tracing::error!(
                    "[CodeSession] Failed to persist user_message chunk: {}",
                    err
                );
            }
            let ws_msg = serde_json::json!({
                "type": "code_session.activity",
                "session_id": session_id,
                "chunk": user_chunk,
            });
            websocket_handler::broadcast(ws_msg.to_string());
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
        let mut attempt_stderr = CliStderrCollector::new();
        stderr_lines = attempt_stderr.lines();
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
            if let Err(err) = persistence::update_pid(&session_id, pid) {
                tracing::warn!("[CodeSession] Failed to store PID: {}", err);
            }
        }

        attempt_stderr.attach(
            child.stderr.take().expect("stderr was piped"),
            session_id.clone(),
        );

        let retryable_oauth_message: Option<String>;
        let retryable_overload_message: Option<String>;

        if use_codex_app_server {
            let outcome = transport_app_server::run_codex_app_server_branch(
                child,
                session_id.clone(),
                account_id,
                oauth_retry_eligible,
                effective_input.clone(),
                working_dir,
                cli_resume_id.clone(),
                model.as_deref(),
                &launch_profile,
                image_paths.clone(),
                session_timeout,
                pre_message_snapshot_id.clone(),
                snapshot_working_dir.clone(),
                cli_session_id_out,
                &mut sequence,
                codex_app_server_turn_ok,
                &mut attempt_stderr,
            )
            .await?;
            exit_code = outcome.exit_code;
            timed_out = outcome.timed_out;
            cli_session_id_out = outcome.cli_session_id_out;
            codex_app_server_turn_ok = outcome.codex_app_server_turn_ok;
            terminal_error_message = outcome.terminal_error_message;
            retryable_oauth_message = outcome.retryable_oauth_message;
            retryable_overload_message = None;
        } else if is_acp_agent {
            let outcome = transport_acp::run_acp_branch(
                child,
                session_id.clone(),
                effective_input.clone(),
                working_dir,
                cli_resume_id.clone(),
                agent.clone(),
                image_paths.clone(),
                session_timeout,
                pre_message_snapshot_id.clone(),
                snapshot_working_dir.clone(),
                cli_session_id_out,
                &mut sequence,
                &env_vars,
            )
            .await?;
            exit_code = outcome.exit_code;
            timed_out = outcome.timed_out;
            cli_session_id_out = outcome.cli_session_id_out;
            retryable_oauth_message = None;
            retryable_overload_message = None;
        } else {
            let outcome = transport_standard::run_standard_branch(
                child,
                session_id.clone(),
                oauth_retry_eligible,
                overload_retry_eligible,
                agent.clone(),
                Some(effective_mode_str),
                account_id,
                model.as_deref(),
                session_timeout,
                pre_message_snapshot_id.clone(),
                snapshot_working_dir.clone(),
                cli_session_id_out,
                &mut sequence,
                &mut attempt_stderr,
            )
            .await;
            exit_code = outcome.exit_code;
            timed_out = outcome.timed_out;
            cli_session_id_out = outcome.cli_session_id_out;
            cli_plan_approval_gate_reached = outcome.cli_plan_approval_gate_reached;
            terminal_error_message = outcome.terminal_error_message;
            retryable_oauth_message = outcome.retryable_oauth_message;
            retryable_overload_message = outcome.retryable_overload_message;
        }

        // Whatever the transport did or did not read, the finalizer reads this
        // buffer for every agent. A no-op if the transport already drained.
        attempt_stderr.drain().await;

        if timed_out {
            tracing::error!(
                "[CodeSession] Session {} timed out after 4 hours",
                session_id
            );
            break;
        }

        if let Some(message) = retryable_oauth_message {
            if oauth_retry_used {
                terminal_oauth_error = Some(message);
                break;
            }
            oauth_retry_used = true;
            tracing::warn!(
                "[CodeSession] {} OAuth failed before replay-unsafe output; refreshing and retrying once",
                agent.as_str()
            );
            match refresh_cli_oauth_for_retry(&agent, account_id, &mut env_vars).await {
                Ok(true) => {
                    // The first failure was recovered. Do not let it outrank a
                    // different terminal error produced by the retried turn.
                    continue;
                }
                Ok(false) => {
                    terminal_oauth_error = Some(
                        "This account needs to be signed in again before the agent can continue."
                            .to_string(),
                    );
                    break;
                }
                Err(err) => {
                    terminal_oauth_error = Some(format!(
                        "Automatic account refresh failed. Please sign in again. {}",
                        err
                    ));
                    break;
                }
            }
        }

        if let Some(message) = retryable_overload_message {
            if let Some((terminal_message, chunk)) =
                exhausted_overload_error_chunk(&session_id, overload_retry_count, &message)
            {
                tracing::warn!(
                    "[CodeSession] {} API overloaded after {} retries; giving up: {}",
                    agent.as_str(),
                    MAX_OVERLOAD_RETRIES,
                    terminal_message,
                );
                terminal_error_message = Some(terminal_message);
                emit_chunk(&chunk, &session_id, &mut sequence).await;
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
        oauth_retry_eligible,
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
            terminal_oauth_error,
            terminal_error_message,
            stderr_lines,
        },
    )
    .await;

    Ok(())
}

#[cfg(test)]
mod tests;
