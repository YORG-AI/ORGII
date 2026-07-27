//! Debug-only CLI-agent runtime probes.

#![cfg(debug_assertions)]

use axum::Json;
use core_types::activity::ActivityChunk;
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;

use crate::agent_sessions::cli::commands::{
    cli_agent_chunks, cli_agent_create, cli_agent_message, cli_agent_resume, cli_agent_run,
    cli_agent_status,
};
use crate::agent_sessions::cli::persistence::{self, CreateCodeSessionParams};
use crate::agent_sessions::cli::session_runner;
use crate::agent_sessions::cli::types::{KeySource, SessionStatus};
use key_vault::key_store::ModelType;

const DEFAULT_TIMEOUT_SECS: u64 = 240;
const POLL_INTERVAL_MS: u64 = 500;
#[derive(Debug, Deserialize)]
pub struct TestCursorCliRuntimeRequest {
    content: String,
    expected_text: Option<String>,
    account_id: String,
    model: Option<String>,
    workspace_path: String,
    session_id: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestCursorCliAccountSwitchRequest {
    initial_content: String,
    followup_content: String,
    initial_account_id: String,
    followup_account_id: String,
    model: Option<String>,
    workspace_path: String,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestClaudeCodeCliAccountSwitchRequest {
    initial_content: String,
    followup_content: String,
    initial_expected_text: Option<String>,
    followup_expected_text: Option<String>,
    initial_account_id: String,
    followup_account_id: String,
    model: Option<String>,
    workspace_path: String,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestCodexCliAccountSwitchRequest {
    initial_content: String,
    followup_content: String,
    initial_expected_text: Option<String>,
    followup_expected_text: Option<String>,
    initial_account_id: String,
    followup_account_id: String,
    model: Option<String>,
    workspace_path: String,
    timeout_secs: Option<u64>,
}

fn assistant_chunk_contains(chunks: &[ActivityChunk], needle: &str) -> bool {
    chunks.iter().any(|chunk| {
        matches!(
            chunk.action_type.as_str(),
            "assistant" | "assistant_delta" | "llm_response"
        ) && serde_json::to_string(&chunk.result)
            .map(|value| value.contains(needle))
            .unwrap_or(false)
    })
}

fn terminal_status(value: SessionStatus) -> bool {
    value.is_terminal()
}

async fn wait_for_terminal_session(
    session_id: &str,
    timeout_secs: u64,
) -> Result<crate::agent_sessions::cli::persistence::CodeSession, String> {
    wait_for_terminal_session_after_update(session_id, None, timeout_secs).await
}

async fn wait_for_terminal_session_after_update(
    session_id: &str,
    previous_updated_at: Option<&str>,
    timeout_secs: u64,
) -> Result<crate::agent_sessions::cli::persistence::CodeSession, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        match cli_agent_status(session_id.to_string()).await {
            Ok(Some(session))
                if terminal_status(session.status)
                    && previous_updated_at
                        .map(|updated_at| session.updated_at != updated_at)
                        .unwrap_or(true) =>
            {
                return Ok(session);
            }
            Ok(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
            }
            Err(err) => return Err(format!("cli_agent_status failed: {err}")),
        }
    }
    Err("CLI session timed out".to_string())
}

async fn wait_for_chunk_progress(
    session_id: &str,
    baseline_count: usize,
    expected_text: Option<&str>,
    timeout_secs: u64,
) -> Result<Vec<ActivityChunk>, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        let chunks = cli_agent_chunks(session_id.to_string())
            .await
            .map_err(|err| format!("cli_agent_chunks failed: {err}"))?;
        if expected_text
            .map(|text| assistant_chunk_contains(&chunks, text))
            .unwrap_or(false)
            || chunks.len() > baseline_count
        {
            return Ok(chunks);
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
    Err("CLI session chunk progress timed out".to_string())
}

pub async fn test_cursor_cli_runtime(
    Json(request): Json<TestCursorCliRuntimeRequest>,
) -> Json<serde_json::Value> {
    if request.account_id.trim().is_empty() {
        return Json(json!({ "error": "account_id is required" }));
    }
    if request.workspace_path.trim().is_empty() {
        return Json(json!({ "error": "workspace_path is required" }));
    }

    let expected_cursor_config_dir = app_paths::cursor_cli_profile_dir(&request.account_id);

    let create_params = CreateCodeSessionParams {
        name: Some("E2E Cursor CLI runtime".to_string()),
        flow: None,
        runner: None,
        cli_agent_type: ModelType::CursorCli.as_str().to_string(),
        model: request
            .model
            .clone()
            .or_else(|| Some("composer-2".to_string())),
        tier: None,
        account_id: Some(request.account_id.clone()),
        repo_path: Some(request.workspace_path.clone()),
        branch: None,
        worktree_path: None,
        worktree_base_ref: None,
        proxy_token: None,
        proxy_url: None,
        hosted_token: None,
        proxy_session_id: None,
        isolate: None,
        background: None,
        key_source: Some(KeySource::OwnKey.as_ref().to_string()),
        additional_directories: None,
        parent_session_id: None,
        org_member_id: None,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
    };

    let created = match cli_agent_create(create_params).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": format!("cli_agent_create failed: {err}") })),
    };
    let created_session_id = created.session_id;
    let session_id = request
        .session_id
        .unwrap_or_else(|| created_session_id.clone());
    if session_id != created_session_id {
        return Json(json!({
            "error": "session_id override is not supported by cli_agent_create"
        }));
    }

