//! Exact, fail-closed source adapters for imported native transcripts.
//!
//! Unlike the sidebar/replay loaders, this path never consumes display
//! `ActivityChunk`s, preview windows, or truncating caches. The cache may
//! locate a transcript, but the adapter reopens the authoritative file once,
//! hashes and parses that same handle, and emits provider-neutral portable
//! events directly.

mod claude;
mod codex;
mod source_file;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use conversation_portability::{
    ExactConversationReader, ExactReadError, ExactReadFailureKind, ExactReadOutcome,
    PortableConversation, PortableEvent, PortableEventBody, PortableLossManifest,
    PortableLossReason, PortableToolCallState, MAX_PORTABLE_CONVERSATION_EVENTS,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use self::source_file::{read_source_records, ExactReadLimits, ExactSourceRecords};
use super::metadata::{SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP};

const EXACT_IMPORTED_PARSER_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExactImportedSourceKind {
    ClaudeCode,
    Codex,
}

impl ExactImportedSourceKind {
    const fn cache_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => SOURCE_CLAUDE_CODE,
            Self::Codex => SOURCE_CODEX_APP,
        }
    }

    const fn portable_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }
}

/// Exact source descriptor. `containment_root` is an authorized transcript
/// root, not a workspace to write into. The reader never opens credentials,
/// config files, indexes, or sibling attachments.
#[derive(Debug, Clone)]
pub struct ExactImportedFileSource {
    pub kind: ExactImportedSourceKind,
    /// Provider-native session/thread id validated against the transcript.
    pub source_session_id: String,
    pub source_path: PathBuf,
    pub containment_root: PathBuf,
    pub title: Option<String>,
    pub model: Option<String>,
    /// Provenance hint only; no reader writes to or scans this directory.
    pub source_workspace_hint: Option<String>,
}

impl ExactImportedFileSource {
    pub fn manual(
        kind: ExactImportedSourceKind,
        source_session_id: impl Into<String>,
        source_path: impl Into<PathBuf>,
        containment_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            kind,
            source_session_id: source_session_id.into(),
            source_path: source_path.into(),
            containment_root: containment_root.into(),
            title: None,
            model: None,
            source_workspace_hint: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExactImportedTranscriptReader {
    source: ExactImportedFileSource,
}

impl ExactImportedTranscriptReader {
    pub fn new(source: ExactImportedFileSource) -> Self {
        Self { source }
    }

    fn read_with_limits(
        &self,
        source_session_id: &str,
        limits: ExactReadLimits,
    ) -> Result<ExactReadOutcome, ExactReadError> {
        if source_session_id != self.source.source_session_id {
            return Err(ExactReadError::new(
                ExactReadFailureKind::InvalidSourceIdentity,
                "Requested source session id does not match the exact source descriptor",
            ));
        }
        let records = read_source_records(&self.source, limits)?;
        match self.source.kind {
            ExactImportedSourceKind::ClaudeCode => claude::read_claude_exact(&self.source, records),
            ExactImportedSourceKind::Codex => codex::read_codex_exact(&self.source, records),
        }
    }
}

impl ExactConversationReader for ExactImportedTranscriptReader {
    fn read_exact_visible(
        &self,
        source_session_id: &str,
    ) -> Result<ExactReadOutcome, ExactReadError> {
        self.read_with_limits(source_session_id, ExactReadLimits::production())
    }
}

pub fn read_exact_imported_file(
    source: ExactImportedFileSource,
) -> Result<PortableConversation, ExactReadError> {
    let source_session_id = source.source_session_id.clone();
    ExactImportedTranscriptReader::new(source)
        .read_exact_visible(&source_session_id)?
        .finalize()
}

/// Resolve one already-imported session from the rebuildable cache, then read
/// its authoritative source. Cache preview text/chunks are never consulted.
pub fn read_exact_imported_session(
    conn: &Connection,
    session_id: &str,
) -> Result<PortableConversation, ExactReadError> {
    let cached = conn
        .query_row(
            "SELECT source, source_session_id, source_path, name, model, repo_path
             FROM imported_history_session_cache
             WHERE session_id = ?1 AND source IN (?2, ?3)
             ORDER BY updated_at_ms DESC LIMIT 1",
            (session_id, SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            ExactReadError::new(
                ExactReadFailureKind::ReadFailed,
                format!("Failed to resolve imported transcript: {error}"),
            )
        })?
        .ok_or_else(|| {
            ExactReadError::new(
                ExactReadFailureKind::UnsupportedSource,
                "Imported session has no exact Claude Code or Codex source",
            )
        })?;

    let (source_name, cache_source_id, source_path, title, model, workspace_hint) = cached;
    let source_path = PathBuf::from(source_path);
    let kind = match source_name.as_str() {
        SOURCE_CLAUDE_CODE => ExactImportedSourceKind::ClaudeCode,
        SOURCE_CODEX_APP => ExactImportedSourceKind::Codex,
        _ => {
            return Err(ExactReadError::new(
                ExactReadFailureKind::UnsupportedSource,
                "Imported source does not have an exact adapter",
            ));
        }
    };
    let cached_stem = source_path.file_stem().and_then(|value| value.to_str());
    if cached_stem != Some(cache_source_id.as_str()) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            "Imported cache source id does not match the authoritative filename",
        ));
    }
    let expected_cached_session_id = match kind {
        ExactImportedSourceKind::ClaudeCode => {
            crate::sources::claude_code::canonical_session_id(&cache_source_id)
        }
        ExactImportedSourceKind::Codex => {
            crate::sources::codex::canonical_session_id(&cache_source_id)
        }
    };
    if session_id != expected_cached_session_id {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourceIdentity,
            "Imported cache canonical session id does not match its source identity",
        ));
    }
    let source_session_id = match kind {
        ExactImportedSourceKind::ClaudeCode => cache_source_id,
        ExactImportedSourceKind::Codex => codex::thread_id_from_rollout_path(&source_path)?,
    };
    let containment_root = source_containment_root(kind, &source_path)?;
    read_exact_imported_file(ExactImportedFileSource {
        kind,
        source_session_id,
        source_path,
        containment_root,
        title: non_empty(title),
        model: model.and_then(non_empty),
        source_workspace_hint: workspace_hint.and_then(non_empty),
    })
}

