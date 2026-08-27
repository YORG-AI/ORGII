//! `web_fetch` tool — HTTP GET + readable-text extraction for a single URL.

use async_trait::async_trait;
use reqwest::{Client, Url};
use serde_json::Value;

use crate::tools::categories as tool_categories;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_int, required_string, Tool, ToolError};

/// Runaway guard when the model did not pass an explicit `max_chars`.
/// Deliberately far above the tool's 50K per-result budget: the turn
/// executor's truncate-or-persist layer stubs oversized results to disk
/// retrievably, so this cap only bounds pathological fetches (multi-MB
/// pages) before they reach that layer.
const FETCH_RUNAWAY_GUARD_CHARS: usize = 2_000_000;
const MAX_SAME_ORIGIN_REDIRECTS: usize = 5;

pub struct WebFetchTool {
    client: Client,
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebFetchTool {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("TLS backend initialization failed"),
        }
    }
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        tool_names::WEB_FETCH
    }

    fn category(&self) -> &str {
        tool_categories::WEB
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Fetch a web page and return its text content. Strips HTML and returns readable text."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL to fetch"
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Optional hard cap on returned characters. Omit to get the full extracted text (oversized results are saved to disk with an inline preview + file path)."
                }
            },
            "required": ["url"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let url = required_string(&params, "url")?;
        let explicit_max_chars = optional_int(&params, "max_chars").map(|v| v as usize);

        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(ToolError::InvalidParams(format!(
                "URL must start with http:// or https:// (got: {url}). \
                 For local files use `read_file` (with `offset`/`limit` for large files) \
                 or `code_search` (action: grep) — not a web tool.",
            )));
        }

        let requested_url = Url::parse(&url)
            .map_err(|err| ToolError::InvalidParams(format!("Invalid URL {url}: {err}")))?;
        let response = match fetch_following_same_origin_redirects(
            &self.client,
            requested_url,
            MAX_SAME_ORIGIN_REDIRECTS,
        )
        .await?
        {
            FetchOutcome::Fetched(response) => response,
            FetchOutcome::CrossHostRedirect { from, to } => {
                return Ok(format!(
                    "REDIRECT DETECTED\nOriginal URL: {from}\nRedirect target: {to}\n\nFor safety, web_fetch does not automatically follow redirects to a different origin (host, port, or scheme downgrade). If you intended to fetch the target, call web_fetch again with the redirect target URL."
                ));
            }
        };

        let _status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let body = response.text().await.map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to read response body: {}", err))
        })?;

        if content_type.contains("json") {
            return Ok(bound_fetched_text(body, explicit_max_chars));
        }

        let text = if content_type.contains("html") {
            html_to_readable_text(&body)
        } else {
            body
        };

        Ok(bound_fetched_text(text, explicit_max_chars))
    }
}

/// Apply the model-requested `max_chars` cap, or only the runaway guard when
/// none was given — the full text then flows to the executor's
/// truncate-or-persist layer, which stubs oversized results to disk
/// retrievably instead of destroying the remainder here.
fn bound_fetched_text(text: String, explicit_max_chars: Option<usize>) -> String {
    let cap = explicit_max_chars.unwrap_or(FETCH_RUNAWAY_GUARD_CHARS);
    if text.len() <= cap {
        return text;
    }
    let truncated: String = crate::utils::safe_truncate_chars_to_string(&text, cap);
    format!(
        "{}\n\n[...truncated, {} total chars]",
        truncated,
        text.len()
    )
}

/// Convert HTML to readable plain text preserving structure (headings, links, lists).
/// Strips `<script>`, `<style>`, `<nav>`, `<footer>` before conversion.
fn html_to_readable_text(html: &str) -> String {
    let cleaned = strip_noisy_tags(html);
    html2text::from_read(cleaned.as_bytes(), 120).unwrap_or(cleaned)
}

/// Remove script/style/nav/footer blocks before HTML-to-text conversion.
fn strip_noisy_tags(html: &str) -> String {
    let tag_patterns = ["script", "style", "nav", "footer", "noscript", "svg"];
    let mut result = html.to_string();
    for tag in &tag_patterns {
        loop {
            let open = format!("<{}", tag);
            let close = format!("</{}>", tag);
            let Some(start) = result.to_lowercase().find(&open) else {
                break;
            };
            let end_pos = result.to_lowercase()[start..]
                .find(&close)
                .map(|pos| start + pos + close.len())
                .unwrap_or_else(|| {
                    result[start..]
                        .find('>')
                        .map(|p| start + p + 1)
                        .unwrap_or(result.len())
                });
            result.replace_range(start..end_pos, "");
        }
    }
    result
}

