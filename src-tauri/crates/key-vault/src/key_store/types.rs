use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
// Deserializer is used by the flexible_datetime modules below
use std::collections::HashMap;
use uuid::Uuid;

// Custom serde for flexible datetime parsing (naive timestamps without timezone)
pub(crate) mod flexible_datetime {
    use super::*;

    pub fn serialize<S>(dt: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Serialize without timezone (naive ISO 8601)
        let s = dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
        serializer.serialize_str(&s)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        // Try parsing with timezone first, then without
        if let Ok(dt) = DateTime::parse_from_rfc3339(&s) {
            return Ok(dt.with_timezone(&Utc));
        }
        // Parse without timezone (naive ISO 8601)
        NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
            .map(|naive| naive.and_utc())
            .map_err(|e| serde::de::Error::custom(format!("Invalid datetime: {}", e)))
    }
}

pub(crate) mod optional_flexible_datetime {
    use super::*;

    pub fn serialize<S>(opt: &Option<DateTime<Utc>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match opt {
            Some(dt) => {
                let s = dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                serializer.serialize_some(&s)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt: Option<String> = Option::deserialize(deserializer)?;
        match opt {
            Some(s) => {
                if let Ok(dt) = DateTime::parse_from_rfc3339(&s) {
                    return Ok(Some(dt.with_timezone(&Utc)));
                }
                NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
                    .map(|naive| Some(naive.and_utc()))
                    .map_err(|e| serde::de::Error::custom(format!("Invalid datetime: {}", e)))
            }
            None => Ok(None),
        }
    }
}

// ============================================
// Enums
// ============================================

/// LLM provider / credential kind (API key or CLI-backed agent).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ModelType {
    // CLI-based coding agents
    CursorCli,
    ClaudeCode,
    Codex,
    GeminiCli,
    Copilot,
    Kiro,
    KimiCli,
    OpenCode,
    // Extended CLI agents
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
    // Direct API key providers
    AnthropicApi,
    OpenaiApi,
    DeepseekApi,
    GeminiApi,
    GroqApi,
    XaiApi,
    ZhipuApi,
    DashscopeApi,
    MoonshotApi,
    OpenrouterApi,
    ZenmuxApi,
    VllmApi,
    MinimaxApi,
    LongcatApi,
    SiliconflowApi,
    ModelscopeApi,
    AihubmixApi,
    CherryinApi,
    /// AWS Bedrock via the `bedrock-mantle` OpenAI/Anthropic-compatible
    /// surface, authenticated with a Bedrock API key rather than SigV4.
    BedrockApi,
    /// Fully user-defined gateway: the user supplies base URL and protocol.
    CustomApi,
    /// OpenAI-compatible embedding-only credential. Never used for chat.
    EmbeddingApi,
    AzureOpenaiApi,
    /// Azure-hosted Anthropic gateway. Same auth shape as `AzureOpenaiApi`
    /// (an Azure resource key + base URL) but routed through the Anthropic
    /// Messages API in `factory.rs` instead of the OpenAI-compat path.
    AzureAnthropicApi,
    // ORGII Orchestrator (API key for ORGII pool access)
    OrgiiOrchestrator,
}

impl ModelType {
    pub fn as_str(&self) -> &'static str {
        match self {
            // CLI agents
            ModelType::CursorCli => "cursor_cli",
            ModelType::ClaudeCode => "claude_code",
            ModelType::Codex => "codex",
            ModelType::GeminiCli => "gemini_cli",
            ModelType::Copilot => "copilot",
            ModelType::Kiro => "kiro",
            ModelType::KimiCli => "kimi_cli",
            ModelType::OpenCode => "opencode",
            ModelType::Aider => "aider",
            ModelType::Goose => "goose",
            ModelType::Amp => "amp",
            ModelType::Cline => "cline",
            ModelType::Kilo => "kilo",
            ModelType::Grok => "grok_cli",
            ModelType::Devin => "devin",
            ModelType::Rovo => "rovo",
            ModelType::Hermes => "hermes",
            ModelType::OpenClaw => "openclaw",
            ModelType::Aug => "aug",
            ModelType::Codebuff => "codebuff",
            ModelType::QwenCode => "qwen_code",
            ModelType::MimoCode => "mimo_code",
            ModelType::Antigravity => "antigravity",
            ModelType::Continue => "continue_cli",
            ModelType::Droid => "droid",
            ModelType::MistralVibe => "mistral_vibe",
            ModelType::Autohand => "autohand",
            ModelType::Omp => "omp",
            ModelType::Pi => "pi",
            // API key providers
            ModelType::AnthropicApi => "anthropic_api",
            ModelType::OpenaiApi => "openai_api",
            ModelType::DeepseekApi => "deepseek_api",
            ModelType::GeminiApi => "gemini_api",
            ModelType::GroqApi => "groq_api",
            ModelType::XaiApi => "xai_api",
            ModelType::ZhipuApi => "zhipu_api",
            ModelType::DashscopeApi => "dashscope_api",
            ModelType::MoonshotApi => "moonshot_api",
            ModelType::OpenrouterApi => "openrouter_api",
            ModelType::ZenmuxApi => "zenmux_api",
            ModelType::VllmApi => "vllm_api",
            ModelType::MinimaxApi => "minimax_api",
            ModelType::LongcatApi => "longcat_api",
            ModelType::SiliconflowApi => "siliconflow_api",
            ModelType::ModelscopeApi => "modelscope_api",
            ModelType::AihubmixApi => "aihubmix_api",
            ModelType::CherryinApi => "cherryin_api",
            ModelType::BedrockApi => "bedrock_api",
            ModelType::CustomApi => "custom_api",
            ModelType::EmbeddingApi => "embedding_api",
            ModelType::AzureOpenaiApi => "azure_openai_api",
            ModelType::AzureAnthropicApi => "azure_anthropic_api",
            ModelType::OrgiiOrchestrator => "orgii_orchestrator",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<ModelType> {
        match s.to_lowercase().as_str() {
            // CLI agents (keep existing aliases for backward compat)
            "cursor_cli" | "cursor" => Some(ModelType::CursorCli),
            "claude_code" => Some(ModelType::ClaudeCode),
            "codex" => Some(ModelType::Codex),
            "gemini_cli" => Some(ModelType::GeminiCli),
            "copilot" | "github_copilot" => Some(ModelType::Copilot),
            "kiro" | "amazon_kiro" => Some(ModelType::Kiro),
            "kimi_cli" | "kimi_code" => Some(ModelType::KimiCli),
            "opencode" | "opencode_cli" => Some(ModelType::OpenCode),
            "aider" => Some(ModelType::Aider),
            "goose" => Some(ModelType::Goose),
            "amp" => Some(ModelType::Amp),
            "cline" => Some(ModelType::Cline),
            "kilo" => Some(ModelType::Kilo),
            "grok_cli" | "grok" => Some(ModelType::Grok),
            "devin" => Some(ModelType::Devin),
            "rovo" => Some(ModelType::Rovo),
            "hermes" => Some(ModelType::Hermes),
            "openclaw" => Some(ModelType::OpenClaw),
            "aug" => Some(ModelType::Aug),
            "codebuff" => Some(ModelType::Codebuff),
            "qwen_code" => Some(ModelType::QwenCode),
            "mimo_code" => Some(ModelType::MimoCode),
            "antigravity" => Some(ModelType::Antigravity),
            "continue_cli" => Some(ModelType::Continue),
            "droid" => Some(ModelType::Droid),
            "mistral_vibe" => Some(ModelType::MistralVibe),
            "autohand" => Some(ModelType::Autohand),
            "omp" => Some(ModelType::Omp),
            "pi" => Some(ModelType::Pi),
            // API key providers
            "anthropic_api" | "anthropic" => Some(ModelType::AnthropicApi),
            "openai_api" | "openai" => Some(ModelType::OpenaiApi),
            "deepseek_api" | "deepseek" => Some(ModelType::DeepseekApi),
            "gemini_api" | "gemini" | "google" => Some(ModelType::GeminiApi),
            "groq_api" | "groq" => Some(ModelType::GroqApi),
            "xai_api" | "xai" => Some(ModelType::XaiApi),
            "zhipu_api" | "zhipu" => Some(ModelType::ZhipuApi),
            "dashscope_api" | "dashscope" => Some(ModelType::DashscopeApi),
            "moonshot_api" | "moonshot" => Some(ModelType::MoonshotApi),
            "openrouter_api" | "openrouter" => Some(ModelType::OpenrouterApi),
            "zenmux_api" | "zenmux" => Some(ModelType::ZenmuxApi),
            "vllm_api" | "vllm" => Some(ModelType::VllmApi),
            "minimax_api" | "minimax" => Some(ModelType::MinimaxApi),
            "longcat_api" | "longcat" => Some(ModelType::LongcatApi),
            "siliconflow_api" | "siliconflow" => Some(ModelType::SiliconflowApi),
            "modelscope_api" | "modelscope" => Some(ModelType::ModelscopeApi),
            "aihubmix_api" | "aihubmix" => Some(ModelType::AihubmixApi),
            "cherryin_api" | "cherryin" => Some(ModelType::CherryinApi),
            "bedrock_api" | "bedrock" => Some(ModelType::BedrockApi),
            "custom_api" | "custom" => Some(ModelType::CustomApi),
            "embedding_api" | "embedding" => Some(ModelType::EmbeddingApi),
            "azure_openai_api" | "azure_openai" | "azure" => Some(ModelType::AzureOpenaiApi),
            "azure_anthropic_api" | "azure_anthropic" => Some(ModelType::AzureAnthropicApi),
            "orgii_orchestrator" | "orgii" => Some(ModelType::OrgiiOrchestrator),
            _ => None,
        }
    }

    /// Returns `true` if this is a direct API key provider (not a CLI agent).
    pub fn is_api_key_provider(&self) -> bool {
        !self.is_cli_agent()
    }

    /// Embedding-only credentials are never valid chat/agent providers.
    pub fn is_embedding_only(&self) -> bool {
        matches!(self, ModelType::EmbeddingApi)
    }

    /// Providers eligible for generation runtimes and model selectors.
    pub fn supports_generation(&self) -> bool {
        !self.is_embedding_only()
    }

    /// Returns `true` if this is a CLI-based coding agent.
    pub fn is_cli_agent(&self) -> bool {
        matches!(
            self,
            ModelType::CursorCli
                | ModelType::ClaudeCode
                | ModelType::Codex
                | ModelType::GeminiCli
                | ModelType::Copilot
                | ModelType::Kiro
                | ModelType::KimiCli
                | ModelType::OpenCode
                | ModelType::Aider
                | ModelType::Goose
                | ModelType::Amp
                | ModelType::Cline
                | ModelType::Kilo
                | ModelType::Grok
                | ModelType::Devin
                | ModelType::Rovo
                | ModelType::Hermes
                | ModelType::OpenClaw
                | ModelType::Aug
                | ModelType::Codebuff
                | ModelType::QwenCode
                | ModelType::MimoCode
                | ModelType::Antigravity
                | ModelType::Continue
                | ModelType::Droid
                | ModelType::MistralVibe
                | ModelType::Autohand
                | ModelType::Omp
                | ModelType::Pi
        )
    }

    /// Returns `true` if this agent requires MITM proxy interception.
    ///
    /// Agents that don't support custom base URL override need their HTTPS
    /// traffic intercepted to swap credentials for cloud billing.
    pub fn needs_mitm_proxy(&self) -> bool {
        matches!(
            self,
            ModelType::CursorCli | ModelType::Copilot | ModelType::Kiro
        )
    }

    pub fn is_acp(&self) -> bool {
        matches!(
            self,
            ModelType::Copilot | ModelType::Kiro | ModelType::OpenCode
        )
    }

    /// Returns `true` if this type is market-native (ORGII pool only, no user keys).
    pub fn is_market_native(&self) -> bool {
        matches!(self, ModelType::OrgiiOrchestrator)
    }
}

/// Authentication method
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum AuthMethod {
    #[default]
    ApiKey,
    Oauth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenAi,
    Anthropic,
}

impl ProviderProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderProtocol::OpenAi => "openai",
            ProviderProtocol::Anthropic => "anthropic",
        }
    }
}

