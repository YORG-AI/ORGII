use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use conversation_portability::PortableConversation;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::filesystem::PublishedFileIdentity;
use crate::semantic::NativeSemanticGroup;

pub const CODEX_SUPPORTED_VERSIONS: &[&str] = &["0.144.4", "0.144.5"];
pub const CLAUDE_CODE_SUPPORTED_VERSIONS: &[&str] = &["2.1.209", "2.1.226"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeConversationRuntime {
    ClaudeCode,
    Codex,
}

impl NativeConversationRuntime {
    pub const fn cli_agent_type(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    pub const fn profile_environment_key(self) -> &'static str {
        match self {
            Self::ClaudeCode => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeRuntimeTarget {
    ClaudeCode {
        model: String,
    },
    Codex {
        model: String,
        model_provider: String,
    },
}

impl NativeRuntimeTarget {
    pub const fn runtime(&self) -> NativeConversationRuntime {
        match self {
            Self::ClaudeCode { .. } => NativeConversationRuntime::ClaudeCode,
            Self::Codex { .. } => NativeConversationRuntime::Codex,
        }
    }
}

#[derive(Debug)]
pub struct NativeMaterializationRequest<'a> {
    pub conversation: &'a PortableConversation,
    /// A caller-generated fresh UUID. It is rejected when it equals the
    /// source native identity or collides with any target path.
    pub target_session_id: Uuid,
    pub runtime: NativeRuntimeTarget,
    pub account_id: &'a str,
    /// Exact executable selected by the existing launch-profile registry.
    pub cli_executable: &'a Path,
    /// Normalized result of the bounded `--version` probe.
    pub observed_cli_version: &'a str,
    /// Account-scoped provider profile. The materializer writes only beneath
    /// the provider's native transcript subtree.
    pub target_profile_root: &'a Path,
    /// Explicit target CWD. Source workspace metadata is never trusted here.
    pub target_workspace_root: &'a Path,
    /// ORG2-owned private root used to recover a rejected candidate after a
    /// real resume attempt. It must not be inside the provider profile.
    pub recovery_root: &'a Path,
    /// RFC3339 creation time supplied by the durable caller.
    pub created_at: &'a str,
    /// Optional source file identity used only as a same-path safety guard.
    /// No source bytes are read through this path.
    pub source_native_path: Option<&'a Path>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResumePlan {
    pub runtime: NativeConversationRuntime,
    pub account_id: String,
    pub native_session_id: String,
    pub cli_version: String,
    /// Explicit model pinned before the first real user turn. Native Codex
    /// history does not store it, so the managed launcher must apply it.
    pub model: String,
    pub model_provider: Option<String>,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub transcript_path: PathBuf,
    pub transcript_sha256_before_resume: String,
    pub transcript_bytes_before_resume: u64,
    /// Binds the local execution choice to the exact portable checkpoint,
    /// without putting recipient-specific target choices into its envelope.
    pub portable_sha256: String,
}

#[derive(Debug, Clone)]
pub struct NativeMaterializationCandidate {
    pub runtime: NativeConversationRuntime,
    pub account_id: String,
    pub native_session_id: String,
    pub target_path: PathBuf,
    pub target_profile_root: PathBuf,
    pub target_workspace_root: PathBuf,
    pub recovery_root: PathBuf,
    pub cli_version: String,
    pub native_sha256: String,
    pub portable_sha256: String,
    pub continuation_complete: bool,
    pub resume_plan: NativeResumePlan,
    pub(crate) published_identity: PublishedFileIdentity,
    pub(crate) expected_semantics: Vec<NativeSemanticGroup>,
    pub(crate) target: NativeRuntimeTarget,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeResumeObservation<'a> {
    /// Native id emitted/accepted by the managed CLI transport.
    pub observed_native_session_id: &'a str,
    /// Exact first real task string passed to the CLI. It is not synthesized
    /// or written by the materializer.
    pub first_real_user_turn: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedNativeMaterialization {
    pub runtime: NativeConversationRuntime,
    pub account_id: String,
    pub native_session_id: String,
    pub cli_version: String,
    pub model: String,
    pub model_provider: Option<String>,
    pub target_profile_root: PathBuf,
    pub target_workspace_root: PathBuf,
    pub transcript_path: PathBuf,
    pub portable_sha256: String,
    pub transcript_sha256_after_resume: String,
    pub transcript_bytes_after_resume: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedNativeMaterialization {
    pub runtime: NativeConversationRuntime,
    pub native_session_id: String,
    pub recovery_path: PathBuf,
}
