//! `IntegrationsConfig` — app-level, cross-agent storage.
//!
//! the agent-definition design (§§2.2 + 3.2): the persistent home for every config field that
//! is *not* agent-intrinsic. Placement test (I-SCOPE-PURITY): "if the user
//! switches `agent_id` in this session, does this value change?" — if no,
//! the field belongs here.
//!
//! # Persistence
//!
//! Serialized at `~/.orgii/integrations.json`. Flat, single-user, no
//! inheritance chain. The single writer is [`IntegrationsStore`];
//! no other code path calls `serde_json::to_writer` on this file
//! (invariant I-SINGLE-WRITE-PATH).
//!
//! # Scope
//!
//! Exactly the fields §3.2 enumerates, minus `automation` (removed Phase
//! 65' §12 — runtime rules live in `integrations/automation/*` and its
//! own JSON file, never in this struct):
//!
//! - `channels` — Telegram / Discord / Slack / … tokens and bindings.
//! - `databases` — DB connection entries used by the DB tool.
//! - `nodes` — OS/desktop-tool node bindings.
//! - `web_search` — API key + defaults for the web-search tool.
//! - `embedding` — semantic-memory embedding engine defaults
//!   (provider, model, chunk sizes). App-level — embedding is the
//!   workspace's index engine, never per-agent.
//!
//! # Violent migration (no dual-read, no legacy fallback)
//!
//! Legacy `~/.orgii/agent-config.json` is **never read** by this module. If
//! the file exists, `load_or_default()` still returns a fresh
//! `IntegrationsConfig::default()`. The old blob is silently left on disk
//! for a human to delete after the upgrade — per §12.3, "No migration
//! function, no backwards-compat code."
//!
//! # Sub-types
//!
//! `WebSearchConfig`, `NodesConfig`, and `EmbeddingConfig` are defined inline
//! below. The L3 learnings toggles (per-agent: `enabled`,
//! `extract_memories_enabled`, `auto_dream_enabled`) live on
//! [`crate::core::definitions::schema::AgentLearningsConfig`]
//! because they are agent-intrinsic.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::core::config::DatabasesConfig;
use crate::integrations::channels::config::ChannelsConfig;
use app_paths as paths;

/// Result type for integrations IO. Errors bubble up to the caller so they
/// can surface them as Tauri / HTTP errors — never swallow.
pub type IntegrationsResult<T> = Result<T, IntegrationsError>;

#[derive(Debug, thiserror::Error)]
pub enum IntegrationsError {
    #[error("integrations.json read failed: {0}")]
    Read(#[source] std::io::Error),
    #[error("integrations.json parse failed: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("integrations.json write failed: {0}")]
    Write(#[source] std::io::Error),
    #[error("integrations.json serialise failed: {0}")]
    Serialize(#[source] serde_json::Error),
}

/// The on-disk shape of `~/.orgii/integrations.json`. Every field has a
/// reasonable `Default` so `load_or_default()` on a missing file returns
/// a fully-populated struct without any special-casing at read sites.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct IntegrationsConfig {
    #[serde(default)]
    pub channels: ChannelsConfig,

    #[serde(default)]
    pub databases: DatabasesConfig,

    #[serde(default)]
    pub nodes: NodesConfig,

    #[serde(default)]
    pub web_search: WebSearchConfig,

    /// MCP registry integration (Smithery key etc). App-level because
    /// the Smithery key is a machine-scoped credential shared by every
    /// agent that wants to install MCP servers.
    #[serde(default)]
    pub mcp: SmitheryConfig,

    /// Semantic-memory embedding engine defaults.
    ///
    /// App-level per I-SCOPE-PURITY: the embedding engine is a workspace
    /// index, not agent behaviour. Switching `agent_id` does not change
    /// which embedding model the index uses.
    #[serde(default)]
    pub embedding: EmbeddingConfig,

    /// Globally excluded skills (by name). App-level: a skill excluded in
    /// the Extensions hub is off for EVERY agent. Per-agent deltas live on
    /// `AgentDefinition.skills_config.exclude`. The effective excluded set
    /// for a session is the union of both. Replaces the old behavior where
    /// the Extensions toggle silently wrote `builtin:os`'s overlay.
    ///
    /// On-disk JSON key remains `"disabled_skills"` to keep existing
    /// `~/.orgii/integrations.json` files readable without migration.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        rename = "disabled_skills"
    )]
    pub excluded_skills: Vec<String>,
}

