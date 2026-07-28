use super::generators::{selected_model_or_default, upsert_env_file};
use super::proxy::openai_chat_proxy_base_url;
use super::registry::{
    AUTOHAND_AGENT, CLINE_AGENT, CONTINUE_CLI_AGENT, DROID_AGENT, GOOSE_AGENT, HERMES_AGENT,
    KIMI_CLI_AGENT, MISTRAL_VIBE_AGENT, OMP_AGENT, OPENCLAW_AGENT, ORGII_PROVIDER_ID,
    ORGII_PROVIDER_NAME, PI_AGENT, QWEN_CODE_AGENT,
};
use chrono::{SecondsFormat, Utc};

fn parse_json_object(existing_content: &str, label: &str) -> Result<serde_json::Value, String> {
    let config = if existing_content.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(existing_content)
            .map_err(|err| format!("Invalid {label} JSON: {err}"))?
    };
    if !config.is_object() {
        return Err(format!("{label} config must be a JSON object"));
    }
    Ok(config)
}

fn parse_jsonc_object(existing_content: &str, label: &str) -> Result<serde_json::Value, String> {
    let config = if existing_content.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        json5::from_str(existing_content).map_err(|err| format!("Invalid {label} JSONC: {err}"))?
    };
    if !config.is_object() {
        return Err(format!("{label} config must be a JSON object"));
    }
    Ok(config)
}

fn serialize_json(config: &serde_json::Value, label: &str) -> Result<String, String> {
    serde_json::to_string_pretty(config)
        .map(|value| format!("{value}\n"))
        .map_err(|err| format!("{label} JSON serialize error: {err}"))
}

fn json_object_field<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !matches!(root.get(key), Some(serde_json::Value::Object(_))) {
        root.insert(
            key.to_string(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }
    root.get_mut(key)
        .and_then(serde_json::Value::as_object_mut)
        .expect("JSON object field was just initialized")
}

fn parse_yaml_mapping(existing_content: &str, label: &str) -> Result<serde_yaml::Value, String> {
    let config = if existing_content.trim().is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(existing_content)
            .map_err(|err| format!("Invalid {label} YAML: {err}"))?
    };
    if !config.is_mapping() {
        return Err(format!("{label} config must be a YAML mapping"));
    }
    Ok(config)
}

fn yaml_key(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_string())
}

fn yaml_string(value: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(value.to_string())
}

fn yaml_mapping_field<'a>(
    root: &'a mut serde_yaml::Mapping,
    key: &str,
) -> &'a mut serde_yaml::Mapping {
    let key_value = yaml_key(key);
    if !matches!(root.get(&key_value), Some(serde_yaml::Value::Mapping(_))) {
        root.insert(
            key_value.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    root.get_mut(&key_value)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .expect("YAML mapping field was just initialized")
}

fn serialize_yaml(config: &serde_yaml::Value, label: &str) -> Result<String, String> {
    serde_yaml::to_string(config).map_err(|err| format!("{label} YAML serialize error: {err}"))
}

fn parse_toml_table(existing_content: &str, label: &str) -> Result<toml::Value, String> {
    let config = if existing_content.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        toml::from_str(existing_content).map_err(|err| format!("Invalid {label} TOML: {err}"))?
    };
    if !config.is_table() {
        return Err(format!("{label} config must be a TOML table"));
    }
    Ok(config)
}

fn toml_table_field<'a>(
    root: &'a mut toml::map::Map<String, toml::Value>,
    key: &str,
) -> &'a mut toml::map::Map<String, toml::Value> {
    if !matches!(root.get(key), Some(toml::Value::Table(_))) {
        root.insert(key.to_string(), toml::Value::Table(toml::map::Map::new()));
    }
    root.get_mut(key)
        .and_then(toml::Value::as_table_mut)
        .expect("TOML table field was just initialized")
}

fn serialize_toml(config: &toml::Value, label: &str) -> Result<String, String> {
    toml::to_string_pretty(config).map_err(|err| format!("{label} TOML serialize error: {err}"))
}

fn remove_string_from_json_array(
    root: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) {
    if let Some(items) = root.get_mut(key).and_then(serde_json::Value::as_array_mut) {
        items.retain(|item| item.as_str() != Some(value));
    }
}

fn add_string_to_existing_json_array(
    root: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) {
    if let Some(items) = root.get_mut(key).and_then(serde_json::Value::as_array_mut) {
        if !items.iter().any(|item| item.as_str() == Some(value)) {
            items.push(serde_json::Value::String(value.to_string()));
        }
    }
}

