//! Policy-driven embedding provider selection. Explicit providers never fall back.
use super::openai::OpenAIEmbeddingProvider;
use super::{EmbeddingProvider, EmbeddingResult, OPENAI_DEFAULT_DIMS};
use async_trait::async_trait;
use key_vault::key_store::{HealthStatus, ModelType, KEY_SERVICE};
use tracing::info;

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
        let key = KEY_SERVICE.get_key(&ModelType::ZenmuxApi, None)?;
        let fresh = key
            .last_validated_at
            .is_some_and(|at| chrono::Utc::now().signed_duration_since(at).num_hours() <= 24);
        (key.enabled && key.health_status == HealthStatus::Valid && fresh).then_some(key)
    }
}
#[async_trait]
impl EmbeddingProvider for AutoEmbeddingProvider {
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String> {
        self.resolve().await?;
        self.inner.lock().await.as_ref().unwrap().embed(text).await
    }
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        self.resolve().await?;
        self.inner
            .lock()
            .await
            .as_ref()
            .unwrap()
            .embed_batch(texts)
            .await
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
