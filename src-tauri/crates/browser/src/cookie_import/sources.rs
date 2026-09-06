//! Discovery of importable browser cookie sources on this machine.
//!
//! A *source* is one browser profile whose cookie store exists on disk. On
//! macOS this covers the Chromium family (Chrome, Edge, Brave, Arc, Vivaldi,
//! Chromium) plus Firefox; on Windows and Linux, Firefox only — mirroring what
//! can actually be decrypted per platform.

use std::path::{Path, PathBuf};

use super::{CookieSourceKind, SourceUnavailableReason};

/// One discovered, on-disk browser profile that can be imported from.
#[derive(Debug, Clone)]
pub struct SourceLocation {
    /// Stable id used to re-find this source on later calls, e.g.
    /// `chromium:chrome:Profile 2`. Never shown to the user.
    pub id: String,
    pub kind: CookieSourceKind,
    /// Machine id for the browser family, e.g. `chrome`, `firefox`.
    pub browser_id: String,
    /// Human label for the browser, e.g. `Google Chrome`.
    pub browser_label: String,
    /// Human label for the profile, e.g. `Personal · you@example.com`.
    pub profile_label: Option<String>,
    /// Absolute path to the cookie database. Kept server-side only.
    pub store_path: PathBuf,
    /// macOS keychain (service, account) for Chromium value decryption.
    pub keychain: Option<(String, String)>,
    /// Why the store cannot be read right now, if it exists but is blocked.
    pub unavailable_reason: Option<SourceUnavailableReason>,
}

#[cfg(target_os = "macos")]
struct ChromiumVendor {
    browser_id: &'static str,
    browser_label: &'static str,
    /// Sub-path under the OS application-support directory (the user-data dir).
    support_subdir: &'static str,
    keychain_service: &'static str,
    keychain_account: &'static str,
}

#[cfg(target_os = "macos")]
const CHROMIUM_VENDORS: &[ChromiumVendor] = &[
    ChromiumVendor {
        browser_id: "chrome",
        browser_label: "Google Chrome",
        support_subdir: "Google/Chrome",
        keychain_service: "Chrome Safe Storage",
        keychain_account: "Chrome",
    },
    ChromiumVendor {
        browser_id: "edge",
        browser_label: "Microsoft Edge",
        support_subdir: "Microsoft Edge",
        keychain_service: "Microsoft Edge Safe Storage",
        keychain_account: "Microsoft Edge",
    },
    ChromiumVendor {
        browser_id: "brave",
        browser_label: "Brave",
        support_subdir: "BraveSoftware/Brave-Browser",
        keychain_service: "Brave Safe Storage",
        keychain_account: "Brave",
    },
    ChromiumVendor {
        browser_id: "arc",
        browser_label: "Arc",
        support_subdir: "Arc/User Data",
        keychain_service: "Arc Safe Storage",
        keychain_account: "Arc",
    },
    ChromiumVendor {
        browser_id: "vivaldi",
        browser_label: "Vivaldi",
        support_subdir: "Vivaldi",
        keychain_service: "Vivaldi Safe Storage",
        keychain_account: "Vivaldi",
    },
    ChromiumVendor {
        browser_id: "chromium",
        browser_label: "Chromium",
        support_subdir: "Chromium",
        keychain_service: "Chromium Safe Storage",
        keychain_account: "Chromium",
    },
];

/// Chromium profile directories that never hold user logins.
#[cfg(target_os = "macos")]
const CHROMIUM_SKIP_PROFILES: &[&str] = &["System Profile", "Guest Profile"];

/// Enumerate every importable source on this machine, in a stable order.
pub fn discover_sources() -> Vec<SourceLocation> {
    let mut sources = Vec::new();
    #[cfg(target_os = "macos")]
    discover_chromium_macos(&mut sources);
    #[cfg(target_os = "macos")]
    discover_safari_macos(&mut sources);
    discover_firefox(&mut sources);
    sources
}

/// macOS application-support directory (`~/Library/Application Support`).
#[cfg(target_os = "macos")]
fn macos_application_support() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"))
}

#[cfg(target_os = "macos")]
fn discover_chromium_macos(sources: &mut Vec<SourceLocation>) {
    let Some(app_support) = macos_application_support() else {
        return;
    };

    for vendor in CHROMIUM_VENDORS {
        let user_data_dir = app_support.join(vendor.support_subdir);
        if !user_data_dir.is_dir() {
            continue;
        }

        for (profile_dir, profile_label) in chromium_profiles(&user_data_dir) {
            if CHROMIUM_SKIP_PROFILES.contains(&profile_dir.as_str()) {
                continue;
            }
            let Some(store_path) = chromium_store_path(&user_data_dir, &profile_dir) else {
                continue;
            };
            sources.push(SourceLocation {
                id: format!("chromium:{}:{}", vendor.browser_id, profile_dir),
                kind: CookieSourceKind::Chromium,
                browser_id: vendor.browser_id.to_string(),
                browser_label: vendor.browser_label.to_string(),
                profile_label,
                store_path,
                keychain: Some((
                    vendor.keychain_service.to_string(),
                    vendor.keychain_account.to_string(),
                )),
                unavailable_reason: None,
            });
        }
    }
}

/// Prefer the newer `<profile>/Network/Cookies` location, falling back to the
/// legacy `<profile>/Cookies`.
#[cfg(target_os = "macos")]
fn chromium_store_path(user_data_dir: &Path, profile_dir: &str) -> Option<PathBuf> {
    let network = user_data_dir.join(profile_dir).join("Network").join("Cookies");
    if network.is_file() {
        return Some(network);
    }
    let legacy = user_data_dir.join(profile_dir).join("Cookies");
    legacy.is_file().then_some(legacy)
}

