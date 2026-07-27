//! Proxy token release — best-effort release back to the market.

use super::super::persistence;
use super::super::types::KeySource;

/// Best-effort release of a session's proxy token back to the market.
///
/// Public wrapper so commands.rs can call this (e.g., before deleting a session row).
pub async fn release_proxy_token_for_session_pub(session_id: &str) {
    release_proxy_token_for_session(session_id).await;
}

/// Best-effort release of a session's proxy token back to the market.
///
/// Loads the session from DB, checks if it's a cloud session with a token and
/// hosted_token, and calls the market release endpoint. If anything
/// fails (network, missing token, etc.), it's logged and swallowed — the
/// server-side TTL will clean up orphaned tokens.
///
/// Also sends `proxy_session_id` so the market can clean up the billing
/// context in Redis and update the Job record.
pub(super) async fn release_proxy_token_for_session(session_id: &str) {
    let load_session_id = session_id.to_string();
    let session =
        match tokio::task::spawn_blocking(move || persistence::get_session(&load_session_id)).await
        {
            Ok(Ok(Some(s))) => s,
            _ => return,
        };

    if session.key_source != KeySource::HostedKey {
        return;
    }

    let proxy_token = match session.proxy_token {
        Some(ref t) if !t.is_empty() => t.clone(),
        _ => return,
    };

    let hosted_token = match session.hosted_token {
        Some(ref t) if !t.is_empty() => t.clone(),
        _ => {
            tracing::warn!(
                "[CodeSession] Cannot release proxy token for session {} — no hosted_token stored",
                session_id
            );
            return;
        }
    };

    let proxy_session_id = session.proxy_session_id.as_deref();

    match integrations::proxy::release_proxy_token_internal(
        &proxy_token,
        proxy_session_id,
        &hosted_token,
    )
    .await
    {
        Ok(true) => {
            tracing::info!(
                "[CodeSession] Released proxy token for session {}",
                session_id
            );
        }
        Ok(false) => {
            tracing::warn!(
                "[CodeSession] Market rejected token release for session {}",
                session_id
            );
        }
        Err(err) => {
            tracing::warn!(
                "[CodeSession] Failed to release proxy token for session {}: {}",
                session_id,
                err
            );
        }
    }
}