impl IntegrationsConfig {
    /// Load from `~/.orgii/integrations.json`. If the file does not exist,
    /// return `IntegrationsConfig::default()` without creating it — a
    /// subsequent `save()` (triggered by an explicit `integrations_update`
    /// RPC) is what actually writes the file.
    pub fn load_or_default() -> IntegrationsResult<Self> {
        Self::load_from(&paths::integrations())
    }

    /// Load from an explicit path. Factored out of `load_or_default` so
    /// tests can round-trip against a `tempfile::NamedTempFile` without
    /// touching the real `~/.orgii` directory.
    pub fn load_from(path: &Path) -> IntegrationsResult<Self> {
        match std::fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content).map_err(IntegrationsError::Parse),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(IntegrationsError::Read(err)),
        }
    }

    /// Persist to `~/.orgii/integrations.json`, creating the parent
    /// directory if missing. Pretty-printed for human-inspectability;
    /// this is not a hot path.
    pub fn save(&self) -> IntegrationsResult<()> {
        self.save_to(&paths::integrations())
    }

    /// Persist to an explicit path. Same split-for-testability rationale
    /// as `load_from`.
    ///
    /// P5 防呆 / config 改前备份: before overwriting an existing
    /// `integrations.json` (channels, credentials, embedding — the most
    /// destructive config to lose), snapshot it to a timestamped
    /// `integrations.json.bak-<unix_secs>` (best-effort, never blocks the
    /// write) and write the new payload atomically via a temp-file rename so
    /// a crash mid-write can't truncate the live file. `IntegrationsStore`
    /// already gates against persisting over a corrupt boot-time file; this
    /// adds crash-safety + a recovery trail on top.
    pub fn save_to(&self, path: &Path) -> IntegrationsResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(IntegrationsError::Write)?;
        }
        let payload = serde_json::to_string_pretty(self).map_err(IntegrationsError::Serialize)?;

        // 1. Best-effort backup of the existing file.
        if path.exists() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let mut backup = path.to_path_buf();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("integrations.json");
            backup.set_file_name(format!("{name}.bak-{stamp}"));
            if let Err(err) = std::fs::copy(path, &backup) {
                tracing::warn!(
                    "[integrations] failed to back up {} before write: {err}",
                    path.display()
                );
            }
        }

        // 2. Atomic write: temp file + rename (atomic on same filesystem).
        let mut tmp = path.to_path_buf();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("integrations.json");
        tmp.set_file_name(format!("{name}.tmp"));
        std::fs::write(&tmp, &payload).map_err(IntegrationsError::Write)?;
        std::fs::rename(&tmp, path).map_err(|err| {
            let _ = std::fs::remove_file(&tmp);
            IntegrationsError::Write(err)
        })
    }
}

// ============================================================================
// Sub-types (relocated from the retired `core/config/agent.rs`)
// ============================================================================

/// Web search tool configuration. Per-call result counts come from the
/// LLM tool args (`count`, clamp 1–10, default 5); only the API key is
/// persisted here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    #[serde(default)]
    pub api_key: String,
}

/// Remote node management configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodesConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
}

/// MCP (Model Context Protocol) integration configuration.
///
/// RPC contract §13: hosts cross-cutting MCP settings that the frontend
/// previously stored under a free-form `tools.mcpSmithery` blob on the
/// legacy `agent-config.json`. Smithery is one MCP registry provider;
/// adding more providers (GitHub MCP Hub, self-hosted) would become
/// additional typed fields on this struct rather than free-form JSON.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmitheryConfig {
    /// Smithery.ai API key used to resolve and install MCP servers from
    /// the Smithery registry. Empty string means "no key configured".
    #[serde(default)]
    pub smithery_api_key: String,
}

