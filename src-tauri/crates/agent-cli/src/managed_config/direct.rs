//! Native API connections. These profiles do not depend on an ORGII process.
use std::collections::BTreeMap;

use super::dto::{CliConfigMode, CliConfigProfileManifest};

// Intentionally no Debug/Serialize: this value holds a decrypted credential.
pub struct DirectConnection {
    pub key_id: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
}

pub(super) fn generate_direct_configs(
    agent: &str,
    contents: &BTreeMap<String, String>,
    connection: &DirectConnection,
    previous: Option<&CliConfigProfileManifest>,
) -> Result<BTreeMap<String, String>, String> {
    if connection.api_key.trim().is_empty() || connection.model.trim().is_empty() {
        return Err("An API key and model are required".into());
    }
    let (file_id, generated) = match agent {
        "claude_code" => (
            "settings",
            claude(
                contents.get("settings").map(String::as_str).unwrap_or(""),
                connection,
            )?,
        ),
        "codex" => (
            "config",
            codex(
                contents.get("config").map(String::as_str).unwrap_or(""),
                connection,
                previous,
            )?,
        ),
        _ => return Err("Direct connections currently support Claude Code and Codex".into()),
    };
    Ok(BTreeMap::from([(file_id.to_string(), generated)]))
}

fn claude(raw: &str, connection: &DirectConnection) -> Result<String, String> {
    let mut settings: serde_json::Value = if raw.trim().is_empty() {
        serde_json::json!({})
    } else {
        // Do not include parser diagnostics: source excerpts can contain secrets.
        serde_json::from_str(raw).map_err(|_| "Invalid Claude Code settings JSON")?
    };
    let root = settings
        .as_object_mut()
        .ok_or("Claude Code settings must be an object")?;
    if root.contains_key("apiKeyHelper") {
        return Err(
            "Claude Code uses apiKeyHelper. Resolve that authentication override before switching."
                .into(),
        );
    }
    let env = root
        .entry("env")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Claude Code env must be an object")?;
    if [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ]
    .iter()
    .any(|key| {
        env.get(*key)
            .is_some_and(|value| value.as_str() == Some("1") || value.as_bool() == Some(true))
    }) {
        return Err(
            "Claude Code has a cloud-provider override. Resolve it before switching.".into(),
        );
    }
    // Remove conflicting authentication/model aliases only; preserve all other settings.
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
    ] {
        env.remove(key);
    }
    let auth_field = if connection.base_url == "https://api.anthropic.com" {
        "ANTHROPIC_API_KEY"
    } else {
        "ANTHROPIC_AUTH_TOKEN"
    };
    env.insert(auth_field.into(), connection.api_key.clone().into());
    env.insert(
        "ANTHROPIC_BASE_URL".into(),
        connection.base_url.clone().into(),
    );
    env.insert("ANTHROPIC_MODEL".into(), connection.model.clone().into());
    root.insert("model".into(), connection.model.clone().into());
    serde_json::to_string_pretty(&settings)
        .map_err(|_| "Failed to serialize Claude Code settings".into())
}

fn codex(
    raw: &str,
    connection: &DirectConnection,
    previous: Option<&CliConfigProfileManifest>,
) -> Result<String, String> {
    use toml_edit::{value, Document, Item, Table};
    let mut config = raw.parse::<Document>().map_err(|_| "Invalid Codex TOML")?;
    if config
        .get("model_providers")
        .is_some_and(|item| !item.is_table())
    {
        return Err("Codex model_providers must be a table".into());
    }
    let owned = previous.is_some_and(|manifest| manifest.mode != CliConfigMode::Default);
    if !owned
        && config
            .get("model_providers")
            .and_then(|item| item.get("orgii"))
            .is_some()
    {
        return Err(
            "A Codex provider named orgii already exists. Rename it before switching.".into(),
        );
    }
    if config.get("model_providers").is_none() {
        config["model_providers"] = Item::Table(Table::new());
    }
    let mut provider = Table::new();
    provider["name"] = value("ORGII");
    provider["base_url"] = value(&connection.base_url);
    provider["wire_api"] = value("responses");
    provider["requires_openai_auth"] = value(false);
    provider["experimental_bearer_token"] = value(&connection.api_key);
    provider["supports_websockets"] = value(false);
    config["model_providers"]["orgii"] = Item::Table(provider);
    config["model_provider"] = value("orgii");
    config["model"] = value(&connection.model);
    // auth.json, the OS credential store, other providers and profiles remain untouched.
    Ok(config.to_string())
}
