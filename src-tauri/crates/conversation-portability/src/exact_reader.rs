use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

use crate::{
    PortableConversation, PortableConversationSource, PortableEvent, PortableLossManifest,
    PORTABLE_CONVERSATION_SCHEMA, PORTABLE_CONVERSATION_VERSION,
};

/// A source snapshot that is eligible for the exact-visible export path.
///
/// Implementations must compute the digest while parsing the same bytes from
/// one open file handle, or while holding the same database read transaction
/// over a deterministic row stream. Hash-then-reopen and metadata-before-open
/// observations do not satisfy the contract. The resulting observation is
/// carried by `source.source_snapshot`. Implementations must
/// report truncation, skipped records, unterminated tails, unknown roles, and
/// provider caps as typed failures or blocking loss; a textual marker such as
/// `...[truncated]` is data and must never be used as proof of truncation.
/// Required system/developer context, compaction summaries, tool linkage, and
/// attachment bytes are part of this contract. Mutable URLs are references,
/// not captured attachment content.
#[derive(Debug, Clone)]
pub struct ExactReadOutcome {
    pub source: PortableConversationSource,
    /// Provider-neutral events built directly from the authoritative source
    /// snapshot. Exact adapters must not route through display projections,
    /// preview windows, or normalized `ActivityChunk` data.
    pub events: Vec<PortableEvent>,
    /// Source-reader losses observed while decoding the provider transcript.
    /// This is the authoritative export capability: `is_exact_visible()`
    /// describes visible fidelity, while `is_continuation_materializable()`
    /// additionally rejects missing context required for continuation.
    /// Private reasoning and opaque lifecycle loss may be context-degrading;
    /// visible text, tool content/linkage, attachment, role, compaction, or
    /// system/developer-context loss must be blocking on the relevant axis.
    pub reader_loss_manifest: PortableLossManifest,
}

impl ExactReadOutcome {
    /// Finish an exact read at the provider-neutral boundary.
    ///
    /// This validates both the typed loss report and the complete portable
    /// conversation. In particular, an adapter cannot call itself exact after
    /// silently dropping visible or continuation-critical source records.
    pub fn finalize(self) -> Result<PortableConversation, ExactReadError> {
        self.reader_loss_manifest
            .validate()
            .map_err(ExactReadError::invalid_output)?;
        if !self.reader_loss_manifest.is_continuation_materializable() {
            return Err(ExactReadError::new(
                ExactReadFailureKind::BlockingLoss,
                "Exact source reader reported blocking conversation loss",
            ));
        }
        let conversation = PortableConversation {
            schema: PORTABLE_CONVERSATION_SCHEMA.to_string(),
            schema_version: PORTABLE_CONVERSATION_VERSION,
            source: self.source,
            events: self.events,
            loss_manifest: self.reader_loss_manifest,
        };
        conversation
            .require_materializable_continuation()
            .map_err(ExactReadError::invalid_output)?;
        // Enforce the serialized limit at the producing boundary. Consumers
        // may impose a stricter bound, but no producer may truncate to fit.
        conversation
            .encode_canonical()
            .map_err(ExactReadError::invalid_output)?;
        Ok(conversation)
    }
}

/// Contract for future source adapters. The leaf crate intentionally ships no
/// provider implementation until that provider can prove the exact snapshot
/// and fidelity requirements above.
pub trait ExactConversationReader {
    fn read_exact_visible(
        &self,
        source_session_id: &str,
    ) -> Result<ExactReadOutcome, ExactReadError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExactReadFailureKind {
    AttachmentUnavailable,
    BlockingLoss,
    EncryptedContext,
    InvalidConversationGraph,
    InvalidSourceIdentity,
    InvalidSourcePath,
    InvalidToolLinkage,
    MalformedRecord,
    RecordLimit,
    SourceChanged,
    VisibleContentTruncated,
    ToolContentTruncated,
    RecordSkipped,
    UnterminatedTail,
    UnknownContentBlock,
    UnknownRecord,
    UnknownRole,
    UnsupportedHistoryMode,
    UnsupportedSource,
    SizeLimit,
    ReadFailed,
    InvalidPortableOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactReadError {
    pub kind: ExactReadFailureKind,
    pub message: String,
}

impl ExactReadError {
    pub fn new(kind: ExactReadFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn invalid_output(message: impl Into<String>) -> Self {
        Self::new(ExactReadFailureKind::InvalidPortableOutput, message)
    }
}

impl Display for ExactReadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl Error for ExactReadError {}
