//! Desktop relay authentication against ORG2 Cloud (Supabase JWT).
//!
//! Canonical transport (mirrors the Cloudflare Worker):
//! - REST: `Authorization: Bearer <org2_cloud_access_token>`
//! - WebSocket: same Bearer header when supported; otherwise
//!   `access_token=<org2_cloud_access_token>` on the upgrade URL.
//!
//! Legacy shared `ORGII_RELAY_DESKTOP_TOKEN` is accepted only when
//! `ORGII_RELAY_DESKTOP_TOKEN_FALLBACK=true` (local dev).

use axum::http::HeaderMap;
use base64::Engine;
use serde::Deserialize;
use std::sync::OnceLock;

use crate::config::RelayConfig;

#[allow(dead_code)] // Public auth-contract identifiers for operators and client authors.
pub const DESKTOP_ACCESS_TOKEN_QUERY_PARAM: &str = "access_token";
#[allow(dead_code)]
pub const DESKTOP_LEGACY_TOKEN_QUERY_PARAM: &str = "token";

const MAX_ACCESS_TOKEN_BYTES: usize = 16 * 1024;

fn relay_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::new()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopAuthMode {
    Supabase,
    LegacyToken,
}

#[derive(Debug)]
pub enum DesktopAuthError {
    MissingCredentials,
    Unauthorized,
    Unavailable(String),
}

impl DesktopAuthError {
    pub fn api_code(&self) -> &'static str {
        match self {
            Self::MissingCredentials | Self::Unauthorized => "unauthorized",
            Self::Unavailable(_) => "auth_unavailable",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::MissingCredentials => {
                "a valid ORG2 Cloud account session is required".to_string()
            }
            Self::Unauthorized => "invalid or expired ORG2 Cloud account token".to_string(),
            Self::Unavailable(message) => message.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct SupabaseUserPayload {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwtPayload {
    exp: Option<i64>,
    sub: Option<String>,
}

pub fn bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?;
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() || token.len() > MAX_ACCESS_TOKEN_BYTES {
        return None;
    }
    Some(token.to_string())
}

fn bounded_query_token(value: Option<&str>) -> Option<String> {
    let token = value?.trim();
    if token.is_empty() || token.len() > MAX_ACCESS_TOKEN_BYTES {
        return None;
    }
    Some(token.to_string())
}

pub fn extract_desktop_access_token(
    headers: &HeaderMap,
    access_token_query: Option<&str>,
) -> Option<String> {
    bearer_from_headers(headers).or_else(|| bounded_query_token(access_token_query))
}

fn legacy_token_matches(config: &RelayConfig, candidate: &str) -> bool {
    config.desktop_token_fallback
        && config
            .desktop_token
            .as_deref()
            .is_some_and(|configured| constant_time_eq(configured, candidate))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    use sha2::{Digest, Sha256};
    let left_hash = Sha256::digest(left.as_bytes());
    let right_hash = Sha256::digest(right.as_bytes());
    left_hash.as_slice() == right_hash.as_slice()
}

fn parse_jwt_payload(token: &str) -> Option<JwtPayload> {
    let payload_segment = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_segment)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn supabase_user_url(raw_url: &str) -> Option<String> {
    let mut url = url::Url::parse(raw_url).ok()?;
    let is_local_http = url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1")
        );
    if url.scheme() != "https" && !is_local_http {
        return None;
    }
    if url.username() != "" || url.password().is_some() || url.query().is_some() {
        return None;
    }
    url.set_path("/auth/v1/user");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

pub async fn verify_supabase_access_token(
    config: &RelayConfig,
    token: &str,
) -> Result<String, DesktopAuthError> {
    let user_url = supabase_user_url(&config.supabase_url)
        .ok_or_else(|| DesktopAuthError::Unavailable("desktop authentication is not configured".to_string()))?;
    if config.supabase_anon_key.trim().is_empty() {
        return Err(DesktopAuthError::Unavailable(
            "desktop authentication is not configured".to_string(),
        ));
    }

    let response = relay_http_client()
        .get(&user_url)
        .header("accept", "application/json")
        .header("apikey", &config.supabase_anon_key)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|err| {
            DesktopAuthError::Unavailable(format!(
                "desktop authentication is temporarily unavailable: {err}"
            ))
        })?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(DesktopAuthError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(DesktopAuthError::Unavailable(
            "desktop authentication is temporarily unavailable".to_string(),
        ));
    }

    let user: SupabaseUserPayload = response.json().await.map_err(|_| {
        DesktopAuthError::Unavailable(
            "desktop authentication is temporarily unavailable".to_string(),
        )
    })?;
    let user_id = user.id.unwrap_or_default();
    if user_id.is_empty() {
        return Err(DesktopAuthError::Unauthorized);
    }

    let jwt = parse_jwt_payload(token);
    let expires_at_ms = jwt
        .as_ref()
        .and_then(|payload| payload.exp)
        .map(|exp| exp.saturating_mul(1_000));
    if expires_at_ms.is_none_or(|expires| expires <= crate::state::now_ms()) {
        return Err(DesktopAuthError::Unauthorized);
    }
    if let Some(sub) = jwt.and_then(|payload| payload.sub) {
        if sub != user_id {
            return Err(DesktopAuthError::Unauthorized);
        }
    }

    Ok(user_id)
}

pub async fn authorize_desktop_access(
    config: &RelayConfig,
    headers: &HeaderMap,
    legacy_token_query: Option<&str>,
    access_token_query: Option<&str>,
) -> Result<DesktopAuthMode, DesktopAuthError> {
    if let Some(token) = extract_desktop_access_token(headers, access_token_query) {
        if verify_supabase_access_token(config, &token).await.is_ok() {
            return Ok(DesktopAuthMode::Supabase);
        }
        if legacy_token_matches(config, &token) {
            return Ok(DesktopAuthMode::LegacyToken);
        }
        return Err(DesktopAuthError::Unauthorized);
    }

    if let Some(legacy) = bounded_query_token(legacy_token_query) {
        if legacy_token_matches(config, &legacy) {
            return Ok(DesktopAuthMode::LegacyToken);
        }
    }

    Err(DesktopAuthError::MissingCredentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_desktop_access_token_prefers_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer header-token".parse().expect("header"),
        );
        assert_eq!(
            extract_desktop_access_token(&headers, Some("query-token")),
            Some("header-token".to_string())
        );
    }

    #[test]
    fn legacy_token_requires_fallback_flag() {
        let config = RelayConfig {
            listen_addr: "127.0.0.1:0".parse().expect("addr"),
            database_path: std::path::PathBuf::from("/tmp/relay.sqlite3"),
            desktop_token: Some("123456789012345678901234".to_string()),
            desktop_token_fallback: false,
            supabase_url: "https://project.supabase.co".to_string(),
            supabase_anon_key: "anon".to_string(),
            public_ws_url: "ws://127.0.0.1:8787/v1/mobile/ws".to_string(),
            public_app_url: "http://127.0.0.1:8787/orgii/mobile".to_string(),
            pairing_ttl_seconds: 120,
        };
        assert!(!legacy_token_matches(&config, "123456789012345678901234"));
        let mut enabled = config.clone();
        enabled.desktop_token_fallback = true;
        assert!(legacy_token_matches(&enabled, "123456789012345678901234"));
    }
}
