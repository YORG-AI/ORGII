//! GitHub API Client
//!
//! Thin wrapper around `reqwest` for the GitHub REST and GraphQL APIs.
//! Takes a bearer token directly — credential resolution happens at the
//! command layer (`commands::resolve_token`) via the centralized
//! `project_management::sync::connection_token_store`. If GitHub explicitly
//! rejects that OAuth app under organization restrictions, API requests retry
//! once with the user's active GitHub CLI keyring credential.
//!
//! 401 responses surface to the caller as `Err("GitHubReAuthRequired: …")`;
//! the user re-authorizes through the Connections wizard.

use reqwest::{Client, Method, Response, StatusCode};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::detect::resolve_gh_cli_token;

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

        log::info!("[GitHub][API] GET {path} (conditional)");
        let mut resp = self
            .do_conditional_get(path, cached_etag.as_deref(), &self.token)
            .await?;
        if resp.status() == StatusCode::FORBIDDEN {
            let status = resp.status();
            let body = resp
                .text()
                .await
                .map_err(|err| format!("Failed to read response body: {err}"))?;
            if let Some(fallback_token) =
                oauth_restriction_fallback_token(status, &body, &format!("GET {path}")).await?
            {
                resp = self
                    .do_conditional_get(path, cached_etag.as_deref(), &fallback_token)
                    .await?;
            } else {
                return parse_response_body(status, body);
            }
        }
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
        log::info!("[GitHub][API] GET {path} (raw)");
        let mut resp = self.do_raw_get(path, accept, &self.token).await?;
        if resp.status() == StatusCode::FORBIDDEN {
            let status = resp.status();
            let body = resp
                .text()
                .await
                .map_err(|err| format!("Failed to read response body: {err}"))?;
            if let Some(fallback_token) =
                oauth_restriction_fallback_token(status, &body, &format!("GET {path}")).await?
            {
                resp = self.do_raw_get(path, accept, &fallback_token).await?;
            } else {
                return Err(format_api_error(status, &body));
            }
        }
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
            Err(format_api_error(status, &String::from_utf8_lossy(&bytes)))
        }
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::POST, path, Some(body)).await
    }

    /// PUT request to the GitHub REST API with a JSON body.
    pub async fn put(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::PUT, path, Some(body)).await
    }

    /// PATCH request to the GitHub REST API with a JSON body.
    pub async fn patch(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::PATCH, path, Some(body)).await
    }

    /// DELETE request to the GitHub REST API with a JSON body.
    ///
    /// GitHub's remove-assignees endpoint requires the logins in the request
    /// body, so it cannot use a body-less DELETE helper.
    pub async fn delete_with_body(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::DELETE, path, Some(body)).await
    }

    pub async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        log::info!("[GitHub][GraphQL] Executing query");
        let body = serde_json::json!({ "query": query, "variables": variables });
        let mut resp = self.do_graphql_request(&body, &self.token).await?;
        let mut retried_with_cli = false;
        if resp.status() == StatusCode::FORBIDDEN {
            let status = resp.status();
            let response_body = resp
                .text()
                .await
                .map_err(|err| format!("Failed to read response body: {err}"))?;
            if let Some(fallback_token) =
                oauth_restriction_fallback_token(status, &response_body, "GraphQL").await?
            {
                resp = self.do_graphql_request(&body, &fallback_token).await?;
                retried_with_cli = true;
            } else {
                return parse_response_body(status, response_body);
            }
        }
        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err("GitHubReAuthRequired: GraphQL returned 401".to_string());
        }
        let value = Self::parse_response(resp).await?;

        // Unlike REST, the GraphQL endpoint reports an OAuth App access
        // restriction as HTTP 200 with an `errors` array, so the status check
        // above never sees it. Without this, every GraphQL-only write — draft
        // state, merge, auto-merge — fails under an organization restriction
        // even though a usable GitHub CLI credential is right there, and the
        // caller surfaces GitHub's raw wording instead of our guidance.
        let Some(restriction) = graphql_restriction_error(&value) else {
            return Ok(value);
        };
        if retried_with_cli {
            return Err(format_api_error(StatusCode::FORBIDDEN, &restriction));
        }
        let Some(fallback_token) =
            oauth_restriction_fallback_token(StatusCode::FORBIDDEN, &restriction, "GraphQL")
                .await?
        else {
            return Ok(value);
        };
        let retry = self.do_graphql_request(&body, &fallback_token).await?;
        if retry.status() == StatusCode::UNAUTHORIZED {
            return Err(
                "GitHub CLI credential was rejected; run `gh auth login` and try again."
                    .to_string(),
            );
        }
        Self::parse_response(retry).await
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
        if resp.status() == StatusCode::FORBIDDEN {
            let status = resp.status();
            let response_body = resp
                .text()
                .await
                .map_err(|err| format!("Failed to read response body: {err}"))?;
            if let Some(fallback_token) = oauth_restriction_fallback_token(
                status,
                &response_body,
                &format!("{method} {path}"),
            )
            .await?
            {
                let fallback_resp = self
                    .do_rest_request_with_token(
                        method.clone(),
                        path,
                        body.as_ref(),
                        &fallback_token,
                    )
                    .await?;
                if fallback_resp.status() == StatusCode::UNAUTHORIZED {
                    return Err(
                        "GitHub CLI credential was rejected; run `gh auth login` and try again."
                            .to_string(),
                    );
                }
                return Self::parse_response(fallback_resp).await;
            }
            return parse_response_body(status, response_body);
        }
        Self::parse_response(resp).await
    }

    async fn do_rest_request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response, String> {
        self.do_rest_request_with_token(method, path, body, &self.token)
            .await
    }

    async fn do_conditional_get(
        &self,
        path: &str,
        etag: Option<&str>,
        token: &str,
    ) -> Result<Response, String> {
        let url = format!("{GITHUB_API_URL}{path}");
        let mut request = self
            .http
            .get(&url)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github.v3+json")
            .header("User-Agent", USER_AGENT);
        if let Some(etag) = etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        request
            .send()
            .await
            .map_err(|err| format!("GitHub API request failed: {err}"))
    }

    async fn do_raw_get(&self, path: &str, accept: &str, token: &str) -> Result<Response, String> {
        self.http
            .get(format!("{GITHUB_API_URL}{path}"))
            .bearer_auth(token)
            .header("Accept", accept)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|err| format!("GitHub API request failed: {err}"))
    }

    async fn do_graphql_request(&self, body: &Value, token: &str) -> Result<Response, String> {
        self.http
            .post(GITHUB_GRAPHQL_URL)
            .bearer_auth(token)
            .header("User-Agent", USER_AGENT)
            .json(body)
            .send()
            .await
            .map_err(|err| format!("GitHub GraphQL request failed: {err}"))
    }

    async fn do_rest_request_with_token(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<Response, String> {
        let url = format!("{GITHUB_API_URL}{path}");
        let mut req = self
            .http
            .request(method, &url)
            .bearer_auth(token)
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
        parse_response_body(status, body)
    }
}

