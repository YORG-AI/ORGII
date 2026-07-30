//! Config-driven rerank transport for semantic memory.
//!
//! Provider selection is exact. `zenmux_api` sends the ZenMux wire shape to
//! `{base}/rerank`, `local` sends the local shape to `{base}/v1/rerank`, and
//! `disabled` means callers intentionally retain cosine order. An enabled
//! provider never falls back to a different transport.

use std::cmp::Ordering;
use std::time::Duration;

use key_vault::key_store::{HealthStatus, ModelKey, ModelType, KEY_SERVICE};
use serde::{Deserialize, Serialize};

use crate::integrations::config::RerankConfig;

const DEFAULT_ZENMUX_BASE_URL: &str = "https://zenmux.ai/api/v1";
const DEFAULT_LOCAL_BASE_URL: &str = "http://localhost:9877";

#[derive(Serialize)]
struct ZenmuxRerankRequest<'a> {
    model: &'a str,
    input: ZenmuxRerankInput<'a>,
    parameters: ZenmuxRerankParameters,
}

#[derive(Serialize)]
struct ZenmuxRerankInput<'a> {
    query: &'a str,
    documents: &'a [String],
}

#[derive(Serialize)]
struct ZenmuxRerankParameters {
    top_n: usize,
    return_documents: bool,
}

#[derive(Serialize)]
struct LocalRerankRequest<'a> {
    query: &'a str,
    documents: &'a [String],
    top_n: usize,
}

#[derive(Deserialize)]
struct RerankResponse {
    results: Vec<RerankItem>,
}

#[derive(Deserialize)]
struct RerankItem {
    index: usize,
    relevance_score: f32,
}

enum RerankTransport {
    Disabled,
    Zenmux {
        endpoint: String,
        model: String,
        api_key: String,
    },
    Local {
        endpoint: String,
    },
}

/// Configured cross-encoder reranker.
pub struct ConfiguredReranker {
    transport: RerankTransport,
    client: reqwest::Client,
}

impl ConfiguredReranker {
    /// Resolve an exact provider from integrations configuration.
    pub fn from_config(config: RerankConfig) -> Result<Self, String> {
        let timeout_secs = config.request_timeout_secs.clamp(1, 120);
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(timeout_secs.min(5)))
            .timeout(Duration::from_secs(timeout_secs))
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|err| format!("failed to create rerank HTTP client: {err}"))?;

        let transport = match config.provider.as_str() {
            "disabled" => RerankTransport::Disabled,
            "local" => RerankTransport::Local {
                endpoint: local_endpoint(config.base_url.as_deref()),
            },
            "zenmux_api" => {
                let model = config
                    .model
                    .as_deref()
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .ok_or_else(|| "ZenMux rerank model is not configured".to_string())?
                    .to_string();
                let key = select_validated_zenmux_key(&model).ok_or_else(|| {
                    "no enabled ZenMux credential with valid health".to_string()
                })?;
                let api_key = key
                    .api_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "selected ZenMux credential has no key material".to_string())?
                    .to_string();
                let base_url = config
                    .base_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                    .or_else(|| {
                        key.base_url
                            .as_deref()
                            .map(str::trim)
                            .filter(|url| !url.is_empty())
                    })
                    .unwrap_or(DEFAULT_ZENMUX_BASE_URL);
                RerankTransport::Zenmux {
                    endpoint: append_endpoint(base_url, "rerank"),
                    model,
                    api_key,
                }
            }
            unknown => return Err(format!("unsupported rerank provider '{unknown}'")),
        };

        Ok(Self { transport, client })
    }

    /// Whether configuration explicitly selected cosine-only behavior.
    pub fn is_disabled(&self) -> bool {
        matches!(self.transport, RerankTransport::Disabled)
    }

    /// Rerank documents and return `(original_index, score)` sorted by score.
    pub async fn rerank(
        &self,
        query: &str,
        documents: &[String],
        top_n: usize,
    ) -> Result<Vec<(usize, f32)>, String> {
        if self.is_disabled() {
            return Err(
                "rerank is disabled; cosine-only behavior must be selected by the caller"
                    .to_string(),
            );
        }
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        let top_n = top_n.min(documents.len());
        if top_n == 0 {
            return Ok(Vec::new());
        }

        let request = match &self.transport {
            RerankTransport::Zenmux {
                endpoint,
                model,
                api_key,
            } => self
                .client
                .post(endpoint)
                .bearer_auth(api_key)
                .json(&ZenmuxRerankRequest {
                    model,
                    input: ZenmuxRerankInput { query, documents },
                    parameters: ZenmuxRerankParameters {
                        top_n,
                        return_documents: true,
                    },
                }),
            RerankTransport::Local { endpoint } => {
                self.client.post(endpoint).json(&LocalRerankRequest {
                    query,
                    documents,
                    top_n,
                })
            }
            RerankTransport::Disabled => {
                return Err(
                    "rerank is disabled; cosine-only behavior must be selected by the caller"
                        .to_string(),
                );
            }
        };

        let response = request
            .send()
            .await
            .map_err(|err| format!("rerank request failed: {err}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("rerank service returned HTTP {status}"));
        }
        let body: RerankResponse = response
            .json()
            .await
            .map_err(|err| format!("malformed rerank response: {err}"))?;
        validate_and_sort(body.results, documents.len(), top_n)
    }

    #[cfg(test)]
    fn for_test(transport: RerankTransport) -> Self {
        Self {
            transport,
            client: reqwest::Client::new(),
        }
    }
}

