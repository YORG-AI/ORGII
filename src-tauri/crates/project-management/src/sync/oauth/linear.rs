//! Linear OAuth — Authorization Code grant with PKCE + loopback.
//!
//! Linear (`https://linear.app`) does not implement RFC 8628 device
//! flow. The desktop client therefore runs the standard
//! authorization-code grant with a PKCE code challenge and a fixed
//! loopback redirect URI on `http://localhost:45445/callback`. No
//! `client_secret` is embedded in the binary — Linear allows omitting
//! it when the request includes `code_verifier`, matching the
//! security posture of Slack / Notion / Linear's own desktop apps.
//!
//! ## Flow shape
//!
//! 1. [`start_auth_flow`] generates a 32-byte `state` and a 64-byte
//!    `code_verifier` (both base64url), hashes the verifier into a
//!    `code_challenge`, reserves the fixed callback port, and composes
//!    the `https://linear.app/oauth/authorize?...` URL the user opens
//!    in their browser.
//! 2. The Tauri command parks the descriptor in a process-local
//!    pending-flow registry (so `state` + `code_verifier` never cross
//!    the IPC boundary), then opens `authorize_url` in the user's
//!    default browser.
//! 3. [`await_callback`] spawns an axum loopback on the fixed port
//!    and resolves with the `code` query param when Linear redirects
//!    the user back to `http://localhost:45445/callback?code=...`.
//!    State mismatch returns [`PollOutcome::PollFailed`]; nobody but
//!    Linear should be hitting that port, but we still verify.
//! 4. [`exchange_code`] POSTs to `https://api.linear.app/oauth/token`
//!    with `grant_type=authorization_code`, the `code`, the
//!    `code_verifier`, the matching `redirect_uri`, and the
//!    `client_id`. The response carries `access_token` +
//!    `refresh_token` + `expires_in` (24h on Linear's side).
//! 5. [`refresh`] re-issues the bearer using `grant_type=refresh_token`
//!    against the same endpoint when the worker discovers the stored
//!    bearer is within 60 seconds of its `expires_at`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(debug_assertions)]
use std::sync::{LazyLock, RwLock};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::super::connection_token_store::{ConnectionTokenRecord, SOURCE_OAUTH_REDIRECT};
use super::{OAuthFlowStart, PollOutcome};

const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const PRODUCTION_TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const DEFAULT_CLIENT_ID: &str = "1f34d894fec6773a9a037552eb152ab7";
const REDIRECT_HOST: &str = "localhost";
const REDIRECT_PORT: u16 = 45445;
const REDIRECT_PATH: &str = "/callback";

/// Process-local override for the Linear OAuth `/oauth/token` URL,
/// only present in debug builds. The e2e debug binary stands up a
/// fake token endpoint inside the backend (`/agent/test/sync/oauth/...`
/// debug routes) and points the production code at it via
/// [`set_test_token_endpoint`] so [`exchange_code`] / [`refresh`]
/// don't have to grow extra parameters.
///
/// `None` means "use [`PRODUCTION_TOKEN_URL`] verbatim". Setting it
/// rebinds every subsequent call until the override is cleared with
/// `set_test_token_endpoint(None)`. The unit tests in `linear_tests.rs`
/// use a separate function-parameter mechanism
/// ([`exchange_code_with_endpoint`] / [`refresh_with_endpoint`]) — this
/// override is purely the seam the e2e binary needs.
#[cfg(debug_assertions)]
static TEST_TOKEN_ENDPOINT: LazyLock<RwLock<Option<String>>> = LazyLock::new(|| RwLock::new(None));

/// Process-local override for [`configured_client_id`], only present
/// in debug builds. The e2e binary calls [`set_test_client_id`] to
/// install a synthetic client id so flows can run without the
/// production `ORGII_LINEAR_OAUTH_CLIENT_ID` build env being set
/// (CI / dev machines typically don't have it). Falls back to
/// [`configured_client_id`] on `None`.
#[cfg(debug_assertions)]
static TEST_CLIENT_ID: LazyLock<RwLock<Option<String>>> = LazyLock::new(|| RwLock::new(None));

/// Install (or clear) the test override for Linear's token endpoint.
/// Debug-only — release builds compile this out entirely. Pass
/// `Some(url)` to redirect both `exchange_code` and `refresh` at the
/// caller-supplied mock; pass `None` to fall back to the production
/// URL on subsequent calls.
#[cfg(debug_assertions)]
pub fn set_test_token_endpoint(url: Option<String>) {
    if let Ok(mut guard) = TEST_TOKEN_ENDPOINT.write() {
        *guard = url;
    }
}

