//! Import cookies (saved logins) from other browsers into the app's browser.
//!
//! Replicates the "import cookies from your browser" affordance: the user picks
//! a source browser profile, sees the sites it holds logins for (money / mail /
//! SSO left unchecked by default), and the selected sites' cookies are written
//! into the app's own WebView cookie store so those sessions carry over.
//!
//! ## Shape
//!
//! - [`sources`] — discover installed browser profiles on this machine.
//! - [`chromium`] / [`firefox`] — read and (for Chromium) decrypt a store.
//! - [`classify`] — group cookies into sites and pick safe defaults.
//! - install — write the chosen cookies into `WKHTTPCookieStore` (macOS).
//!
//! Decrypted cookie *values* never leave Rust: preview returns only per-site
//! counts, and import reads, decrypts, and writes without round-tripping values
//! through the webview.
//!
//! ## Platform support
//!
//! - **macOS**: Chromium family (Chrome, Edge, Brave, Arc, Vivaldi, Chromium)
//!   and Firefox.
//! - **Windows / Linux**: Firefox only. Chromium value decryption there (DPAPI
//!   / libsecret) is not yet implemented, so those profiles are not offered.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use classify::SiteCategory;

pub mod chromium;
pub mod classify;
pub mod firefox;
pub mod sources;

/// How many representative host names to keep per site for display.
const MAX_SAMPLE_HOSTS: usize = 4;

/// Timeout for the native cookie-write round trip.
#[cfg(target_os = "macos")]
const INSTALL_TIMEOUT_SECS: u64 = 20;

// ============================================================================
// Wire types (frontend-facing)
// ============================================================================

/// Browser engine family of a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CookieSourceKind {
    Chromium,
    Firefox,
}

/// One importable browser profile, as shown in the source picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportSource {
    /// Opaque, stable id used for the follow-up preview / import calls.
    pub id: String,
    pub kind: CookieSourceKind,
    /// Machine id for the browser family, e.g. `chrome`, `firefox`.
    pub browser_id: String,
    /// Display name of the browser, e.g. `Google Chrome`.
    pub browser_label: String,
    /// Display name of the profile, e.g. `Personal · you@example.com`.
    pub profile_label: Option<String>,
}

/// One site (registrable domain) worth of cookies in a preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieSiteGroup {
    /// Registrable domain, e.g. `github.com`.
    pub domain: String,
    /// Number of cookies the source holds for this site.
    pub cookie_count: usize,
    pub category: SiteCategory,
    /// Whether this row should start checked (false for money / mail / SSO).
    pub default_selected: bool,
    /// A few concrete host names under the domain, for display.
    pub sample_hosts: Vec<String>,
}

/// Result of previewing a source: the sites it can import, plus context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportPreview {
    pub source_id: String,
    pub total_cookies: usize,
    pub sites: Vec<CookieSiteGroup>,
    /// Non-fatal note, e.g. some values could not be decrypted.
    pub warning: Option<String>,
}

/// Outcome of an import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportResult {
    pub requested_domains: usize,
    pub imported_cookies: usize,
    /// Cookies that matched a chosen site but could not be written.
    pub skipped_cookies: usize,
}

// ============================================================================
// Internal cookie representation (never serialized to the frontend)
// ============================================================================

/// A fully decrypted cookie, ready to install. Stays inside Rust.
#[derive(Debug, Clone)]
pub struct DecryptedCookie {
    pub host_key: String,
    pub name: String,
    pub value: String,
    pub path: String,
    /// Expiry as Unix seconds; `None` for a session cookie.
    pub expires_utc: Option<i64>,
    pub is_secure: bool,
    pub is_http_only: bool,
    /// SameSite as read from the source. Preserved at the read boundary but not
    /// re-applied on install (see [`SameSite`]).
    pub same_site: SameSite,
}

/// SameSite attribute carried through from the source store.
///
/// Read from the source but intentionally not re-applied on install: WebKit's
/// default handling keeps first-party (same-site) requests authenticated, and
/// passing an unrecognized SameSite key to `cookieWithProperties:` can void the
/// whole cookie. Kept as a distinct type for clarity at the read boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    Unspecified,
    None,
    Lax,
    Strict,
}

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug)]
pub enum CookieReadError {
    /// Could not open the cookie database.
    Open(String),
    /// A SQL query against the cookie database failed.
    Query(String),
    /// The system keychain denied or failed the value-key lookup.
    Keychain(String),
    /// The requested source is not supported on this platform.
    Unsupported(String),
}

