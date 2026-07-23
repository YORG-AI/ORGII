//! OpenAI-compatible embedding provider.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::{EmbeddingProvider, EmbeddingResult, OPENAI_DEFAULT_DIMS};

const OPENAI_DEFAULT_MODEL: &str = "text-embedding-3-small";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// OpenAI-compatible embedding provider.
pub struct OpenAIEmbeddingProvider {
    api_key: String,
    model: String,
    base_url: String,
    dimensions: usize,
    client: reqwest::Client,
    max_input_chars: usize,
}

impl OpenAIEmbeddingProvider {
    pub fn new(api_key: String, model: Option<String>, base_url: Option<String>) -> Self {
        Self::with_limits(api_key, model, base_url, None, 20, 48_000)
            .expect("default embedding client configuration is valid")
    }

    pub fn with_limits(
        api_key: String,
        model: Option<String>,
        base_url: Option<String>,
        dimensions: Option<usize>,
        timeout_secs: u64,
        max_input_chars: usize,
    ) -> Result<Self, String> {
        if dimensions == Some(0) {
            return Err("Embedding dimensions must be greater than zero".to_string());
        }
        let timeout_secs = timeout_secs.clamp(1, 120);
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5.min(timeout_secs)))
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|err| format!("Failed to build embedding client: {err}"))?;
        Ok(Self {
            api_key,
            model: model.unwrap_or_else(|| OPENAI_DEFAULT_MODEL.to_string()),
            base_url: base_url
                .unwrap_or_else(|| OPENAI_DEFAULT_BASE_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            dimensions: dimensions.unwrap_or(OPENAI_DEFAULT_DIMS),
            client,
            max_input_chars: max_input_chars.clamp(1_024, 256_000),
        })
    }

    fn bounded(&self, text: &str) -> String {
        text.chars().take(self.max_input_chars).collect()
    }
    fn validate_vector(&self, vector: &[f32]) -> Result<(), String> {
        if vector.is_empty() || vector.len() != self.dimensions {
            return Err(format!(
                "Embedding dimension mismatch: expected {}, got {}",
                self.dimensions,
                vector.len()
            ));
        }
        if vector.iter().any(|v| !v.is_finite()) {
            return Err("Embedding contains non-finite values".into());
        }
        Ok(())
    }

    fn results_from_response(
        &self,
        data: Vec<OpenAIEmbedData>,
        expected_count: usize,
    ) -> Result<Vec<EmbeddingResult>, String> {
        if data.len() != expected_count {
            return Err(format!(
                "Embedding response count mismatch: expected {expected_count}, got {}",
                data.len()
            ));
        }

        let mut ordered = (0..expected_count).map(|_| None).collect::<Vec<_>>();
        for item in data {
            if item.index >= expected_count {
                return Err(format!(
                    "Embedding response index {} is outside the requested batch",
                    item.index
                ));
            }
            if ordered[item.index].is_some() {
                return Err(format!(
                    "Embedding response contains duplicate index {}",
                    item.index
                ));
            }
            self.validate_vector(&item.embedding)?;
            ordered[item.index] = Some(EmbeddingResult {
                dimensions: item.embedding.len(),
                source: format!(
                    "openai:{}:{}:{}",
                    self.base_url,
                    self.model,
                    item.embedding.len()
                ),
                vector: item.embedding,
                model: self.model.clone(),
            });
        }

        ordered
            .into_iter()
            .enumerate()
            .map(|(index, result)| {
                result.ok_or_else(|| format!("Embedding response is missing index {index}"))
            })
            .collect()
    }
}

#[derive(Serialize)]
pub(crate) struct OpenAIEmbedRequest {
    pub input: Vec<String>,
    pub model: String,
}

#[derive(Deserialize)]
pub(crate) struct OpenAIEmbedResponse {
    pub data: Vec<OpenAIEmbedData>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAIEmbedData {
    pub index: usize,
    pub embedding: Vec<f32>,
}

#[async_trait]
impl EmbeddingProvider for OpenAIEmbeddingProvider {
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String> {
        let url = format!("{}/embeddings", self.base_url);

        let request = OpenAIEmbedRequest {
            input: vec![self.bounded(text)],
            model: self.model.clone(),
        };

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&request)
            .send()
            .await
            .map_err(|err| format!("OpenAI embedding request failed: {}", err))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::utils::response_text_or_read_error(response).await;
            return Err(format!(
                "OpenAI embedding API returned {}: {}",
                status, body
            ));
        }

        let body: OpenAIEmbedResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse OpenAI embedding response: {}", err))?;

        self.results_from_response(body.data, 1)?
            .into_iter()
            .next()
            .ok_or_else(|| "Empty embedding response".to_string())
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        let url = format!("{}/embeddings", self.base_url);

        let request = OpenAIEmbedRequest {
            input: texts.iter().map(|text| self.bounded(text)).collect(),
            model: self.model.clone(),
        };

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&request)
            .send()
            .await
            .map_err(|err| format!("OpenAI batch embedding request failed: {}", err))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::utils::response_text_or_read_error(response).await;
            return Err(format!(
                "OpenAI embedding API returned {}: {}",
                status, body
            ));
        }

        let body: OpenAIEmbedResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse batch embedding response: {}", err))?;

        self.results_from_response(body.data, texts.len())
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn provider_name(&self) -> &str {
        "openai"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OpenAIEmbeddingProvider {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        OpenAIEmbeddingProvider::with_limits(
            "test-key".to_string(),
            Some("test-model".to_string()),
            Some("http://127.0.0.1:9876/v1/".to_string()),
            Some(3),
            20,
            1_024,
        )
        .expect("provider")
    }

    #[test]
    fn request_wire_shape_is_minimal_and_bounded() {
        let provider = provider();
        let request = OpenAIEmbedRequest {
            input: vec![provider.bounded(&"a".repeat(2_000))],
            model: provider.model.clone(),
        };
        let value = serde_json::to_value(request).expect("serialize request");

        assert_eq!(value["model"], "test-model");
        assert_eq!(value["input"][0].as_str().map(str::len), Some(1_024));
        assert_eq!(value.as_object().map(|value| value.len()), Some(2));
    }

    #[test]
    fn batch_response_is_reordered_and_source_includes_endpoint() {
        let results = provider()
            .results_from_response(
                vec![
                    OpenAIEmbedData {
                        index: 1,
                        embedding: vec![4.0, 5.0, 6.0],
                    },
                    OpenAIEmbedData {
                        index: 0,
                        embedding: vec![1.0, 2.0, 3.0],
                    },
                ],
                2,
            )
            .expect("valid response");

        assert_eq!(results[0].vector, vec![1.0, 2.0, 3.0]);
        assert_eq!(results[1].vector, vec![4.0, 5.0, 6.0]);
        assert_eq!(
            results[0].source,
            "openai:http://127.0.0.1:9876/v1:test-model:3"
        );
    }

    #[test]
    fn rejects_malformed_batch_response_and_zero_dimensions() {
        let provider = provider();
        assert!(provider
            .results_from_response(
                vec![
                    OpenAIEmbedData {
                        index: 0,
                        embedding: vec![1.0, 2.0, 3.0]
                    },
                    OpenAIEmbedData {
                        index: 0,
                        embedding: vec![4.0, 5.0, 6.0]
                    },
                ],
                2,
            )
            .is_err());
        assert!(OpenAIEmbeddingProvider::with_limits(
            String::new(),
            None,
            None,
            Some(0),
            20,
            1_024
        )
        .is_err());
    }
}
