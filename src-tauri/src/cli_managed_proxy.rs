use axum::{
    body::{to_bytes, Body},
    extract::Path,
    http::{header::CONTENT_TYPE, HeaderMap, Method, Request, Response, StatusCode},
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use key_vault::key_store::KEY_SERVICE;
use serde::Serialize;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MANAGED_CODEX_AGENT: &str = "codex";
const MANAGED_CLAUDE_CODE_AGENT: &str = "claude_code";
const DEFAULT_CODEX_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
const ORGII_CURRENT_MODEL: &str = "orgii-current-model";
const MAX_PROXY_BODY_BYTES: usize = 64 * 1024 * 1024;
const OPENAI_API_PROVIDER: &str = "openai_api";
const ANTHROPIC_API_PROVIDER: &str = "anthropic_api";
const MAX_PROXY_RETRY_DELAY_SECS: u64 = 30;

static PROXY_START_REQUESTED: AtomicBool = AtomicBool::new(false);
static PROXY_RUNNING: AtomicBool = AtomicBool::new(false);
static PROXY_RETRY_ATTEMPT: AtomicU32 = AtomicU32::new(0);
static PROXY_LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManagedProxyStatus {
    pub agent_name: String,
    pub supported: bool,
    pub running: bool,
    pub ready: bool,
    pub url: String,
    pub selected_key_id: Option<String>,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub upstream_base_url: Option<String>,
    pub compatible_key_ids: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum ProxyProtocol {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone)]
struct ProxyContext {
    key_id: String,
    provider: String,
    model: String,
    upstream_base_url: String,
    api_key: String,
    proxy_token: String,
    protocol: ProxyProtocol,
}

#[derive(Debug, Clone, Copy)]
struct ProxyAgentDescriptor {
    protocol: ProxyProtocol,
    protocol_name: &'static str,
    display_name: &'static str,
    requires_openai_responses: bool,
}

pub fn start_cli_managed_proxy_thread() {
    if PROXY_START_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }

    // Async-IO proxy: two workers cover many concurrent CLI streams without
    // paying for a core-count worker pool.
    std::thread::spawn(|| {
        match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(rt) => {
                rt.block_on(supervise_proxy_server());
                PROXY_RUNNING.store(false, Ordering::SeqCst);
                PROXY_START_REQUESTED.store(false, Ordering::SeqCst);
            }
            Err(err) => {
                PROXY_RUNNING.store(false, Ordering::SeqCst);
                PROXY_START_REQUESTED.store(false, Ordering::SeqCst);
                set_proxy_last_error(Some(format!("Failed to create proxy runtime: {err}")));
                tracing::error!(error = %err, "[CLI Managed Proxy] failed to create tokio runtime");
            }
        }
    });
}

async fn supervise_proxy_server() {
    loop {
        let error = match run_proxy_server().await {
            Ok(()) => "Proxy server stopped unexpectedly".to_string(),
            Err(err) => err,
        };
        PROXY_RUNNING.store(false, Ordering::SeqCst);
        set_proxy_last_error(Some(error.clone()));

        let attempt = PROXY_RETRY_ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
        let retry_delay_secs = proxy_retry_delay_secs(attempt);
        tracing::warn!(
            error = %error,
            attempt,
            retry_delay_secs,
            "[CLI Managed Proxy] unavailable; retrying"
        );
        tokio::time::sleep(Duration::from_secs(retry_delay_secs)).await;
    }
}

fn proxy_retry_delay_secs(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1).min(5);
    (1_u64 << exponent).min(MAX_PROXY_RETRY_DELAY_SECS)
}

fn set_proxy_last_error(error: Option<String>) {
    let state = PROXY_LAST_ERROR.get_or_init(|| Mutex::new(None));
    match state.lock() {
        Ok(mut value) => *value = error,
        Err(poisoned) => *poisoned.into_inner() = error,
    }
}

