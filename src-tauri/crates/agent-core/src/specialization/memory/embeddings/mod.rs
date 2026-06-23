//! Embedding providers for memory retrieval.
//!
//! Supports:
//! - **OpenAI** (`text-embedding-3-small`, 1536 dims)
//! - **Azure OpenAI** (deployment-routed `text-embedding-*`, 1536 / 3072 dims)
//! - **Auto** — picks an available API provider in order
//!
mod auto;
mod azure;
mod openai;
#[allow(dead_code)]
mod rerank;

// `AutoEmbeddingProvider` is the only provider type external callers reach
// for — they construct it via `AutoEmbeddingProvider::resolve(...)`. The
// concrete `Azure` / `OpenAI` providers are only instantiated inside
// `auto.rs`, so they stay behind their submodule path.
pub use auto::AutoEmbeddingProvider;

use async_trait::async_trait;

/// Result of embedding a text.
#[derive(Debug, Clone)]
pub struct EmbeddingResult {
    /// The embedding vector.
    pub vector: Vec<f32>,
    /// Dimensionality.
    pub dimensions: usize,
    /// Model used to generate the embedding.
    pub model: String,
}

/// Trait for embedding providers.
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    /// Generate an embedding for a single text.
    async fn embed(&self, text: &str) -> Result<EmbeddingResult, String>;

    /// Generate embeddings for multiple texts (batch).
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<EmbeddingResult>, String> {
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            results.push(self.embed(text).await?);
        }
        Ok(results)
    }

    /// The dimensionality of embeddings from this provider.
    fn dimensions(&self) -> usize;

    /// Provider name for logging/metadata.
    fn provider_name(&self) -> &str;
}

/// Compute cosine similarity between two vectors.
pub fn cosine_similarity(vec_a: &[f32], vec_b: &[f32]) -> f32 {
    if vec_a.len() != vec_b.len() || vec_a.is_empty() {
        return 0.0;
    }

    let dot: f32 = vec_a
        .iter()
        .zip(vec_b.iter())
        .map(|(left, right)| left * right)
        .sum();
    let norm_a: f32 = vec_a.iter().map(|val| val * val).sum::<f32>().sqrt();
    let norm_b: f32 = vec_b.iter().map(|val| val * val).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a * norm_b)
}

pub(crate) const OPENAI_DEFAULT_DIMS: usize = 1536;

#[cfg(test)]
mod tests {
    use super::cosine_similarity;

    #[test]
    fn test_cosine_identical() {
        let vec = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&vec, &vec) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_orthogonal() {
        let vec_a = vec![1.0, 0.0];
        let vec_b = vec![0.0, 1.0];
        assert!(cosine_similarity(&vec_a, &vec_b).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_opposite() {
        let vec_a = vec![1.0, 0.0];
        let vec_b = vec![-1.0, 0.0];
        assert!((cosine_similarity(&vec_a, &vec_b) + 1.0).abs() < 1e-6);
    }
}
