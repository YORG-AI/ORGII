//! ZCode managed capture: ZCode bundles hooks inside plugins, so ORGII ships a
//! tiny managed plugin under its own filesystem marketplace (manifest +
//! `hooks/hooks.json` + activation dir), registers it in
//! `installed_plugins.json`, and flips it on in `config.json` — never touching
//! ZCode's official plugin files.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::config::{hook_commands, read_config, write_atomic, write_config, HOOK_MARKER};

// ZCode's tool names are not enumerated publicly; match all and let the adapter
// drop non-file tools.
pub(super) const ZCODE_POST_TOOL_USE_MATCHER: &str = ".*";
pub(super) const ZCODE_PLUGIN_MARKETPLACE: &str = "orgii";
pub(super) const ZCODE_PLUGIN_NAME: &str = "session-provenance";
const ZCODE_PLUGIN_VERSION: &str = "0.1.0";

/// Root of ZCode's filesystem plugin store (`~/.zcode/cli/plugins`).
fn zcode_plugins_root() -> PathBuf {
    app_paths::home_dir()
        .join(".zcode")
        .join("cli")
        .join("plugins")
}

fn zcode_plugin_cache_dir() -> PathBuf {
    zcode_plugins_root()
        .join("cache")
        .join(ZCODE_PLUGIN_MARKETPLACE)
        .join(ZCODE_PLUGIN_NAME)
        .join(ZCODE_PLUGIN_VERSION)
}

pub(super) fn zcode_plugin_hooks_path() -> PathBuf {
    zcode_plugin_cache_dir().join("hooks").join("hooks.json")
}

/// Empty marker directory whose presence enables the plugin.
pub(super) fn zcode_plugin_data_dir() -> PathBuf {
    zcode_plugins_root()
        .join("data")
        .join(format!("{ZCODE_PLUGIN_NAME}@{ZCODE_PLUGIN_MARKETPLACE}"))
}

fn zcode_marketplace_dir() -> PathBuf {
    zcode_plugins_root()
        .join("marketplaces")
        .join(ZCODE_PLUGIN_MARKETPLACE)
}

/// The Claude-Code-style `hooks/hooks.json` body for ORGII's ZCode plugin.
pub(super) fn zcode_hooks_value(command: &str) -> Value {
    json!({
        "hooks": {
            "PostToolUse": [{
                "matcher": ZCODE_POST_TOOL_USE_MATCHER,
                "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
            }]
        }
    })
}

/// ZCode's installed-plugin registry: `~/.zcode/cli/plugins/installed_plugins.json`.
///
/// ZCode discovers installed plugins from this registry, not by scanning the
/// cache tree. A plugin absent from here is invisible to ZCode even when its
/// cache/marketplace/data files are all on disk, so the startup log reports
/// `pluginCount` without it and `hookCount: 0`. Entries are keyed by plugin id
/// (`<name>@<marketplace>`).
fn zcode_installed_plugins_path() -> PathBuf {
    zcode_plugins_root().join("installed_plugins.json")
}

/// Register (or update) our plugin in ZCode's `installed_plugins.json`, writing
/// `plugins["session-provenance@orgii"]` with the install path and version.
/// Other plugins' entries are preserved.
fn zcode_set_plugin_installed(cache_path: &Path) -> Result<(), String> {
    let path = zcode_installed_plugins_path();
    let mut config = read_config(&path)?;
    zcode_add_plugin_to_registry(&mut config, cache_path);
    write_atomic(
        &path,
        &serde_json::to_vec_pretty(&config)
            .map_err(|err| format!("Failed to serialize installed_plugins.json: {err}"))?,
    )
}

/// Pure transform: add/replace our plugin's registry entry in a config value.
pub(super) fn zcode_add_plugin_to_registry(config: &mut Value, cache_path: &Path) {
    let root = match config.as_object_mut() {
        Some(root) => root,
        None => {
            tracing::warn!(
                "[SessionProvenance] installed_plugins.json root is not an object; skipping registry write"
            );
            return;
        }
    };
    if root.get("version").is_none() {
        root.insert("version".to_string(), json!(1));
    }
    let plugins = root
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(map) = plugins.as_object_mut() {
        map.insert(
            zcode_plugin_id().to_string(),
            json!({
                "installPath": cache_path.to_string_lossy(),
                "version": ZCODE_PLUGIN_VERSION,
                "installedAt": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "scope": "user",
            }),
        );
    }
}

