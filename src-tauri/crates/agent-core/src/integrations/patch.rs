//! Typed patch shape for [`IntegrationsConfig`].
//!
//! Agent patch contract §11.9 + §13. Companion of `core::definitions::patch` — every
//! sub-block (channels, databases, nodes, web_search) can be
//! updated independently with replace-per-field semantics.
//!
//! See `core::definitions::patch` for the full rationale; the trade-off
//! is the same (no deep merge, callers read → mutate → write sub-struct
//! wholesale).

use serde::{Deserialize, Serialize};

use super::channels::config::ChannelsConfig;
use super::config::{
    EmbeddingConfig, IntegrationsConfig, NodesConfig, SmitheryConfig, WebSearchConfig,
};
use crate::core::config::DatabasesConfig;

/// Typed patch for [`IntegrationsConfig`]. Each field is `Option<T>`:
/// `None` leaves the target alone; `Some(value)` replaces the
/// corresponding sub-struct wholesale.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationsConfigPatch {
    pub channels: Option<ChannelsConfig>,
    pub databases: Option<DatabasesConfig>,
    pub nodes: Option<NodesConfig>,
    pub web_search: Option<WebSearchConfig>,
    pub mcp: Option<SmitheryConfig>,
    /// Semantic-memory embedding engine configuration (provider, model,
    /// chunk sizes). Wholesale replace — frontend must send the full
    /// `EmbeddingConfig` to avoid resetting siblings.
    pub embedding: Option<EmbeddingConfig>,
    /// Globally excluded skills. Wholesale replace of the full list.
    /// Wire shape stays `disabledSkills` for FE compatibility.
    #[serde(rename = "disabledSkills")]
    pub excluded_skills: Option<Vec<String>>,
}

impl IntegrationsConfigPatch {
    /// Apply the patch to `target` in place. Callers that need the new
    /// on-disk state should run this inside `IntegrationsStore::update`.
    pub fn apply(self, target: &mut IntegrationsConfig) {
        if let Some(v) = self.channels {
            target.channels = v;
        }
        if let Some(v) = self.databases {
            target.databases = v;
        }
        if let Some(v) = self.nodes {
            target.nodes = v;
        }
        if let Some(v) = self.web_search {
            target.web_search = v;
        }
        if let Some(v) = self.mcp {
            target.mcp = v;
        }
        if let Some(v) = self.embedding {
            target.embedding = v;
        }
        if let Some(v) = self.excluded_skills {
            target.excluded_skills = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_patch_leaves_target_unchanged() {
        let mut target = IntegrationsConfig::default();
        target.web_search.api_key = "unchanged".into();

        IntegrationsConfigPatch::default().apply(&mut target);

        assert_eq!(target.web_search.api_key, "unchanged");
    }

    #[test]
    fn patch_deserialises_camel_case() {
        // The unknown `maxResults` key proves serde tolerates legacy
        // payloads while still binding `apiKey` correctly.
        let patch: IntegrationsConfigPatch =
            serde_json::from_str(r#"{"webSearch":{"apiKey":"k","maxResults":10}}"#)
                .expect("camelCase decodes");
        let ws = patch.web_search.as_ref().unwrap();
        assert_eq!(ws.api_key, "k");
    }

    #[test]
    fn patch_replaces_embedding_wholesale() {
        let mut target = IntegrationsConfig::default();
        target.embedding.provider = "old".into();

        let new_embedding = EmbeddingConfig {
            provider: "openai".into(),
            model: Some("text-embedding-3-large".into()),
            ..EmbeddingConfig::default()
        };

        let patch = IntegrationsConfigPatch {
            embedding: Some(new_embedding),
            ..Default::default()
        };
        patch.apply(&mut target);

        assert_eq!(target.embedding.provider, "openai");
        assert_eq!(
            target.embedding.model.as_deref(),
            Some("text-embedding-3-large")
        );
    }

    #[test]
    fn embedding_patch_deserialises_camel_case() {
        let patch: IntegrationsConfigPatch =
            serde_json::from_str(r#"{"embedding":{"provider":"local","model":"bge-m3"}}"#)
                .expect("camelCase decodes");
        let emb = patch.embedding.as_ref().unwrap();
        assert_eq!(emb.provider, "local");
        assert_eq!(emb.model.as_deref(), Some("bge-m3"));
    }
}
