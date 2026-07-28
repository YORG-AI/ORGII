use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};
// Host-managed popup window is only built on macOS/Linux; Windows uses the
// native WebView2 popup (NewWindowResponse::Allow) instead.
#[cfg(not(target_os = "windows"))]
use tauri::WebviewWindowBuilder;

use crate::agent_sessions::cli::platform_adapters::webview_session::{
    clear_oauth_browser_session_native, COMMON_OAUTH_SESSION_DOMAINS,
};

const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_CODE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CODE_OAUTH_USER_AGENT: &str = "claude-cli/2.1.78 (orgii, cli)";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_CODE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_CODE_SESSION_DOMAINS: &[&str] = &[
    "claude.ai",
    "claude.com",
    "platform.claude.com",
    "console.anthropic.com",
    "anthropic.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeOauthStartResponse {
    pub auth_url: String,
    pub state: String,
    pub code_verifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeOauthExchangeResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub account_metadata: Option<ClaudeCodeAccountMetadata>,
}

#[derive(Debug, Clone, Serialize)]
struct ClaudeCodeOauthExchangeRequest<'a> {
    grant_type: &'static str,
    code: &'a str,
    redirect_uri: &'static str,
    client_id: &'static str,
    code_verifier: &'a str,
    state: &'a str,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeAccountMetadata {
    pub email: Option<String>,
    pub organization_uuid: Option<String>,
    pub organization_name: Option<String>,
    pub organization_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileResponse {
    account: Option<ClaudeCodeOauthProfileAccount>,
    organization: Option<ClaudeCodeOauthProfileOrganization>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileAccount {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileOrganization {
    uuid: Option<String>,
    name: Option<String>,
    organization_type: Option<String>,
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

#[tauri::command]
pub async fn start_claude_code_oauth_login() -> Result<ClaudeCodeOauthStartResponse, String> {
    let state = random_base64url(32);
    let code_verifier = random_base64url(32);
    let code_challenge = pkce_challenge(&code_verifier);
    let auth_url = build_authorize_url(&state, &code_challenge)?;

    Ok(ClaudeCodeOauthStartResponse {
        auth_url,
        state,
        code_verifier,
    })
}

#[tauri::command]
pub async fn exchange_claude_code_oauth_code(
    code: String,
    state: String,
    expected_state: String,
    code_verifier: String,
) -> Result<ClaudeCodeOauthExchangeResponse, String> {
    if state != expected_state {
        return Err("OAuth state mismatch. Please restart sign-in.".to_string());
    }

    let cleaned_code = clean_authorization_code(&code);
    if cleaned_code.is_empty() {
        return Err("Authorization code is empty.".to_string());
    }

    let request_body = ClaudeCodeOauthExchangeRequest {
        grant_type: "authorization_code",
        code: &cleaned_code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: &code_verifier,
        state: &state,
    };

    exchange_code_for_tokens(&request_body).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_claude_code_oauth_webview(
    app: AppHandle,
    parent_window: String,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_window(&parent_window)
        .ok_or_else(|| format!("Parent window '{}' not found", parent_window))?;

    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    clear_claude_code_oauth_browser_session(&app);
    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

    let label_for_closure = label.clone();
    let app_for_closure = app.clone();
    let label_for_new_window = label.clone();
    let app_for_new_window = app.clone();
    let builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(url.parse().map_err(|err| format!("Invalid URL: {err}"))?),
    )
    .incognito(true)
    .auto_resize()
    .on_new_window(move |new_window_url, features| {
        let url_value = new_window_url.to_string();
        tracing::info!(url = %url_value, "[claude-code-oauth] new window requested");
        if is_google_accounts_url(&url_value) {
            // Windows: hand the popup to WebView2 natively. wry maps `Allow` to
            // `SetHandled(false)`, so WebView2 opens the popup as a real child of
            // the caller webview — preserving `window.opener` and the shared
            // session. Google's GIS popup needs that opener to postMessage the
            // credential back to claude.ai. The host-managed `Create` path below
            // uses a fresh environment with no opener, so on Windows the popup
            // renders but sign-in fails with "There was an error logging you in".
            #[cfg(target_os = "windows")]
            {
                let _ = &features; // unused on this platform
                tracing::info!(url = %url_value, "[claude-code-oauth] allowing native Google OAuth popup (Windows)");
                return tauri::webview::NewWindowResponse::Allow;
            }

            // macOS/Linux: WKWebView / WebKitGTK drive a host-created popup to the
            // requested URL and keep it related to the caller, so we manage it
            // ourselves and watch its navigation to auto-close on completion.
            #[cfg(not(target_os = "windows"))]
            {
                let popup_label =
                    format!("{}-popup-{}", label_for_new_window, random_base64url(6));
                let app_for_popup_navigation = app_for_new_window.clone();
                let app_for_popup_close = app_for_new_window.clone();
                let label_for_popup_navigation = label_for_new_window.clone();
                let popup_label_for_navigation = popup_label.clone();
                let ownership_observation =
                    perf_utils::begin_webview_ownership_observation(popup_label.clone());
                let builder = WebviewWindowBuilder::new(
                    &app_for_new_window,
                    popup_label,
                    WebviewUrl::External("about:blank".parse().expect("valid about:blank URL")),
                )
                .window_features(features)
                .title("Google Sign in")
                .inner_size(520.0, 640.0)
                .on_navigation(move |popup_navigation_url| {
                    let popup_url_value = popup_navigation_url.to_string();
                    let _ = app_for_popup_navigation.emit(
                        "claude-code-oauth-url-changed",
                        serde_json::json!({
                            "url": popup_url_value,
                            "webviewLabel": label_for_popup_navigation,
                        }),
                    );
                    if is_claude_code_callback_url(&popup_url_value)
                        || is_google_gsi_transform_url(&popup_url_value)
                    {
                        let close_delay_ms = if is_google_gsi_transform_url(&popup_url_value) {
                            1_000
                        } else {
                            300
                        };
                        let app_for_async_close = app_for_popup_close.clone();
                        let popup_label_for_async_close = popup_label_for_navigation.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(tokio::time::Duration::from_millis(close_delay_ms))
                                .await;
                            if let Some(popup) =
                                app_for_async_close.get_webview_window(&popup_label_for_async_close)
                            {
                                let _ = popup.close();
                            }
                        });
                    }
                    true
                });

                match builder.build() {
                    Ok(window) => {
                        ownership_observation.commit();
                        tracing::info!(url = %url_value, "[claude-code-oauth] created Google OAuth popup");
                        return tauri::webview::NewWindowResponse::Create { window };
                    }
                    Err(err) => {
                        tracing::warn!(url = %url_value, error = %err, "[claude-code-oauth] failed to create Google OAuth popup");
                        return tauri::webview::NewWindowResponse::Deny;
                    }
                }
            }
        }

        let _ = app_for_new_window.emit(
            "claude-code-oauth-navigate-new-window",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_new_window,
            }),
        );
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |navigation_url| {
        let url_value = navigation_url.to_string();

        let _ = app_for_closure.emit(
            "claude-code-oauth-url-changed",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_closure,
            }),
        );
        true
    });

    let ownership_observation = perf_utils::begin_webview_ownership_observation(label.clone());
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|err| format!("Failed to create webview: {err}"))?;
    ownership_observation.commit();

    Ok(())
}

