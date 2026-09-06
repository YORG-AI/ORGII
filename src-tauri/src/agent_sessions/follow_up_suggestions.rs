//! Unified Tauri boundary for provider-backed follow-up suggestions.
//!
//! CLI and Rust-agent sessions persist their provider identity in different
//! tables. This boundary resolves both and passes the authoritative
//! model/account pair to `agent_core`; the frontend never chooses credentials.

use serde::Deserialize;

use agent_core::state::commands::{
    generate_session_follow_up_suggestions, SessionFollowUpGenerationRequest,
    SessionFollowUpMessage, SessionFollowUpSuggestionsResponse,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFollowUpSuggestionsRequest {
    pub session_id: String,
    pub messages: Vec<SessionFollowUpMessage>,
}

fn required_provider_target(
    source: &str,
    model: Option<String>,
    account_id: Option<String>,
) -> Result<(String, String), String> {
    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{source} session has no selected model"))?;
    let account_id = account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{source} session has no selected provider account"))?;
    Ok((model, account_id))
}

fn resolve_provider_target(session_id: &str) -> Result<(String, String), String> {
    if let Some(session) = super::cli::persistence::get_session(session_id)
        .map_err(|error| format!("Failed to read CLI session provider identity: {error}"))?
    {
        return required_provider_target("CLI", session.model, session.account_id);
    }

    if let Some(session) = agent_core::session::persistence::get_session(session_id)
        .map_err(|error| format!("Failed to read agent session provider identity: {error}"))?
    {
        return required_provider_target("Agent", session.model, session.account_id);
    }

    Err(format!("Session '{session_id}' was not found"))
}

#[tauri::command]
pub async fn session_follow_up_suggestions(
    request: SessionFollowUpSuggestionsRequest,
) -> Result<SessionFollowUpSuggestionsResponse, String> {
    let session_id = request.session_id.trim().to_string();
    if session_id.is_empty() || session_id.len() > 512 {
        return Err("Invalid session ID for follow-up suggestions".to_string());
    }
    let lookup_session_id = session_id.clone();
    let (model, account_id) =
        tokio::task::spawn_blocking(move || resolve_provider_target(&lookup_session_id))
            .await
            .map_err(|error| format!("Provider identity lookup task failed: {error}"))??;

    generate_session_follow_up_suggestions(SessionFollowUpGenerationRequest {
        session_id,
        messages: request.messages,
        account_id,
        model,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_target_requires_a_complete_persisted_pair() {
        assert_eq!(
            required_provider_target(
                "CLI",
                Some(" gpt-5.6-sol ".to_string()),
                Some(" codex-oauth ".to_string())
            )
            .unwrap(),
            ("gpt-5.6-sol".to_string(), "codex-oauth".to_string())
        );
        assert!(required_provider_target("CLI", None, Some("account".to_string())).is_err());
        assert!(required_provider_target("Agent", Some("model".to_string()), None).is_err());
    }
}
