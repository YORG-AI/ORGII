//! Native Cookie Access
//!
//! Platform-specific APIs to access cookies, including HttpOnly cookies
//! that JavaScript cannot read.
//!
//! # Platform Support
//!
//! - **macOS**: Full support via WKHTTPCookieStore and NSHTTPCookieStorage
//! - **Other platforms**: Not yet implemented

use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

use super::types::CookieInfo;

/// Get cookies from native cookie store (including HttpOnly).
///
/// Uses platform-specific APIs to access cookies that JavaScript cannot read.
/// Tries the webview-specific cookie store first, then falls back to the
/// shared system cookie storage.
///
/// # Arguments
///
/// * `webview_label` - Label of the webview to get cookies from
/// * `url` - Optional URL to filter cookies by domain
pub async fn get_webview_cookies(
    app: AppHandle,
    webview_label: String,
    url: Option<String>,
) -> Result<Vec<CookieInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        // First try WKWebView's cookie store (for webview-specific cookies)
        if let Some(webview) = app.get_webview(&webview_label) {
            if let Ok(cookies) = get_wkwebview_cookies(&webview, url.as_deref()).await {
                if !cookies.is_empty() {
                    return Ok(cookies);
                }
            }
        }

        // Fall back to shared cookie storage
        get_macos_shared_cookies(url.as_deref())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, webview_label, url);
        Err("Cookie access not implemented for this platform".to_string())
    }
}

// ============================================
// macOS: WKWebView Cookie Access
// ============================================

/// Get cookies from WKWebView's WKHTTPCookieStore.
#[cfg(target_os = "macos")]
async fn get_wkwebview_cookies(
    webview: &tauri::Webview,
    url_filter: Option<&str>,
) -> Result<Vec<CookieInfo>, String> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Vec<CookieInfo>>();
    let filter_domain = parse_domain_filter(url_filter);

    webview
        .with_webview(move |wv| {
            #[cfg(target_os = "macos")]
            // SAFETY: This block accesses WKWebView's WKHTTPCookieStore via Objective-C runtime.
            // - wv.inner() provides a valid WKWebView* on macOS
            // - Object chain: WKWebView -> WKWebViewConfiguration -> WKWebsiteDataStore -> WKHTTPCookieStore
            // - All selectors are standard WebKit APIs (configuration, websiteDataStore, httpCookieStore)
            // - getAllCookies: calls completion block with NSArray<NSHTTPCookie*>
            // - parse_cookie() only reads cookie properties, does not modify
            // - Null checks at each step prevent null pointer dereference
            unsafe {
                // Get WKWebView from the platform webview
                let wk_webview: *mut AnyObject = wv.inner() as *mut AnyObject;
                if wk_webview.is_null() {
                    let _ = tx.send(vec![]);
                    return;
                }

                // WKWebView -> configuration -> websiteDataStore -> httpCookieStore
                let configuration: *mut AnyObject = msg_send![wk_webview, configuration];
                if configuration.is_null() {
                    let _ = tx.send(vec![]);
                    return;
                }

                let data_store: *mut AnyObject = msg_send![configuration, websiteDataStore];
                if data_store.is_null() {
                    let _ = tx.send(vec![]);
                    return;
                }

                let cookie_store: *mut AnyObject = msg_send![data_store, httpCookieStore];
                if cookie_store.is_null() {
                    let _ = tx.send(vec![]);
                    return;
                }

                // Create completion block for getAllCookies
                let tx_clone = tx.clone();
                let filter_clone = filter_domain.clone();
                let block = RcBlock::new(move |cookies: *mut AnyObject| {
                    let mut result = Vec::new();

                    if !cookies.is_null() {
                        let count: usize = msg_send![cookies, count];
                        for i in 0..count {
                            let cookie: *mut AnyObject = msg_send![cookies, objectAtIndex: i];
                            if !cookie.is_null() {
                                let info = parse_cookie(cookie);

                                // Apply domain filter
                                if let Some(ref filter) = filter_clone {
                                    if !matches_domain(&info.domain, filter) {
                                        continue;
                                    }
                                }

                                result.push(info);
                            }
                        }
                    }

                    let _ = tx_clone.send(result);
                });

                // Call getAllCookies with completion handler
                let _: () = msg_send![cookie_store, getAllCookies: &*block];
            }
        })
        .map_err(|e| format!("Failed to access webview: {:?}", e))?;

    // Wait for completion (with timeout)
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Timeout waiting for cookies".to_string())
}

// ============================================
// macOS: Shared Cookie Storage
// ============================================

