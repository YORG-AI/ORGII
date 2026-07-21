//! OpenCode managed capture: OpenCode has no JSON hook config, so capture is a
//! managed JS plugin FILE under its XDG config dir that pipes provenance JSON
//! to this binary.

use std::path::{Path, PathBuf};

use super::config::{write_atomic, HOOK_MARKER};

// The managed OpenCode plugin file. `__ORGII_BINARY__` is replaced with the
// JS-escaped absolute ORGII executable path at install time. The marker string
// (`HOOK_MARKER`) must appear so the installer can recognize its own file.
pub(super) const OPENCODE_PLUGIN_TEMPLATE: &str =
    include_str!("session_provenance_opencode_plugin.js");

/// Absolute path of the managed OpenCode plugin file
/// (`$XDG_CONFIG_HOME/opencode/plugin/orgii-session-provenance.js`, defaulting
/// to `~/.config`).
pub(super) fn opencode_plugin_path() -> PathBuf {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| app_paths::home_dir().join(".config"));
    config_home
        .join("opencode")
        .join("plugin")
        .join("orgii-session-provenance.js")
}

/// Escape a filesystem path for embedding inside a JS double-quoted string
/// literal (backslashes and quotes). Windows paths carry backslashes.
pub(super) fn js_escaped_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// True only if `path` is our managed OpenCode plugin (contains [`HOOK_MARKER`]),
/// so uninstall never deletes a user-authored plugin that happens to share the
/// filename.
pub(super) fn opencode_plugin_is_managed(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|contents| contents.contains(HOOK_MARKER))
        .unwrap_or(false)
}

/// Install/remove the managed OpenCode plugin file. OpenCode has no JSON hook
/// config; capture is a JS plugin that pipes provenance JSON to this binary.
pub(super) fn update_opencode_plugin(enabled: bool, executable: &Path) -> Result<(), String> {
    let path = opencode_plugin_path();
    if !enabled {
        if opencode_plugin_is_managed(&path) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!("Failed to remove {}: {err}", path.display()));
                }
            }
        }
        return Ok(());
    }
    let contents =
        OPENCODE_PLUGIN_TEMPLATE.replace("__ORGII_BINARY__", &js_escaped_path(executable));
    write_atomic(&path, contents.as_bytes())
}
