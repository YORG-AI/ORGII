//! Cursor Session Capture
//!
//! Specialized webview for Cursor native OAuth sign-in.
//! Opens Cursor's CLI login flow and polls for a native access token.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use crate::agent_sessions::cli::platform_adapters::webview_session::{
    clear_oauth_browser_session_native, COMMON_OAUTH_SESSION_DOMAINS,
};

// ============================================
// Constants
// ============================================

const CURSOR_SETTINGS_URL: &str = "https://www.cursor.com/settings";
const CURSOR_LOGIN_DEEP_CONTROL_URL: &str = "https://cursor.com/loginDeepControl";
const CURSOR_AUTH_POLL_URL: &str = "https://api2.cursor.sh/auth/poll";
const POLL_INTERVAL_SECS: u64 = 2;
const CURSOR_AUTH_POLL_MAX_ATTEMPTS: usize = 150;
const CURSOR_AUTH_POLL_BASE_DELAY_MS: u64 = 1_000;
const CURSOR_AUTH_POLL_MAX_DELAY_MS: u64 = 10_000;
const CURSOR_SESSION_DOMAINS: &[&str] = &[
    "cursor.com",
    "www.cursor.com",
    "cursor.sh",
    "authenticator.cursor.sh",
    "workos.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorNativeOauthStartResponse {
    pub login_url: String,
    pub uuid: String,
    pub verifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorNativeOauthPollResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorNativeOauthPollWireResponse {
    #[serde(alias = "access_token")]
    access_token: String,
    #[serde(default, alias = "refresh_token")]
    _refresh_token: Option<String>,
}

// ============================================
// Global State
// ============================================

/// Track active polling tasks for each webview
static ACTIVE_POLLERS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ============================================
// Commands
// ============================================

#[tauri::command]
pub async fn start_cursor_native_oauth_login() -> Result<CursorNativeOauthStartResponse, String> {
    let verifier = random_base64url(32);
    let challenge = pkce_challenge(&verifier);
    let uuid = uuid::Uuid::new_v4().to_string();
    let login_url = format!(
        "{}?challenge={}&uuid={}&mode=login&redirectTarget=cli",
        CURSOR_LOGIN_DEEP_CONTROL_URL, challenge, uuid
    );

    tracing::info!("[cursor-native-oauth] started login flow");

    Ok(CursorNativeOauthStartResponse {
        login_url,
        uuid,
        verifier,
    })
}

#[tauri::command]
pub async fn poll_cursor_native_oauth_token(
    uuid: String,
    verifier: String,
) -> Result<CursorNativeOauthPollResponse, String> {
    tracing::info!("[cursor-native-oauth] polling for token");
    let client = reqwest::Client::new();
    let mut delay_ms = CURSOR_AUTH_POLL_BASE_DELAY_MS;
    let mut consecutive_errors = 0usize;

    for attempt in 0..CURSOR_AUTH_POLL_MAX_ATTEMPTS {
        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;

        let response = client
            .get(CURSOR_AUTH_POLL_URL)
            .query(&[("uuid", uuid.as_str()), ("verifier", verifier.as_str())])
            .send()
            .await;

        match response {
            Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                if attempt % 10 == 0 {
                    tracing::info!(
                        attempt = attempt + 1,
                        "[cursor-native-oauth] token not ready yet"
                    );
                }
                consecutive_errors = 0;
                delay_ms = ((delay_ms as f64) * 1.2) as u64;
                delay_ms = delay_ms.min(CURSOR_AUTH_POLL_MAX_DELAY_MS);
            }
            Ok(response) if response.status().is_success() => {
                tracing::info!(
                    attempt = attempt + 1,
                    "[cursor-native-oauth] token poll succeeded"
                );
                let token = response
                    .json::<CursorNativeOauthPollWireResponse>()
                    .await
                    .map_err(|err| format!("Failed to parse Cursor OAuth response: {err}"))?;
                return Ok(CursorNativeOauthPollResponse {
                    access_token: token.access_token,
                });
            }
            Ok(response) => {
                tracing::warn!(
                    status = response.status().as_u16(),
                    "[cursor-native-oauth] token poll failed with HTTP status"
                );
                return Err(format!(
                    "Cursor OAuth poll failed: HTTP {}",
                    response.status()
                ));
            }
            Err(err) => {
                consecutive_errors += 1;
                if consecutive_errors >= 3 {
                    return Err(format!(
                        "Cursor OAuth polling failed after repeated errors: {err}"
                    ));
                }
            }
        }
    }

    Err("Cursor OAuth polling timed out".to_string())
}