/// Get cookies from the shared NSHTTPCookieStorage (system-wide cookie jar).
///
/// This accesses cookies that are shared across the app, not specific to a webview.
/// Used as a fallback when WKWebView-specific cookies are not available.
#[cfg(target_os = "macos")]
fn get_macos_shared_cookies(url_filter: Option<&str>) -> Result<Vec<CookieInfo>, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    // SAFETY: This block accesses the shared NSHTTPCookieStorage via Objective-C runtime.
    // - NSHTTPCookieStorage is a singleton, sharedHTTPCookieStorage always returns valid pointer
    // - cookies selector returns NSArray<NSHTTPCookie*> or nil
    // - All objects are read-only accessed, no mutations
    // - Null checks prevent dereferencing nil pointers
    unsafe {
        let class = AnyClass::get(c"NSHTTPCookieStorage").ok_or("NSHTTPCookieStorage not found")?;
        let storage: *mut AnyObject = msg_send![class, sharedHTTPCookieStorage];
        if storage.is_null() {
            return Ok(vec![]);
        }

        let cookies: *mut AnyObject = msg_send![storage, cookies];
        if cookies.is_null() {
            return Ok(vec![]);
        }

        let count: usize = msg_send![cookies, count];
        let filter_domain = parse_domain_filter(url_filter);

        let mut result = Vec::with_capacity(count);

        for i in 0..count {
            let cookie: *mut AnyObject = msg_send![cookies, objectAtIndex: i];
            if cookie.is_null() {
                continue;
            }

            let info = parse_cookie(cookie);

            // Apply domain filter
            if let Some(ref filter) = filter_domain {
                if !matches_domain(&info.domain, filter) {
                    continue;
                }
            }

            result.push(info);
        }

        Ok(result)
    }
}

// ============================================
// macOS: Cookie Parsing Helpers
// ============================================

/// Parse an NSHTTPCookie object into a CookieInfo struct.
///
/// # Safety
///
/// Caller must ensure `cookie` is a valid, non-null pointer to an NSHTTPCookie object.
/// This function reads cookie properties using documented NSHTTPCookie selectors.
#[cfg(target_os = "macos")]
unsafe fn parse_cookie(cookie: *mut objc2::runtime::AnyObject) -> CookieInfo {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let name: *mut AnyObject = msg_send![cookie, name];
    let value: *mut AnyObject = msg_send![cookie, value];
    let domain: *mut AnyObject = msg_send![cookie, domain];
    let path: *mut AnyObject = msg_send![cookie, path];
    let http_only: bool = msg_send![cookie, isHTTPOnly];
    let secure: bool = msg_send![cookie, isSecure];

    CookieInfo {
        name: nsstring_to_string(name).unwrap_or_default(),
        value: nsstring_to_string(value).unwrap_or_default(),
        domain: nsstring_to_string(domain),
        path: nsstring_to_string(path),
        http_only,
        secure,
        expires: None,
        same_site: None,
    }
}

/// Parse URL to extract domain for filtering.
#[cfg(target_os = "macos")]
fn parse_domain_filter(url_filter: Option<&str>) -> Option<String> {
    url_filter.and_then(|u| {
        u.parse::<url::Url>()
            .ok()
            .and_then(|parsed| parsed.host_str().map(|h| h.to_string()))
    })
}

/// Check if a cookie domain matches the filter.
#[cfg(target_os = "macos")]
pub(crate) fn matches_domain(cookie_domain: &Option<String>, filter: &str) -> bool {
    cookie_domain.as_ref().is_some_and(|d| {
        d.contains(filter)
            || filter.contains(d)
            || d.ends_with(&format!(".{}", filter))
            || filter.ends_with(&format!(".{}", d))
    })
}

/// Convert an NSString pointer to a Rust String.
///
/// Returns `None` if the pointer is null or if UTF-8 conversion fails.
///
/// # Safety
///
/// Caller must ensure `nsstring` is either null or a valid pointer to an NSString object.
/// The UTF8String selector returns a pointer to the string's internal buffer which is
/// valid for the lifetime of the NSString object.
#[cfg(target_os = "macos")]
pub unsafe fn nsstring_to_string(nsstring: *mut objc2::runtime::AnyObject) -> Option<String> {
    use objc2::msg_send;
    use std::ffi::CStr;

    if nsstring.is_null() {
        return None;
    }

    let utf8: *const i8 = msg_send![nsstring, UTF8String];
    if utf8.is_null() {
        return None;
    }

    CStr::from_ptr(utf8).to_str().ok().map(|s| s.to_string())
}

#[cfg(test)]
#[cfg(target_os = "macos")]
#[path = "tests/cookies_tests.rs"]
mod tests;
