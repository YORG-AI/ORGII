//! Parse helpers for the streamed `tool_calls[].function.arguments` JSON.
//!
//! Returns a structured success/failure variant so the SSE assembly loop
//! can synthesize an inline error tool-result the LLM understands instead
//! of silently dropping to `{}` (which masks bad provider output as a
//! "missing required field" error from the tool's own validator).

use serde_json::Value;

/// Marker key written into a tool call's `arguments` Value when the
/// streamed arguments string could not be parsed as JSON. The tool
/// execution layer (`turn_executor::tool_execution::single` /
/// `parallel`) checks for this key **before** dispatching to the tool
/// and, if present, synthesizes an error `tool_result` that tells the
/// model exactly why (cause + preview + length) so it can retry with
/// different arguments instead of silently receiving a "missing
/// required field" error from the tool's own schema validator.
///
/// Keep this in sync with `STREAM_PARSE_ERROR_KEY` in
/// `turn_executor::tool_execution::mod` (see `detect_stream_parse_error`).
pub const STREAM_PARSE_ERROR_KEY: &str = "_stream_parse_error";

/// Build the `arguments` Value used when `parse_streamed_tool_args`
/// rejects the accumulated JSON. The shape is a **single-key object**
/// (`{"_stream_parse_error": { ... }}`) so downstream code can detect
/// it with a single `get(STREAM_PARSE_ERROR_KEY)` call — no schema
/// collision with real tool args because tools never accept a field
/// starting with an underscore in this codebase.
pub(super) fn build_stream_parse_error_args(
    cause: &'static str,
    parse_err: &str,
    preview: &str,
    total_len: usize,
) -> Value {
    serde_json::json!({
        STREAM_PARSE_ERROR_KEY: {
            "cause": cause,
            "parse_err": parse_err,
            "preview": preview,
            "total_len": total_len,
        }
    })
}

/// Result of attempting to parse the accumulated tool-call arguments
/// string that the OpenAI-compatible streaming protocol sends as a
/// sequence of `function.arguments` deltas.
///
/// Used by `parse_streamed_tool_args` to give the caller a structured
/// error variant carrying a human-readable root-cause classification
/// — useful for understanding *why* a provider produced something
/// `serde_json` rejected, instead of just dropping to an empty `{}`
/// silently.
pub(super) enum ParsedToolArgs {
    Ok(Value),
    Failed {
        cause: &'static str,
        parse_err: serde_json::Error,
    },
}

fn parse_with_quoted_absolute_paths(args_str: &str) -> Option<Value> {
    let mut repaired = String::with_capacity(args_str.len() + 8);
    let mut chars = args_str.char_indices().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some((idx, ch)) = chars.next() {
        repaired.push(ch);

        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string || ch != ':' {
            continue;
        }

        while let Some((_, ws)) = chars.peek().copied() {
            if !ws.is_whitespace() {
                break;
            }
            repaired.push(ws);
            chars.next();
        }

        let Some((value_start, '/')) = chars.peek().copied() else {
            continue;
        };

        let mut value_end = value_start;
        while let Some((next_idx, next_ch)) = chars.peek().copied() {
            if matches!(next_ch, ',' | '}' | ']') {
                break;
            }
            value_end = next_idx + next_ch.len_utf8();
            chars.next();
        }

        let raw_value = &args_str[value_start..value_end];
        let trimmed = raw_value.trim_end();
        if trimmed.is_empty() {
            return None;
        }
        let quoted = serde_json::to_string(trimmed).ok()?;
        repaired.push_str(&quoted);
        repaired.push_str(&raw_value[trimmed.len()..]);

        if value_end <= idx {
            return None;
        }
    }

    if repaired == args_str {
        return None;
    }
    serde_json::from_str::<Value>(&repaired).ok()
}

/// Parse the accumulated `function.arguments` string for a streamed
/// tool call. On failure, classifies the error so that callers (and
/// log scrapers) can tell apart the four root-cause families we have
/// actually seen in production:
///
/// 1. **empty** — provider sent zero `arguments` deltas (the model
///    decided to call a no-arg tool but the schema requires args).
/// 2. **double-encoded** — provider wrapped the args object as a JSON
///    string literal (`"\"{...}\""`) instead of sending raw JSON.
///    Some Azure deployments and a handful of relays do this.
/// 3. **concatenated objects** — multi-tool index collision: two
///    different tool_calls had their `arguments` deltas accumulated
///    under the same accumulator key because the provider omitted
///    `index` on follow-up chunks (and we fall back to `index=0`).
///    Result looks like `{"path":"a"}{"path":"b"}`.
/// 4. **truncated** — stream ended before the closing braces (network
///    error, timeout, or the model hit `max_tokens` mid-args). The
///    accumulated string parses as a valid prefix but `from_str`
///    rejects it.
///
/// All four root causes have showed up in real logs at least once.
/// The classification is heuristic but conservative: when in doubt
/// it falls through to `"balanced but invalid JSON syntax"`.
pub(super) fn parse_streamed_tool_args(args_str: &str) -> ParsedToolArgs {
    // A zero-arg tool (e.g. `list_gateway_agents` with empty `properties`)
    // legitimately sends no `arguments` deltas. Treat an empty / whitespace
    // accumulator as `{}` instead of flagging a parse error — otherwise the
    // turn-executor short-circuits with a "streaming JSON parse failure"
    // tool_result and the model retries in a loop. Non-empty garbage still
    // falls through to the classifier.
    if args_str.trim().is_empty() {
        return ParsedToolArgs::Ok(Value::Object(serde_json::Map::new()));
    }
    match serde_json::from_str::<Value>(args_str) {
        Ok(v) => ParsedToolArgs::Ok(v),
        Err(parse_err) => {
            if let Some(repaired) = parse_with_quoted_absolute_paths(args_str) {
                return ParsedToolArgs::Ok(repaired);
            }
            let cause = super::error_classify::classify_invalid_args(args_str);
            ParsedToolArgs::Failed { cause, parse_err }
        }
    }
}
