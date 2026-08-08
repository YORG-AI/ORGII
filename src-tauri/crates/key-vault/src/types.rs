//! Shared types for validation results.
//!
//! These types mirror the Python `orgii_shared.validation.types` module.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Single usage type (cursor_auto_composer, cursor_api, chat, completions, premium, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageItem {
    /// Type of usage: "cursor_auto_composer", "cursor_api", "chat", "completions", "premium", etc.
    pub usage_type: String,
    /// Whether this usage type is enabled
    pub enabled: bool,
    /// Amount used
    pub used: Option<i64>,
    /// Usage limit (None = unlimited)
    pub limit: Option<i64>,
    /// Remaining amount
    pub remaining: Option<i64>,
    /// Remaining percentage (0-100, -1 = unknown)
    pub remaining_percentage: f64,
    /// Reset time for this specific usage window (ISO 8601 string)
    #[serde(default)]
    pub reset_time: Option<String>,
}

impl UsageItem {
    pub fn new(usage_type: &str) -> Self {
        Self {
            usage_type: usage_type.to_string(),
            enabled: false,
            used: None,
            limit: None,
            remaining: None,
            remaining_percentage: -1.0,
            reset_time: None,
        }
    }
}

/// Exact monetary balance exposed by providers that do not publish a
/// percentage-based quota window (for example DeepSeek pay-as-you-go).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuotaBalance {
    pub amount: f64,
    pub currency: String,
}

/// Quota/usage information for an API key.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuotaInfo {
    /// Overall remaining percentage (0-100, -1 = unknown)
    pub remaining_percentage: f64,
    /// Total used
    pub used: Option<i64>,
    /// Total limit
    pub limit: Option<i64>,
    /// Total remaining
    pub remaining: Option<i64>,
    /// Reset time (ISO 8601 string)
    pub reset_time: Option<String>,
    /// Billing start date
    pub billing_start: Option<String>,
    /// Plan type: "Pro", "Free", "Business", "Enterprise", etc.
    pub plan_type: Option<String>,
    /// Limit type: "team", "individual"
    pub limit_type: Option<String>,
    /// Whether the plan is unlimited
    pub is_unlimited: bool,
    /// Which quota type determined the percentage
    pub quota_source: Option<String>,
    /// All usage items (cursor_auto_composer, cursor_api, chat, completions, etc.)
    pub usage_items: Vec<UsageItem>,
    /// Exact provider-reported balance. This is intentionally separate from
    /// percentage windows so callers never synthesize a misleading meter.
    #[serde(default)]
    pub balance: Option<QuotaBalance>,
    /// Auto-generated message from API
    pub auto_message: Option<String>,
    /// Named message from API
    pub named_message: Option<String>,
}

impl QuotaInfo {
    pub fn new() -> Self {
        Self {
            remaining_percentage: -1.0,
            ..Default::default()
        }
    }

    pub fn unlimited() -> Self {
        Self {
            remaining_percentage: 100.0,
            is_unlimited: true,
            ..Default::default()
        }
    }
}

/// Account-visible model metadata returned by a provider's authoritative
/// discovery surface. This is intentionally provider-neutral so the OAuth
/// wizard, refresh flow, and persisted variant metadata can share one result
/// instead of maintaining parallel model-id lists.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub supported_efforts: Vec<String>,
    #[serde(default)]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub supports_adaptive_thinking: bool,
    #[serde(default)]
    pub supports_manual_thinking: bool,
    #[serde(default)]
    pub is_default: bool,
}

/// Result of credential validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    /// Whether the credential is valid
    pub valid: bool,
    /// Human-readable message
    pub message: String,
    /// List of available model IDs
    #[serde(default)]
    pub models_available: Vec<String>,
    /// Per-model context window (tokens) reported by the provider's
    /// `/v1/models` endpoint. Empty for providers that only return ids
    /// (official OpenAI/Anthropic); populated by OpenAI-compat proxies and
    /// aggregators that expose `context_length`. Consumed at runtime to
    /// override the static `FAMILY_RULES` defaults — see
    /// `agent_core::providers::model_capabilities::resolve`.
    #[serde(default)]
    pub model_context_lengths: HashMap<String, u64>,
    /// List of disabled/unavailable model IDs
    #[serde(default)]
    pub disabled_models: Vec<String>,
    /// Whether the account is in degraded state
    #[serde(default)]
    pub is_degraded: bool,
    /// Quota information (if available)
    pub quota_info: Option<QuotaInfo>,
    /// Raw provider response (for debugging)
    #[serde(default)]
    pub provider_response: String,
}

impl ValidationResult {
    /// Create a successful validation result
    pub fn success(message: &str) -> Self {
        Self {
            valid: true,
            message: message.to_string(),
            models_available: Vec::new(),
            model_context_lengths: HashMap::new(),
            disabled_models: Vec::new(),
            is_degraded: false,
            quota_info: None,
            provider_response: String::new(),
        }
    }

    /// Create a failed validation result
    pub fn failure(message: &str) -> Self {
        Self {
            valid: false,
            message: message.to_string(),
            models_available: Vec::new(),
            model_context_lengths: HashMap::new(),
            disabled_models: Vec::new(),
            is_degraded: false,
            quota_info: None,
            provider_response: String::new(),
        }
    }

    /// Set models available
    pub fn with_models(mut self, models: Vec<String>) -> Self {
        self.models_available = models;
        self
    }

    /// Attach per-model context windows reported by the provider. Only the
    /// OpenAI-compat providers (openai/anthropic-proxy/azure) that expose
    /// `context_length` on `/v1/models` call this; other providers leave the
    /// map empty and the runtime falls back to the static family table.
    pub fn with_contexts(mut self, contexts: HashMap<String, u64>) -> Self {
        self.model_context_lengths = contexts;
        self
    }

    /// Set quota info
    pub fn with_quota(mut self, quota: QuotaInfo) -> Self {
        self.quota_info = Some(quota);
        self
    }
}