/// Pure check: does this registry value contain our plugin?
pub(super) fn zcode_registry_has_plugin(config: &Value) -> bool {
    config
        .get("plugins")
        .and_then(|plugins| plugins.get(zcode_plugin_id()))
        .is_some()
}

/// Pure transform: remove our plugin's entry from a registry value.
pub(super) fn zcode_remove_plugin_from_registry_value(config: &mut Value) {
    if let Some(map) = config.get_mut("plugins").and_then(Value::as_object_mut) {
        map.remove(zcode_plugin_id());
    }
}

/// Remove our plugin from ZCode's `installed_plugins.json`. Other entries and
/// the file itself are left untouched.
fn zcode_remove_plugin_from_registry() -> Result<(), String> {
    let path = zcode_installed_plugins_path();
    if !path.exists() {
        return Ok(());
    }
    let mut config = read_config(&path)?;
    let removed = zcode_registry_has_plugin(&config);
    if removed {
        zcode_remove_plugin_from_registry_value(&mut config);
        write_atomic(
            &path,
            &serde_json::to_vec_pretty(&config)
                .map_err(|err| format!("Failed to serialize installed_plugins.json: {err}"))?,
        )?;
    }
    Ok(())
}

/// ZCode's user config file: `~/.zcode/cli/config.json`.
///
/// ZCode persists per-plugin enablement here under
/// `plugins.enabledPlugins[<id>]`. A plugin is only active when its id maps to
/// `true`; the default is `false`, so installing the cache/marketplace/data
/// files alone is not enough — the config entry must be set too.
pub(super) fn zcode_config_path() -> PathBuf {
    app_paths::home_dir()
        .join(".zcode")
        .join("cli")
        .join("config.json")
}

/// The plugin id ZCode uses for our managed plugin: `<name>@<marketplace>`.
pub(super) const fn zcode_plugin_id() -> &'static str {
    // `format!` is not const, so inline the two known constants.
    // Keep in sync with ZCODE_PLUGIN_NAME and ZCODE_PLUGIN_MARKETPLACE.
    "session-provenance@orgii"
}

/// Read ZCode's `config.json`, returning an empty object when missing or
/// unparseable (mirrors ZCode's own tolerant `readJsonConfigFileOrEmpty`).
fn read_zcode_config() -> Value {
    let path = zcode_config_path();
    read_config(&path).unwrap_or_else(|err| {
        tracing::warn!(
            path = %path.display(),
            error = %err,
            "[SessionProvenance] Failed to read ZCode config.json; treating as empty"
        );
        Value::Object(Map::new())
    })
}

/// True if ZCode's config.json marks our plugin as enabled.
fn zcode_plugin_is_enabled_in_config() -> bool {
    zcode_plugin_is_enabled_in(&read_zcode_config())
}

/// Pure check: does this ZCode config value mark our plugin enabled?
pub(super) fn zcode_plugin_is_enabled_in(config: &Value) -> bool {
    config
        .get("plugins")
        .and_then(|plugins| plugins.get("enabledPlugins"))
        .and_then(|map| map.get(zcode_plugin_id()))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Set our plugin's enablement in ZCode's `config.json`.
///
/// Writes `plugins.enabledPlugins["session-provenance@orgii"] = enabled` with an
/// atomic temp+rename, preserving every other key the user may have. Creates the
/// file (and its parent) when it does not yet exist.
fn zcode_set_plugin_enabled(enabled: bool) -> Result<(), String> {
    zcode_set_plugin_enabled_at(&zcode_config_path(), enabled)
}

/// Path-based core of [`zcode_set_plugin_enabled`], separated so it can be tested
/// without mutating the process-global `HOME`.
pub(super) fn zcode_set_plugin_enabled_at(path: &Path, enabled: bool) -> Result<(), String> {
    let mut config = read_config(path)?;
    set_plugin_enabled_in_config(&mut config, enabled)?;
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|err| format!("Failed to serialize ZCode config.json: {err}"))?;
    write_atomic(path, &bytes)
}

/// Pure transform: set our plugin's enablement flag in a ZCode config value.
pub(super) fn set_plugin_enabled_in_config(
    config: &mut Value,
    enabled: bool,
) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json root must be a JSON object".to_string())?;
    let plugins = root
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let enabled_plugins = plugins
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json `plugins` must be a JSON object".to_string())?
        .entry("enabledPlugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    enabled_plugins
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json `enabledPlugins` must be a JSON object".to_string())?
        .insert(zcode_plugin_id().to_string(), Value::Bool(enabled));
    Ok(())
}

