//! Context snapshot/import metadata and cache-layout observability.
//!
//! This module is intentionally small and durable-data oriented. Provider
//! prompt cache is a performance optimization only; these records describe the
//! deterministic context ORG2 selected/reconstructed before a turn.

use serde::{Deserialize, Serialize};

/// Source kind for an explicitly imported context chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSourceKind {
    Session,
    WorkItem,
    File,
    Memory,
    ImportedContext,
    GlobalPreference,
}

impl ContextSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::WorkItem => "work_item",
            Self::File => "file",
            Self::Memory => "memory",
            Self::ImportedContext => "imported_context",
            Self::GlobalPreference => "global_preference",
        }
    }
}

/// Namespace for retrieval/embedding isolation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextNamespace {
    pub kind: ContextSourceKind,
    pub id: String,
}

impl ContextNamespace {
    pub fn new(kind: ContextSourceKind, id: impl Into<String>) -> Self {
        Self { kind, id: id.into() }
    }

    pub fn global() -> Self {
        Self::new(ContextSourceKind::GlobalPreference, "global")
    }

    pub fn session(session_id: impl Into<String>) -> Self {
        Self::new(ContextSourceKind::Session, session_id)
    }

    pub fn work_item(work_item_id: impl Into<String>) -> Self {
        Self::new(ContextSourceKind::WorkItem, work_item_id)
    }

    pub fn imported_context(snapshot_id: impl Into<String>) -> Self {
        Self::new(ContextSourceKind::ImportedContext, snapshot_id)
    }

    /// Stable string form suitable for storage and filtering.
    pub fn storage_key(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.id)
    }
}

/// Metadata for one explicit context import/snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextSnapshotMeta {
    pub snapshot_id: String,
    pub target_session_id: String,
    pub source_kind: ContextSourceKind,
    pub source_id: String,
    pub namespace: String,
    pub title: Option<String>,
    pub token_estimate: i64,
    pub pinned: bool,
    pub created_at: String,
}

impl ContextSnapshotMeta {
    pub fn new(
        target_session_id: impl Into<String>,
        source_kind: ContextSourceKind,
        source_id: impl Into<String>,
        title: Option<String>,
        token_estimate: i64,
        pinned: bool,
    ) -> Self {
        let source_id = source_id.into();
        let namespace = ContextNamespace::new(source_kind.clone(), source_id.clone()).storage_key();
        Self {
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            target_session_id: target_session_id.into(),
            source_kind,
            source_id,
            namespace,
            title,
            token_estimate: token_estimate.max(0),
            pinned,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Prompt/cache layout metrics for a single turn.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheLayoutStats {
    pub stable_prefix_tokens: i64,
    pub volatile_context_tokens: i64,
    pub imported_context_count: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

impl CacheLayoutStats {
    pub fn new(
        stable_prefix_tokens: i64,
        volatile_context_tokens: i64,
        imported_context_count: i64,
        cache_read_tokens: i64,
        cache_write_tokens: i64,
    ) -> Self {
        Self {
            stable_prefix_tokens: stable_prefix_tokens.max(0),
            volatile_context_tokens: volatile_context_tokens.max(0),
            imported_context_count: imported_context_count.max(0),
            cache_read_tokens: cache_read_tokens.max(0),
            cache_write_tokens: cache_write_tokens.max(0),
        }
    }

    pub fn provider_cache_hit_rate(&self) -> Option<f64> {
        let total = self.cache_read_tokens + self.cache_write_tokens;
        (total > 0).then(|| self.cache_read_tokens as f64 / total as f64)
    }
}

/// Progress marker for proactive session embedding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionEmbeddingState {
    pub namespace: String,
    pub session_id: String,
    pub work_item_id: Option<String>,
    pub last_embedded_sequence: i64,
    pub embedding_model: Option<String>,
    pub updated_at: String,
}

impl SessionEmbeddingState {
    pub fn for_session(
        session_id: impl Into<String>,
        work_item_id: Option<String>,
        last_embedded_sequence: i64,
        embedding_model: Option<String>,
    ) -> Self {
        let session_id = session_id.into();
        Self {
            namespace: ContextNamespace::session(session_id.clone()).storage_key(),
            session_id,
            work_item_id,
            last_embedded_sequence: last_embedded_sequence.max(0),
            embedding_model,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_storage_keys_are_stable() {
        assert_eq!(ContextNamespace::global().storage_key(), "global_preference:global");
        assert_eq!(ContextNamespace::session("s1").storage_key(), "session:s1");
        assert_eq!(ContextNamespace::work_item("WI-1").storage_key(), "work_item:WI-1");
        assert_eq!(
            ContextNamespace::imported_context("snap").storage_key(),
            "imported_context:snap"
        );
    }

    #[test]
    fn snapshot_clamps_negative_token_estimates() {
        let snap = ContextSnapshotMeta::new(
            "target",
            ContextSourceKind::Session,
            "source",
            Some("Source".into()),
            -10,
            true,
        );
        assert_eq!(snap.target_session_id, "target");
        assert_eq!(snap.namespace, "session:source");
        assert_eq!(snap.token_estimate, 0);
        assert!(snap.pinned);
    }

    #[test]
    fn cache_hit_rate_uses_provider_cache_tokens_only() {
        let stats = CacheLayoutStats::new(1000, 200, 2, 75, 25);
        assert_eq!(stats.provider_cache_hit_rate(), Some(0.75));
        assert_eq!(CacheLayoutStats::default().provider_cache_hit_rate(), None);
    }

    #[test]
    fn embedding_state_is_session_namespaced() {
        let state = SessionEmbeddingState::for_session(
            "session-a",
            Some("WI-7".into()),
            42,
            Some("qwen3-rerank".into()),
        );
        assert_eq!(state.namespace, "session:session-a");
        assert_eq!(state.work_item_id.as_deref(), Some("WI-7"));
        assert_eq!(state.last_embedded_sequence, 42);
    }
}
