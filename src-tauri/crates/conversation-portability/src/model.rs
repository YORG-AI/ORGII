use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::encode_canonical_json;

pub const PORTABLE_CONVERSATION_SCHEMA: &str = "org2.portable_conversation";
pub const PORTABLE_CONVERSATION_VERSION: u32 = 1;
pub const MAX_PORTABLE_CONVERSATION_EVENTS: usize = 100_000;
pub const MAX_PORTABLE_CONVERSATION_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PORTABLE_JSON_DEPTH: usize = 128;
pub const MAX_PORTABLE_JSON_NODES: usize = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableConversation {
    pub schema: String,
    pub schema_version: u32,
    pub source: PortableConversationSource,
    pub events: Vec<PortableEvent>,
    pub loss_manifest: PortableLossManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableConversationSource {
    /// Provider/reader category (`claude_code`, `native_agent`, ...).
    pub source_kind: String,
    /// Source-side session identity. It is independent of where the portable
    /// conversation will later be materialized.
    pub source_session_id: String,
    /// Content observation produced from the exact bytes or database snapshot
    /// parsed by the source reader. Cached metadata is not sufficient.
    pub source_snapshot: PortableSourceSnapshot,
    pub parser_version: i64,
    pub title: Option<String>,
    pub model: Option<String>,
    /// A hint only. The receiver must explicitly authorize its actual target
    /// workspace; materializers must never write to this source path.
    pub source_workspace_hint: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSourceSnapshot {
    pub algorithm: PortableSourceSnapshotAlgorithm,
    pub digest: String,
    /// Number of bytes in the exact file prefix or deterministic database-row
    /// stream covered by `digest`.
    pub observed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableSourceSnapshotAlgorithm {
    Sha256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableEvent {
    pub event_id: String,
    pub source_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    pub timestamp: Option<String>,
    #[serde(flatten)]
    pub body: PortableEventBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PortableEventBody {
    Message {
        role: PortableRole,
        content: Vec<PortableContentBlock>,
    },
    ToolCall {
        call_id: String,
        name: String,
        canonical_name: String,
        state: PortableToolCallState,
        input: Value,
    },
    ToolResult {
        call_id: String,
        content: Vec<PortableContentBlock>,
        is_error: bool,
    },
    Annotation {
        annotation_kind: PortableAnnotationKind,
        content: Vec<PortableContentBlock>,
    },
    CompactionSummary {
        content: Vec<PortableContentBlock>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableToolCallState {
    Pending,
    Settled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableRole {
    User,
    Assistant,
    System,
    Developer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PortableContentBlock {
    Text { text: String },
    Image { uri: String },
    Json { value: Value },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableAnnotationKind {
    SourceError,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableLossManifest {
    pub fidelity: PortableFidelity,
    pub entries: Vec<PortableLossEntry>,
    pub total_omitted_items: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableLossEntry {
    pub reason: PortableLossReason,
    pub impact: PortableLossImpact,
    pub count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableFidelity {
    pub visible: PortableVisibleFidelity,
    pub continuation: PortableContinuationFidelity,
}

impl Default for PortableFidelity {
    fn default() -> Self {
        Self {
            visible: PortableVisibleFidelity::Exact,
            continuation: PortableContinuationFidelity::ContextComplete,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableVisibleFidelity {
    Exact,
    BlockingLoss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableContinuationFidelity {
    /// All portable context is present. This does not claim byte-identical
    /// native state, credentials, or live processes.
    ContextComplete,
    /// Visible content is exact, but non-essential opaque/runtime state was
    /// omitted. Callers must not describe this as native-equivalent.
    ContextDegraded,
    /// Context required for a faithful continuation is missing.
    BlockingLoss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableLossImpact {
    Informational,
    ContinuationDegrading,
    ContinuationBlocking,
    VisibleBlocking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableLossReason {
    CompactionSummaryOmitted,
    DeveloperContextOmitted,
    DuplicateToolCallId,
    EmptyVisibleMessage,
    InvalidAttachmentReference,
    LocalAttachmentUnavailable,
    MissingToolCallId,
    MissingToolName,
    OpaqueProviderStateOmitted,
    PrivateReasoningOmitted,
    RemoteAttachmentUncaptured,
    RuntimeLifecycleOmitted,
    SourceRecordSkipped,
    SourceToolContentTruncated,
    SourceVisibleContentTruncated,
    SystemContextOmitted,
    UnknownRole,
    UnsupportedChunk,
}

impl PortableLossReason {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::CompactionSummaryOmitted => "compaction_summary_omitted",
            Self::DeveloperContextOmitted => "developer_context_omitted",
            Self::DuplicateToolCallId => "duplicate_tool_call_id",
            Self::EmptyVisibleMessage => "empty_visible_message",
            Self::InvalidAttachmentReference => "invalid_attachment_reference",
            Self::LocalAttachmentUnavailable => "local_attachment_unavailable",
            Self::MissingToolCallId => "missing_tool_call_id",
            Self::MissingToolName => "missing_tool_name",
            Self::OpaqueProviderStateOmitted => "opaque_provider_state_omitted",
            Self::PrivateReasoningOmitted => "private_reasoning_omitted",
            Self::RemoteAttachmentUncaptured => "remote_attachment_uncaptured",
            Self::RuntimeLifecycleOmitted => "runtime_lifecycle_omitted",
            Self::SourceRecordSkipped => "source_record_skipped",
            Self::SourceToolContentTruncated => "source_tool_content_truncated",
            Self::SourceVisibleContentTruncated => "source_visible_content_truncated",
            Self::SystemContextOmitted => "system_context_omitted",
            Self::UnknownRole => "unknown_role",
            Self::UnsupportedChunk => "unsupported_chunk",
        }
    }

    pub const fn impact(self) -> PortableLossImpact {
        match self {
            Self::OpaqueProviderStateOmitted
            | Self::PrivateReasoningOmitted
            | Self::RuntimeLifecycleOmitted => PortableLossImpact::ContinuationDegrading,
            Self::CompactionSummaryOmitted
            | Self::DeveloperContextOmitted
            | Self::DuplicateToolCallId
            | Self::MissingToolCallId
            | Self::MissingToolName
            | Self::SystemContextOmitted => PortableLossImpact::ContinuationBlocking,
            Self::EmptyVisibleMessage
            | Self::InvalidAttachmentReference
            | Self::LocalAttachmentUnavailable
            | Self::RemoteAttachmentUncaptured
            | Self::SourceRecordSkipped
            | Self::SourceToolContentTruncated
            | Self::SourceVisibleContentTruncated
            | Self::UnknownRole
            | Self::UnsupportedChunk => PortableLossImpact::VisibleBlocking,
        }
    }
}

impl PortableFidelity {
    pub const fn is_exact_visible(self) -> bool {
        matches!(self.visible, PortableVisibleFidelity::Exact)
    }

    /// Whether a materializer may use this checkpoint for a faithful
    /// continuation. Exact visible text alone is insufficient when required
    /// system/developer/tool/compaction context is missing.
    pub const fn is_continuation_materializable(self) -> bool {
        self.is_exact_visible()
            && !matches!(
                self.continuation,
                PortableContinuationFidelity::BlockingLoss
            )
    }

    pub const fn is_continuation_complete(self) -> bool {
        self.is_exact_visible()
            && matches!(
                self.continuation,
                PortableContinuationFidelity::ContextComplete
            )
    }

    fn apply(&mut self, impact: PortableLossImpact) {
        match impact {
            PortableLossImpact::Informational => {}
            PortableLossImpact::ContinuationDegrading => {
                if self.continuation == PortableContinuationFidelity::ContextComplete {
                    self.continuation = PortableContinuationFidelity::ContextDegraded;
                }
            }
            PortableLossImpact::ContinuationBlocking => {
                self.continuation = PortableContinuationFidelity::BlockingLoss;
            }
            PortableLossImpact::VisibleBlocking => {
                self.visible = PortableVisibleFidelity::BlockingLoss;
                self.continuation = PortableContinuationFidelity::BlockingLoss;
            }
        }
    }
}

impl PortableLossManifest {
    pub fn validate(&self) -> Result<(), String> {
        let manifest_total = self
            .entries
            .iter()
            .try_fold(0u64, |total, item| total.checked_add(item.count))
            .ok_or_else(|| "Portable loss manifest total overflowed".to_string())?;
        if manifest_total != self.total_omitted_items {
            return Err("Portable loss manifest total does not match its entries".to_string());
        }
        if self.entries.iter().any(|item| item.count == 0)
            || self
                .entries
                .windows(2)
                .any(|items| items[0].reason.wire_name() >= items[1].reason.wire_name())
        {
            return Err("Portable loss manifest must be sorted, unique, and non-zero".to_string());
        }
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.impact != entry.reason.impact())
        {
            return Err(format!(
                "Portable loss impact does not match reason {:?}",
                entry.reason
            ));
        }
        if self.fidelity != self.computed_fidelity() {
            return Err("Portable loss fidelity does not match its entries".to_string());
        }
        Ok(())
    }

    pub fn computed_fidelity(&self) -> PortableFidelity {
        let mut fidelity = PortableFidelity::default();
        for entry in &self.entries {
            fidelity.apply(entry.impact);
        }
        fidelity
    }

    pub fn is_exact_visible(&self) -> bool {
        self.fidelity.is_exact_visible()
    }

    pub fn is_continuation_complete(&self) -> bool {
        self.fidelity.is_continuation_complete()
    }

    pub fn is_continuation_materializable(&self) -> bool {
        self.fidelity.is_continuation_materializable()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedPortableConversation {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

impl PortableConversation {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != PORTABLE_CONVERSATION_SCHEMA {
            return Err(format!(
                "Unknown portable conversation schema: {}",
                self.schema
            ));
        }
        if self.schema_version != PORTABLE_CONVERSATION_VERSION {
            return Err(format!(
                "Unsupported portable conversation version: {}",
                self.schema_version
            ));
        }
        validate_non_empty("source kind", &self.source.source_kind)?;
        validate_non_empty("source session id", &self.source.source_session_id)?;
        validate_component_bytes("source kind", &self.source.source_kind)?;
        validate_component_bytes("source session id", &self.source.source_session_id)?;
        for (label, value) in [
            ("source title", self.source.title.as_deref()),
            ("source model", self.source.model.as_deref()),
            (
                "source workspace hint",
                self.source.source_workspace_hint.as_deref(),
            ),
            ("source start timestamp", self.source.started_at.as_deref()),
            ("source update timestamp", self.source.updated_at.as_deref()),
        ] {
            if let Some(value) = value {
                validate_component_bytes(label, value)?;
            }
        }
        if self.source.parser_version < 0 {
            return Err("Portable conversation parser version must be non-negative".to_string());
        }
        if self.source.source_snapshot.digest.len() != 64
            || !self
                .source
                .source_snapshot
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Portable source snapshot must be a lowercase SHA-256 digest".to_string());
        }
        if self.events.len() > MAX_PORTABLE_CONVERSATION_EVENTS {
            return Err(format!(
                "Portable conversation has {} events; limit is {MAX_PORTABLE_CONVERSATION_EVENTS}",
                self.events.len()
            ));
        }

        let mut event_ids = HashSet::with_capacity(self.events.len());
        let mut call_states = HashMap::new();
        let mut result_ids = HashSet::new();
        let mut last_source_index = None;
        for event in &self.events {
            validate_non_empty("portable event id", &event.event_id)?;
            validate_component_bytes("portable event id", &event.event_id)?;
            if let Some(thread_id) = event.source_thread_id.as_deref() {
                validate_non_empty("source thread id", thread_id)?;
                validate_component_bytes("source thread id", thread_id)?;
            }
            if let Some(timestamp) = event.timestamp.as_deref() {
                validate_component_bytes("event timestamp", timestamp)?;
            }
            if !event_ids.insert(event.event_id.as_str()) {
                return Err(format!("Duplicate portable event id: {}", event.event_id));
            }
            if last_source_index.is_some_and(|previous| event.source_index < previous) {
                return Err("Portable conversation events are not in source order".to_string());
            }
            last_source_index = Some(event.source_index);
            match &event.body {
                PortableEventBody::Message { content, .. }
                | PortableEventBody::Annotation { content, .. }
                | PortableEventBody::CompactionSummary { content } => validate_content(content)?,
                PortableEventBody::ToolCall {
                    call_id,
                    name,
                    canonical_name,
                    state,
                    input,
                } => {
                    validate_non_empty("tool call id", call_id)?;
                    validate_non_empty("tool name", name)?;
                    validate_non_empty("canonical tool name", canonical_name)?;
                    validate_component_bytes("tool call id", call_id)?;
                    validate_component_bytes("tool name", name)?;
                    validate_component_bytes("canonical tool name", canonical_name)?;
                    if call_states.insert(call_id.as_str(), *state).is_some() {
                        return Err(format!("Duplicate portable tool call id: {call_id}"));
                    }
                    validate_json_value(input)?;
                }
                PortableEventBody::ToolResult {
                    call_id, content, ..
                } => {
                    validate_non_empty("tool result call id", call_id)?;
                    validate_component_bytes("tool result call id", call_id)?;
                    let Some(state) = call_states.get(call_id.as_str()) else {
                        return Err(format!("Orphan portable tool result: {call_id}"));
                    };
                    if *state != PortableToolCallState::Settled {
                        return Err(format!(
                            "Pending portable tool call has a result: {call_id}"
                        ));
                    }
                    if !result_ids.insert(call_id.as_str()) {
                        return Err(format!("Duplicate portable tool result: {call_id}"));
                    }
                    validate_content_allow_empty(content)?;
                }
            }
        }
        if let Some((call_id, _)) = call_states.iter().find(|(call_id, state)| {
            **state == PortableToolCallState::Settled && !result_ids.contains(**call_id)
        }) {
            return Err(format!(
                "Settled portable tool call has no result: {call_id}"
            ));
        }

        self.loss_manifest.validate()?;
        Ok(())
    }

    pub fn require_exact_visible(&self) -> Result<(), String> {
        self.validate()?;
        if !self.loss_manifest.is_exact_visible() {
            return Err("Portable conversation has blocking visible-content loss".to_string());
        }
        Ok(())
    }

    pub fn require_continuation_complete(&self) -> Result<(), String> {
        self.require_materializable_continuation()?;
        if !self.loss_manifest.is_continuation_complete() {
            return Err("Portable conversation is not continuation-complete".to_string());
        }
        Ok(())
    }

    pub fn require_materializable_continuation(&self) -> Result<(), String> {
        self.require_exact_visible()?;
        if !self.loss_manifest.is_continuation_materializable() {
            return Err(
                "Portable conversation is missing context required for continuation".to_string(),
            );
        }
        Ok(())
    }

    pub fn encode_canonical(&self) -> Result<EncodedPortableConversation, String> {
        self.validate()?;
        encode_canonical_json(self)
    }

    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_PORTABLE_CONVERSATION_BYTES {
            return Err(format!(
                "Portable conversation is {} bytes; limit is {MAX_PORTABLE_CONVERSATION_BYTES}",
                bytes.len()
            ));
        }
        let conversation: Self = serde_json::from_slice(bytes)
            .map_err(|err| format!("Failed to decode portable conversation: {err}"))?;
        conversation.validate()?;
        if conversation.encode_canonical()?.bytes != bytes {
            return Err("Portable conversation is valid JSON but not canonical".to_string());
        }
        Ok(conversation)
    }
}

pub(crate) fn portable_image_uri(uri: &str) -> bool {
    let Some((header, data)) = uri.split_once(',') else {
        return false;
    };
    if !matches!(
        header,
        "data:image/gif;base64"
            | "data:image/jpeg;base64"
            | "data:image/png;base64"
            | "data:image/webp;base64"
    ) || data.is_empty()
        || data.len() % 4 != 0
    {
        return false;
    }
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
    padding <= 2
        && data[..data.len() - padding]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        && data[data.len() - padding..]
            .bytes()
            .all(|byte| byte == b'=')
}

fn validate_content(content: &[PortableContentBlock]) -> Result<(), String> {
    if content.is_empty() {
        return Err("Portable visible content must not be empty".to_string());
    }
    validate_content_allow_empty(content)
}

fn validate_content_allow_empty(content: &[PortableContentBlock]) -> Result<(), String> {
    for block in content {
        match block {
            PortableContentBlock::Text { text } if text.is_empty() => {
                return Err("Portable conversation contains an empty text block".to_string());
            }
            PortableContentBlock::Image { uri } => {
                validate_component_bytes("image URI", uri)?;
                if !portable_image_uri(uri) {
                    return Err("Portable conversation contains an invalid image URI".to_string());
                }
            }
            PortableContentBlock::Json { value } => validate_json_value(value)?,
            PortableContentBlock::Text { text } => {
                validate_component_bytes("text block", text)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_json_value(value: &Value) -> Result<(), String> {
    let mut stack = vec![(value, 1usize)];
    let mut nodes = 0usize;
    let mut raw_bytes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        if depth > MAX_PORTABLE_JSON_DEPTH {
            return Err(format!(
                "Portable JSON exceeds the {MAX_PORTABLE_JSON_DEPTH}-level nesting limit"
            ));
        }
        nodes = nodes
            .checked_add(1)
            .ok_or_else(|| "Portable JSON node count overflowed".to_string())?;
        if nodes > MAX_PORTABLE_JSON_NODES {
            return Err(format!(
                "Portable JSON exceeds the {MAX_PORTABLE_JSON_NODES}-node limit"
            ));
        }
        match value {
            Value::Array(values) => {
                stack.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                for key in values.keys() {
                    raw_bytes = raw_bytes
                        .checked_add(key.len())
                        .ok_or_else(|| "Portable JSON byte count overflowed".to_string())?;
                }
                stack.extend(values.values().map(|value| (value, depth + 1)));
            }
            Value::String(value) => {
                raw_bytes = raw_bytes
                    .checked_add(value.len())
                    .ok_or_else(|| "Portable JSON byte count overflowed".to_string())?;
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
        if raw_bytes > MAX_PORTABLE_CONVERSATION_BYTES {
            return Err(format!(
                "Portable JSON string/key payload exceeds {MAX_PORTABLE_CONVERSATION_BYTES} bytes"
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_component_bytes(label: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_PORTABLE_CONVERSATION_BYTES {
        Err(format!(
            "Portable conversation {label} exceeds {MAX_PORTABLE_CONVERSATION_BYTES} bytes"
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("Portable conversation {label} must not be empty"))
    } else {
        Ok(())
    }
}
