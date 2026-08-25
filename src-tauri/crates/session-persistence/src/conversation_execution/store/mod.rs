mod mutations;
mod read;
mod registry;

pub(crate) use mutations::*;
pub(crate) use registry::*;

use chrono::{SecondsFormat, Utc};

use super::types::{
    ConversationExecutionKey, ConversationRuntimeProfile, ConversationSourceCheckpoint,
};

const MAX_ID_CHARS: usize = 4_096;
const MAX_VALUE_CHARS: usize = 32_768;
const MAX_ROLL_REASON_CHARS: usize = 512;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn validate_key(key: &ConversationExecutionKey) -> Result<(), String> {
    validate_required("executorScope", &key.executor_scope, MAX_ID_CHARS)?;
    validate_required(
        "conversationRootKey",
        &key.conversation_root_key,
        MAX_ID_CHARS,
    )
}

fn validate_required(label: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{label} exceeds the {max_chars}-character limit"));
    }
    Ok(())
}

fn validate_optional(label: &str, value: Option<&str>, max_chars: usize) -> Result<(), String> {
    if let Some(value) = value {
        validate_required(label, value, max_chars)?;
    }
    Ok(())
}

fn validate_revision(revision: i64) -> Result<(), String> {
    if revision < 0 {
        return Err("expectedRevision must be non-negative".to_string());
    }
    Ok(())
}

fn validate_sha256(label: &str, value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} must be a lowercase SHA-256 hex digest"));
    }
    Ok(())
}

fn validate_source_checkpoint(source: &ConversationSourceCheckpoint) -> Result<(), String> {
    if source.source_event_count < 0 {
        return Err("sourceEventCount must be non-negative".to_string());
    }
    validate_optional(
        "sourceCheckpointId",
        source.source_checkpoint_id.as_deref(),
        MAX_ID_CHARS,
    )?;
    validate_optional(
        "sourceTipEventId",
        source.source_tip_event_id.as_deref(),
        MAX_ID_CHARS,
    )?;
    match (
        source.source_checkpoint_id.as_deref(),
        source.source_checkpoint_sha256.as_deref(),
    ) {
        (Some(_), Some(digest)) => validate_sha256("sourceCheckpointSha256", digest)?,
        (None, None) => {}
        _ => {
            return Err(
                "sourceCheckpointId and sourceCheckpointSha256 must be present together"
                    .to_string(),
            );
        }
    }
    if source.source_event_count > 0 && source.source_checkpoint_id.is_none() {
        return Err("a non-empty source requires checkpoint id and SHA-256".to_string());
    }
    if source.source_event_count == 0 && source.source_tip_event_id.is_some() {
        return Err("an empty source cannot have sourceTipEventId".to_string());
    }
    Ok(())
}

fn validate_runtime_profile(runtime: &ConversationRuntimeProfile) -> Result<(), String> {
    validate_required("runtimeCategory", &runtime.runtime_category, MAX_ID_CHARS)?;
    validate_required("runtimeId", &runtime.runtime_id, MAX_ID_CHARS)?;
    validate_optional("agentId", runtime.agent_id.as_deref(), MAX_ID_CHARS)?;
    validate_optional("accountId", runtime.account_id.as_deref(), MAX_ID_CHARS)?;
    validate_optional("modelId", runtime.model_id.as_deref(), MAX_VALUE_CHARS)?;
    validate_optional(
        "workspaceLocator",
        runtime.workspace_locator.as_deref(),
        MAX_VALUE_CHARS,
    )?;
    validate_optional(
        "workspaceFingerprint",
        runtime.workspace_fingerprint.as_deref(),
        MAX_VALUE_CHARS,
    )?;
    validate_required(
        "executionProfileFingerprint",
        &runtime.execution_profile_fingerprint,
        MAX_VALUE_CHARS,
    )
}

fn validate_roll_reason(value: &str) -> Result<(), String> {
    validate_required("rollReason", value, MAX_ROLL_REASON_CHARS)
}
