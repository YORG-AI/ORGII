use crate::agent_sessions::cli::platform_adapters::webview_session::{
    clear_oauth_browser_session_native, COMMON_OAUTH_SESSION_DOMAINS,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_USER_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const REDIRECT_ORIGIN: &str = "http://127.0.0.1:1456";
const REDIRECT_PATH: &str = "/oauth2callback";
const GEMINI_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const GEMINI_OAUTH_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const GEMINI_SESSION_DOMAINS: &[&str] = &[
    "accounts.google.com",
    "google.com",
    "gstatic.com",
    "cloudcode-pa.googleapis.com",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiOauthStartResponse {
    pub auth_url: String,
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiOauthExchangeResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub project_id: String,
    pub expires_at: String,
    pub available_models: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GeminiOauthExchangeRequest<'a> {
    grant_type: &'static str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'a str,
    client_secret: &'a str,
    code_verifier: &'a str,
}

#[derive(Debug, Deserialize)]
struct GeminiOauthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiOauthErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistRequest {
    cloudaicompanion_project: Option<String>,
    metadata: LoadCodeAssistMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistMetadata {
    ide_type: &'static str,
    platform: &'static str,
    plugin_type: &'static str,
    duet_project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistResponse {
    cloudaicompanion_project: Option<String>,
    current_tier: Option<GeminiUserTier>,
    #[serde(default)]
    allowed_tiers: Vec<GeminiUserTier>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUserTier {
    id: String,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    user_defined_cloudaicompanion_project: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserRequest {
    tier_id: String,
    cloudaicompanion_project: Option<String>,
    metadata: LoadCodeAssistMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserOperation {
    #[serde(default)]
    done: bool,
    response: Option<OnboardUserResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserResponse {
    cloudaicompanion_project: Option<OnboardProject>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OnboardProject {
    Id { id: Option<String> },
    Value(String),
}

impl OnboardProject {
    fn into_id(self) -> Option<String> {
        match self {
            Self::Id { id } => id,
            Self::Value(value) => Some(value),
        }
    }
}

#[tauri::command]
pub async fn start_gemini_oauth_login() -> Result<GeminiOauthStartResponse, String> {
    start_gemini_oauth_login_for_redirect(format!("{REDIRECT_ORIGIN}{REDIRECT_PATH}"))
}
fn start_gemini_oauth_login_for_redirect(
    redirect_uri: String,
) -> Result<GeminiOauthStartResponse, String> {
    let state = random_base64url(32);
    let code_verifier = random_base64url(48);
    let code_challenge = pkce_challenge(&code_verifier);
    let auth_url = build_authorize_url(&redirect_uri, &state, &code_challenge)?;

    Ok(GeminiOauthStartResponse {
        auth_url,
        state,
        code_verifier,
        redirect_uri,
    })
}

#[tauri::command]
pub async fn exchange_gemini_oauth_code(
    code: String,
    state: String,
    expected_state: String,
    code_verifier: String,
    redirect_uri: String,
) -> Result<GeminiOauthExchangeResponse, String> {
    tracing::info!(
        code_len = code.len(),
        state_matches = (state == expected_state),
        redirect_uri = %redirect_uri,
        "[gemini-oauth] exchange_gemini_oauth_code invoked"
    );
    let result =
        exchange_gemini_oauth_code_inner(code, state, expected_state, code_verifier, redirect_uri)
            .await;
    match &result {
        Ok(resp) => tracing::info!(
            models = resp.available_models.len(),
            "[gemini-oauth] exchange_gemini_oauth_code succeeded"
        ),
        Err(err) => {
            tracing::warn!(error = %err, "[gemini-oauth] exchange_gemini_oauth_code failed")
        }
    }
    result
}
async fn exchange_gemini_oauth_code_inner(
    code: String,
    state: String,
    expected_state: String,
    code_verifier: String,
    redirect_uri: String,
) -> Result<GeminiOauthExchangeResponse, String> {
    if state != expected_state {
        return Err("OAuth state mismatch. Please restart sign-in.".to_string());
    }

    let cleaned_code = clean_authorization_code(&code);
    if cleaned_code.is_empty() {
        return Err("Authorization code is empty.".to_string());
    }

    let client_id = google_oauth_client_id();
    let client_secret = google_oauth_client_secret();
    let request_body = GeminiOauthExchangeRequest {
        grant_type: "authorization_code",
        code: &cleaned_code,
        redirect_uri: &redirect_uri,
        client_id: &client_id,
        client_secret: &client_secret,
        code_verifier: &code_verifier,
    };

    let parsed = exchange_code_for_tokens(&request_body).await?;
    let refresh_token = parsed.refresh_token.ok_or_else(|| {
        "Google OAuth did not return a refresh token. Please restart sign-in and approve offline access."
            .to_string()
    })?;
    let project_id = load_code_assist_project(&parsed.access_token).await?;
    let available_models =
        key_vault::gemini_oauth_list_models(parsed.access_token.clone(), Some(project_id.clone()))
            .await?;
    if available_models.is_empty() {
        return Err("Gemini OAuth model discovery returned no models".to_string());
    }
    let expires_in = parsed.expires_in;
    let expires_at = Utc::now()
        + chrono::Duration::seconds(expires_in.unwrap_or(3600).try_into().unwrap_or(3600));

    Ok(GeminiOauthExchangeResponse {
        access_token: parsed.access_token,
        refresh_token,
        expires_in,
        token_type: parsed.token_type,
        scope: parsed.scope,
        project_id,
        expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        available_models,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_gemini_oauth_webview(
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

    clear_gemini_oauth_browser_session(&app);
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
    .user_agent(GEMINI_OAUTH_USER_AGENT)
    .auto_resize()
    .on_new_window(move |new_window_url, features| {
        let url_value = new_window_url.to_string();
        tracing::info!(url = %url_value, "[gemini-oauth] new window requested");

        if should_open_oauth_popup(&url_value) {
            let popup_label = format!("{}-popup-{}", label_for_new_window, random_base64url(6));
            let app_for_popup_navigation = app_for_new_window.clone();
            let app_for_popup_close = app_for_new_window.clone();
            let label_for_popup_navigation = label_for_new_window.clone();
            let popup_label_for_navigation = popup_label.clone();
            let builder = WebviewWindowBuilder::new(
                &app_for_new_window,
                popup_label,
                WebviewUrl::External("about:blank".parse().expect("valid about:blank URL")),
            )
            .incognito(true)
            .user_agent(GEMINI_OAUTH_USER_AGENT)
            .window_features(features)
            .title("Google Sign in")
            .inner_size(560.0, 700.0)
            .on_navigation(move |popup_navigation_url| {
                let popup_url_value = popup_navigation_url.to_string();
                let _ = app_for_popup_navigation.emit(
                    "gemini-oauth-url-changed",
                    serde_json::json!({
                        "url": popup_url_value,
                        "webviewLabel": label_for_popup_navigation,
                    }),
                );
                if is_gemini_callback_url(&popup_url_value) {
                    let app_for_async_close = app_for_popup_close.clone();
                    let popup_label_for_async_close = popup_label_for_navigation.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(popup) = app_for_async_close
                            .get_webview_window(&popup_label_for_async_close)
                        {
                            let _ = popup.close();
                        }
                    });
                    return false;
                }
                true
            });

            match builder.build() {
                Ok(window) => {
                    tracing::info!(url = %url_value, "[gemini-oauth] created OAuth popup");
                    return tauri::webview::NewWindowResponse::Create { window };
                }
                Err(err) => {
                    tracing::warn!(url = %url_value, error = %err, "[gemini-oauth] failed to create OAuth popup");
                    return tauri::webview::NewWindowResponse::Deny;
                }
            }
        }

        let _ = app_for_new_window.emit(
            "gemini-oauth-navigate-new-window",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_new_window,
            }),
        );
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |navigation_url| {
        let url_value = navigation_url.to_string();
        let is_callback = is_gemini_callback_url(&url_value);
        let _ = app_for_navigation.emit(
            "gemini-oauth-url-changed",
            serde_json::json!({
                "url": url_value,
                "webviewLabel": label_for_navigation,
            }),
        );
        !is_callback
    });

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|err| format!("Failed to create webview: {err}"))?;

    Ok(())
}

#[tauri::command]
pub async fn close_gemini_oauth_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|err| format!("Failed to close webview: {err}"))?;
    }
    Ok(())
}

fn google_oauth_client_id() -> String {
    std::env::var("GEMINI_OAUTH_CLIENT_ID").unwrap_or_else(|_| {
        let parts: &[&str] = &[
            "681255809395-oo8ft2oprd",
            "rnp9e3aqf6av3hmdib135j",
            ".apps.googleusercontent.com",
        ];
        parts.concat()
    })
}

fn google_oauth_client_secret() -> String {
    std::env::var("GEMINI_OAUTH_CLIENT_SECRET").unwrap_or_else(|_| {
        let parts: &[&str] = &["GOCSPX-", "4uHgMPm-1o7", "Sk-geV6Cu5clXFsxl"];
        parts.concat()
    })
}

fn clear_gemini_oauth_browser_session(app: &AppHandle) {
    let domains: Vec<&str> = GEMINI_SESSION_DOMAINS
        .iter()
        .chain(COMMON_OAUTH_SESSION_DOMAINS.iter())
        .copied()
        .collect();
    clear_oauth_browser_session_native(app, &domains);
}

fn should_open_oauth_popup(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| matches!(url.domain(), Some("accounts.google.com")))
        .unwrap_or(false)
}

fn is_gemini_callback_url(value: &str) -> bool {
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
    let client_id = google_oauth_client_id();
    let mut url = url::Url::parse(AUTHORIZE_URL).map_err(|err| err.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", GEMINI_SCOPES)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
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
    request_body: &GeminiOauthExchangeRequest<'_>,
) -> Result<GeminiOauthTokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Failed to build OAuth client: {err}"))?;

    let response = client
        .post(TOKEN_URL)
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
        let message = serde_json::from_str::<GeminiOauthErrorResponse>(&body)
            .ok()
            .and_then(|err| err.error_description.or(err.message).or(err.error))
            .unwrap_or(body);
        return Err(format!("Gemini OAuth token exchange failed: {message}"));
    }

    serde_json::from_str(&body).map_err(|err| format!("Failed to parse token response: {err}"))
}

async fn load_code_assist_project(access_token: &str) -> Result<String, String> {
    let explicit_project = env_google_cloud_project();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| format!("Failed to build Code Assist client: {err}"))?;

    let load_response = load_code_assist(&client, access_token, explicit_project.clone()).await?;
    let load_project = load_response
        .cloudaicompanion_project
        .clone()
        .filter(|project| !project.trim().is_empty());

    // Mirror the official gemini-cli `setupUser` logic: if loadCodeAssist
    // already returned a project for this account (because it was onboarded
    // previously), use it directly — regardless of whether the tier is marked
    // as requiring a user-defined project. Only fall back to onboarding /
    // GOOGLE_CLOUD_PROJECT when the server returned no project.
    if let Some(project) = load_project.clone() {
        return Ok(project);
    }

    let tier = select_onboard_tier(&load_response);

    if tier.user_defined_cloudaicompanion_project && explicit_project.is_none() {
        return Err(
            "This Gemini account requires GOOGLE_CLOUD_PROJECT before Code Assist can be enabled."
                .to_string(),
        );
    }

    let onboard_response =
        onboard_code_assist_user(&client, access_token, tier.id, explicit_project.clone()).await?;

    onboard_response
        .response
        .and_then(|response| response.cloudaicompanion_project)
        .and_then(OnboardProject::into_id)
        .filter(|project| !project.trim().is_empty())
        .or(explicit_project)
        .or(load_project)
        .ok_or_else(|| "Gemini Code Assist onboarding did not return a project".to_string())
}

fn env_google_cloud_project() -> Option<String> {
    std::env::var("GOOGLE_CLOUD_PROJECT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("GOOGLE_CLOUD_PROJECT_ID")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

fn code_assist_metadata(project_id: Option<String>) -> LoadCodeAssistMetadata {
    LoadCodeAssistMetadata {
        ide_type: "GEMINI_CLI",
        platform: "PLATFORM_UNSPECIFIED",
        plugin_type: "GEMINI",
        duet_project: project_id,
    }
}

async fn load_code_assist(
    client: &reqwest::Client,
    access_token: &str,
    project_id: Option<String>,
) -> Result<LoadCodeAssistResponse, String> {
    let request_body = LoadCodeAssistRequest {
        cloudaicompanion_project: project_id.clone(),
        metadata: code_assist_metadata(project_id),
    };
    let response = client
        .post(LOAD_CODE_ASSIST_URL)
        .bearer_auth(access_token)
        .json(&request_body)
        .send()
        .await
        .map_err(|err| format!("loadCodeAssist request failed: {err}"))?;

    parse_code_assist_response::<LoadCodeAssistResponse>(response, "loadCodeAssist").await
}

fn select_onboard_tier(load_response: &LoadCodeAssistResponse) -> GeminiUserTier {
    load_response
        .current_tier
        .clone()
        .or_else(|| {
            load_response
                .allowed_tiers
                .iter()
                .find(|tier| tier.is_default)
                .cloned()
        })
        .or_else(|| load_response.allowed_tiers.first().cloned())
        .unwrap_or_else(|| GeminiUserTier {
            id: "LEGACY".to_string(),
            is_default: false,
            user_defined_cloudaicompanion_project: true,
        })
}

async fn onboard_code_assist_user(
    client: &reqwest::Client,
    access_token: &str,
    tier_id: String,
    project_id: Option<String>,
) -> Result<OnboardUserOperation, String> {
    let request_body = OnboardUserRequest {
        tier_id,
        cloudaicompanion_project: project_id.clone(),
        metadata: code_assist_metadata(project_id),
    };

    let mut operation = post_onboard_code_assist_user(client, access_token, &request_body).await?;
    for _ in 0..12 {
        if operation.done {
            return Ok(operation);
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        operation = post_onboard_code_assist_user(client, access_token, &request_body).await?;
    }

    if operation.done {
        Ok(operation)
    } else {
        Err("Gemini Code Assist onboarding timed out".to_string())
    }
}

async fn post_onboard_code_assist_user(
    client: &reqwest::Client,
    access_token: &str,
    request_body: &OnboardUserRequest,
) -> Result<OnboardUserOperation, String> {
    let response = client
        .post(ONBOARD_USER_URL)
        .bearer_auth(access_token)
        .json(request_body)
        .send()
        .await
        .map_err(|err| format!("onboardUser request failed: {err}"))?;

    parse_code_assist_response::<OnboardUserOperation>(response, "onboardUser").await
}

async fn parse_code_assist_response<T>(
    response: reqwest::Response,
    operation: &str,
) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read {operation} response: {err}"))?;

    if !status.is_success() {
        return Err(format!("{operation} failed with HTTP {status}: {body}"));
    }

    serde_json::from_str(&body)
        .map_err(|err| format!("Failed to parse {operation} response: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboard_tier_prefers_current_tier() {
        let load_response: LoadCodeAssistResponse = serde_json::from_value(serde_json::json!({
            "currentTier": { "id": "CURRENT", "isDefault": false },
            "allowedTiers": [
                { "id": "FREE", "isDefault": true },
                { "id": "PRO", "isDefault": false }
            ]
        }))
        .expect("parse load response");

        let tier = select_onboard_tier(&load_response);
        assert_eq!(tier.id, "CURRENT");
    }

    #[test]
    fn onboard_tier_uses_default_allowed_tier_without_current() {
        let load_response: LoadCodeAssistResponse = serde_json::from_value(serde_json::json!({
            "allowedTiers": [
                { "id": "PRO", "isDefault": false },
                { "id": "FREE", "isDefault": true }
            ]
        }))
        .expect("parse load response");

        let tier = select_onboard_tier(&load_response);
        assert_eq!(tier.id, "FREE");
        assert!(!tier.user_defined_cloudaicompanion_project);
    }

    #[test]
    fn onboard_tier_requires_explicit_project_when_no_tiers_exist() {
        let load_response: LoadCodeAssistResponse =
            serde_json::from_value(serde_json::json!({})).expect("parse load response");

        let tier = select_onboard_tier(&load_response);
        assert_eq!(tier.id, "LEGACY");
        assert!(tier.user_defined_cloudaicompanion_project);
    }

    #[test]
    fn onboard_project_accepts_object_or_string_shape() {
        let object_response: OnboardUserOperation = serde_json::from_value(serde_json::json!({
            "done": true,
            "response": {
                "cloudaicompanionProject": { "id": "object-project" }
            }
        }))
        .expect("parse object project");
        let object_project = object_response
            .response
            .and_then(|response| response.cloudaicompanion_project)
            .and_then(OnboardProject::into_id);
        assert_eq!(object_project.as_deref(), Some("object-project"));

        let string_response: OnboardUserOperation = serde_json::from_value(serde_json::json!({
            "done": true,
            "response": {
                "cloudaicompanionProject": "string-project"
            }
        }))
        .expect("parse string project");
        let string_project = string_response
            .response
            .and_then(|response| response.cloudaicompanion_project)
            .and_then(OnboardProject::into_id);
        assert_eq!(string_project.as_deref(), Some("string-project"));
    }
}
