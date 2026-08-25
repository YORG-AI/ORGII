use serde::{Deserialize, Serialize};

/// Maximum retained episode metadata per executor/root pair.
///
/// The active and candidate episodes are always retained. The remaining
/// slots contain the most recently finalized lineage nodes. Runner registry
/// rows have their own lifecycle and are not removed by this bound.
pub const MAX_CONVERSATION_EXECUTION_EPISODES: usize = 16;

pub const MAX_RUNNER_PAGE_SIZE: i64 = 500;
pub const MAX_RUNNER_CLEANUP_CANDIDATES: i64 = 500;
pub const MAX_LEGACY_RUNNER_IMPORTS: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationExecutionEpisodeState {
    Prepared,
    Materializing,
    Active,
    Retired,
    Failed,
}

impl ConversationExecutionEpisodeState {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Materializing => "materializing",
            Self::Active => "active",
            Self::Retired => "retired",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "materializing" => Ok(Self::Materializing),
            "active" => Ok(Self::Active),
            "retired" => Ok(Self::Retired),
            "failed" => Ok(Self::Failed),
            other => Err(format!(
                "invalid conversation execution episode state: {other}"
            )),
        }
    }

    pub(crate) const fn is_candidate(self) -> bool {
        matches!(self, Self::Prepared | Self::Materializing)
    }

    pub(crate) const fn is_final(self) -> bool {
        matches!(self, Self::Retired | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationExecutionFinalState {
    Retired,
    Failed,
}

impl ConversationExecutionFinalState {
    pub(crate) const fn episode_state(self) -> ConversationExecutionEpisodeState {
        match self {
            Self::Retired => ConversationExecutionEpisodeState::Retired,
            Self::Failed => ConversationExecutionEpisodeState::Failed,
        }
    }
}

/// Provider- and trigger-neutral local execution identity.
///
/// `conversation_root_key` is the canonical source root (not a Work Item,
/// Cloud row, or transport session id). `executor_scope` identifies the local
/// principal/partition executing it. Runtime/model/workspace belong to an
/// episode and therefore never participate in this key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionKey {
    pub executor_scope: String,
    pub conversation_root_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionRecord {
    pub executor_scope: String,
    pub conversation_root_key: String,
    pub active_episode_id: Option<String>,
    pub candidate_episode_id: Option<String>,
    pub revision: i64,
    pub updated_at: String,
}

/// Exact source prefix incorporated into one native episode.
///
/// There is deliberately no `-1`/"not loaded" sentinel. An empty source is
/// `source_event_count = 0`; checkpoint id/hash are either both present or
/// both absent. Adapters keep their remote/transport cursors outside this
/// provider-neutral state machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSourceCheckpoint {
    pub source_checkpoint_id: Option<String>,
    pub source_checkpoint_sha256: Option<String>,
    pub source_event_count: i64,
    pub source_tip_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRuntimeProfile {
    /// Stable adapter category such as `agent` or `cli`; intentionally open
    /// ended so adding another runtime does not silently fall into a default.
    pub runtime_category: String,
    /// Category-owned runtime identifier (agent engine, CLI platform, etc.).
    pub runtime_id: String,
    pub agent_id: Option<String>,
    pub account_id: Option<String>,
    pub model_id: Option<String>,
    /// Explicit, adapter-owned locator needed to reopen the authorized local
    /// workspace after restart. It is never inferred from a stale UI cache.
    pub workspace_locator: Option<String>,
    pub workspace_fingerprint: Option<String>,
    /// Canonical non-secret digest/value over every launch-relevant choice.
    pub execution_profile_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionEpisode {
    pub executor_scope: String,
    pub conversation_root_key: String,
    pub episode_id: String,
    /// Globally unique ORG2-managed plumbing session. This, rather than a
    /// provider UUID, is the global runner-registry identity.
    pub runner_session_id: String,
    /// Provider-native id scoped by the pinned runtime/profile. The same UUID
    /// may validly appear under two different runtime profiles.
    pub native_session_id: String,
    pub state: ConversationExecutionEpisodeState,
    #[serde(flatten)]
    pub source: ConversationSourceCheckpoint,
    #[serde(flatten)]
    pub runtime: ConversationRuntimeProfile,
    pub bootstrap_intent_id: String,
    /// Hash of the provider-neutral transcript obtained by independently
    /// reparsing the newly published native session. Present before activation.
    pub verified_materialization_sha256: Option<String>,
    /// Durable adapter receipt proving the bootstrap/first real turn was
    /// accepted. Activation requires both this and independent reparse proof.
    pub activation_receipt_id: Option<String>,
    pub supersedes_episode_id: Option<String>,
    pub roll_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionSnapshot {
    pub execution: ConversationExecutionRecord,
    pub episodes: Vec<ConversationExecutionEpisode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionMutationResult {
    pub applied: bool,
    pub snapshot: ConversationExecutionSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionPrepareCandidateRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub episode_id: String,
    pub runner_session_id: String,
    pub native_session_id: String,
    pub bootstrap_intent_id: String,
    #[serde(flatten)]
    pub source: ConversationSourceCheckpoint,
    #[serde(flatten)]
    pub runtime: ConversationRuntimeProfile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionBeginMaterializationRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub expected_candidate_episode_id: String,
    pub runner_session_id: String,
    pub native_session_id: String,
    pub bootstrap_intent_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionActivateCandidateRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub expected_active_episode_id: Option<String>,
    pub expected_candidate_episode_id: String,
    pub runner_session_id: String,
    pub native_session_id: String,
    pub bootstrap_intent_id: String,
    pub verified_materialization_sha256: String,
    pub activation_receipt_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionAbortCandidateRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub expected_candidate_episode_id: String,
    pub runner_session_id: String,
    pub final_state: ConversationExecutionFinalState,
    pub roll_reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionAdvanceCheckpointRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub episode_id: String,
    pub runner_session_id: String,
    #[serde(flatten)]
    pub source: ConversationSourceCheckpoint,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionRetireActiveRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub expected_revision: i64,
    pub expected_active_episode_id: String,
    pub runner_session_id: String,
    pub final_state: ConversationExecutionFinalState,
    pub roll_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerRegistration {
    pub runner_session_id: String,
    pub executor_scope: String,
    pub conversation_root_key: String,
    pub episode_id: String,
    pub terminal: bool,
    pub registered_at: String,
    pub terminal_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerMutationResult {
    pub applied: bool,
    pub registration: Option<ConversationRunnerRegistration>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerIdentityRequest {
    pub runner_session_id: String,
    pub executor_scope: String,
    pub conversation_root_key: String,
    pub episode_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerPageRequest {
    pub after_runner_session_id: Option<String>,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerPage {
    pub runner_session_ids: Vec<String>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunnerCleanupCandidatesRequest {
    pub terminal_before: String,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConversationRunnerImport {
    pub runner_session_id: String,
    pub episode_id: String,
    pub terminal: bool,
}

/// Lossless compatibility import for the old localStorage registry only.
///
/// Old continuation cursors were Cloud-plane sequence numbers and cannot be
/// converted into exact source checkpoints. Consequently this request has no
/// episode/pointer/cursor fields: unpublished drafts and active continuation
/// state are intentionally never guessed into the new state machine.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecutionImportLegacyRunnersRequest {
    #[serde(flatten)]
    pub key: ConversationExecutionKey,
    pub runners: Vec<LegacyConversationRunnerImport>,
}
