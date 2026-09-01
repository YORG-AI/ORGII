//! ORGII Proxy Integration
//!
//! Two modes of proxy operation:
//!
//! 1. **Base URL override** (Claude Code, Codex):
//!    Set `{PROVIDER}_BASE_URL` to the ORGII proxy URL. Simple, no MITM needed.
//!    Handled by `get_proxy_env_for_agent()` in `key_store::env`.
//!
//! 2. **MITM proxy** (Cursor, Kiro, Copilot):
//!    These agents don't support base URL override. A per-session local HTTPS
//!    proxy is started on an OS-assigned ephemeral port, intercepts LLM API
//!    traffic, swaps keys with the session's proxy token, and forwards to the
//!    ORGII cloud proxy. Each cloud session gets its own proxy instance so
//!    multiple concurrent sessions don't cross-contaminate billing.
//!    Requires one-time CA certificate installation.
//!
//! ## Proxy Lifecycle
//!
//! The proxy is managed entirely by the Rust backend — no frontend involvement:
//! - **Start:** `runner::run_session()` calls `server::start_session_proxy()`
//! - **Stop:** On session exit, cancel, or delete via `server::stop_session_proxy()`
//! - **State:** In-memory `HashMap<session_id, ProxyServer>` (ephemeral — sockets
//!   die with the process; token/URL are persisted in the `code_sessions` DB table)
//!
//! ## Modules
//!
//! - `ca` — Root CA certificate generation and storage
//! - `cert_install` — OS-specific certificate installation helpers
//! - `server` — Per-session MITM HTTPS proxy server

pub mod cert_install;
pub mod certificate_authority;
pub mod server;
pub mod sse_sanitizer;

use serde::{Deserialize, Serialize};

/// Proxy token allocation response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAllocation {
    pub proxy_token: String,
    pub proxy_url: String,
    pub expires_at: Option<String>,
    /// Proxy-side session ID (sess_xxx) used for billing context and release.
    pub session_id: Option<String>,
    /// Resolved model API name (e.g. "claude-opus-4.6") for CLI invocation.
    /// Returned by the proxy so the client doesn't need its own name mapping.
    pub model_name: Option<String>,

    // Bonus/margin fields
    #[serde(default)]
    pub has_bonus: bool,
    pub bonus_message: Option<String>,
    pub original_tier: Option<String>,
    pub actual_tier: Option<String>,
    #[serde(default)]
    pub bonus_exhausted: bool,
    /// Resolved CLI agent type (e.g. "claude_code") when the platform is a
    /// virtual pool like orgii_orchestrator.  `None` when platform == agent type.
    pub agent_type: Option<String>,
}

/// Default hosted-service base URL when `REACT_APP_MARKETPLACE_URL` is unset.
const DEFAULT_HOSTED_SERVICE_BASE_URL: &str = "http://127.0.0.1:8001";

fn hosted_service_base_url() -> String {
    std::env::var("REACT_APP_MARKETPLACE_URL")
        .unwrap_or_else(|_| DEFAULT_HOSTED_SERVICE_BASE_URL.to_string())
}

// ============================================
// Proxy Token Commands (Hosted Service Billing)
// ============================================

