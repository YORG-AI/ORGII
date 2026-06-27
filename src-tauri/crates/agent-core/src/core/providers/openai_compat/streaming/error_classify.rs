//! Heuristic error frame classifiers for the SSE stream.
//!
//! - [`classify_invalid_args`] groups `serde_json` failures on the streamed
//!   tool-arguments string into the four root causes that have actually
//!   shown up in production logs (truncated / concatenated / double-encoded
//!   / leading garbage / unbalanced).
//! - [`looks_overloaded`] detects upstream-capacity exhaustion (HTTP 529 /
//!   `overloaded_error`) so the retry layer can pick the short backoff.
//! - [`parse_retry_after_ms`] extracts a provider-supplied retry floor in
//!   milliseconds from the JSON body of an SSE error frame.

/// Heuristic root-cause classifier for an args string that
/// `serde_json::from_str` rejected. Returns a human-readable static
/// label suitable for logging.
///
/// The order of the checks matters — we try the cheapest, most
/// distinctive checks first (`is_empty`, leading char) before
/// scanning for brace balance.
pub(super) fn classify_invalid_args(args_str: &str) -> &'static str {
    if args_str.is_empty() {
        return "empty (no arguments deltas received)";
    }
    let trimmed = args_str.trim_start();
    if trimmed.starts_with('"') {
        return "double-encoded string (provider wrapped args in a JSON string literal)";
    }
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return "leading garbage (likely truncated or index collision)";
    }

    // Scan once, tracking string state so braces inside strings
    // do not affect the depth counter.
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut esc = false;
    let mut max_depth: i32 = 0;
    let mut returned_to_zero_then_opens = false;
    for ch in args_str.chars() {
        if esc {
            esc = false;
            continue;
        }
        if ch == '\\' {
            esc = true;
            continue;
        }
        if ch == '"' {
            in_str = !in_str;
            continue;
        }
        if in_str {
            continue;
        }
        match ch {
            '{' | '[' => {
                if depth == 0 && max_depth > 0 {
                    returned_to_zero_then_opens = true;
                }
                depth += 1;
                if depth > max_depth {
                    max_depth = depth;
                }
            }
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }

    if returned_to_zero_then_opens {
        "concatenated objects (multi-tool index collision: two tool_calls accumulated under the same index)"
    } else if depth > 0 {
        "truncated (stream ended before closing braces)"
    } else if depth < 0 {
        "unbalanced (more closes than opens)"
    } else {
        "balanced but invalid JSON syntax"
    }
}

/// Heuristic classifier: does this provider error frame signal upstream
/// capacity exhaustion (HTTP 529 / `overloaded`)?
///
/// Recognized signals:
///   - status code `529` (Anthropic's "overloaded" convention)
///   - structured `"type":"overloaded_error"` in the body
///   - literal substring `"overloaded"` (loose catch for gateway wrappers
///     like OpenRouter / cursorlinkai.com / LiteLLM that reshape the
///     payload but preserve the keyword)
///   - HTTP 529 status surfaced as a plain integer in the SSE frame
///
/// Returns `false` for other 5xx errors — those still retry but on the
/// longer `ProviderError` budget, not the short `Overloaded` one.
pub(super) fn looks_overloaded(sse_data: &str) -> bool {
    if sse_data.contains("\"type\":\"overloaded_error\"")
        || sse_data.contains("overloaded_error")
        || sse_data.contains("\"status\":529")
        || sse_data.contains("\"code\":529")
    {
        return true;
    }
    // Loose word match; guarded to the error-frame context so we don't
    // misclassify model output content that happens to mention the word.
    let lower = sse_data.to_ascii_lowercase();
    lower.contains("overloaded") || lower.contains("overload")
}

/// Extract a provider-supplied retry floor (in milliseconds) from an SSE
/// error frame body.
///
/// Inspects fallback fields inside the JSON error body. Since SSE
/// error frames arrive **inside** a 200 OK response, the HTTP
/// `Retry-After` header is unavailable at this point — we can only
/// reach the fields that the provider embeds in the JSON payload.
///
/// Recognized fields (checked in priority order, first hit wins):
///   - `retry_after_ms` / `retryAfterMs` — already in milliseconds, no conversion
///   - `retry_after` / `retryAfter` — seconds, multiplied by 1000
///   - nested under `error.*` and `headers.*` variants
///
/// Returns `None` if no recognizable floor is found; the retry layer then
/// falls back to the exponential `stream_backoff_ms` value.
pub(super) fn parse_retry_after_ms(sse_data: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(sse_data).ok()?;

    // Search order mirrors withRetry.ts: direct body, then under `error`,
    // then under `headers` (some gateways smuggle headers into the JSON body).
    let roots = [
        Some(&value),
        value.get("error"),
        value.get("headers"),
        value.get("error").and_then(|e| e.get("headers")),
    ];

    for root in roots.into_iter().flatten() {
        // Millisecond fields win — no rounding loss.
        for key in ["retry_after_ms", "retryAfterMs", "retry-after-ms"] {
            if let Some(ms) = root.get(key).and_then(extract_non_negative_u64) {
                return Some(ms);
            }
        }
        // Second fields, upcast to ms.
        for key in ["retry_after", "retryAfter", "retry-after", "Retry-After"] {
            if let Some(secs) = root.get(key).and_then(extract_non_negative_u64) {
                return Some(secs.saturating_mul(1000));
            }
        }
    }

    None
}