pub(super) fn generate_open_code_family_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
    agent_name: &str,
    label: &str,
    allow_jsonc: bool,
) -> Result<String, String> {
    let mut config = if allow_jsonc {
        parse_jsonc_object(existing_content, label)?
    } else {
        parse_json_object(existing_content, label)?
    };
    let root = config
        .as_object_mut()
        .expect("validated OpenCode-family JSON object");

    remove_string_from_json_array(root, "disabled_providers", ORGII_PROVIDER_ID);
    add_string_to_existing_json_array(root, "enabled_providers", ORGII_PROVIDER_ID);

    let model = selected_model_or_default(selected_model);
    let mut models = serde_json::Map::new();
    models.insert(model.to_string(), serde_json::json!({}));
    json_object_field(root, "provider").insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": ORGII_PROVIDER_NAME,
            "options": {
                "baseURL": openai_chat_proxy_base_url(proxy_url, agent_name, proxy_token),
                "apiKey": proxy_token,
            },
            "models": models,
        }),
    );

    let model_ref = format!("{ORGII_PROVIDER_ID}/{model}");
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model_ref.clone()),
    );
    root.insert(
        "small_model".to_string(),
        serde_json::Value::String(model_ref),
    );

    serialize_json(&config, label)
}

pub(super) fn generate_kimi_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_toml_table(existing_content, "Kimi CLI")?;
    let root = config.as_table_mut().expect("validated Kimi TOML table");
    let model = selected_model_or_default(selected_model);
    let model_ref = format!("{ORGII_PROVIDER_ID}/{model}");

    root.insert(
        "default_model".to_string(),
        toml::Value::String(model_ref.clone()),
    );

    let mut provider = toml::map::Map::new();
    provider.insert(
        "type".to_string(),
        toml::Value::String("openai".to_string()),
    );
    provider.insert(
        "base_url".to_string(),
        toml::Value::String(openai_chat_proxy_base_url(
            proxy_url,
            KIMI_CLI_AGENT,
            proxy_token,
        )),
    );
    provider.insert(
        "api_key".to_string(),
        toml::Value::String(proxy_token.to_string()),
    );
    toml_table_field(root, "providers")
        .insert(ORGII_PROVIDER_ID.to_string(), toml::Value::Table(provider));

    let mut model_config = toml::map::Map::new();
    model_config.insert(
        "provider".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );
    model_config.insert("model".to_string(), toml::Value::String(model.to_string()));
    model_config.insert(
        "max_context_size".to_string(),
        toml::Value::Integer(131_072),
    );
    toml_table_field(root, "models").insert(model_ref, toml::Value::Table(model_config));

    serialize_toml(&config, "Kimi CLI")
}

pub(super) fn generate_goose_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "Goose")?;
    let root = config
        .as_mapping_mut()
        .expect("validated Goose YAML mapping");
    let model = selected_model_or_default(selected_model);

    root.insert(
        yaml_key("GOOSE_DISABLE_KEYRING"),
        serde_yaml::Value::Bool(true),
    );
    root.insert(yaml_key("active_provider"), yaml_string("openai"));
    root.insert(yaml_key("GOOSE_PROVIDER"), yaml_string("openai"));
    root.insert(yaml_key("GOOSE_MODEL"), yaml_string(model));
    root.insert(
        yaml_key("OPENAI_BASE_URL"),
        yaml_string(&openai_chat_proxy_base_url(
            proxy_url,
            GOOSE_AGENT,
            proxy_token,
        )),
    );

    let mut openai = serde_yaml::Mapping::new();
    openai.insert(yaml_key("enabled"), serde_yaml::Value::Bool(true));
    openai.insert(yaml_key("model"), yaml_string(model));
    openai.insert(yaml_key("configured"), serde_yaml::Value::Bool(true));
    yaml_mapping_field(root, "providers")
        .insert(yaml_key("openai"), serde_yaml::Value::Mapping(openai));

    serialize_yaml(&config, "Goose")
}

pub(super) fn generate_goose_secrets(
    existing_content: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "Goose secrets")?;
    config
        .as_mapping_mut()
        .expect("validated Goose secrets mapping")
        .insert(yaml_key("OPENAI_API_KEY"), yaml_string(proxy_token));
    serialize_yaml(&config, "Goose secrets")
}

