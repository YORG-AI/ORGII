//! Azure OpenAI embedding provider.

use async_trait::async_trait;
use serde::Serialize;

use super::openai::OpenAIEmbedResponse;
use super::{EmbeddingProvider, EmbeddingResult, OPENAI_DEFAULT_DIMS};

const AZURE_API_VERSION: &str = "2024-02-01";

/// Azure OpenAI embedding provider.
///
/// Azure uses `api-key` header (not Bearer token) and requires
/// `?api-version=` query parameter. The base_url is the full deployment
/// endpoint (e.g. `https://{resource}.openai.azure.com/openai/deployments/{deployment}`).
pub struct AzureEmbeddingProvider {
    api_key: String,
    base_url: String,
    dimensions: usize,
    client: reqwest::Client,
}

impl AzureEmbeddingProvider {
    pub fn new(api_key: String, base_url: String) -> Self {
        Self {
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            dimensions: OPENAI_DEFAULT_DIMS,
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Serialize)]
struct AzureEmbedRequest {
    input: Vec<String>,
}

#[async_trait]
impl EmbeddingProvider for AzureEmbeddingProvider {
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String> {
        let url = format!(
            "{}/embeddings?api-version={}",
            self.base_url, AZURE_API_VERSION
        );

        let request = AzureEmbedRequest {
            input: vec![text.to_string()],
        };

        let response = self
            .client
            .post(&url)
            .header("api-key", &self.api_key)
            .json(&request)
            .send()
            .await
            .map_err(|err| format!("Azure embedding request failed: {}", err))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::utils::response_text_or_read_error(response).await;
            return Err(format!("Azure embedding API returned {}: {}", status, body));
        }

        let body: OpenAIEmbedResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse Azure embedding response: {}", err))?;

        let embedding = body
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "Empty Azure embedding response".to_string())?;

        Ok(EmbeddingResult {
            dimensions: embedding.embedding.len(),
            source: format!("azure:azure-deployment:{}", embedding.embedding.len()),
            vector: embedding.embedding,
            model: "azure-deployment".to_string(),
        })
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        let url = format!(
            "{}/embeddings?api-version={}",
            self.base_url, AZURE_API_VERSION
        );

        let request = AzureEmbedRequest {
            input: texts.to_vec(),
        };

        let response = self
            .client
            .post(&url)
            .header("api-key", &self.api_key)
            .json(&request)
            .send()
            .await
            .map_err(|err| format!("Azure batch embedding request failed: {}", err))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::utils::response_text_or_read_error(response).await;
            return Err(format!("Azure embedding API returned {}: {}", status, body));
        }

        let body: OpenAIEmbedResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse Azure batch embedding response: {}", err))?;

        Ok(body
            .data
            .into_iter()
            .map(|item| EmbeddingResult {
                dimensions: item.embedding.len(),
                source: format!("azure:azure-deployment:{}", item.embedding.len()),
                vector: item.embedding,
                model: "azure-deployment".to_string(),
            })
            .collect())
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn provider_name(&self) -> &str {
        "azure"
    }
}