fn source_containment_root(
    kind: ExactImportedSourceKind,
    source_path: &Path,
) -> Result<PathBuf, ExactReadError> {
    let roots = match kind {
        ExactImportedSourceKind::ClaudeCode => {
            crate::sources::claude_code::history::claude_projects_dirs()
        }
        ExactImportedSourceKind::Codex => crate::sources::codex::app::codex_sessions_dirs(),
    }
    .map_err(|message| ExactReadError::new(ExactReadFailureKind::ReadFailed, message))?;
    source_containment_root_from_roots(kind, source_path, &roots)
}

fn source_containment_root_from_roots(
    kind: ExactImportedSourceKind,
    source_path: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, ExactReadError> {
    if !source_path.is_absolute() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Imported exact transcript path must be absolute",
        ));
    }
    roots
        .iter()
        .filter(|root| root.is_absolute() && source_path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .ok_or_else(|| {
            ExactReadError::new(
                ExactReadFailureKind::InvalidSourcePath,
                format!(
                    "Imported {} transcript is outside every provider discovery root",
                    kind.cache_name()
                ),
            )
        })
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

struct ExactOutcomeMetadata {
    source_runtime_version: Option<String>,
    observed_title: Option<String>,
    observed_model: Option<String>,
    observed_workspace: Option<String>,
    started_at: Option<String>,
    updated_at: Option<String>,
}

fn finalize_outcome(
    source: &ExactImportedFileSource,
    records: &ExactSourceRecords,
    mut events: Vec<PortableEvent>,
    loss_counts: HashMap<PortableLossReason, u64>,
    metadata: ExactOutcomeMetadata,
) -> Result<ExactReadOutcome, ExactReadError> {
    for (index, event) in events.iter_mut().enumerate() {
        event.source_index = u64::try_from(index).map_err(|_| {
            ExactReadError::new(
                ExactReadFailureKind::RecordLimit,
                "Exact portable event index overflowed",
            )
        })?;
    }
    if events.len() > MAX_PORTABLE_CONVERSATION_EVENTS {
        return Err(ExactReadError::new(
            ExactReadFailureKind::RecordLimit,
            format!(
                "Exact transcript produced {} events; limit is {MAX_PORTABLE_CONVERSATION_EVENTS}",
                events.len()
            ),
        ));
    }
    if events.is_empty() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::UnsupportedSource,
            "Exact transcript contains no portable conversation events",
        ));
    }
    let reader_loss_manifest =
        PortableLossManifest::from_reason_counts(loss_counts).map_err(|message| {
            ExactReadError::new(ExactReadFailureKind::InvalidPortableOutput, message)
        })?;
    Ok(ExactReadOutcome {
        source: conversation_portability::PortableConversationSource {
            source_kind: source.kind.portable_name().to_string(),
            source_session_id: source.source_session_id.clone(),
            source_snapshot: records.snapshot.clone(),
            parser_version: EXACT_IMPORTED_PARSER_VERSION,
            source_runtime_version: metadata.source_runtime_version,
            title: metadata.observed_title.or_else(|| source.title.clone()),
            model: metadata.observed_model.or_else(|| source.model.clone()),
            source_workspace_hint: metadata
                .observed_workspace
                .or_else(|| source.source_workspace_hint.clone()),
            started_at: metadata.started_at,
            updated_at: metadata.updated_at,
        },
        events,
        reader_loss_manifest,
    })
}