/// Install (or clear) the test override for the Linear OAuth client
/// id. Debug-only. The e2e binary uses this so it can drive the
/// PKCE + refresh flows without depending on the production
/// `ORGII_LINEAR_OAUTH_CLIENT_ID` build env being set. Read by
/// [`effective_client_id`].
#[cfg(debug_assertions)]
pub fn set_test_client_id(client_id: Option<String>) {
    if let Ok(mut guard) = TEST_CLIENT_ID.write() {
        *guard = client_id;
    }
}

/// Resolve the client id to send on `/oauth/token` requests. In
/// release builds this is just [`configured_client_id`]; in debug
/// builds the [`TEST_CLIENT_ID`] override wins so e2e scenarios can
/// run without the production env var set.
pub fn effective_client_id() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(guard) = TEST_CLIENT_ID.read() {
            if let Some(value) = guard.as_ref() {
                return Some(value.clone());
            }
        }
    }
    configured_client_id().map(|raw| raw.to_string())
}

/// Resolve the URL [`exchange_code`] / [`refresh`] should POST to.
/// In release builds this is a constant-folded `&'static str`; in
/// debug builds it consults [`TEST_TOKEN_ENDPOINT`] first and falls
/// back to the production URL when the override is not set.
fn token_endpoint() -> String {
    #[cfg(debug_assertions)]
    {
        if let Ok(guard) = TEST_TOKEN_ENDPOINT.read() {
            if let Some(url) = guard.as_ref() {
                return url.clone();
            }
        }
    }
    PRODUCTION_TOKEN_URL.to_string()
}
/// Linear's authorize-url has its own TTL (~10 min) and the loopback
/// listener should not outlive the user's patience either; one
/// timeout governs both halves.
const FLOW_TIMEOUT_SECS: u64 = 10 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = concat!("orgii-sync-oauth/", env!("CARGO_PKG_VERSION"));
/// Comma-separated list of Linear OAuth scopes. `read` + `write`
/// covers issue CRUD; `issues:create` is required to create issues
/// on behalf of the user (it is not implied by `write`).
const SCOPES: &str = "read,write,issues:create";

/// Linear OAuth client id. The public default identifies ORGII's
/// PKCE application and can be shipped in an open-source desktop app.
/// `ORGII_LINEAR_OAUTH_CLIENT_ID` remains available for development
/// builds that need to point at a different Linear OAuth app.
pub fn configured_client_id() -> Option<&'static str> {
    match option_env!("ORGII_LINEAR_OAUTH_CLIENT_ID") {
        Some(raw) if !raw.is_empty() => Some(raw),
        _ => Some(DEFAULT_CLIENT_ID),
    }
}

/// Internal descriptor stashed in `commands/sync.rs::PENDING_FLOWS`
/// so the secret PKCE state never crosses the IPC boundary. The
/// public form is [`OAuthFlowStart::Redirect`].
#[derive(Debug, Clone)]
pub struct RedirectFlowDescriptor {
    pub state: String,
    pub code_verifier: String,
    pub port: u16,
    pub redirect_uri: String,
    pub authorize_url: String,
    pub expires_at: DateTime<Utc>,
}

impl RedirectFlowDescriptor {
    pub fn to_public(&self) -> OAuthFlowStart {
        OAuthFlowStart::Redirect {
            authorize_url: self.authorize_url.clone(),
            expires_at_unix: self.expires_at.timestamp(),
        }
    }
}

fn http_client() -> Result<Client, String> {
    #[cfg(test)]
    crate::test_support::install_crypto_provider_for_tests();

    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|err| format!("reqwest build failed: {}", err))
}

fn random_base64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Build a fresh PKCE descriptor and reserve the fixed Linear loopback
/// callback port. The browser is opened by the caller (`commands/sync.rs`).
/// This function only manufactures the descriptor.
pub async fn start_auth_flow(client_id: &str) -> Result<RedirectFlowDescriptor, String> {
    if client_id.is_empty() {
        return Err("Linear OAuth client id is empty".to_string());
    }

    let state = random_base64url(32);
    let code_verifier = random_base64url(64);
    let code_challenge = pkce_challenge(&code_verifier);

    let listener = TcpListener::bind((REDIRECT_HOST, REDIRECT_PORT))
        .await
        .map_err(|err| format!("loopback bind failed: {}", err))?;
    drop(listener);

    let port = REDIRECT_PORT;
    let redirect_uri = format!("http://{REDIRECT_HOST}:{REDIRECT_PORT}{REDIRECT_PATH}");
    let authorize_url = format!(
        "{base}?response_type=code&client_id={client_id}&redirect_uri={redirect}&scope={scope}&state={state}&code_challenge={challenge}&code_challenge_method=S256&actor=user&prompt=consent",
        base = AUTHORIZE_URL,
        client_id = urlencoding::encode(client_id),
        redirect = urlencoding::encode(&redirect_uri),
        scope = urlencoding::encode(SCOPES),
        state = urlencoding::encode(&state),
        challenge = urlencoding::encode(&code_challenge),
    );

    let expires_at = Utc::now() + chrono::Duration::seconds(FLOW_TIMEOUT_SECS as i64);

    Ok(RedirectFlowDescriptor {
        state,
        code_verifier,
        port,
        redirect_uri,
        authorize_url,
        expires_at,
    })
}

