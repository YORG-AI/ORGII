//! Shared types for CLI agent event parsing.
//!
//! The canonical `ActivityChunk` wire shape lives in
//! [`core_types::activity::ActivityChunk`] so non-CLI emitters
//! (`orgtrack_core`, event-pipeline ingestion, websocket broadcasters) can
//! type their values without depending on this module.

use serde::{Deserialize, Serialize};

/// CLI-based agents (subset of ModelType for parser use).
///
/// This is a focused subset for the parsers module. For the full set including
/// API providers, use `ModelType` from `key_vault::key_store::types`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentType {
    CursorCli,
    ClaudeCode,
    Codex,
    Kiro,
    Copilot,
    KimiCli,
    OpenCode,
    Aider,
    Goose,
    Amp,
    Cline,
    Kilo,
    Grok,
    Devin,
    Rovo,
    Hermes,
    OpenClaw,
    Aug,
    Codebuff,
    QwenCode,
    MimoCode,
    Antigravity,
    Continue,
    Droid,
    MistralVibe,
    Autohand,
    Omp,
    Pi,
    QoderCli,
    TraeCli,
}

impl CliAgentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CursorCli => "cursor_cli",
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Kiro => "kiro",
            Self::Copilot => "copilot",
            Self::KimiCli => "kimi_cli",
            Self::OpenCode => "opencode",
            Self::Aider => "aider",
            Self::Goose => "goose",
            Self::Amp => "amp",
            Self::Cline => "cline",
            Self::Kilo => "kilo",
            Self::Grok => "grok_cli",
            Self::Devin => "devin",
            Self::Rovo => "rovo",
            Self::Hermes => "hermes",
            Self::OpenClaw => "openclaw",
            Self::Aug => "aug",
            Self::Codebuff => "codebuff",
            Self::QwenCode => "qwen_code",
            Self::MimoCode => "mimo_code",
            Self::Antigravity => "antigravity",
            Self::Continue => "continue_cli",
            Self::Droid => "droid",
            Self::MistralVibe => "mistral_vibe",
            Self::Autohand => "autohand",
            Self::Omp => "omp",
            Self::Pi => "pi",
            Self::QoderCli => "qoder_cli",
            Self::TraeCli => "trae_cli",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cursor_cli" | "cursor" => Some(Self::CursorCli),
            "claude_code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "kiro" => Some(Self::Kiro),
            "copilot" => Some(Self::Copilot),
            "kimi_cli" | "kimi_code" => Some(Self::KimiCli),
            "opencode" | "opencode_cli" => Some(Self::OpenCode),
            "aider" => Some(Self::Aider),
            "goose" => Some(Self::Goose),
            "amp" => Some(Self::Amp),
            "cline" => Some(Self::Cline),
            "kilo" => Some(Self::Kilo),
            "grok_cli" | "grok" => Some(Self::Grok),
            "devin" => Some(Self::Devin),
            "rovo" => Some(Self::Rovo),
            "hermes" => Some(Self::Hermes),
            "openclaw" => Some(Self::OpenClaw),
            "aug" => Some(Self::Aug),
            "codebuff" => Some(Self::Codebuff),
            "qwen_code" => Some(Self::QwenCode),
            "mimo_code" => Some(Self::MimoCode),
            "antigravity" => Some(Self::Antigravity),
            "continue_cli" => Some(Self::Continue),
            "droid" => Some(Self::Droid),
            "mistral_vibe" => Some(Self::MistralVibe),
            "autohand" => Some(Self::Autohand),
            "omp" => Some(Self::Omp),
            "pi" => Some(Self::Pi),
            "qoder_cli" | "qodercli" => Some(Self::QoderCli),
            "trae_cli" | "trae-agent" => Some(Self::TraeCli),
            _ => None,
        }
    }
}

/// Deprecated: Use `CliAgentType` instead.
#[deprecated(since = "0.2.0", note = "Use CliAgentType instead")]
pub type AgentPlatform = CliAgentType;

/// Token usage reported by CLI agents.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    pub model: Option<String>,
}

#[cfg(test)]
#[path = "tests/types_tests.rs"]
mod tests;
