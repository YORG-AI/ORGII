//! Child-process environment preparation for CLI sessions.
//!
//! Everything that mutates the spawned agent's environment or on-disk profile
//! before launch: per-agent config/home directories, the per-session MITM
//! proxy, system-proxy passthrough, the Codex hosted-proxy config + login, and
//! the OpenCode SSE sanitizer. Extracted from `session::run_session` so the
//! runner reads as an orchestration of named phases.

use key_vault::key_store::{ModelKey, ModelType};
use std::collections::HashMap;
use std::path::Path;

use super::super::persistence::CodeSession;
use super::super::types::{proxy_env, KeySource};
use super::oauth_setup::write_codex_cli_auth_file;

const OPENCODE_ZENMUX_PROVIDER_ID: &str = "zenmux";
const OPENCODE_ZENMUX_BASE_URL: &str = "https://zenmux.ai/api/v1";
const OPENCODE_DEFAULT_ZENMUX_MODEL: &str = "deepseek/deepseek-chat";
const ATLASCLOUD_PROVIDER_ID: &str = "atlascloud";
const CODEX_COMPATIBLE_PROVIDER_ID: &str = "orgii_compatible";
const ATLASCLOUD_BASE_URL: &str = "https://api.atlascloud.ai/v1";
const ATLASCLOUD_DEFAULT_MODEL: &str = "zai-org/glm-5.1";
const OPENCODE_ZENMUX_MODEL_IDS: &[&str] = &[
    "inclusionai/ling-1t",
    "inclusionai/ring-1t",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-opus-4.1",
    "anthropic/claude-sonnet-4.5",
    "deepseek/deepseek-chat",
    "google/gemini-2.5-pro",
    "kat-ai/kat-coder-pro-v1",
    "moonshotai/kimi-k2-0905",
    "openai/gpt-5-codex",
    "openai/gpt-5",
    "qwen/qwen3-coder-plus",
    "x-ai/grok-4-fast-non-reasoning",
    "x-ai/grok-4-fast",
    "x-ai/grok-4",
    "x-ai/grok-code-fast-1",
    "z-ai/glm-4.5-air",
    "z-ai/glm-4.6",
];

pub(super) fn opencode_zenmux_model_id(
    session_model: Option<&str>,
    selected_key: &ModelKey,
) -> String {
    session_model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| selected_key.enabled_models.first().map(String::as_str))
        .or_else(|| selected_key.available_models.first().map(String::as_str))
        .unwrap_or(OPENCODE_DEFAULT_ZENMUX_MODEL)
        .to_string()
}

pub(super) fn atlascloud_model_id(session_model: Option<&str>, selected_key: &ModelKey) -> String {
    session_model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| selected_key.enabled_models.first().map(String::as_str))
        .or_else(|| selected_key.available_models.first().map(String::as_str))
        .unwrap_or(ATLASCLOUD_DEFAULT_MODEL)
        .to_string()
}

fn opencode_zenmux_config_payload(model_id: &str) -> serde_json::Value {
    let mut models = serde_json::Map::new();
    for model in OPENCODE_ZENMUX_MODEL_IDS {
        models.insert((*model).to_string(), serde_json::json!({}));
    }
    models.insert(model_id.to_string(), serde_json::json!({}));

    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            OPENCODE_ZENMUX_PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "ZenMux",
                "options": {
                    "baseURL": OPENCODE_ZENMUX_BASE_URL,
                    "apiKey": "{env:ZENMUX_API_KEY}"
                },
                "models": models
            }
        },
        "model": format!("{}/{}", OPENCODE_ZENMUX_PROVIDER_ID, model_id),
        "small_model": format!("{}/{}", OPENCODE_ZENMUX_PROVIDER_ID, model_id)
    })
}

fn opencode_auth_payload(api_key: &str) -> serde_json::Value {
    serde_json::json!({
        OPENCODE_ZENMUX_PROVIDER_ID: {
            "type": "api",
            "key": api_key
        }
    })
}

