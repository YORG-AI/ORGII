//! Context bridge building — injects prior ORGII conversation history into CLI
//! sessions that have no native conversation state.

use super::super::persistence;

const CONTEXT_BRIDGE_MAX_CHARS: usize = 12_000;
const CONTEXT_BRIDGE_MAX_MESSAGES: usize = 24;

pub(super) fn build_context_bridge(session_id: &str) -> Option<String> {
    let messages = persistence::load_recent_context_messages(
        session_id,
        CONTEXT_BRIDGE_MAX_MESSAGES,
        CONTEXT_BRIDGE_MAX_CHARS,
    )
    .ok()?;
    let mut lines = Vec::new();
    for (role, text) in messages {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        lines.push(format!("{role}: {text}"));
    }
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    let mut body = lines.join("\n\n");
    if body.len() > CONTEXT_BRIDGE_MAX_CHARS {
        let mut start = body.len().saturating_sub(CONTEXT_BRIDGE_MAX_CHARS);
        while start < body.len() && !body.is_char_boundary(start) {
            start += 1;
        }
        body = body[start..].to_string();
    }

    let mutation_note = persistence::get_history_mutation(session_id)
        .ok()
        .flatten()
        .map(|mutation| {
            format!(
                "\nORGII history mutation marker: epoch={}, reason={}, mutated_at={}. The native CLI conversation state was intentionally discarded after this mutation; treat the ORGII conversation context below as authoritative.",
                mutation.epoch, mutation.reason, mutation.mutated_at
            )
        })
        .unwrap_or_default();

    Some(format!(
        "<orgii_context_bridge>\nThis CLI profile has no native conversation for this ORGII session yet. Continue using the ORGII conversation context below; do not repeat or summarize it unless the user asks.{}\n\n{}\n</orgii_context_bridge>",
        mutation_note, body
    ))
}
