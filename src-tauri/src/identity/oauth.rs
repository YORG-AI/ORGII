use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use identity_broker::{
    HostedOAuthCodeExchange, HostedServiceOAuthConfig, OAuthCodeExchange, Org2CloudOAuthConfig,
    PreparedSupabaseRefresh, RefreshedSupabaseAccess, SecretBytes, VerifiedHostedServiceSession,
    VerifiedOrg2CloudSession,
};
use reqwest::{redirect::Policy, Client, Response};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

const CONFIG_BODY_LIMIT: usize = 32 * 1024;
const TOKEN_BODY_LIMIT: usize = 64 * 1024;
const USER_INFO_BODY_LIMIT: usize = 64 * 1024;
const CALLBACK_REQUEST_LIMIT: usize = 8 * 1024;
const MAX_LOOPBACK_CONNECTIONS: usize = 16;
const LOOPBACK_CALLBACK_PATH: &str = "/org2-cloud/oauth/callback";

const LOOPBACK_SUCCESS_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ORG2 Cloud</title></head><body><p>ORG2 is completing sign-in. You can return to the app.</p></body></html>"#;
const LOOPBACK_REJECTED_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ORG2 Cloud</title></head><body><p>This sign-in callback was not accepted. Return to ORG2 and try again.</p></body></html>"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Org2CloudSignInInput {
    pub web_origin: String,
    pub supabase_url: String,
    pub public_client_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedServiceSignInInput {
    pub supabase_url: String,
    pub public_client_key: String,
    pub redirect_uri: String,
    pub provider: String,
    pub scopes: String,
}