pub(super) fn setup_opencode_zenmux_profile(
    profile_home: &Path,
    selected_key: &ModelKey,
    session_model: Option<&str>,
) -> Result<(), String> {
    let api_key = selected_key
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenCode ZenMux session requires a ZenMux API key".to_string())?;
    let model_id = opencode_zenmux_model_id(session_model, selected_key);
    let config_dir = profile_home.join(".config").join("opencode");
    let data_dir = profile_home.join(".local").join("share").join("opencode");

    std::fs::create_dir_all(&config_dir)
        .map_err(|err| format!("Failed to create OpenCode config dir: {}", err))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("Failed to create OpenCode data dir: {}", err))?;

    let config_bytes = serde_json::to_vec_pretty(&opencode_zenmux_config_payload(&model_id))
        .map_err(|err| err.to_string())?;
    std::fs::write(config_dir.join("opencode.json"), config_bytes)
        .map_err(|err| format!("Failed to write OpenCode config: {}", err))?;

    let auth_bytes = serde_json::to_vec_pretty(&opencode_auth_payload(api_key))
        .map_err(|err| err.to_string())?;
    std::fs::write(data_dir.join("auth.json"), auth_bytes)
        .map_err(|err| format!("Failed to write OpenCode auth: {}", err))?;

    Ok(())
}

fn opencode_atlascloud_config_payload(model_id: &str, base_url: &str) -> serde_json::Value {
    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            ATLASCLOUD_PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "atlascloud",
                "options": {
                    "baseURL": base_url,
                    "apiKey": "{env:ATLASCLOUD_API_KEY}"
                },
                "models": {
                    model_id: {
                        "name": model_id
                    }
                }
            }
        },
        "model": format!("{}/{}", ATLASCLOUD_PROVIDER_ID, model_id),
        "small_model": format!("{}/{}", ATLASCLOUD_PROVIDER_ID, model_id)
    })
}

pub(super) fn setup_opencode_atlascloud_profile(
    profile_home: &Path,
    selected_key: &ModelKey,
    session_model: Option<&str>,
) -> Result<(), String> {
    let api_key = selected_key
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenCode Atlas Cloud session requires an API key".to_string())?;
    let model_id = atlascloud_model_id(session_model, selected_key);
    let base_url = selected_key
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(ATLASCLOUD_BASE_URL);
    let config_dir = profile_home.join(".config").join("opencode");
    let data_dir = profile_home.join(".local").join("share").join("opencode");

    std::fs::create_dir_all(&config_dir)
        .map_err(|err| format!("Failed to create OpenCode config dir: {}", err))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("Failed to create OpenCode data dir: {}", err))?;

    let config_bytes =
        serde_json::to_vec_pretty(&opencode_atlascloud_config_payload(&model_id, base_url))
            .map_err(|err| err.to_string())?;
    std::fs::write(config_dir.join("opencode.json"), config_bytes)
        .map_err(|err| format!("Failed to write OpenCode config: {}", err))?;

    let auth_bytes = serde_json::to_vec_pretty(&serde_json::json!({
        ATLASCLOUD_PROVIDER_ID: {
            "type": "api",
            "key": api_key
        }
    }))
    .map_err(|err| err.to_string())?;
    std::fs::write(data_dir.join("auth.json"), auth_bytes)
        .map_err(|err| format!("Failed to write OpenCode auth: {}", err))?;

    Ok(())
}

fn codex_compatible_model_id(
    session_model: Option<&str>,
    selected_key: &ModelKey,
) -> Result<String, String> {
    session_model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| selected_key.enabled_models.first().map(String::as_str))
        .or_else(|| selected_key.available_models.first().map(String::as_str))
        .map(|model| normalize_codex_provider_model_id(model, &selected_key.model_type))
        .ok_or_else(|| {
            format!(
                "Codex provider {} requires an explicit Responses-compatible model",
                selected_key.model_type.as_str()
            )
        })
}

pub(super) fn normalize_codex_provider_model_id(model: &str, provider: &ModelType) -> String {
    let model = model.trim();
    match provider {
        // Apply the equivalent namespace removal for direct OpenAI keys.
        ModelType::OpenaiApi => model.strip_prefix("openai/").unwrap_or(model).to_string(),
        // ZenMux requires provider/model slugs, so preserve them exactly.
        // Zhipu and Atlas Cloud are rejected by the compatibility gate because
        // their coding endpoints expose Chat Completions but not Responses.
        _ => model.to_string(),
    }
}

