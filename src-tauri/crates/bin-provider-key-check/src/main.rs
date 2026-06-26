//! Headless credential validation against live provider APIs (no Tauri UI).
//!
//! Usage:
//!   provider-key-check [CONFIG.json]
//!   PROVIDER_KEY_CHECK_CONFIG=/path/to/config.json provider-key-check
//!
//! Config lists `agent_type` values (same strings as Integrations / `validate_key`)
//! and which environment variable holds the API key or token.
//!
//! CI: inject secrets as env vars, point to a checked-in example config with *_ENV names,
//! or use a generated JSON from your pipeline.

use key_vault::run_validate_key;
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

#[derive(Debug, Deserialize)]
struct CheckEntry {
    /// Same strings as Key Vault wizard / `run_validate_key` (see `AGENT_ENV_CONFIG`).
    agent_type: String,
    /// Environment variable for API key or primary token (see wizard `apiKeyEnvVar`)
    api_key_env: String,
    /// Fixed base URL (optional)
    #[serde(default)]
    base_url: Option<String>,
    /// Read base URL from this env (optional; matches wizard `baseUrlEnvVar` — overrides `base_url` when set)
    #[serde(default)]
    base_url_env: Option<String>,
    /// Optional session / OAuth token (e.g. Cursor quota, Codex OAuth)
    #[serde(default)]
    session_token_env: Option<String>,
    #[serde(default)]
    test_model: Option<String>,
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfigFile {
    checks: Vec<CheckEntry>,
}

fn resolve_config_path() -> Result<PathBuf, String> {
    if let Some(first) = env::args().nth(1) {
        if first == "--help" || first == "-h" {
            print_usage();
            process::exit(0);
        }
        return Ok(PathBuf::from(first));
    }
    env::var("PROVIDER_KEY_CHECK_CONFIG")
        .map(PathBuf::from)
        .map_err(|_| {
            "No config path: pass CONFIG.json as first argument or set PROVIDER_KEY_CHECK_CONFIG"
                .to_string()
        })
}

fn print_usage() {
    eprintln!("provider-key-check — validate API keys via the same Rust validators as the app");
    eprintln!();
    eprintln!("Usage:");
    eprintln!("  provider-key-check <CONFIG.json>");
    eprintln!("  PROVIDER_KEY_CHECK_CONFIG=./config.json provider-key-check");
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("provider-key-check: {}", err);
        process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let path = resolve_config_path()?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
    let config: ConfigFile =
        serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in config: {}", e))?;

    if config.checks.is_empty() {
        return Err("config has empty `checks` array".to_string());
    }

    let mut failed = false;

    for entry in &config.checks {
        let api_key = env::var(&entry.api_key_env).map_err(|_| {
            format!(
                "missing env {} for check agent_type={}",
                entry.api_key_env, entry.agent_type
            )
        })?;

        // Session is optional (matches wizard: Cursor quota / Codex OAuth may be absent).
        let session_token = entry
            .session_token_env
            .as_ref()
            .and_then(|name| env::var(name).ok());

        let base_url = match &entry.base_url_env {
            Some(name) => env::var(name).ok().or_else(|| entry.base_url.clone()),
            None => entry.base_url.clone(),
        };

        match run_validate_key(
            entry.agent_type.clone(),
            api_key,
            base_url,
            session_token,
            entry.test_model.clone(),
            entry.protocol.clone(),
        )
        .await
        {
            Ok(result) => {
                if result.valid {
                    println!(
                        "[{}] {} — OK — {} ({} models)",
                        entry.agent_type,
                        entry.api_key_env,
                        result.message,
                        result.models_available.len()
                    );
                } else {
                    failed = true;
                    println!(
                        "[{}] {} — FAIL — {}",
                        entry.agent_type, entry.api_key_env, result.message
                    );
                }
            }
            Err(e) => {
                failed = true;
                println!(
                    "[{}] {} — ERROR — {}",
                    entry.agent_type, entry.api_key_env, e
                );
            }
        }
    }

    if failed {
        process::exit(1);
    }
    Ok(())
}
