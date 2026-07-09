//! CLI environment variable configuration helpers.

use super::super::AgentEnvConfig;

pub(crate) fn cli_env_config(name: &str) -> Option<AgentEnvConfig> {
    let cfg = |key_var: &str,
               base_var: Option<&str>,
               supports: bool,
               placeholder_key: &str,
               base_placeholder: Option<&str>| AgentEnvConfig {
        api_key_env_var: key_var.into(),
        base_url_env_var: base_var.map(String::from),
        supports_base_url: supports,
        api_key_placeholder_key: placeholder_key.into(),
        base_url_placeholder: base_placeholder.map(String::from),
    };
    match name {
        "cursor_cli" => Some(cfg(
            "CURSOR_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.cursor_cli",
            None,
        )),
        "claude_code" => Some(cfg(
            "ANTHROPIC_API_KEY",
            Some("ANTHROPIC_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.claude_code",
            Some("https://api.example.com"),
        )),
        "codex" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.codex",
            Some("https://api.example.com/v1"),
        )),
        "gemini_cli" => Some(cfg(
            "GEMINI_API_KEY",
            Some("GOOGLE_GEMINI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.gemini_cli",
            Some("https://geminicode.net"),
        )),
        "copilot" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.copilot",
            Some("https://api.example.com/v1"),
        )),
        "kiro" => Some(cfg(
            "KIRO_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.kiro",
            None,
        )),
        "kimi_cli" => Some(cfg(
            "MOONSHOT_API_KEY",
            Some("MOONSHOT_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.kimi_cli",
            Some("https://api.moonshot.ai/v1"),
        )),
        "aider" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_API_BASE"),
            true,
            "codeAccounts.apiKeyPlaceholder.aider",
            Some("https://api.example.com/v1"),
        )),
        "goose" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.goose",
            Some("https://api.example.com/v1"),
        )),
        "grok_cli" => Some(cfg(
            "XAI_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.grok",
            None,
        )),
        "hermes" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.hermes",
            Some("https://api.example.com/v1"),
        )),
        "qwen_code" => Some(cfg(
            "DASHSCOPE_API_KEY",
            Some("DASHSCOPE_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.qwen_code",
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )),
        "continue_cli" => Some(cfg(
            "OPENAI_API_KEY",
            Some("OPENAI_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.continue_cli",
            Some("https://api.example.com/v1"),
        )),
        "mistral_vibe" => Some(cfg(
            "MISTRAL_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.mistral_vibe",
            None,
        )),
        "amp" => Some(cfg(
            "AMP_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.amp",
            None,
        )),
        "cline" => Some(cfg(
            "ANTHROPIC_API_KEY",
            Some("ANTHROPIC_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.cline",
            Some("https://api.example.com"),
        )),
        "kilo" => Some(cfg(
            "ANTHROPIC_API_KEY",
            Some("ANTHROPIC_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.kilo",
            Some("https://api.example.com"),
        )),
        "devin" => Some(cfg(
            "DEVIN_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.devin",
            None,
        )),
        "rovo" => Some(cfg(
            "ATLASSIAN_API_TOKEN",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.rovo",
            None,
        )),
        "codebuff" => Some(cfg(
            "CODEBUFF_API_KEY",
            None,
            false,
            "codeAccounts.apiKeyPlaceholder.codebuff",
            None,
        )),
        "mimo_code" => Some(cfg(
            "ANTHROPIC_API_KEY",
            Some("ANTHROPIC_BASE_URL"),
            true,
            "codeAccounts.apiKeyPlaceholder.mimo_code",
            // MiMo's hosted Anthropic-compatible endpoint.
            Some("https://api.xiaomimimo.com/anthropic"),
        )),
        // Agents without a single universal API-key env var for ORGII to inject.
        // Some are subscription-token based, while others require provider-specific
        // config files or auth stores instead of one standard env-config path.
        "aug" | "droid" | "autohand" | "omp" | "pi" | "open_claw" | "openclaw" | "antigravity" => {
            None
        }
        // The caller iterates `cli_agent_registry()` entries, so a CLI
        // agent that ships in the registry but has no env config here
        // would silently let the API-key dialog render with no env-var
        // hint. Warn so a future registry addition surfaces in logs.
        other => {
            tracing::warn!(
                "[key_vault::registry] cli_env_config has no entry for CLI agent {:?}; \
                 the API-key dialog will render without an env-var hint",
                other
            );
            None
        }
    }
}