fn codex_compatible_base_url(selected_key: &ModelKey) -> Result<String, String> {
    selected_key
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            key_vault::provider_config::get_provider_config(selected_key.model_type.as_str())
                .default_base_url
        })
        .ok_or_else(|| {
            format!(
                "Codex compatible provider {} requires a base URL",
                selected_key.model_type.as_str()
            )
        })
}

/// Direct OpenAI keys must keep Codex's built-in `openai` provider, which
/// already targets the official endpoint over Responses with native OpenAI
/// auth, WebSocket support and Codex's own retry defaults. Routing them through
/// the synthetic compatible-provider table downgrades all four for no benefit.
/// A custom endpoint override is the one case that still needs the table.
pub(super) fn codex_needs_compatible_profile(selected_key: &ModelKey) -> bool {
    if selected_key.model_type != ModelType::OpenaiApi {
        return true;
    }

    let Some(base_url) = selected_key
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };

    key_vault::provider_config::get_provider_config(ModelType::OpenaiApi.as_str())
        .default_base_url
        .as_deref()
        .is_none_or(|official| !codex_endpoints_match(base_url, official))
}

fn codex_endpoints_match(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

/// Drop a profile an earlier session wrote for this key. Without this a key
/// that had a custom endpoint and then had it cleared would keep routing
/// through the stale `orgii_compatible` table forever. Only ORGII-authored
/// profiles are removed, so anything Codex persisted itself survives.
pub(super) fn clear_codex_compatible_profile(profile_home: &Path) -> Result<(), String> {
    let config_path = profile_home.join("config.toml");
    let Ok(existing) = std::fs::read_to_string(&config_path) else {
        return Ok(());
    };
    if !existing.contains(CODEX_COMPATIBLE_PROVIDER_ID) {
        return Ok(());
    }

    match std::fs::remove_file(&config_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to clear stale Codex config: {}", err)),
    }
}

pub(super) fn validate_codex_own_key_provider(selected_key: &ModelKey) -> Result<(), String> {
    let provider = selected_key.model_type.as_str();
    if selected_key.model_type == ModelType::Codex
        || key_vault::is_cli_provider_compatible("codex", provider)
    {
        return Ok(());
    }

    Err(format!(
        "Provider {provider} is not registered as Responses-compatible with Codex CLI"
    ))
}

/// Write the Codex custom-provider profile used by every cross-provider
/// own-key session. Codex no longer supports the legacy `wire_api = "chat"`
/// setting: OpenAI-compatible providers must use Responses, and providers that
/// do not explicitly advertise WebSocket support must stay on HTTP/SSE.
pub(super) fn setup_codex_compatible_profile(
    profile_home: &Path,
    selected_key: &ModelKey,
    session_model: Option<&str>,
    env_vars: &mut HashMap<String, String>,
) -> Result<(), String> {
    let base_url = codex_compatible_base_url(selected_key)?;
    let quoted_base_url = serde_json::to_string(&base_url).map_err(|err| err.to_string())?;
    let provider_name = format!("ORGII {}", selected_key.model_type.as_str());
    let quoted_provider_name =
        serde_json::to_string(&provider_name).map_err(|err| err.to_string())?;
    let model_id = codex_compatible_model_id(session_model, selected_key)?;
    let quoted_model = serde_json::to_string(&model_id).map_err(|err| err.to_string())?;
    let request_max_retries = agent_cli::managed_config::CODEX_REQUEST_MAX_RETRIES;
    let stream_max_retries = agent_cli::managed_config::CODEX_STREAM_MAX_RETRIES;
    let config = format!(
        "model_provider = \"{CODEX_COMPATIBLE_PROVIDER_ID}\"\n\
         model = {quoted_model}\n\n\
         [model_providers.{CODEX_COMPATIBLE_PROVIDER_ID}]\n\
         name = {quoted_provider_name}\n\
         base_url = {quoted_base_url}\n\
         env_key = \"OPENAI_API_KEY\"\n\
         wire_api = \"responses\"\n\
         requires_openai_auth = false\n\
         supports_websockets = false\n\
         request_max_retries = {request_max_retries}\n\
         stream_max_retries = {stream_max_retries}\n"
    );

    std::fs::create_dir_all(profile_home)
        .map_err(|err| format!("Failed to create Codex profile dir: {}", err))?;
    std::fs::write(profile_home.join("config.toml"), config)
        .map_err(|err| format!("Failed to write Codex config: {}", err))?;

    // The custom provider table is the single source of truth for routing;
    // do not leave a second endpoint override for the child to interpret.
    env_vars.remove("OPENAI_BASE_URL");

    Ok(())
}

/// Start the per-session MITM proxy and point the child's proxy/cert env at it.
/// Called only when the session uses a hosted key on a MITM-requiring agent.
pub(super) async fn start_session_mitm_proxy(
    session: &CodeSession,
    session_id: &str,
    env_vars: &mut HashMap<String, String>,
) -> Result<(), String> {
    let proxy_token_val = session
        .proxy_token
        .as_deref()
        .ok_or_else(|| "proxy_token is required for MITM proxy sessions".to_string())?;
    let proxy_url_val = session
        .proxy_url
        .as_deref()
        .ok_or_else(|| "proxy_url is required for MITM proxy sessions".to_string())?;

    let port = integrations::proxy::server::start_session_proxy(
        session_id,
        proxy_token_val,
        proxy_url_val,
    )
    .await?;

    tracing::info!(
        "[CodeSession] Started per-session MITM proxy on port {} for session {}",
        port,
        session_id
    );

    let cert_file = integrations::proxy::server::get_ssl_cert_file();
    let proxy_addr = format!("http://127.0.0.1:{}", port);
    env_vars.insert(proxy_env::HTTPS_PROXY.to_string(), proxy_addr.clone());
    env_vars.insert(proxy_env::HTTPS_PROXY_LOWER.to_string(), proxy_addr.clone());
    env_vars.insert("HTTP_PROXY".to_string(), proxy_addr.clone());
    env_vars.insert("http_proxy".to_string(), proxy_addr);
    env_vars.insert(proxy_env::SSL_CERT_FILE.to_string(), cert_file.clone());
    env_vars.insert(proxy_env::NODE_EXTRA_CA_CERTS.to_string(), cert_file);
    Ok(())
}

/// Set up per-agent config/home directories and auth-profile state on the
/// child's environment (Cursor, Claude Code, Codex own-key, OpenCode ZenMux,
/// Kiro). Also clears any stale Kiro session lock for a resumed conversation.
pub(super) fn setup_codex_hosted_profile(
    session_id: &str,
    proxy_url: Option<&str>,
    env_vars: &mut HashMap<String, String>,
) -> Result<(), String> {
    let proxy_url = proxy_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex hosted session requires a proxy URL".to_string())?;
    if env_vars
        .get("PROXY_TOKEN")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        return Err("Codex hosted session requires PROXY_TOKEN".to_string());
    }

    let codex_home = app_paths::codex_hosted_cli_profile_dir(session_id);
    agent_cli::managed_config::write_codex_hosted_profile(&codex_home, proxy_url)
        .map_err(|err| format!("Failed to setup hosted Codex profile: {err}"))?;
    env_vars.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().to_string(),
    );
    tracing::info!(
        "[CodeSession] Hosted Codex CODEX_HOME={}",
        codex_home.display()
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn configure_agent_profile(
    agent: &ModelType,
    session: &CodeSession,
    account_id: Option<&str>,
    selected_key: Option<&ModelKey>,
    session_id: &str,
    cli_resume_id: Option<&str>,
    env_vars: &mut HashMap<String, String>,
) -> Result<(), String> {
    if matches!(agent, ModelType::CursorCli) {
        let cursor_config_dir = if session.key_source == KeySource::HostedKey {
            Some(app_paths::cursor_config_dir(session_id))
        } else {
            account_id.map(app_paths::cursor_cli_profile_dir)
        };

        if let Some(orgii_dir) = cursor_config_dir {
            if let Err(err) = std::fs::create_dir_all(&orgii_dir) {
                tracing::warn!("[CodeSession] Failed to create cursor config dir: {}", err);
            } else {
                let config_path = orgii_dir.to_string_lossy().to_string();
                tracing::info!("[CodeSession] CURSOR_CONFIG_DIR={}", config_path);
                env_vars.insert("CURSOR_CONFIG_DIR".to_string(), config_path);

                if session.key_source == KeySource::HostedKey {
                    let config_content = r#"{"version": 1, "network": {"useHttp1ForAgent": true}}"#;
                    if let Err(err) =
                        std::fs::write(orgii_dir.join("cli-config.json"), config_content)
                    {
                        tracing::warn!("[CodeSession] Failed to write cursor config: {}", err);
                    }
                }
            }
        }
    }

    if matches!(agent, ModelType::ClaudeCode) {
        let claude_config_dir = if session.key_source == KeySource::HostedKey {
            Some(app_paths::claude_code_cli_profile_dir(session_id))
        } else {
            account_id.map(app_paths::claude_code_cli_profile_dir)
        };

        if let Some(orgii_dir) = claude_config_dir {
            if let Err(err) = std::fs::create_dir_all(&orgii_dir) {
                tracing::warn!(
                    "[CodeSession] Failed to create Claude Code config dir: {}",
                    err
                );
            } else {
                let config_path = orgii_dir.to_string_lossy().to_string();
                tracing::info!("[CodeSession] CLAUDE_CONFIG_DIR={}", config_path);
                env_vars.insert("CLAUDE_CONFIG_DIR".to_string(), config_path);
            }
        }
    }

    if matches!(agent, ModelType::Codex) && session.key_source == KeySource::OwnKey {
        let Some(account_id) = account_id else {
            return Err("Codex CLI own-key session requires account_id".to_string());
        };
        let codex_home = app_paths::codex_cli_profile_dir(account_id);
        env_vars.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().to_string(),
        );
        let selected_key = selected_key
            .ok_or_else(|| "Codex CLI own-key session requires a selected key".to_string())?;
        validate_codex_own_key_provider(selected_key)?;
        write_codex_cli_auth_file(account_id, selected_key, env_vars)?;
        if selected_key.model_type.is_api_key_provider()
            && codex_needs_compatible_profile(selected_key)
        {
            setup_codex_compatible_profile(
                &codex_home,
                selected_key,
                session.model.as_deref(),
                env_vars,
            )
            .map_err(|err| format!("Failed to setup Codex compatible provider profile: {err}"))?;
        } else if selected_key.model_type.is_api_key_provider() {
            clear_codex_compatible_profile(&codex_home)?;
        }
    }

    if matches!(agent, ModelType::Codex) && session.key_source == KeySource::HostedKey {
        setup_codex_hosted_profile(session_id, session.proxy_url.as_deref(), env_vars)?;
    }

    if matches!(agent, ModelType::OpenCode)
        && session.key_source == KeySource::OwnKey
        && selected_key.is_some_and(|key| {
            matches!(
                &key.model_type,
                ModelType::ZenmuxApi | ModelType::AtlascloudApi
            )
        })
    {
        let Some(account_id) = account_id else {
            return Err("OpenCode provider session requires account_id".to_string());
        };
        let selected_key = selected_key
            .ok_or_else(|| "OpenCode provider session requires a selected key".to_string())?;
        let opencode_home = app_paths::opencode_cli_profile_dir(account_id);
        let (provider_name, api_key_env) = match &selected_key.model_type {
            ModelType::ZenmuxApi => {
                setup_opencode_zenmux_profile(
                    &opencode_home,
                    selected_key,
                    session.model.as_deref(),
                )
                .map_err(|err| format!("Failed to setup OpenCode ZenMux profile: {}", err))?;
                ("ZenMux", "ZENMUX_API_KEY")
            }
            ModelType::AtlascloudApi => {
                setup_opencode_atlascloud_profile(
                    &opencode_home,
                    selected_key,
                    session.model.as_deref(),
                )
                .map_err(|err| format!("Failed to setup OpenCode Atlas Cloud profile: {}", err))?;
                ("Atlas Cloud", "ATLASCLOUD_API_KEY")
            }
            _ => unreachable!("OpenCode managed profile guard only accepts ZenMux or Atlas Cloud"),
        };

        let home_path = opencode_home.to_string_lossy().to_string();
        let config_home = opencode_home.join(".config").to_string_lossy().to_string();
        let data_home = opencode_home
            .join(".local")
            .join("share")
            .to_string_lossy()
            .to_string();

        tracing::info!(
            "[CodeSession] OpenCode {} HOME={}",
            provider_name,
            home_path
        );
        env_vars.insert("HOME".to_string(), home_path);
        env_vars.insert("XDG_CONFIG_HOME".to_string(), config_home);
        env_vars.insert("XDG_DATA_HOME".to_string(), data_home);
        if let Some(api_key) = selected_key.api_key.as_deref() {
            env_vars.insert(api_key_env.to_string(), api_key.to_string());
        }
    }

    if matches!(agent, ModelType::Kiro) {
        let kiro_home = if session.key_source == KeySource::HostedKey {
            let proxy_token_val = session.proxy_token.as_deref().unwrap_or("");
            let region_val = "us-east-1";
            match crate::agent_sessions::cli::platform_adapters::kiro::proxy_auth::setup_proxy_auth_db(
                proxy_token_val,
                region_val,
                session_id,
            ) {
                Ok(temp_home) => Some(temp_home),
                Err(err) => {
                    tracing::error!("[CodeSession] Failed to setup Kiro proxy auth DB: {}", err);
                    return Err(format!("Failed to setup Kiro proxy auth DB: {}", err));
                }
            }
        } else {
            match account_id {
                Some(account_id) => {
                    let profile_home = app_paths::kiro_cli_profile_dir(account_id);
                    match crate::agent_sessions::cli::platform_adapters::kiro::proxy_auth::setup_own_key_home(
                        &profile_home,
                        env_vars,
                    ) {
                        Ok(()) => Some(profile_home),
                        Err(err) => {
                            tracing::error!("[CodeSession] Failed to setup Kiro own-key auth DB: {}", err);
                            return Err(format!("Failed to setup Kiro own-key auth DB: {}", err));
                        }
                    }
                }
                None => None,
            }
        };

        if let Some(kiro_home) = kiro_home {
            let home_path = kiro_home.to_string_lossy().to_string();
            tracing::info!("[CodeSession] Kiro HOME={}", home_path);
            #[cfg(unix)]
            if let Some(real_home) = dirs::home_dir() {
                let real_bin = real_home.join(".local/bin");
                let real_bin_str = real_bin.to_string_lossy().to_string();
                let current_path = std::env::var("PATH").unwrap_or_default();
                if !current_path.contains(&real_bin_str) {
                    env_vars.insert(
                        "PATH".to_string(),
                        format!("{}:{}", real_bin_str, current_path),
                    );
                }
            }
            env_vars.insert("HOME".to_string(), home_path);
        }
    }
    if matches!(agent, ModelType::Kiro) {
        if let Some(resume_id) = cli_resume_id {
            crate::agent_sessions::cli::parsers::kiro::clean_stale_lock(resume_id);
        }
    }

    Ok(())
}