/// Create a webview for Cursor native OAuth capture.
///
/// Uses an incognito webview so each guided setup starts from a clean browser
/// session, then polls Cursor's PKCE endpoint for the native access token.
///
/// # Events Emitted
/// - `cursor-session-token-captured`: When session token is detected
/// - `cursor-webview-url-changed`: When URL changes in webview
/// - `cursor-webview-navigate-oauth`: When OAuth URL needs navigation
#[allow(clippy::too_many_arguments)]
// Tauri exposes these parameters directly as the frontend command contract;
// grouping them would be a wire-protocol change.
#[tauri::command]
pub async fn create_cursor_session_webview(
    app: AppHandle,
    parent_window: String,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    url: Option<String>,
) -> Result<(), String> {
    tracing::info!(label = %label, "[cursor-session-webview] create requested");
    let window = app
        .get_window(&parent_window)
        .ok_or_else(|| format!("Parent window '{}' not found", parent_window))?;

    // Stop existing poller and destroy the previous webview so a new OAuth
    // attempt never reuses in-memory session state from the same inline label.
    stop_poller(&label);
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    clear_cursor_oauth_browser_session(&app);
    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

    let position = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(width, height));
    let initial_url = url.unwrap_or_else(|| CURSOR_SETTINGS_URL.to_string());
    let cursor_url: url::Url = initial_url
        .parse()
        .map_err(|err| format!("Invalid Cursor URL: {err}"))?;

    let label_for_closure = label.clone();
    let app_for_closure = app.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(cursor_url))
        .incognito(true)
        .auto_resize()
        .on_new_window(move |url, _| {
            let url_str = url.to_string();

            // Handle OAuth redirects
            let is_oauth = url_str.contains("accounts.google.com")
                || url_str.contains("github.com/login")
                || url_str.contains("login.microsoftonline.com")
                || url_str.contains("workos.com")
                || url_str.contains("authenticator.cursor.sh");

            if is_oauth {
                let _ = app_for_closure.emit(
                    "cursor-webview-navigate-oauth",
                    serde_json::json!({
                        "url": url_str,
                        "webviewLabel": label_for_closure
                    }),
                );
            }

            tauri::webview::NewWindowResponse::Deny
        });

    let ownership_observation = perf_utils::begin_webview_ownership_observation(label.clone());
    window
        .add_child(builder, position, size)
        .map_err(|e| format!("Failed to create webview: {}", e))?;
    ownership_observation.commit();
    tracing::info!(label = %label, "[cursor-session-webview] created new webview");

    // Start polling task
    start_token_poller(app, label);

    Ok(())
}

/// Poll for credentials (can be called manually from frontend)
#[tauri::command]
pub async fn poll_cursor_session(
    app: AppHandle,
    label: String,
) -> Result<serde_json::Value, String> {
    let webview = app.get_webview(&label).ok_or("Webview not found")?;

    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();

    // Try to get token via native cookie API
    let token = get_cursor_session_token(&app, &label).await;

    Ok(serde_json::json!({
        "url": url,
        "hasToken": token.is_some()
    }))
}

/// Stop credential polling and move the Cursor capture webview offscreen without destroying it.
#[tauri::command]
pub fn close_cursor_session_webview(app: AppHandle, label: String) -> Result<(), String> {
    tracing::info!(label = %label, "[cursor-session-webview] close requested");
    stop_poller(&label);

    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                -10_000.0, -10_000.0,
            )))
            .map_err(|err| format!("Failed to move Cursor webview offscreen: {err}"))?;
        webview
            .set_size(tauri::Size::Logical(tauri::LogicalSize::new(1.0, 1.0)))
            .map_err(|err| format!("Failed to shrink Cursor webview: {err}"))?;
    }

    Ok(())
}

/// Stop credential polling for a webview
#[tauri::command]
pub fn stop_cursor_session_polling(label: String) {
    stop_poller(&label);
}

/// Clear session and allow re-login with different account
#[tauri::command]
pub async fn clear_cursor_session(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app.get_webview(&label).ok_or("Webview not found")?;

    clear_cursor_oauth_browser_session(&app);

    // Clear non-HttpOnly cookies and storage via JS
    let clear_script = r#"
        document.cookie.split(';').forEach(c => {
            const name = c.trim().split('=')[0];
            document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
            document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.cursor.com';
        });
        localStorage.clear();
        sessionStorage.clear();
    "#;

    let _ = webview.eval(clear_script);
    let _ = webview.eval(format!("window.location.href = '{}';", CURSOR_SETTINGS_URL));

    Ok(())
}

fn clear_cursor_oauth_browser_session(app: &AppHandle) {
    let domains: Vec<&str> = CURSOR_SESSION_DOMAINS
        .iter()
        .chain(COMMON_OAUTH_SESSION_DOMAINS.iter())
        .copied()
        .collect();
    clear_oauth_browser_session_native(app, &domains);
}

