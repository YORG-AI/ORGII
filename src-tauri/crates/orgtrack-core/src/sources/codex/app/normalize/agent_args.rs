//! Normalization for Codex multi-agent spawn and collaboration-message calls.

use serde_json::Value;

pub(super) fn normalize_spawn_agent_args(args: Value) -> Value {
    let task_name = args
        .get("task_name")
        .or_else(|| args.get("taskName"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut normalized = args.as_object().cloned().unwrap_or_default();
    normalized.insert("payload".to_string(), args);
    normalized
        .entry("description".to_string())
        .or_insert_with(|| Value::String(task_name.clone()));
    normalized
        .entry("task".to_string())
        .or_insert_with(|| Value::String(task_name));
    if !message.is_empty() && !is_encrypted_collaboration_text(&message) {
        normalized
            .entry("prompt".to_string())
            .or_insert_with(|| Value::String(message));
    }
    Value::Object(normalized)
}

pub(super) fn normalize_agent_message_args(action: &str, args: Value) -> Option<Value> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // Codex encrypts parent-side collaboration messages. Unlike the initial
    // spawn prompt, later interactions are not persisted as plaintext in the
    // child rollout, so rendering these calls would produce empty message
    // cards. Keep plaintext follow-ups, but omit unrecoverable placeholders.
    if message.is_empty() || is_encrypted_collaboration_text(&message) {
        return None;
    }
    let mut normalized = args.as_object().cloned().unwrap_or_default();
    normalized.insert("payload".to_string(), args);
    normalized.insert("kind".to_string(), Value::String("plain".to_string()));
    normalized.insert("action".to_string(), Value::String(action.to_string()));
    normalized
        .entry("recipient_member_id".to_string())
        .or_insert_with(|| Value::String(target));
    normalized
        .entry("text".to_string())
        .or_insert_with(|| Value::String(message.clone()));
    normalized
        .entry("summary".to_string())
        .or_insert_with(|| Value::String(message));
    Some(Value::Object(normalized))
}

fn is_encrypted_collaboration_text(value: &str) -> bool {
    // Codex collaboration messages are Fernet tokens in the parent rollout.
    // The child rollout contains a plaintext first user message, which the
    // session linker uses instead. Never surface the opaque token as a prompt.
    value.starts_with("gAAAAA") && value.len() >= 80
}
