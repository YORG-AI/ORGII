//! Managed config content generation: the inline generators for Codex,
//! Claude Code, OpenCode and Aider, plus the per-agent dispatch that fans
//! out to [`super::adapters`].

use std::collections::{BTreeMap, BTreeSet};

use super::adapters;
use super::proxy::{claude_code_proxy_base_url, codex_proxy_base_url, openai_chat_proxy_base_url};
use super::registry::{
    managed_config_adapter, ManagedConfigGenerator, AIDER_AGENT, DEFAULT_ORGII_MODEL, KILO_AGENT,
    MIMO_CODE_AGENT, OPENCODE_AGENT, ORGII_PROVIDER_ID, ORGII_PROVIDER_NAME,
};

pub(super) fn generate_codex_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: toml::Value = if existing_content.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str(existing_content).map_err(|err| format!("Invalid Codex TOML: {err}"))?
    };

    let Some(root) = config.as_table_mut() else {
        return Err("Codex config must be a TOML table".to_string());
    };

    let model = selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ORGII_MODEL);
    root.insert("model".to_string(), toml::Value::String(model.to_string()));
    root.insert(
        "model_provider".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );

    if !matches!(root.get("model_providers"), Some(toml::Value::Table(_))) {
        root.insert(
            "model_providers".to_string(),
            toml::Value::Table(toml::map::Map::new()),
        );
    }

    let Some(toml::Value::Table(providers)) = root.get_mut("model_providers") else {
        return Err("Failed to build Codex model_providers table".to_string());
    };

    let mut orgii = toml::map::Map::new();
    orgii.insert(
        "name".to_string(),
        toml::Value::String(ORGII_PROVIDER_NAME.to_string()),
    );
    orgii.insert(
        "base_url".to_string(),
        toml::Value::String(codex_proxy_base_url(proxy_url, proxy_token)),
    );
    orgii.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(false),
    );
    orgii.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    providers.insert(ORGII_PROVIDER_ID.to_string(), toml::Value::Table(orgii));

    toml::to_string_pretty(&config).map_err(|err| format!("TOML serialize error: {err}"))
}

pub(super) fn selected_model_or_default(selected_model: Option<&str>) -> &str {
    selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ORGII_MODEL)
}

pub(super) fn generate_claude_code_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: serde_json::Value = if existing_content.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(existing_content)
            .map_err(|err| format!("Invalid Claude Code JSON: {err}"))?
    };

    let Some(root) = config.as_object_mut() else {
        return Err("Claude Code settings must be a JSON object".to_string());
    };

    let model = selected_model_or_default(selected_model);
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );

    if !matches!(root.get("env"), Some(serde_json::Value::Object(_))) {
        root.insert(
            "env".to_string(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }

    let Some(serde_json::Value::Object(env)) = root.get_mut("env") else {
        return Err("Failed to build Claude Code env object".to_string());
    };

    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        serde_json::Value::String(proxy_token.to_string()),
    );
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        serde_json::Value::String(claude_code_proxy_base_url(proxy_url, proxy_token)),
    );
    env.insert(
        "ANTHROPIC_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    env.insert(
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string(),
        serde_json::Value::String("1".to_string()),
    );
    env.insert(
        "DISABLE_INTERLEAVED_THINKING".to_string(),
        serde_json::Value::String("1".to_string()),
    );

    serde_json::to_string_pretty(&config)
        .map(|value| format!("{value}\n"))
        .map_err(|err| format!("JSON serialize error: {err}"))
}

fn quote_env_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn env_line_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty()
        || !key
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(key.to_string())
}