/// List a Chromium install's profile directories with display labels, read from
/// `Local State` when present and otherwise inferred from directory names.
#[cfg(target_os = "macos")]
fn chromium_profiles(user_data_dir: &Path) -> Vec<(String, Option<String>)> {
    if let Some(profiles) = chromium_profiles_from_local_state(user_data_dir) {
        if !profiles.is_empty() {
            return profiles;
        }
    }

    // Fallback: scan for `Default` and `Profile N` directories.
    let mut profiles = Vec::new();
    if user_data_dir.join("Default").is_dir() {
        profiles.push(("Default".to_string(), None));
    }
    if let Ok(entries) = std::fs::read_dir(user_data_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("Profile ") && entry.path().is_dir() {
                profiles.push((name, None));
            }
        }
    }
    profiles
}

#[cfg(target_os = "macos")]
fn chromium_profiles_from_local_state(user_data_dir: &Path) -> Option<Vec<(String, Option<String>)>> {
    let raw = std::fs::read_to_string(user_data_dir.join("Local State")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let info_cache = parsed.get("profile")?.get("info_cache")?.as_object()?;

    let mut profiles = Vec::new();
    for (profile_dir, info) in info_cache {
        let name = info
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(profile_dir);
        let user_name = info
            .get("user_name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let label = if user_name.is_empty() {
            name.to_string()
        } else {
            format!("{name} · {user_name}")
        };
        profiles.push((profile_dir.clone(), Some(label)));
    }
    // Stable, human order regardless of JSON map ordering.
    profiles.sort_by(|left, right| left.0.cmp(&right.0));
    Some(profiles)
}

/// Directory that holds Firefox's `profiles.ini`, per platform.
fn firefox_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Firefox")
        })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(|appdata| PathBuf::from(appdata).join("Mozilla").join("Firefox"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".mozilla").join("firefox"))
    }
}

fn discover_firefox(sources: &mut Vec<SourceLocation>) {
    let Some(root) = firefox_root() else {
        return;
    };
    let Ok(ini) = std::fs::read_to_string(root.join("profiles.ini")) else {
        return;
    };

    for (path, is_relative) in parse_firefox_profiles_ini(&ini) {
        let profile_dir = if is_relative {
            root.join(&path)
        } else {
            PathBuf::from(&path)
        };
        let store_path = profile_dir.join("cookies.sqlite");
        if !store_path.is_file() {
            continue;
        }
        // The trailing path segment (e.g. `xxxx.default-release`) is the only
        // stable, human-recognisable profile name Firefox exposes.
        let label = profile_dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string());
        sources.push(SourceLocation {
            id: format!("firefox:{path}"),
            kind: CookieSourceKind::Firefox,
            browser_id: "firefox".to_string(),
            browser_label: "Firefox".to_string(),
            profile_label: label,
            store_path,
            keychain: None,
            unavailable_reason: None,
        });
    }
}

/// Safari's persistent cookie store. The sandbox-container path is the
/// modern location; `~/Library/Cookies` predates it. Both sit behind Full
/// Disk Access, and without it macOS refuses even to list the folder — so a
/// permission error means "Safari is here but blocked", not "no Safari".
#[cfg(target_os = "macos")]
fn discover_safari_macos(sources: &mut Vec<SourceLocation>) {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let candidates = [
        home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies"),
        home.join("Library/Cookies"),
    ];

    let mut blocked = false;
    for dir in &candidates {
        match std::fs::read_dir(dir) {
            Ok(_) => {
                let store_path = dir.join("Cookies.binarycookies");
                if store_path.is_file() {
                    sources.push(safari_source(store_path, None));
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                blocked = true;
            }
            Err(_) => {}
        }
    }

    if blocked {
        sources.push(safari_source(
            candidates[0].join("Cookies.binarycookies"),
            Some(SourceUnavailableReason::NeedsFullDiskAccess),
        ));
    }
}

#[cfg(target_os = "macos")]
fn safari_source(
    store_path: PathBuf,
    unavailable_reason: Option<SourceUnavailableReason>,
) -> SourceLocation {
    SourceLocation {
        id: "safari".to_string(),
        kind: CookieSourceKind::Safari,
        browser_id: "safari".to_string(),
        browser_label: "Safari".to_string(),
        profile_label: None,
        store_path,
        keychain: None,
        unavailable_reason,
    }
}

/// Parse the `Path=`/`IsRelative=` pairs out of a `profiles.ini` body.
/// Returns `(path, is_relative)` for each `[ProfileN]` section.
pub fn parse_firefox_profiles_ini(ini: &str) -> Vec<(String, bool)> {
    let mut profiles = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_relative = true;
    let mut in_profile_section = false;

    let flush = |profiles: &mut Vec<(String, bool)>,
                 path: &mut Option<String>,
                 relative: bool| {
        if let Some(path) = path.take() {
            profiles.push((path, relative));
        }
    };

    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            flush(&mut profiles, &mut current_path, current_relative);
            in_profile_section = line.starts_with("[Profile");
            current_relative = true;
            continue;
        }
        if !in_profile_section {
            continue;
        }
        if let Some(value) = line.strip_prefix("Path=") {
            current_path = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("IsRelative=") {
            current_relative = value.trim() != "0";
        }
    }
    flush(&mut profiles, &mut current_path, current_relative);
    profiles
}

#[cfg(test)]
#[path = "tests/sources_tests.rs"]
mod tests;
