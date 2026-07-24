use super::*;

pub const DEFAULT_MAX_TURNS: usize = 1;
pub const HARD_MAX_TURNS: usize = 10;
pub const DEFAULT_MAX_EVENTS: usize = 200;
pub const HARD_MAX_EVENTS: usize = 200;
pub const DEFAULT_MAX_IPC_BYTES: usize = 4 * 1024 * 1024;
pub const HARD_MAX_IPC_BYTES: usize = 4 * 1024 * 1024;
pub const NORMAL_PAYLOAD_PREVIEW_BYTES: usize = 8 * 1024;
pub const SHELL_PAYLOAD_PREVIEW_BYTES: usize = 32 * 1024;
pub const DEFAULT_PAYLOAD_RANGE_BYTES: usize = 64 * 1024;
pub const HARD_MAX_PAYLOAD_RANGE_BYTES: usize = 256 * 1024;
pub const INVALIDATED_EVENT_NAME: &str = "external-replay://invalidated";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLimits {
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    #[serde(default = "default_max_events")]
    pub max_events: usize,
    #[serde(default = "default_max_ipc_bytes")]
    pub max_ipc_bytes: usize,
}

const fn default_max_turns() -> usize {
    DEFAULT_MAX_TURNS
}
const fn default_max_events() -> usize {
    DEFAULT_MAX_EVENTS
}
const fn default_max_ipc_bytes() -> usize {
    DEFAULT_MAX_IPC_BYTES
}

impl Default for ReplayLimits {
    fn default() -> Self {
        Self {
            max_turns: DEFAULT_MAX_TURNS,
            max_events: DEFAULT_MAX_EVENTS,
            max_ipc_bytes: DEFAULT_MAX_IPC_BYTES,
        }
    }
}

