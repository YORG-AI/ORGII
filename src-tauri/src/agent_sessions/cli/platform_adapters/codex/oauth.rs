use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::agent_sessions::cli::platform_adapters::webview_session::{
    clear_oauth_browser_session_native, COMMON_OAUTH_SESSION_DOMAINS,
};

const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_ORIGIN: &str = "http://localhost:1455";
const REDIRECT_PATH: &str = "/auth/callback";
const CODEX_SCOPES: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_SESSION_DOMAINS: &[&str] = &[
    "auth.openai.com",
    "chatgpt.com",
    "chat.openai.com",
    "openai.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOauthStartResponse {
    pub auth_url: String,
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOauthExchangeResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
struct CodexOauthExchangeRequest<'a> {
    grant_type: &'static str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'static str,
    code_verifier: &'a str,
}

#[derive(Debug, Deserialize)]
struct CodexOauthTokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexOauthErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

#[tauri::command]
pub async fn start_codex_oauth_login() -> Result<CodexOauthStartResponse, String> {
    let state = random_base64url(32);
    let code_verifier = random_base64url(32);
    let code_challenge = pkce_challenge(&code_verifier);
    let redirect_uri = format!("{REDIRECT_ORIGIN}{REDIRECT_PATH}");
    let auth_url = build_authorize_url(&redirect_uri, &state, &code_challenge)?;

    Ok(CodexOauthStartResponse {
        auth_url,
        state,
        code_verifier,
        redirect_uri,
    })
}

#[tauri::command]
pub async fn exchange_codex_oauth_code(
    code: String,
    state: String,
    expected_state: String,
    code_verifier: String,
    redirect_uri: String,
) -> Result<CodexOauthExchangeResponse, String> {
    if state != expected_state {
        return Err("OAuth state mismatch. Please restart sign-in.".to_string());
    }

    let cleaned_code = clean_authorization_code(&code);
    if cleaned_code.is_empty() {
        return Err("Authorization code is empty.".to_string());
    }

    let request_body = CodexOauthExchangeRequest {
        grant_type: "authorization_code",
        code: &cleaned_code,
        redirect_uri: &redirect_uri,
        client_id: CLIENT_ID,
        code_verifier: &code_verifier,
    };

    exchange_code_for_tokens(&request_body).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_codex_oauth_webview(
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

    clear_codex_oauth_browser_session(&app);
    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

    let label_for_navigation = label.clone();
    let app_for_navigation = app.clone();
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
        tracing::info!(url = %url_value, "[codex-oauth] new window requested");

        if should_open_oauth_popup(&url_value) {
            let popup_label = format!("{}-popup-{}", label_for_new_window, random_base64url(6));
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
            .title("OpenAI Sign in")
            .inner_size(560.0, 700.0)
            .on_navigation(move |popup_navigation_url| {
                let popup_url_value = popup_navigation_url.to_string();
                let _ = app_for_popup_navigation.emit(
                    "codex-oauth-url-changed",
                    serde_json::json!({
                        "url": popup_url_value,
                        "webviewLabel": label_for_popup_navigation,
                    }),
                );
                if is_codex_callback_url(&popup_url_value) {
                    let app_for_async_close = app_for_popup_close.clone();
                    let popup_label_for_async_close = popup_label_for_navigation.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
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
                    tracing::info!(url = %url_value, "[codex-oauth] created OAuth popup");
                    return tauri::webview::NewWindowResponse::Create { window };
                }
                Err(err) => {
                    tracing::warn!(url = %url_value, error = %err, "[codex-oauth] failed to create OAuth popup");
                    return tauri::webview::NewWindowResponse::Deny;
                }
            }
        }

        let _ = app_for_new_window.emit(
            "codex-oauth-navigate-new-window",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_new_window,
            }),
        );
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |navigation_url| {
        let url_value = navigation_url.to_string();
        let _ = app_for_navigation.emit(
            "codex-oauth-url-changed",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_navigation,
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
pub async fn close_codex_oauth_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|err| format!("Failed to close webview: {err}"))?;
    }
    Ok(())
}

fn clear_codex_oauth_browser_session(app: &AppHandle) {
    let domains: Vec<&str> = CODEX_SESSION_DOMAINS
        .iter()
        .chain(COMMON_OAUTH_SESSION_DOMAINS.iter())
        .copied()
        .collect();
    clear_oauth_browser_session_native(app, &domains);
}

fn should_open_oauth_popup(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| {
            matches!(
                url.domain(),
                Some("accounts.google.com")
                    | Some("login.microsoftonline.com")
                    | Some("github.com")
            )
        })
        .unwrap_or(false)
}

fn is_codex_callback_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| {
            url.as_str()
                .starts_with(&format!("{REDIRECT_ORIGIN}{REDIRECT_PATH}"))
        })
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

fn build_authorize_url(
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(AUTHORIZE_URL).map_err(|err| err.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", CODEX_SCOPES)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", "codex_cli_rs");
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
    request_body: &CodexOauthExchangeRequest<'_>,
) -> Result<CodexOauthExchangeResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Failed to build OAuth client: {err}"))?;

    let response = client
        .post(TOKEN_URL)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .form(request_body)
        .send()
        .await
        .map_err(|err| format!("Token exchange request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read token exchange response: {err}"))?;

    if !status.is_success() {
        let message = serde_json::from_str::<CodexOauthErrorResponse>(&body)
            .ok()
            .and_then(|err| err.error_description.or(err.message).or(err.error))
            .unwrap_or_else(|| format!("Token exchange failed with HTTP {status}"));
        return Err(message);
    }

    let parsed: CodexOauthTokenResponse = serde_json::from_str(&body)
        .map_err(|err| format!("Failed to parse token exchange response: {err}"))?;

    Ok(CodexOauthExchangeResponse {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        id_token: parsed.id_token,
        expires_in: parsed.expires_in,
        token_type: parsed.token_type,
        scope: parsed.scope,
    })
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
    fn authorize_url_contains_codex_oauth_params() {
        let url = build_authorize_url(
            "http://localhost:1455/auth/callback",
            "state-value",
            "challenge-value",
        )
        .unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.as_str().split('?').next(), Some(AUTHORIZE_URL));
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some("http://localhost:1455/auth/callback")
        );
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some("challenge-value")
        );
        assert_eq!(params.get("state").map(String::as_str), Some("state-value"));
        assert_eq!(
            params.get("codex_cli_simplified_flow").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            params.get("originator").map(String::as_str),
            Some("codex_cli_rs")
        );
    }

    #[test]
    fn clean_authorization_code_removes_query_tail_and_fragment() {
        assert_eq!(
            clean_authorization_code("abc123&state=ignored#fragment"),
            "abc123"
        );
    }
}