impl std::fmt::Display for CookieReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CookieReadError::Open(message) => write!(formatter, "open cookie store: {message}"),
            CookieReadError::Query(message) => write!(formatter, "read cookie store: {message}"),
            CookieReadError::Keychain(message) => {
                write!(formatter, "keychain access failed: {message}")
            }
            CookieReadError::Unsupported(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for CookieReadError {}

// ============================================================================
// SQLite helper
// ============================================================================

/// Percent-encode a filesystem path into a SQLite `file:` URI body.
fn to_sqlite_uri(path: &Path) -> String {
    let mut uri = String::from("file:");
    for byte in path.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                uri.push(*byte as char);
            }
            other => uri.push_str(&format!("%{other:02X}")),
        }
    }
    // `immutable=1` reads the committed pages even while the source browser holds
    // a write lock, and needs no temp copy or side files.
    uri.push_str("?immutable=1");
    uri
}

/// Open a browser cookie database read-only, tolerating a running browser.
pub fn open_sqlite_readonly(path: &Path) -> Result<rusqlite::Connection, CookieReadError> {
    use rusqlite::OpenFlags;

    if !path.is_file() {
        return Err(CookieReadError::Open(format!(
            "cookie store not found: {}",
            path.display()
        )));
    }
    rusqlite::Connection::open_with_flags(
        to_sqlite_uri(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| CookieReadError::Open(error.to_string()))
}

// ============================================================================
// Read orchestration
// ============================================================================

/// Cookies read from a source, plus how many rows could not be decrypted.
struct ReadOutcome {
    cookies: Vec<DecryptedCookie>,
    undecryptable: usize,
}

fn read_source_cookies(
    location: &sources::SourceLocation,
) -> Result<ReadOutcome, CookieReadError> {
    match location.kind {
        CookieSourceKind::Firefox => Ok(ReadOutcome {
            cookies: firefox::read_cookies(&location.store_path)?,
            undecryptable: 0,
        }),
        CookieSourceKind::Chromium => {
            #[cfg(target_os = "macos")]
            let key = match &location.keychain {
                Some((service, account)) => {
                    Some(chromium::chromium_keychain_key(service, account)?)
                }
                None => None,
            };
            #[cfg(not(target_os = "macos"))]
            let key: Option<[u8; 16]> = None;

            let result = chromium::read_cookies(&location.store_path, key.as_ref())?;
            Ok(ReadOutcome {
                cookies: result.cookies,
                undecryptable: result.undecryptable,
            })
        }
    }
}

/// Find a discovered source by its opaque id.
fn find_location(source_id: &str) -> Result<sources::SourceLocation, CookieReadError> {
    sources::discover_sources()
        .into_iter()
        .find(|location| location.id == source_id)
        .ok_or_else(|| {
            CookieReadError::Unsupported(format!("browser source not found: {source_id}"))
        })
}

/// Group cookies into per-site rows with categories and default selection.
fn group_sites(cookies: &[DecryptedCookie]) -> Vec<CookieSiteGroup> {
    struct Bucket {
        count: usize,
        hosts: Vec<String>,
    }
    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();

    for cookie in cookies {
        let domain = classify::registrable_domain(&cookie.host_key);
        if domain.is_empty() {
            continue;
        }
        let bucket = buckets.entry(domain).or_insert_with(|| Bucket {
            count: 0,
            hosts: Vec::new(),
        });
        bucket.count += 1;
        let host = cookie.host_key.trim_start_matches('.').to_string();
        if bucket.hosts.len() < MAX_SAMPLE_HOSTS && !bucket.hosts.contains(&host) {
            bucket.hosts.push(host);
        }
    }

    let mut sites: Vec<CookieSiteGroup> = buckets
        .into_iter()
        .map(|(domain, bucket)| {
            let category =
                classify::classify_site(&domain, bucket.hosts.iter().map(String::as_str));
            CookieSiteGroup {
                domain,
                cookie_count: bucket.count,
                category,
                default_selected: category.default_selected(),
                sample_hosts: bucket.hosts,
            }
        })
        .collect();

    // Most cookies first, then alphabetical for a stable order.
    sites.sort_by(|left, right| {
        right
            .cookie_count
            .cmp(&left.cookie_count)
            .then_with(|| left.domain.cmp(&right.domain))
    });
    sites
}

// ============================================================================
// Tauri commands
// ============================================================================

/// List importable browser profiles found on this machine.
#[tauri::command]
pub async fn list_cookie_import_sources() -> Result<Vec<CookieImportSource>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        sources::discover_sources()
            .into_iter()
            .map(|location| CookieImportSource {
                id: location.id,
                kind: location.kind,
                browser_id: location.browser_id,
                browser_label: location.browser_label,
                profile_label: location.profile_label,
            })
            .collect()
    })
    .await
    .map_err(|error| format!("failed to enumerate browser sources: {error}"))
}

