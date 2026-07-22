//! Event Store Types
//!
//! Unified event type matching the frontend `SessionEvent` interface.
//! Used by the Rust-side event store, derived computations, and Tauri commands.
//!
//! Lives in `core_types` so leaf consumers (`agent_core`, the future
//! extracted `agent-core` crate) can construct and inspect `SessionEvent`
//! values without depending on `agent_sessions::event_pipeline`. The
//! `recompute_extracted` helper uses an inversion-of-control slot
//! (`register_extractor`) so `core_types` can call back into the
//! `event_pipeline::extractors` implementation that lives upstream.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

use crate::extracted::ExtractedData;
use crate::tool_names;

/// Inversion-of-control slot for `extract_event_data`. Registered at
/// startup by the `app` layer so `recompute_extracted` can produce typed
/// rendering envelopes without `core_types` depending on the
/// `event_pipeline::extractors` module that owns the parsing logic.
type ExtractorFn = fn(&SessionEvent) -> Option<ExtractedData>;
static EXTRACTOR: OnceLock<ExtractorFn> = OnceLock::new();

/// Register the extractor function pointer. Idempotent. When unregistered
/// (unit tests that exercise pure-data paths) `recompute_extracted` is a
/// no-op rather than a panic.
pub fn register_extractor(extractor: ExtractorFn) {
    let _ = EXTRACTOR.set(extractor);
}

// ============================================
// Enums
// ============================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Assistant,
    User,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventDisplayVariant {
    ToolCall,
    Message,
    Thinking,
    Plan,
    Approval,
    Session,
    Summary,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventDisplayStatus {
    Running,
    Completed,
    Failed,
    Pending,
    /// The event represents an interactive tool call (e.g.
    /// `ask_user_questions`) that is blocking the agent turn while awaiting
    /// user input from the frontend. Distinct from `Running` so generic
    /// turn-completion paths (`complete_last_running`, etc.) do not
    /// prematurely transition these events to `Completed`; only
    /// `agent:interaction_finalized` should do that.
    #[serde(rename = "awaiting_user")]
    AwaitingUser,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityStatus {
    Agent,
    Pending,
    Processed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulatorEventFilterCategory {
    KeyInteractions,
    FileChanges,
    TerminalEvents,
    Explore,
    Other,
}

// ============================================
// SessionEvent
// ============================================

/// Unified event type representing any action during a session.
///
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PayloadRef {
    pub event_id: String,
    pub field_path: String,
    pub preview: String,
    pub full_size_bytes: usize,
    pub truncated: bool,
    /// External replay locators point into provider-owned storage rather than
    /// the sessions.db event cache. Optional fields preserve native refs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_source_event_id: Option<String>,
}

/// Stable reference to one append-only shell replay artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReplayRef {
    pub session_id: String,
    pub call_id: String,
    pub format_version: u32,
}

/// Immutable as-of watermark captured for one Session Replay timeline event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellReplayBookmark {
    pub visible_through_sequence: u64,
    pub visible_bytes: u64,
}

/// Whether the replay artifact is still being appended, fully durable, or
/// only partially available after an I/O failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellReplayStatus {
    Running,
    Complete,
    Incomplete,
}

/// Bounded shell state carried by live shell rows and immutable playback
/// cursors. The complete transcript itself always lives in the artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReplayState {
    #[serde(rename = "ref")]
    pub replay_ref: ShellReplayRef,
    pub bookmark: ShellReplayBookmark,
    pub terminal_preview: String,
    pub status: ShellReplayStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// ISO-8601 timestamp written only after the file and manifest have been
    /// finalized. Historical replay may use a terminal state only when this
    /// timestamp is not later than the selected timeline event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// Mirrors the frontend `SessionEvent` interface exactly.
