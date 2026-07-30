//! Policy-driven embedding provider selection. Explicit providers never fall back.
use super::openai::OpenAIEmbeddingProvider;
use super::{EmbeddingProvider, EmbeddingResult, OPENAI_DEFAULT_DIMS};
use async_trait::async_trait;
use key_vault::key_store::{HealthStatus, ModelType, KEY_SERVICE};
use tracing::{info, warn};

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProviderKind {
    Disabled,
    LocalQwen,
    LocalCodeRank,
    RemoteEmbedding,
}
fn provider_kind(hint: &str) -> Result<ProviderKind, String> {
    match hint.trim().to_ascii_lowercase().as_str() {
        "disabled" | "off" | "none" => Ok(ProviderKind::Disabled),
        "auto" | "local" | "local_qwen" | "qwen3" => Ok(ProviderKind::LocalQwen),
        "local_coderank" | "coderank" | "coderankembed" => Ok(ProviderKind::LocalCodeRank),
        "embedding" | "embedding_api" => Ok(ProviderKind::RemoteEmbedding),
        other => Err(format!("Unsupported embedding provider '{other}'")),
    }
}

pub struct AutoEmbeddingProvider {
    inner: tokio::sync::Mutex<Option<Box<dyn EmbeddingProvider>>>,
    config: crate::integrations::config::EmbeddingConfig,
    /// Key Vault id of the remote credential backing `inner`, when the
    /// provider was resolved through `RemoteEmbedding`. Used to demote the
    /// key on auth failures observed at call time.
    remote_key_id: tokio::sync::Mutex<Option<String>>,
}
impl AutoEmbeddingProvider {
    pub fn new(provider: String, model: Option<String>) -> Self {
        let mut config = crate::integrations::config::EmbeddingConfig::default();
        config.provider = provider;
        config.model = model;
        Self::from_config(config)
    }
    pub fn from_config(config: crate::integrations::config::EmbeddingConfig) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            config,
            remote_key_id: tokio::sync::Mutex::new(None),
        }
    }
    pub fn is_available(&self) -> bool {
        match provider_kind(&self.config.provider) {
            Ok(ProviderKind::LocalQwen) => self
                .config
                .local_base_url
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty()),
            Ok(ProviderKind::RemoteEmbedding) => Self::validated_remote_credential().is_some(),
            _ => false,
        }
    }
    async fn resolve(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.is_some() {
            return Ok(());
        }
        let provider: Box<dyn EmbeddingProvider> = match provider_kind(&self.config.provider)? {
            ProviderKind::Disabled => return Err("Embedding is disabled".into()),
            ProviderKind::LocalCodeRank => return Err("CodeRankEmbed session-memory adapter is unavailable on this platform; select local_qwen or embedding_api".into()),
            ProviderKind::LocalQwen => {
                let base_url = self.config.local_base_url.clone().filter(|v| !v.trim().is_empty()).ok_or("local_qwen requires localBaseUrl")?;
                let model = self.config.model.clone().filter(|v| !v.trim().is_empty()).ok_or("local_qwen requires model")?;
                info!("[memory-embeddings] local model={} url={}", model, base_url);
                Box::new(OpenAIEmbeddingProvider::with_limits(String::new(), Some(model), Some(base_url), self.config.dimensions, self.config.request_timeout_secs, self.config.max_input_chars)?)
            }
            ProviderKind::RemoteEmbedding => {
                let key = Self::validated_remote_credential().ok_or("ZenMux embedding is enabled by default but no enabled, validated ZenMux credential was found in Key Vault; configure ZenMux explicitly")?;
                *self.remote_key_id.lock().await = Some(key.id.clone());
                let model = self.config.model.clone().or_else(|| key.enabled_models.iter().find(|m| m.to_ascii_lowercase().contains("embedding")).cloned()).or_else(|| key.available_models.iter().find(|m| m.to_ascii_lowercase().contains("embedding")).cloned()).ok_or("ZenMux embedding credential has no enabled/available embedding model")?;
                let base_url = key.base_url.filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "https://zenmux.ai/api/v1".to_string());
                let api_key = key.api_key.filter(|v| !v.trim().is_empty()).ok_or("embedding_api requires api_key")?;
                Box::new(OpenAIEmbeddingProvider::with_limits(api_key, Some(model), Some(base_url), self.config.dimensions, self.config.request_timeout_secs, self.config.max_input_chars)?)
            }
        };
        *inner = Some(provider);
        Ok(())
    }
    fn validated_remote_credential() -> Option<key_vault::key_store::ModelKey> {
        // ZenMux is the built-in remote embedding transport. Deliberately do
        // not fall back to another provider/key when its credential is absent.
        //
        // Validation is persistent: a key that was validated once stays
        // usable regardless of how long ago that was. There is no freshness
        // window — demotion only happens when an actual embedding call fails
        // with an auth error (see `demote_remote_credential_on_auth_error`).
        let key = KEY_SERVICE.get_key(&ModelType::ZenmuxApi, None)?;
        (key.enabled && key.health_status == HealthStatus::Valid).then_some(key)
    }

    /// Inspect a call-time error and, if it is an auth failure (401/403),
    /// demote the backing Key Vault credential so `is_available()` reflects
    /// reality and the UI shows the key as invalid. Transient errors
    /// (timeouts, 5xx, network) never demote.
    async fn demote_remote_credential_on_auth_error(&self, err: &str) {
        if !is_auth_error(err) {
            return;
        }
        let key_id = self.remote_key_id.lock().await.clone();
        let Some(key_id) = key_id else { return };
        warn!(
            "[memory-embeddings] remote embedding auth failure; demoting key {} to invalid: {}",
            key_id, err
        );
        if let Err(store_err) = KEY_SERVICE.update_key_health(
            &key_id,
            HealthStatus::Invalid,
            Some(format!("embedding call auth failure: {err}")),
            None,
            None,
            None,
            None,
        ) {
            warn!(
                "[memory-embeddings] failed to persist health demotion for key {}: {}",
                key_id, store_err
            );
        }
        // Drop the cached provider so subsequent calls re-resolve (and fail
        // fast with a clear configuration error instead of hammering the API).
        *self.inner.lock().await = None;
    }
}

