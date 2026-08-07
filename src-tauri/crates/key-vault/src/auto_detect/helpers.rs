use serde::Deserialize;
use std::path::PathBuf;

use super::DetectedKey;

// ============================================
// Config File Structures
// ============================================

/// Claude Code config structure (~/.claude.json or ~/.config/claude/config.json)
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeConfig {
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

/// OpenAI/Codex config structure
#[derive(Debug, Deserialize)]
pub(crate) struct OpenAIConfig {
    pub api_key: Option<String>,
    #[allow(dead_code)]
    pub organization: Option<String>,
}

// ============================================
// Path Helpers
// ============================================

pub(crate) fn get_home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

pub(crate) fn get_claude_config_paths() -> Vec<PathBuf> {
    let mut paths = vec![];
    if let Some(home) = get_home_dir() {
        paths.push(home.join(".claude.json"));
        paths.push(home.join(".claude/config.json"));
        paths.push(home.join(".config/claude/config.json"));
        paths.push(home.join(".config/anthropic/config.json"));
    }
    paths
}

pub(crate) fn get_openai_config_paths() -> Vec<PathBuf> {
    let mut paths = vec![];
    if let Some(home) = get_home_dir() {
        paths.push(home.join(".openai/config.json"));
        paths.push(home.join(".config/openai/config.json"));
    }
    paths
}

// ============================================
// Shell Config Parsing
// ============================================

/// Extract value from shell export statement
/// Handles: export VAR=value, export VAR="value", export VAR='value'
/// Also handles inline comments: export VAR="value" # comment
pub(crate) fn extract_export_value(content: &str, var_name: &str) -> Option<String> {
    // Pre-compute patterns to avoid repeated allocations
    let export_pattern = format!("export {}=", var_name);
    let direct_pattern = format!("{}=", var_name);

    for line in content.lines() {
        let line = line.trim();

        // Skip comments
        if line.starts_with('#') {
            continue;
        }

        // Match: export VAR=value or VAR=value (without export)
        let rest = line
            .strip_prefix(&export_pattern)
            .or_else(|| line.strip_prefix(&direct_pattern));

        if let Some(rest) = rest {
            // Handle quoted values with potential inline comments
            let value = if rest.starts_with('"') {
                // Double-quoted: find closing quote
                rest.get(1..)?.split('"').next()?.to_string()
            } else if rest.starts_with('\'') {
                // Single-quoted: find closing quote
                rest.get(1..)?.split('\'').next()?.to_string()
            } else {
                // Unquoted: take until whitespace or comment
                rest.split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('#')
                    .to_string()
            };

            // Don't return empty values or variable references
            if !value.is_empty() && !value.starts_with('$') {
                return Some(value);
            }
        }
    }
    None
}

// ============================================
// Detected key factory
// ============================================

pub(crate) fn create_detected_key(id: &str, name: &str, auth_method: &str) -> DetectedKey {
    DetectedKey {
        id: id.to_string(),
        name: name.to_string(),
        auth_method: auth_method.to_string(),
        api_key: None,
        session_token: None,
        base_url: None,
        env_vars: None,
        account_metadata: None,
        available_models: None,
        quota_info: None,
        validated: None,
        validation_message: None,
    }
}

// ============================================
// Validation Wrappers
// ============================================

pub(crate) async fn validate_anthropic_key(
    api_key: &str,
    base_url: Option<&str>,
) -> (bool, Option<String>, Option<Vec<String>>) {
    use crate::providers::anthropic::AnthropicValidator;

    let validator = AnthropicValidator::new();
    let result = validator.validate(api_key, base_url, None).await;

    (
        result.valid,
        if result.valid {
            None
        } else {
            Some(result.message)
        },
        if result.valid {
            Some(result.models_available)
        } else {
            None
        },
    )
}

pub(crate) async fn validate_openai_key(
    api_key: &str,
    base_url: Option<&str>,
) -> (bool, Option<String>, Option<Vec<String>>) {
    use crate::providers::openai::OpenAIValidator;

    let validator = OpenAIValidator::new();
    let result = validator.validate(api_key, base_url, None, None).await;

    (
        result.valid,
        if result.valid {
            None
        } else {
            Some(result.message)
        },
        if result.valid {
            Some(result.models_available)
        } else {
            None
        },
    )
}

pub(crate) async fn validate_github_token(token: &str) -> (bool, Option<String>) {
    use crate::providers::copilot::CopilotValidator;

    let validator = CopilotValidator::new();
    let result = validator.validate(token).await;

    (
        result.valid,
        if result.valid {
            None
        } else {
            Some(result.message)
        },
    )
}