/// Wait for Linear to redirect the user back to the fixed callback URL.
/// Resolves with the `code` on state-match, or a [`PollOutcome`] error
/// variant otherwise.
///
/// The loopback listens on the exact port advertised in `start_auth_flow`.
/// Three terminal cases:
///
/// - Successful callback with matching `state` → `Ok(code)`.
/// - Mismatched / missing `state` or `code` →
///   `Err(PollOutcome::PollFailed)`.
/// - Cancellation token fires → `Err(PollOutcome::Cancelled)`.
/// - 10-minute timer fires → `Err(PollOutcome::Expired)`.
pub async fn await_callback(
    port: u16,
    expected_state: &str,
    cancel: CancellationToken,
) -> Result<String, PollOutcome> {
    await_callback_with_timeout(
        port,
        expected_state,
        cancel,
        Duration::from_secs(FLOW_TIMEOUT_SECS),
    )
    .await
}

/// Same as [`await_callback`] but with an injectable timeout, so the
/// unit tests don't have to wait 10 minutes to exercise the timeout
/// branch.
pub async fn await_callback_with_timeout(
    port: u16,
    expected_state: &str,
    cancel: CancellationToken,
    timeout: Duration,
) -> Result<String, PollOutcome> {
    let listener = match TcpListener::bind((REDIRECT_HOST, port)).await {
        Ok(listener) => listener,
        Err(err) => {
            return Err(PollOutcome::PollFailed(format!(
                "loopback rebind failed on port {}: {}",
                port, err
            )));
        }
    };

    let (tx, rx) = oneshot::channel::<Result<String, PollOutcome>>();
    let shared_state = Arc::new(SharedCallbackState {
        expected_state: expected_state.to_string(),
        sender: tokio::sync::Mutex::new(Some(tx)),
    });

    let app: Router = Router::new()
        .route(REDIRECT_PATH, get(callback_handler))
        .with_state(shared_state.clone());

    let server_cancel = cancel.clone();
    let mut server_handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                server_cancel.cancelled().await;
            })
            .await;
    });

    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(PollOutcome::Cancelled),
        _ = tokio::time::sleep(timeout) => Err(PollOutcome::Expired),
        received = rx => match received {
            Ok(result) => result,
            Err(_) => Err(PollOutcome::PollFailed(
                "loopback receiver dropped before delivering callback".into(),
            )),
        },
    };

    // Always stop accepting new callbacks, but let the in-flight browser
    // response finish before tearing the server down. Aborting immediately
    // can cut off the success/error page after the handler settles `rx`.
    cancel.cancel();
    if tokio::time::timeout(Duration::from_secs(1), &mut server_handle)
        .await
        .is_err()
    {
        server_handle.abort();
        let _ = server_handle.await;
    }

    outcome
}

/// State shared between the `/callback` handler and the awaiting
/// task. Wraps the oneshot sender in a mutex so the handler can take
/// it without owning it.
struct SharedCallbackState {
    expected_state: String,
    sender: tokio::sync::Mutex<Option<oneshot::Sender<Result<String, PollOutcome>>>>,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn callback_handler(
    State(shared): State<Arc<SharedCallbackState>>,
    Query(query): Query<CallbackQuery>,
) -> impl IntoResponse {
    let result: Result<String, PollOutcome> = if let Some(err) = query.error {
        let detail = query.error_description.unwrap_or_else(|| err.clone());
        match err.as_str() {
            "access_denied" => Err(PollOutcome::AccessDenied),
            other => Err(PollOutcome::PollFailed(format!(
                "linear authorize error: {} ({})",
                other, detail
            ))),
        }
    } else {
        match (query.code, query.state) {
            (Some(code), Some(state)) if state == shared.expected_state => Ok(code),
            (_, Some(state)) if state != shared.expected_state => {
                Err(PollOutcome::PollFailed("state_mismatch".to_string()))
            }
            _ => Err(PollOutcome::PollFailed(
                "linear callback missing code or state".to_string(),
            )),
        }
    };

    // Surface the same outcome to both the awaiting task and the
    // browser tab. Once `take()` returns `None` the user has reloaded
    // /callback after the flow already settled — show a benign page.
    let mut guard = shared.sender.lock().await;
    let already_settled = guard.is_none();
    if let Some(sender) = guard.take() {
        let _ = sender.send(result.clone());
    }
    drop(guard);

    if already_settled {
        return (StatusCode::OK, Html(SETTLED_PAGE_HTML)).into_response();
    }

    match result {
        Ok(_) => (StatusCode::OK, Html(SUCCESS_PAGE_HTML)).into_response(),
        Err(PollOutcome::AccessDenied) => (StatusCode::OK, Html(DENIED_PAGE_HTML)).into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, Html(ERROR_PAGE_HTML)).into_response(),
    }
}