fn parse_response_body(status: StatusCode, body: String) -> Result<Value, String> {
    if status.is_success() {
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&body).map_err(|err| format!("Failed to parse JSON: {err}"))
    } else {
        Err(format_api_error(status, &body))
    }
}

fn is_oauth_app_access_restriction(body: &str) -> bool {
    body.to_lowercase()
        .contains("oauth app access restrictions")
}

/// An OAuth App restriction reported inside a successful GraphQL payload,
/// rebuilt as an error body so it flows through the same helpers as a REST
/// 403. Returns `None` for a clean response or for unrelated GraphQL errors,
/// which the caller still owns.
fn graphql_restriction_error(value: &Value) -> Option<String> {
    let messages = value["errors"]
        .as_array()?
        .iter()
        .filter_map(|error| error["message"].as_str())
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return None;
    }
    let joined = messages.join("; ");
    is_oauth_app_access_restriction(&joined)
        .then(|| serde_json::json!({ "message": joined }).to_string())
}

async fn oauth_restriction_fallback_token(
    status: StatusCode,
    body: &str,
    operation: &str,
) -> Result<Option<String>, String> {
    if status != StatusCode::FORBIDDEN || !is_oauth_app_access_restriction(body) {
        return Ok(None);
    }
    let Some(token) = resolve_gh_cli_token().await else {
        return Err(format!(
            "{} No approved GitHub CLI credential was found; sign in with `gh auth login` or approve ORGII in the organization settings.",
            format_api_error(status, body)
        ));
    };
    log::info!(
        "[GitHub][Auth] retrying {operation} with GitHub CLI credential after OAuth app restriction"
    );
    Ok(Some(token))
}

fn format_api_error(status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    if status == StatusCode::FORBIDDEN
        && message
            .to_lowercase()
            .contains("oauth app access restrictions")
    {
        return "GitHub access blocked: this organization has OAuth App access restrictions. Ask an organization owner to approve the app for this organization."
            .to_string();
    }
    format!("GitHub API error {}: {message}", status.as_u16())
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;

    use serde_json::json;

    use super::{format_api_error, graphql_restriction_error, is_oauth_app_access_restriction};

    #[test]
    fn formats_oauth_app_restriction_without_raw_json() {
        let error = format_api_error(
            StatusCode::FORBIDDEN,
            r#"{"message":"The organization has enabled OAuth App access restrictions","status":"403"}"#,
        );

        assert!(error.contains("OAuth App access restrictions"));
        assert!(error.contains("organization owner"));
        assert!(!error.contains("{\"message\""));
    }

    #[test]
    fn distinguishes_oauth_restrictions_from_other_forbidden_errors() {
        assert!(is_oauth_app_access_restriction(
            r#"{"message":"OAuth App access restrictions are enabled"}"#
        ));
        assert!(!is_oauth_app_access_restriction(
            r#"{"message":"API rate limit exceeded"}"#
        ));
    }

    #[test]
    fn detects_an_oauth_restriction_reported_inside_a_200_graphql_payload() {
        // GitHub answers a restricted GraphQL call with HTTP 200 and an
        // `errors` array, so the status code alone never reveals it.
        let restriction = graphql_restriction_error(&json!({
            "data": null,
            "errors": [{
                "message": "Although you appear to have the correct authorization credentials, the `org2AI` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited."
            }]
        }))
        .expect("restriction should be detected");

        assert!(is_oauth_app_access_restriction(&restriction));
        // Rebuilt as an error body so it formats like a REST 403 does.
        let error = format_api_error(StatusCode::FORBIDDEN, &restriction);
        assert!(error.contains("organization owner"));
        assert!(!error.contains("third-parties"));
    }

    #[test]
    fn leaves_clean_and_unrelated_graphql_responses_to_the_caller() {
        assert!(graphql_restriction_error(&json!({ "data": { "node": null } })).is_none());
        assert!(graphql_restriction_error(&json!({
            "errors": [{ "message": "Could not resolve to a node with the global id" }]
        }))
        .is_none());
        assert!(graphql_restriction_error(&json!({ "errors": [] })).is_none());
    }
}