/// Inject the orgtrack identity for agent-plane CLI calls (design M6),
/// mirroring the native run_shell injection: `org2-pm` resolves
/// actor/session/scope/mode from these env vars instead of trusting
/// model-typed flags, the fail-closed workspace marker binds the identity
/// to this session, and the host binary directory rides the front of PATH
/// so the bundled `org2-pm` always matches the app version. External CLIs
/// (Claude Code, Codex, …) go through the same org2-pm surface as native
/// agents because of this injection.
pub(super) fn resolve_orgtrack_product_mode(
    persisted_product_mode: Option<&str>,
    has_work_item: bool,
) -> &str {
    // WorkItem linkage is a frozen resolver rule and may repair a legacy row.
    // A project slug is scope only: elevating it here would let an ordinary
    // Build session launched inside a project acquire PM mutation capability.
    persisted_product_mode.unwrap_or(if has_work_item { "project" } else { "build" })
}

pub(super) fn inject_orgtrack_environment(
    session: &CodeSession,
    session_id: &str,
    working_dir: &str,
    env_vars: &mut HashMap<String, String>,
) {
    let agent = session.cli_agent_type.as_deref().unwrap_or("cli");
    // The persisted product-mode axis wins; sessions from before the
    // column (or launched by flows that never set it) fall back to the
    // WorkItem linkage may repair a historical row; project scope alone must
    // never elevate an ordinary Build session into Project capability.
    let product_mode = resolve_orgtrack_product_mode(
        session.product_mode.as_deref(),
        session.work_item_id.is_some(),
    );

    env_vars.insert(
        "ORGII_SESSION_REF".to_string(),
        format!("org2:{session_id}"),
    );
    env_vars.insert("ORGII_ACTOR".to_string(), format!("agent:{agent}"));
    env_vars.insert("ORGII_MODE".to_string(), product_mode.to_string());
    if let Some(slug) = session.project_slug.as_deref() {
        env_vars.insert("ORGII_SCOPE".to_string(), slug.to_string());
    }
    let org_scope =
        project_management::projects::io::resolve_local_org_scope(Some(session.org_id.as_str()));
    if let Some(org) = org_scope.as_deref() {
        env_vars.insert("ORGII_ORG".to_string(), org.to_string());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let base_path = env_vars
                .get("PATH")
                .map(std::ffi::OsString::from)
                .or_else(|| std::env::var_os("PATH"));
            let mut paths = vec![dir.to_path_buf()];
            if let Some(existing_path) = base_path {
                paths.extend(std::env::split_paths(&existing_path));
            }
            if let Ok(joined_path) = std::env::join_paths(paths) {
                env_vars.insert(
                    "PATH".to_string(),
                    joined_path.to_string_lossy().to_string(),
                );
            }
        }
    }

    agent_core::session::launch::write_agent_session_marker(
        working_dir,
        session_id,
        Some(agent),
        Some(product_mode),
        session.project_slug.as_deref(),
        Some(session.org_id.as_str()),
    );
}