/// True if our plugin is registered in ZCode's `installed_plugins.json`.
fn zcode_plugin_is_in_registry() -> bool {
    read_config(&zcode_installed_plugins_path())
        .map(|config| {
            config
                .get("plugins")
                .and_then(|plugins| plugins.get(zcode_plugin_id()))
                .is_some()
        })
        .unwrap_or(false)
}

/// True if ORGII's managed ZCode plugin is installed AND enabled. ZCode only
/// resolves a plugin when it is in `installed_plugins.json`, and only loads its
/// hooks when it is marked enabled in `config.json` — so all three conditions
/// must hold for capture to fire.
pub(super) fn zcode_plugin_is_managed() -> bool {
    zcode_plugin_data_dir().is_dir()
        && std::fs::read_to_string(zcode_plugin_hooks_path())
            .map(|contents| contents.contains(HOOK_MARKER))
            .unwrap_or(false)
        && zcode_plugin_is_in_registry()
        && zcode_plugin_is_enabled_in_config()
}

/// Install/remove ORGII's managed ZCode plugin. ZCode resolves plugins from the
/// filesystem (`~/.zcode/cli/plugins`) at startup, so a self-contained plugin
/// under ORGII's own `orgii` marketplace (manifest + `hooks/hooks.json` + an
/// empty `data/<plugin>@<marketplace>` activation dir) is discovered without
/// touching ZCode's official plugin files.
pub(super) fn update_zcode_plugin(enabled: bool, executable: &Path) -> Result<(), String> {
    let cache_dir = zcode_plugin_cache_dir();
    let data_dir = zcode_plugin_data_dir();
    let marketplace_dir = zcode_marketplace_dir();
    if !enabled {
        // Only ever remove ORGII's own `orgii` marketplace tree.
        for dir in [
            data_dir,
            zcode_plugins_root()
                .join("cache")
                .join(ZCODE_PLUGIN_MARKETPLACE),
            marketplace_dir,
        ] {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("Failed to remove {}: {err}", dir.display())),
            }
        }
        // Clear the enablement entry so ZCode stops loading our hooks. Ignore a
        // missing config.json — there is nothing to clean in that case.
        if zcode_config_path().exists() {
            zcode_set_plugin_enabled(false)?;
        }
        // Remove our entry from the installed-plugin registry so ZCode no longer
        // discovers the plugin at all.
        zcode_remove_plugin_from_registry()?;
        return Ok(());
    }
    let (unix_command, windows_command) = hook_commands(executable, "zcode");
    let command = if cfg!(windows) {
        &windows_command
    } else {
        &unix_command
    };
    write_config(
        &cache_dir.join(".zcode-plugin").join("plugin.json"),
        &json!({
            "name": ZCODE_PLUGIN_NAME,
            "version": ZCODE_PLUGIN_VERSION,
            "description": "ORGII session provenance — records file-interaction metadata via a managed hook. Prompts, tool output, and file contents are not stored.",
            "author": { "name": "ORGII" },
            "license": "MIT"
        }),
    )?;
    write_config(&zcode_plugin_hooks_path(), &zcode_hooks_value(command))?;
    write_config(
        &marketplace_dir.join("marketplace.json"),
        &json!({
            "name": ZCODE_PLUGIN_MARKETPLACE,
            "version": 1,
            "plugins": [{
                "cachePath": cache_dir.to_string_lossy(),
                "name": ZCODE_PLUGIN_NAME,
                "source": "filesystem",
                "version": ZCODE_PLUGIN_VERSION
            }]
        }),
    )?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("Failed to create {}: {err}", data_dir.display()))?;
    // ZCode discovers installed plugins from a registry
    // (`installed_plugins.json`), not by scanning the cache tree. Without an
    // entry here the plugin is invisible to ZCode even though all its files are
    // on disk, so the startup log shows hookCount: 0.
    zcode_set_plugin_installed(&cache_dir)?;
    // ZCode only loads hooks from plugins marked enabled in config.json; the
    // cache/marketplace/data files above make it discoverable, this entry makes
    // it active. Without it the startup log shows hookCount: 0.
    zcode_set_plugin_enabled(true)?;
    Ok(())
}
