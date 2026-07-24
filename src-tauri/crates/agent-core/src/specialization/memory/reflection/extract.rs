//! LLM extraction + post-hoc rejection guard for reflection insights.
//!
//! Asks the session's model for a JSON array of behavioral insights, then
//! filters environment-specific noise that slips past the prompt — see the
//! `docs/agent/audit-fallbacks-0421.md` post-mortem for why the
//! second-line guard exists.

use serde::Deserialize;
use tracing::debug;

/// Maximum learnings to extract per session.
pub(super) const MAX_INSIGHTS_PER_SESSION: usize = 5;

#[derive(Debug, Deserialize)]
pub(super) struct ExtractedInsight {
    /// Full-context paragraph. Explains *why* the insight matters and the
    /// situation it came from — readable by humans browsing the learnings UI.
    pub content: String,
    /// One-line actionable rule distilled from `content`. Optional — the LLM
    /// may omit it for insights that resist one-line summarization.
    #[serde(default)]
    pub takeaway: Option<String>,
    pub category: String,
    #[serde(default = "default_importance")]
    pub importance: f64,
}

fn default_importance() -> f64 {
    0.5
}

/// Ask LLM to extract behavioral insights from a transcript.
///
/// Reflection prompt: asks for **structured `{content, takeaway}`** output
/// and applies a novelty gate plus a soft-dedup instruction. The model is
/// explicitly told most sessions should produce zero insights.
///
/// The transcript passed in has already been tail-capped by `build_transcript`,
/// so this function does not re-truncate it.
pub(super) async fn extract_insights(
    provider: &dyn crate::providers::traits::LLMProvider,
    model_id: &str,
    transcript: &str,
) -> Result<Vec<ExtractedInsight>, String> {
    let prompt = format!(
        r#"You are reflecting on a finished conversation to decide whether anything *durable and novel* is worth remembering for future sessions with this agent.

Focus areas:
- Patterns: "When X happens, I should do Y"
- Corrections: "I made mistake X, next time I should Y"
- Preferences: "User prefers X over Y"
- Strategies: "For this type of task, approach X works best"

VERBATIM USER CORRECTIONS (highest priority — never paraphrase away the original words):
When the user pushes back, corrects, narrows scope, or forbids something — especially with
signals like "不是这样 / 不对 / 其实 / 我没让你 / 不要 / 只用 / 回归 / 固化 / actually / no, /
don't / stop / revert" — you MUST capture it as a `correction` insight, and the `content`
paragraph MUST embed the user's exact wording verbatim inside 「」or "" quotes. Keep BOTH the
verbatim correction AND the resulting rule, so a future session cannot silently re-apply the
rejected behaviour. This rule overrides brevity: a correction with its quote is never "too
trivial" to keep.

Do NOT extract (hard rejects — these WILL be filtered out post-hoc, do not waste a slot):
- Technical facts (e.g. "Rust uses ownership")
- Trivial observations or generic best-practice advice
- Anything already obvious from the system prompt or standard engineering practice
- Anything that wouldn't concretely change how the agent acts next time
- Environment-specific or transient artifacts — absolute filesystem paths (`/Users/...`,
  `/tmp/...`, `~/.orgii/...`), session IDs (`e2e-...`, `sess-...`, `agent:builtin:...`),
  sandbox labels, tool schema errors (`missing additionalProperties`, `invalid JSON schema`),
  UUIDs, or anything else that only makes sense *inside this one session*
- Internal reasoning about this extraction task itself (do not reflect on reflection)

Novelty gate — before including any insight, ask yourself:
1. Is this genuinely novel (not obvious from the system prompt or standard practice)?
2. Would this concretely change how the agent acts in a future session?
3. Would it still be useful to an agent running a week from now in a different working directory, on a different machine, with a different session ID? If the insight only makes sense with this session's IDs, paths, or sandbox context, the answer is no — skip it.
If all three answers aren't yes, skip it.

Do not write duplicate memories. Not every session produces an insight. Most won't. Don't force it. Returning an empty array is not only acceptable — it is the expected default.

For each insight you DO include, output JSON:
{{ "content": "Full context paragraph — what happened, why it matters", "takeaway": "One-line actionable rule", "category": "pattern|correction|preference|strategy", "importance": 0.0-1.0 }}

Respond with a JSON array (max 5 items). If none pass the gate, respond with [].

Transcript:
{transcript}"#
    );

    let messages = vec![serde_json::json!({
        "role": "user",
        "content": prompt,
    })];

    let response = provider
        .chat_streaming(&messages, None, model_id, 1024, 0.2, &|_| {}, None)
        .await
        .map_err(|e| format!("LLM call failed: {}", e))?;

    let text = response.content.as_deref().unwrap_or("[]");

    let json_str = extract_json_array(text);

    serde_json::from_str::<Vec<ExtractedInsight>>(&json_str).map_err(|e| {
        debug!(
            "[reflection] Failed to parse insights: {} — raw: {}",
            e, text
        );
        format!("Parse failed: {}", e)
    })
}

