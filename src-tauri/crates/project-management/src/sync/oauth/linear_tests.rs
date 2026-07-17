//! Wiremock-backed unit tests for the Linear OAuth helpers.

use super::*;
use serial_test::serial;
use std::time::Duration;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// PKCE challenge derivation must match RFC 7636: the URL-safe-no-pad
/// base64 of the SHA-256 of the verifier ASCII bytes. This vector
/// pins one verifier to its expected challenge so a future careless
/// edit to `pkce_challenge` flips the test red.
#[test]
fn pkce_challenge_matches_known_vector() {
    // Vector from RFC 7636 §4.2 example.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert_eq!(pkce_challenge(verifier), expected);
}

/// `random_base64url` produces enough bytes that two consecutive
/// invocations are essentially guaranteed to differ; collisions would
/// indicate a broken RNG. Length parity also matters for downstream
/// consumers that assume the verifier is ≥ 43 chars (the lower bound
/// recommended in RFC 7636 §4.1).
#[test]
fn random_base64url_yields_distinct_long_outputs() {
    let a = random_base64url(64);
    let b = random_base64url(64);
    assert_ne!(a, b);
    // Url-safe base64-no-pad: 64 bytes → 86 chars (no padding).
    assert!(a.len() >= 86, "expected ≥ 86 chars, got {}: {}", a.len(), a);
}

/// `start_auth_flow` must build an `authorize_url` that contains every
/// PKCE-required query parameter, encoded properly.
#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn start_auth_flow_builds_pkce_compliant_authorize_url() {
    let descriptor = start_auth_flow("test_client_123")
        .await
        .expect("flow start succeeds");

    let url = &descriptor.authorize_url;
    assert!(url.contains("response_type=code"), "url={}", url);
    assert!(url.contains("client_id=test_client_123"), "url={}", url);
    assert!(url.contains("code_challenge_method=S256"), "url={}", url);
    assert!(url.contains("code_challenge="), "url={}", url);
    assert!(url.contains("state="), "url={}", url);
    assert!(url.contains("scope=read"), "url={}", url);
    assert!(
        url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A45445%2Fcallback"),
        "url={}",
        url
    );
    assert_eq!(descriptor.redirect_uri, "http://localhost:45445/callback");
    assert_eq!(descriptor.port, 45445);
    assert!(
        descriptor.code_verifier.len() >= 43,
        "verifier too short: {}",
        descriptor.code_verifier
    );
    assert!(!descriptor.state.is_empty());
    let now = Utc::now().timestamp();
    let delta = descriptor.expires_at.timestamp() - now;
    assert!(delta > 8 * 60 && delta <= 10 * 60, "delta={}", delta);
}

#[tokio::test]
async fn start_auth_flow_rejects_empty_client_id() {
    let err = start_auth_flow("").await.unwrap_err();
    assert!(err.to_lowercase().contains("client id"), "got {}", err);
}

#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn await_callback_resolves_with_code_on_state_match() {
    let descriptor = start_auth_flow("test_client").await.expect("flow start");
    let port = descriptor.port;
    let state = descriptor.state.clone();
    let cancel = CancellationToken::new();

    let listener_handle = tokio::spawn({
        let cancel = cancel.clone();
        let state = state.clone();
        async move { await_callback_with_timeout(port, &state, cancel, Duration::from_secs(5)).await }
    });

    // Give the loopback a moment to bind, then fire the redirect.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let url = format!(
        "http://localhost:{}/callback?code=AUTHCODE&state={}",
        port,
        urlencoding::encode(&state)
    );
    let resp = reqwest::get(&url).await.expect("redirect get");
    assert_eq!(resp.status().as_u16(), 200);

    let outcome = listener_handle.await.expect("listener join");
    match outcome {
        Ok(code) => assert_eq!(code, "AUTHCODE"),
        Err(err) => panic!("expected Ok(code), got {:?}", err),
    }
}

#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn await_callback_returns_state_mismatch_when_state_differs() {
    let descriptor = start_auth_flow("test_client").await.expect("flow start");
    let port = descriptor.port;
    let cancel = CancellationToken::new();

    let listener_handle = tokio::spawn({
        let cancel = cancel.clone();
        let state = descriptor.state.clone();
        async move { await_callback_with_timeout(port, &state, cancel, Duration::from_secs(5)).await }
    });

    tokio::time::sleep(Duration::from_millis(150)).await;
    let url = format!(
        "http://localhost:{}/callback?code=AUTHCODE&state=ATTACKER",
        port
    );
    let _ = reqwest::get(&url).await.expect("redirect get");

    let outcome = listener_handle.await.expect("listener join");
    match outcome {
        Err(PollOutcome::PollFailed(detail)) => {
            assert!(
                detail.contains("state_mismatch"),
                "expected state_mismatch detail, got {}",
                detail
            );
        }
        other => panic!("expected PollFailed(state_mismatch), got {:?}", other),
    }
}

#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn await_callback_times_out_when_no_callback_arrives() {
    let descriptor = start_auth_flow("test_client").await.expect("flow start");
    let outcome = await_callback_with_timeout(
        descriptor.port,
        &descriptor.state,
        CancellationToken::new(),
        Duration::from_millis(150),
    )
    .await;
    assert!(
        matches!(outcome, Err(PollOutcome::Expired)),
        "got {:?}",
        outcome
    );
}