fn validate_and_sort(
    results: Vec<RerankItem>,
    document_count: usize,
    top_n: usize,
) -> Result<Vec<(usize, f32)>, String> {
    if results.is_empty() {
        return Err("rerank response contained no results".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut ranked = Vec::with_capacity(results.len().min(top_n));
    for item in results {
        if item.index >= document_count {
            return Err(format!(
                "rerank response index {} is outside {} documents",
                item.index, document_count
            ));
        }
        if !item.relevance_score.is_finite() {
            return Err("rerank response contained a non-finite score".to_string());
        }
        if !seen.insert(item.index) {
            return Err(format!(
                "rerank response contained duplicate index {}",
                item.index
            ));
        }
        ranked.push((item.index, item.relevance_score));
    }
    ranked.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
    ranked.truncate(top_n);
    Ok(ranked)
}

fn append_endpoint(base_url: &str, endpoint: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), endpoint)
}

fn local_endpoint(base_url: Option<&str>) -> String {
    let base_url = base_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(DEFAULT_LOCAL_BASE_URL);
    if base_url.trim_end_matches('/').ends_with("/v1") {
        append_endpoint(base_url, "rerank")
    } else {
        append_endpoint(base_url, "v1/rerank")
    }
}

fn select_validated_zenmux_key(model: &str) -> Option<ModelKey> {
    // Validation is persistent: once a key was validated (health Valid) it
    // stays eligible with no freshness window. Demotion happens only via
    // call-time auth failures (auto.rs) or explicit re-validation in the UI.
    let mut keys: Vec<ModelKey> = KEY_SERVICE
        .get_all_keys_for_agent(&ModelType::ZenmuxApi)
        .into_iter()
        .filter(|key| {
            key.enabled
                && key.health_status == HealthStatus::Valid
                && key
                    .api_key
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
        })
        .collect();

    keys.sort_by(|left, right| {
        let left_model_match = key_supports_model(left, model);
        let right_model_match = key_supports_model(right, model);
        right_model_match
            .cmp(&left_model_match)
            .then_with(|| right.last_validated_at.cmp(&left.last_validated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    keys.into_iter().next()
}

fn key_supports_model(key: &ModelKey, model: &str) -> bool {
    key.enabled_models
        .iter()
        .any(|candidate| candidate == model)
        || key
            .enabled_models
            .iter()
            .any(|candidate| candidate.to_ascii_lowercase().contains("rerank"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::{ConfiguredReranker, RerankTransport};
    use crate::test_support::install_crypto_provider_for_tests;

    #[tokio::test]
    async fn zenmux_uses_exact_wire_shape_and_sorts_response() {
        install_crypto_provider_for_tests();
        let server = MockServer::start().await;
        let documents = vec!["alpha".to_string(), "beta".to_string()];
        Mock::given(method("POST"))
            .and(path("/api/v1/rerank"))
            .and(header("authorization", "Bearer test-secret"))
            .and(body_json(json!({
                "model": "qwen/qwen3-vl-rerank",
                "input": {"query": "question", "documents": documents},
                "parameters": {"top_n": 2, "return_documents": true}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [
                    {"index": 0, "relevance_score": 0.2},
                    {"index": 1, "relevance_score": 0.9}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let reranker = ConfiguredReranker::for_test(RerankTransport::Zenmux {
            endpoint: format!("{}/api/v1/rerank", server.uri()),
            model: "qwen/qwen3-vl-rerank".to_string(),
            api_key: "test-secret".to_string(),
        });
        let ranked = reranker
            .rerank("question", &documents, 2)
            .await
            .expect("ZenMux response should rerank");

        assert_eq!(ranked, vec![(1, 0.9), (0, 0.2)]);
        server.verify().await;
    }

    #[tokio::test]
    async fn local_uses_explicit_v1_shape_without_auth_or_model() {
        install_crypto_provider_for_tests();
        let server = MockServer::start().await;
        let documents = vec!["alpha".to_string(), "beta".to_string()];
        Mock::given(method("POST"))
            .and(path("/v1/rerank"))
            .and(body_json(json!({
                "query": "question",
                "documents": documents,
                "top_n": 1
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{"index": 1, "relevance_score": 0.9}]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let reranker = ConfiguredReranker::for_test(RerankTransport::Local {
            endpoint: format!("{}/v1/rerank", server.uri()),
        });
        assert_eq!(
            reranker.rerank("question", &documents, 1).await.unwrap(),
            vec![(1, 0.9)]
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn zenmux_failure_never_calls_local_transport() {
        install_crypto_provider_for_tests();
        let zenmux = MockServer::start().await;
        let local = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rerank"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&zenmux)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/rerank"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&local)
            .await;

        let reranker = ConfiguredReranker::for_test(RerankTransport::Zenmux {
            endpoint: format!("{}/rerank", zenmux.uri()),
            model: "qwen/qwen3-vl-rerank".to_string(),
            api_key: "test-secret".to_string(),
        });
        let error = reranker
            .rerank("question", &["alpha".to_string()], 1)
            .await
            .expect_err("ZenMux failure must surface");

        assert!(error.contains("503"));
        zenmux.verify().await;
        local.verify().await;
    }

    #[test]
    fn malformed_and_empty_responses_are_errors() {
        assert!(super::validate_and_sort(Vec::new(), 2, 2).is_err());
        assert!(super::validate_and_sort(
            vec![super::RerankItem {
                index: 2,
                relevance_score: 0.5,
            }],
            2,
            2,
        )
        .is_err());
    }
}
