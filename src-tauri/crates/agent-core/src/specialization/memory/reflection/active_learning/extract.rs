//! LLM extraction prompt + response parsing for active observation.
//!
//! The prompt is intentionally strict: it ASKS for an empty `{}` response
//! when the failures are incidental, and rejects session-specific noise
//! (paths, UUIDs, schema validation errors) in the prompt body so the
//! caller doesn't have to filter them out post-hoc.

use serde::Deserialize;

use crate::core::side_query::{side_query, SideQueryConfig};

use super::patterns::ToolFailurePattern;

/// Single-insight payload returned by the active-observation prompt.
///
/// Distinct from `super::super::extract::ExtractedInsight` — that one is
/// an array element from the broader transcript-reflection pass, this one
/// is a single object emitted by the tool-failure-pattern prompt and is
/// allowed to be `{}` to mean "no durable insight worth recording".
/// Renamed to avoid the bare-name collision with the transcript variant.
#[derive(Debug, Deserialize)]
pub(super) struct ActiveLearningInsight {
    pub(super) content: String,
    #[serde(default)]
    pub(super) takeaway: Option<String>,
    pub(super) category: String,
    #[serde(default = "default_importance")]
    pub(super) importance: f64,
}

fn default_importance() -> f64 {
    0.6
}

pub(super) async fn extract_insight(
    provider: &dyn crate::providers::traits::LLMProvider,
    model_id: &str,
    patterns: &[ToolFailurePattern],
) -> Result<Option<ActiveLearningInsight>, String> {
    let summary = format_patterns_for_prompt(patterns);
    let prompt = format!(
        r#"A session ended with {n} distinct tool-failure → user-intervention patterns. Your job is to decide whether they share a durable behavioral lesson worth remembering across sessions.

Return EITHER a single JSON object:
{{ "content": "Full context paragraph describing the shared pattern and why it matters", "takeaway": "One-line actionable rule", "category": "correction|strategy", "importance": 0.0-1.0 }}

OR return an empty object `{{}}` if the failures are incidental (different tools, different causes, or clearly just normal error-and-retry). Do not force a lesson.

Hard rejects — if the shared thread is only any of these, return `{{}}`:
- Session-specific artifacts (absolute paths like `/Users/...`, session IDs, UUIDs, sandbox labels)
- Tool-schema validation errors (`missing additionalProperties`, `invalid JSON schema`)
- Generic "the LLM made a typo and the user corrected it" — that is every session
- Anything an engineer running the same agent next week on a different machine would not benefit from

Patterns:
{summary}"#,
        n = patterns.len(),
        summary = summary,
    );

    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    let cfg = SideQueryConfig {
        model: Some(model_id.to_string()),
        max_tokens: Some(512),
        temperature: 0.2,
        system_prompt: None,
        ..Default::default()
    };
    let resp = side_query(provider, &messages, &cfg, model_id)
        .await
        .map_err(|e| format!("LLM call failed: {}", e))?;

    parse_llm_response(&resp.content)
}

pub(crate) fn format_patterns_for_prompt(patterns: &[ToolFailurePattern]) -> String {
    use super::patterns::MAX_PATTERNS_IN_PROMPT;
    let take = patterns.iter().take(MAX_PATTERNS_IN_PROMPT);
    let mut out = String::new();
    for (idx, p) in take.enumerate() {
        out.push_str(&format!(
            "\n--- Pattern {} ---\nTool: {}\nFailure: {}\nUser intervention: {}\n",
            idx + 1,
            if p.tool_name.is_empty() {
                "(unknown)"
            } else {
                p.tool_name.as_str()
            },
            p.tool_result_snippet,
            p.user_intervention_snippet,
        ));
    }
    out
}

pub(super) fn parse_llm_response(raw: &str) -> Result<Option<ActiveLearningInsight>, String> {
    let trimmed = raw.trim();
    let body = strip_code_fence(trimmed);
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| {
        format!(
            "Failed to parse LLM response as JSON: {} (raw={:?})",
            e, trimmed
        )
    })?;

    match value {
        serde_json::Value::Object(ref map) if map.is_empty() => Ok(None),
        serde_json::Value::Object(_) => {
            let insight: ActiveLearningInsight = serde_json::from_value(value)
                .map_err(|e| format!("Failed to deserialise insight: {}", e))?;
            if insight.content.trim().is_empty() {
                return Ok(None);
            }
            Ok(Some(insight))
        }
        other => Err(format!(
            "Expected JSON object, got {}",
            std::any::type_name_of_val(&other)
        )),
    }
}

fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        return rest
            .trim_start_matches(|c: char| c.is_ascii_whitespace())
            .trim_end_matches("```")
            .trim();
    }
    if let Some(rest) = t.strip_prefix("```") {
        return rest
            .trim_start_matches(|c: char| c.is_ascii_whitespace())
            .trim_end_matches("```")
            .trim();
    }
    t
}

#[cfg(test)]
mod tests {
    use super::super::patterns::{ToolFailurePattern, MAX_PATTERNS_IN_PROMPT};
    use super::*;

    #[test]
    fn parse_llm_response_empty_object_means_no_insight() {
        assert!(parse_llm_response("{}").unwrap().is_none());
        assert!(parse_llm_response("  {}  ").unwrap().is_none());
        assert!(parse_llm_response("```json\n{}\n```").unwrap().is_none());
    }

    #[test]
    fn parse_llm_response_accepts_object() {
        let raw = r#"{"content":"X","takeaway":"Y","category":"correction","importance":0.7}"#;
        let got = parse_llm_response(raw).unwrap().expect("insight");
        assert_eq!(got.content, "X");
        assert_eq!(got.takeaway.as_deref(), Some("Y"));
        assert_eq!(got.category, "correction");
        assert!((got.importance - 0.7).abs() < 1e-9);
    }

    #[test]
    fn parse_llm_response_rejects_array() {
        assert!(parse_llm_response("[]").is_err());
        assert!(parse_llm_response("[{\"content\":\"x\"}]").is_err());
    }

    #[test]
    fn parse_llm_response_treats_empty_content_as_no_insight() {
        let raw = r#"{"content":"  ","category":"correction"}"#;
        assert!(parse_llm_response(raw).unwrap().is_none());
    }

    #[test]
    fn format_patterns_for_prompt_caps_at_max() {
        let p = ToolFailurePattern {
            tool_name: "bash".into(),
            tool_result_snippet: "err".into(),
            user_intervention_snippet: "user".into(),
        };
        let many = vec![p; MAX_PATTERNS_IN_PROMPT + 3];
        let out = format_patterns_for_prompt(&many);
        assert_eq!(out.matches("--- Pattern").count(), MAX_PATTERNS_IN_PROMPT);
    }
}