    if let Err(err) = cli_agent_run(
        session_id.clone(),
        request.content.clone(),
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("cli_agent_run failed: {err}") }));
    }

    let session = match wait_for_terminal_session(
        &session_id,
        request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
    )
    .await
    {
        Ok(session) => session,
        Err(err) => {
            return Json(json!({
                "error": err,
                "session_id": session_id,
            }));
        }
    };

    let chunks = match cli_agent_chunks(session_id.clone()).await {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": format!("cli_agent_chunks failed: {err}") })),
    };
    let expected_seen = request
        .expected_text
        .as_deref()
        .map(|expected_text| assistant_chunk_contains(&chunks, expected_text));

    let expected_cursor_config_file = expected_cursor_config_dir.join("cli-config.json");

    Json(json!({
        "session_id": session_id,
        "status": session.status.as_ref(),
        "error_message": session.error_message,
        "cli_session_id": session.cli_session_id,
        "chunk_count": chunks.len(),
        "expected_seen": expected_seen,
        "cursor_config_dir": expected_cursor_config_dir.to_string_lossy(),
        "cursor_config_dir_exists": expected_cursor_config_dir.exists(),
        "cursor_config_file_exists": expected_cursor_config_file.exists(),
        "chunks": chunks,
    }))
}

pub async fn test_cursor_cli_account_switch(
    Json(request): Json<TestCursorCliAccountSwitchRequest>,
) -> Json<serde_json::Value> {
    if request.initial_account_id.trim().is_empty() {
        return Json(json!({ "error": "initial_account_id is required" }));
    }
    if request.followup_account_id.trim().is_empty() {
        return Json(json!({ "error": "followup_account_id is required" }));
    }
    if request.workspace_path.trim().is_empty() {
        return Json(json!({ "error": "workspace_path is required" }));
    }

    let model = request
        .model
        .clone()
        .unwrap_or_else(|| "composer-2".to_string());
    let create_params = CreateCodeSessionParams {
        name: Some("E2E Cursor CLI account switch".to_string()),
        flow: None,
        runner: None,
        cli_agent_type: ModelType::CursorCli.as_str().to_string(),
        model: Some(model.clone()),
        tier: None,
        account_id: Some(request.initial_account_id.clone()),
        repo_path: Some(request.workspace_path.clone()),
        branch: None,
        worktree_path: None,
        worktree_base_ref: None,
        proxy_token: None,
        proxy_url: None,
        hosted_token: None,
        proxy_session_id: None,
        isolate: None,
        background: None,
        key_source: Some(KeySource::OwnKey.as_ref().to_string()),
        additional_directories: None,
        parent_session_id: None,
        org_member_id: None,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
    };

    let created = match cli_agent_create(create_params).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": format!("cli_agent_create failed: {err}") })),
    };
    let session_id = created.session_id;
    if let Err(err) = cli_agent_run(
        session_id.clone(),
        request.initial_content.clone(),
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("initial cli_agent_run failed: {err}") }));
    }

    let timeout_secs = request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    let initial_session = match wait_for_terminal_session(&session_id, timeout_secs).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };

    if let Err(err) = cli_agent_message(
        session_id.clone(),
        request.followup_content.clone(),
        None,
        Some(request.followup_account_id.clone()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("cli_agent_message failed: {err}") }));
    }

    let followup_session = match wait_for_terminal_session(&session_id, timeout_secs).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };
    let persisted_session = match persistence::get_session(&session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return Json(json!({ "error": "session disappeared after follow-up" })),
        Err(err) => return Json(json!({ "error": format!("DB error: {err}") })),
    };

    let initial_cursor_config_dir = app_paths::cursor_cli_profile_dir(&request.initial_account_id);
    let followup_cursor_config_dir =
        app_paths::cursor_cli_profile_dir(&request.followup_account_id);

    Json(json!({
        "session_id": session_id,
        "initial_status": initial_session.status.as_ref(),
        "initial_error_message": initial_session.error_message,
        "followup_status": followup_session.status.as_ref(),
        "followup_error_message": followup_session.error_message,
        "persisted_account_id": persisted_session.account_id,
        "persisted_model": persisted_session.model,
        "initial_cursor_config_dir": initial_cursor_config_dir.to_string_lossy(),
        "initial_cursor_config_dir_exists": initial_cursor_config_dir.exists(),
        "initial_cursor_config_file_exists": initial_cursor_config_dir.join("cli-config.json").exists(),
        "followup_cursor_config_dir": followup_cursor_config_dir.to_string_lossy(),
        "followup_cursor_config_dir_exists": followup_cursor_config_dir.exists(),
        "followup_cursor_config_file_exists": followup_cursor_config_dir.join("cli-config.json").exists(),
    }))
}