/// Extract a JSON array from text that may contain markdown fences.
fn extract_json_array(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with('[') {
        return trimmed.to_string();
    }
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            return trimmed[start..=end].to_string();
        }
    }
    "[]".to_string()
}

/// Substrings that, when present in an insight's content or takeaway, mark it
/// as environment-specific noise rather than a durable behavioural learning.
///
/// These patterns are the distilled signature of the 14 polluted rows the
/// reflection pipeline produced for `agent:builtin:sde` before 0421 (all of
/// which came from truncated tool_input / tool_output bytes — see
/// `docs/agent/audit-fallbacks-0421.md`). The check is a pure
/// substring scan on the final insight strings, not on the transcript, so it
/// still bites when the model paraphrases a bad signal from the input.
const REJECT_PATTERNS: &[&str] = &[
    "/Users/",
    "/tmp/",
    "~/.orgii/",
    ".orgii/",
    "e2e-",
    "sess-",
    "agent:builtin:",
    "additionalProperties",
    "tool schema",
    "sandbox-",
];

/// Returns `Some(matched_pattern)` if the insight should be rejected, `None` if
/// it passes the guard. `content` and `takeaway` are both scanned case-
/// insensitively.
///
/// `correction` insights are exempt from the path/sandbox REJECT_PATTERNS:
/// those patterns target truncated tool_input/tool_output noise, but a
/// verbatim user correction may legitimately quote a path (e.g. 「不要用
/// /tmp/」). User-authored corrections are signal, not noise — dropping them
/// would defeat the P4 原话保真 guarantee. Tool-noise never lands in the
/// `correction` category, so the exemption is safe.
pub(super) fn rejection_reason(insight: &ExtractedInsight) -> Option<&'static str> {
    if insight.category.eq_ignore_ascii_case("correction") {
        return None;
    }
    let haystacks = [
        insight.content.as_str(),
        insight.takeaway.as_deref().unwrap_or(""),
    ];
    for hay in haystacks.iter() {
        let lower = hay.to_ascii_lowercase();
        for pattern in REJECT_PATTERNS {
            if lower.contains(&pattern.to_ascii_lowercase()) {
                return Some(pattern);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insight(content: &str, takeaway: Option<&str>) -> ExtractedInsight {
        ExtractedInsight {
            content: content.to_string(),
            takeaway: takeaway.map(str::to_string),
            category: "pattern".to_string(),
            importance: 0.5,
        }
    }

    #[test]
    fn rejection_reason_hits_absolute_path() {
        let i = insight(
            "Agent should remember /Users/vinceorz/Projects/ is the workspace root",
            None,
        );
        assert_eq!(rejection_reason(&i), Some("/Users/"));
    }

    #[test]
    fn correction_category_exempt_from_path_reject() {
        // P4 原话保真: a verbatim user correction that quotes a path must
        // survive the noise guard.
        let mut i = insight(
            "用户纠正：「不要用 /tmp/，必须用 /mnt/share_88」",
            Some("禁用 /tmp/，改 /mnt/share_88"),
        );
        i.category = "correction".to_string();
        assert_eq!(rejection_reason(&i), None);
    }

    #[test]
    fn rejection_reason_hits_session_id_prefix() {
        let i = insight(
            "e2e-orch-8f3 failed because the mock tool did not return",
            Some("retry on e2e failure"),
        );
        assert_eq!(rejection_reason(&i), Some("e2e-"));
    }

    #[test]
    fn rejection_reason_hits_schema_error_in_takeaway() {
        let i = insight(
            "The agent should add additionalProperties: false to every tool schema",
            Some("always set additionalProperties"),
        );
        assert_eq!(rejection_reason(&i), Some("additionalProperties"));
    }

    #[test]
    fn rejection_reason_hits_orgii_sandbox_path() {
        let i = insight("cache lives at ~/.orgii/cache for later lookup", None);
        assert_eq!(rejection_reason(&i), Some("~/.orgii/"));
    }

    #[test]
    fn rejection_reason_is_case_insensitive() {
        let i = insight("path is /USERS/VINCEORZ/Projects/foo", None);
        assert_eq!(rejection_reason(&i), Some("/Users/"));
    }

    #[test]
    fn rejection_reason_passes_clean_insight() {
        let i = insight(
            "When the user asks for a refactor plan, outline trade-offs before editing.",
            Some("Discuss trade-offs before refactoring"),
        );
        assert_eq!(rejection_reason(&i), None);
    }

    #[test]
    fn test_extract_json_array() {
        assert_eq!(extract_json_array("[]"), "[]");
        assert_eq!(
            extract_json_array("```json\n[{\"a\":1}]\n```"),
            "[{\"a\":1}]"
        );
        assert_eq!(extract_json_array("no json here"), "[]");
    }
}
