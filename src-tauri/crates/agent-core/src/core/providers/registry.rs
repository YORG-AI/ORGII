//! Provider registry -- single source of truth for LLM provider metadata.
//!
//! Maps provider names to their API configurations and model-name prefixes.
//!
//! ## Adding a new provider
//!
//! 1. Add a `pub const` to [`provider_id`] with the canonical wire name.
//! 2. Add a [`ProviderSpec`] entry to [`PROVIDERS`] using that constant.
//! 3. Use the constant (never the raw string) at any call site that needs to
//!    branch on provider identity (`spec.name == provider_id::ANTHROPIC`).

/// Canonical provider identifiers.
///
/// These are the wire-format strings used for `ProviderSpec::name`,
/// keys in saved configurations, and any cross-module branching that
/// needs to know "is this Anthropic?". Always reference these constants
/// instead of raw string literals so a typo becomes a compile error
/// rather than a silent miss in `find_by_name()`.
pub mod provider_id {
    // Aggregators
    pub const OPENROUTER: &str = "openrouter";
    pub const ZENMUX: &str = "zenmux";

    // Standard providers
    pub const ANTHROPIC: &str = "anthropic";
    pub const OPENAI: &str = "openai";
    pub const DEEPSEEK: &str = "deepseek";
    pub const GEMINI: &str = "gemini";
    pub const GROQ: &str = "groq";
    pub const XAI: &str = "xai";
    pub const ZHIPU: &str = "zhipu";
    pub const DASHSCOPE: &str = "dashscope";
    pub const MINIMAX: &str = "minimax";
    pub const MOONSHOT: &str = "moonshot";
    pub const AZURE_OPENAI: &str = "azure_openai";
    pub const VLLM: &str = "vllm";
}

/// Metadata for an LLM provider.
#[derive(Debug, Clone)]
pub struct ProviderSpec {
    /// Internal name (e.g., "openai", "anthropic", "openrouter").
    pub name: &'static str,
    /// Display name for UI.
    pub display_name: &'static str,
    /// Keywords in model names that indicate this provider (e.g., ["gpt", "o1"] for OpenAI).
    pub keywords: &'static [&'static str],
    /// Prefix to prepend to model names for the API (e.g., "openai/" for OpenRouter).
    pub litellm_prefix: Option<&'static str>,
    /// Model prefixes to skip when prepending (already have the prefix).
    pub skip_prefixes: &'static [&'static str],
    /// Default API base URL.
    pub default_api_base: Option<&'static str>,
    /// Default Anthropic-compatible API base URL when this provider exposes one.
    pub default_anthropic_api_base: Option<&'static str>,
    /// Whether this is a local server (e.g., vLLM).
    pub is_local: bool,
    /// Environment variable name used by account-less preflight checks when
    /// the key vault has no entry for the provider.
    pub env_key: Option<&'static str>,
}

