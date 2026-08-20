//! Derived computations for session events
//!
//! Single source of truth for event visibility (`is_visible_in_chat`,
//! `is_visible_in_simulator`, `is_visible_in_messages`) and the full
//! `compute_derived()` single-pass function that produces a
//! `DerivedSnapshot` without any intermediate allocations.
//!
//! Simulator/Messages visibility is computed exclusively here; the frontend
//! consumes the pre-filtered `sorted_simulator_events` / `messages_events`
//! from snapshots instead of re-filtering. Chat visibility keeps a TS twin
//! (`isVisibleInChat` in `visibilityFilters.ts`) for synchronous Jotai
//! paths — parity is enforced by the shared fixture in
//! `fixtures/visibility_parity.json`.

use std::{cmp::Ordering, collections::HashMap};

use crate::agent_sessions::event_pipeline::payload_compaction::compact_event_for_snapshot;
use crate::agent_sessions::event_pipeline::types::{
    DerivedSnapshot, EventDisplayStatus, EventDisplayVariant, EventSource, LatestCanvasPreview,
    SessionEvent, SimulatorEventPreview,
};

/// Background-shell process states stamped onto tool_call args as
/// `shellProcessStatus` (stamped by the exact call-id lifecycle bridge).
/// Terminal states mean the shell is no longer a live runtime resource even
/// if the event's display_status is still "running".
const TERMINAL_SHELL_PROCESS_STATUSES: &[&str] = &["exited", "killed"];
const ACTIVE_SHELL_PROCESS_STATUSES: &[&str] = &["running", "background"];

fn shell_process_status(event: &SessionEvent) -> Option<&str> {
    event
        .args
        .as_object()
        .and_then(|obj| obj.get("shellProcessStatus"))
        .and_then(|v| v.as_str())
}

/// Whether the event represents work that is still alive at runtime
/// (running tool, streaming message, active/background shell process).
///
/// Mirrors `isLiveRuntimeResourceEvent` in TS `runningEventGate.ts`.
fn is_live_runtime_resource_event(event: &SessionEvent) -> bool {
    if let Some(status) = shell_process_status(event) {
        if TERMINAL_SHELL_PROCESS_STATUSES.contains(&status) {
            return false;
        }
        if ACTIVE_SHELL_PROCESS_STATUSES.contains(&status) {
            return true;
        }
    }
    event.display_status == EventDisplayStatus::Running
        || event
            .result
            .as_object()
            .and_then(|obj| obj.get("status"))
            .and_then(|v| v.as_str())
            == Some("running")
}

/// Check if an event should be shown in the chat panel.
///
/// Mirrors JS `isVisibleInChat` from `normalizers.ts`.
pub fn is_visible_in_chat(event: &SessionEvent) -> bool {
    // NOTE: thinking deltas (is_delta=true, variant=Thinking) are now allowed
    // through so the chat panel can show a live streaming cursor while the
    // model reasons. The ThinkingEvent component already supports isStreaming.
    // Empty thinking deltas are still caught by the has_thinking_content
    // guard below.

    // Hide session start/end from chat
    if event.display_variant == EventDisplayVariant::Session {
        return false;
    }

    // Hide task lifecycle and stage errors from chat (no UI components)
    if matches!(
        event.action_type.as_str(),
        "task_start" | "task_completed" | "task_failed" | "stage_error"
    ) {
        return false;
    }

    // Hide standalone tool_result events
    if event.action_type == "tool_result" {
        return false;
    }

    // Hide user messages from failed turns. When an `agent:error` arrives the
    // frontend marks the preceding user message as `Failed`; the original text
    // stays in the store for audit / replay but should not appear in chat so
    // retries don't produce a wall of duplicate inputs.
    if event.source == EventSource::User && event.display_status == EventDisplayStatus::Failed {
        return false;
    }

    // Hide empty thinking events
    if event.display_variant == EventDisplayVariant::Thinking
        && !has_thinking_content(&event.result)
    {
        return false;
    }

    // Hide whitespace-only assistant messages
    if event.display_variant == EventDisplayVariant::Message
        && event.action_type == "assistant"
        && !has_visible_message_content(event)
    {
        return false;
    }

    true
}