/// Health status of the credential
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum HealthStatus {
    Valid,
    Degraded,
    Invalid,
    #[default]
    Unknown,
}

// ============================================
// Data Models
// ============================================

/// Generate a unique key ID (8 char hex)
fn generate_key_id() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

/// Stored API key / token entry for a CLI agent or provider.
///
/// Two boolean flags express the listing state:
///
/// | `has_local_key` | `is_listed` | Meaning                                  |
/// |-----------------|-------------|------------------------------------------|
/// | `true`          | `false`     | Key exists locally, not published        |
/// | `false`         | `true`      | Published listing, no local key row      |
/// | `true`          | `true`      | Key exists locally AND published listing |
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelKey {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "agent_type")]
    pub model_type: ModelType,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub protocol: Option<ProviderProtocol>,
    #[serde(default)]
    pub env_vars: HashMap<String, String>,
    #[serde(default)]
    pub account_metadata: HashMap<String, String>,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub available_models: Vec<String>,
    #[serde(default)]
    pub quota_info: Option<serde_json::Value>,
    #[serde(default = "Utc::now", with = "flexible_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now", with = "flexible_datetime")]
    pub updated_at: DateTime<Utc>,
    /// Key material is stored locally (in credentials.json).
    #[serde(default = "app_utils::default_true")]
    pub has_local_key: bool,
    /// This key is published as a market listing.
    #[serde(default)]
    pub is_listed: bool,
    #[serde(default)]
    pub listing_id: Option<String>,
    #[serde(default)]
    pub health_status: HealthStatus,
    #[serde(default)]
    pub last_validation_error: Option<String>,
    #[serde(default, with = "optional_flexible_datetime")]
    pub last_validated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub enabled_models: Vec<String>,
    #[serde(default)]
    pub model_aliases: Vec<ModelAlias>,
    #[serde(default)]
    pub model_variants: Vec<ModelVariant>,
    /// User-chosen default variant per base model. When a base model family
    /// (e.g. `claude-4.6-opus`) is selected, the runtime resolves it to the
    /// concrete variant model id stored here (e.g. `claude-4.6-opus-high`).
    #[serde(default)]
    pub default_variants: Vec<DefaultVariant>,
    #[serde(default)]
    pub oauth_refresh_failure_count: u32,
    #[serde(default, with = "optional_flexible_datetime")]
    pub last_oauth_refresh_failed_at: Option<DateTime<Utc>>,
    #[serde(default, with = "optional_flexible_datetime")]
    pub temporary_unavailable_until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub temporary_unavailable_reason: Option<String>,
    #[serde(default)]
    pub last_upstream_status: Option<u16>,
    #[serde(default)]
    pub last_upstream_error_type: Option<String>,
    #[serde(default, with = "optional_flexible_datetime")]
    pub rate_limit_reset_at: Option<DateTime<Utc>>,
    /// Master switch — when false the key is disabled without clearing enabled_models.
    #[serde(default = "app_utils::default_true")]
    pub enabled: bool,
}