impl HostedServiceSignInInput {
    pub(super) fn into_config(self) -> Result<HostedServiceOAuthConfig, OAuthAdapterError> {
        let issuer = normalized_origin(&self.supabase_url)?;
        let scopes: Vec<_> = self.scopes.split_whitespace().map(str::to_owned).collect();
        Ok(HostedServiceOAuthConfig {
            authorization_endpoint: format!("{issuer}/auth/v1/authorize"),
            issuer,
            public_client_key: self.public_client_key,
            redirect_uri: self.redirect_uri,
            provider: self.provider,
            scopes,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OAuthAdapterError {
    code: &'static str,
}

impl OAuthAdapterError {
    pub(super) fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(self) -> &'static str {
        self.code
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopOAuthConfigWire {
    authorization_endpoint: String,
    client_id: String,
    redirect_uri: String,
    scopes: Vec<String>,
    token_endpoint: String,
    user_endpoint: String,
    version: u8,
}

pub(super) struct ExchangedTokens {
    access_credential: SecretBytes,
    refresh_credential: SecretBytes,
    expires_in: i64,
    scopes: Vec<String>,
}

#[derive(Deserialize)]
struct TokenResponseWire {
    access_token: SensitiveString,
    refresh_token: SensitiveString,
    token_type: String,
    expires_in: i64,
    scope: String,
}

struct SensitiveString(SecretBytes);

impl<'de> Deserialize<'de> for SensitiveString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(|value| Self(SecretBytes::new(value.into_bytes())))
    }
}

impl SensitiveString {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn len(&self) -> usize {
        self.0.expose().len()
    }

    fn into_secret(self) -> SecretBytes {
        self.0
    }
}

#[derive(Deserialize)]
struct UserInfoWire {
    sub: String,
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AudienceClaim {
    One(String),
    Many(Vec<String>),
}

impl AudienceClaim {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::One(value) => value == expected,
            Self::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[derive(Deserialize)]
struct AccessTokenClaims {
    iss: String,
    sub: String,
    aud: AudienceClaim,
    exp: i64,
    #[serde(default)]
    client_id: Option<String>,
}

#[derive(Deserialize)]
struct LegacyRefreshResponseWire {
    access_token: SensitiveString,
    refresh_token: SensitiveString,
    token_type: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct HostedUserWire {
    id: String,
    email: Option<String>,
    #[serde(default)]
    user_metadata: serde_json::Value,
}

pub(super) enum RefreshOutcome {
    Refreshed(RefreshedSupabaseAccess),
    Rejected,
}

pub fn build_http_client() -> Client {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("ORG2-Desktop-Identity-Broker/1")
        .build()
        .unwrap_or_default()
}

pub async fn fetch_desktop_oauth_config(
    client: &Client,
    input: &Org2CloudSignInInput,
) -> Result<Org2CloudOAuthConfig, OAuthAdapterError> {
    let web_origin = normalized_origin(&input.web_origin)?;
    let supabase_origin = normalized_origin(&input.supabase_url)?;
    if input.public_client_key.trim().is_empty() || input.public_client_key.len() > 4_096 {
        return Err(OAuthAdapterError::new("identity_oauth_input_invalid"));
    }

    let config_url = format!("{web_origin}/api/auth/desktop/config");
    let response = client
        .get(&config_url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_config_unavailable"))?;
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new("identity_oauth_config_unavailable"));
    }
    let body = bounded_body(response, CONFIG_BODY_LIMIT).await?;
    let wire: DesktopOAuthConfigWire = serde_json::from_slice(&body)
        .map_err(|_| OAuthAdapterError::new("identity_oauth_config_invalid"))?;
    if wire.version != 1
        || wire.authorization_endpoint != format!("{supabase_origin}/auth/v1/oauth/authorize")
        || wire.token_endpoint != format!("{supabase_origin}/auth/v1/oauth/token")
        || wire.user_endpoint != format!("{supabase_origin}/auth/v1/oauth/userinfo")
        || wire.redirect_uri != format!("{web_origin}/auth/desktop/oauth/callback")
    {
        return Err(OAuthAdapterError::new("identity_oauth_config_invalid"));
    }

    Ok(Org2CloudOAuthConfig {
        issuer: supabase_origin,
        public_client_key: input.public_client_key.clone(),
        authorization_endpoint: wire.authorization_endpoint,
        token_endpoint: wire.token_endpoint,
        user_endpoint: wire.user_endpoint,
        client_id: wire.client_id,
        redirect_uri: wire.redirect_uri,
        scopes: wire.scopes,
    })
}

fn normalized_origin(raw_value: &str) -> Result<String, OAuthAdapterError> {
    let url = Url::parse(raw_value)
        .map_err(|_| OAuthAdapterError::new("identity_oauth_input_invalid"))?;
    let loopback_http = url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
    if (url.scheme() != "https" && !loopback_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(OAuthAdapterError::new("identity_oauth_input_invalid"));
    }
    Ok(url.origin().ascii_serialization())
}

async fn bounded_body(
    mut response: Response,
    maximum: usize,
) -> Result<Vec<u8>, OAuthAdapterError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(OAuthAdapterError::new("identity_oauth_response_invalid"));
    }
    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(maximum);
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_network_failed"))?
    {
        if chunk.len() > maximum.saturating_sub(body.len()) {
            return Err(OAuthAdapterError::new("identity_oauth_response_invalid"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn bind_loopback() -> Result<TcpListener, OAuthAdapterError> {
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| OAuthAdapterError::new("identity_loopback_bind_failed"))
}

pub async fn wait_for_callback(
    listener: TcpListener,
    port: u16,
) -> Result<String, OAuthAdapterError> {
    for _ in 0..MAX_LOOPBACK_CONNECTIONS {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| OAuthAdapterError::new("identity_loopback_failed"))?;
        let request = read_request(&mut stream).await;
        match request
            .as_deref()
            .and_then(|request| parse_callback_request(request, port))
        {
            Some(callback_url) => {
                write_response(&mut stream, 200, LOOPBACK_SUCCESS_HTML).await;
                return Ok(callback_url);
            }
            None => {
                write_response(&mut stream, 404, LOOPBACK_REJECTED_HTML).await;
            }
        }
    }
    Err(OAuthAdapterError::new("identity_loopback_rejected"))
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Vec<u8>> {
    let mut request = Vec::with_capacity(1_024);
    let read = async {
        loop {
            let mut chunk = [0_u8; 1_024];
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            request.extend_from_slice(&chunk[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return Some(request);
            }
            if request.len() >= CALLBACK_REQUEST_LIMIT {
                return None;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(3), read)
        .await
        .ok()
        .flatten()
}

fn parse_callback_request(request: &[u8], port: u16) -> Option<String> {
    let request = std::str::from_utf8(request).ok()?;
    let first_line = request.split("\r\n").next()?;
    let mut parts = first_line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if parts.next()? != "HTTP/1.1" || parts.next().is_some() || !target.starts_with('/') {
        return None;
    }
    let callback = Url::parse(&format!("http://127.0.0.1:{port}{target}")).ok()?;
    if callback.path() != LOOPBACK_CALLBACK_PATH || callback.fragment().is_some() {
        return None;
    }
    Some(callback.to_string())
}

async fn write_response(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

pub async fn exchange_code(
    client: &Client,
    exchange: &OAuthCodeExchange,
) -> Result<ExchangedTokens, OAuthAdapterError> {
    let code = std::str::from_utf8(exchange.code())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_callback_invalid"))?;
    let verifier = std::str::from_utf8(exchange.verifier())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_callback_invalid"))?;
    let config = exchange.config();
    let response = client
        .post(&config.token_endpoint)
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_exchange_failed"))?;
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new("identity_oauth_exchange_rejected"));
    }
    let body = SecretBytes::new(bounded_body(response, TOKEN_BODY_LIMIT).await?);
    parse_token_response(body, &config.scopes)
}

pub(super) async fn refresh_supabase_access(
    client: &Client,
    request: &PreparedSupabaseRefresh,
) -> Result<RefreshOutcome, OAuthAdapterError> {
    let refresh_credential = std::str::from_utf8(request.refresh_credential.expose())
        .map_err(|_| OAuthAdapterError::new("identity_access_refresh_invalid"))?;
    let response = if let Some(client_id) = request.oauth_client_id.as_deref() {
        client
            .post(format!(
                "{}/auth/v1/oauth/token",
                request.issuer.trim_end_matches('/')
            ))
            .header("accept", "application/json")
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_credential),
                ("client_id", client_id),
            ])
            .send()
            .await
    } else {
        client
            .post(format!(
                "{}/auth/v1/token?grant_type=refresh_token",
                request.issuer.trim_end_matches('/')
            ))
            .header("accept", "application/json")
            .header("apikey", &request.public_client_key)
            .json(&serde_json::json!({ "refresh_token": refresh_credential }))
            .send()
            .await
    }
    .map_err(|_| OAuthAdapterError::new("identity_access_refresh_unavailable"))?;

    if matches!(response.status().as_u16(), 400 | 401) {
        return Ok(RefreshOutcome::Rejected);
    }
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new(
            "identity_access_refresh_unavailable",
        ));
    }

    let body = SecretBytes::new(bounded_body(response, TOKEN_BODY_LIMIT).await?);
    let tokens = if request.oauth_client_id.is_some() {
        parse_token_response(body, &request.scopes)?
    } else {
        parse_legacy_refresh_response(body)?
    };
    let ExchangedTokens {
        access_credential,
        refresh_credential,
        expires_in,
        ..
    } = tokens;
    let access_token = std::str::from_utf8(access_credential.expose())
        .map_err(|_| OAuthAdapterError::new("identity_access_refresh_invalid"))?;
    let claims = parse_access_token_claims(access_token)?;
    validate_refreshed_token_identity(request, &claims, expires_in, unix_now())?;
    Ok(RefreshOutcome::Refreshed(RefreshedSupabaseAccess {
        subject: claims.sub,
        expires_at_unix: claims.exp,
        access_credential,
        refresh_credential: Some(refresh_credential),
    }))
}

pub(super) async fn exchange_hosted_service_code(
    client: &Client,
    exchange: &HostedOAuthCodeExchange,
) -> Result<VerifiedHostedServiceSession, OAuthAdapterError> {
    let code = std::str::from_utf8(exchange.code())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_callback_invalid"))?;
    let verifier = std::str::from_utf8(exchange.verifier())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_callback_invalid"))?;
    let config = exchange.config();
    let response = client
        .post(format!(
            "{}/auth/v1/token?grant_type=pkce",
            config.issuer.trim_end_matches('/')
        ))
        .header("accept", "application/json")
        .header("apikey", &config.public_client_key)
        .json(&serde_json::json!({
            "auth_code": code,
            "code_verifier": verifier,
        }))
        .send()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_exchange_failed"))?;
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new("identity_oauth_exchange_rejected"));
    }
    let body = SecretBytes::new(bounded_body(response, TOKEN_BODY_LIMIT).await?);
    let tokens = parse_legacy_refresh_response(body)?;
    verify_hosted_service_tokens(client, config, tokens).await
}

async fn verify_hosted_service_tokens(
    client: &Client,
    config: &HostedServiceOAuthConfig,
    tokens: ExchangedTokens,
) -> Result<VerifiedHostedServiceSession, OAuthAdapterError> {
    let ExchangedTokens {
        access_credential,
        refresh_credential,
        expires_in,
        ..
    } = tokens;
    let access_token = std::str::from_utf8(access_credential.expose())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    let response = client
        .get(format!(
            "{}/auth/v1/user",
            config.issuer.trim_end_matches('/')
        ))
        .header("accept", "application/json")
        .header("apikey", &config.public_client_key)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_verification_failed"))?;
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new(
            "identity_oauth_verification_rejected",
        ));
    }
    let user_body = bounded_body(response, USER_INFO_BODY_LIMIT).await?;
    let user: HostedUserWire = serde_json::from_slice(&user_body)
        .map_err(|_| OAuthAdapterError::new("identity_oauth_user_invalid"))?;
    let claims = parse_access_token_claims(access_token)?;
    let now = unix_now();
    let expected_issuer = format!("{}/auth/v1", config.issuer.trim_end_matches('/'));
    let computed_expiry = now.saturating_add(expires_in);
    if claims.iss != expected_issuer
        || claims.sub != user.id
        || !claims.aud.contains("authenticated")
        || claims.exp <= now.saturating_add(60)
        || claims.exp > now.saturating_add(86_400)
        || claims.exp.abs_diff(computed_expiry) > 120
    {
        return Err(OAuthAdapterError::new("identity_oauth_claims_mismatch"));
    }
    let metadata = user.user_metadata.as_object();
    let display_name = metadata.and_then(|values| {
        ["full_name", "name", "user_name"]
            .into_iter()
            .find_map(|key| values.get(key).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
    });
    let avatar_url = metadata
        .and_then(|values| values.get("avatar_url"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Ok(VerifiedHostedServiceSession {
        subject: user.id,
        display_name,
        primary_email: user.email,
        avatar_url,
        expires_at_unix: claims.exp,
        access_credential,
        refresh_credential,
    })
}

fn parse_legacy_refresh_response(body: SecretBytes) -> Result<ExchangedTokens, OAuthAdapterError> {
    let wire: LegacyRefreshResponseWire = serde_json::from_slice(body.expose())
        .map_err(|_| OAuthAdapterError::new("identity_access_refresh_invalid"))?;
    if !wire.token_type.eq_ignore_ascii_case("bearer")
        || wire.expires_in <= 0
        || wire.expires_in > 86_400
        || wire.access_token.is_empty()
        || wire.access_token.len() > 32_768
        || wire.refresh_token.is_empty()
        || wire.refresh_token.len() > 16_384
    {
        return Err(OAuthAdapterError::new("identity_access_refresh_invalid"));
    }
    Ok(ExchangedTokens {
        access_credential: wire.access_token.into_secret(),
        refresh_credential: wire.refresh_token.into_secret(),
        expires_in: wire.expires_in,
        scopes: Vec::new(),
    })
}

fn parse_token_response(
    body: SecretBytes,
    expected_scopes: &[String],
) -> Result<ExchangedTokens, OAuthAdapterError> {
    let wire: TokenResponseWire = serde_json::from_slice(body.expose())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    if !wire.token_type.eq_ignore_ascii_case("bearer")
        || wire.expires_in <= 0
        || wire.expires_in > 86_400
        || wire.access_token.is_empty()
        || wire.access_token.len() > 32_768
        || wire.refresh_token.is_empty()
        || wire.refresh_token.len() > 16_384
    {
        return Err(OAuthAdapterError::new("identity_oauth_token_invalid"));
    }
    let scopes: Vec<_> = wire.scope.split_whitespace().map(str::to_owned).collect();
    if !same_scope_set(&scopes, expected_scopes) {
        return Err(OAuthAdapterError::new("identity_oauth_token_invalid"));
    }
    Ok(ExchangedTokens {
        access_credential: wire.access_token.into_secret(),
        refresh_credential: wire.refresh_token.into_secret(),
        expires_in: wire.expires_in,
        scopes,
    })
}

pub async fn verify_tokens(
    client: &Client,
    config: &Org2CloudOAuthConfig,
    tokens: ExchangedTokens,
) -> Result<VerifiedOrg2CloudSession, OAuthAdapterError> {
    let ExchangedTokens {
        access_credential,
        refresh_credential,
        expires_in,
        scopes,
    } = tokens;
    let access_token = std::str::from_utf8(access_credential.expose())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    let response = client
        .get(&config.user_endpoint)
        .header("accept", "application/json")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| OAuthAdapterError::new("identity_oauth_verification_failed"))?;
    if !response.status().is_success() {
        return Err(OAuthAdapterError::new(
            "identity_oauth_verification_rejected",
        ));
    }
    let user_body = bounded_body(response, USER_INFO_BODY_LIMIT).await?;
    let user: UserInfoWire = serde_json::from_slice(&user_body)
        .map_err(|_| OAuthAdapterError::new("identity_oauth_user_invalid"))?;
    let claims = parse_access_token_claims(access_token)?;
    let now = unix_now();
    validate_token_identity(config, &user, &claims, expires_in, now)?;

    Ok(VerifiedOrg2CloudSession {
        subject: user.sub,
        display_name: user.name,
        primary_email: user.email,
        avatar_url: user.picture,
        scopes,
        expires_at_unix: claims.exp,
        access_credential,
        refresh_credential,
    })
}

fn validate_token_identity(
    config: &Org2CloudOAuthConfig,
    user: &UserInfoWire,
    claims: &AccessTokenClaims,
    expires_in: i64,
    now: i64,
) -> Result<(), OAuthAdapterError> {
    let expected_issuer = format!("{}/auth/v1", config.issuer.trim_end_matches('/'));
    let computed_expiry = now.saturating_add(expires_in);
    if claims.iss != expected_issuer
        || claims.sub != user.sub
        || claims.client_id.as_deref() != Some(config.client_id.as_str())
        || !claims.aud.contains("authenticated")
        || claims.exp <= now.saturating_sub(60)
        || claims.exp > now.saturating_add(86_400)
        || claims.exp.abs_diff(computed_expiry) > 120
    {
        return Err(OAuthAdapterError::new("identity_oauth_claims_mismatch"));
    }
    Ok(())
}

fn validate_refreshed_token_identity(
    request: &PreparedSupabaseRefresh,
    claims: &AccessTokenClaims,
    expires_in: i64,
    now: i64,
) -> Result<(), OAuthAdapterError> {
    let expected_issuer = format!("{}/auth/v1", request.issuer.trim_end_matches('/'));
    let computed_expiry = now.saturating_add(expires_in);
    let client_matches = request
        .oauth_client_id
        .as_deref()
        .is_none_or(|expected| claims.client_id.as_deref() == Some(expected));
    if claims.iss != expected_issuer
        || claims.sub != request.subject
        || !client_matches
        || !claims.aud.contains("authenticated")
        || claims.exp <= now.saturating_add(60)
        || claims.exp > now.saturating_add(86_400)
        || claims.exp.abs_diff(computed_expiry) > 120
    {
        return Err(OAuthAdapterError::new("identity_access_refresh_invalid"));
    }
    Ok(())
}

fn parse_access_token_claims(access_token: &str) -> Result<AccessTokenClaims, OAuthAdapterError> {
    let mut parts = access_token.split('.');
    let _header = parts
        .next()
        .filter(|header| !header.is_empty() && header.len() <= 16_384)
        .ok_or_else(|| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    let payload = parts
        .next()
        .filter(|payload| !payload.is_empty() && payload.len() <= 32_768)
        .ok_or_else(|| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    if parts
        .next()
        .filter(|signature| !signature.is_empty() && signature.len() <= 32_768)
        .is_none()
        || parts.next().is_some()
    {
        return Err(OAuthAdapterError::new("identity_oauth_token_invalid"));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| OAuthAdapterError::new("identity_oauth_token_invalid"))?;
    let decoded = SecretBytes::new(decoded);
    serde_json::from_slice(decoded.expose())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_token_invalid"))
}

fn same_scope_set(left: &[String], right: &[String]) -> bool {
    let left_set: std::collections::BTreeSet<_> = left.iter().map(String::as_str).collect();
    let right_set: std::collections::BTreeSet<_> = right.iter().map(String::as_str).collect();
    left.len() == left_set.len() && right.len() == right_set.len() && left_set == right_set
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth_config() -> Org2CloudOAuthConfig {
        Org2CloudOAuthConfig {
            issuer: "https://project.supabase.co".to_owned(),
            public_client_key: "public-key".to_owned(),
            authorization_endpoint: "https://project.supabase.co/auth/v1/oauth/authorize"
                .to_owned(),
            token_endpoint: "https://project.supabase.co/auth/v1/oauth/token".to_owned(),
            user_endpoint: "https://project.supabase.co/auth/v1/oauth/userinfo".to_owned(),
            client_id: "org2-desktop-client".to_owned(),
            redirect_uri: "https://cloud.example/auth/desktop/oauth/callback".to_owned(),
            scopes: vec!["email".to_owned(), "profile".to_owned()],
        }
    }

    fn valid_claims(expires_at: i64) -> AccessTokenClaims {
        AccessTokenClaims {
            iss: "https://project.supabase.co/auth/v1".to_owned(),
            sub: "user-123".to_owned(),
            aud: AudienceClaim::One("authenticated".to_owned()),
            exp: expires_at,
            client_id: Some("org2-desktop-client".to_owned()),
        }
    }

    #[test]
    fn loopback_request_parser_accepts_only_fixed_get_path() {
        let valid =
            b"GET /org2-cloud/oauth/callback?code=x&state=y HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_callback_request(valid, 49_152).as_deref(),
            Some("http://127.0.0.1:49152/org2-cloud/oauth/callback?code=x&state=y")
        );
        for invalid in [
            b"POST /org2-cloud/oauth/callback?code=x HTTP/1.1\r\n\r\n".as_slice(),
            b"GET /other?code=x HTTP/1.1\r\n\r\n".as_slice(),
            b"GET https://evil.example/callback HTTP/1.1\r\n\r\n".as_slice(),
            b"GET /org2-cloud/oauth/callback#fragment HTTP/1.1\r\n\r\n".as_slice(),
        ] {
            assert!(parse_callback_request(invalid, 49_152).is_none());
        }
    }

    #[test]
    fn endpoint_input_requires_an_https_or_loopback_origin() {
        assert_eq!(
            normalized_origin("https://project.supabase.co/").unwrap(),
            "https://project.supabase.co"
        );
        assert_eq!(
            normalized_origin("http://127.0.0.1:54321").unwrap(),
            "http://127.0.0.1:54321"
        );
        for invalid in [
            "http://project.supabase.co",
            "https://project.supabase.co/path",
            "https://user@project.supabase.co",
            "not-a-url",
        ] {
            assert!(normalized_origin(invalid).is_err());
        }
    }

    #[test]
    fn token_response_parser_rejects_malformed_or_scope_drift() {
        let expected_scopes = vec!["email".to_owned(), "profile".to_owned()];
        let valid = br#"{"access_token":"header.payload.signature","refresh_token":"refresh","token_type":"Bearer","expires_in":3600,"scope":"profile email","ignored":"allowed"}"#;
        let parsed = parse_token_response(SecretBytes::new(valid.to_vec()), &expected_scopes)
            .expect("valid token response");
        assert_eq!(parsed.scopes, vec!["profile", "email"]);

        for invalid in [
            br#"{"access_token":"a","refresh_token":"r","token_type":"mac","expires_in":3600,"scope":"email profile"}"#.as_slice(),
            br#"{"access_token":"a","refresh_token":"","token_type":"Bearer","expires_in":3600,"scope":"email profile"}"#.as_slice(),
            br#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":0,"scope":"email profile"}"#.as_slice(),
            br#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":3600,"scope":"email profile admin"}"#.as_slice(),
            br#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":3600,"scope":"email email"}"#.as_slice(),
            br#"not-json"#.as_slice(),
        ] {
            assert!(parse_token_response(
                SecretBytes::new(invalid.to_vec()),
                &expected_scopes
            )
            .is_err());
        }
    }

    #[test]
    fn legacy_refresh_parser_accepts_only_bounded_bearer_rotation() {
        let valid = br#"{"access_token":"header.payload.signature","refresh_token":"rotated-refresh","token_type":"Bearer","expires_in":3600}"#;
        let parsed = parse_legacy_refresh_response(SecretBytes::new(valid.to_vec()))
            .expect("legacy refresh response should parse");
        assert_eq!(
            parsed.access_credential.expose(),
            b"header.payload.signature"
        );
        assert_eq!(parsed.refresh_credential.expose(), b"rotated-refresh");
        assert_eq!(parsed.expires_in, 3_600);

        for invalid in [
            br#"{"access_token":"a","refresh_token":"r","token_type":"mac","expires_in":3600}"#
                .as_slice(),
            br#"{"access_token":"a","refresh_token":"","token_type":"Bearer","expires_in":3600}"#
                .as_slice(),
            br#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":0}"#
                .as_slice(),
            br#"not-json"#.as_slice(),
        ] {
            assert!(parse_legacy_refresh_response(SecretBytes::new(invalid.to_vec())).is_err());
        }
    }

    #[test]
    fn token_identity_requires_exact_issuer_client_audience_subject_and_expiry() {
        let config = oauth_config();
        let user = UserInfoWire {
            sub: "user-123".to_owned(),
            email: None,
            name: None,
            picture: None,
        };
        let now = 1_800_000_000;
        assert!(
            validate_token_identity(&config, &user, &valid_claims(now + 3_600), 3_600, now).is_ok()
        );

        let mut wrong_issuer = valid_claims(now + 3_600);
        wrong_issuer.iss = "https://evil.example/auth/v1".to_owned();
        let mut wrong_subject = valid_claims(now + 3_600);
        wrong_subject.sub = "other-user".to_owned();
        let mut wrong_audience = valid_claims(now + 3_600);
        wrong_audience.aud = AudienceClaim::One("anon".to_owned());
        let mut wrong_client = valid_claims(now + 3_600);
        wrong_client.client_id = Some("other-client".to_owned());
        let wrong_expiry = valid_claims(now + 3_900);
        for claims in [
            wrong_issuer,
            wrong_subject,
            wrong_audience,
            wrong_client,
            wrong_expiry,
        ] {
            assert!(validate_token_identity(&config, &user, &claims, 3_600, now).is_err());
        }
    }
}