/// Shared visibility rule for the Simulator and the Messages app.
///
/// Both contexts show completed tool calls, thinking events, and messages but
/// hide streaming deltas and in-progress non-tool events.
///
/// All `tool_call` events are shown while running so every agent station app
/// can display a loading state immediately when the tool starts, mirroring
/// the chat panel's shimmer behaviour. Standalone `tool_result` events are
/// hidden — their content belongs to the merged parent tool_call; if one
/// slips past the merger (missing call_id) it must not show as a duplicate.
fn is_visible_in_simulator_or_messages(event: &SessionEvent) -> bool {
    if event.is_delta == Some(true) {
        return false;
    }

    // Hide standalone tool_result events (orphans of tool_call_merger).
    if event.action_type == "tool_result" {
        return false;
    }

    // Hide live non-tool_call events (e.g. bare assistant messages that are
    // still streaming) — only tool_call events get a loading state in the
    // apps. Background shells stay visible via the shellProcessStatus check
    // inside is_live_runtime_resource_event.
    if is_live_runtime_resource_event(event)
        && event.display_variant != EventDisplayVariant::ToolCall
    {
        return false;
    }

    matches!(
        event.display_variant,
        EventDisplayVariant::ToolCall
            | EventDisplayVariant::Thinking
            | EventDisplayVariant::Message
    )
}

/// Check if an event should be shown in the simulator.
pub fn is_visible_in_simulator(event: &SessionEvent) -> bool {
    is_visible_in_simulator_or_messages(event)
}

/// Check if an event should be shown in the Messages app.
///
/// Same rules as [`is_visible_in_simulator`].
pub fn is_visible_in_messages(event: &SessionEvent) -> bool {
    is_visible_in_simulator_or_messages(event)
}

pub struct SimulatorPreviewIndexes {
    pub sorted_simulator_event_ids: Vec<String>,
    pub event_preview_by_id: HashMap<String, SimulatorEventPreview>,
    pub created_at_by_id: HashMap<String, String>,
    pub thread_id_by_id: HashMap<String, String>,
    pub function_name_by_id: HashMap<String, String>,
    pub display_status_by_id: HashMap<String, String>,
    pub display_variant_by_id: HashMap<String, String>,
}

fn display_status_wire(status: &EventDisplayStatus) -> &'static str {
    match status {
        EventDisplayStatus::Running => "running",
        EventDisplayStatus::Completed => "completed",
        EventDisplayStatus::Failed => "failed",
        EventDisplayStatus::Pending => "pending",
        EventDisplayStatus::AwaitingUser => "awaiting_user",
    }
}

fn display_variant_wire(variant: &EventDisplayVariant) -> &'static str {
    match variant {
        EventDisplayVariant::ToolCall => "tool_call",
        EventDisplayVariant::Message => "message",
        EventDisplayVariant::Thinking => "thinking",
        EventDisplayVariant::Plan => "plan",
        EventDisplayVariant::Approval => "approval",
        EventDisplayVariant::Session => "session",
        EventDisplayVariant::Summary => "summary",
        EventDisplayVariant::Error => "error",
    }
}

pub fn latest_canvas_preview(events: &[SessionEvent]) -> Option<LatestCanvasPreview> {
    use core_types::tool_names::{RENDER_INLINE_CANVAS, REVISE_INLINE_CANVAS};

    events.iter().rev().find_map(|event| {
        let is_canvas_event = event.ui_canonical == "canvas_inline"
            || event.function_name == RENDER_INLINE_CANVAS
            || event.function_name == REVISE_INLINE_CANVAS;
        if !is_canvas_event {
            return None;
        }
        let args = event.args.as_object()?;
        Some(LatestCanvasPreview {
            event_id: event.id.clone(),
            mode: args
                .get("mode")
                .and_then(|value| value.as_str())
                .unwrap_or("html")
                .to_string(),
            url: args
                .get("url")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            title: args
                .get("title")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            streaming: args.get("streaming").and_then(|value| value.as_bool()),
        })
    })
}