enum FetchOutcome {
    Fetched(reqwest::Response),
    CrossHostRedirect { from: Url, to: Url },
}

async fn fetch_following_same_origin_redirects(
    client: &Client,
    mut current_url: Url,
    max_redirects: usize,
) -> Result<FetchOutcome, ToolError> {
    for _ in 0..=max_redirects {
        let response = client
            .get(current_url.clone())
            .header("User-Agent", "orgii-agent/1.0")
            .send()
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Fetch failed: {err}")))?;

        if !response.status().is_redirection() {
            return Ok(FetchOutcome::Fetched(response));
        }

        let Some(location) = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            return Ok(FetchOutcome::Fetched(response));
        };

        let next_url = current_url.join(location).map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "Invalid redirect location from {current_url}: {location} ({err})"
            ))
        })?;

        if !same_origin_or_https_upgrade(&current_url, &next_url) {
            return Ok(FetchOutcome::CrossHostRedirect {
                from: current_url,
                to: next_url,
            });
        }

        current_url = next_url;
    }

    Err(ToolError::ExecutionFailed(format!(
        "Too many redirects (>{max_redirects}) while fetching {current_url}"
    )))
}

/// Same-origin check for auto-followed redirects, with one carve-out: the
/// ubiquitous same-host `http` → `https` upgrade (default ports on both
/// sides) is followed automatically. Everything else — different host,
/// different port, or a scheme downgrade — interrupts with the redirect
/// notice.
fn same_origin_or_https_upgrade(from: &Url, to: &Url) -> bool {
    if from.host_str() != to.host_str() {
        return false;
    }
    if from.scheme() == to.scheme() {
        return from.port_or_known_default() == to.port_or_known_default();
    }
    from.scheme() == "http"
        && to.scheme() == "https"
        && from.port().is_none()
        && to.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::{bound_fetched_text, same_origin_or_https_upgrade, FETCH_RUNAWAY_GUARD_CHARS};
    use reqwest::Url;

    #[test]
    fn bound_fetched_text_honors_explicit_max_chars() {
        let text = "a".repeat(10_000);
        let out = bound_fetched_text(text, Some(1_000));
        assert!(out.starts_with(&"a".repeat(1_000)));
        assert!(out.contains("[...truncated, 10000 total chars]"));
    }

    #[test]
    fn bound_fetched_text_returns_full_text_without_explicit_cap() {
        // 100K would previously be cut at the 50K default; the full text
        // must now flow through so the executor persist layer can stub it.
        let text = "b".repeat(100_000);
        let out = bound_fetched_text(text.clone(), None);
        assert_eq!(out, text);
    }

    #[test]
    fn bound_fetched_text_applies_runaway_guard() {
        let text = "c".repeat(FETCH_RUNAWAY_GUARD_CHARS + 10);
        let out = bound_fetched_text(text, None);
        assert!(out.len() < FETCH_RUNAWAY_GUARD_CHARS + 100);
        assert!(out.contains("[...truncated,"));
    }

    #[test]
    fn allows_same_origin_path_redirects() {
        let from = Url::parse("https://example.com/docs").unwrap();
        let to = Url::parse("https://example.com/other").unwrap();

        assert!(same_origin_or_https_upgrade(&from, &to));
    }

    #[test]
    fn allows_same_host_https_upgrade() {
        let from = Url::parse("http://example.com/docs").unwrap();
        let to = Url::parse("https://example.com/docs").unwrap();

        assert!(same_origin_or_https_upgrade(&from, &to));
    }

    #[test]
    fn rejects_cross_host_redirects() {
        let from = Url::parse("https://example.com/docs").unwrap();
        let to = Url::parse("https://evil.example/docs").unwrap();

        assert!(!same_origin_or_https_upgrade(&from, &to));
    }

    #[test]
    fn rejects_scheme_downgrade_and_port_changes() {
        let https = Url::parse("https://example.com/docs").unwrap();
        let http = Url::parse("http://example.com/docs").unwrap();
        assert!(!same_origin_or_https_upgrade(&https, &http));

        let base = Url::parse("http://example.com/docs").unwrap();
        let odd_port = Url::parse("https://example.com:8443/docs").unwrap();
        assert!(!same_origin_or_https_upgrade(&base, &odd_port));
    }
}