/// All fields use camelCase serialization to match the JS/TS convention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    #[serde(rename = "chunk_id")]
    pub chunk_id: Option<String>,
    pub session_id: String,
    pub created_at: String,

    pub function_name: String,
    /// Pre-computed UI canonical name for frontend component routing.
    /// Computed once at ingestion from `alias_map::get_ui_canonical()`.
    /// Frontend reads this directly instead of calling `normalizeFunctionName()` at render time.
    #[serde(default)]
    pub ui_canonical: String,
    pub action_type: String,
    pub args: serde_json::Value,
    pub result: serde_json::Value,
    pub source: EventSource,

    pub display_text: String,
    pub display_status: EventDisplayStatus,
    pub display_variant: EventDisplayVariant,
    pub activity_status: ActivityStatus,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_delta: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,

    /// Rust-computed event payload for frontend blocks. See
    /// `event_pipeline::extractors::extract_event_data`. Serialized to the
    /// frontend so blocks can read pre-parsed typed data directly instead of
    /// re-parsing `args`/`result` JSON on the TS side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted: Option<ExtractedData>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub payload_refs: Vec<PayloadRef>,

    /// Mutable latest state on the canonical shell tool-call row. Safe for
    /// live-tail rendering; historical replay must use
    /// `shell_replay_bookmarks` from the selected playback event instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_replay: Option<ShellReplayState>,

    /// Immutable active-shell watermarks captured when this event first
    /// enters the timeline. Same-ID merges must preserve this map unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_replay_bookmarks: Option<HashMap<String, ShellReplayState>>,

    /// Last time `extracted` was re-computed (monotonic clock). Used by
    /// streaming ingestion to debounce recomputation. Not serialized.
    #[serde(skip, default)]
    pub last_extract_at: Option<Instant>,
}

/// Debounce window for streaming re-extraction. During rapid `SessionEventPatch`
/// updates we only recompute `extracted` at most once per this interval;
/// creation and status transitions always force a recompute regardless.
pub const EXTRACT_DEBOUNCE_MS: u64 = 500;

impl SessionEvent {
    /// Force-recompute `extracted` and stamp `last_extract_at`. Call on event
    /// creation, on terminal status transitions (running → completed/failed),
    /// and from any path that knows it needs a fresh extraction.
    ///
    /// Routes through the `EXTRACTOR` IoC slot so the parsing logic stays
    /// in `event_pipeline::extractors` while this type lives in
    /// `core_types`. When unregistered (test contexts that don't boot the
    /// pipeline) the call is a no-op and `extracted` is left untouched.
    pub fn recompute_extracted(&mut self) {
        if let Some(extractor) = EXTRACTOR.get() {
            self.extracted = extractor(self);
        }
        self.last_extract_at = Some(Instant::now());
    }

    /// Recompute `extracted` only if the debounce window has elapsed since the
    /// last recompute. No-op otherwise. Callers that know they need a fresh
    /// value (e.g. on status change) should call `recompute_extracted()`.
    pub fn maybe_recompute_extracted(&mut self) {
        let due = match self.last_extract_at {
            None => true,
            Some(prev) => prev.elapsed().as_millis() as u64 >= EXTRACT_DEBOUNCE_MS,
        };
        if due {
            self.recompute_extracted();
        }
    }
}

// ============================================
// Partial update payload (for update_by_id)
// ============================================

/// Partial updates applied to a single event field-by-field.
/// Only fields present (`Some`) are written; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_status: Option<EventDisplayStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_variant: Option<EventDisplayVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_status: Option<ActivityStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_delta: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EventSource>,
}

impl SessionEventPatch {
    /// Apply this patch to a mutable event. Only `Some` fields are written.
    ///
    /// Also updates `event.extracted`:
    /// - Always recompute on a `display_status` transition (any status change
    ///   forces a fresh extraction regardless of debounce).
    /// - Otherwise, recompute at most once per `EXTRACT_DEBOUNCE_MS` when
    ///   `args`/`result` change during streaming.
    pub fn apply_to(&self, event: &mut SessionEvent) {
        let status_changed = match &self.display_status {
            Some(new_status) => *new_status != event.display_status,
            None => false,
        };
        let payload_changed = self.args.is_some() || self.result.is_some();

        if let Some(ref status) = self.display_status {
            event.display_status = status.clone();
        }
        if let Some(ref text) = self.display_text {
            event.display_text = text.clone();
        }
        if let Some(ref variant) = self.display_variant {
            event.display_variant = variant.clone();
        }
        if let Some(ref status) = self.activity_status {
            event.activity_status = status.clone();
        }
        if let Some(ref result) = self.result {
            event.result = result.clone();
        }
        if let Some(ref args) = self.args {
            event.args = args.clone();
        }
        if let Some(is_delta) = self.is_delta {
            event.is_delta = Some(is_delta);
        }
        if let Some(ref source) = self.source {
            event.source = source.clone();
        }

        if status_changed {
            event.recompute_extracted();
        } else if payload_changed {
            event.maybe_recompute_extracted();
        }
    }
}

