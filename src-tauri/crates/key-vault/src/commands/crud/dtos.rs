use std::collections::HashMap;

use crate::key_store::ModelVariant;

/// Serializable model alias for API responses
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ModelAliasInfo {
    #[serde(default)]
    pub display_name: String,
    pub alias: String,
    pub icon: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ModelVariantInfo {
    pub model: String,
    pub base_model: String,
    pub reasoning: Option<String>,
    pub fast: bool,
    /// Context window reported by the provider's `/v1/models` endpoint.
    /// Round-tripped so a subsequent `save_key` carrying `model_variants`
    /// doesn't erase the value written by `update_key_health`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

impl From<ModelVariantInfo> for ModelVariant {
    fn from(v: ModelVariantInfo) -> Self {
        ModelVariant {
            model: v.model,
            base_model: v.base_model,
            reasoning: v.reasoning,
            fast: v.fast,
            context_window: v.context_window.filter(|ctx| *ctx > 0),
        }
    }
}

/// Serializable per-base-model default variant for API responses
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DefaultVariantInfo {
    pub base_model: String,
    pub model: String,
}

/// Response for key info (sensitive data masked)
#[derive(serde::Serialize)]
pub struct KeyInfo {
    pub id: String,
    pub name: Option<String>,
    pub agent_type: String,
    pub has_api_key: bool,
    pub has_session_token: bool,
    pub has_base_url: bool,
    pub api_key_preview: Option<String>,
    pub session_token_preview: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: Vec<String>,
    pub env_vars_masked: HashMap<String, String>,
    pub account_metadata: HashMap<String, String>,
    pub available_models: Vec<String>,
    pub enabled_models: Vec<String>,
    pub model_aliases: Vec<ModelAliasInfo>,
    pub model_variants: Vec<ModelVariantInfo>,
    pub default_variants: Vec<DefaultVariantInfo>,
    pub quota_info: Option<serde_json::Value>,
    pub description: Option<String>,
    pub has_local_key: bool,
    pub is_listed: bool,
    pub auth_method: String,
    pub listing_id: Option<String>,
    pub health_status: String,
    pub last_validation_error: Option<String>,
    pub last_validated_at: Option<String>,
    pub oauth_refresh_failure_count: u32,
    pub last_oauth_refresh_failed_at: Option<String>,
    pub temporary_unavailable_until: Option<String>,
    pub temporary_unavailable_reason: Option<String>,
    pub last_upstream_status: Option<u16>,
    pub last_upstream_error_type: Option<String>,
    pub rate_limit_reset_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub enabled: bool,
    pub can_refresh_quota: bool,
    pub supports_rust_agents: bool,
    pub can_launch_cli: bool,
    pub can_use_native_harness: bool,
    pub native_harness_type: Option<String>,
}

/// Request to save a key
#[derive(serde::Deserialize)]
pub struct SaveKeyRequest {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub agent_type: String,
    pub api_key: Option<String>,
    pub session_token: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: Option<HashMap<String, String>>,
    pub account_metadata: Option<HashMap<String, String>>,
    pub available_models: Option<Vec<String>>,
    pub enabled_models: Option<Vec<String>>,
    pub model_aliases: Option<Vec<ModelAliasInfo>>,
    pub model_variants: Option<Vec<ModelVariantInfo>>,
    pub default_variants: Option<Vec<DefaultVariantInfo>>,
    pub quota_info: Option<serde_json::Value>,
    pub has_local_key: Option<bool>,
    pub is_listed: Option<bool>,
    pub auth_method: Option<String>,
    pub listing_id: Option<String>,
    pub enabled: Option<bool>,
}

/// Full key response (unmasked, for internal use)
#[derive(serde::Serialize)]
pub struct FullKeyResponse {
    pub id: String,
    pub name: Option<String>,
    pub agent_type: String,
    pub api_key: Option<String>,
    pub session_token: Option<String>,
    pub base_url: Option<String>,
    pub protocol: Option<String>,
    pub env_vars: HashMap<String, String>,
    pub account_metadata: HashMap<String, String>,
    pub available_models: Vec<String>,
    pub model_aliases: Vec<ModelAliasInfo>,
    pub model_variants: Vec<ModelVariantInfo>,
    pub default_variants: Vec<DefaultVariantInfo>,
    pub auth_method: String,
}