fn proxy_last_error() -> Option<String> {
    let state = PROXY_LAST_ERROR.get_or_init(|| Mutex::new(None));
    match state.lock() {
        Ok(value) => value.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn proxy_unavailable_message() -> String {
    if let Some(error) = proxy_last_error() {
        let attempt = PROXY_RETRY_ATTEMPT.load(Ordering::SeqCst).max(1);
        return format!(
            "Local proxy is unavailable and will retry automatically (attempt {attempt}): {error}"
        );
    }
    if PROXY_START_REQUESTED.load(Ordering::SeqCst) {
        "Local proxy is starting".to_string()
    } else {
        "Local proxy has not started".to_string()
    }
}

async fn run_proxy_server() -> Result<(), String> {
    let addr = std::net::SocketAddr::from((
        [127, 0, 0, 1],
        agent_cli::managed_config::managed_proxy_port(),
    ));
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/proxy/{token}/v1", any(proxy_v1_root_handler))
        .route("/proxy/{token}/v1/{*path}", any(proxy_v1_handler))
        .route("/proxy/{token}/claude", any(proxy_claude_root_handler))
        .route("/proxy/{token}/claude/{*path}", any(proxy_claude_handler))
        .route("/cli/{agent}/{token}/v1", any(cli_v1_root_handler))
        .route("/cli/{agent}/{token}/v1/{*path}", any(cli_v1_handler))
        .route("/cli/{agent}/{token}/claude", any(cli_claude_root_handler))
        .route(
            "/cli/{agent}/{token}/claude/{*path}",
            any(cli_claude_handler),
        );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|err| format!("Failed to bind {addr}: {err}"))?;

    PROXY_RETRY_ATTEMPT.store(0, Ordering::SeqCst);
    set_proxy_last_error(None);
    PROXY_RUNNING.store(true, Ordering::SeqCst);
    tracing::info!("[CLI Managed Proxy] listening on http://{}", addr);
    let result = axum::serve(listener, app)
        .await
        .map_err(|err| format!("Proxy server error: {err}"));
    PROXY_RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn health_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "service": "orgii-cli-managed-proxy",
            "protocolVersion": 1,
            "running": true,
            "url": agent_cli::managed_config::managed_proxy_url(),
        })),
    )
        .into_response()
}

async fn proxy_v1_root_handler(
    Path(token): Path<String>,
    request: Request<Body>,
) -> Response<Body> {
    proxy_agent_handler(MANAGED_CODEX_AGENT, token, String::new(), request).await
}

async fn proxy_v1_handler(
    Path((token, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    proxy_agent_handler(MANAGED_CODEX_AGENT, token, path, request).await
}

async fn proxy_claude_root_handler(
    Path(token): Path<String>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD {
        return authenticated_empty_ok_response(MANAGED_CLAUDE_CODE_AGENT, &token);
    }

    proxy_agent_handler(MANAGED_CLAUDE_CODE_AGENT, token, String::new(), request).await
}

async fn proxy_claude_handler(
    Path((token, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD && path == "v1" {
        return authenticated_empty_ok_response(MANAGED_CLAUDE_CODE_AGENT, &token);
    }

    proxy_agent_handler(MANAGED_CLAUDE_CODE_AGENT, token, path, request).await
}

async fn cli_v1_root_handler(
    Path((agent, token)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    proxy_agent_handler(&agent, token, String::new(), request).await
}

async fn cli_v1_handler(
    Path((agent, token, path)): Path<(String, String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    proxy_agent_handler(&agent, token, path, request).await
}

async fn cli_claude_root_handler(
    Path((agent, token)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD {
        return authenticated_empty_ok_response(&agent, &token);
    }
    proxy_agent_handler(&agent, token, String::new(), request).await
}

async fn cli_claude_handler(
    Path((agent, token, path)): Path<(String, String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD && path == "v1" {
        return authenticated_empty_ok_response(&agent, &token);
    }
    proxy_agent_handler(&agent, token, path, request).await
}

async fn proxy_agent_handler(
    agent_name: &str,
    supplied_token: String,
    path: String,
    request: Request<Body>,
) -> Response<Body> {
    let context = match resolve_proxy_context(agent_name) {
        Ok(context) => context,
        Err(err) => {
            return json_error(StatusCode::PRECONDITION_FAILED, err);
        }
    };
    if !proxy_token_matches(&context.proxy_token, &supplied_token) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Invalid ORGII proxy token".to_string(),
        );
    }
    let query = forwarded_query(&context.protocol, request.uri().query());
    let path = match query {
        Some(query) if !query.is_empty() => format!("{path}?{query}"),
        _ => path,
    };

    let (parts, body) = request.into_parts();
    let body_bytes = match to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Failed to read proxy request body: {err}"),
            );
        }
    };

    let mut outbound_body = body_bytes.to_vec();
    if is_json_request(&parts.headers) && !outbound_body.is_empty() {
        if let Ok(mut value) = serde_json::from_slice::<Value>(&outbound_body) {
            rewrite_model_field(&mut value, &context.model);
            match serde_json::to_vec(&value) {
                Ok(bytes) => outbound_body = bytes,
                Err(err) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        format!("Failed to serialize proxy request body: {err}"),
                    );
                }
            }
        }
    }

    forward_request(parts.method, &parts.headers, &context, &path, outbound_body).await
}

fn empty_ok_response() -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap_or_else(|err| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build proxy response: {err}"),
            )
        })
}

