//! Agent identity inference from session ids, stored session metadata, and
//! model names, together with the parsed-category provenance trail.

use super::SessionRow;
use crate::orgtrack::types::{OrgtrackAgentIdentity, OrgtrackParsedCategory};

pub(super) fn agent_identity_for(
    session_id: &str,
    session: Option<&SessionRow>,
) -> OrgtrackAgentIdentity {
    let label = session
        .map(|session| session.label.clone())
        .unwrap_or_else(|| session_id.to_string());
    let agent_kind = session.and_then(|session| session.agent_kind.clone());
    let model = session.and_then(|session| session.model.clone());
    let key_source = session.and_then(|session| session.key_source.clone());
    let agent_exec_mode = session.and_then(|session| session.agent_exec_mode.clone());
    let dispatch_category = infer_dispatch_category(session_id, agent_kind.as_deref());
    let rust_agent_type = infer_rust_agent_type(session_id, agent_kind.as_deref());
    let cli_agent_type = infer_cli_agent_type(session_id, agent_kind.as_deref());
    let origin = match dispatch_category.as_deref() {
        Some("rust_agent") => Some("orgii".to_string()),
        Some("cli_agent") => Some("external_cli".to_string()),
        Some("cursor_ide") => Some("cursor_ide".to_string()),
        _ => None,
    };

    let mut parsed_categories = Vec::new();
    push_category(
        &mut parsed_categories,
        "sessionIdPrefix",
        session_id_prefix(session_id),
        "session_id",
    );
    push_category_opt(
        &mut parsed_categories,
        "agentKind",
        agent_kind.as_deref(),
        "agent_sessions.session_type",
    );
    push_category_opt(
        &mut parsed_categories,
        "dispatchCategory",
        dispatch_category.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "rustAgentType",
        rust_agent_type.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "cliAgentType",
        cli_agent_type.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "agentExecMode",
        agent_exec_mode.as_deref(),
        "agent_sessions.agent_exec_mode",
    );
    push_category_opt(
        &mut parsed_categories,
        "model",
        model.as_deref(),
        "agent_sessions.model",
    );
    push_category_opt(
        &mut parsed_categories,
        "keySource",
        key_source.as_deref(),
        "agent_sessions.key_source",
    );
    push_category_opt(
        &mut parsed_categories,
        "origin",
        origin.as_deref(),
        "inferred",
    );

    OrgtrackAgentIdentity {
        dispatch_category,
        rust_agent_type,
        cli_agent_type,
        agent_exec_mode,
        session_id: session_id.to_string(),
        display_name: Some(label),
        provider_model_type: model.as_deref().and_then(infer_provider_from_model),
        model,
        key_source,
        origin,
        parsed_categories,
    }
}

fn infer_dispatch_category(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    if session_id.starts_with("cursoride-") || matches!(agent_kind, Some("cursor_ide")) {
        Some("cursor_ide".to_string())
    } else if matches!(agent_kind, Some("cli" | "cli_agent" | "code"))
        || infer_cli_agent_type(session_id, agent_kind).is_some()
    {
        Some("cli_agent".to_string())
    } else {
        Some("rust_agent".to_string())
    }
}

fn infer_rust_agent_type(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    if session_id.starts_with("osagent-") || matches!(agent_kind, Some("os")) {
        Some("os".to_string())
    } else if session_id.starts_with("sdeagent-") || matches!(agent_kind, Some("sde")) {
        Some("sde".to_string())
    } else if session_id.starts_with("gateway-") || matches!(agent_kind, Some("gateway")) {
        Some("gateway".to_string())
    } else if matches!(agent_kind, Some("agent" | "rust_agent")) {
        Some("custom".to_string())
    } else {
        None
    }
}

fn infer_cli_agent_type(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    let searchable = format!("{}:{}", session_id, agent_kind.unwrap_or_default()).to_lowercase();
    for candidate in [
        "claude_code",
        "cursor_cli",
        "codex",
        "copilot",
        "kiro",
        "opencode",
    ] {
        if searchable.contains(candidate) || searchable.contains(&candidate.replace('_', "-")) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn infer_provider_from_model(model: &str) -> Option<String> {
    let lower = model.to_lowercase();
    let provider = if lower.contains("claude") {
        "anthropic"
    } else if lower.contains("gpt") || lower.contains("o3") || lower.contains("o4") {
        "openai"
    } else if lower.contains("gemini") {
        "google"
    } else if lower.contains("orgii") {
        "orgii_orchestrator"
    } else {
        return None;
    };
    Some(provider.to_string())
}

fn session_id_prefix(session_id: &str) -> &str {
    session_id.split(['-', '_']).next().unwrap_or(session_id)
}

fn push_category(
    categories: &mut Vec<OrgtrackParsedCategory>,
    key: &str,
    value: &str,
    source: &str,
) {
    if value.trim().is_empty() {
        return;
    }
    categories.push(OrgtrackParsedCategory {
        key: key.to_string(),
        value: value.to_string(),
        source: source.to_string(),
    });
}

fn push_category_opt(
    categories: &mut Vec<OrgtrackParsedCategory>,
    key: &str,
    value: Option<&str>,
    source: &str,
) {
    if let Some(value) = value {
        push_category(categories, key, value, source);
    }
}