/// Preview the sites a source holds logins for, without importing anything.
///
/// For a Chromium source this reads the value-encryption key from the system
/// keychain, which triggers the OS's own consent prompt the first time.
#[tauri::command]
pub async fn preview_cookie_import(source_id: String) -> Result<CookieImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let location = find_location(&source_id)?;
        let outcome = read_source_cookies(&location)?;
        let sites = group_sites(&outcome.cookies);
        let warning = (outcome.undecryptable > 0).then(|| {
            format!(
                "{} cookies could not be decrypted and were skipped",
                outcome.undecryptable
            )
        });
        Ok::<_, CookieReadError>(CookieImportPreview {
            source_id,
            total_cookies: outcome.cookies.len(),
            sites,
            warning,
        })
    })
    .await
    .map_err(|error| format!("cookie preview task failed: {error}"))?
    .map_err(|error| error.to_string())
}

/// Import the cookies for the chosen sites (registrable domains) into the app's
/// browser cookie store.
#[tauri::command]
pub async fn import_browser_cookies(
    app: AppHandle,
    source_id: String,
    domains: Vec<String>,
) -> Result<CookieImportResult, String> {
    let requested_domains = domains.len();
    let selected: std::collections::HashSet<String> = domains.into_iter().collect();

    let cookies = tauri::async_runtime::spawn_blocking(move || {
        let location = find_location(&source_id)?;
        let outcome = read_source_cookies(&location)?;
        let chosen: Vec<DecryptedCookie> = outcome
            .cookies
            .into_iter()
            .filter(|cookie| selected.contains(&classify::registrable_domain(&cookie.host_key)))
            .collect();
        Ok::<_, CookieReadError>(chosen)
    })
    .await
    .map_err(|error| format!("cookie read task failed: {error}"))?
    .map_err(|error| error.to_string())?;

    let total = cookies.len();
    let imported = install_cookies(&app, cookies)?;

    Ok(CookieImportResult {
        requested_domains,
        imported_cookies: imported,
        skipped_cookies: total.saturating_sub(imported),
    })
}

// ============================================================================
// Native install (macOS)
// ============================================================================

/// Write decrypted cookies into the app's default WebView cookie store.
#[cfg(target_os = "macos")]
fn install_cookies(app: &AppHandle, cookies: Vec<DecryptedCookie>) -> Result<usize, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    if cookies.is_empty() {
        return Ok(0);
    }

    let (tx, rx) = mpsc::channel::<usize>();

    app.run_on_main_thread(move || {
        // SAFETY: Runs on the main thread (WebKit requirement). Reaches the
        // process-wide default WebView cookie store and writes each cookie via
        // the documented WKHTTPCookieStore API. Every pointer is null-checked;
        // completion blocks only increment a main-thread-local counter and send
        // the final total back through the channel.
        unsafe {
            use block2::RcBlock;
            use objc2::msg_send;
            use objc2::runtime::{AnyClass, AnyObject};
            use std::cell::Cell;
            use std::rc::Rc;

            let Some(data_store_class) = AnyClass::get(c"WKWebsiteDataStore") else {
                let _ = tx.send(0);
                return;
            };
            let data_store: *mut AnyObject = msg_send![data_store_class, defaultDataStore];
            if data_store.is_null() {
                let _ = tx.send(0);
                return;
            }
            let cookie_store: *mut AnyObject = msg_send![data_store, httpCookieStore];
            if cookie_store.is_null() {
                let _ = tx.send(0);
                return;
            }

            let ns_cookies: Vec<*mut AnyObject> = cookies
                .iter()
                .map(|cookie| build_ns_cookie(cookie))
                .filter(|cookie| !cookie.is_null())
                .collect();

            let total = ns_cookies.len();
            if total == 0 {
                let _ = tx.send(0);
                return;
            }

            let done = Rc::new(Cell::new(0usize));
            for ns_cookie in ns_cookies {
                let done = Rc::clone(&done);
                let tx = tx.clone();
                let completion = RcBlock::new(move || {
                    let count = done.get() + 1;
                    done.set(count);
                    if count == total {
                        let _ = tx.send(total);
                    }
                });
                let _: () = msg_send![cookie_store, setCookie: ns_cookie, completionHandler: &*completion];
            }
        }
    })
    .map_err(|error| format!("failed to dispatch cookie install: {error}"))?;

    rx.recv_timeout(Duration::from_secs(INSTALL_TIMEOUT_SECS))
        .map_err(|_| "timed out writing cookies to the browser store".to_string())
}