pub(super) fn upsert_env_file(existing_content: &str, values: &[(&str, String)]) -> String {
    let replacements: BTreeMap<&str, String> = values.iter().cloned().collect();
    let mut seen = BTreeSet::new();
    let mut lines = Vec::new();

    for line in existing_content.lines() {
        if let Some(key) = env_line_key(line) {
            if let Some(value) = replacements.get(key.as_str()) {
                if seen.insert(key.clone()) {
                    lines.push(format!("{key}={}", quote_env_value(value)));
                }
                continue;
            }
        }
        lines.push(line.to_string());
    }

    for (key, value) in values {
        if !seen.contains(*key) {
            lines.push(format!("{key}={}", quote_env_value(value)));
        }
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

pub(super) fn generate_opencode_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    adapters::generate_open_code_family_managed_config(
        existing_content,
        selected_model,
        proxy_url,
        proxy_token,
        OPENCODE_AGENT,
        "OpenCode",
        true,
    )
}

pub(super) fn generate_aider_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config: serde_yaml::Value = if existing_content.trim().is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(existing_content)
            .map_err(|err| format!("Invalid Aider YAML: {err}"))?
    };
    let Some(root) = config.as_mapping_mut() else {
        return Err("Aider config must be a YAML mapping".to_string());
    };

    let model = selected_model_or_default(selected_model);
    let aider_model = if model.starts_with("openai/") {
        model.to_string()
    } else {
        format!("openai/{model}")
    };
    root.insert(
        serde_yaml::Value::String("model".to_string()),
        serde_yaml::Value::String(aider_model),
    );
    root.insert(
        serde_yaml::Value::String("openai-api-base".to_string()),
        serde_yaml::Value::String(openai_chat_proxy_base_url(
            proxy_url,
            AIDER_AGENT,
            proxy_token,
        )),
    );
    root.insert(
        serde_yaml::Value::String("openai-api-key".to_string()),
        serde_yaml::Value::String(proxy_token.to_string()),
    );

    serde_yaml::to_string(&config).map_err(|err| format!("Aider YAML serialize error: {err}"))
}

pub(super) fn generate_managed_configs(
    agent_name: &str,
    existing_contents: &BTreeMap<String, String>,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<BTreeMap<String, String>, String> {
    let adapter = managed_config_adapter(agent_name)
        .ok_or_else(|| format!("ORGII managed config is not available for {agent_name}"))?;
    let content = |file_id: &str| {
        existing_contents
            .get(file_id)
            .map(String::as_str)
            .unwrap_or("")
    };
    let mut files = BTreeMap::new();
    for target in adapter.targets {
        let existing_content = content(target.file_id);
        let generated = match target.generator {
            ManagedConfigGenerator::CodexToml => generate_codex_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::ClaudeCodeJson => generate_claude_code_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OpenCodeJsonc => generate_opencode_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::AiderYaml => generate_aider_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::KimiToml => adapters::generate_kimi_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::GooseYaml => adapters::generate_goose_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::GooseSecretsYaml => {
                adapters::generate_goose_secrets(existing_content, proxy_token)?
            }
            ManagedConfigGenerator::ClineProvidersJson => adapters::generate_cline_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::KiloJsonc => {
                adapters::generate_open_code_family_managed_config(
                    existing_content,
                    selected_model,
                    proxy_url,
                    proxy_token,
                    KILO_AGENT,
                    "Kilo",
                    true,
                )?
            }
            ManagedConfigGenerator::HermesYaml => adapters::generate_hermes_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OpenClawJsonc => adapters::generate_openclaw_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::QwenCodeJson => adapters::generate_qwen_code_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MimoCodeJson => {
                adapters::generate_open_code_family_managed_config(
                    existing_content,
                    selected_model,
                    proxy_url,
                    proxy_token,
                    MIMO_CODE_AGENT,
                    "MiMo Code",
                    false,
                )?
            }
            ManagedConfigGenerator::ContinueYaml => adapters::generate_continue_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::DroidJson => adapters::generate_droid_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MistralVibeToml => adapters::generate_mistral_vibe_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::MistralVibeEnv => {
                adapters::generate_mistral_vibe_env(existing_content, proxy_token)
            }
            ManagedConfigGenerator::AutohandJson => adapters::generate_autohand_managed_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OmpModelsYaml => adapters::generate_omp_models_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
            ManagedConfigGenerator::OmpSettingsYaml => {
                adapters::generate_omp_settings_config(existing_content, selected_model)?
            }
            ManagedConfigGenerator::PiSettingsJson => {
                adapters::generate_pi_settings_config(existing_content, selected_model)?
            }
            ManagedConfigGenerator::PiModelsJson => adapters::generate_pi_models_config(
                existing_content,
                selected_model,
                proxy_url,
                proxy_token,
            )?,
        };
        files.insert(target.file_id.to_string(), generated);
    }
    Ok(files)
}