pub async fn test_claude_code_cli_account_switch(
    Json(request): Json<TestClaudeCodeCliAccountSwitchRequest>,
) -> Json<serde_json::Value> {
    if request.initial_account_id.trim().is_empty() {
        return Json(json!({ "error": "initial_account_id is required" }));
    }
    if request.followup_account_id.trim().is_empty() {
        return Json(json!({ "error": "followup_account_id is required" }));
    }
    if request.workspace_path.trim().is_empty() {
        return Json(json!({ "error": "workspace_path is required" }));
    }

    let model = request
        .model
        .clone()
        .unwrap_or_else(|| "claude-sonnet-4-6".to_string());
    let create_params = CreateCodeSessionParams {
        name: Some("E2E Claude Code CLI account switch".to_string()),
        flow: None,
        runner: None,
        cli_agent_type: ModelType::ClaudeCode.as_str().to_string(),
        model: Some(model.clone()),
        tier: None,
        account_id: Some(request.initial_account_id.clone()),
        repo_path: Some(request.workspace_path.clone()),
        branch: None,
        worktree_path: None,
        worktree_base_ref: None,
        proxy_token: None,
        proxy_url: None,
        hosted_token: None,
        proxy_session_id: None,
        isolate: None,
        background: None,
        key_source: Some(KeySource::OwnKey.as_ref().to_string()),
        additional_directories: None,
        parent_session_id: None,
        org_member_id: None,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
    };

    let created = match cli_agent_create(create_params).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": format!("cli_agent_create failed: {err}") })),
    };
    let session_id = created.session_id;
    if let Err(err) = cli_agent_run(
        session_id.clone(),
        request.initial_content.clone(),
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("initial cli_agent_run failed: {err}") }));
    }

    let timeout_secs = request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    let initial_session = match wait_for_terminal_session(&session_id, timeout_secs).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };
    let initial_chunks = match cli_agent_chunks(session_id.clone()).await {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": format!("cli_agent_chunks failed: {err}") })),
    };
    let baseline_chunk_count = initial_chunks.len();
    let baseline_updated_at = initial_session.updated_at.clone();

    if let Err(err) = cli_agent_message(
        session_id.clone(),
        request.followup_content.clone(),
        Some(model.clone()),
        Some(request.followup_account_id.clone()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("cli_agent_message failed: {err}") }));
    }

    let _followup_chunks = match wait_for_chunk_progress(
        &session_id,
        baseline_chunk_count,
        request.followup_expected_text.as_deref(),
        timeout_secs,
    )
    .await
    {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };

    let followup_session = match wait_for_terminal_session_after_update(
        &session_id,
        Some(&baseline_updated_at),
        timeout_secs,
    )
    .await
    {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };
    let persisted_session = match persistence::get_session(&session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return Json(json!({ "error": "session disappeared after follow-up" })),
        Err(err) => return Json(json!({ "error": format!("DB error: {err}") })),
    };
    let chunks = match cli_agent_chunks(session_id.clone()).await {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": format!("cli_agent_chunks failed: {err}") })),
    };

    let initial_claude_config_dir =
        app_paths::claude_code_cli_profile_dir(&request.initial_account_id);
    let followup_claude_config_dir =
        app_paths::claude_code_cli_profile_dir(&request.followup_account_id);
    let initial_expected_seen = request
        .initial_expected_text
        .as_deref()
        .map(|expected_text| assistant_chunk_contains(&chunks, expected_text));
    let followup_expected_seen = request
        .followup_expected_text
        .as_deref()
        .map(|expected_text| assistant_chunk_contains(&chunks, expected_text));

    Json(json!({
        "session_id": session_id,
        "initial_status": initial_session.status.as_ref(),
        "initial_error_message": initial_session.error_message,
        "followup_status": followup_session.status.as_ref(),
        "followup_error_message": followup_session.error_message,
        "persisted_account_id": persisted_session.account_id,
        "persisted_model": persisted_session.model,
        "chunk_count": chunks.len(),
        "initial_expected_seen": initial_expected_seen,
        "followup_expected_seen": followup_expected_seen,
        "initial_claude_config_dir": initial_claude_config_dir.to_string_lossy(),
        "initial_claude_config_dir_exists": initial_claude_config_dir.exists(),
        "followup_claude_config_dir": followup_claude_config_dir.to_string_lossy(),
        "followup_claude_config_dir_exists": followup_claude_config_dir.exists(),
    }))
}

