use std::error::Error;
use std::fmt::{Display, Formatter};

use core_types::activity::ActivityChunk;
use serde::{Deserialize, Serialize};

use crate::{PortableConversationSource, PortableLossManifest};

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
    pub chunks: Vec<ActivityChunk>,
    /// Source-reader losses observed before the provider-neutral projection.
    /// This is the authoritative export capability: `is_exact_visible()`
    /// describes visible fidelity, while `is_continuation_materializable()`
    /// additionally rejects missing context required for continuation.
    /// Private reasoning and opaque lifecycle loss may be context-degrading;
    /// visible text, tool content/linkage, attachment, role, compaction, or
    /// system/developer-context loss must be blocking on the relevant axis.
    pub reader_loss_manifest: PortableLossManifest,
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
    SourceChanged,
    VisibleContentTruncated,
    ToolContentTruncated,
    RecordSkipped,
    UnterminatedTail,
    UnknownRole,
    UnsupportedSource,
    SizeLimit,
    ReadFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactReadError {
    pub kind: ExactReadFailureKind,
    pub message: String,
}

impl Display for ExactReadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl Error for ExactReadError {}
