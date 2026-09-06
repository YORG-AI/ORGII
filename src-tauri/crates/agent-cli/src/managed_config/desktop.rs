//! Claude Desktop's local third-party inference profile. This is a configuration
//! target only: Desktop is never registered as an executable CLI agent.
use super::{direct::DirectConnection, dto::CliConfigProfileManifest};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

pub const TARGET: &str = "claude_desktop";
const PROFILE_ID: &str = "01704638-8000-4000-8000-000000000002";

pub fn supported() -> bool {
    cfg!(any(target_os = "macos", windows))
}

pub(super) fn targets() -> Result<Vec<(&'static str, String, PathBuf)>, String> {
    if !supported() {
        return Err("Claude Desktop connections currently support macOS and Windows".into());
    }
    let root = app_paths::external_history_data_local_dir();
    let library = root.join("Claude-3p/configLibrary");
    Ok(vec![
        (
            "desktop",
            "desktop.json".into(),
            root.join("Claude/claude_desktop_config.json"),
        ),
        (
            "third_party",
            "third-party.json".into(),
            root.join("Claude-3p/claude_desktop_config.json"),
        ),
        (
            "profile",
            "profile.json".into(),
            library.join(format!("{PROFILE_ID}.json")),
        ),
        ("catalog", "catalog.json".into(), library.join("_meta.json")),
    ])
}

/// Do not claim a local profile can override administrator policy. Read-only
/// detection is conservative; no system preferences or registry values are written.
pub fn ensure_unmanaged() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let user = app_paths::external_history_home_dir()
            .file_name()
            .ok_or("Cannot determine the Desktop configuration user")?
            .to_owned();
        let root = PathBuf::from("/Library/Managed Preferences");
        for path in [
            root.join("com.anthropic.claudefordesktop.plist"),
            root.join(user).join("com.anthropic.claudefordesktop.plist"),
        ] {
            if path
                .try_exists()
                .map_err(|_| "Cannot inspect managed Claude Desktop preferences")?
            {
                return Err("Claude Desktop has managed preferences. Use your administrator's configuration; ORGII will not override it.".into());
            }
        }
    }
    #[cfg(windows)]
    {
        use winreg::{
            enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
            RegKey,
        };
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            match RegKey::predef(hive)
                .open_subkey_with_flags(r"SOFTWARE\Policies\Claude", KEY_READ | KEY_WOW64_64KEY)
            {
                Ok(_) => {
                    return Err(
                        "Claude Desktop has managed policy. ORGII will not override it.".into(),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Cannot inspect managed Claude Desktop policy".into()),
            }
        }
    }
    Ok(())
}

fn object(contents: &BTreeMap<String, String>, id: &str) -> Result<Value, String> {
    let raw = contents.get(id).map(String::as_str).unwrap_or("");
    let value = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw).map_err(|_| "Invalid Claude Desktop configuration JSON")?
    };
    if !value.is_object() {
        return Err("Claude Desktop configuration must be a JSON object".into());
    }
    Ok(value)
}

pub fn validate_model(model: &str) -> Result<(), String> {
    let id = model.strip_prefix("anthropic/").unwrap_or(model);
    if [
        "claude-sonnet-",
        "claude-opus-",
        "claude-haiku-",
        "claude-fable-",
    ]
    .iter()
    .any(|prefix| {
        id.strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
    }) && model
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._/".contains(&byte))
    {
        Ok(())
    } else {
        Err("Desktop direct connections require a full Claude Sonnet, Opus, Haiku or Fable model ID. For other IDs, use a model mapping profile in App connections.".into())
    }
}

pub(super) fn generate(
    contents: &BTreeMap<String, String>,
    connection: &DirectConnection,
    previous: Option<&CliConfigProfileManifest>,
) -> Result<BTreeMap<String, String>, String> {
    if let Some(profile) = &connection.profile {
        profile.validate()?;
    } else {
        validate_model(&connection.model)?;
    }
    let owned = previous.is_some_and(|manifest| manifest.mode != super::CliConfigMode::Default);
    if !owned
        && contents
            .get("profile")
            .is_some_and(|raw| !raw.trim().is_empty())
    {
        return Err("An existing Claude Desktop profile uses ORGII's profile ID. Resolve that conflict before switching.".into());
    }
    let options = connection
        .desktop_auth_scheme
        .as_deref()
        .ok_or("Desktop connection settings are required")?;
    if !matches!(options, "bearer" | "x-api-key") {
        return Err("Unsupported Desktop authentication scheme".into());
    }
    let mut generated = BTreeMap::new();
    for id in ["desktop", "third_party"] {
        let mut value = object(contents, id)?;
        if value.get("enterpriseConfig").is_some() {
            return Err("Claude Desktop has inline enterprise configuration. Resolve it in Desktop before switching.".into());
        }
        value["deploymentMode"] = json!("3p");
        generated.insert(id.into(), value);
    }
    let mut catalog = object(contents, "catalog")?;
    let mut entries = match catalog.get("entries") {
        Some(value) => value
            .as_array()
            .ok_or("Invalid Claude Desktop profile catalog")?
            .clone(),
        None => Vec::new(),
    };
    if !owned && entries.iter().any(|entry| entry["id"] == PROFILE_ID) {
        return Err("An existing Claude Desktop catalog entry uses ORGII's profile ID".into());
    }
    entries.retain(|entry| entry["id"] != PROFILE_ID);
    entries.push(json!({"id": PROFILE_ID, "name": "ORGII"}));
    catalog["entries"] = json!(entries);
    catalog["appliedId"] = json!(PROFILE_ID);
    generated.insert("catalog".into(), catalog);
    generated.insert(
        "profile".into(),
        json!({
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": connection.base_url,
            "inferenceGatewayApiKey": connection.api_key,
            "inferenceGatewayAuthScheme": options,
            "inferenceModels": connection.profile.as_ref().map(|p| p.models.claude().map(|m| m.desktop_catalog())).transpose()?.unwrap_or_else(|| vec![json!({"name": connection.model})]),
            "modelDiscoveryEnabled": false
        }),
    );
    generated
        .into_iter()
        .map(|(id, value)| {
            serde_json::to_string_pretty(&value)
                .map(|raw| (id, raw))
                .map_err(|_| "Cannot serialize Claude Desktop configuration".into())
        })
        .collect()
}
