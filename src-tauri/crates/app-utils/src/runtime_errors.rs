//! Stable classification of errors shared by runtime-facing domains.
//!
//! Keep these probes conservative: a false positive can trigger a destructive
//! recovery action, while a false negative merely leaves the original error
//! visible for manual recovery.

/// Return whether a provider/runtime error means that the model context can no
/// longer accept the requested turn.
pub fn is_context_exhausted_message(message: &str) -> bool {
    if serde_json::from_str::<serde_json::Value>(message)
        .ok()
        .is_some_and(|value| json_has_prompt_too_long_terminal_reason(&value))
    {
        return true;
    }

    let normalized = message.to_ascii_lowercase();
    let compact = normalized
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    if compact.contains("\"terminal_reason\":\"prompt_too_long\"")
        || compact.contains("\\\"terminal_reason\\\":\\\"prompt_too_long\\\"")
    {
        return true;
    }

    if message.chars().count() > 320 {
        return false;
    }
    [
        "prompt is too long",
        "input exceeds the context window",
        "context window has been exceeded",
        "maximum context length is",
        "ran out of room in the model's context window",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}

fn json_has_prompt_too_long_terminal_reason(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            object
                .get("terminal_reason")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|reason| reason.eq_ignore_ascii_case("prompt_too_long"))
                || object
                    .values()
                    .any(json_has_prompt_too_long_terminal_reason)
        }
        serde_json::Value::Array(values) => {
            values.iter().any(json_has_prompt_too_long_terminal_reason)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_context_exhausted_message;

    #[test]
    fn recognizes_structured_and_user_facing_context_errors() {
        for message in [
            r#"{"terminal_reason":"prompt_too_long"}"#,
            r#"{"nested":{"terminal_reason":"PROMPT_TOO_LONG"}}"#,
            "Prompt is too long and cannot be compacted further.",
            "Codex ran out of room in the model's context window.",
        ] {
            assert!(is_context_exhausted_message(message), "{message}");
        }
    }

    #[test]
    fn stays_conservative_for_unrelated_and_large_messages() {
        assert!(!is_context_exhausted_message("network connection failed"));
        assert!(!is_context_exhausted_message(&format!(
            "{} maximum context length is only diagnostic text",
            "x".repeat(321)
        )));
    }
}
