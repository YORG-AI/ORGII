//! Cross-session semantic recall over persisted Session Memory summaries.
//!
//! Session Memory (SM) is per-session and independent. This module adds the
//! cross-session lookup layer: every successful SM extraction is embedded into
//! `session_memory_index`, then callers can embed a query, cosine-recall the
//! nearest session summaries, and rerank them with the local Qwen3 reranker.

use crate::memory::embeddings::{cosine_similarity, AutoEmbeddingProvider, EmbeddingProvider};
use crate::session::persistence::{load_session_memory_index_rows, SessionMemoryIndexRow};

const DEFAULT_TOP_K: usize = 5;
const RERANK_RECALL_MULT: usize = 3;
const MIN_SIMILARITY: f32 = 0.20;

#[derive(Debug, Clone)]
pub struct SessionMemorySearchHit {
    pub session_id: String,
    pub content: String,
    pub score: f32,
    pub updated_at: String,
}

/// Search indexed session-memory summaries with embedding + rerank.
///
/// Best-effort fallback contract:
/// - query embedding failure => empty hits
/// - no compatible indexed embeddings => empty hits
/// - reranker failure => cosine order
pub async fn search_session_memories(query: &str, top_k: usize) -> Result<Vec<SessionMemorySearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let top_k = if top_k == 0 { DEFAULT_TOP_K } else { top_k };

    let embed_cfg = crate::state::integrations_store::integrations_store()
        .snapshot()
        .embedding;
    let provider = AutoEmbeddingProvider::new(embed_cfg.provider, embed_cfg.model);
    let query_embedding = provider.embed(query).await?;

    let rows = tokio::task::spawn_blocking(load_session_memory_index_rows)
        .await
        .map_err(|err| format!("session-memory index load task failed: {err}"))?
        .map_err(|err| format!("session-memory index load failed: {err}"))?;

    let mut scored: Vec<(SessionMemoryIndexRow, f32)> = rows
        .into_iter()
        .filter(|row| !row.embedding.is_empty())
        .filter(|row| row.embedding.len() == query_embedding.vector.len())
        .filter(|row| match row.embedding_model.as_deref() {
            Some(model) => model == query_embedding.model,
            None => true,
        })
        .map(|row| {
            let score = cosine_similarity(&query_embedding.vector, &row.embedding);
            (row, score)
        })
        .filter(|(_, score)| *score >= MIN_SIMILARITY)
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k.saturating_mul(RERANK_RECALL_MULT).max(top_k));

    if scored.is_empty() {
        return Ok(Vec::new());
    }

    let docs: Vec<String> = scored.iter().map(|(row, _)| row.content.clone()).collect();
    let reranker = crate::memory::embeddings::LocalReranker::new();
    let reranked = reranker.rerank(query, &docs, top_k).await;

    let hits = match reranked {
        Ok(order) if !order.is_empty() => order
            .into_iter()
            .filter_map(|(idx, score)| scored.get(idx).map(|(row, _)| hit_from_row(row, score)))
            .collect(),
        _ => scored
            .into_iter()
            .take(top_k)
            .map(|(row, score)| hit_from_row(&row, score))
            .collect(),
    };

    Ok(hits)
}

fn hit_from_row(row: &SessionMemoryIndexRow, score: f32) -> SessionMemorySearchHit {
    SessionMemorySearchHit {
        session_id: row.session_id.clone(),
        content: row.content.clone(),
        score,
        updated_at: row.updated_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use crate::session::persistence::{load_session_memory_index_rows, save_session_memory_index};
    use test_helpers::test_env;

    #[test]
    fn session_memory_index_roundtrips_embedding() {
        let _sandbox = test_env::sandbox();
        save_session_memory_index("sm-index-test", "# Current State\nTesting", &[0.1, 0.2, 0.3], Some("test-model"))
            .expect("save index");
        let rows = load_session_memory_index_rows().expect("load rows");
        let row = rows.into_iter().find(|r| r.session_id == "sm-index-test").expect("row exists");
        assert_eq!(row.content, "# Current State\nTesting");
        assert_eq!(row.embedding, vec![0.1, 0.2, 0.3]);
        assert_eq!(row.embedding_model.as_deref(), Some("test-model"));
    }
}
