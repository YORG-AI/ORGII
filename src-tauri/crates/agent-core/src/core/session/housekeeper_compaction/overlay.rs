use serde_json::Value;

use super::config;
use super::history::{prefix_hash, structurally_matches, summary_message};
use super::persistence;
use crate::session::persistence as session_persistence;
use crate::session::prompt::cache::ORGII_SYSTEM_CACHE_SCOPE_KEY;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverlayOutcome {
    Disabled,
    Missing,
    Stale,
    CurrentViewChanged,
    Applied { covered_messages: usize },
}

fn has_runtime_system_scope(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| part.get(ORGII_SYSTEM_CACHE_SCOPE_KEY).is_some())
}

fn leading_runtime_system_prefix_len(messages: &[Value]) -> usize {
    messages
        .iter()
        .take_while(|message| {
            message.get("role").and_then(Value::as_str) == Some("system")
                && has_runtime_system_scope(message)
        })
        .count()
}

pub(crate) fn apply(session_id: &str, messages: &mut Vec<Value>) -> Result<OverlayOutcome, String> {
    if !config::is_enabled() {
        return Ok(OverlayOutcome::Disabled);
    }

    let record = persistence::load(session_id)?;
    if !record.enabled || record.summary.trim().is_empty() || record.covered_message_count == 0 {
        return Ok(OverlayOutcome::Missing);
    }

    let history = session_persistence::load_llm_history(session_id)
        .map_err(|err| format!("load MiniCPM overlay history failed: {err}"))?;
    let current_hash = prefix_hash(&history, record.covered_message_count);
    if current_hash.as_deref() != Some(record.covered_prefix_hash.as_str()) {
        persistence::reset_progress(session_id)?;
        tracing::info!(
            "[housekeeper_compaction] reset stale overlay after canonical history changed (session={})",
            session_id
        );
        return Ok(OverlayOutcome::Stale);
    }

    let prefix_len = leading_runtime_system_prefix_len(messages);
    let end = prefix_len.saturating_add(record.covered_message_count);
    if end > messages.len()
        || !structurally_matches(
            &history[..record.covered_message_count],
            &messages[prefix_len..end],
        )
    {
        return Ok(OverlayOutcome::CurrentViewChanged);
    }

    messages.splice(
        prefix_len..end,
        [summary_message(
            &record.summary,
            record.covered_message_count,
        )],
    );
    Ok(OverlayOutcome::Applied {
        covered_messages: record.covered_message_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_scoped_runtime_system_prefix() {
        let messages = vec![
            serde_json::json!({
                "role": "system",
                "content": [{"type": "text", "text": "stable", ORGII_SYSTEM_CACHE_SCOPE_KEY: "session"}],
            }),
            serde_json::json!({"role": "system", "content": "durable summary"}),
            serde_json::json!({"role": "user", "content": "recent"}),
        ];

        assert_eq!(leading_runtime_system_prefix_len(&messages), 1);
    }
}