pub fn build_simulator_preview_indexes(
    sorted_simulator_events: &[SessionEvent],
) -> SimulatorPreviewIndexes {
    build_simulator_preview_indexes_from_iter(
        sorted_simulator_events.iter(),
        sorted_simulator_events.len(),
    )
}

fn build_simulator_preview_indexes_from_iter<'a>(
    sorted_simulator_events: impl Iterator<Item = &'a SessionEvent>,
    event_count: usize,
) -> SimulatorPreviewIndexes {
    let mut sorted_simulator_event_ids = Vec::with_capacity(event_count);
    let mut event_preview_by_id = HashMap::with_capacity(event_count);
    let mut created_at_by_id = HashMap::with_capacity(event_count);
    let mut thread_id_by_id = HashMap::new();
    let mut function_name_by_id = HashMap::with_capacity(event_count);
    let mut display_status_by_id = HashMap::with_capacity(event_count);
    let mut display_variant_by_id = HashMap::with_capacity(event_count);

    for event in sorted_simulator_events {
        sorted_simulator_event_ids.push(event.id.clone());
        event_preview_by_id.insert(event.id.clone(), SimulatorEventPreview::from(event));
        created_at_by_id.insert(event.id.clone(), event.created_at.clone());
        if let Some(thread_id) = &event.thread_id {
            thread_id_by_id.insert(event.id.clone(), thread_id.clone());
        }
        function_name_by_id.insert(event.id.clone(), event.function_name.clone());
        display_status_by_id.insert(
            event.id.clone(),
            display_status_wire(&event.display_status).to_string(),
        );
        display_variant_by_id.insert(
            event.id.clone(),
            display_variant_wire(&event.display_variant).to_string(),
        );
    }

    SimulatorPreviewIndexes {
        sorted_simulator_event_ids,
        event_preview_by_id,
        created_at_by_id,
        thread_id_by_id,
        function_name_by_id,
        display_status_by_id,
        display_variant_by_id,
    }
}

/// Compute all derived data in a single pass over the events.
///
/// Produces `DerivedSnapshot` containing:
/// - `chat_events` (filtered + sorted by createdAt)
/// - `simulator_events` (filtered)
/// - `messages_events` (filtered)
/// - `sorted_events` (simulator events sorted by createdAt then id)
/// - `last_event`
/// - `event_index` (id → index in events vec)
pub fn compute_derived(events: &[SessionEvent], version: u64) -> DerivedSnapshot {
    let event_count = events.len();
    let mut compacted_events = Vec::with_capacity(event_count);
    let mut chat_event_indexes = Vec::with_capacity(event_count / 2);
    let mut simulator_event_indexes = Vec::with_capacity(event_count / 2);
    let mut messages_event_indexes = Vec::with_capacity(event_count / 2);
    let mut event_index = HashMap::with_capacity(event_count);
    let mut has_running_event = false;

    for (idx, event) in events.iter().enumerate() {
        event_index.insert(event.id.clone(), idx);

        if event.display_status == EventDisplayStatus::Running {
            has_running_event = true;
        }

        if is_visible_in_chat(event) {
            chat_event_indexes.push(idx);
        }
        if is_visible_in_simulator(event) {
            simulator_event_indexes.push(idx);
        }
        if is_visible_in_messages(event) {
            messages_event_indexes.push(idx);
        }

        compacted_events.push(compact_event_for_snapshot(event));
    }

    let mut chat_events = chat_event_indexes
        .iter()
        .map(|idx| compacted_events[*idx].clone())
        .collect::<Vec<_>>();
    sort_if_unsorted(&mut chat_events);

    let mut sorted_simulator_events = simulator_event_indexes
        .iter()
        .map(|idx| compacted_events[*idx].clone())
        .collect::<Vec<_>>();
    sort_simulator_events(&mut sorted_simulator_events);

    let messages_events = messages_event_indexes
        .iter()
        .map(|idx| compacted_events[*idx].clone())
        .collect::<Vec<_>>();

    let chat_event_count = chat_events.len();
    let last_event = compacted_events.last().cloned();
    let preview_indexes = build_simulator_preview_indexes(&sorted_simulator_events);
    let latest_canvas_preview = latest_canvas_preview(events);

    DerivedSnapshot {
        version,
        event_count,
        events: compacted_events,
        chat_events,
        messages_events,
        sorted_simulator_events,
        sorted_simulator_event_ids: preview_indexes.sorted_simulator_event_ids,
        event_preview_by_id: preview_indexes.event_preview_by_id,
        created_at_by_id: preview_indexes.created_at_by_id,
        thread_id_by_id: preview_indexes.thread_id_by_id,
        function_name_by_id: preview_indexes.function_name_by_id,
        display_status_by_id: preview_indexes.display_status_by_id,
        display_variant_by_id: preview_indexes.display_variant_by_id,
        last_event,
        event_index,
        chat_event_count,
        has_running_event,
        latest_canvas_preview,
    }
}

