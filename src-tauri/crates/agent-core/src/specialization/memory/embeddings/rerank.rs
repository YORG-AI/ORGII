//! Local rerank provider — Qwen3-Reranker-8B served at `http://localhost:9877`.
//!
//! Simon's setup adds a cross-encoder rerank stage on top of cosine recall:
//! cosine retrieves a coarse top-N, then the reranker reorders by semantic
//! relevance. ORG-2 upstream only had cosine; this is the added increment.
//!
//! Endpoint (OpenAI-style):
//!   POST {base_url}/v1/rerank
//!   body:  {"query": "...", "documents": ["..", ".."], "top_n": N}
//!   resp:  {"results": [{"index": 0, "relevance_score": 0.19}, ...]}
//!
//! Overridable via env `ORGII_RERANK_URL`. If the service is unreachable the
//! caller falls back to cosine order (rerank is best-effort, never fatal).

use serde::{Deserialize, Serialize};

const DEFAULT_RERANK_URL: &str = "http://localhost:9877";

#[derive(Serialize)]
struct RerankRequest<'a> {
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

/// Local cross-encoder reranker client.
pub struct LocalReranker {
    base_url: String,
    client: reqwest::Client,
}

impl LocalReranker {
    pub fn new() -> Self {
        let base_url = std::env::var("ORGII_RERANK_URL")
            .unwrap_or_else(|_| DEFAULT_RERANK_URL.to_string());
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Rerank `documents` against `query`. Returns `(original_index, score)`
    /// pairs sorted by relevance desc, truncated to `top_n`.
    ///
    /// Best-effort: on any error returns `Err` and the caller keeps the
    /// existing (cosine) order.
    pub async fn rerank(
        &self,
        query: &str,
        documents: &[String],
        top_n: usize,
    ) -> Result<Vec<(usize, f32)>, String> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/v1/rerank", self.base_url);
        let req = RerankRequest {
            query,
            documents,
            top_n,
        };
        let resp = self
            .client
            .post(&url)
            .json(&req)
            .send()
            .await
            .map_err(|err| format!("rerank request failed: {}", err))?;
        if !resp.status().is_success() {
            return Err(format!("rerank API returned {}", resp.status()));
        }
        let body: RerankResponse = resp
            .json()
            .await
            .map_err(|err| format!("failed to parse rerank response: {}", err))?;
        let mut out: Vec<(usize, f32)> = body
            .results
            .into_iter()
            .map(|r| (r.index, r.relevance_score))
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(top_n);
        Ok(out)
    }
}

impl Default for LocalReranker {
    fn default() -> Self {
        Self::new()
    }
}