/// Coerce a JSON scalar into a non-negative u64. Accepts both JSON numbers
/// (including floats, which get floored) and decimal strings (common in HTTP
/// headers smuggled verbatim into JSON bodies).
fn extract_non_negative_u64(v: &serde_json::Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= 0.0 {
            return Some(f as u64);
        }
    }
    if let Some(s) = v.as_str() {
        return s.trim().parse::<u64>().ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::parse::{parse_streamed_tool_args, ParsedToolArgs};
    use super::{classify_invalid_args, looks_overloaded, parse_retry_after_ms};

    fn classify(s: &str) -> &'static str {
        match parse_streamed_tool_args(s) {
            ParsedToolArgs::Ok(_) => "ok",
            ParsedToolArgs::Failed { cause, .. } => cause,
        }
    }

    // ---- classify_invalid_args ----

    #[test]
    fn parses_normal_object() {
        let args = r#"{"path":"foo.md","content":"hello"}"#;
        assert!(matches!(
            parse_streamed_tool_args(args),
            ParsedToolArgs::Ok(_)
        ));
    }

    #[test]
    fn empty_string_parses_as_empty_object() {
        // Zero-arg tools (e.g. `list_gateway_agents`) legitimately receive
        // no `arguments` deltas — the parser must accept that as `{}` so the
        // turn-executor doesn't short-circuit them as parse failures.
        match parse_streamed_tool_args("") {
            ParsedToolArgs::Ok(v) => {
                assert!(v.is_object() && v.as_object().unwrap().is_empty());
            }
            ParsedToolArgs::Failed { cause, parse_err } => {
                panic!("expected Ok({{}}), got Failed cause={cause} err={parse_err}")
            }
        }
        // Whitespace-only deltas (some providers emit a single " " filler) too.
        match parse_streamed_tool_args("   ") {
            ParsedToolArgs::Ok(v) => assert!(v.is_object()),
            ParsedToolArgs::Failed { cause, .. } => panic!("expected Ok, got cause={cause}"),
        }
        // The classifier itself still labels truly empty strings the same way
        // Kept for log clarity on non-tool callers, if any.
        assert_eq!(
            classify_invalid_args(""),
            "empty (no arguments deltas received)"
        );
    }

    #[test]
    fn repairs_unquoted_absolute_path_value() {
        let args = r#"{"pattern":"platform::Simulate|simulator","paths": /Users/shibosheng/Desktop/code/atomcode_src}"#;
        match parse_streamed_tool_args(args) {
            ParsedToolArgs::Ok(value) => {
                assert_eq!(
                    value.get("paths").and_then(|v| v.as_str()),
                    Some("/Users/shibosheng/Desktop/code/atomcode_src")
                );
            }
            ParsedToolArgs::Failed { cause, parse_err } => {
                panic!("expected repaired JSON, got cause={cause} err={parse_err}")
            }
        }
    }

    #[test]
    fn classifies_double_encoded_string() {
        // Provider wrapped the actual object as a JSON string literal:
        //   "\"{\\\"path\\\":\\\"a.md\\\"}\""
        // Note: serde_json::from_str will parse this *successfully* as
        // a string Value. The failure case here is when the inner
        // content is itself broken AND the provider quoted it. We test
        // the classifier directly to confirm leading-quote detection.
        let args = "\"{\\\"path\\\":\\\"a.md\\\"";
        assert_eq!(
            classify_invalid_args(args),
            "double-encoded string (provider wrapped args in a JSON string literal)"
        );
    }

    #[test]
    fn classifies_concatenated_objects_as_index_collision() {
        // Multi-tool collision: two `edit_file` calls' args got
        // accumulated into the same string because the provider
        // omitted `index` on the second tool's chunks.
        let args = r#"{"path":"a.md","content":"x"}{"path":"b.md","content":"y"}"#;
        assert_eq!(
            classify(args),
            "concatenated objects (multi-tool index collision: two tool_calls accumulated under the same index)"
        );
    }

    #[test]
    fn classifies_truncated_object() {
        // Stream cut off mid-args. `serde_json` rejects it but the
        // brace counter ends positive, indicating we never closed.
        let args = r#"{"path":"foo.md","content":"hello wor"#;
        let cause = classify(args);
        assert!(
            cause.starts_with("truncated"),
            "expected truncated classification, got {cause}"
        );
    }

    #[test]
    fn classifies_unbalanced_extra_close() {
        let args = r#"{"path":"foo.md"}}"#;
        let cause = classify(args);
        // serde rejects this; classifier should call out the imbalance.
        assert!(
            cause.starts_with("unbalanced"),
            "expected unbalanced classification, got {cause}"
        );
    }

    #[test]
    fn classifies_leading_garbage() {
        let args = "garbage_no_brace";
        assert_eq!(
            classify(args),
            "leading garbage (likely truncated or index collision)"
        );
    }

    #[test]
    fn brace_inside_string_does_not_break_depth_tracking() {
        // Verify that `{` and `}` inside a JSON string literal are
        // NOT counted as object delimiters by the classifier. This
        // is critical because args often contain code or shell
        // snippets with literal braces.
        let args = r#"{"command":"echo {}; if [ -f a ]; then echo {}; fi"#; // truncated end
        let cause = classify(args);
        assert!(
            cause.starts_with("truncated"),
            "expected truncated, got {cause}"
        );
    }

    #[test]
    fn escaped_quote_does_not_toggle_string_state() {
        // `\"` inside a JSON string literal is NOT a closing quote.
        // The classifier must skip it. Truncated case here ensures we
        // see depth>0 at the end.
        let args = r#"{"content":"she said \"hi\" and "#;
        let cause = classify(args);
        assert!(
            cause.starts_with("truncated"),
            "expected truncated, got {cause}"
        );
    }

    // ---- looks_overloaded + parse_retry_after_ms ----

    #[test]
    fn overloaded_detects_anthropic_native_shape() {
        // Anthropic's canonical payload.
        assert!(looks_overloaded(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"..."}}"#
        ));
    }

    #[test]
    fn overloaded_detects_529_status() {
        assert!(looks_overloaded(
            r#"{"error":{"message":"upstream capacity","status":529}}"#
        ));
    }

    #[test]
    fn overloaded_detects_loose_keyword_in_wrapper_message() {
        // OpenRouter / LiteLLM style wrapper — no explicit status field.
        assert!(looks_overloaded(
            r#"{"error":{"message":"Anthropic returned 529 Overloaded"}}"#
        ));
    }

    #[test]
    fn overloaded_does_not_match_unrelated_errors() {
        assert!(!looks_overloaded(
            r#"{"error":{"type":"invalid_request_error","message":"missing field"}}"#
        ));
        assert!(!looks_overloaded(
            r#"{"error":{"type":"rate_limit_error"}}"#
        ));
    }

    #[test]
    fn retry_after_parses_top_level_seconds() {
        let body = r#"{"retry_after": 30}"#;
        assert_eq!(parse_retry_after_ms(body), Some(30_000));
    }

    #[test]
    fn retry_after_parses_top_level_milliseconds_direct() {
        // Millisecond field takes priority and does not get re-scaled.
        let body = r#"{"retry_after_ms": 1500}"#;
        assert_eq!(parse_retry_after_ms(body), Some(1500));
    }

    #[test]
    fn retry_after_parses_nested_under_error() {
        // Most providers put it inside the `error` object.
        let body = r#"{"error":{"type":"overloaded_error","retry_after": 60}}"#;
        assert_eq!(parse_retry_after_ms(body), Some(60_000));
    }

    #[test]
    fn retry_after_parses_nested_under_headers_smuggle() {
        // Some gateways shove HTTP headers into the JSON body verbatim.
        let body = r#"{"error":{"headers":{"Retry-After":"45"}}}"#;
        assert_eq!(parse_retry_after_ms(body), Some(45_000));
    }

    #[test]
    fn retry_after_ms_wins_over_retry_after_seconds() {
        // If both fields are present, the ms field should take priority (it's
        // more precise and avoids rounding to seconds).
        let body = r#"{"retry_after_ms": 2500, "retry_after": 9999}"#;
        assert_eq!(parse_retry_after_ms(body), Some(2500));
    }

    #[test]
    fn retry_after_returns_none_when_absent() {
        let body = r#"{"error":{"message":"something broke"}}"#;
        assert_eq!(parse_retry_after_ms(body), None);
    }

    #[test]
    fn retry_after_returns_none_on_invalid_json() {
        assert_eq!(parse_retry_after_ms("garbage"), None);
        assert_eq!(parse_retry_after_ms(""), None);
    }

    #[test]
    fn retry_after_parses_float_and_string_scalars() {
        // A float gets floored to u64.
        let body_float = r#"{"retry_after": 2.8}"#;
        assert_eq!(parse_retry_after_ms(body_float), Some(2_000));
        // A string number is parsed.
        let body_str = r#"{"retry_after": "15"}"#;
        assert_eq!(parse_retry_after_ms(body_str), Some(15_000));
    }

    #[test]
    fn retry_after_rejects_negative_floats() {
        let body = r#"{"retry_after": -5}"#;
        assert_eq!(parse_retry_after_ms(body), None);
    }
}