pub(super) fn generate_cline_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Cline providers")?;
    let root = config
        .as_object_mut()
        .expect("validated Cline providers object");
    root.insert("version".to_string(), serde_json::json!(1));
    root.insert(
        "lastUsedProvider".to_string(),
        serde_json::Value::String(ORGII_PROVIDER_ID.to_string()),
    );

    let providers = json_object_field(root, "providers");
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let model = selected_model_or_default(selected_model);
    providers.insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::json!({
            "settings": {
                "provider": ORGII_PROVIDER_ID,
                "baseUrl": openai_chat_proxy_base_url(proxy_url, CLINE_AGENT, proxy_token),
                "model": model,
                "apiKey": proxy_token,
                "protocol": "openai-chat",
                "client": "openai-compatible",
                "capabilities": ["streaming", "tools"],
            },
            "updatedAt": updated_at,
            "tokenSource": "manual",
        }),
    );

    serialize_json(&config, "Cline providers")
}

pub(super) fn generate_hermes_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "Hermes")?;
    let root = config
        .as_mapping_mut()
        .expect("validated Hermes YAML mapping");
    let model = selected_model_or_default(selected_model);
    let model_config = yaml_mapping_field(root, "model");
    model_config.insert(yaml_key("default"), yaml_string(model));
    model_config.insert(yaml_key("provider"), yaml_string("custom"));
    model_config.insert(
        yaml_key("base_url"),
        yaml_string(&openai_chat_proxy_base_url(
            proxy_url,
            HERMES_AGENT,
            proxy_token,
        )),
    );
    model_config.insert(yaml_key("api_key"), yaml_string(proxy_token));
    serialize_yaml(&config, "Hermes")
}

pub(super) fn generate_openclaw_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_jsonc_object(existing_content, "OpenClaw")?;
    let root = config
        .as_object_mut()
        .expect("validated OpenClaw JSON object");
    let model = selected_model_or_default(selected_model);
    let model_ref = format!("{ORGII_PROVIDER_ID}/{model}");

    let agents = json_object_field(root, "agents");
    let defaults = json_object_field(agents, "defaults");
    json_object_field(defaults, "model").insert(
        "primary".to_string(),
        serde_json::Value::String(model_ref.clone()),
    );
    json_object_field(defaults, "models").insert(model_ref, serde_json::json!({}));

    let models = json_object_field(root, "models");
    models.insert(
        "mode".to_string(),
        serde_json::Value::String("merge".to_string()),
    );
    json_object_field(models, "providers").insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::json!({
            "baseUrl": openai_chat_proxy_base_url(proxy_url, OPENCLAW_AGENT, proxy_token),
            "apiKey": proxy_token,
            "api": "openai-completions",
            "models": [{
                "id": model,
                "name": model,
                "reasoning": false,
                "input": ["text"],
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                "contextWindow": 128000,
                "maxTokens": 16384,
            }],
        }),
    );

    serialize_json(&config, "OpenClaw")
}

pub(super) fn generate_qwen_code_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Qwen Code")?;
    let root = config
        .as_object_mut()
        .expect("validated Qwen Code JSON object");
    let model = selected_model_or_default(selected_model);

    json_object_field(root, "env").insert(
        "ORGII_API_KEY".to_string(),
        serde_json::Value::String(proxy_token.to_string()),
    );
    json_object_field(root, "modelProviders").insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::json!([{
            "id": model,
            "name": model,
            "envKey": "ORGII_API_KEY",
            "baseUrl": openai_chat_proxy_base_url(proxy_url, QWEN_CODE_AGENT, proxy_token),
        }]),
    );
    json_object_field(root, "providerProtocol").insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::Value::String("openai".to_string()),
    );
    json_object_field(root, "model").insert(
        "name".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    let security = json_object_field(root, "security");
    json_object_field(security, "auth").insert(
        "selectedType".to_string(),
        serde_json::Value::String(ORGII_PROVIDER_ID.to_string()),
    );

    serialize_json(&config, "Qwen Code")
}

