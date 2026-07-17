//! GitHub API Client
//!
//! Thin wrapper around `reqwest` for the GitHub REST and GraphQL APIs.
//! Takes a bearer token directly — credential resolution happens at the
//! command layer (`commands::resolve_token`) via the centralized
//! `project_management::sync::connection_token_store`.
//!
//! 401 responses surface to the caller as `Err("GitHubReAuthRequired: …")`;
//! the user re-authorizes through the Connections wizard.

use reqwest::{Client, Method, Response, StatusCode};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_GRAPHQL_URL: &str = "https://api.github.com/graphql";
const USER_AGENT: &str = "ORGII-Desktop/1.0";

/// Upper bound on distinct paths tracked by the conditional-request cache.
/// Keys are per-`owner/repo` list/detail paths, so a handful of repos stay
/// well under this; the cap only guards against unbounded growth over a long
/// session. When exceeded the whole map is cleared (simple, rarely hit).
const ETAG_CACHE_MAX_ENTRIES: usize = 256;

struct ETagEntry {
    etag: String,
    value: Value,
}

/// Process-wide `ETag` cache for conditional GETs. Lives at module scope so it
/// survives the per-command `GitHubClient` instances (one is created per
/// `#[command]` via `make_client`). Lets read endpoints send `If-None-Match`
/// and reuse the cached JSON on a `304 Not Modified` — which GitHub does *not*
/// count against the primary rate limit, so warm refreshes are near-free.
fn etag_cache() -> &'static Mutex<HashMap<String, ETagEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ETagEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct GitHubClient {
    http: Client,
    token: String,
}

impl GitHubClient {
    pub fn new(token: String) -> Self {
        Self {
            http: Client::new(),
            token,
        }
    }

    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.request(Method::GET, path, None).await
    }

    /// GET with `If-None-Match` conditional-request support.
    ///
    /// Sends the previously stored `ETag` for `path`; on `304 Not Modified`
    /// returns the cached JSON without re-parsing a body, on `200` refreshes
    /// the cache. Behaves exactly like [`get`](Self::get) for callers — the
    /// caching is transparent — but makes warm list/detail refreshes cheap.
    /// Falls back to the plain response value when no `ETag` is present.
    pub async fn get_conditional(&self, path: &str) -> Result<Value, String> {
        let cached_etag = etag_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(path).map(|entry| entry.etag.clone()));

        let url = format!("{GITHUB_API_URL}{path}");
        let mut req = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github.v3+json")
            .header("User-Agent", USER_AGENT);
        if let Some(etag) = &cached_etag {
            req = req.header(reqwest::header::IF_NONE_MATCH, etag.clone());
        }

        log::info!("[GitHub][API] GET {path} (conditional)");
        let resp = req
            .send()
            .await
            .map_err(|err| format!("GitHub API request failed: {err}"))?;
        let status = resp.status();

        if status == StatusCode::UNAUTHORIZED {
            return Err(format!("GitHubReAuthRequired: GET {path} returned 401"));
        }

        if status == StatusCode::NOT_MODIFIED {
            if let Some(entry) = etag_cache()
                .lock()
                .ok()
                .and_then(|cache| cache.get(path).map(|entry| entry.value.clone()))
            {
                log::info!("[GitHub][API] 304 {path} (served from ETag cache)");
                return Ok(entry);
            }
            // 304 but the cache was cleared underneath us — fall back to a
            // plain (unconditional) fetch so the caller still gets data.
            return self.get(path).await;
        }

        // Capture the ETag header before `parse_response` consumes the body.
        let etag = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(String::from);

        let value = Self::parse_response(resp).await?;

        if let Some(etag) = etag {
            if let Ok(mut cache) = etag_cache().lock() {
                if cache.len() >= ETAG_CACHE_MAX_ENTRIES && !cache.contains_key(path) {
                    cache.clear();
                }
                cache.insert(
                    path.to_string(),
                    ETagEntry {
                        etag,
                        value: value.clone(),
                    },
                );
            }
        }

        Ok(value)
    }

    /// GET raw bytes with a caller-supplied `Accept` (e.g.
    /// `application/vnd.github.raw` for the Contents API). Used to pull a
    /// file's exact bytes at a commit SHA for the PR diff viewer — no JSON
    /// parsing, no local clone. 401 surfaces as the canonical re-auth error.
    pub async fn get_raw(&self, path: &str, accept: &str) -> Result<Vec<u8>, String> {
        let url = format!("{GITHUB_API_URL}{path}");
        log::info!("[GitHub][API] GET {path} (raw)");
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .header("Accept", accept)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|err| format!("GitHub API request failed: {err}"))?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(format!("GitHubReAuthRequired: GET {path} returned 401"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("Failed to read response body: {err}"))?;
        if status.is_success() {
            Ok(bytes.to_vec())
        } else {
            Err(format!(
                "GitHub API error {}: {}",
                status.as_u16(),
                String::from_utf8_lossy(&bytes)
            ))
        }
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::POST, path, Some(body)).await
    }

    /// PATCH request to the GitHub REST API with a JSON body.
    pub async fn patch(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::PATCH, path, Some(body)).await
    }

    pub async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        log::info!("[GitHub][GraphQL] Executing query");
        let body = serde_json::json!({ "query": query, "variables": variables });
        let resp = self
            .http
            .post(GITHUB_GRAPHQL_URL)
            .bearer_auth(&self.token)
            .header("User-Agent", USER_AGENT)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("GitHub GraphQL request failed: {err}"))?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err("GitHubReAuthRequired: GraphQL returned 401".to_string());
        }
        Self::parse_response(resp).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        log::info!("[GitHub][API] {} {}", method, path);
        let resp = self
            .do_rest_request(method.clone(), path, body.as_ref())
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err(format!(
                "GitHubReAuthRequired: {method} {path} returned 401"
            ));
        }
        Self::parse_response(resp).await
    }

    async fn do_rest_request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response, String> {
        let url = format!("{GITHUB_API_URL}{path}");
        let mut req = self
            .http
            .request(method, &url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github.v3+json")
            .header("User-Agent", USER_AGENT);
        if let Some(payload) = body {
            req = req.json(payload);
        }
        req.send()
            .await
            .map_err(|err| format!("GitHub API request failed: {err}"))
    }

    async fn parse_response(resp: Response) -> Result<Value, String> {
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|err| format!("Failed to read response body: {err}"))?;
        if status.is_success() {
            if body.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(&body).map_err(|err| format!("Failed to parse JSON: {err}"))
        } else {
            Err(format!("GitHub API error {}: {}", status.as_u16(), body))
        }
    }
}
