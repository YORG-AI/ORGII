//! Shared, bounded HTTP transport for direct provider quota lookups.
//!
//! Refresh coalescing, TTLs, retries, and last-good retention belong to
//! `quota_runtime`. This module only owns one small process-wide connection
//! pool and a deadline/body bound for each individual provider request.

use std::fmt;
use std::sync::LazyLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_LENGTH, RETRY_AFTER};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::Value;

const REQUEST_DEADLINE: Duration = Duration::from_secs(12);
const CONNECT_DEADLINE: Duration = Duration::from_secs(4);
const IDLE_POOL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

static QUOTA_HTTP_CLIENT: LazyLock<Result<Client, String>> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(CONNECT_DEADLINE)
        .timeout(REQUEST_DEADLINE)
        .pool_idle_timeout(IDLE_POOL_TIMEOUT)
        .pool_max_idle_per_host(1)
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .build()
        .map_err(|error| format!("Failed to build quota HTTP client: {error}"))
});

#[derive(Debug)]
pub(crate) struct QuotaHttpError {
    status: Option<StatusCode>,
    message: String,
}

impl QuotaHttpError {
    pub(crate) fn status(&self) -> Option<StatusCode> {
        self.status
    }
}

impl fmt::Display for QuotaHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// Perform one bounded bearer-authenticated GET and parse its JSON body.
pub(crate) async fn get_bearer_json(
    provider: &str,
    url: &str,
    api_key: &str,
) -> Result<Value, QuotaHttpError> {
    let client = quota_http_client()?;
    send_json(
        provider,
        client
            .get(url)
            .bearer_auth(api_key)
            .header(ACCEPT, "application/json"),
    )
    .await
}

/// Perform one bounded GET with provider-specific headers.
///
/// Callers construct a `HeaderMap` so secrets remain typed header values and
/// never pass through URL query strings. Redirect, deadline, connection-pool,
/// and response-size policy remains centralized in this module.
pub(crate) async fn get_json_with_headers(
    provider: &str,
    url: &str,
    headers: HeaderMap,
) -> Result<Value, QuotaHttpError> {
    let client = quota_http_client()?;
    send_json(
        provider,
        client
            .get(url)
            .header(ACCEPT, "application/json")
            .headers(headers),
    )
    .await
}

fn quota_http_client() -> Result<&'static Client, QuotaHttpError> {
    QUOTA_HTTP_CLIENT
        .as_ref()
        .map_err(|message| QuotaHttpError {
            status: None,
            message: message.clone(),
        })
}

async fn send_json(provider: &str, request: RequestBuilder) -> Result<Value, QuotaHttpError> {
    let mut response = request.send().await.map_err(|error| QuotaHttpError {
        status: None,
        message: format!("{provider} quota request failed: {error}"),
    })?;

    let status = response.status();
    if !status.is_success() {
        let retry_after = if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
        } else {
            None
        };
        return Err(status_error(provider, status, retry_after));
    }

    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(QuotaHttpError {
            status: Some(status),
            message: format!(
                "{provider} quota HTTP {} response exceeds {} bytes",
                status.as_u16(),
                MAX_RESPONSE_BYTES
            ),
        });
    }

    let initial_capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(MAX_RESPONSE_BYTES);
    let mut body = Vec::with_capacity(initial_capacity);
    while let Some(chunk) = response.chunk().await.map_err(|error| QuotaHttpError {
        status: Some(status),
        message: format!(
            "{provider} quota HTTP {} body read failed: {error}",
            status.as_u16()
        ),
    })? {
        append_bounded_chunk(&mut body, &chunk).map_err(|()| QuotaHttpError {
            status: Some(status),
            message: format!(
                "{provider} quota HTTP {} response exceeds {} bytes",
                status.as_u16(),
                MAX_RESPONSE_BYTES
            ),
        })?;
    }

    serde_json::from_slice(&body).map_err(|error| QuotaHttpError {
        status: Some(status),
        message: format!(
            "{provider} quota HTTP {} returned invalid JSON: {error}",
            status.as_u16()
        ),
    })
}

fn append_bounded_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ()> {
    if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
        return Err(());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn status_error(
    provider: &str,
    status: StatusCode,
    retry_after_seconds: Option<u64>,
) -> QuotaHttpError {
    let retry_after = retry_after_seconds
        .map(|seconds| format!(" retry-after: {seconds} seconds"))
        .unwrap_or_default();
    QuotaHttpError {
        status: Some(status),
        message: format!(
            "{provider} quota request failed: HTTP {}{retry_after}",
            status.as_u16()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_retry_after_is_preserved_for_runtime_retry_policy() {
        let error = status_error("OpenRouter", StatusCode::TOO_MANY_REQUESTS, Some(37));
        assert_eq!(error.status(), Some(StatusCode::TOO_MANY_REQUESTS));
        assert!(error.to_string().contains("HTTP 429"));
        assert!(error.to_string().contains("retry-after: 37"));
    }

    #[test]
    fn ordinary_http_error_still_contains_status() {
        let error = status_error("DeepSeek", StatusCode::BAD_GATEWAY, None);
        assert_eq!(error.status(), Some(StatusCode::BAD_GATEWAY));
        assert!(error.to_string().contains("HTTP 502"));
    }

    #[test]
    fn chunk_guard_rejects_before_extending_past_body_limit() {
        let mut body = vec![0; MAX_RESPONSE_BYTES - 2];
        assert!(append_bounded_chunk(&mut body, &[1, 2]).is_ok());
        assert_eq!(body.len(), MAX_RESPONSE_BYTES);
        assert!(append_bounded_chunk(&mut body, &[3]).is_err());
        assert_eq!(body.len(), MAX_RESPONSE_BYTES);
    }
}