#[tauri::command]
pub async fn close_claude_code_oauth_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|err| format!("Failed to close webview: {err}"))?;
    }
    Ok(())
}

fn clear_claude_code_oauth_browser_session(app: &AppHandle) {
    let domains: Vec<&str> = CLAUDE_CODE_SESSION_DOMAINS
        .iter()
        .chain(COMMON_OAUTH_SESSION_DOMAINS.iter())
        .copied()
        .collect();
    clear_oauth_browser_session_native(app, &domains);
}

fn is_google_accounts_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| url.domain() == Some("accounts.google.com"))
        .unwrap_or(false)
}

// Only used by the host-managed popup's navigation handler (macOS/Linux). On
// Windows the native WebView2 popup is unmanaged, so these are not referenced.
#[cfg(not(target_os = "windows"))]
fn is_claude_code_callback_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| url.as_str().starts_with(REDIRECT_URI))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn is_google_gsi_transform_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| url.domain() == Some("accounts.google.com") && url.path() == "/gsi/transform")
        .unwrap_or(false)
}

fn random_base64url(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn pkce_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn build_authorize_url(state: &str, code_challenge: &str) -> Result<String, String> {
    let mut url = url::Url::parse(AUTHORIZE_URL).map_err(|err| err.to_string())?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", CLAUDE_CODE_SCOPES)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.to_string())
}

fn clean_authorization_code(code: &str) -> String {
    code.split('#')
        .next()
        .unwrap_or(code)
        .split('&')
        .next()
        .unwrap_or(code)
        .trim()
        .to_string()
}

async fn exchange_code_for_tokens(
    request_body: &ClaudeCodeOauthExchangeRequest<'_>,
) -> Result<ClaudeCodeOauthExchangeResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Failed to build OAuth client: {err}"))?;

    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(request_body)
        .send()
        .await
        .map_err(|err| format!("Token exchange request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read token exchange response: {err}"))?;

    if !status.is_success() {
        let message = serde_json::from_str::<ClaudeCodeOauthErrorResponse>(&body)
            .ok()
            .and_then(|err| err.error_description.or(err.message).or(err.error))
            .unwrap_or_else(|| format!("Token exchange failed with HTTP {status}"));
        return Err(message);
    }

    let parsed: ClaudeCodeOauthTokenResponse = serde_json::from_str(&body)
        .map_err(|err| format!("Failed to parse token exchange response: {err}"))?;

    let account_metadata = fetch_claude_code_oauth_profile(&client, &parsed.access_token)
        .await
        .map_err(|err| {
            tracing::warn!(error = %err, "[claude-code-oauth] profile lookup failed; continuing without account metadata");
            err
        })
        .ok();

    Ok(ClaudeCodeOauthExchangeResponse {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_in: parsed.expires_in,
        token_type: parsed.token_type,
        scope: parsed.scope,
        account_metadata,
    })
}

