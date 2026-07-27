//! Child-process environment preparation for CLI sessions.
//!
//! Everything that mutates the spawned agent's environment or on-disk profile
//! before launch: per-agent config/home directories, the per-session MITM
//! proxy, system-proxy passthrough, the Codex hosted-proxy config + login, and
//! the OpenCode SSE sanitizer. Extracted from `session::run_session` so the
//! runner reads as an orchestration of named phases.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;

use tokio::process::Command;

use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use key_vault::key_store::{ModelKey, ModelType};

use super::super::persistence::CodeSession;
use super::super::types::{proxy_env, KeySource};
use super::oauth_setup::write_codex_cli_auth_file;

const OPENCODE_ZENMUX_PROVIDER_ID: &str = "zenmux";
const OPENCODE_ZENMUX_BASE_URL: &str = "https://zenmux.ai/api/v1";
const OPENCODE_DEFAULT_ZENMUX_MODEL: &str = "deepseek/deepseek-chat";
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
        write_codex_cli_auth_file(account_id, env_vars);
    }

    if matches!(agent, ModelType::OpenCode)
        && session.key_source == KeySource::OwnKey
        && selected_key.is_some_and(|key| key.model_type == ModelType::ZenmuxApi)
    {
        let Some(account_id) = account_id else {
            return Err("OpenCode ZenMux own-key session requires account_id".to_string());
        };
        let selected_key = selected_key
            .ok_or_else(|| "OpenCode ZenMux session requires a selected ZenMux key".to_string())?;
        let opencode_home = app_paths::opencode_cli_profile_dir(account_id);
        setup_opencode_zenmux_profile(&opencode_home, selected_key, session.model.as_deref())
            .map_err(|err| format!("Failed to setup OpenCode ZenMux profile: {}", err))?;

        let home_path = opencode_home.to_string_lossy().to_string();
        let config_home = opencode_home.join(".config").to_string_lossy().to_string();
        let data_home = opencode_home
            .join(".local")
            .join("share")
            .to_string_lossy()
            .to_string();

        tracing::info!("[CodeSession] OpenCode ZenMux HOME={}", home_path);
        env_vars.insert("HOME".to_string(), home_path);
        env_vars.insert("XDG_CONFIG_HOME".to_string(), config_home);
        env_vars.insert("XDG_DATA_HOME".to_string(), data_home);
        if let Some(api_key) = selected_key.api_key.as_deref() {
            env_vars.insert("ZENMUX_API_KEY".to_string(), api_key.to_string());
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

fn ensure_codex_hosted_proxy_config(proxy_url_val: &str) {
    if let Some(home) = dirs::home_dir() {
        let codex_dir = home.join(".codex");
        let config_file = codex_dir.join("config.toml");

        let needs_proxy_section = if config_file.exists() {
            std::fs::read_to_string(&config_file)
                .map(|content| !content.contains("[model_providers.proxy]"))
                .unwrap_or(true)
        } else {
            true
        };

        if needs_proxy_section {
            if let Err(err) = std::fs::create_dir_all(&codex_dir) {
                tracing::warn!("[CodeSession] Failed to create ~/.codex dir: {}", err);
            } else {
                let proxy_section = format!(
                    "\n[model_providers.proxy]\n\
                     name = \"Proxy\"\n\
                     base_url = \"{}/v1\"\n\
                     env_key = \"PROXY_TOKEN\"\n\
                     requires_openai_auth = false\n\
                     wire_api = \"responses\"\n",
                    proxy_url_val
                );
                let write_result = if config_file.exists() {
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(&config_file)
                        .and_then(|mut file| {
                            use std::io::Write;
                            file.write_all(proxy_section.as_bytes())
                        })
                } else {
                    std::fs::write(&config_file, proxy_section.trim_start())
                };
                match write_result {
                    Ok(()) => {
                        tracing::info!(
                            "[CodeSession] Wrote codex proxy config to {:?}",
                            config_file
                        )
                    }
                    Err(err) => {
                        tracing::warn!("[CodeSession] Failed to write codex config.toml: {}", err)
                    }
                }
            }
        }
    }
}

/// For a Codex hosted-key session: ensure `~/.codex/config.toml` has the proxy
/// `model_providers.proxy` section, then run `codex login --with-api-key` with
/// the proxy token. No-op for any other agent/key-source. Failures are logged
/// and the session continues.
pub(super) async fn setup_codex_hosted_proxy(
    agent: &ModelType,
    session: &CodeSession,
    env_vars: &HashMap<String, String>,
) {
    if !(matches!(agent, ModelType::Codex) && session.key_source == KeySource::HostedKey) {
        return;
    }

    let proxy_url = session.proxy_url.clone().unwrap_or_default();
    if let Err(err) = tokio::task::spawn_blocking(move || {
        ensure_codex_hosted_proxy_config(&proxy_url);
    })
    .await
    {
        tracing::warn!("[CodeSession] Codex proxy config task failed: {err}");
    }

    let api_key_val = session.proxy_token.as_deref().unwrap_or("");
    if !api_key_val.is_empty() {
        let codex_bin = resolve_cli_binary_command(CliBinaryId::Codex);
        tracing::info!(
            "[CodeSession] Running codex login --with-api-key via {}...",
            codex_bin
        );
        let mut login_cmd = Command::new(&codex_bin);
        login_cmd
            .arg("login")
            .arg("--with-api-key")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(env_vars);
        // Windows: don't flash a console window for `codex login`.
        #[cfg(windows)]
        login_cmd.creation_flags(app_platform::CREATE_NO_WINDOW);
        match login_cmd.spawn() {
            Ok(mut login_child) => {
                if let Some(mut stdin) = login_child.stdin.take() {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(api_key_val.as_bytes()).await;
                    drop(stdin);
                }
                match login_child.wait().await {
                    Ok(status) if status.success() => {
                        tracing::info!("[CodeSession] codex login succeeded");
                    }
                    Ok(status) => {
                        tracing::warn!(
                            "[CodeSession] codex login failed (exit {:?}) — continuing anyway",
                            status.code()
                        );
                    }
                    Err(err) => {
                        tracing::warn!(
                            "[CodeSession] codex login wait error: {} — continuing anyway",
                            err
                        );
                    }
                }
            }
            Err(err) => {
                tracing::warn!(
                    "[CodeSession] Failed to spawn codex login: {} — continuing anyway",
                    err
                );
            }
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