/// Auth-classifier for embedding/rerank HTTP errors. Only hard auth
/// rejections count; 5xx/timeouts are transient and must not demote keys.
pub(super) fn is_auth_error(err: &str) -> bool {
    err.contains("401") || err.contains("403") || {
        let lower = err.to_ascii_lowercase();
        lower.contains("unauthorized") || lower.contains("forbidden")
    }
}
#[async_trait]
impl EmbeddingProvider for AutoEmbeddingProvider {
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String> {
        self.resolve().await?;
        let result = { self.inner.lock().await.as_ref().unwrap().embed(text).await };
        if let Err(err) = &result {
            self.demote_remote_credential_on_auth_error(err).await;
        }
        result
    }
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        self.resolve().await?;
        let result = {
            self.inner
                .lock()
                .await
                .as_ref()
                .unwrap()
                .embed_batch(texts)
                .await
        };
        if let Err(err) = &result {
            self.demote_remote_credential_on_auth_error(err).await;
        }
        result
    }
    fn dimensions(&self) -> usize {
        self.config.dimensions.unwrap_or(OPENAI_DEFAULT_DIMS)
    }
    fn provider_name(&self) -> &str {
        "configured"
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_error_classification() {
        assert!(is_auth_error("OpenAI embedding API returned 401 Unauthorized: bad key"));
        assert!(is_auth_error("HTTP 403 Forbidden"));
        assert!(!is_auth_error("OpenAI embedding API returned 500: oops"));
        assert!(!is_auth_error("request timed out"));
        assert!(!is_auth_error("connection refused"));
    }

    #[test]
    fn explicit_policy() {
        assert_eq!(provider_kind("auto").unwrap(), ProviderKind::LocalQwen);
        assert_eq!(
            provider_kind("embedding_api").unwrap(),
            ProviderKind::RemoteEmbedding
        );
        assert!(provider_kind("zenmux_api").is_err());
        assert_eq!(
            crate::integrations::config::EmbeddingConfig::default().provider,
            "embedding_api"
        );
    }
}