async fn fetch_claude_code_oauth_profile(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<ClaudeCodeAccountMetadata, String> {
    let response = client
        .get(PROFILE_URL)
        .header("Authorization", format!("Bearer {}", access_token.trim()))
        .header("anthropic-beta", CLAUDE_CODE_OAUTH_BETA)
        .header("User-Agent", CLAUDE_CODE_OAUTH_USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("Claude Code OAuth profile request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Claude Code OAuth profile response: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Claude Code OAuth profile failed with HTTP {}: {}",
            status.as_u16(),
            body
        ));
    }

    parse_claude_code_oauth_profile_response(&body)
}

fn parse_claude_code_oauth_profile_response(
    body: &str,
) -> Result<ClaudeCodeAccountMetadata, String> {
    let parsed: ClaudeCodeOauthProfileResponse = serde_json::from_str(body)
        .map_err(|err| format!("Failed to parse Claude Code OAuth profile response: {err}"))?;
    let account = parsed.account;
    let organization = parsed.organization;
    Ok(ClaudeCodeAccountMetadata {
        email: account.and_then(|account| normalize_metadata_field(account.email)),
        organization_uuid: organization
            .as_ref()
            .and_then(|organization| normalize_metadata_field(organization.uuid.clone())),
        organization_name: organization
            .as_ref()
            .and_then(|organization| normalize_metadata_field(organization.name.clone())),
        organization_type: organization.as_ref().and_then(|organization| {
            normalize_metadata_field(organization.organization_type.clone())
        }),
        rate_limit_tier: organization
            .and_then(|organization| normalize_metadata_field(organization.rate_limit_tier)),
    })
}

fn normalize_metadata_field(value: Option<String>) -> Option<String> {
    value
        .map(|field| field.trim().to_string())
        .filter(|field| !field.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_rfc7636_s256() {
        let challenge = pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn authorize_url_contains_claude_code_oauth_params() {
        let url = build_authorize_url("state-value", "challenge-value").unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.as_str().split('?').next(), Some(AUTHORIZE_URL));
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some(REDIRECT_URI)
        );
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some("challenge-value")
        );
        assert_eq!(params.get("state").map(String::as_str), Some("state-value"));
        assert!(params
            .get("scope")
            .is_some_and(|scope| scope.contains("user:sessions:claude_code")));
    }

    #[test]
    fn clean_authorization_code_removes_query_tail_and_fragment() {
        assert_eq!(
            clean_authorization_code("abc123&state=ignored#fragment"),
            "abc123"
        );
    }

    #[test]
    fn google_accounts_urls_are_identified_for_native_popup() {
        assert!(is_google_accounts_url(
            "https://accounts.google.com/gsi/transform?client_id=abc"
        ));
        assert!(is_google_accounts_url(
            "https://accounts.google.com/signin/oauth/legacy/approval?authuser=0"
        ));
        assert!(!is_google_accounts_url(
            "https://platform.claude.com/oauth/code/callback?code=abc"
        ));
    }
}
