//! Dev-only Tauri command: explicit context/cache observability snapshot.
//!
//! This complements `prompt_dump`: provider prompt cache is performance-only,
//! while this command exposes the durable context-import/cache-layout records
//! ORG2 has persisted for a session.

use serde::{Deserialize, Serialize};

use crate::core::session::context_import::{CacheLayoutStats, ContextSnapshotMeta, SessionEmbeddingState};
use crate::core::session::persistence as unified_persistence;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshotWire {
    pub snapshot_id: String,
    pub target_session_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub namespace: String,
    pub title: Option<String>,
    pub token_estimate: i64,
    pub pinned: bool,
    pub snippet: Option<String>,
    pub created_at: String,
}

impl From<ContextSnapshotMeta> for ContextSnapshotWire {
    fn from(value: ContextSnapshotMeta) -> Self {
        Self {
            snapshot_id: value.snapshot_id,
            target_session_id: value.target_session_id,
            source_kind: value.source_kind.as_str().to_string(),
            source_id: value.source_id,
            namespace: value.namespace,
            title: value.title,
            token_estimate: value.token_estimate,
            pinned: value.pinned,
            snippet: value.snippet,
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLayoutStatsWire {
    pub stable_prefix_tokens: i64,
    pub volatile_context_tokens: i64,
    pub imported_context_count: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub provider_cache_hit_rate: Option<f64>,
}

impl From<CacheLayoutStats> for CacheLayoutStatsWire {
    fn from(value: CacheLayoutStats) -> Self {
        let provider_cache_hit_rate = value.provider_cache_hit_rate();
        Self {
            stable_prefix_tokens: value.stable_prefix_tokens,
            volatile_context_tokens: value.volatile_context_tokens,
            imported_context_count: value.imported_context_count,
            cache_read_tokens: value.cache_read_tokens,
            cache_write_tokens: value.cache_write_tokens,
            provider_cache_hit_rate,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEmbeddingStateWire {
    pub namespace: String,
    pub session_id: String,
    pub work_item_id: Option<String>,
    pub last_embedded_sequence: i64,
    pub embedding_model: Option<String>,
    pub updated_at: String,
}

impl From<SessionEmbeddingState> for SessionEmbeddingStateWire {
    fn from(value: SessionEmbeddingState) -> Self {
        Self {
            namespace: value.namespace,
            session_id: value.session_id,
            work_item_id: value.work_item_id,
            last_embedded_sequence: value.last_embedded_sequence,
            embedding_model: value.embedding_model,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCacheSnapshotResult {
    pub session_id: String,
    pub snapshots: Vec<ContextSnapshotWire>,
    pub latest_cache_layout: Option<CacheLayoutStatsWire>,
    pub embedding_state: Option<SessionEmbeddingStateWire>,
}

/// Return durable explicit context-import metadata, latest cache-layout stats,
/// and proactive embedding progress for a session.
#[tauri::command]
pub async fn debug_session_context_cache_snapshot(
    session_id: String,
) -> Result<ContextCacheSnapshotResult, String> {
    let session_id_for_block = session_id.clone();
    tokio::task::spawn_blocking(move || {
        let snapshots = unified_persistence::load_context_snapshots(&session_id_for_block)
            .map_err(|err| format!("load_context_snapshots failed: {err}"))?
            .into_iter()
            .map(ContextSnapshotWire::from)
            .collect::<Vec<_>>();

        let latest_cache_layout = unified_persistence::load_latest_turn_cache_layout_stats(&session_id_for_block)
            .map_err(|err| format!("load_latest_turn_cache_layout_stats failed: {err}"))?
            .map(|(_turn_id, stats)| CacheLayoutStatsWire::from(stats));

        let embedding_namespace = format!("session:{session_id_for_block}");
        let embedding_state = unified_persistence::load_session_embedding_state(&embedding_namespace)
            .map_err(|err| format!("load_session_embedding_state failed: {err}"))?
            .map(SessionEmbeddingStateWire::from);

        Ok(ContextCacheSnapshotResult {
            session_id: session_id_for_block,
            snapshots,
            latest_cache_layout,
            embedding_state,
        })
    })
    .await
    .map_err(|err| format!("debug_session_context_cache_snapshot task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::context_import::ContextSourceKind;

    #[test]
    fn context_snapshot_wire_uses_snake_case_source_kind_and_camel_case_fields() {
        let meta = ContextSnapshotMeta::new(
            "target",
            ContextSourceKind::WorkItem,
            "WI-1",
            Some("Work item".to_string()),
            123,
            true,
        );
        let wire = ContextSnapshotWire::from(meta);
        assert_eq!(wire.source_kind, "work_item");
        assert_eq!(wire.namespace, "work_item:WI-1");
        assert_eq!(wire.token_estimate, 123);
        assert!(wire.pinned);
    }

    #[test]
    fn cache_layout_wire_includes_provider_hit_rate() {
        let wire = CacheLayoutStatsWire::from(CacheLayoutStats::new(100, 50, 2, 9, 1));
        assert_eq!(wire.stable_prefix_tokens, 100);
        assert_eq!(wire.volatile_context_tokens, 50);
        assert_eq!(wire.imported_context_count, 2);
        assert_eq!(wire.provider_cache_hit_rate, Some(0.9));
    }
}