/// A user-added model entry for proxies that don't expose a model list.
/// `alias` is the model id used to call the LLM; `display_name` is what is
/// shown in agent selectors and other UI surfaces (falls back to `alias`
/// when empty).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAlias {
    /// Display name shown in UI (e.g., "Claude Sonnet 4.5"). Optional.
    #[serde(default)]
    pub display_name: String,
    /// Model id used to call the LLM (e.g., "claude-sonnet-4-5").
    pub alias: String,
    /// User-chosen icon provider key (e.g., "openai", "claude")
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelVariant {
    pub model: String,
    pub base_model: String,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub fast: bool,
    /// Context window (tokens) reported by this provider's `/v1/models`
    /// endpoint, overriding the static `FAMILY_RULES` default at runtime.
    /// `None` when the provider did not report one (official OpenAI/Anthropic).
    #[serde(default)]
    pub context_window: Option<u64>,
}

/// A user-chosen default variant for one base model family. `base_model` is
/// the family root (e.g. `claude-4.6-opus`); `model` is the concrete variant
/// id the runtime should launch when that family is selected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultVariant {
    pub base_model: String,
    pub model: String,
}

impl ModelKey {
    /// Create a new key entry with auto-generated ID
    pub fn new(model_type: ModelType) -> Self {
        Self {
            id: generate_key_id(),
            name: None,
            description: None,
            model_type,
            api_key: None,
            session_token: None,
            base_url: None,
            protocol: None,
            env_vars: HashMap::new(),
            account_metadata: HashMap::new(),
            auth_method: AuthMethod::ApiKey,
            available_models: Vec::new(),
            quota_info: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            has_local_key: true,
            is_listed: false,
            listing_id: None,
            health_status: HealthStatus::Unknown,
            last_validation_error: None,
            last_validated_at: None,
            enabled_models: Vec::new(),
            model_aliases: Vec::new(),
            model_variants: Vec::new(),
            default_variants: Vec::new(),
            oauth_refresh_failure_count: 0,
            last_oauth_refresh_failed_at: None,
            temporary_unavailable_until: None,
            temporary_unavailable_reason: None,
            last_upstream_status: None,
            last_upstream_error_type: None,
            rate_limit_reset_at: None,
            enabled: true,
        }
    }

