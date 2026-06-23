//! Auto-detecting embedding provider.

use async_trait::async_trait;
use tracing::info;

use key_vault::key_store::{ModelType, KEY_SERVICE};

use super::azure::AzureEmbeddingProvider;
use super::openai::OpenAIEmbeddingProvider;
use super::{EmbeddingProvider, EmbeddingResult, OPENAI_DEFAULT_DIMS};

/// Provider-hint values that `AutoEmbeddingProvider` understands.
///
/// The hint is a free-form string today (it comes from
/// `IntegrationsConfig.embedding.provider` and may also be a `ModelType`
/// name like `"openai_api"` for forwards compatibility), so we keep it as
/// `&str`, but the *recognised* values live here as constants to keep the
/// match arms self-documenting.
mod hint {
    /// Force the bundled local embedder (no network, no API key needed).
    pub const LOCAL: &str = "local";
    /// Try local first, fall back to whichever API key is configured.
    pub const AUTO: &str = "auto";
    /// Use the OpenAI Embeddings API.
    pub const OPENAI: &str = "openai";
    /// Use the Azure OpenAI Embeddings deployment.
    pub const AZURE: &str = "azure";
    /// Long-form alias for `azure`.
    pub const AZURE_OPENAI: &str = "azure_openai";
}

/// API-key + endpoint pair resolved for an embedding provider. Local to this
/// file so the name stays short — the type never crosses module boundaries.
struct ResolvedEmbeddingKey {
    api_key: String,
    base_url: Option<String>,
    is_azure: bool,
}

/// Auto-detecting embedding provider.
///
/// Resolves the best available provider using the configured `provider` hint
/// (from `IntegrationsConfig.embedding.provider`) and stored credentials.
pub struct AutoEmbeddingProvider {
    /// Resolved inner provider (set on first use).
    inner: tokio::sync::Mutex<Option<Box<dyn EmbeddingProvider>>>,
    /// Provider hint: "auto", "openai", or another API-key provider name.
    provider_hint: String,
    /// Model override.
    model: Option<String>,
}

