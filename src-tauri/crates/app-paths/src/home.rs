//! User home resolution and the roots scanned for external agent histories.
//!
//! Owns `home_dir()` plus the `ORGII_EXTERNAL_HISTORY_HOME`-aware
//! data/config/state/XDG roots that external-history discovery probes.

use std::path::PathBuf;

/// User home directory with a deterministic fallback to the system temp dir.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// User-home root scanned for histories created by external agent apps.
///
/// Production falls back to the real user home. Multi-instance development
/// launchers may set `ORGII_EXTERNAL_HISTORY_HOME` so a secondary profile
/// does not discover and publish the primary profile's external histories
/// under a different cloud identity.
pub fn external_history_home_dir() -> PathBuf {
    external_history_home_override().unwrap_or_else(home_dir)
}

fn external_history_home_override() -> Option<PathBuf> {
    std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Roaming/application-data root used only for discovering external histories.
///
/// A secondary ORG2 identity redirects this beneath its isolated external
/// history home instead of inheriting the primary user's `APPDATA`/XDG paths.
pub fn external_history_data_dir() -> PathBuf {
    if external_history_home_override().is_none() {
        if let Some(path) = dirs::data_dir() {
            return path;
        }
    }
    let home = external_history_home_dir();
    #[cfg(target_os = "windows")]
    return home.join("AppData").join("Roaming");
    #[cfg(target_os = "macos")]
    return home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return home.join(".local").join("share");
}

/// Machine-local application-data root used for external-history discovery.
pub fn external_history_data_local_dir() -> PathBuf {
    if external_history_home_override().is_none() {
        if let Some(path) = dirs::data_local_dir() {
            return path;
        }
    }
    let home = external_history_home_dir();
    #[cfg(target_os = "windows")]
    return home.join("AppData").join("Local");
    #[cfg(target_os = "macos")]
    return home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return home.join(".local").join("share");
}

/// Configuration root used for external-history discovery.
pub fn external_history_config_dir() -> PathBuf {
    if external_history_home_override().is_none() {
        if let Some(path) = dirs::config_dir() {
            return path;
        }
    }
    let home = external_history_home_dir();
    #[cfg(target_os = "windows")]
    return home.join("AppData").join("Roaming");
    #[cfg(target_os = "macos")]
    return home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return home.join(".config");
}

/// State root (`XDG_STATE_HOME` equivalent) used for external-history
/// discovery.
pub fn external_history_state_dir() -> PathBuf {
    if external_history_home_override().is_none() {
        if let Some(path) = dirs::state_dir() {
            return path;
        }
    }
    let home = external_history_home_dir();
    #[cfg(target_os = "windows")]
    return home.join("AppData").join("Local");
    #[cfg(target_os = "macos")]
    return home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return home.join(".local").join("state");
}

/// Explicit `$XDG_CONFIG_HOME` probe used for external-history discovery.
///
/// `dirs::config_dir()` only honors XDG on Linux, but some providers (e.g.
/// cursor-agent) honor an exported `$XDG_CONFIG_HOME` on macOS too, so
/// callers add this as an extra candidate root alongside
/// [`external_history_config_dir`].
///
/// Returns `None` when the env var is unset or blank, and — to keep identity
/// isolation airtight — whenever `ORGII_EXTERNAL_HISTORY_HOME` is set: the
/// real user's XDG environment must never leak into a secondary profile's
/// discovery, and the override tree's deterministic XDG-default equivalent
/// (`<override>/.config` on Linux) is already produced by
/// [`external_history_config_dir`]'s fallback chain.
pub fn external_history_xdg_config_dir() -> Option<PathBuf> {
    external_history_xdg_dir("XDG_CONFIG_HOME")
}

/// Explicit `$XDG_STATE_HOME` probe used for external-history discovery.
///
/// `dirs::state_dir()` is `None` on macOS/Windows even when the user exports
/// `XDG_STATE_HOME` for XDG-aware tools (e.g. Warp on Linux-style installs).
/// Same isolation contract as [`external_history_xdg_config_dir`]: `None`
/// whenever `ORGII_EXTERNAL_HISTORY_HOME` is set, since the isolated
/// equivalent (`<override>/.local/state` on Linux) is already produced by
/// [`external_history_state_dir`]'s fallback chain.
pub fn external_history_xdg_state_dir() -> Option<PathBuf> {
    external_history_xdg_dir("XDG_STATE_HOME")
}

fn external_history_xdg_dir(var: &str) -> Option<PathBuf> {
    if external_history_home_override().is_some() {
        return None;
    }
    let value = std::env::var(var).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// Serializes tests that mutate process environment variables. Env vars
    /// are process-global, so parallel test threads would otherwise race.
    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sets or unsets one env var and restores the original value on drop.
    struct EnvVarGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, original }
        }

        fn unset(key: &'static str) -> Self {
            let original = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.original.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn xdg_config_dir_reads_env_without_isolation_override() {
        let _lock = env_lock();
        let _isolation = EnvVarGuard::unset("ORGII_EXTERNAL_HISTORY_HOME");
        let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", "/home/tester/.config");

        assert_eq!(
            external_history_xdg_config_dir(),
            Some(PathBuf::from("/home/tester/.config")),
        );
    }

    #[test]
    fn xdg_config_dir_is_none_under_isolation_override() {
        let _lock = env_lock();
        let _isolation = EnvVarGuard::set("ORGII_EXTERNAL_HISTORY_HOME", "/tmp/orgii-instance2");
        let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", "/home/tester/.config");

        assert_eq!(external_history_xdg_config_dir(), None);
    }

    #[test]
    fn xdg_state_dir_reads_env_without_isolation_override() {
        let _lock = env_lock();
        let _isolation = EnvVarGuard::unset("ORGII_EXTERNAL_HISTORY_HOME");
        let _xdg = EnvVarGuard::set("XDG_STATE_HOME", "/home/tester/.local/state");

        assert_eq!(
            external_history_xdg_state_dir(),
            Some(PathBuf::from("/home/tester/.local/state")),
        );
    }

    #[test]
    fn xdg_state_dir_is_none_under_isolation_override() {
        let _lock = env_lock();
        let _isolation = EnvVarGuard::set("ORGII_EXTERNAL_HISTORY_HOME", "/tmp/orgii-instance2");
        let _xdg = EnvVarGuard::set("XDG_STATE_HOME", "/home/tester/.local/state");

        assert_eq!(external_history_xdg_state_dir(), None);
    }

    #[test]
    fn xdg_dirs_ignore_unset_and_blank_env_values() {
        let _lock = env_lock();
        let _isolation = EnvVarGuard::unset("ORGII_EXTERNAL_HISTORY_HOME");

        {
            let _xdg = EnvVarGuard::unset("XDG_CONFIG_HOME");
            assert_eq!(external_history_xdg_config_dir(), None);
        }
        {
            let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", "   ");
            assert_eq!(external_history_xdg_config_dir(), None);
        }
        {
            let _xdg = EnvVarGuard::set("XDG_STATE_HOME", "  /home/tester/.local/state  ");
            // Accidental surrounding whitespace is trimmed off.
            assert_eq!(
                external_history_xdg_state_dir(),
                Some(PathBuf::from("/home/tester/.local/state")),
            );
        }
    }
}