    /// Mask sensitive data for display
    pub fn mask_api_key(&self) -> Option<String> {
        self.api_key.as_ref().map(|key| {
            if key.len() <= 8 {
                "*".repeat(key.len())
            } else {
                let masked_len = key.len().saturating_sub(8).min(20);
                format!(
                    "{}{}{}",
                    &key[..4],
                    "*".repeat(masked_len),
                    &key[key.len() - 4..]
                )
            }
        })
    }

    /// Mask session token for display
    pub fn mask_session_token(&self) -> Option<String> {
        self.session_token.as_ref().map(|token| {
            if token.len() <= 8 {
                "*".repeat(token.len())
            } else {
                let masked_len = token.len().saturating_sub(8).min(20);
                format!(
                    "{}{}{}",
                    &token[..4],
                    "*".repeat(masked_len),
                    &token[token.len() - 4..]
                )
            }
        })
    }
}

/// Whether the account talks to an official Anthropic endpoint. A configured
/// `base_url` means the traffic goes through a third-party relay/mirror whose
/// gateway may reject Anthropic-native request features (`output_config`/
/// effort, OAuth bearer auth, beta headers) — those accounts must never
/// receive them.
///
/// The prefix must end at a host boundary so lookalike hosts
/// (e.g. `api.anthropic.com.evil.example`) don't classify as official.
///
/// Shared with agent-core's provider factory so both crates agree on what
/// "official endpoint" means (same lockstep discipline as
/// `model_supports_output_config_effort`).
pub fn is_official_anthropic_endpoint(base_url: Option<&str>) -> bool {
    const OFFICIAL_ORIGIN: &str = "https://api.anthropic.com";
    match base_url.map(str::trim) {
        None | Some("") => true,
        Some(url) => match url.strip_prefix(OFFICIAL_ORIGIN) {
            Some(rest) => match rest.as_bytes().first() {
                None => true,
                Some(b'/') | Some(b'?') => true,
                // Allow an explicit port, but only digits up to the path —
                // `:pass@evil.example/` must not read as official.
                Some(b':') => {
                    let port = &rest[1..];
                    let port = &port[..port.find(['/', '?']).unwrap_or(port.len())];
                    !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
                }
                Some(_) => false,
            },
            None => false,
        },
    }
}

/// Whether `token` is an official Anthropic OAuth access token (Claude Code
/// sign-in). These carry the `sk-ant-oat` prefix and only authenticate
/// against the official Anthropic API — presenting one to a third-party
/// relay gets it rejected as an unknown API key. Relay-issued ClaudeCode
/// session tokens do not have this prefix.
pub fn is_claude_official_oauth_token(token: &str) -> bool {
    token.trim().starts_with("sk-ant-oat")
}