const SUCCESS_PAGE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear connected</title></head><body style=\"font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px;color:#1f2937;\"><h2>You can close this tab</h2><p>Linear is connected. Return to ORGII to finish setup.</p></body></html>";
const DENIED_PAGE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear connection cancelled</title></head><body style=\"font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px;color:#1f2937;\"><h2>Connection cancelled</h2><p>You can close this tab and try again from ORGII.</p></body></html>";
const ERROR_PAGE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear connection failed</title></head><body style=\"font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px;color:#1f2937;\"><h2>Connection failed</h2><p>Return to ORGII for the detailed error message.</p></body></html>";
const SETTLED_PAGE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear</title></head><body style=\"font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px;color:#1f2937;\"><h2>You can close this tab</h2></body></html>";

/// Linear `/oauth/token` happy-path response. We pull every field
/// even though `token_type` and `scope` are unused today — keeping
/// them documented in the deserializer makes future audits faster.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    /// Seconds until expiry. Linear returns 86400 (24h) on the
    /// authorization-code grant, less on refresh.
    #[serde(default)]
    expires_in: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    token_type: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    scope: Option<String>,
}

/// Trade an authorization `code` for a [`ConnectionTokenRecord`]. On success
/// the record carries the bearer + refresh + computed
/// `expires_at_unix`; the caller persists it via
/// `super::super::connection_token_store::save`.
pub async fn exchange_code(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> PollOutcome {
    let endpoint = token_endpoint();
    exchange_code_with_endpoint(client_id, code, code_verifier, redirect_uri, &endpoint).await
}

pub async fn exchange_code_with_endpoint(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    token_url: &str,
) -> PollOutcome {
    let client = match http_client() {
        Ok(client) => client,
        Err(err) => return PollOutcome::PollFailed(err),
    };
    let response = match client
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", code_verifier),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            return PollOutcome::PollFailed(format!("linear token request failed: {}", err))
        }
    };
    let status = response.status();
    let body_text = match response.text().await {
        Ok(text) => text,
        Err(err) => {
            return PollOutcome::PollFailed(format!("linear token body read failed: {}", err))
        }
    };
    if !status.is_success() {
        return PollOutcome::PollFailed(format!(
            "linear token endpoint returned {}: {}",
            status, body_text
        ));
    }
    let parsed: TokenResponse = match serde_json::from_str(&body_text) {
        Ok(parsed) => parsed,
        Err(err) => {
            return PollOutcome::PollFailed(format!(
                "linear token json parse failed: {}: {}",
                err, body_text
            ))
        }
    };
    PollOutcome::Token(record_from_response(parsed))
}

/// Re-issue a Linear bearer using a stored `refresh_token`. Errors
/// are returned as plain strings (not [`PollOutcome`]) because this
/// path is driven by the worker's `ensure_fresh_connection_token`, which fails
/// the outbox row directly.
pub async fn refresh(
    client_id: &str,
    refresh_token: &str,
) -> Result<ConnectionTokenRecord, String> {
    let endpoint = token_endpoint();
    refresh_with_endpoint(client_id, refresh_token, &endpoint).await
}

pub async fn refresh_with_endpoint(
    client_id: &str,
    refresh_token: &str,
    token_url: &str,
) -> Result<ConnectionTokenRecord, String> {
    if client_id.is_empty() {
        return Err("Linear OAuth client id is empty".to_string());
    }
    let client = http_client()?;
    let response = client
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|err| format!("linear refresh request failed: {}", err))?;
    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|err| format!("linear refresh body read failed: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "linear refresh endpoint returned {}: {}",
            status, body_text
        ));
    }
    let parsed: TokenResponse = serde_json::from_str(&body_text)
        .map_err(|err| format!("linear refresh json parse failed: {}: {}", err, body_text))?;
    Ok(record_from_response(parsed))
}

fn record_from_response(response: TokenResponse) -> ConnectionTokenRecord {
    let expires_at_unix = response
        .expires_in
        .and_then(|seconds| Utc::now().timestamp().checked_add(seconds));
    ConnectionTokenRecord {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at_unix,
        source: SOURCE_OAUTH_REDIRECT.to_string(),
    }
}

#[cfg(test)]
#[path = "linear_tests.rs"]
mod tests;
