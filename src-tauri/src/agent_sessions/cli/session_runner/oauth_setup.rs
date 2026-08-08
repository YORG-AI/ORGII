//! OAuth auth file writing, retry detection, and pre-spawn environment
//! sanitization for CLI agent sessions.

use std::collections::HashMap;

use chrono::{SecondsFormat, Utc};
use core_types::activity::ActivityChunk;
use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};
use key_vault::key_store::{ModelKey, ModelType, KEY_SERVICE};

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

pub(super) fn is_cli_oauth_retry_eligible(
    agent: &ModelType,
    key_source: KeySource,
    selected_key: Option<&ModelKey>,
) -> bool {
    key_source == KeySource::OwnKey
        && selected_key.is_some_and(|key| key.is_native_oauth_for(agent))
}

pub(super) fn is_cli_oauth_stderr_retry_candidate(
    oauth_retry_eligible: bool,
    exit_code: i32,
    replay_unsafe_output_seen: bool,
) -> bool {
    oauth_retry_eligible && exit_code != 0 && !replay_unsafe_output_seen
}

pub(super) fn is_retryable_cli_oauth_failure_chunk(
    oauth_retry_eligible: bool,
    chunk: &ActivityChunk,
) -> Option<String> {
    if !oauth_retry_eligible {
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

pub(super) fn codex_cli_auth_payload(
    selected_key: &ModelKey,
    env_vars: &HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    if !selected_key.is_native_oauth_for(&ModelType::Codex) {
        let api_key = selected_key
            .api_key
            .as_deref()
            .or_else(|| env_vars.get("OPENAI_API_KEY").map(String::as_str))
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("Codex API-key profile {} has no API key", selected_key.id))?;
        return Ok(serde_json::json!({ "OPENAI_API_KEY": api_key }));
    }

    let access_token = selected_key
        .session_token
        .as_deref()
        .or_else(|| env_vars.get("OPENAI_API_KEY").map(String::as_str))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "Codex OAuth profile {} has no access token",
                selected_key.id
            )
        })?;
    let refresh_token = selected_key
        .env_vars
        .get(CODEX_REFRESH_TOKEN_ENV_KEY)
        .map(String::as_str)
        .or_else(|| {
            env_vars
                .get(CODEX_REFRESH_TOKEN_ENV_KEY)
                .map(String::as_str)
        })
        .filter(|value| !value.trim().is_empty());
    let id_token = selected_key
        .env_vars
        .get(CODEX_ID_TOKEN_ENV_KEY)
        .map(String::as_str)
        .or_else(|| env_vars.get(CODEX_ID_TOKEN_ENV_KEY).map(String::as_str))
        .filter(|value| !value.trim().is_empty());
    let account_id_from_token = id_token.and_then(|token| {
        agent_core::core::providers::codex_native::extract_account_id_from_id_token(token)
    });

    let mut tokens = serde_json::Map::new();
    tokens.insert(
        "access_token".to_string(),
        serde_json::Value::String(access_token.to_string()),
    );
    if let Some(refresh_token) = refresh_token {
        tokens.insert(
            "refresh_token".to_string(),
            serde_json::Value::String(refresh_token.to_string()),
        );
    }
    if let Some(id_token) = id_token {
        tokens.insert(
            "id_token".to_string(),
            serde_json::Value::String(id_token.to_string()),
        );
    }
    if let Some(account_id) = account_id_from_token {
        tokens.insert(
            "account_id".to_string(),
            serde_json::Value::String(account_id),
        );
    }

    Ok(serde_json::json!({
        "OPENAI_API_KEY": serde_json::Value::Null,
        "tokens": tokens,
        "last_refresh": Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true),
    }))
}

pub(super) fn write_codex_cli_auth_file(
    account_id: &str,
    selected_key: &ModelKey,
    env_vars: &HashMap<String, String>,
) -> Result<(), String> {
    let codex_home = app_paths::codex_cli_profile_dir(account_id);
    std::fs::create_dir_all(&codex_home)
        .map_err(|err| format!("Failed to create Codex home: {err}"))?;

    let home_path = codex_home.to_string_lossy().to_string();
    tracing::info!("[CodeSession] CODEX_HOME={}", home_path);

    let auth_path = codex_home.join("auth.json");
    let auth_json = codex_cli_auth_payload(selected_key, env_vars)?;
    let bytes = serde_json::to_vec_pretty(&auth_json).map_err(|err| err.to_string())?;
    // Atomic replace: a crash mid-write must not leave a truncated auth.json
    // that silently downgrades the next launch to unauthenticated. The chmod
    // stays fatal here — this file holds the credential itself.
    agent_cli::managed_config::write_cli_profile_file_atomic(&auth_path, &bytes)
        .map_err(|err| format!("Failed to write Codex auth.json: {err}"))?;
    app_paths::set_sensitive_file_permissions(&auth_path)
        .map_err(|err| format!("Failed to secure Codex auth.json: {err}"))?;
    tracing::info!("[CodeSession] Wrote Codex auth.json to {:?}", auth_path);
    Ok(())
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

    let outcome = match agent {
        ModelType::Codex => {
            KEY_SERVICE
                .refresh_codex_oauth_key(
                    account_id,
                    env_vars
                        .get("OPENAI_API_KEY")
                        .map(String::as_str)
                        .unwrap_or(""),
                )
                .await?
        }
        ModelType::ClaudeCode => {
            KEY_SERVICE
                .refresh_claude_code_oauth_key(
                    account_id,
                    env_vars
                        .get("ANTHROPIC_AUTH_TOKEN")
                        .map(String::as_str)
                        .unwrap_or(""),
                )
                .await?
        }
        _ => return Ok(false),
    };

    let Some(refreshed_key) = outcome.into_key() else {
        return Ok(false);
    };

    let refreshed_env = KEY_SERVICE.get_env_for_agent(agent, Some(account_id));
    for (key, value) in refreshed_env {
        env_vars.insert(key, value);
    }
    if matches!(agent, ModelType::Codex) {
        let auth_account_id = account_id.to_string();
        let auth_env = env_vars.clone();
        tokio::task::spawn_blocking(move || {
            write_codex_cli_auth_file(&auth_account_id, &refreshed_key, &auth_env)
        })
        .await
        .map_err(|err| format!("Codex auth persistence task failed: {err}"))??;
    }
    sanitize_cli_oauth_env_for_child(agent, env_vars);
    Ok(true)
}