#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn await_callback_returns_cancelled_when_token_signalled() {
    let descriptor = start_auth_flow("test_client").await.expect("flow start");
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        cancel_clone.cancel();
    });
    let outcome = await_callback_with_timeout(
        descriptor.port,
        &descriptor.state,
        cancel,
        Duration::from_secs(5),
    )
    .await;
    assert!(
        matches!(outcome, Err(PollOutcome::Cancelled)),
        "got {:?}",
        outcome
    );
}

#[tokio::test]
#[serial(linear_oauth_loopback)]
async fn await_callback_returns_access_denied_on_authorize_error() {
    let descriptor = start_auth_flow("test_client").await.expect("flow start");
    let port = descriptor.port;
    let state = descriptor.state.clone();
    let cancel = CancellationToken::new();

    let listener_handle = tokio::spawn({
        let cancel = cancel.clone();
        let state = state.clone();
        async move { await_callback_with_timeout(port, &state, cancel, Duration::from_secs(5)).await }
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let url = format!(
        "http://localhost:{}/callback?error=access_denied&error_description=user+denied",
        port
    );
    let _ = reqwest::get(&url).await.expect("redirect get");
    let outcome = listener_handle.await.expect("listener join");
    assert!(
        matches!(outcome, Err(PollOutcome::AccessDenied)),
        "got {:?}",
        outcome
    );
}

#[tokio::test]
async fn exchange_code_returns_token_record_with_refresh_and_expiry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("code_verifier=verifier_value"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "lin_oauth_bearer",
            "refresh_token": "lin_refresh_token",
            "expires_in": 86400,
            "token_type": "Bearer",
            "scope": "read,write,issues:create",
        })))
        .mount(&server)
        .await;

    let outcome = exchange_code_with_endpoint(
        "client_abc",
        "AUTH_CODE",
        "verifier_value",
        "http://127.0.0.1:1234/callback",
        &format!("{}/oauth/token", server.uri()),
    )
    .await;

    match outcome {
        PollOutcome::Token(record) => {
            assert_eq!(record.access_token, "lin_oauth_bearer");
            assert_eq!(record.refresh_token.as_deref(), Some("lin_refresh_token"));
            assert_eq!(record.source, SOURCE_OAUTH_REDIRECT);
            let expires_at = record.expires_at_unix.expect("expires_at populated");
            let delta = expires_at - Utc::now().timestamp();
            assert!(
                delta > 86_000 && delta <= 86_400,
                "expected ~24h, got delta={}",
                delta
            );
        }
        other => panic!("expected Token, got {:?}", other),
    }
}

#[tokio::test]
async fn exchange_code_surfaces_http_error_through_poll_failed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_string(r#"{"error":"invalid_grant","error_description":"code expired"}"#),
        )
        .mount(&server)
        .await;

    let outcome = exchange_code_with_endpoint(
        "client_abc",
        "AUTH_CODE",
        "verifier_value",
        "http://127.0.0.1:1234/callback",
        &format!("{}/oauth/token", server.uri()),
    )
    .await;
    match outcome {
        PollOutcome::PollFailed(detail) => {
            assert!(detail.contains("400"), "detail={}", detail);
            assert!(detail.contains("invalid_grant"), "detail={}", detail);
        }
        other => panic!("expected PollFailed, got {:?}", other),
    }
}

#[tokio::test]
async fn refresh_returns_fresh_record_with_new_expiry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=stored_refresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "lin_oauth_bearer_v2",
            "refresh_token": "lin_refresh_v2",
            "expires_in": 86400,
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;

    let record = refresh_with_endpoint(
        "client_abc",
        "stored_refresh",
        &format!("{}/oauth/token", server.uri()),
    )
    .await
    .expect("refresh succeeds");
    assert_eq!(record.access_token, "lin_oauth_bearer_v2");
    assert_eq!(record.refresh_token.as_deref(), Some("lin_refresh_v2"));
    assert!(record.expires_at_unix.is_some());
    assert_eq!(record.source, SOURCE_OAUTH_REDIRECT);
}

#[tokio::test]
async fn refresh_returns_error_string_on_revoked_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(
            ResponseTemplate::new(401).set_body_string(
                r#"{"error":"invalid_grant","error_description":"token revoked"}"#,
            ),
        )
        .mount(&server)
        .await;

    let err = refresh_with_endpoint(
        "client_abc",
        "stored_refresh",
        &format!("{}/oauth/token", server.uri()),
    )
    .await
    .unwrap_err();
    assert!(err.contains("401"), "err={}", err);
    assert!(err.contains("invalid_grant"), "err={}", err);
}

#[tokio::test]
async fn refresh_rejects_empty_client_id() {
    let err = refresh_with_endpoint("", "stored_refresh", "http://unused.test")
        .await
        .unwrap_err();
    assert!(err.to_lowercase().contains("client id"), "err={}", err);
}

/// `set_test_token_endpoint(Some(url))` round-trips through
/// `token_endpoint()` so the e2e binary's override hook actually
/// changes the URL [`exchange_code`] / [`refresh`] hit. Clearing the
/// override restores the production URL. This guards the
/// `oauth/set-token-endpoint` debug endpoint from a regression where
/// the override silently doesn't take effect, leaving the e2e
/// scenarios pointing at the real Linear token endpoint.
#[test]
fn test_token_endpoint_override_round_trips() {
    let production = token_endpoint();
    assert_eq!(production, PRODUCTION_TOKEN_URL);

    set_test_token_endpoint(Some("http://127.0.0.1:65000/oauth/token".to_string()));
    let overridden = token_endpoint();
    assert_eq!(overridden, "http://127.0.0.1:65000/oauth/token");

    set_test_token_endpoint(None);
    assert_eq!(token_endpoint(), PRODUCTION_TOKEN_URL);
}