// ============================================
// Derived Snapshots
// ============================================

fn classify_simulator_event(event: &SessionEvent) -> SimulatorEventFilterCategory {
    let name = if event.ui_canonical.is_empty() {
        event.function_name.as_str()
    } else {
        event.ui_canonical.as_str()
    };

    if matches!(event.source, EventSource::User)
        || matches!(
            name,
            tool_names::ASK_USER_QUESTIONS
                | tool_names::ASK_USER_PERMISSIONS
                | tool_names::SUGGEST_MODE_SWITCH
                | tool_names::CREATE_PLAN
                | tool_names::MANAGE_SECRETS
        )
    {
        return SimulatorEventFilterCategory::KeyInteractions;
    }

    if matches!(name, tool_names::EDIT_FILE | tool_names::DELETE_FILE) {
        return SimulatorEventFilterCategory::FileChanges;
    }

    if event.command.is_some()
        || matches!(
            name,
            tool_names::RUN_SHELL | tool_names::AWAIT_OUTPUT | tool_names::INSPECT_TERMINALS
        )
    {
        return SimulatorEventFilterCategory::TerminalEvents;
    }

    if matches!(
        name,
        tool_names::READ_FILE
            | tool_names::LIST_DIR
            | "list_directory"
            | tool_names::CODE_SEARCH
            | "codebase_search"
            | tool_names::WEB_SEARCH
            | tool_names::WEB_FETCH
            | "glob_file_search"
            | "find_files"
            | tool_names::QUERY_LSP
            | tool_names::TOOL_SEARCH
    ) {
        return SimulatorEventFilterCategory::Explore;
    }

    if event.file_path.is_some() {
        return SimulatorEventFilterCategory::FileChanges;
    }

    SimulatorEventFilterCategory::Other
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorEventPreview {
    pub id: String,
    pub session_id: String,
    pub created_at: String,
    pub function_name: String,
    pub ui_canonical: String,
    pub action_type: String,
    pub source: EventSource,
    pub display_text: String,
    pub display_status: EventDisplayStatus,
    pub display_variant: EventDisplayVariant,
    pub activity_status: ActivityStatus,
    pub filter_category: SimulatorEventFilterCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_delta: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
}

impl From<&SessionEvent> for SimulatorEventPreview {
    fn from(event: &SessionEvent) -> Self {
        Self {
            id: event.id.clone(),
            session_id: event.session_id.clone(),
            created_at: event.created_at.clone(),
            function_name: event.function_name.clone(),
            ui_canonical: event.ui_canonical.clone(),
            action_type: event.action_type.clone(),
            source: event.source.clone(),
            display_text: event.display_text.clone(),
            display_status: event.display_status.clone(),
            display_variant: event.display_variant.clone(),
            activity_status: event.activity_status.clone(),
            filter_category: classify_simulator_event(event),
            thread_id: event.thread_id.clone(),
            process_id: event.process_id.clone(),
            call_id: event.call_id.clone(),
            file_path: event.file_path.clone(),
            command: event.command.clone(),
            is_delta: event.is_delta,
            repo_id: event.repo_id.clone(),
            repo_path: event.repo_path.clone(),
        }
    }
}

/// Full snapshot pushed to the frontend when not streaming.
/// Contains all derived data so the frontend does zero computation.
///
/// Optimization: `simulatorEvents` and `sortedEvents` have been removed.
/// `sortedSimulatorEvents` serves both roles — the frontend reads it for
/// `simulatorEventsAtom` and `sortedEventsAtom`, saving two full-array
/// clones and their serialization cost on every snapshot push.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestCanvasPreview {
    pub event_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedSnapshot {
    pub version: u64,
    pub event_count: usize,
    /// Full events array for eventsAtom (insertion order, capped at MAX_EVENTS).
    pub events: Vec<SessionEvent>,
    pub chat_events: Vec<SessionEvent>,
    pub messages_events: Vec<SessionEvent>,
    /// Simulator events pre-sorted by `created_at` then `id`.
    /// Also used by `simulatorEventsAtom` and `sortedEventsAtom` on the frontend
    /// (previously duplicated as `simulatorEvents` and `sortedEvents`).
    pub sorted_simulator_events: Vec<SessionEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sorted_simulator_event_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub event_preview_by_id: HashMap<String, SimulatorEventPreview>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub created_at_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub thread_id_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub function_name_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_status_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_variant_by_id: HashMap<String, String>,
    pub last_event: Option<SessionEvent>,
    pub event_index: HashMap<String, usize>,
    /// Pre-computed: number of chat-visible events (avoids TS-side .length on filtered array).
    pub chat_event_count: usize,
    /// Pre-computed: whether any event has displayStatus === "running".
    pub has_running_event: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_canvas_preview: Option<LatestCanvasPreview>,
}

/// Lightweight snapshot pushed during streaming.
/// Omits the full `events` array and `event_index` to reduce serialization,
/// but includes `sorted_simulator_events` so the Simulator stays live.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingSnapshot {
    pub version: u64,
    pub event_count: usize,
    pub chat_events: Vec<SessionEvent>,
    pub sorted_simulator_events: Vec<SessionEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub simulator_event_upserts: Vec<SessionEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sorted_simulator_event_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub event_preview_by_id: HashMap<String, SimulatorEventPreview>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub created_at_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub thread_id_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub function_name_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_status_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_variant_by_id: HashMap<String, String>,
    pub last_event: Option<SessionEvent>,
    pub streaming: bool,
    /// Whether any event in the full store has displayStatus == Running.
    /// Checked against ALL events (not just chatEvents) so that non-visible
    /// running events (e.g. thinking deltas) are still detected.
    pub has_running_event: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_canvas_preview: Option<LatestCanvasPreview>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDelta {
    pub version: u64,
    pub base_version: u64,
    pub event_count: usize,
    pub upserts: Vec<SessionEvent>,
    pub removed_ids: Vec<String>,
    pub event_ids: Vec<String>,
    pub chat_event_ids: Vec<String>,
    pub messages_event_ids: Vec<String>,
    pub sorted_simulator_event_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub event_preview_by_id: HashMap<String, SimulatorEventPreview>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub created_at_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub thread_id_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub function_name_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_status_by_id: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub display_variant_by_id: HashMap<String, String>,
    pub last_event_id: Option<String>,
    pub chat_event_count: usize,
    pub has_running_event: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_canvas_preview: Option<LatestCanvasPreview>,
    pub snapshot_delta: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(ui_canonical: &str) -> SessionEvent {
        SessionEvent {
            id: "event-1".to_string(),
            chunk_id: None,
            session_id: "session-1".to_string(),
            created_at: "2026-06-22T00:00:00.000Z".to_string(),
            function_name: ui_canonical.to_string(),
            ui_canonical: ui_canonical.to_string(),
            action_type: "tool_call".to_string(),
            args: json!({}),
            result: json!({}),
            source: EventSource::Assistant,
            display_text: "event".to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::ToolCall,
            activity_status: ActivityStatus::Processed,
            thread_id: None,
            process_id: None,
            call_id: None,
            file_path: None,
            command: None,
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    #[test]
    fn simulator_preview_classifies_filter_category_in_rust() {
        let mut read = event(tool_names::READ_FILE);
        read.file_path = Some("src/App.tsx".to_string());
        assert_eq!(
            SimulatorEventPreview::from(&read).filter_category,
            SimulatorEventFilterCategory::Explore
        );

        let mut edit = event(tool_names::EDIT_FILE);
        edit.function_name = tool_names::APPLY_PATCH.to_string();
        assert_eq!(
            SimulatorEventPreview::from(&edit).filter_category,
            SimulatorEventFilterCategory::FileChanges
        );

        let mut terminal = event("unknown_tool");
        terminal.command = Some("pnpm test".to_string());
        assert_eq!(
            SimulatorEventPreview::from(&terminal).filter_category,
            SimulatorEventFilterCategory::TerminalEvents
        );

        let mut user = event("user");
        user.source = EventSource::User;
        assert_eq!(
            SimulatorEventPreview::from(&user).filter_category,
            SimulatorEventFilterCategory::KeyInteractions
        );
    }
}