/// Controls how coding tool calls are dispatched.
///
/// Agent-intrinsic (per-`AgentDefinition`): coding agents run `Direct`,
/// Work-Station agents run `WorkStation`. Co-located here so every
/// sub-config type shares a single home and every consumer
/// (`AgentDefinition`, `ResolvedAgent`, `dispatch.rs`, `tools/registration`)
/// imports from one place.
///
/// - `Direct`: run in the Rust backend (default).
/// - `WorkStation`: forward to the frontend Workstation runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// Run tools directly in the Rust backend (default).
    #[default]
    Direct,
    /// Forward tool calls to the frontend Workstation runtime.
    WorkStation,
}

/// Semantic-memory embedding engine configuration.
///
/// App-level (per I-SCOPE-PURITY): embedding choice is a workspace index
/// concern, not agent behaviour. Lives on `IntegrationsConfig.embedding`
/// and is consumed by:
/// - `specialization::memory::embeddings::AutoEmbeddingProvider` (provider
///   resolution), and
/// - `specialization::memory::consolidation` (recall mode probe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    /// `local_qwen`, `embedding_api`, or `disabled`. `auto` is retained for
    /// compatibility and resolves to a safe local provider only.
    #[serde(default = "default_embedding_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    /// OpenAI-compatible local endpoint (used by local_qwen).
    #[serde(default)]
    pub local_base_url: Option<String>,
    /// Expected vector size; responses with a different size are rejected.
    #[serde(default)]
    pub dimensions: Option<usize>,
    /// Minimum token growth between session-memory embeddings.
    #[serde(default = "default_embedding_min_token_delta")]
    pub min_token_delta: usize,
    /// Minimum wall-clock interval between embeddings for one session.
    #[serde(default = "default_embedding_min_interval_secs")]
    pub min_interval_secs: u64,
    /// Request timeout for local or remote embedding calls.
    #[serde(default = "default_embedding_timeout_secs")]
    pub request_timeout_secs: u64,
    /// Maximum UTF-8 characters sent for one session-memory embedding.
    #[serde(default = "default_embedding_max_input_chars")]
    pub max_input_chars: usize,
}

fn default_embedding_provider() -> String {
    "embedding_api".to_string()
}
fn default_embedding_min_token_delta() -> usize {
    5_000
}
fn default_embedding_min_interval_secs() -> u64 {
    300
}
fn default_embedding_timeout_secs() -> u64 {
    20
}
fn default_embedding_max_input_chars() -> usize {
    48_000
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: default_embedding_provider(),
            model: None,
            local_base_url: None,
            dimensions: None,
            min_token_delta: default_embedding_min_token_delta(),
            min_interval_secs: default_embedding_min_interval_secs(),
            request_timeout_secs: default_embedding_timeout_secs(),
            max_input_chars: default_embedding_max_input_chars(),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_default() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("integrations.json");
        assert!(!path.exists());

        let cfg = IntegrationsConfig::load_from(&path).expect("load ok");
        // default channel map is empty; prove the value round-trips as default.
        let json = serde_json::to_string(&cfg).expect("serialize");
        assert!(json.contains("\"channels\""));
    }

    #[test]
    fn embedding_defaults_are_bounded_and_disabled() {
        let cfg = EmbeddingConfig::default();
        assert_eq!(cfg.provider, "disabled");
        assert_eq!(cfg.local_base_url, None);
        assert_eq!(cfg.dimensions, None);
        assert_eq!(cfg.request_timeout_secs, 20);
        assert!(cfg.max_input_chars <= 48_000);
        assert!(cfg.min_interval_secs >= 300);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("subdir").join("integrations.json");

        let mut cfg = IntegrationsConfig::default();
        cfg.web_search.api_key = "test-key".into();
        cfg.save_to(&path).expect("save");

        let reloaded = IntegrationsConfig::load_from(&path).expect("reload");
        assert_eq!(reloaded.web_search.api_key, "test-key");
    }

    #[test]
    fn corrupt_json_errors_cleanly() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("integrations.json");
        std::fs::write(&path, "{ not json").unwrap();

        let err = IntegrationsConfig::load_from(&path).unwrap_err();
        assert!(matches!(err, IntegrationsError::Parse(_)));
    }
}