// =========================================================================
// Helpers
// =========================================================================

fn has_thinking_content(result: &serde_json::Value) -> bool {
    let obj = match result.as_object() {
        Some(obj) => obj,
        None => return false,
    };

    for key in &["thought", "content", "observation"] {
        if let Some(serde_json::Value::String(text)) = obj.get(*key) {
            if !text.trim().is_empty() {
                return true;
            }
        }
    }
    false
}

fn has_visible_message_content(event: &SessionEvent) -> bool {
    if let Some(obj) = event.result.as_object() {
        for key in &["content", "observation"] {
            if let Some(serde_json::Value::String(text)) = obj.get(*key) {
                if !text.trim().is_empty() {
                    return true;
                }
            }
        }
    }
    !event.display_text.trim().is_empty()
}

fn is_turn_summary_event(event: &SessionEvent) -> bool {
    event.display_variant == EventDisplayVariant::Summary
        || event.function_name == "turn_summary"
        || event.ui_canonical == "turn_summary"
}

fn chat_sort_rank(event: &SessionEvent) -> u8 {
    if is_turn_summary_event(event) {
        return 1;
    }
    0
}

fn chat_sort_cmp(a: &SessionEvent, b: &SessionEvent) -> Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| chat_sort_rank(a).cmp(&chat_sort_rank(b)))
        .then_with(|| a.id.cmp(&b.id))
}

/// Sort events by chat timeline order only if the array is not already sorted.
pub(crate) fn sort_if_unsorted(events: &mut [SessionEvent]) {
    if events.len() <= 1 {
        return;
    }
    let needs_sort = events
        .windows(2)
        .any(|pair| chat_sort_cmp(&pair[0], &pair[1]) == Ordering::Greater);
    if needs_sort {
        events.sort_by(chat_sort_cmp);
    }
}

/// Sort simulator events by createdAt then id, skipping if already sorted.
pub(crate) fn sort_simulator_events(events: &mut [SessionEvent]) {
    if events.len() <= 1 {
        return;
    }
    let needs_sort = events.windows(2).any(|pair| {
        let ord = pair[0].created_at.cmp(&pair[1].created_at);
        ord == std::cmp::Ordering::Greater
            || (ord == std::cmp::Ordering::Equal && pair[0].id > pair[1].id)
    });
    if needs_sort {
        events.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
    }
}

#[cfg(test)]
#[path = "tests/derived_tests.rs"]
mod tests;
