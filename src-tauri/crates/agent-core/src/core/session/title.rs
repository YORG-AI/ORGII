use serde_json::Value;
use tracing::warn;

use crate::core::side_query::{self, SideQueryConfig, StructuredOutput};
use crate::providers::traits::LLMProvider;
use crate::session::persistence;

const MAX_SESSION_TITLE_LEN: usize = 80;
const TITLE_TOOL_NAME: &str = "emit_session_title";
const TITLE_SYSTEM_PROMPT: &str = r#"Generate a concise display title for an ORGII agent session.

Rules:
- Return only the title in the structured `title` field.
- Use 3-8 words.
- No quotes, markdown, punctuation-only endings, emoji, or labels like "Session:".
- Capture the user's concrete task, not the agent behavior.
- Prefer imperative noun phrases, e.g. "Fix Rust Session Naming" or "Audit Login Redirect"."#;

fn normalize_title(raw: &str) -> Option<String> {
    let collapsed = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | '*' | '#' | ':' | '-' | '–' | '—'))
        .trim()
        .to_string();

    if collapsed.is_empty() {
        return None;
    }

    let without_prefix = collapsed
        .strip_prefix("Session: ")
        .or_else(|| collapsed.strip_prefix("Title: "))
        .unwrap_or(&collapsed)
        .trim();

    let trimmed = without_prefix
        .trim_end_matches(['.', '!', '?', ':', ';'])
        .trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(truncate_title(trimmed))
}

pub fn derive_title_fallback(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "New session".to_string();
    }

    normalize_title(trimmed).unwrap_or_else(|| "New session".to_string())
}

fn truncate_title(title: &str) -> String {
    if title.len() <= MAX_SESSION_TITLE_LEN {
        return title.to_string();
    }

    let mut boundary = MAX_SESSION_TITLE_LEN;
    while boundary > 0 && !title.is_char_boundary(boundary) {
        boundary -= 1;
    }
    title[..boundary].trim_end().to_string()
}

pub async fn generate_session_title(
    provider: &dyn LLMProvider,
    model: &str,
    account_id: Option<&str>,
    content: &str,
) -> Result<String, String> {
    let user_message = serde_json::json!({
        "role": "user",
        "content": format!("User request:\n{}", content.trim()),
    });

    let result = side_query::side_query(
        provider,
        &[user_message],
        &SideQueryConfig {
            max_tokens: Some(128),
            temperature: 0.0,
            system_prompt: Some(TITLE_SYSTEM_PROMPT.to_string()),
            structured: Some(StructuredOutput {
                tool_name: TITLE_TOOL_NAME.to_string(),
                schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Concise display title for the session"
                        }
                    },
                    "required": ["title"],
                    "additionalProperties": false
                }),
            }),
            account_id: account_id.map(str::to_string),
            ..SideQueryConfig::default()
        },
        model,
    )
    .await?;

    let structured_title = result
        .structured
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .and_then(normalize_title);

    let plain_title = normalize_title(&result.content);

    structured_title
        .or(plain_title)
        .ok_or_else(|| "session title generation returned an empty title".to_string())
}

pub async fn generate_and_persist_session_title(
    session_id: &str,
    provider: &dyn LLMProvider,
    model: &str,
    account_id: Option<&str>,
    content: &str,
) -> String {
    let title = match generate_session_title(provider, model, account_id, content).await {
        Ok(title) => title,
        Err(err) => {
            warn!(
                session_id = %session_id,
                error = %err,
                "[session_title] title generation failed; using deterministic fallback"
            );
            derive_title_fallback(content)
        }
    };

    let session_id_for_task = session_id.to_string();
    let session_id_for_log = session_id.to_string();
    let persisted_title = title.clone();
    match tokio::task::spawn_blocking(move || {
        persistence::update_name(&session_id_for_task, &persisted_title)
    })
    .await
    {
        Ok(Ok(true)) => title,
        Ok(Ok(false)) => {
            warn!(
                session_id = %session_id_for_log,
                "[session_title] session row missing while persisting generated title"
            );
            title
        }
        Ok(Err(err)) => {
            warn!(
                session_id = %session_id_for_log,
                error = %err,
                "[session_title] failed to persist generated title"
            );
            title
        }
        Err(err) => {
            warn!(
                session_id = %session_id_for_log,
                error = %err,
                "[session_title] title persistence task failed"
            );
            title
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_collapses_and_truncates_prompt() {
        let title = derive_title_fallback("  Fix   Rust\n session naming metadata updates  ");
        assert_eq!(title, "Fix Rust session naming metadata updates");
    }

    #[test]
    fn normalize_strips_common_wrapping() {
        assert_eq!(
            normalize_title("\"Session: Fix Rust Session Naming.\"").as_deref(),
            Some("Fix Rust Session Naming")
        );
    }
}
