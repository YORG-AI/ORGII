//! Native Claude role mappings. Labels are never request model identifiers.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeRole {
    Sonnet,
    Opus,
    Fable,
    Haiku,
    Subagent,
}
impl ClaudeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sonnet => "sonnet",
            Self::Opus => "opus",
            Self::Fable => "fable",
            Self::Haiku => "haiku",
            Self::Subagent => "subagent",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeModel {
    pub model: String,
    pub display_name: String,
    pub context_1m: bool,
}
impl ClaudeModel {
    pub fn native_id(&self) -> String {
        format!(
            "{}{}",
            self.model,
            if self.context_1m { "[1m]" } else { "" }
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeModels {
    pub default_role: ClaudeRole,
    pub roles: BTreeMap<ClaudeRole, ClaudeModel>,
}
impl ClaudeModels {
    pub fn validate(&self, desktop: bool) -> Result<(), String> {
        if self.default_role == ClaudeRole::Subagent || !self.roles.contains_key(&self.default_role)
        {
            return Err("Choose a configured main model role".into());
        }
        // All four roles are explicit: no hidden upstream/default traffic after a switch.
        for role in [
            ClaudeRole::Sonnet,
            ClaudeRole::Opus,
            ClaudeRole::Fable,
            ClaudeRole::Haiku,
        ] {
            if !self.roles.contains_key(&role) {
                return Err("Configure every Claude model role".into());
            }
        }
        if desktop && self.roles.contains_key(&ClaudeRole::Subagent) {
            return Err("Desktop profiles do not support a separate subagent override".into());
        }
        for (role, entry) in &self.roles {
            validate_id(&entry.model)?;
            if entry.display_name.len() > 120 || entry.display_name.chars().any(char::is_control) {
                return Err(
                    "Model display names must be at most 120 bytes without control characters"
                        .into(),
                );
            }
            if (*role == ClaudeRole::Subagent && !entry.display_name.is_empty())
                || (*role == ClaudeRole::Haiku && entry.context_1m)
            {
                return Err("Subagents have no picker label; Haiku has no 1M declaration".into());
            }
        }
        Ok(())
    }
    pub fn request_models(&self) -> BTreeSet<&str> {
        self.roles
            .values()
            .map(|entry| entry.model.as_str())
            .collect()
    }
    pub fn write_cli(&self, env: &mut serde_json::Map<String, serde_json::Value>) {
        for (role, entry) in &self.roles {
            let key = if *role == ClaudeRole::Subagent {
                "CLAUDE_CODE_SUBAGENT_MODEL".into()
            } else {
                format!("ANTHROPIC_DEFAULT_{}_MODEL", role.as_str().to_uppercase())
            };
            env.insert(key.clone(), entry.native_id().into());
            if !entry.display_name.is_empty() {
                env.insert(format!("{key}_NAME"), entry.display_name.clone().into());
            }
        }
    }
    pub fn desktop_catalog(&self) -> Vec<serde_json::Value> {
        let mut roles: Vec<_> = self.roles.iter().collect();
        roles.sort_by_key(|(role, _)| **role != self.default_role);
        roles
            .into_iter()
            .map(|(role, entry)| {
                serde_json::json!({
                    "name": entry.model, "labelOverride": entry.display_name,
                    "supports1m": entry.context_1m, "prefer1m": entry.context_1m,
                    "anthropicFamilyTier": role.as_str(), "isFamilyDefault": true,
                })
            })
            .collect()
    }
}
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 256
        || id.chars().any(|c| c.is_whitespace() || c.is_control())
        || id.contains(['[', ']'])
    {
        return Err(
            "Enter a model ID without spaces or context suffixes; use the 1M checkbox separately"
                .into(),
        );
    }
    Ok(())
}

/// All native switch paths clear role metadata before installing the next mapping.
pub(super) fn clear_role_overrides(env: &mut serde_json::Map<String, serde_json::Value>) {
    for role in ["SONNET", "OPUS", "FABLE", "HAIKU"] {
        for suffix in ["", "_NAME", "_DESCRIPTION", "_SUPPORTED_CAPABILITIES"] {
            env.remove(&format!("ANTHROPIC_DEFAULT_{role}_MODEL{suffix}"));
        }
    }
    for field in [
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_DEFAULT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
    ] {
        env.remove(field);
    }
}