pub(super) fn generate_continue_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "Continue")?;
    let root = config
        .as_mapping_mut()
        .expect("validated Continue YAML mapping");
    let model = selected_model_or_default(selected_model);

    root.entry(yaml_key("name"))
        .or_insert_with(|| yaml_string("ORGII Managed"));
    root.entry(yaml_key("version"))
        .or_insert_with(|| yaml_string("1.0.0"));

    let models_key = yaml_key("models");
    if !matches!(root.get(&models_key), Some(serde_yaml::Value::Sequence(_))) {
        root.insert(models_key.clone(), serde_yaml::Value::Sequence(Vec::new()));
    }
    let models = root
        .get_mut(&models_key)
        .and_then(serde_yaml::Value::as_sequence_mut)
        .expect("Continue models sequence was just initialized");
    models.retain(|entry| entry.get("name").and_then(serde_yaml::Value::as_str) != Some("ORGII"));

    let mut orgii_model = serde_yaml::Mapping::new();
    orgii_model.insert(yaml_key("name"), yaml_string("ORGII"));
    orgii_model.insert(yaml_key("provider"), yaml_string("openai"));
    orgii_model.insert(yaml_key("model"), yaml_string(model));
    orgii_model.insert(yaml_key("apiKey"), yaml_string(proxy_token));
    orgii_model.insert(
        yaml_key("apiBase"),
        yaml_string(&openai_chat_proxy_base_url(
            proxy_url,
            CONTINUE_CLI_AGENT,
            proxy_token,
        )),
    );
    orgii_model.insert(
        yaml_key("roles"),
        serde_yaml::Value::Sequence(
            ["chat", "edit", "summarize", "subagent"]
                .into_iter()
                .map(yaml_string)
                .collect(),
        ),
    );
    models.insert(0, serde_yaml::Value::Mapping(orgii_model));

    serialize_yaml(&config, "Continue")
}

pub(super) fn generate_droid_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Droid")?;
    let root = config.as_object_mut().expect("validated Droid JSON object");
    let model = selected_model_or_default(selected_model);
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );

    if !matches!(root.get("customModels"), Some(serde_json::Value::Array(_))) {
        root.insert(
            "customModels".to_string(),
            serde_json::Value::Array(Vec::new()),
        );
    }
    let models = root
        .get_mut("customModels")
        .and_then(serde_json::Value::as_array_mut)
        .expect("Droid customModels was just initialized");
    models.retain(|entry| {
        entry.get("displayName").and_then(serde_json::Value::as_str) != Some("ORGII")
    });
    models.insert(
        0,
        serde_json::json!({
            "model": model,
            "displayName": "ORGII",
            "baseUrl": openai_chat_proxy_base_url(proxy_url, DROID_AGENT, proxy_token),
            "apiKey": proxy_token,
            "provider": "generic-chat-completion-api",
            "maxOutputTokens": 16384,
        }),
    );

    serialize_json(&config, "Droid")
}

pub(super) fn generate_mistral_vibe_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_toml_table(existing_content, "Mistral Vibe")?;
    let root = config
        .as_table_mut()
        .expect("validated Mistral Vibe TOML table");
    let model = selected_model_or_default(selected_model);

    root.insert(
        "active_model".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );

    let mut provider = toml::map::Map::new();
    provider.insert(
        "name".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );
    provider.insert(
        "api_base".to_string(),
        toml::Value::String(openai_chat_proxy_base_url(
            proxy_url,
            MISTRAL_VIBE_AGENT,
            proxy_token,
        )),
    );
    provider.insert(
        "api_key_env_var".to_string(),
        toml::Value::String("ORGII_API_KEY".to_string()),
    );
    provider.insert(
        "api_style".to_string(),
        toml::Value::String("openai".to_string()),
    );
    provider.insert(
        "backend".to_string(),
        toml::Value::String("generic".to_string()),
    );

    let providers = root
        .entry("providers".to_string())
        .or_insert_with(|| toml::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Mistral Vibe providers must be a TOML array".to_string())?;
    providers
        .retain(|entry| entry.get("name").and_then(toml::Value::as_str) != Some(ORGII_PROVIDER_ID));
    providers.insert(0, toml::Value::Table(provider));

    let mut model_config = toml::map::Map::new();
    model_config.insert("name".to_string(), toml::Value::String(model.to_string()));
    model_config.insert(
        "provider".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );
    model_config.insert(
        "alias".to_string(),
        toml::Value::String(ORGII_PROVIDER_ID.to_string()),
    );
    let models = root
        .entry("models".to_string())
        .or_insert_with(|| toml::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Mistral Vibe models must be a TOML array".to_string())?;
    models.retain(|entry| {
        entry.get("alias").and_then(toml::Value::as_str) != Some(ORGII_PROVIDER_ID)
    });
    models.insert(0, toml::Value::Table(model_config));

    serialize_toml(&config, "Mistral Vibe")
}

pub(super) fn generate_mistral_vibe_env(existing_content: &str, proxy_token: &str) -> String {
    upsert_env_file(
        existing_content,
        &[("ORGII_API_KEY", proxy_token.to_string())],
    )
}

pub(super) fn generate_autohand_managed_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Autohand")?;
    let root = config
        .as_object_mut()
        .expect("validated Autohand JSON object");
    let model = selected_model_or_default(selected_model);
    root.insert(
        "provider".to_string(),
        serde_json::Value::String("openai".to_string()),
    );
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    let openai = json_object_field(root, "openai");
    openai.insert(
        "apiKey".to_string(),
        serde_json::Value::String(proxy_token.to_string()),
    );
    openai.insert(
        "baseUrl".to_string(),
        serde_json::Value::String(openai_chat_proxy_base_url(
            proxy_url,
            AUTOHAND_AGENT,
            proxy_token,
        )),
    );
    openai.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    serialize_json(&config, "Autohand")
}

