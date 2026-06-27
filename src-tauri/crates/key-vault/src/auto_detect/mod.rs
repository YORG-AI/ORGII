//! Auto-detect LLM keys from local config files and environment variables
//!
//! Scans common locations for API keys:
//! - Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
//! - Config files (~/.claude/config.json, etc.)
//! - OAuth tokens from local databases

mod claude;
mod codex;
mod copilot;
mod cursor;
mod gemini;
pub(crate) mod helpers;
mod kiro;
mod opencode;

use serde::{Deserialize, Serialize};

use crate::key_store::ModelType;

// ============================================
// Types
// ============================================

/// A detected key entry from auto-detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedKey {
    pub id: String,
    pub name: String,
    pub auth_method: String, // "api_key" or "oauth"
    pub api_key: Option<String>,
    pub session_token: Option<String>,
    pub base_url: Option<String>,
    pub env_vars: Option<std::collections::HashMap<String, String>>,
    pub available_models: Option<Vec<String>>,
    pub quota_info: Option<QuotaInfo>,
    pub validated: Option<bool>,
    pub validation_message: Option<String>,
}

/// Quota information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaInfo {
    pub remaining_percentage: Option<f64>,
    pub used: Option<i64>,
    pub limit: Option<i64>,
    pub remaining: Option<i64>,
    pub reset_time: Option<String>,
    pub plan_type: Option<String>,
    pub is_unlimited: Option<bool>,
}

/// Result of auto-detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDetectResult {
    pub success: bool,
    pub agent_type: String,
    pub message: String,
    pub keys: Vec<DetectedKey>,
}

// ============================================
// Auto-Detection Dispatch
// ============================================

/// Auto-detect keys for an agent type
pub async fn auto_detect_key(agent_type: &str) -> AutoDetectResult {
    let agent = match ModelType::from_str(agent_type) {
        Some(a) => a,
        None => {
            return AutoDetectResult {
                success: false,
                agent_type: agent_type.to_string(),
                message: format!("Unknown agent type: {}", agent_type),
                keys: vec![],
            }
        }
    };

    let detected_keys = match agent {
        ModelType::CursorCli => cursor::detect_cursor_keys().await,
        ModelType::ClaudeCode => claude::detect_claude_keys().await,
        ModelType::Codex => codex::detect_codex_keys().await,
        ModelType::GeminiCli => gemini::detect_gemini_keys().await,
        ModelType::Copilot => copilot::detect_copilot_keys().await,
        ModelType::Kiro => kiro::detect_kiro_keys().await,
        ModelType::OpenCode => opencode::detect_opencode_keys().await,
        // API key providers don't have auto-detect (keys are entered manually)
        _ => vec![],
    };

    if detected_keys.is_empty() {
        AutoDetectResult {
            success: false,
            agent_type: agent_type.to_string(),
            message: "No keys found in config files or environment".to_string(),
            keys: vec![],
        }
    } else {
        AutoDetectResult {
            success: true,
            agent_type: agent_type.to_string(),
            message: format!("Found {} key(s)", detected_keys.len()),
            keys: detected_keys,
        }
    }
}

#[cfg(test)]
mod tests;
