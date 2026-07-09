use super::registry::ProviderSpec;

/// Context-window lookup. Thin delegate over the unified capability
/// resolver in `model_capabilities.rs` — the family table there is the
/// single source of truth. Kept for signature stability at existing call
/// sites.
pub fn context_window_hint(model: &str) -> usize {
    super::model_capabilities::resolve(model, None).context_window
}

pub fn wire_model_name(spec: &ProviderSpec, model: &str) -> String {
    let stripped = {
        let mut result = model;
        for prefix in spec.skip_prefixes {
            if let Some(rest) = model.strip_prefix(prefix) {
                result = rest;
                break;
            }
        }
        result
    };

    let normalized = normalize_claude_shorthand(stripped);

    if let Some(prefix) = spec.litellm_prefix {
        if normalized.starts_with(prefix) {
            return normalized;
        }
        return format!("{}{}", prefix, normalized);
    }

    normalized
}

pub fn normalize_claude_shorthand(model: &str) -> String {
    if model.starts_with("claude-") {
        return model.to_string();
    }
    const CLAUDE_FAMILIES: &[&str] = &["sonnet-", "haiku-", "opus-"];
    for family in CLAUDE_FAMILIES {
        if model.starts_with(family) {
            return format!("claude-{}", model);
        }
    }
    model.to_string()
}

pub fn fast_model_hint(parent_model: &str) -> String {
    let lower = parent_model.to_lowercase();
    if lower.contains("claude")
        || lower.contains("anthropic")
        || lower.contains("sonnet")
        || lower.contains("haiku")
        || lower.contains("opus")
    {
        "anthropic/claude-haiku-4.5".to_string()
    } else if lower.contains("gpt") || lower.contains("openai") {
        "openai/gpt-5.4-mini".to_string()
    } else if lower.contains("gemini") {
        "gemini/gemini-3.1-flash".to_string()
    } else if lower.contains("deepseek") {
        "deepseek/deepseek-chat".to_string()
    } else {
        parent_model.to_string()
    }
}
