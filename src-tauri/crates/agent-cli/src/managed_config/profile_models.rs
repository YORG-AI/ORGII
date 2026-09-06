//! Target-specific model settings share catalog/transaction ownership, never role semantics.
use super::claude_models::ClaudeModels;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProfileModels {
    Claude(ClaudeModels),
    Codex(CodexModels),
}
impl ProfileModels {
    pub fn validate(&self, target: &str) -> Result<(), String> {
        match (target, self) {
            ("claude_code" | "claude_desktop", Self::Claude(models)) => {
                models.validate(target == "claude_desktop")
            }
            ("codex", Self::Codex(models)) => models.validate(),
            _ => Err("Model settings do not match the profile target".into()),
        }
    }
    pub fn claude(&self) -> Result<&ClaudeModels, String> {
        match self {
            Self::Claude(m) => Ok(m),
            _ => Err("Expected Claude model settings".into()),
        }
    }
    #[cfg(test)]
    pub fn claude_mut(&mut self) -> Result<&mut ClaudeModels, String> {
        match self {
            Self::Claude(m) => Ok(m),
            _ => Err("Expected Claude model settings".into()),
        }
    }
    pub fn codex(&self) -> Result<&CodexModels, String> {
        match self {
            Self::Codex(m) => Ok(m),
            _ => Err("Expected Codex model settings".into()),
        }
    }
    pub fn default_model(&self) -> Result<&str, String> {
        match self {
            Self::Claude(m) => m
                .roles
                .get(&m.default_role)
                .map(|v| v.model.as_str())
                .ok_or_else(|| "Missing default model".into()),
            Self::Codex(m) => Ok(&m.model),
        }
    }
    pub fn request_models(&self) -> std::collections::BTreeSet<&str> {
        match self {
            Self::Claude(m) => m.request_models(),
            Self::Codex(m) => [&*m.model].into_iter().collect(),
        }
    }
    pub fn reasoning_effort(&self) -> Option<&str> {
        match self {
            Self::Claude(_) => None,
            Self::Codex(m) => m.reasoning_effort.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexModels {
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub context_window: Option<i64>,
    pub auto_compact_token_limit: Option<i64>,
}
impl CodexModels {
    pub fn validate(&self) -> Result<(), String> {
        validate_request_model_id(&self.model)?;
        if self
            .reasoning_effort
            .as_deref()
            .is_some_and(|v| !matches!(v, "minimal" | "low" | "medium" | "high" | "xhigh"))
        {
            return Err("Unsupported Codex reasoning effort".into());
        }
        if [self.context_window, self.auto_compact_token_limit]
            .into_iter()
            .flatten()
            .any(|n| !(1..=1_000_000_000).contains(&n))
        {
            return Err("Token limits must be whole numbers between 1 and 1000000000".into());
        }
        if self
            .auto_compact_token_limit
            .is_some_and(|n| self.context_window.is_none_or(|window| n > window))
        {
            return Err("Auto-compact tokens require a context window at least as large".into());
        }
        Ok(())
    }
    pub fn clear_config(config: &mut toml_edit::Document) {
        for key in [
            "model_reasoning_effort",
            "model_context_window",
            "model_auto_compact_token_limit",
        ] {
            config.remove(key);
        }
    }
    pub fn write_config(&self, config: &mut toml_edit::Document) {
        Self::clear_config(config);
        if let Some(effort) = &self.reasoning_effort {
            config["model_reasoning_effort"] = toml_edit::value(effort);
        }
        if let Some(tokens) = self.context_window {
            config["model_context_window"] = toml_edit::value(tokens);
        }
        if let Some(tokens) = self.auto_compact_token_limit {
            config["model_auto_compact_token_limit"] = toml_edit::value(tokens);
        }
    }
}

/// Model IDs are request values, independent of app-specific role/context syntax.
pub fn validate_request_model_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(
            "Enter a model ID of at most 256 bytes without spaces or control characters".into(),
        );
    }
    Ok(())
}