fn authenticated_empty_ok_response(agent_name: &str, supplied_token: &str) -> Response<Body> {
    let context = match resolve_proxy_context(agent_name) {
        Ok(context) => context,
        Err(err) => return json_error(StatusCode::PRECONDITION_FAILED, err),
    };
    if !proxy_token_matches(&context.proxy_token, supplied_token) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Invalid ORGII proxy token".to_string(),
        );
    }
    empty_ok_response()
}

async fn forward_request(
    method: Method,
    incoming_headers: &HeaderMap,
    context: &ProxyContext,
    path: &str,
    body: Vec<u8>,
) -> Response<Body> {
    let client = PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    let url = match context.protocol {
        ProxyProtocol::OpenAi => build_upstream_url(&context.upstream_base_url, path),
        ProxyProtocol::Anthropic => build_anthropic_upstream_url(&context.upstream_base_url, path),
    };
    let url = match url {
        Ok(url) => url,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err),
    };

    let req_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut builder = client.request(req_method, url);

    for (name, value) in incoming_headers {
        if should_forward_header(name.as_str()) {
            builder = builder.header(name.as_str(), value.as_bytes());
        }
    }

    builder = apply_auth_header(
        builder,
        &context.protocol,
        &context.provider,
        &context.api_key,
    );
    if !incoming_headers.contains_key(CONTENT_TYPE) {
        builder = builder.header(CONTENT_TYPE.as_str(), "application/json");
    }

    let response = match builder.body(body).send().await {
        Ok(response) => response,
        Err(err) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to connect to upstream provider: {err}"),
            );
        }
    };

    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers().clone();

    let mut out = Response::builder().status(status);
    for (name, value) in headers.iter() {
        if should_forward_response_header(name.as_str()) {
            out = out.header(name, value);
        }
    }
    out.body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|err| {
            json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to build proxy response: {err}"),
            )
        })
}

