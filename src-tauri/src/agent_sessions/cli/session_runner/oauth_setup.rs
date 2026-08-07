//! OAuth auth file writing, retry detection, and pre-spawn environment
//! sanitization for CLI agent sessions.

use std::collections::HashMap;

use chrono::{SecondsFormat, Utc};
use core_types::activity::ActivityChunk;
use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};
use key_vault::key_store::{ModelType, KEY_SERVICE};

use super::super::types::KeySource;

// ── Auth failure detection ────────────────────────────────────────────────────

pub(super) fn is_cli_oauth_failure_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    let auth_failure = lower.contains("refresh token")
        || lower.contains("access token")
        || lower.contains("auth token")
        || lower.contains("oauth")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
        || lower.contains("authentication")
        || lower.contains("login required")
        || lower.contains("please log in")
        || lower.contains("please login")
        || lower.contains("revoked")
        || lower.contains("invalid_grant");
    let token_unusable = lower.contains("already used")
        || lower.contains("expired")
        || lower.contains("invalid")
        || lower.contains("could not be refreshed")
        || lower.contains("failed to refresh")
        || lower.contains("401")
        || lower.contains("403")
        || lower.contains("denied")
        || lower.contains("rejected");

    auth_failure && token_unusable
}

pub(super) fn chunk_error_message(chunk: &ActivityChunk) -> Option<String> {
    let result = &chunk.result;
    result
        .get("error_message")
        .and_then(|value| value.as_str())
        .or_else(|| result.get("error").and_then(|value| value.as_str()))
        .or_else(|| result.get("message").and_then(|value| value.as_str()))
        .or_else(|| result.get("observation").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn is_api_overloaded_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("overloaded_error")
        || lower.contains("overloaded")
        || lower.contains("529")
        || (lower.contains("api") && lower.contains("overload"))
        || lower.contains("too many requests")
        || lower.contains("rate limit")
        || lower.contains("429")
}

pub(super) fn is_retryable_overloaded_chunk(chunk: &ActivityChunk) -> Option<String> {
    let message = chunk_error_message(chunk)?;
    if is_api_overloaded_message(&message) {
        Some(message)
    } else {
        None
    }
}

pub(super) fn is_cli_oauth_retry_agent(agent: &ModelType) -> bool {
    matches!(agent, ModelType::Codex | ModelType::ClaudeCode)
}

pub(super) fn is_cli_oauth_stderr_retry_candidate(
    agent: &ModelType,
    key_source: KeySource,
    exit_code: i32,
    replay_unsafe_output_seen: bool,
) -> bool {
    key_source == KeySource::OwnKey
        && exit_code != 0
        && !replay_unsafe_output_seen
        && is_cli_oauth_retry_agent(agent)
}

pub(super) fn is_retryable_cli_oauth_failure_chunk(
    agent: &ModelType,
    key_source: KeySource,
    chunk: &ActivityChunk,
) -> Option<String> {
    if key_source != KeySource::OwnKey || !is_cli_oauth_retry_agent(agent) {
        return None;
    }
    let message = chunk_error_message(chunk)?;
    if is_cli_oauth_failure_message(&message) {
        Some(message)
    } else {
        None
    }
}

pub(super) fn is_cli_chunk_replay_unsafe(chunk: &ActivityChunk) -> bool {
    matches!(
        chunk.action_type.as_str(),
        "assistant"
            | "assistant_delta"
            | "message"
            | "message_delta"
            | "llm_thinking"
            | "llm_thinking_delta"
            | "tool_call"
            | "tool_call_delta"
            | "error"
    )
}

// ── Environment sanitization ──────────────────────────────────────────────────

pub(super) fn sanitize_cli_oauth_env_for_child(
    agent: &ModelType,
    env_vars: &mut HashMap<String, String>,
) {
    match agent {
        ModelType::Codex => {
            env_vars.remove(CODEX_REFRESH_TOKEN_ENV_KEY);
            env_vars.remove(CODEX_ID_TOKEN_ENV_KEY);
        }
        ModelType::ClaudeCode => {
            env_vars.remove("CLAUDE_CODE_REFRESH_TOKEN");
            env_vars.remove("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
            env_vars.remove("CLAUDE_CODE_OAUTH_SCOPES");
        }
        _ => {}
    }
}

// ── Auth file writers ─────────────────────────────────────────────────────────

pub(super) fn write_codex_cli_auth_file(account_id: &str, env_vars: &HashMap<String, String>) {
    let codex_home = app_paths::codex_cli_profile_dir(account_id);
    if let Err(err) = std::fs::create_dir_all(&codex_home) {
        tracing::warn!("[CodeSession] Failed to create Codex home: {}", err);
        return;
    }

    let home_path = codex_home.to_string_lossy().to_string();
    tracing::info!("[CodeSession] CODEX_HOME={}", home_path);

    let auth_path = codex_home.join("auth.json");
    let access_token = env_vars.get("OPENAI_API_KEY").cloned().unwrap_or_default();
    let refresh_token = env_vars.get(CODEX_REFRESH_TOKEN_ENV_KEY).cloned();
    let id_token = env_vars.get(CODEX_ID_TOKEN_ENV_KEY).cloned();
    let account_id_from_token = id_token.as_deref().and_then(|token| {
        agent_core::core::providers::codex_native::extract_account_id_from_id_token(token)
    });

    if access_token.trim().is_empty() {
        return;
    }

    let last_refresh = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    let auth_json = serde_json::json!({
        "OPENAI_API_KEY": serde_json::Value::Null,
        "tokens": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "account_id": account_id_from_token,
        },
        "last_refresh": last_refresh,
    });
    let write_result = serde_json::to_vec_pretty(&auth_json)
        .map_err(|err| err.to_string())
        .and_then(|bytes| std::fs::write(&auth_path, bytes).map_err(|err| err.to_string()));
    match write_result {
        Ok(()) => tracing::info!(
            "[CodeSession] Wrote fresh Codex auth.json to {:?}",
            auth_path
        ),
        Err(err) => tracing::warn!("[CodeSession] Failed to write Codex auth.json: {}", err),
    }
}

// ── OAuth refresh for retry ───────────────────────────────────────────────────

pub(super) async fn refresh_cli_oauth_for_retry(
    agent: &ModelType,
    account_id: Option<&str>,
    env_vars: &mut HashMap<String, String>,
) -> Result<bool, String> {
    let Some(account_id) = account_id else {
        return Ok(false);
    };

    let refreshed = match agent {
        ModelType::Codex => Some(
            KEY_SERVICE
                .refresh_codex_oauth_key(
                    account_id,
                    env_vars
                        .get("OPENAI_API_KEY")
                        .map(String::as_str)
                        .unwrap_or(""),
                )
                .await?,
        ),
        ModelType::ClaudeCode => Some(
            KEY_SERVICE
                .refresh_claude_code_oauth_key(
                    account_id,
                    env_vars
                        .get("ANTHROPIC_AUTH_TOKEN")
                        .map(String::as_str)
                        .unwrap_or(""),
                )
                .await?,
        ),
        _ => None,
    };

    if refreshed.is_none() {
        return Ok(false);
    }

    let refreshed_env = KEY_SERVICE.get_env_for_agent(agent, Some(account_id));
    for (key, value) in refreshed_env {
        env_vars.insert(key, value);
    }
    if matches!(agent, ModelType::Codex) {
        write_codex_cli_auth_file(account_id, env_vars);
    }
    sanitize_cli_oauth_env_for_child(agent, env_vars);
    Ok(true)
}