fn random_base64url(bytes_len: usize) -> String {
    let mut bytes = vec![0u8; bytes_len];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// ============================================
// Internal Functions
// ============================================

/// Start the token polling task
fn start_token_poller(app: AppHandle, label: String) {
    let stop_flag = Arc::new(AtomicBool::new(false));

    {
        let mut pollers = ACTIVE_POLLERS.lock().unwrap();
        pollers.insert(label.clone(), stop_flag.clone());
    }

    tokio::spawn(async move {
        let mut last_url = String::new();
        let mut last_token: Option<String> = None;

        // Wait for webview initialization
        tokio::time::sleep(tokio::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let webview = match app.get_webview(&label) {
                Some(wv) => wv,
                None => break,
            };

            // Get current URL
            if let Ok(url) = webview.url() {
                let url_str = url.to_string();

                // Emit URL changes
                if url_str != last_url {
                    last_url = url_str.clone();
                    let _ = app.emit(
                        "cursor-webview-url-changed",
                        serde_json::json!({
                            "url": url_str,
                            "timestamp": chrono::Utc::now().timestamp_millis()
                        }),
                    );
                }

                // Try to capture token - emit if new or changed (account switch)
                if url_str.contains("cursor.com") {
                    if let Some(token) = get_cursor_session_token(&app, &label).await {
                        let is_new = last_token.as_ref() != Some(&token);
                        if is_new {
                            last_token = Some(token.clone());
                            let _ = app.emit(
                                "cursor-session-token-captured",
                                serde_json::json!({
                                    "token": token,
                                    "url": url_str,
                                    "timestamp": chrono::Utc::now().timestamp_millis()
                                }),
                            );
                        }
                    }
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }

        // Cleanup
        let mut pollers = ACTIVE_POLLERS.lock().unwrap();
        pollers.remove(&label);
    });
}

/// Stop an active poller
fn stop_poller(label: &str) {
    let mut pollers = ACTIVE_POLLERS.lock().unwrap();
    if let Some(stop_flag) = pollers.remove(label) {
        stop_flag.store(true, Ordering::SeqCst);
    }
}

/// Get Cursor session token from webview
///
/// Tries multiple methods:
/// 1. Shared cookie storage (NSHTTPCookieStorage)
/// 2. JavaScript cookie access (document.cookie)
/// 3. Login detection fallback
async fn get_cursor_session_token(app: &AppHandle, label: &str) -> Option<String> {
    // Method 1: Try shared cookie storage (might work if cookies are shared)
    let cookies = browser::get_webview_cookies(
        app.clone(),
        label.to_string(),
        Some("https://cursor.com".to_string()),
    )
    .await
    .ok();

    if let Some(ref cookie_list) = cookies {
        if let Some(token) = cookie_list
            .iter()
            .find(|c| c.name == "WorkosCursorSessionToken")
            .map(|c| c.value.clone())
        {
            return Some(token);
        }
    }

    // Method 2: Try reading cookie via JavaScript (works if not HttpOnly)
    let webview = app.get_webview(label)?;

    // Use JavaScript to read the session cookie directly
    let cookie_script = r#"
        (function() {
            try {
                const cookies = document.cookie.split(';');
                for (const cookie of cookies) {
                    const [name, ...valueParts] = cookie.trim().split('=');
                    if (name === 'WorkosCursorSessionToken') {
                        const value = valueParts.join('=');
                        if (value && window.__TAURI__) {
                            window.__TAURI__.event.emit('cursor-cookie-found', {
                                token: value,
                                source: 'javascript',
                                timestamp: Date.now()
                            });
                        }
                        return;
                    }
                }
            } catch (e) {
                console.error('[CursorCookie] Error reading cookie:', e);
            }
        })();
    "#;
    let _ = webview.eval(cookie_script);

    // Method 3: Use JavaScript to detect login state (fallback)
    let login_script = r#"
        (function() {
            try {
                const pageText = document.body?.innerText || '';
                const pageHtml = document.body?.innerHTML || '';

                // Look for email pattern (indicates logged in)
                const emailMatch = pageText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);

                // Check for logged-in UI elements (multiple patterns)
                const hasLogoutButton = /sign\s*out|log\s*out|logout/i.test(pageText);
                const hasApiKeysSection = /api\s*key|user\s*api/i.test(pageText);
                const hasSettingsMenu = /overview|settings|members|integrations/i.test(pageText);
                const hasDashboard = pageHtml.includes('/cn/dashboard') || pageHtml.includes('/settings');
                const hasAccountInfo = document.querySelector('[class*="user"]') !== null ||
                                       document.querySelector('[class*="account"]') !== null ||
                                       document.querySelector('[class*="avatar"]') !== null ||
                                       document.querySelector('[class*="profile"]') !== null;

                // Enterprise/Team indicators
                const hasEnterprise = /enterprise|team|organization/i.test(pageText);

                // Determine if user is logged in (more lenient)
                const isLoggedIn = !!(
                    emailMatch ||
                    hasLogoutButton ||
                    (hasApiKeysSection && hasAccountInfo) ||
                    (hasSettingsMenu && hasDashboard) ||
                    (hasEnterprise && hasAccountInfo)
                );

                if (isLoggedIn) {
                    const email = emailMatch ? emailMatch[1] : 'logged_in_user';
                    const timestamp = Date.now();
                    const pseudoToken = 'login_verified::' + btoa(email) + '::' + timestamp;

                    if (window.__TAURI__) {
                        window.__TAURI__.event.emit('cursor-login-detected', {
                            email: email,
                            pseudoToken: pseudoToken,
                            isLoggedIn: true,
                            timestamp: timestamp
                        });
                    }
                }
            } catch (e) {
                console.error('[CursorLogin] Detection error:', e);
            }
        })();
    "#;
    let _ = webview.eval(login_script);

    None
}