/// Forward the host's system proxy env vars to the child and ensure localhost
/// bypasses the proxy.
pub(super) fn apply_system_proxy_passthrough(env_vars: &mut HashMap<String, String>) {
    for (lower, upper) in &[
        ("http_proxy", "HTTP_PROXY"),
        ("https_proxy", "HTTPS_PROXY"),
        ("no_proxy", "NO_PROXY"),
    ] {
        let value = std::env::var(lower).or_else(|_| std::env::var(upper)).ok();
        if let Some(ref val) = value {
            env_vars
                .entry(lower.to_string())
                .or_insert_with(|| val.clone());
            env_vars
                .entry(upper.to_string())
                .or_insert_with(|| val.clone());
        }
    }

    let no_proxy_extras = "localhost,127.0.0.1";
    for key in &["no_proxy", "NO_PROXY"] {
        let current = env_vars.get(*key).cloned().unwrap_or_default();
        if current.is_empty() {
            env_vars.insert(key.to_string(), no_proxy_extras.to_string());
        } else if !current.contains("localhost") {
            env_vars.insert(key.to_string(), format!("{},{}", current, no_proxy_extras));
        }
    }
}

/// For an OpenCode session with an Anthropic `baseURL` configured, start the
/// local SSE sanitizer proxy and repoint `ANTHROPIC_BASE_URL` at it. No-op for
/// any other agent. Failures fall back to a direct connection.
pub(super) async fn setup_opencode_sse_sanitizer(
    agent: &ModelType,
    env_vars: &mut HashMap<String, String>,
) {
    if !matches!(agent, ModelType::OpenCode) {
        return;
    }

    let upstream = tokio::task::spawn_blocking(|| {
        let config_text = std::fs::read_to_string(
            dirs::config_dir()
                .unwrap_or_default()
                .join("opencode")
                .join("opencode.json"),
        )
        .ok()?;
        let config = serde_json::from_str::<serde_json::Value>(&config_text).ok()?;
        config
            .get("provider")?
            .get("anthropic")?
            .get("options")?
            .get("baseURL")?
            .as_str()
            .map(str::to_string)
    })
    .await
    .ok()
    .flatten();

    if let Some(upstream) = upstream {
        if !upstream.contains("127.0.0.1") && !upstream.contains("localhost") {
            match integrations::proxy::sse_sanitizer::ensure_running(&upstream).await {
                Ok(local_url) => {
                    tracing::info!(
                        "[CodeSession] SSE sanitizer active: {} → {}",
                        local_url,
                        upstream
                    );
                    env_vars.insert("ANTHROPIC_BASE_URL".to_string(), local_url);
                }
                Err(err) => {
                    tracing::warn!(
                        "[CodeSession] SSE sanitizer failed: {} — using direct connection",
                        err
                    );
                }
            }
        }
    }
}