#[cfg(not(target_os = "macos"))]
fn install_cookies(_app: &AppHandle, _cookies: Vec<DecryptedCookie>) -> Result<usize, String> {
    Err("importing cookies into the browser is only supported on macOS".to_string())
}

/// Build an `NSHTTPCookie` from a decrypted cookie, or null if WebKit rejects
/// the property set.
///
/// # Safety
/// Must run on the main thread; uses documented `NSHTTPCookie` / `NSString` /
/// `NSDate` selectors and null-checks the result.
#[cfg(target_os = "macos")]
unsafe fn build_ns_cookie(cookie: &DecryptedCookie) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Some(dictionary_class) = AnyClass::get(c"NSMutableDictionary") else {
        return std::ptr::null_mut();
    };
    let Some(cookie_class) = AnyClass::get(c"NSHTTPCookie") else {
        return std::ptr::null_mut();
    };
    let properties: *mut AnyObject = msg_send![dictionary_class, dictionary];
    if properties.is_null() {
        return std::ptr::null_mut();
    }

    // NSHTTPCookie property keys are these exact string constants.
    dict_set(properties, "Name", ns_string(&cookie.name));
    dict_set(properties, "Value", ns_string(&cookie.value));
    dict_set(properties, "Domain", ns_string(&cookie.host_key));
    let path = if cookie.path.is_empty() {
        "/"
    } else {
        cookie.path.as_str()
    };
    dict_set(properties, "Path", ns_string(path));
    if cookie.is_secure {
        dict_set(properties, "Secure", ns_string("TRUE"));
    }
    if cookie.is_http_only {
        dict_set(properties, "HttpOnly", ns_string("TRUE"));
    }
    if let Some(expires) = cookie.expires_utc {
        if let Some(date_class) = AnyClass::get(c"NSDate") {
            let date: *mut AnyObject =
                msg_send![date_class, dateWithTimeIntervalSince1970: expires as f64];
            dict_set(properties, "Expires", date);
        }
    }

    msg_send![cookie_class, cookieWithProperties: properties]
}

/// Set one entry on an `NSMutableDictionary`, skipping null values.
///
/// # Safety
/// `dictionary` must be a valid `NSMutableDictionary`; runs on the main thread.
#[cfg(target_os = "macos")]
unsafe fn dict_set(
    dictionary: *mut objc2::runtime::AnyObject,
    key: &str,
    value: *mut objc2::runtime::AnyObject,
) {
    use objc2::msg_send;

    if value.is_null() {
        return;
    }
    let key_object = ns_string(key);
    if key_object.is_null() {
        return;
    }
    let _: () = msg_send![dictionary, setObject: value, forKey: key_object];
}

/// Build an autoreleased `NSString` from a Rust string.
///
/// # Safety
/// Uses the documented `+[NSString stringWithUTF8String:]`; returns null if the
/// value contains an interior NUL.
#[cfg(target_os = "macos")]
unsafe fn ns_string(value: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;

    let Ok(cstring) = std::ffi::CString::new(value) else {
        return std::ptr::null_mut();
    };
    let Some(string_class) = AnyClass::get(c"NSString") else {
        return std::ptr::null_mut();
    };
    msg_send![string_class, stringWithUTF8String: cstring.as_ptr()]
}

#[cfg(test)]
#[path = "tests/group_tests.rs"]
mod tests;
