//! Embedded defaults for the E2E HTTP client (`model`, `account_id`, `base_url`, timeouts).
//!
//! Defaults are embedded in this file. Override at runtime with `SOYD_E2E_*`
//! environment variables or `--config /path/to.yaml` (YAML shape: top-level `agent:` with the same fields).
//! Each run sets a unique `session_prefix` (`test:e2e-<unix_secs>`).

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct E2eConfigFile {
    #[serde(default)]
    pub agent: E2eAgentSection,
}

/// Embedded shape for the top-level `agent:` section of the E2E config YAML.
/// This is purely the test harness's own settings (model, account, base URL,
/// timeout) — it is NOT related to the agent-core runtime agent definition.
#[derive(Debug, Deserialize)]
pub struct E2eAgentSection {
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_account")]
    pub account_id: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "default_base_url")]
    pub base_url: String,
}

impl Default for E2eAgentSection {
    fn default() -> Self {
        Self {
            model: default_model(),
            account_id: default_account(),
            timeout_secs: default_timeout(),
            base_url: default_base_url(),
        }
    }
}

fn default_model() -> String {
    std::env::var("SOYD_E2E_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".to_string())
}

fn default_account() -> String {
    std::env::var("SOYD_E2E_ACCOUNT_ID").unwrap_or_else(|_| "166a5ee8".to_string())
}

fn default_timeout() -> u64 {
    std::env::var("SOYD_E2E_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(180)
}

fn default_base_url() -> String {
    std::env::var("SOYD_E2E_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:13847".to_string())
}

pub struct Config {
    pub model: String,
    pub account_id: String,
    pub timeout_secs: u64,
    pub base_url: String,
    pub session_prefix: String,
}

/// Load config: embedded defaults, or merge with optional `--config` YAML file.
pub fn load(config_path: Option<&str>) -> Config {
    let file_cfg = match config_path {
        None => {
            println!("Using embedded E2E defaults (see e2e_test/config.rs). Pass --config <path> to override.");
            E2eAgentSection::default()
        }
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.exists() {
                eprintln!("Config file not found: {}", path.display());
                std::process::exit(1);
            }
            let content = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                eprintln!("Failed to read {}: {}", path.display(), e);
                std::process::exit(1);
            });
            let parsed: E2eConfigFile = serde_yaml::from_str(&content).unwrap_or_else(|e| {
                eprintln!("Invalid YAML in {}: {}", path.display(), e);
                std::process::exit(1);
            });
            println!("Loaded config from {}", path.display());
            parsed.agent
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    Config {
        model: file_cfg.model,
        account_id: file_cfg.account_id,
        timeout_secs: file_cfg.timeout_secs,
        base_url: file_cfg.base_url,
        session_prefix: format!("test:e2e-{}", ts),
    }
}