impl ReplayLimits {
    pub fn bounded(self) -> Self {
        Self {
            max_turns: self.max_turns.clamp(1, HARD_MAX_TURNS),
            max_events: self.max_events.clamp(1, HARD_MAX_EVENTS),
            max_ipc_bytes: self.max_ipc_bytes.clamp(1, HARD_MAX_IPC_BYTES),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCursor {
    pub source_id: String,
    pub session_id: String,
    pub generation: String,
    pub revision: u64,
    pub through_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTurnHeader {
    pub turn_id: String,
    pub turn_index: i64,
    pub start_sequence: i64,
    pub end_sequence: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub event_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStats {
    pub parsed_bytes: u64,
    pub parsed_rows: u64,
    pub normalized_events: u64,
    pub upserted_events: u64,
    pub removed_events: u64,
    pub ipc_bytes: u64,
    pub not_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadDescriptor {
    pub field_path: String,
    pub kind: ReplayPayloadKind,
    /// Encoding of bytes returned by payload range reads. New adapters must
    /// set this explicitly; the legacy value exists only so replay rows
    /// written before this field was introduced remain readable.
    #[serde(default)]
    pub encoding: ReplayPayloadEncoding,
    /// Bounded semantic body selected before a root JSON value is compacted.
    /// Markdown/CSV consumers use this instead of hydrating the whole root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_projection: Option<ReplayPayloadBodyProjection>,
    pub spans: Vec<ReplaySourceSpan>,
    pub total_bytes: u64,
    /// Ordinal of the normalized payload-bearing item within one JSONL line.
    /// This is persisted only as a source locator; public cursors remain
    /// storage-neutral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ordinal: Option<u32>,
    /// Stable provider row/KV key used by SQLite adapters for range reads.
    /// It is an internal locator and is never exposed in [`ReplayCursor`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
}

impl ReplayPayloadDescriptor {
    /// Resolve rows written before `encoding` became explicit without
    /// preserving path-shape inference in new production call sites.
    pub fn resolved_encoding(&self) -> ReplayPayloadEncoding {
        match self.encoding {
            ReplayPayloadEncoding::LegacyPathInferred => {
                if self.field_path.contains('.') {
                    ReplayPayloadEncoding::Utf8Text
                } else {
                    ReplayPayloadEncoding::JsonValue
                }
            }
            encoding => encoding,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayPayloadEncoding {
    /// Compatibility-only value for cached descriptors that predate this
    /// field. Newly constructed descriptors must never use it.
    #[default]
    LegacyPathInferred,
    /// Payload ranges form one complete serialized JSON value.
    JsonValue,
    /// Payload ranges form decoded UTF-8 string content.
    Utf8Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadBodyProjection {
    pub field_path: String,
    pub text: String,
    pub truncated: bool,
}

/// Select and bound the same semantic body used by transcript renderers
/// before a canonical root JSON payload is replaced by a compact preview.
/// `fallback_json` should be the already-serialized root when the root has no
/// well-known text field, avoiding a second session-sized serialization.
pub fn replay_payload_body_projection(
    root: &str,
    value: &serde_json::Value,
    fallback_json: Option<&str>,
    max_bytes: usize,
    tail: bool,
) -> Option<ReplayPayloadBodyProjection> {
    let (field_path, text) = replay_body_candidate(root, value)
        .or_else(|| fallback_json.map(|text| (root.to_string(), text)))?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (text, truncated) = bounded_body_preview(text, max_bytes, tail);
    Some(ReplayPayloadBodyProjection {
        field_path,
        text: text.to_string(),
        truncated,
    })
}

fn replay_body_candidate<'a>(
    root: &str,
    value: &'a serde_json::Value,
) -> Option<(String, &'a str)> {
    match value {
        serde_json::Value::String(text) => Some((root.to_string(), text)),
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_str)
            {
                if !text.trim().is_empty() {
                    return Some((format!("{root}.message.content"), text));
                }
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "body",
                "summary",
                "prompt",
                "description",
            ] {
                let Some(text) = map.get(key).and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if !text.trim().is_empty() {
                    return Some((format!("{root}.{key}"), text));
                }
            }
            None
        }
        _ => None,
    }
}

fn bounded_body_preview(text: &str, max_bytes: usize, tail: bool) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    if tail {
        let mut start = text.len().saturating_sub(max_bytes);
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        (&text[start..], true)
    } else {
        let mut end = text.len().min(max_bytes);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        (&text[..end], true)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayPayloadKind {
    UserMessage,
    AgentMessage,
    AssistantContent,
    Reasoning,
    ToolOutput,
    ToolArguments,
    ToolDiff,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySourceSpan {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone)]
pub struct ReplayIndexedChunk {
    pub sequence: i64,
    pub turn_index: i64,
    pub chunk: ActivityChunk,
    pub payloads: Vec<ReplayPayloadDescriptor>,
}

#[derive(Debug, Clone)]
pub struct ReplayChunkWindow {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub turn_headers: Vec<ReplayTurnHeader>,
    pub total_turn_count: u64,
    pub total_event_count: u64,
    pub has_older: bool,
    pub stats: ReplayStats,
}

#[derive(Debug, Clone)]
pub struct ReplayChunkDelta {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub removed_event_ids: Vec<String>,
    pub reset_required: bool,
    pub stats: ReplayStats,
}

/// Source-neutral forward scan used by backend-only streaming consumers.
///
/// Unlike `ReplayChunkWindow`, this does not apply turn pagination: callers
/// advance strictly by sequence and keep each batch bounded by `ReplayLimits`.
/// The type is intentionally not part of the renderer wire protocol.
#[derive(Debug, Clone)]
pub struct ReplayChunkScan {
    pub cursor: ReplayCursor,
    pub chunks: Vec<ReplayIndexedChunk>,
    pub has_more: bool,
    pub stats: ReplayStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPayloadRange {
    pub event_id: String,
    pub field_path: String,
    pub offset: u64,
    pub next_offset: u64,
    pub eof: bool,
    pub total_bytes: u64,
    pub text: String,
}

/// Immutable locator for one content-addressed payload body in ORGII's replay
/// cache. This type is backend-only: renderer wire types continue to expose
/// only source-neutral event/field payload references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayPayloadArtifactLocator {
    pub source_id: String,
    pub source_session_id: String,
    pub generation: String,
    pub content_hash: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayInvalidated {
    pub session_id: String,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
}
