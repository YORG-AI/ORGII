//! Sanitization for HTTP error response bodies before they are embedded in
//! `ProviderError` strings and surfaced to the user.
//!
//! Some upstreams (proxies, load balancers, gateways) answer non-2xx requests
//! with a full HTML error page rather than a structured JSON envelope. Dumping
//! that raw page into the error string produces output like
//! `Request failed: HTTP 500: <!doctype html><html>...` which renders as broken
//! UI. This module collapses HTML / empty bodies into the standard status
//! reason phrase and trims/normalizes the remaining (plausibly useful) bodies.

use crate::utils::safe_truncate_utf8;

/// Max characters of a non-HTML error body we keep in the user-facing message.
const MAX_BODY_CHARS: usize = 300;

/// Produce a concise, human-readable message from an HTTP error response body.
///
/// - Empty / whitespace-only bodies → standard reason phrase for the status.
/// - HTML pages → the standard reason phrase (or the `<title>` text when the
///   status has no known phrase), never the raw markup.
/// - Anything else → whitespace-collapsed, length-bounded body text.
pub fn clean_error_message(status: u16, body: &str) -> String {
    let trimmed = body.trim();

    if trimmed.is_empty() {
        return status_label(status);
    }

    if looks_like_html(trimmed) {
        return reason_phrase(status)
            .map(str::to_string)
            .or_else(|| extract_html_title(trimmed))
            .unwrap_or_else(|| status_label(status));
    }

    let collapsed = collapse_whitespace(trimmed);
    safe_truncate_utf8(&collapsed, MAX_BODY_CHARS).to_string()
}

fn status_label(status: u16) -> String {
    match reason_phrase(status) {
        Some(reason) => reason.to_string(),
        None => format!("status {}", status),
    }
}

/// Heuristic detection of an HTML body (full pages or fragments).
fn looks_like_html(trimmed: &str) -> bool {
    let head = safe_truncate_utf8(trimmed, 256).to_ascii_lowercase();
    head.starts_with("<!doctype html")
        || head.starts_with("<html")
        || head.contains("<html")
        || head.contains("<head")
        || head.contains("<body")
        || head.contains("<title")
}

/// Extract and normalize the text inside the first `<title>...</title>` tag.
fn extract_html_title(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let content_start = open + lower[open..].find('>')? + 1;
    let close_rel = lower[content_start..].find("</title>")?;
    let title = body[content_start..content_start + close_rel].trim();
    let collapsed = collapse_whitespace(title);
    (!collapsed.is_empty()).then_some(collapsed)
}

/// Collapse runs of whitespace (including newlines) into single spaces.
fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Standard reason phrases for the HTTP status codes we expect from LLM
/// upstreams. Returns `None` for codes without a well-known phrase so callers
/// can fall back to a generic label.
fn reason_phrase(status: u16) -> Option<&'static str> {
    let phrase = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        529 => "Overloaded",
        _ => return None,
    };
    Some(phrase)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML_500: &str = "<!doctype html>\n<html lang=en>\n<title>500 Internal Server Error</title>\n<h1>Internal Server Error</h1>\n<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>";

    #[test]
    fn html_body_collapses_to_reason_phrase() {
        assert_eq!(clean_error_message(500, HTML_500), "Internal Server Error");
    }

    #[test]
    fn html_body_unknown_status_uses_title() {
        let body = "<html><head><title>Custom Gateway Error</title></head></html>";
        assert_eq!(clean_error_message(599, body), "Custom Gateway Error");
    }

    #[test]
    fn html_body_unknown_status_no_title_falls_back_to_label() {
        let body = "<html><body><h1>broken</h1></body></html>";
        assert_eq!(clean_error_message(599, body), "status 599");
    }

    #[test]
    fn json_body_is_preserved() {
        let body = r#"{"error":{"message":"invalid model"}}"#;
        assert_eq!(clean_error_message(400, body), body);
    }

    #[test]
    fn empty_body_uses_reason_phrase() {
        assert_eq!(clean_error_message(503, "   \n  "), "Service Unavailable");
    }

    #[test]
    fn empty_body_unknown_status_uses_label() {
        assert_eq!(clean_error_message(418, ""), "status 418");
    }

    #[test]
    fn long_plain_body_is_truncated() {
        let body = "x".repeat(1000);
        let cleaned = clean_error_message(400, &body);
        assert_eq!(cleaned.len(), MAX_BODY_CHARS);
    }

    #[test]
    fn multiline_plain_body_is_collapsed() {
        let body = "rate limit exceeded\n  please retry\n\nlater";
        assert_eq!(
            clean_error_message(429, body),
            "rate limit exceeded please retry later"
        );
    }

    #[test]
    fn multibyte_body_truncation_does_not_panic() {
        let body = "é".repeat(1000);
        let cleaned = clean_error_message(400, &body);
        assert!(cleaned.len() <= MAX_BODY_CHARS);
    }
}