/// Internal helper — allocate a proxy token from the hosted service.
///
/// Used by both the Tauri command and Rust-internal callers (e.g.,
/// `cli_agent_message` re-allocating a token for follow-up runs).
pub async fn allocate_proxy_token_internal(
    platform: &str,
    model: Option<&str>,
    tier: Option<&str>,
    pricing_type: Option<&str>,
    hosted_token: &str,
) -> Result<ProxyAllocation, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/proxy/allocate", hosted_service_base_url());

    let mut body = serde_json::json!({ "platform": platform });
    if let Some(m) = model {
        body["model"] = serde_json::Value::String(m.to_string());
    }
    if let Some(t) = tier {
        body["tier"] = serde_json::Value::String(t.to_string());
    }
    if let Some(pt) = pricing_type {
        body["pricing_type"] = serde_json::Value::String(pt.to_string());
    }

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", hosted_token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to hosted service: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        // Preserve the body-read failure so the operator sees
        // "(body read failed: <err>)" instead of an empty body that
        // hides whether the hosted service truly returned no diagnostic or
        // the body was unreachable.
        let text = match response.text().await {
            Ok(t) => t,
            Err(err) => format!("(body read failed: {})", err),
        };
        return Err(format!("Proxy allocation failed ({}): {}", status, text));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid response from hosted service: {}", e))?;

    let data = result.get("data").unwrap_or(&result);

    Ok(ProxyAllocation {
        proxy_token: data
            .get("proxy_token")
            .and_then(|v| v.as_str())
            .ok_or("Missing proxy_token")?
            .to_string(),
        proxy_url: data
            .get("proxy_url")
            .and_then(|v| v.as_str())
            .ok_or("Missing proxy_url")?
            .to_string(),
        expires_at: data
            .get("expires_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        session_id: data
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        model_name: data
            .get("model_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        has_bonus: data
            .get("has_bonus")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        bonus_message: data
            .get("bonus_message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        original_tier: data
            .get("original_tier")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        actual_tier: data
            .get("actual_tier")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        bonus_exhausted: data
            .get("bonus_exhausted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        agent_type: data
            .get("agent_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Internal helper for releasing a proxy token — callable from both Tauri commands
/// and Rust backend code (e.g., runner cleanup).
///
/// Sends both `proxy_token` and `session_id` to the hosted service so it can
/// clean up the billing context in Redis and update the Job record.
pub async fn release_proxy_token_internal(
    proxy_token: &str,
    session_id: Option<&str>,
    hosted_token: &str,
) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/proxy/release", hosted_service_base_url());

    let mut body = serde_json::json!({ "proxy_token": proxy_token });
    if let Some(sid) = session_id {
        body["session_id"] = serde_json::Value::String(sid.to_string());
    }

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", hosted_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to release proxy token: {}", e))?;

    Ok(response.status().is_success())
}

// ============================================
// Certificate Management Commands
// ============================================

// ============================================
// MITM Proxy Server Commands
// ============================================
// NOTE: proxy_start / proxy_stop Tauri commands have been removed.
// The per-session MITM proxy is now managed entirely by the Rust backend:
//   - start_session_proxy() is called inside runner::run_session() for cloud MITM agents
//   - stop_session_proxy() is called on session exit, cancel, or delete
// The frontend never needs to touch the proxy directly.

// NOTE: `proxy_needs_mitm` was a Tauri command exposing
// `ModelType::needs_mitm_proxy()` to the frontend. It had no remaining
// callers (TypeScript or Rust) and the per-session MITM decision is now
// made entirely backend-side inside `session_runner::session.rs`, which
// reads `agent.needs_mitm_proxy()` directly off the typed `ModelType`.
// Deleted as part of the P1 default-branch audit since its
// `unwrap_or(false)` fallback would have silently mis-routed unknown
// platform strings as "no MITM needed".

// ============================================
// Hosted Service Proxy (bypasses WebView CORS)
// ============================================

/// Proxy request to the hosted service backend.
///
/// The Tauri WebView cannot directly call `http://127.0.0.1:8001` due to CORS
/// restrictions. This command forwards the request through Rust's reqwest client
/// which is not subject to browser CORS policies.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedServiceProxyRequest {
    pub method: String,
    pub path: String,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedServiceProxyResponse {
    pub status: u16,
    pub data: serde_json::Value,
}

#[tauri::command]
pub async fn hosted_service_proxy(
    request: HostedServiceProxyRequest,
) -> Result<HostedServiceProxyResponse, String> {
    let client = reqwest::Client::new();
    let base = hosted_service_base_url();
    let mut url = format!("{}{}", base, request.path);

    if let Some(params) = &request.params {
        if let Some(obj) = params.as_object() {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (key, val) in obj {
                let val_str = match val {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Null => continue,
                    other => other.to_string(),
                };
                if !val_str.is_empty() {
                    serializer.append_pair(key, &val_str);
                }
            }
            let qs = serializer.finish();
            if !qs.is_empty() {
                url = format!("{}?{}", url, qs);
            }
        }
    }

    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("Unsupported HTTP method: {}", other)),
    };

    let mut req_builder = client.request(method, &url);

    if let Some(headers) = request.headers {
        for (key, value) in headers {
            req_builder = req_builder.header(&key, &value);
        }
    }

    if let Some(body) = request.body {
        req_builder = req_builder
            .header("Content-Type", "application/json")
            .json(&body);
    }

    let response = req_builder
        .send()
        .await
        .map_err(|err| format!("Hosted service proxy request failed: {}", err))?;

    let status = response.status().as_u16();
    let data: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);

    Ok(HostedServiceProxyResponse { status, data })
}
