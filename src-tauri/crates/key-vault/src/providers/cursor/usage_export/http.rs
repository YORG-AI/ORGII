use std::path::PathBuf;

use base64::Engine;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, COOKIE, REFERER, USER_AGENT,
};
use tokio::io::AsyncWriteExt;

use super::{
    filesystem::open_sensitive_new,
    types::{CursorUsageFailureKind, CursorUsageSyncFailure},
    MAX_CURSOR_EXPORT_BYTES,
};

pub(super) async fn fetch_usage_csv_to(
    client: &reqwest::Client,
    endpoint: &str,
    session_token: &str,
    staged_path: PathBuf,
) -> Result<u64, CursorUsageSyncFailure> {
    let auth_attempts = cursor_auth_attempts(session_token);
    let auth_attempt_count = auth_attempts.len();
    let mut response = None;
    for (index, auth) in auth_attempts.into_iter().enumerate() {
        let current = client
            .get(endpoint)
            .headers(cursor_headers(&auth)?)
            .send()
            .await
            .map_err(|error| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::Network,
                    format!("Cursor usage request failed: {error}"),
                )
            })?;
        let may_retry_auth = index + 1 < auth_attempt_count;
        if is_auth_failure(current.status()) && may_retry_auth {
            continue;
        }
        response = Some(current);
        break;
    }
    let mut response = response.ok_or_else(|| {
        CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Unauthorized,
            "Cursor web session is expired or unauthorized",
        )
    })?;

    if is_auth_failure(response.status()) {
        return Err(CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Unauthorized,
            "Cursor web session is expired or unauthorized",
        ));
    }
    if !response.status().is_success() {
        return Err(CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Network,
            format!("Cursor usage API returned HTTP {}", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CURSOR_EXPORT_BYTES as u64)
    {
        return Err(CursorUsageSyncFailure::new(
            CursorUsageFailureKind::InvalidExport,
            "Cursor usage export exceeds the 64 MiB safety limit",
        ));
    }

    let mut file = open_sensitive_new(&staged_path).await.map_err(|error| {
        CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Cache,
            format!("Failed to stage Cursor usage export: {error}"),
        )
    })?;
    let mut downloaded_bytes = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Network,
            format!("Failed to read Cursor usage response: {error}"),
        )
    })? {
        downloaded_bytes = downloaded_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::InvalidExport,
                    "Cursor usage export byte count overflowed",
                )
            })?;
        if downloaded_bytes > MAX_CURSOR_EXPORT_BYTES as u64 {
            return Err(CursorUsageSyncFailure::new(
                CursorUsageFailureKind::InvalidExport,
                "Cursor usage export exceeds the 64 MiB safety limit",
            ));
        }
        file.write_all(&chunk).await.map_err(|error| {
            CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to write Cursor usage staging file: {error}"),
            )
        })?;
    }
    file.sync_all().await.map_err(|error| {
        CursorUsageSyncFailure::new(
            CursorUsageFailureKind::Cache,
            format!("Failed to sync Cursor usage staging file: {error}"),
        )
    })?;
    Ok(downloaded_bytes)
}

pub(super) enum CursorAuthAttempt {
    Cookie(String),
    Bearer(String),
}

fn cursor_headers(auth: &CursorAuthAttempt) -> Result<HeaderMap, CursorUsageSyncFailure> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("text/csv,*/*;q=0.9"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.cursor.com/settings"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
        ),
    );
    match auth {
        CursorAuthAttempt::Cookie(session_token) => {
            let cookie =
                HeaderValue::from_str(&format!("WorkosCursorSessionToken={session_token}"))
                    .map_err(|_| {
                        CursorUsageSyncFailure::new(
                            CursorUsageFailureKind::InvalidAccount,
                            "Cursor session token cannot be encoded as an HTTP cookie",
                        )
                    })?;
            headers.insert(COOKIE, cookie);
        }
        CursorAuthAttempt::Bearer(jwt) => {
            let authorization = HeaderValue::from_str(&format!("Bearer {jwt}")).map_err(|_| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::InvalidAccount,
                    "Cursor session token cannot be encoded as an authorization header",
                )
            })?;
            headers.insert(AUTHORIZATION, authorization);
        }
    }
    Ok(headers)
}

fn is_auth_failure(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    )
}

pub(super) fn cursor_auth_attempts(session_token: &str) -> Vec<CursorAuthAttempt> {
    let mut attempts = vec![CursorAuthAttempt::Cookie(session_token.to_string())];
    let raw_jwt = raw_jwt_from_cursor_token(session_token);
    if let Some(alternative) = alternative_cursor_session_token(session_token) {
        push_distinct_auth_attempt(&mut attempts, CursorAuthAttempt::Cookie(alternative));
    }
    if let Some(jwt) = raw_jwt {
        push_distinct_auth_attempt(&mut attempts, CursorAuthAttempt::Bearer(jwt));
    }
    attempts
}

fn push_distinct_auth_attempt(attempts: &mut Vec<CursorAuthAttempt>, candidate: CursorAuthAttempt) {
    let duplicate = attempts
        .iter()
        .any(|existing| match (existing, &candidate) {
            (CursorAuthAttempt::Cookie(left), CursorAuthAttempt::Cookie(right))
            | (CursorAuthAttempt::Bearer(left), CursorAuthAttempt::Bearer(right)) => left == right,
            _ => false,
        });
    if !duplicate {
        attempts.push(candidate);
    }
}

fn raw_jwt_from_cursor_token(token: &str) -> Option<String> {
    if let Some((_, jwt)) = token.split_once("%3A%3A") {
        return (!jwt.is_empty()).then(|| jwt.to_string());
    }
    if let Some((_, jwt)) = token.split_once("::") {
        return (!jwt.is_empty()).then(|| jwt.to_string());
    }
    (token.matches('.').count() >= 2).then(|| token.to_string())
}

fn alternative_cursor_session_token(token: &str) -> Option<String> {
    if let Some(jwt) = raw_jwt_from_cursor_token(token) {
        if token.contains("%3A%3A") || token.contains("::") {
            return Some(jwt);
        }
        return extract_cursor_user_id_from_jwt(&jwt)
            .map(|user_id| format!("{user_id}%3A%3A{jwt}"));
    }
    None
}

fn extract_cursor_user_id_from_jwt(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("sub")
        .or_else(|| value.get("user_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