pub async fn test_codex_cli_account_switch(
    Json(request): Json<TestCodexCliAccountSwitchRequest>,
) -> Json<serde_json::Value> {
    if request.initial_account_id.trim().is_empty() {
        return Json(json!({ "error": "initial_account_id is required" }));
    }
    if request.followup_account_id.trim().is_empty() {
        return Json(json!({ "error": "followup_account_id is required" }));
    }
    if request.workspace_path.trim().is_empty() {
        return Json(json!({ "error": "workspace_path is required" }));
    }

    let model = request
        .model
        .clone()
        .unwrap_or_else(|| "gpt-5.5".to_string());
    let create_params = CreateCodeSessionParams {
        name: Some("E2E Codex CLI account switch".to_string()),
        flow: None,
        runner: None,
        cli_agent_type: ModelType::Codex.as_str().to_string(),
        model: Some(model.clone()),
        tier: None,
        account_id: Some(request.initial_account_id.clone()),
        repo_path: Some(request.workspace_path.clone()),
        branch: None,
        worktree_path: None,
        worktree_base_ref: None,
        proxy_token: None,
        proxy_url: None,
        hosted_token: None,
        proxy_session_id: None,
        isolate: None,
        background: None,
        key_source: Some(KeySource::OwnKey.as_ref().to_string()),
        additional_directories: None,
        parent_session_id: None,
        org_member_id: None,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
    };

    let created = match cli_agent_create(create_params).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": format!("cli_agent_create failed: {err}") })),
    };
    let session_id = created.session_id;
    let timeout_secs = request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);

    let initial_codex_home = app_paths::codex_cli_profile_dir(&request.initial_account_id);
    let followup_codex_home = app_paths::codex_cli_profile_dir(&request.followup_account_id);

    if let Err(err) = cli_agent_run(
        session_id.clone(),
        request.initial_content.clone(),
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("initial cli_agent_run failed: {err}") }));
    }

    let initial_session = match wait_for_terminal_session(&session_id, timeout_secs).await {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };
    let initial_env_ready = initial_codex_home.exists();
    let initial_chunks = match cli_agent_chunks(session_id.clone()).await {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": format!("cli_agent_chunks failed: {err}") })),
    };
    let baseline_chunk_count = initial_chunks.len();
    let baseline_updated_at = initial_session.updated_at.clone();

    if let Err(err) = cli_agent_message(
        session_id.clone(),
        request.followup_content.clone(),
        Some(model.clone()),
        Some(request.followup_account_id.clone()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    {
        return Json(json!({ "error": format!("cli_agent_message failed: {err}") }));
    }

    let _followup_chunks = match wait_for_chunk_progress(
        &session_id,
        baseline_chunk_count,
        request.followup_expected_text.as_deref(),
        timeout_secs,
    )
    .await
    {
        Ok(chunks) => chunks,
        Err(err) => {
            return Json(json!({
                "error": err,
                "session_id": session_id,
                "initial_codex_home": initial_codex_home.to_string_lossy(),
                "followup_codex_home": followup_codex_home.to_string_lossy(),
                "initial_codex_home_exists": initial_env_ready,
                "followup_codex_home_exists": followup_codex_home.exists(),
            }));
        }
    };
    let followup_session = match wait_for_terminal_session_after_update(
        &session_id,
        Some(&baseline_updated_at),
        timeout_secs,
    )
    .await
    {
        Ok(session) => session,
        Err(err) => return Json(json!({ "error": err, "session_id": session_id })),
    };
    let chunks = match cli_agent_chunks(session_id.clone()).await {
        Ok(chunks) => chunks,
        Err(err) => return Json(json!({ "error": format!("cli_agent_chunks failed: {err}") })),
    };
    let initial_expected_seen = request
        .initial_expected_text
        .as_deref()
        .map(|expected_text| assistant_chunk_contains(&chunks, expected_text));
    let followup_expected_seen = request
        .followup_expected_text
        .as_deref()
        .map(|expected_text| assistant_chunk_contains(&chunks, expected_text));

    let persisted_session = match persistence::get_session(&session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return Json(json!({ "error": "session disappeared after follow-up" })),
        Err(err) => return Json(json!({ "error": format!("DB error: {err}") })),
    };

    Json(json!({
        "session_id": session_id,
        "timeout_secs": timeout_secs,
        "initial_status": initial_session.status.as_ref(),
        "initial_error_message": initial_session.error_message,
        "followup_status": followup_session.status.as_ref(),
        "followup_error_message": followup_session.error_message,
        "persisted_account_id": persisted_session.account_id,
        "persisted_model": persisted_session.model,
        "chunk_count": chunks.len(),
        "initial_expected_seen": initial_expected_seen,
        "followup_expected_seen": followup_expected_seen,
        "initial_codex_home": initial_codex_home.to_string_lossy(),
        "initial_codex_home_exists": initial_env_ready,
        "initial_codex_auth_file_exists": initial_codex_home.join("auth.json").exists(),
        "followup_codex_home": followup_codex_home.to_string_lossy(),
        "followup_codex_home_exists": followup_codex_home.exists(),
        "followup_codex_auth_file_exists": followup_codex_home.join("auth.json").exists(),
    }))
}

/// Debug-only regression probe for CLI resume lock isolation.
///
/// Reproduces the slow-start class without invoking a provider: a stale running
/// session points at a real `sleep` PID, so `cli_agent_resume` spends the fixed
/// SIGTERM grace period in stale-process cleanup. A second unrelated session
/// start must not wait on that cleanup via the global RUNNING_SESSIONS mutex.
pub async fn test_cli_resume_lock_isolation() -> Json<serde_json::Value> {
    let mut stale_child = match Command::new("sleep").arg("30").spawn() {
        Ok(child) => child,
        Err(err) => {
            return Json(json!({
                "ok": false,
                "error": format!("failed to spawn stale sleep process: {err}"),
            }));
        }
    };
    let stale_pid = stale_child.id().unwrap_or_default();

    let create_params = |name: &str| CreateCodeSessionParams {
        name: Some(name.to_string()),
        flow: None,
        runner: None,
        cli_agent_type: ModelType::ClaudeCode.as_str().to_string(),
        model: Some("e2e-lock-probe-model".to_string()),
        tier: None,
        account_id: Some("e2e-lock-probe-account".to_string()),
        repo_path: std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().to_string()),
        branch: None,
        worktree_path: None,
        worktree_base_ref: None,
        proxy_token: None,
        proxy_url: None,
        hosted_token: None,
        proxy_session_id: None,
        isolate: Some(false),
        background: Some(true),
        key_source: Some(KeySource::OwnKey.as_ref().to_string()),
        additional_directories: None,
        parent_session_id: None,
        org_member_id: None,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
    };

    let stale_session = match cli_agent_create(create_params("E2E stale resume lock probe")).await {
        Ok(session) => session,
        Err(err) => {
            let _ = stale_child.kill().await;
            return Json(json!({
                "ok": false,
                "error": format!("create stale session failed: {err}"),
            }));
        }
    };
    let peer_session = match cli_agent_create(create_params("E2E peer start lock probe")).await {
        Ok(session) => session,
        Err(err) => {
            let _ = stale_child.kill().await;
            return Json(json!({
                "ok": false,
                "error": format!("create peer session failed: {err}"),
            }));
        }
    };

    let stale_session_id = stale_session.session_id.clone();
    let peer_session_id = peer_session.session_id.clone();

    let seed_result = tokio::task::spawn_blocking({
        let sid = stale_session_id.clone();
        move || {
            let conn = database::db::get_connection().map_err(|err| err.to_string())?;
            conn.execute(
                "UPDATE code_sessions SET status = 'running', user_input = ?2, pid = ?3, updated_at = ?4 WHERE session_id = ?1",
                rusqlite::params![
                    sid,
                    "E2E stale resume lock probe prompt",
                    stale_pid as i64,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(|err| err.to_string())?;
            Ok::<(), String>(())
        }
    })
    .await;

    if let Err(err) = seed_result
        .map_err(|err| format!("seed join failed: {err}"))
        .and_then(|inner| inner)
    {
        let _ = stale_child.kill().await;
        return Json(json!({ "ok": false, "error": err }));
    }

    let resume_session_id = stale_session_id.clone();
    let resume_task = tokio::spawn(async move { cli_agent_resume(resume_session_id).await });

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let peer_start = std::time::Instant::now();
    let peer_result = cli_agent_run(
        peer_session_id.clone(),
        "E2E peer start should not wait on unrelated resume cleanup".to_string(),
        None,
        None,
        None,
        None,
    )
    .await;
    let peer_start_ms = peer_start.elapsed().as_millis() as u64;

    let resume_result =
        match tokio::time::timeout(std::time::Duration::from_secs(8), resume_task).await {
            Ok(Ok(result)) => result
                .map(|_| true)
                .map_err(|err| format!("resume failed: {err}")),
            Ok(Err(join_err)) => Err(format!("resume join failed: {join_err}")),
            Err(_) => Err("resume timed out".to_string()),
        };

    let _ = session_runner::kill_running_agent(&stale_session_id).await;
    let _ = session_runner::kill_running_agent(&peer_session_id).await;
    let _ = stale_child.kill().await;
    let _ = stale_child.wait().await;

    Json(json!({
        "ok": peer_result.is_ok() && peer_start_ms < 1500,
        "peer_start_ms": peer_start_ms,
        "peer_result_ok": peer_result.is_ok(),
        "peer_error": peer_result.err(),
        "resume_result_ok": resume_result.is_ok(),
        "resume_error": resume_result.err(),
        "stale_session_id": stale_session_id,
        "peer_session_id": peer_session_id,
    }))
}