/// All supported providers.
pub static PROVIDERS: &[ProviderSpec] = &[
    // ===== Aggregators (multi-provider routing) =====
    ProviderSpec {
        name: provider_id::OPENROUTER,
        display_name: "OpenRouter",
        keywords: &[],
        litellm_prefix: Some("openrouter/"),
        skip_prefixes: &["openrouter/"],
        default_api_base: Some("https://openrouter.ai/api/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("OPENROUTER_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::ZENMUX,
        display_name: "ZenMux",
        keywords: &[],
        litellm_prefix: None,
        skip_prefixes: &["zenmux/"],
        default_api_base: Some("https://zenmux.ai/api/v1"),
        default_anthropic_api_base: Some("https://zenmux.ai/api/anthropic"),
        is_local: false,
        env_key: Some("ZENMUX_API_KEY"),
    },
    // ===== Standard Providers =====
    ProviderSpec {
        name: provider_id::ANTHROPIC,
        display_name: "Anthropic",
        keywords: &["claude", "sonnet", "haiku", "opus"],
        litellm_prefix: None,
        skip_prefixes: &["anthropic/"],
        default_api_base: Some("https://api.anthropic.com/v1"),
        default_anthropic_api_base: Some("https://api.anthropic.com/v1"),
        is_local: false,
        env_key: Some("ANTHROPIC_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::OPENAI,
        display_name: "OpenAI",
        keywords: &["gpt", "o1", "o3", "o4"],
        litellm_prefix: None,
        skip_prefixes: &["openai/"],
        default_api_base: Some("https://api.openai.com/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("OPENAI_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::DEEPSEEK,
        display_name: "DeepSeek",
        keywords: &["deepseek"],
        litellm_prefix: None,
        skip_prefixes: &["deepseek/"],
        default_api_base: Some("https://api.deepseek.com"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("DEEPSEEK_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::GEMINI,
        display_name: "Google Gemini",
        keywords: &["gemini"],
        litellm_prefix: None, // Google's OpenAI-compat API expects bare model names (e.g. "gemini-2.0-flash")
        skip_prefixes: &["gemini/"], // Strip LiteLLM prefix from frontend model names
        default_api_base: Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("GEMINI_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::GROQ,
        display_name: "Groq",
        keywords: &["groq", "llama", "mixtral"],
        litellm_prefix: Some("groq/"),
        skip_prefixes: &["groq/"],
        default_api_base: Some("https://api.groq.com/openai/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("GROQ_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::XAI,
        display_name: "xAI Grok",
        keywords: &["grok"],
        litellm_prefix: None,
        skip_prefixes: &["xai/", "grok/"],
        default_api_base: Some("https://api.x.ai/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("XAI_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::ZHIPU,
        display_name: "Zhipu AI",
        keywords: &["glm"],
        litellm_prefix: None,
        skip_prefixes: &[],
        default_api_base: Some("https://open.bigmodel.cn/api/paas/v4"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("ZHIPU_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::DASHSCOPE,
        display_name: "DashScope (Qwen)",
        keywords: &["qwen"],
        litellm_prefix: None, // DashScope OpenAI-compat API expects bare model names (e.g. "qwen3-max")
        skip_prefixes: &["dashscope/"], // Strip LiteLLM prefix from frontend model names
        default_api_base: Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("DASHSCOPE_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::MINIMAX,
        display_name: "MiniMax",
        keywords: &["minimax", "abab"],
        litellm_prefix: None,
        skip_prefixes: &[],
        default_api_base: Some("https://api.minimax.io/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("MINIMAX_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::MOONSHOT,
        display_name: "Moonshot (Kimi)",
        keywords: &["kimi", "moonshot"],
        litellm_prefix: None,
        skip_prefixes: &[],
        default_api_base: Some("https://api.moonshot.cn/v1"),
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("MOONSHOT_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::AZURE_OPENAI,
        display_name: "Azure OpenAI",
        keywords: &[],
        litellm_prefix: Some("azure/"),
        skip_prefixes: &["azure/"],
        default_api_base: None,
        default_anthropic_api_base: None,
        is_local: false,
        env_key: Some("AZURE_OPENAI_API_KEY"),
    },
    ProviderSpec {
        name: provider_id::VLLM,
        display_name: "vLLM (Local)",
        keywords: &[],
        litellm_prefix: None,
        skip_prefixes: &[],
        default_api_base: None, // User must set their own
        default_anthropic_api_base: None,
        is_local: true,
        env_key: None,
    },
];

/// Guess a provider spec by model-name keywords.
///
/// This is a catalog/preflight hint only. Runtime session routing must use the
/// selected account's provider identity instead of guessing from model aliases.
pub fn guess_provider_by_model(model: &str) -> Option<&'static ProviderSpec> {
    let model_lower = model.to_lowercase();
    PROVIDERS
        .iter()
        .find(|spec| spec.keywords.iter().any(|kw| model_lower.contains(kw)))
}
/// Find a provider by internal name.
pub fn find_by_name(name: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|spec| spec.name == name)
}