fn link_tool_events(events: &mut [PortableEvent]) -> Result<(), ExactReadError> {
    let mut calls = HashMap::<String, usize>::new();
    let mut results = HashSet::<String>::new();
    for index in 0..events.len() {
        match &events[index].body {
            PortableEventBody::ToolCall { call_id, .. } => {
                if calls.insert(call_id.clone(), index).is_some() {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::InvalidToolLinkage,
                        format!("Exact transcript contains duplicate tool call id: {call_id}"),
                    ));
                }
            }
            PortableEventBody::ToolResult { call_id, .. } => {
                let Some(call_index) = calls.get(call_id).copied() else {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::InvalidToolLinkage,
                        format!("Exact transcript contains orphan tool result: {call_id}"),
                    ));
                };
                if !results.insert(call_id.clone()) {
                    return Err(ExactReadError::new(
                        ExactReadFailureKind::InvalidToolLinkage,
                        format!("Exact transcript contains duplicate tool result: {call_id}"),
                    ));
                }
                let PortableEventBody::ToolCall { state, .. } = &mut events[call_index].body else {
                    unreachable!("recorded tool call index must remain a tool call");
                };
                *state = PortableToolCallState::Settled;
            }
            _ => {}
        }
    }
    Ok(())
}

fn increment_loss(
    losses: &mut HashMap<PortableLossReason, u64>,
    reason: PortableLossReason,
) -> Result<(), ExactReadError> {
    let next = losses
        .get(&reason)
        .copied()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| {
            ExactReadError::new(
                ExactReadFailureKind::InvalidPortableOutput,
                "Exact transcript loss count overflowed",
            )
        })?;
    losses.insert(reason, next);
    Ok(())
}

fn push_event(events: &mut Vec<PortableEvent>, event: PortableEvent) -> Result<(), ExactReadError> {
    if events.len() >= MAX_PORTABLE_CONVERSATION_EVENTS {
        return Err(ExactReadError::new(
            ExactReadFailureKind::RecordLimit,
            format!("Exact transcript exceeds {MAX_PORTABLE_CONVERSATION_EVENTS} events"),
        ));
    }
    events.push(event);
    Ok(())
}

fn required_object_field<'a>(
    provider: &str,
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a Map<String, Value>, ExactReadError> {
    object.get(field).and_then(Value::as_object).ok_or_else(|| {
        ExactReadError::new(
            ExactReadFailureKind::MalformedRecord,
            format!("{provider} record {source_index} field {field:?} must be an object"),
        )
    })
}

fn required_string_field<'a>(
    provider: &str,
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<&'a str, ExactReadError> {
    let value = object.get(field).and_then(Value::as_str).ok_or_else(|| {
        ExactReadError::new(
            ExactReadFailureKind::MalformedRecord,
            format!("{provider} record {source_index} field {field:?} must be a string"),
        )
    })?;
    if value.is_empty() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::MalformedRecord,
            format!("{provider} record {source_index} field {field:?} must not be empty"),
        ));
    }
    Ok(value)
}

fn optional_string_field<'a>(
    provider: &str,
    object: &'a Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<&'a str>, ExactReadError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(ExactReadError::new(
            ExactReadFailureKind::MalformedRecord,
            format!("{provider} record {source_index} field {field:?} must be a string or null"),
        )),
    }
}

fn optional_bool_field(
    provider: &str,
    object: &Map<String, Value>,
    field: &str,
    source_index: u64,
) -> Result<Option<bool>, ExactReadError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ExactReadError::new(
            ExactReadFailureKind::MalformedRecord,
            format!("{provider} record {source_index} field {field:?} must be a boolean"),
        )),
    }
}

fn source_record_error(
    kind: ExactReadFailureKind,
    record_index: u64,
    message: &str,
) -> ExactReadError {
    ExactReadError::new(kind, format!("{message} at source record {record_index}"))
}

fn uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests;