impl AutoEmbeddingProvider {
    pub fn new(provider_hint: String, model: Option<String>) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            provider_hint,
            model,
        }
    }

    /// Check synchronously whether any embedding provider can be resolved.
    ///
    /// Call this before registering memory search tools so the tools are
    /// skipped entirely when no provider is available (instead of failing
    /// at runtime with "missing required parameter: query").
    pub fn is_available(&self) -> bool {
        match self.provider_hint.as_str() {
            hint::LOCAL => Self::resolve_local(None).is_ok(),
            hint::AUTO => Self::resolve_local(None).is_ok() || Self::resolve_auto_api().is_some(),
            hint::OPENAI => Self::resolve_for_agent_type(&ModelType::OpenaiApi).is_some(),
            hint::AZURE | hint::AZURE_OPENAI => {
                Self::resolve_for_agent_type(&ModelType::AzureOpenaiApi).is_some()
            }
            other => ModelType::from_str(other)
                .and_then(|at| Self::resolve_for_agent_type(&at))
                .is_some(),
        }
    }

    /// Resolve the best available provider.
    async fn resolve(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.is_some() {
            return Ok(());
        }

        match self.provider_hint.as_str() {
            hint::LOCAL => {
                let provider = Self::resolve_local(None)?;
                *inner = Some(provider);
                return Ok(());
            }
            hint::AUTO => {
                if let Ok(provider) = Self::resolve_local(None) {
                    *inner = Some(provider);
                    return Ok(());
                }
            }
            _ => {}
        }

        let resolved = match self.provider_hint.as_str() {
            hint::OPENAI => Self::resolve_for_agent_type(&ModelType::OpenaiApi),
            hint::AZURE | hint::AZURE_OPENAI => {
                Self::resolve_for_agent_type(&ModelType::AzureOpenaiApi)
            }
            hint::AUTO => Self::resolve_auto_api(),
            other => ModelType::from_str(other)
                .and_then(|agent_type| Self::resolve_for_agent_type(&agent_type)),
        };

        match resolved {
            Some(cred) if cred.is_azure => {
                let base_url = cred.base_url.ok_or_else(|| {
                    "Azure embedding credential is missing base_url (deployment endpoint)"
                        .to_string()
                })?;
                info!(
                    "[memory-embeddings] Using Azure OpenAI embedding provider (hint={})",
                    self.provider_hint
                );
                *inner = Some(Box::new(AzureEmbeddingProvider::new(
                    cred.api_key,
                    base_url,
                )));
                Ok(())
            }
            Some(cred) => {
                info!(
                    "[memory-embeddings] Using OpenAI-compatible embedding provider (hint={})",
                    self.provider_hint
                );
                *inner = Some(Box::new(OpenAIEmbeddingProvider::new(
                    cred.api_key,
                    self.model.clone(),
                    cred.base_url,
                )));
                Ok(())
            }
            None => Err(format!(
                "No embedding provider available (provider={}). \
                 Add an OpenAI-compatible API key in Code Accounts, or select 'local'.",
                self.provider_hint
            )),
        }
    }

    /// Local embedding provider — Simon's setup: qwen3-embedding-4b served at
    /// `http://localhost:9876/v1` (OpenAI-compatible, 1024-dim, no API key).
    /// Overridable via env `ORGII_LOCAL_EMBED_URL` / `ORGII_LOCAL_EMBED_MODEL`.
    fn resolve_local(_custom_path: Option<&str>) -> Result<Box<dyn EmbeddingProvider>, String> {
        let base_url = std::env::var("ORGII_LOCAL_EMBED_URL")
            .unwrap_or_else(|_| "http://localhost:9876/v1".to_string());
        let model = std::env::var("ORGII_LOCAL_EMBED_MODEL")
            .unwrap_or_else(|_| "qwen3-embedding-4b".to_string());
        info!(
            "[memory-embeddings] Using LOCAL qwen3 embedding provider ({} / {})",
            base_url, model
        );
        Ok(Box::new(OpenAIEmbeddingProvider::new(
            "not-needed".to_string(),
            Some(model),
            Some(base_url),
        )))
    }

    /// Look up a credential for a specific agent type.
    fn resolve_for_agent_type(agent_type: &ModelType) -> Option<ResolvedEmbeddingKey> {
        let cred = KEY_SERVICE.get_key(agent_type, None)?;
        let api_key = cred.api_key.filter(|k| !k.is_empty())?;
        Some(ResolvedEmbeddingKey {
            api_key,
            base_url: cred.base_url.filter(|u| !u.is_empty()),
            is_azure: matches!(agent_type, ModelType::AzureOpenaiApi),
        })
    }

    /// Auto-resolve API providers: try Azure (dedicated embedding deployments)
    /// first, then OpenAI, then other compatible providers.
    fn resolve_auto_api() -> Option<ResolvedEmbeddingKey> {
        const PREFERRED_ORDER: &[ModelType] = &[
            ModelType::AzureOpenaiApi,
            ModelType::OpenaiApi,
            ModelType::OpenrouterApi,
            ModelType::ZenmuxApi,
            ModelType::DeepseekApi,
        ];

        for agent_type in PREFERRED_ORDER {
            if let Some(cred) = Self::resolve_for_agent_type(agent_type) {
                return Some(cred);
            }
        }
        None
    }
}

#[async_trait]
impl EmbeddingProvider for AutoEmbeddingProvider {
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String> {
        self.resolve().await?;
        let inner = self.inner.lock().await;
        inner.as_ref().unwrap().embed(text).await
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        self.resolve().await?;
        let inner = self.inner.lock().await;
        inner.as_ref().unwrap().embed_batch(texts).await
    }

    fn dimensions(&self) -> usize {
        OPENAI_DEFAULT_DIMS
    }

    fn provider_name(&self) -> &str {
        "auto"
    }
}