fn openai_provider_yaml(
    agent_name: &str,
    model: &str,
    proxy_url: &str,
    proxy_token: &str,
) -> serde_yaml::Value {
    let mut provider = serde_yaml::Mapping::new();
    provider.insert(
        yaml_key("baseUrl"),
        yaml_string(&openai_chat_proxy_base_url(
            proxy_url,
            agent_name,
            proxy_token,
        )),
    );
    provider.insert(yaml_key("apiKey"), yaml_string(proxy_token));
    provider.insert(yaml_key("api"), yaml_string("openai-completions"));
    provider.insert(yaml_key("authHeader"), serde_yaml::Value::Bool(true));
    provider.insert(
        yaml_key("models"),
        serde_yaml::Value::Sequence(vec![serde_yaml::to_value(serde_json::json!({
            "id": model,
            "name": model,
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 16384,
        }))
        .expect("static model metadata serializes to YAML")]),
    );
    serde_yaml::Value::Mapping(provider)
}

pub(super) fn generate_omp_models_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "OMP models")?;
    let root = config
        .as_mapping_mut()
        .expect("validated OMP models YAML mapping");
    let model = selected_model_or_default(selected_model);
    yaml_mapping_field(root, "providers").insert(
        yaml_key(ORGII_PROVIDER_ID),
        openai_provider_yaml(OMP_AGENT, model, proxy_url, proxy_token),
    );
    serialize_yaml(&config, "OMP models")
}

pub(super) fn generate_omp_settings_config(
    existing_content: &str,
    selected_model: Option<&str>,
) -> Result<String, String> {
    let mut config = parse_yaml_mapping(existing_content, "OMP settings")?;
    let root = config
        .as_mapping_mut()
        .expect("validated OMP settings YAML mapping");
    let model_ref = format!(
        "{ORGII_PROVIDER_ID}/{}",
        selected_model_or_default(selected_model)
    );
    let roles = yaml_mapping_field(root, "modelRoles");
    for role in ["default", "smol", "slow", "plan", "commit"] {
        roles.insert(yaml_key(role), yaml_string(&model_ref));
    }
    root.insert(
        yaml_key("enabledModels"),
        serde_yaml::Value::Sequence(vec![yaml_string(&model_ref)]),
    );
    serialize_yaml(&config, "OMP settings")
}

pub(super) fn generate_pi_models_config(
    existing_content: &str,
    selected_model: Option<&str>,
    proxy_url: &str,
    proxy_token: &str,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Pi models")?;
    let root = config
        .as_object_mut()
        .expect("validated Pi models JSON object");
    let model = selected_model_or_default(selected_model);
    json_object_field(root, "providers").insert(
        ORGII_PROVIDER_ID.to_string(),
        serde_json::json!({
            "baseUrl": openai_chat_proxy_base_url(proxy_url, PI_AGENT, proxy_token),
            "apiKey": proxy_token,
            "api": "openai-completions",
            "authHeader": true,
            "models": [{
                "id": model,
                "name": model,
                "reasoning": false,
                "input": ["text"],
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                "contextWindow": 128000,
                "maxTokens": 16384,
            }],
        }),
    );
    serialize_json(&config, "Pi models")
}

pub(super) fn generate_pi_settings_config(
    existing_content: &str,
    selected_model: Option<&str>,
) -> Result<String, String> {
    let mut config = parse_json_object(existing_content, "Pi settings")?;
    let root = config
        .as_object_mut()
        .expect("validated Pi settings JSON object");
    let model = selected_model_or_default(selected_model);
    root.insert(
        "defaultProvider".to_string(),
        serde_json::Value::String(ORGII_PROVIDER_ID.to_string()),
    );
    root.insert(
        "defaultModel".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    root.insert(
        "enabledModels".to_string(),
        serde_json::json!([format!("{ORGII_PROVIDER_ID}/{model}")]),
    );
    serialize_json(&config, "Pi settings")
}
