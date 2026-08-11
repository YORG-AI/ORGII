//! LSP/Lint Discovery Commands
//!
//! Tauri commands for detecting installed language servers and lint tools.

use super::cache;
use crate::lint_tools::LintToolInfo;
use crate::server_defs::{servers, servers_for_language_id};

use super::package_manager::detect_install_type;

/// Language server info returned to frontend
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerInfo {
    pub language: String,
    pub display_name: String,
    pub command: String,
    pub install_hint: String,
    pub installed: bool,
    pub uninstall_supported: bool,
}

/// All supported languages with their display names
pub const LANGUAGE_DISPLAY_NAMES: &[(&str, &str)] = &[
    ("typescript", "TypeScript / JavaScript"),
    ("rust", "Rust"),
    ("python", "Python"),
    ("go", "Go"),
    ("c", "C / C++"),
    ("cpp", "C / C++"),
    ("java", "Java"),
    ("csharp", "C#"),
    ("ruby", "Ruby"),
    ("php", "PHP"),
    ("swift", "Swift"),
    ("kotlin", "Kotlin"),
    ("scala", "Scala"),
    ("lua", "Lua"),
    ("haskell", "Haskell"),
    ("ocaml", "OCaml"),
    ("elixir", "Elixir"),
    ("clojure", "Clojure"),
    ("html", "HTML"),
    ("css", "CSS / SCSS"),
    ("json", "JSON"),
    ("yaml", "YAML"),
    ("markdown", "Markdown"),
    ("shellscript", "Shell / Bash"),
    ("dockerfile", "Dockerfile"),
    ("sql", "SQL"),
    ("vue", "Vue"),
    ("svelte", "Svelte"),
    ("zig", "Zig"),
];

pub use crate::command_detection::command_exists;

/// Check if uninstall is supported based on install hint
fn is_uninstall_supported(install_hint: &str) -> bool {
    let install_type = detect_install_type(install_hint);
    // These package managers support uninstall
    matches!(
        install_type,
        "npm" | "pip" | "cargo" | "rustup" | "gem" | "brew" | "ghcup" | "opam"
    )
    // Notably NOT supported: "go", "unknown"
}

/// Check which language servers are installed on the system
/// Returns full info including display names (single source of truth)
#[tauri::command]
pub async fn lsp_check_installed() -> Vec<LanguageServerInfo> {
    tokio::task::spawn_blocking(|| {
        let result: Vec<LanguageServerInfo> = LANGUAGE_DISPLAY_NAMES
            .iter()
            .filter_map(|(lang, display_name)| {
                let server_def = *servers_for_language_id(lang).first()?;
                let install_hint = server_def.install_hint();
                let command = server_def.binary_name();
                let installed = command_exists(command);
                let uninstall_supported = is_uninstall_supported(&install_hint);
                Some(LanguageServerInfo {
                    language: lang.to_string(),
                    display_name: display_name.to_string(),
                    command: command.to_string(),
                    install_hint,
                    installed,
                    uninstall_supported,
                })
            })
            .collect();

        cache::save_lsp(&result);
        result
    })
    .await
    .unwrap_or_default()
}

/// Check which lint tools are installed on the system
#[tauri::command]
pub async fn lint_check_installed() -> Vec<LintToolInfo> {
    tokio::task::spawn_blocking(|| {
        let result = crate::lint_tools::check_lint_tools();
        cache::save_lint(&result);
        result
    })
    .await
    .unwrap_or_default()
}

/// Return cached LSP servers if fresh, otherwise empty (caller should fetch fresh).
#[tauri::command]
pub fn lsp_get_cached() -> Vec<LanguageServerInfo> {
    cache::load_lsp().unwrap_or_default()
}

/// Return cached lint tools if fresh, otherwise empty (caller should fetch fresh).
#[tauri::command]
pub fn lint_get_cached() -> Vec<LintToolInfo> {
    cache::load_lint().unwrap_or_default()
}

/// Get list of supported languages with install hints.
///
/// Each entry is `(language_id, install_hint)`. A server that handles multiple
/// language IDs (e.g. typescript-language-server handles both `typescript` and
/// `javascript`) emits one entry per language ID, all sharing the same hint.
#[tauri::command]
pub fn lsp_get_supported_languages() -> Vec<(String, String)> {
    servers::STATIC_SERVERS
        .iter()
        .flat_map(|server_def| {
            let hint = server_def.install_hint();
            server_def
                .language_ids()
                .iter()
                .map(move |lang| (lang.to_string(), hint.clone()))
        })
        .collect()
}