fn proxy_token_matches(expected: &str, supplied: &str) -> bool {
    if expected.len() != supplied.len() {
        return false;
    }
    expected
        .as_bytes()
        .iter()
        .zip(supplied.as_bytes())
        .fold(0_u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

fn forwarded_query(_protocol: &ProxyProtocol, query: Option<&str>) -> Option<String> {
    query.filter(|value| !value.is_empty()).map(str::to_string)
}

fn is_json_request(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("json"))
        .unwrap_or(true)
}

fn rewrite_model_field(value: &mut Value, selected_model: &str) {
    let Some(object) = value.as_object_mut() else {
        return;
    };

    match object.get("model").and_then(Value::as_str) {
        Some(model) if model == ORGII_CURRENT_MODEL || model != selected_model => {
            object.insert(
                "model".to_string(),
                Value::String(selected_model.to_string()),
            );
        }
        None => {
            object.insert(
                "model".to_string(),
                Value::String(selected_model.to_string()),
            );
        }
        _ => {}
    }
}

fn build_upstream_url(base_url: &str, path: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(base_url).map_err(|err| format!("Invalid upstream base URL: {err}"))?;
    let (path, incoming_query) = path.split_once('?').unwrap_or((path, ""));
    let base_path = url.path().trim_end_matches('/');
    let incoming_path = path.trim_start_matches('/');
    let combined_path = if incoming_path.is_empty() {
        base_path.to_string()
    } else if base_path.is_empty() || base_path == "/" {
        format!("/{incoming_path}")
    } else {
        format!("{base_path}/{incoming_path}")
    };
    let base_query = url.query().map(str::to_string);
    let combined_query = match (base_query, incoming_query.is_empty()) {
        (Some(query), false) => Some(format!("{query}&{incoming_query}")),
        (Some(query), true) => Some(query),
        (None, false) => Some(incoming_query.to_string()),
        (None, true) => None,
    };
    url.set_path(&combined_path);
    url.set_query(combined_query.as_deref());
    Ok(url.to_string())
}

fn strip_path_prefix(path: &str, prefix: &str) -> String {
    let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
    let stripped = path_only.strip_prefix(prefix).unwrap_or(path_only);
    if query.is_empty() {
        stripped.to_string()
    } else {
        format!("{stripped}?{query}")
    }
}

fn build_anthropic_upstream_url(base_url: &str, path: &str) -> Result<String, String> {
    let base_path = reqwest::Url::parse(base_url)
        .map_err(|err| format!("Invalid Anthropic upstream base URL: {err}"))?
        .path()
        .trim_end_matches('/')
        .to_string();
    let path = if base_path.ends_with("/v1") {
        strip_path_prefix(path.trim_start_matches('/'), "v1/")
    } else {
        path.to_string()
    };
    build_upstream_url(base_url, &path)
}

fn should_forward_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "authorization"
            | "x-api-key"
            | "x-goog-api-key"
            | "api-key"
            | "host"
            | "content-length"
            | "connection"
            | "keep-alive"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn should_forward_response_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "content-length"
            | "connection"
            | "keep-alive"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn apply_auth_header(
    builder: reqwest::RequestBuilder,
    protocol: &ProxyProtocol,
    provider: &str,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match protocol {
        ProxyProtocol::OpenAi if provider == "azure_openai_api" => {
            builder.header("api-key", api_key)
        }
        ProxyProtocol::OpenAi => builder.header("Authorization", format!("Bearer {api_key}")),
        ProxyProtocol::Anthropic if provider == "azure_anthropic_api" => {
            builder.header("api-key", api_key)
        }
        ProxyProtocol::Anthropic => builder.header("x-api-key", api_key),
    }
}

fn protocol_for_agent(agent_name: &str) -> Result<ProxyAgentDescriptor, String> {
    use agent_cli::managed_config::CliManagedProxyProtocol;

    let proxy_protocol = agent_cli::managed_config::managed_proxy_protocol_for_agent(agent_name)
        .ok_or_else(|| {
            agent_cli::managed_config::managed_config_unavailable_reason_for_agent(agent_name)
                .map(str::to_string)
                .unwrap_or_else(|| format!("CLI managed proxy is not registered for {agent_name}"))
        })?;
    let display_name = key_vault::cli_agent_display_name(agent_name)
        .ok_or_else(|| format!("Missing CLI registry entry for {agent_name}"))?;
    let (protocol, protocol_name, requires_openai_responses) = match proxy_protocol {
        CliManagedProxyProtocol::OpenAiResponses => (ProxyProtocol::OpenAi, "openai", true),
        CliManagedProxyProtocol::OpenAiChatCompletions => (ProxyProtocol::OpenAi, "openai", false),
        CliManagedProxyProtocol::AnthropicMessages => {
            (ProxyProtocol::Anthropic, "anthropic", false)
        }
    };
    Ok(ProxyAgentDescriptor {
        protocol,
        protocol_name,
        display_name,
        requires_openai_responses,
    })
}

fn resolve_proxy_context_for_selection(
    agent_name: &str,
    key_id: Option<&str>,
    selected_model: Option<&str>,
    proxy_token: String,
) -> Result<ProxyContext, String> {
    let descriptor = protocol_for_agent(agent_name)?;
    let protocol = descriptor.protocol;
    let protocol_name = descriptor.protocol_name;
    let agent_display = descriptor.display_name;
    let key_id = key_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("No KeyVault key selected for {agent_display} managed config"))?;

    let key = KEY_SERVICE
        .get_key_by_id(key_id)
        .ok_or_else(|| format!("Selected KeyVault key does not exist: {key_id}"))?;

    if !key.enabled {
        return Err("Selected KeyVault key is disabled".to_string());
    }

    let provider = key.model_type.as_str().to_string();

    if !key_vault::is_cli_provider_compatible(agent_name, &provider) {
        return Err(format!(
            "Provider {provider} is not registered as compatible with {agent_display}"
        ));
    }

    if descriptor.requires_openai_responses && provider != OPENAI_API_PROVIDER {
        return Err(format!(
            "Provider {provider} is OpenAI-compatible but is not verified for the Responses API required by {agent_display} managed config"
        ));
    }

    let provider_config = key_vault::provider_config::get_provider_config(&provider);
    if !provider_config
        .supported_protocols
        .iter()
        .any(|protocol| protocol == protocol_name)
    {
        return Err(format!(
            "Provider {provider} is not {protocol_name}-compatible for {agent_display} managed proxy"
        ));
    }

    let api_key = key
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Selected key has no API key material. OAuth/subscription proxying is not supported yet."
                .to_string()
        })?
        .to_string();

    let upstream_base_url = key
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| match protocol {
            ProxyProtocol::OpenAi => provider_config.default_base_url.clone(),
            ProxyProtocol::Anthropic => provider_config
                .default_anthropic_base_url()
                .or(provider_config.default_base_url.clone()),
        })
        .or_else(|| {
            if matches!(protocol, ProxyProtocol::OpenAi) && provider == OPENAI_API_PROVIDER {
                Some(DEFAULT_CODEX_OPENAI_BASE_URL.to_string())
            } else if matches!(protocol, ProxyProtocol::Anthropic)
                && provider == ANTHROPIC_API_PROVIDER
            {
                Some(DEFAULT_ANTHROPIC_BASE_URL.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Provider {provider} requires a base URL before proxying"))?;
    let parsed_base_url = reqwest::Url::parse(&upstream_base_url)
        .map_err(|err| format!("Provider {provider} has an invalid base URL: {err}"))?;
    if !matches!(parsed_base_url.scheme(), "http" | "https") {
        return Err(format!(
            "Provider {provider} base URL must use http or https"
        ));
    }

    let configured_models = if key.enabled_models.is_empty() {
        &key.available_models
    } else {
        &key.enabled_models
    };
    let requested_model = selected_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model = match requested_model {
        Some(model)
            if configured_models
                .iter()
                .any(|candidate| candidate.trim() == model) =>
        {
            model.to_string()
        }
        Some(model) => {
            return Err(format!(
                "Model {model} is not enabled for the selected KeyVault key"
            ));
        }
        None => configured_models
            .iter()
            .map(|model| model.trim())
            .find(|model| !model.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("No model selected for {agent_display} managed config"))?,
    };

    Ok(ProxyContext {
        key_id: key_id.to_string(),
        provider,
        model,
        upstream_base_url,
        api_key,
        proxy_token,
        protocol,
    })
}

fn resolve_proxy_context(agent_name: &str) -> Result<ProxyContext, String> {
    let agent_display = protocol_for_agent(agent_name)?.display_name;
    let selection = agent_cli::managed_config::managed_selection_for_agent(agent_name)?
        .ok_or_else(|| format!("{agent_display} is not in ORGII Managed config mode"))?;
    let proxy_token = selection
        .proxy_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("{agent_display} managed config predates proxy authentication; apply it again")
        })?;
    resolve_proxy_context_for_selection(
        agent_name,
        selection.selected_key_id.as_deref(),
        selection.selected_model.as_deref(),
        proxy_token,
    )
}

fn compatible_key_ids_for_agent(agent_name: &str) -> Vec<String> {
    KEY_SERVICE
        .list_keys()
        .into_iter()
        .filter(|key| {
            resolve_proxy_context_for_selection(agent_name, Some(&key.id), None, String::new())
                .is_ok()
        })
        .map(|key| key.id)
        .collect()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_enable_orgii_managed(
    agent_name: String,
    key_id: Option<String>,
    model: Option<String>,
    force: bool,
) -> Result<agent_cli::managed_config::CliConfigManagedStatus, String> {
    start_cli_managed_proxy_thread();
    tokio::task::spawn_blocking(move || {
        if !PROXY_RUNNING.load(Ordering::SeqCst) {
            return Err(proxy_unavailable_message());
        }
        let context = resolve_proxy_context_for_selection(
            &agent_name,
            key_id.as_deref(),
            model.as_deref(),
            String::new(),
        )?;
        agent_cli::managed_config::enable_orgii_managed(
            &agent_name,
            Some(context.key_id),
            Some(context.provider),
            Some(context.model),
            force,
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_managed_proxy_status(agent_name: String) -> Result<CliManagedProxyStatus, String> {
    start_cli_managed_proxy_thread();
    let running = PROXY_RUNNING.load(Ordering::SeqCst);
    let url = agent_cli::managed_config::managed_proxy_url();

    if let Err(reason) = protocol_for_agent(&agent_name) {
        return Ok(CliManagedProxyStatus {
            agent_name,
            supported: false,
            running,
            ready: false,
            url,
            selected_key_id: None,
            selected_provider: None,
            selected_model: None,
            upstream_base_url: None,
            compatible_key_ids: Vec::new(),
            message: Some(reason),
        });
    }

    let compatible_key_ids = compatible_key_ids_for_agent(&agent_name);

    match resolve_proxy_context(&agent_name) {
        Ok(context) => {
            let message = if running {
                None
            } else {
                Some(proxy_unavailable_message())
            };
            Ok(CliManagedProxyStatus {
                agent_name,
                supported: true,
                running,
                ready: running,
                url,
                selected_key_id: Some(context.key_id),
                selected_provider: Some(context.provider),
                selected_model: Some(context.model),
                upstream_base_url: Some(context.upstream_base_url),
                compatible_key_ids: compatible_key_ids.clone(),
                message,
            })
        }
        Err(err) => {
            let selection = agent_cli::managed_config::managed_selection_for_agent(&agent_name)?;
            let message = if running {
                err
            } else {
                format!("{}; {err}", proxy_unavailable_message())
            };
            Ok(CliManagedProxyStatus {
                agent_name,
                supported: true,
                running,
                ready: false,
                url,
                selected_key_id: selection
                    .as_ref()
                    .and_then(|selection| selection.selected_key_id.clone()),
                selected_provider: selection
                    .as_ref()
                    .and_then(|selection| selection.selected_provider.clone()),
                selected_model: selection
                    .as_ref()
                    .and_then(|selection| selection.selected_model.clone()),
                upstream_base_url: None,
                compatible_key_ids,
                message: Some(message),
            })
        }
    }
}

fn json_error(status: StatusCode, message: String) -> Response<Body> {
    let body = serde_json::json!({
        "error": {
            "message": message,
            "type": "orgii_cli_managed_proxy_error",
        }
    });

    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::from("proxy error")))
}

#[allow(dead_code)]
fn response_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{prefix}_{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rewrites_placeholder_model() {
        let mut value = json!({
            "model": ORGII_CURRENT_MODEL,
            "input": "hello"
        });

        rewrite_model_field(&mut value, "gpt-5.1");

        assert_eq!(value["model"], "gpt-5.1");
    }

    #[test]
    fn inserts_missing_model() {
        let mut value = json!({
            "input": "hello"
        });

        rewrite_model_field(&mut value, "gpt-5.1");

        assert_eq!(value["model"], "gpt-5.1");
    }

    #[test]
    fn managed_adapter_protocols_drive_proxy_capabilities() {
        let codex = protocol_for_agent("codex").unwrap();
        assert!(matches!(codex.protocol, ProxyProtocol::OpenAi));
        assert!(codex.requires_openai_responses);

        let opencode = protocol_for_agent("opencode").unwrap();
        assert!(matches!(opencode.protocol, ProxyProtocol::OpenAi));
        assert!(!opencode.requires_openai_responses);

        let aider = protocol_for_agent("aider").unwrap();
        assert!(matches!(aider.protocol, ProxyProtocol::OpenAi));
        assert!(!aider.requires_openai_responses);
    }

    #[test]
    fn proxy_retry_delay_is_exponential_and_capped() {
        assert_eq!(proxy_retry_delay_secs(1), 1);
        assert_eq!(proxy_retry_delay_secs(2), 2);
        assert_eq!(proxy_retry_delay_secs(3), 4);
        assert_eq!(proxy_retry_delay_secs(5), 16);
        assert_eq!(proxy_retry_delay_secs(6), 30);
        assert_eq!(proxy_retry_delay_secs(20), 30);
    }

    #[test]
    fn builds_upstream_url_without_double_slashes() {
        assert_eq!(
            build_upstream_url("https://api.openai.com/v1/", "/responses").unwrap(),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn upstream_url_preserves_base_and_incoming_queries() {
        assert_eq!(
            build_upstream_url(
                "https://example.test/openai?api-version=2026-01-01",
                "responses?stream=true"
            )
            .unwrap(),
            "https://example.test/openai/responses?api-version=2026-01-01&stream=true"
        );
    }

    #[test]
    fn builds_anthropic_upstream_url_without_double_v1() {
        assert_eq!(
            build_anthropic_upstream_url("https://api.anthropic.com/v1", "v1/messages").unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_anthropic_upstream_url("https://zenmux.ai/api/anthropic", "v1/messages").unwrap(),
            "https://zenmux.ai/api/anthropic/v1/messages"
        );
    }

    #[test]
    fn proxy_token_check_rejects_missing_or_modified_tokens() {
        assert!(proxy_token_matches("abc123", "abc123"));
        assert!(!proxy_token_matches("abc123", "abc124"));
        assert!(!proxy_token_matches("abc123", "abc12"));
    }

    #[test]
    fn proxy_forwards_query_parameters() {
        assert_eq!(
            forwarded_query(&ProxyProtocol::OpenAi, Some("api-version=2026-01-01")),
            Some("api-version=2026-01-01".to_string())
        );
    }
}
