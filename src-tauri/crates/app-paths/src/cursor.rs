//! Canonical resolver for the Cursor app's own on-disk storage locations.
//!
//! Single source of truth for where the Cursor IDE / CLI keep their data
//! (ORGII only ever reads these locations):
//!
//! - **IDE user data** hangs off the platform config root — macOS
//!   `~/Library/Application Support/Cursor/`, Linux `$XDG_CONFIG_HOME/Cursor/`
//!   (default `~/.config/Cursor/`), Windows `%APPDATA%\Cursor\`.
//! - **CLI / plugin data** lives in the home-anchored dotdir `~/.cursor/` on
//!   every platform.
//!
//! Not to be confused with the ORGII-managed Cursor CLI profile helpers in the
//! crate root (`cursor_config_dir`, `cursor_cli_profile_dir`, ...), which
//! resolve ORGII-owned directories under `~/.orgii/`.
//!
//! ## Identity isolation
//!
//! Every resolver honors the `ORGII_EXTERNAL_HISTORY_HOME` override exactly
//! like the crate root's `external_history_*` family: when the override is
//! set, paths resolve deterministically beneath the override home and the real
//! user's `$HOME` / `$XDG_CONFIG_HOME` / `%APPDATA%` environment is never
//! consulted, so a secondary dev profile cannot discover the primary user's
//! Cursor state.
//!
//! ## Unavailability
//!
//! When neither the override nor a usable home/config root exists, resolvers
//! return [`CursorPathsUnavailable`] instead of fabricating a path. Callers
//! decide how to degrade — for read-only discovery this is equivalent to
//! "Cursor is not installed".

use std::path::{Path, PathBuf};

/// No home / platform-config root exists to anchor Cursor storage paths.
///
/// Practically: `ORGII_EXTERNAL_HISTORY_HOME` is unset, `dirs::home_dir()`
/// failed, and (on Linux/Windows) `$XDG_CONFIG_HOME` / `%APPDATA%` are unset
/// or unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorPathsUnavailable;

impl std::fmt::Display for CursorPathsUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "no home or platform config directory is available to resolve Cursor storage paths",
        )
    }
}

impl std::error::Error for CursorPathsUnavailable {}

// ── Public API (process environment + current platform) ──

/// Cursor IDE's `User/globalStorage` directory for the current platform.
///
/// Does not check existence — callers join a filename and test that.
pub fn global_storage_dir() -> Result<PathBuf, CursorPathsUnavailable> {
    CursorEnv::from_process().global_storage_dir(current_platform())
}

/// Cursor's global key-value store: `<globalStorage>/state.vscdb`.
///
/// Does not check existence.
pub fn state_db_path() -> Result<PathBuf, CursorPathsUnavailable> {
    CursorEnv::from_process().state_db_path(current_platform())
}

/// Cursor's conversation index (newer builds), stored next to `state.vscdb`:
/// `<globalStorage>/conversation-search.db`.
///
/// Does not check existence — older Cursor builds predate this file.
pub fn conversation_index_db_path() -> Result<PathBuf, CursorPathsUnavailable> {
    CursorEnv::from_process().conversation_index_db_path(current_platform())
}

/// Cursor's marketplace plugin cache: `~/.cursor/plugins/cache/cursor-public/`.
///
/// Layout: one `{slug}/{hash}/` directory per downloaded plugin. Does not
/// check existence.
pub fn plugins_cache_dir() -> Result<PathBuf, CursorPathsUnavailable> {
    CursorEnv::from_process().plugins_cache_dir()
}

// ── Pure resolver core ──

/// OS flavor, split from `cfg` blocks so the full platform matrix stays
/// unit-testable on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    MacOs,
    /// Linux plus any other XDG-style unix.
    Linux,
    Windows,
}

fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// Environment inputs that determine Cursor storage roots.
///
/// Production snapshots the process environment once per resolution
/// ([`CursorEnv::from_process`]); tests construct values directly to cover the
/// whole platform matrix. Fields hold already-validated values — env-string
/// filtering lives in [`parse_env_path`].
#[derive(Debug, Clone, Default)]
struct CursorEnv {
    /// `ORGII_EXTERNAL_HISTORY_HOME` identity-isolation override.
    external_history_home: Option<PathBuf>,
    /// Real user home directory (`dirs::home_dir()`).
    home: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` (absolute values only). Consulted on Linux.
    xdg_config_home: Option<PathBuf>,
    /// `%APPDATA%` (absolute values only). Consulted on Windows.
    appdata: Option<PathBuf>,
}

impl CursorEnv {
    fn from_process() -> Self {
        Self {
            external_history_home: crate::external_history_home_override(),
            home: dirs::home_dir(),
            xdg_config_home: env_path("XDG_CONFIG_HOME"),
            appdata: env_path("APPDATA"),
        }
    }

    /// Root that Cursor's Electron shell resolves its `userData` dir against.
    fn config_root(&self, platform: Platform) -> Result<PathBuf, CursorPathsUnavailable> {
        // Isolation override: deterministic per-platform layout beneath the
        // override home; never read the real user's XDG/APPDATA environment
        // (same contract as `external_history_config_dir`).
        if let Some(isolated_home) = &self.external_history_home {
            return Ok(default_config_root_under(platform, isolated_home));
        }
        match platform {
            Platform::Linux => {
                if let Some(xdg_config_home) = &self.xdg_config_home {
                    return Ok(xdg_config_home.clone());
                }
            }
            Platform::Windows => {
                if let Some(appdata) = &self.appdata {
                    return Ok(appdata.clone());
                }
            }
            Platform::MacOs => {}
        }
        let home = self.home.as_deref().ok_or(CursorPathsUnavailable)?;
        Ok(default_config_root_under(platform, home))
    }

    /// Home root anchoring the `~/.cursor` dotdir family.
    fn home_root(&self) -> Result<PathBuf, CursorPathsUnavailable> {
        if let Some(isolated_home) = &self.external_history_home {
            return Ok(isolated_home.clone());
        }
        self.home.clone().ok_or(CursorPathsUnavailable)
    }

    fn global_storage_dir(&self, platform: Platform) -> Result<PathBuf, CursorPathsUnavailable> {
        Ok(self
            .config_root(platform)?
            .join("Cursor")
            .join("User")
            .join("globalStorage"))
    }

    fn state_db_path(&self, platform: Platform) -> Result<PathBuf, CursorPathsUnavailable> {
        Ok(self.global_storage_dir(platform)?.join("state.vscdb"))
    }

    fn conversation_index_db_path(
        &self,
        platform: Platform,
    ) -> Result<PathBuf, CursorPathsUnavailable> {
        Ok(self
            .global_storage_dir(platform)?
            .join("conversation-search.db"))
    }

    fn plugins_cache_dir(&self) -> Result<PathBuf, CursorPathsUnavailable> {
        Ok(self
            .home_root()?
            .join(".cursor")
            .join("plugins")
            .join("cache")
            .join("cursor-public"))
    }
}

/// Default per-platform config root beneath a given home directory — the
/// matrix previously duplicated across `orgtrack_core` and `agent_cli`.
fn default_config_root_under(platform: Platform, home: &Path) -> PathBuf {
    match platform {
        Platform::MacOs => home.join("Library").join("Application Support"),
        Platform::Linux => home.join(".config"),
        Platform::Windows => home.join("AppData").join("Roaming"),
    }
}

fn env_path(var: &str) -> Option<PathBuf> {
    parse_env_path(&std::env::var(var).ok()?)
}

/// Filter for env-provided directory values: trimmed, non-empty, absolute.
/// (The XDG base-dir spec requires relative `XDG_*` values to be ignored;
/// the same guard keeps a malformed `%APPDATA%` from producing a relative
/// storage root.)
fn parse_env_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixture paths use `/` separators (host-native on the unix CI/dev hosts
    // this suite runs on) even for the Windows rows: `Path` equality compares
    // components, and the resolver core never inspects separators itself.

    const ALL_PLATFORMS: [Platform; 3] = [Platform::MacOs, Platform::Linux, Platform::Windows];

    fn env_with_home(home: &str) -> CursorEnv {
        CursorEnv {
            home: Some(PathBuf::from(home)),
            ..CursorEnv::default()
        }
    }

    // ── Platform matrix (no override) ──

    #[test]
    fn macos_global_storage_under_application_support() {
        let env = env_with_home("/Users/dev");
        assert_eq!(
            env.global_storage_dir(Platform::MacOs).unwrap(),
            PathBuf::from("/Users/dev/Library/Application Support/Cursor/User/globalStorage"),
        );
    }

    #[test]
    fn linux_global_storage_defaults_to_dot_config() {
        let env = env_with_home("/home/dev");
        assert_eq!(
            env.global_storage_dir(Platform::Linux).unwrap(),
            PathBuf::from("/home/dev/.config/Cursor/User/globalStorage"),
        );
    }

    #[test]
    fn linux_global_storage_respects_xdg_config_home() {
        let env = CursorEnv {
            home: Some(PathBuf::from("/home/dev")),
            xdg_config_home: Some(PathBuf::from("/mnt/config")),
            ..CursorEnv::default()
        };
        assert_eq!(
            env.global_storage_dir(Platform::Linux).unwrap(),
            PathBuf::from("/mnt/config/Cursor/User/globalStorage"),
        );
        // XDG is a Linux-only concept here: macOS keeps the home-based layout.
        assert_eq!(
            env.global_storage_dir(Platform::MacOs).unwrap(),
            PathBuf::from("/home/dev/Library/Application Support/Cursor/User/globalStorage"),
        );
    }

    #[test]
    fn windows_global_storage_prefers_appdata() {
        let env = CursorEnv {
            home: Some(PathBuf::from("C:/Users/dev")),
            appdata: Some(PathBuf::from("D:/Roaming")),
            ..CursorEnv::default()
        };
        assert_eq!(
            env.global_storage_dir(Platform::Windows).unwrap(),
            PathBuf::from("D:/Roaming/Cursor/User/globalStorage"),
        );
    }

    #[test]
    fn windows_global_storage_falls_back_to_home_appdata_roaming() {
        let env = env_with_home("C:/Users/dev");
        assert_eq!(
            env.global_storage_dir(Platform::Windows).unwrap(),
            PathBuf::from("C:/Users/dev/AppData/Roaming/Cursor/User/globalStorage"),
        );
    }

    // ── Identity-isolation override ──

    #[test]
    fn override_wins_and_real_environment_is_never_consulted() {
        let env = CursorEnv {
            external_history_home: Some(PathBuf::from("/tmp/orgii-instance2")),
            home: Some(PathBuf::from("/Users/real")),
            xdg_config_home: Some(PathBuf::from("/real/xdg")),
            appdata: Some(PathBuf::from("C:/real/appdata")),
        };
        assert_eq!(
            env.global_storage_dir(Platform::MacOs).unwrap(),
            PathBuf::from(
                "/tmp/orgii-instance2/Library/Application Support/Cursor/User/globalStorage"
            ),
        );
        assert_eq!(
            env.global_storage_dir(Platform::Linux).unwrap(),
            PathBuf::from("/tmp/orgii-instance2/.config/Cursor/User/globalStorage"),
        );
        assert_eq!(
            env.global_storage_dir(Platform::Windows).unwrap(),
            PathBuf::from("/tmp/orgii-instance2/AppData/Roaming/Cursor/User/globalStorage"),
        );
        assert_eq!(
            env.plugins_cache_dir().unwrap(),
            PathBuf::from("/tmp/orgii-instance2/.cursor/plugins/cache/cursor-public"),
        );
    }

    #[test]
    fn override_resolves_even_without_a_home_dir() {
        let env = CursorEnv {
            external_history_home: Some(PathBuf::from("/tmp/orgii-instance2")),
            ..CursorEnv::default()
        };
        for platform in ALL_PLATFORMS {
            assert!(env.global_storage_dir(platform).is_ok());
        }
        assert!(env.plugins_cache_dir().is_ok());
    }

    // ── Typed unavailability ──

    #[test]
    fn missing_home_is_typed_unavailable_not_a_fake_path() {
        let env = CursorEnv::default();
        for platform in ALL_PLATFORMS {
            assert_eq!(env.global_storage_dir(platform), Err(CursorPathsUnavailable));
            assert_eq!(env.state_db_path(platform), Err(CursorPathsUnavailable));
        }
        assert_eq!(env.plugins_cache_dir(), Err(CursorPathsUnavailable));
    }

    #[test]
    fn windows_appdata_alone_resolves_global_storage_but_not_home_dotdir() {
        let env = CursorEnv {
            appdata: Some(PathBuf::from("C:/Roaming")),
            ..CursorEnv::default()
        };
        assert_eq!(
            env.global_storage_dir(Platform::Windows).unwrap(),
            PathBuf::from("C:/Roaming/Cursor/User/globalStorage"),
        );
        assert_eq!(env.plugins_cache_dir(), Err(CursorPathsUnavailable));
    }

    // ── File names & dotdir family ──

    #[test]
    fn database_file_names_join_global_storage() {
        let env = env_with_home("/Users/dev");
        assert_eq!(
            env.state_db_path(Platform::MacOs).unwrap(),
            PathBuf::from(
                "/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
            ),
        );
        assert_eq!(
            env.conversation_index_db_path(Platform::MacOs).unwrap(),
            PathBuf::from(
                "/Users/dev/Library/Application Support/Cursor/User/globalStorage/conversation-search.db"
            ),
        );
    }

    #[test]
    fn plugins_cache_is_home_anchored() {
        let env = env_with_home("/home/dev");
        assert_eq!(
            env.plugins_cache_dir().unwrap(),
            PathBuf::from("/home/dev/.cursor/plugins/cache/cursor-public"),
        );
    }

    // ── Env-value filtering ──

    #[test]
    fn parse_env_path_filters_blank_and_relative_values() {
        assert_eq!(parse_env_path(""), None);
        assert_eq!(parse_env_path("   "), None);
        assert_eq!(parse_env_path("relative/config"), None);
        assert_eq!(
            parse_env_path("  /abs/config  "),
            Some(PathBuf::from("/abs/config")),
        );
    }
}
