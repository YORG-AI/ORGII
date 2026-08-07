use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};

use serde_json::Value;

const DEFAULT_CONTEXT_LIMIT_TOKENS: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HousekeeperCompactionConfig {
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub context_limit_tokens: usize,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static CONFIG: OnceLock<RwLock<HousekeeperCompactionConfig>> = OnceLock::new();

fn config_store() -> &'static RwLock<HousekeeperCompactionConfig> {
    CONFIG.get_or_init(|| {
        RwLock::new(HousekeeperCompactionConfig {
            account_id: None,
            model: None,
            context_limit_tokens: DEFAULT_CONTEXT_LIMIT_TOKENS,
        })
    })
}

fn optional_string(settings: &Value, key: &str) -> Option<String> {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_settings(settings: &Value) -> (bool, HousekeeperCompactionConfig) {
    let enabled = settings
        .get("housekeeper.enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && settings
            .get("housekeeper.features.contextCompact")
            .and_then(Value::as_bool)
            .unwrap_or(false);

    let config = HousekeeperCompactionConfig {
        account_id: optional_string(settings, "housekeeper.accountId"),
        model: optional_string(settings, "housekeeper.model"),
        context_limit_tokens: settings
            .get("housekeeper.contextLimitTokens")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_CONTEXT_LIMIT_TOKENS)
            .clamp(1_024, 32_768),
    };

    (enabled, config)
}

pub fn update_from_settings(settings: &Value) {
    let (enabled, next) = parse_settings(settings);

    match config_store().write() {
        Ok(mut config) => *config = next,
        Err(poisoned) => *poisoned.into_inner() = next,
    }
    ENABLED.store(enabled, Ordering::Release);
}

pub fn refresh_from_disk() {
    match settings::file_io::read_settings() {
        Ok(settings) => update_from_settings(&settings),
        Err(err) => {
            ENABLED.store(false, Ordering::Release);
            tracing::warn!(
                "[housekeeper_compaction] failed to read settings; feature disabled: {}",
                err
            );
        }
    }
}

pub(crate) fn current() -> Option<HousekeeperCompactionConfig> {
    if !ENABLED.load(Ordering::Acquire) {
        return None;
    }

    Some(match config_store().read() {
        Ok(config) => config.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    })
}

pub(crate) fn is_enabled() -> bool {
    ENABLED.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_double_gate_and_runtime_selection() {
        let settings = serde_json::json!({
            "housekeeper.enabled": true,
            "housekeeper.features.contextCompact": true,
            "housekeeper.accountId": "local-minicpm",
            "housekeeper.model": "openbmb/MiniCPM5-1B",
            "housekeeper.contextLimitTokens": 9_000,
        });

        let (enabled, config) = parse_settings(&settings);

        assert!(enabled);
        assert_eq!(
            config,
            HousekeeperCompactionConfig {
                account_id: Some("local-minicpm".to_string()),
                model: Some("openbmb/MiniCPM5-1B".to_string()),
                context_limit_tokens: 9_000,
            }
        );
    }

    #[test]
    fn feature_defaults_to_disabled() {
        let (enabled, _) = parse_settings(&serde_json::json!({
            "housekeeper.enabled": true,
        }));

        assert!(!enabled);
    }
}
