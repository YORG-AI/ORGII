//! Inversion-of-control bridge to the live `EventStore` pipeline.
//!
//! `agent_core` needs to push events into per-session `EventStore` instances,
//! schedule frontend `es:changed` notifications, persist write-throughs, and
//! drive pin/unpin LRU lifecycle on subagent child sessions. Those operations
//! live in `agent_sessions::event_pipeline::commands` (the wire crate), but
//! `agent_core` must compile without depending on `agent_sessions`.
//!
//! Same pattern as [`super::register_broadcast`]: each operation has an
//! `OnceLock<fn>` slot that the wire crate fills in at startup. The slot
//! signatures are intentionally narrow — they hide both `EventStoreState`
//! (the Tauri-managed handle) and the underlying `CachedEvent` write
//! representation, so this module never needs to import either type.
//!
//! `EventStoreState` is registered as a Tauri-managed `State<'_, ...>` and
//! cannot be unregistered, so the wire-side adapter resolves it via
//! `handle.state::<EventStoreState>()` inside each closure rather than
//! requiring `agent_core` to thread it through every call site.

use std::sync::OnceLock;

use serde_json::Value;
use tauri::AppHandle;

use core_types::session_event::SessionEvent;
use core_types::session_event::ShellReplayState;

// ============================================================================
// Slot signatures
// ============================================================================

/// Push events into the session's in-memory store, schedule a frontend
/// notification, and persist the non-placeholder events to SQLite.
/// Replicates `event_pipeline::commands::push_events_to_session`.
pub type PushEventsFn = fn(handle: &AppHandle, session_id: &str, events: Vec<SessionEvent>);

/// Schedule a batched `es:changed` emit for `session_id`.
/// Replicates `event_pipeline::commands::schedule_notify`.
pub type ScheduleNotifyFn = fn(handle: &AppHandle, session_id: &str);

/// Merge `merge_args` into the last still-running spawning tool_call event
/// matching any of `function_names` and write-through to SQLite. Returns the
/// patched event id when one was found.
pub type UpdateSpawningToolArgsFn = fn(
    handle: &AppHandle,
    session_id: &str,
    function_names: &[&str],
    merge_args: Value,
) -> Option<String>;

/// Like [`UpdateSpawningToolArgsFn`] but matches by LLM-assigned `call_id`.
pub type UpdateToolArgsByCallIdFn =
    fn(handle: &AppHandle, session_id: &str, call_id: &str, merge_args: Value) -> Option<String>;

/// Update the canonical shell tool-call's bounded latest replay state by exact
/// call identity. `seed_bookmark` inserts the immutable initial watermark only
/// when that call has no bookmark on the event yet.
pub type UpdateShellReplayByCallIdFn = fn(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    state: ShellReplayState,
    seed_bookmark: bool,
) -> Result<Option<String>, String>;

/// Flip a still-running spawning tool_call (matched by `call_id`) to a
/// terminal `display_status` and write-through to SQLite. Used when a
/// background subagent finishes: its parent `agent` tool_call never receives
/// a `tool_result` (the launch message returned synchronously at spawn), so
/// without this its `display_status` stays `running` forever — stranding the
/// SubagentBlock spinner and leaving the Stop button live on a finished card.
/// `success = false` maps to `Failed`, otherwise `Completed`.
pub type CompleteToolCallByCallIdFn =
    fn(handle: &AppHandle, session_id: &str, call_id: &str, success: bool);

/// Flip `is_delta=false` on every TS-side streaming placeholder for
/// `session_id` and emit a notification when the flag flipped on at least
/// one event.
pub type FinalizeStreamingFn = fn(handle: &AppHandle, session_id: &str);

/// Toggle the session's `streaming` flag. While `true`, downstream
/// `schedule_notify` calls batch at `STREAMING_BATCH_MS`; flipping back to
/// `false` forces a final flush.
pub type SetSessionStreamingFn = fn(handle: &AppHandle, session_id: &str, streaming: bool);

/// Atomically swap a TS-placeholder event for the authoritative `event` and
/// schedule a notification.
pub type ReplaceStreamingEventFn =
    fn(handle: &AppHandle, session_id: &str, placeholder_id: &str, event: SessionEvent);

/// Remove events by exact ids from the in-memory store AND the SQLite
/// write-through, then schedule a notification. Used by stream-error
/// recovery to retract segments that belong to an aborted LLM response:
/// the retry regenerates the whole response, so the already-flushed
/// segments would otherwise remain as duplicated orphan bubbles.
pub type RemoveEventsByIdsFn = fn(handle: &AppHandle, session_id: &str, ids: Vec<String>);

/// Mark `session_id` as pinned in the LRU (subagent child sessions).
pub type PinSessionFn = fn(handle: &AppHandle, session_id: &str);

/// Unpin `session_id`; the wire side also evicts any newly-stale stores from
/// the in-memory map.
pub type UnpinSessionFn = fn(handle: &AppHandle, session_id: &str);

/// Snapshot the in-memory event list for `session_id`. Returns an empty
/// vector when the session has no live store.
pub type ReadSessionEventsFn = fn(handle: &AppHandle, session_id: &str) -> Vec<SessionEvent>;

/// Backend-authoritative finalize for a plan revision's interactive events.
/// Flips the persisted `awaiting_user` plan events (`{revision}` pending
/// card + `tool-call-{revision}` create_plan tool call) to `completed` in
/// both the in-memory store and SQLite, so a missed FE broadcast can never
/// strand them.
pub type FinalizePlanRevisionEventsFn =
    fn(handle: &AppHandle, session_id: &str, plan_revision_id: &str);

/// Persist a batch of `SessionEvent`s synchronously with retry. The wire
/// side converts each to its on-disk `CachedEvent` representation. `label`
/// is used in retry log lines.
pub type PersistEventsFn =
    fn(label: &'static str, session_id: &str, events: &[SessionEvent], max_retries: u32);

/// Fire-and-forget variant: spawns `persist_events` onto a blocking thread.
pub type PersistEventsAsyncFn =
    fn(label: &'static str, session_id: String, events: Vec<SessionEvent>, max_retries: u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PersistedUserMessageSource {
    User,
    AgentOrgInboxTranscript,
}

impl PersistedUserMessageSource {
    pub fn is_agent_org_inbox_transcript(self) -> bool {
        matches!(self, Self::AgentOrgInboxTranscript)
    }
}

/// Persist and push a durable user-message event corresponding to an already
/// saved `agent_messages` row.
///
/// `display_text` is the pill-format string from the frontend composer (e.g.
/// `"create-skill [skill:/create-skill]"`). When `Some`, it is stored as the
/// event's `display_text` field instead of the raw agent content so that
/// re-editing a historical message re-populates the pill rather than the
/// expanded YAML. When `None` the adapter falls back to `content`.
pub type PersistUserMessageEventFn = fn(
    handle: &AppHandle,
    session_id: &str,
    message_id: &str,
    content: &str,
    display_text: Option<&str>,
    images: Option<&[String]>,
    source: PersistedUserMessageSource,
    turn_intent_id: &str,
) -> Result<(), String>;

// ============================================================================
// Slots
// ============================================================================

static PUSH_EVENTS: OnceLock<PushEventsFn> = OnceLock::new();
static SCHEDULE_NOTIFY: OnceLock<ScheduleNotifyFn> = OnceLock::new();
static UPDATE_SPAWNING_TOOL_ARGS: OnceLock<UpdateSpawningToolArgsFn> = OnceLock::new();
static UPDATE_TOOL_ARGS_BY_CALL_ID: OnceLock<UpdateToolArgsByCallIdFn> = OnceLock::new();
static UPDATE_SHELL_REPLAY_BY_CALL_ID: OnceLock<UpdateShellReplayByCallIdFn> = OnceLock::new();
static COMPLETE_TOOL_CALL_BY_CALL_ID: OnceLock<CompleteToolCallByCallIdFn> = OnceLock::new();
static FINALIZE_STREAMING: OnceLock<FinalizeStreamingFn> = OnceLock::new();
static SET_SESSION_STREAMING: OnceLock<SetSessionStreamingFn> = OnceLock::new();
static REPLACE_STREAMING_EVENT: OnceLock<ReplaceStreamingEventFn> = OnceLock::new();
static REMOVE_EVENTS_BY_IDS: OnceLock<RemoveEventsByIdsFn> = OnceLock::new();
static PIN_SESSION: OnceLock<PinSessionFn> = OnceLock::new();
static UNPIN_SESSION: OnceLock<UnpinSessionFn> = OnceLock::new();
static READ_SESSION_EVENTS: OnceLock<ReadSessionEventsFn> = OnceLock::new();
static FINALIZE_PLAN_REVISION_EVENTS: OnceLock<FinalizePlanRevisionEventsFn> = OnceLock::new();
static PERSIST_EVENTS: OnceLock<PersistEventsFn> = OnceLock::new();
static PERSIST_EVENTS_ASYNC: OnceLock<PersistEventsAsyncFn> = OnceLock::new();
static PERSIST_USER_MESSAGE_EVENT: OnceLock<PersistUserMessageEventFn> = OnceLock::new();

// ============================================================================
// Registration
// ============================================================================

/// Register every event-pipeline bridge slot in one shot. Idempotent — later
/// calls are silently ignored, which keeps tests safe across `app::run`
/// re-entry. Called from `app::run` once at startup.
#[allow(clippy::too_many_arguments)]
pub fn register(
    push_events: PushEventsFn,
    schedule_notify: ScheduleNotifyFn,
    update_spawning_tool_args: UpdateSpawningToolArgsFn,
    update_tool_args_by_call_id: UpdateToolArgsByCallIdFn,
    update_shell_replay_by_call_id: UpdateShellReplayByCallIdFn,
    complete_tool_call_by_call_id: CompleteToolCallByCallIdFn,
    finalize_streaming: FinalizeStreamingFn,
    set_session_streaming: SetSessionStreamingFn,
    replace_streaming_event: ReplaceStreamingEventFn,
    remove_events_by_ids: RemoveEventsByIdsFn,
    pin_session: PinSessionFn,
    unpin_session: UnpinSessionFn,
    read_session_events: ReadSessionEventsFn,
    finalize_plan_revision_events: FinalizePlanRevisionEventsFn,
    persist_events: PersistEventsFn,
    persist_events_async: PersistEventsAsyncFn,
    persist_user_message_event: PersistUserMessageEventFn,
) {
    let _ = PUSH_EVENTS.set(push_events);
    let _ = SCHEDULE_NOTIFY.set(schedule_notify);
    let _ = UPDATE_SPAWNING_TOOL_ARGS.set(update_spawning_tool_args);
    let _ = UPDATE_TOOL_ARGS_BY_CALL_ID.set(update_tool_args_by_call_id);
    let _ = UPDATE_SHELL_REPLAY_BY_CALL_ID.set(update_shell_replay_by_call_id);
    let _ = COMPLETE_TOOL_CALL_BY_CALL_ID.set(complete_tool_call_by_call_id);
    let _ = FINALIZE_STREAMING.set(finalize_streaming);
    let _ = SET_SESSION_STREAMING.set(set_session_streaming);
    let _ = REPLACE_STREAMING_EVENT.set(replace_streaming_event);
    let _ = REMOVE_EVENTS_BY_IDS.set(remove_events_by_ids);
    let _ = PIN_SESSION.set(pin_session);
    let _ = UNPIN_SESSION.set(unpin_session);
    let _ = READ_SESSION_EVENTS.set(read_session_events);
    let _ = FINALIZE_PLAN_REVISION_EVENTS.set(finalize_plan_revision_events);
    let _ = PERSIST_EVENTS.set(persist_events);
    let _ = PERSIST_EVENTS_ASYNC.set(persist_events_async);
    let _ = PERSIST_USER_MESSAGE_EVENT.set(persist_user_message_event);
}

// ============================================================================
// Call-site wrappers
//
// Each wrapper degrades to a `tracing::warn!` no-op when the bridge has not
// been registered (unit tests that exercise `agent_core` without bringing up
// the full Tauri runtime). This matches `super::broadcast_event`'s behaviour
// when its slot is unset.
// ============================================================================

pub fn push_events(handle: &AppHandle, session_id: &str, events: Vec<SessionEvent>) {
    if let Some(f) = PUSH_EVENTS.get() {
        f(handle, session_id, events);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] push_events called before register; dropping {} events for {}",
            events.len(),
            session_id
        );
    }
}

pub fn schedule_notify(handle: &AppHandle, session_id: &str) {
    if let Some(f) = SCHEDULE_NOTIFY.get() {
        f(handle, session_id);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] schedule_notify called before register for {}",
            session_id
        );
    }
}

pub fn update_spawning_tool_args(
    handle: &AppHandle,
    session_id: &str,
    function_names: &[&str],
    merge_args: Value,
) -> Option<String> {
    match UPDATE_SPAWNING_TOOL_ARGS.get() {
        Some(f) => f(handle, session_id, function_names, merge_args),
        None => {
            tracing::warn!(
                "[event-pipeline-bridge] update_spawning_tool_args called before register for {}",
                session_id
            );
            None
        }
    }
}

pub fn update_tool_args_by_call_id(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    merge_args: Value,
) -> Option<String> {
    match UPDATE_TOOL_ARGS_BY_CALL_ID.get() {
        Some(f) => f(handle, session_id, call_id, merge_args),
        None => {
            tracing::warn!(
                "[event-pipeline-bridge] update_tool_args_by_call_id called before register for {}",
                session_id
            );
            None
        }
    }
}

pub fn update_shell_replay_by_call_id(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    state: ShellReplayState,
    seed_bookmark: bool,
) -> Result<Option<String>, String> {
    match UPDATE_SHELL_REPLAY_BY_CALL_ID.get() {
        Some(f) => f(handle, session_id, call_id, state, seed_bookmark),
        None => {
            tracing::warn!(
                "[event-pipeline-bridge] update_shell_replay_by_call_id called before register for {}",
                session_id
            );
            Ok(None)
        }
    }
}

pub fn complete_tool_call_by_call_id(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    success: bool,
) {
    if let Some(f) = COMPLETE_TOOL_CALL_BY_CALL_ID.get() {
        f(handle, session_id, call_id, success);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] complete_tool_call_by_call_id called before register for {}",
            session_id
        );
    }
}

pub fn finalize_streaming(handle: &AppHandle, session_id: &str) {
    if let Some(f) = FINALIZE_STREAMING.get() {
        f(handle, session_id);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] finalize_streaming called before register for {}",
            session_id
        );
    }
}

pub fn set_session_streaming(handle: &AppHandle, session_id: &str, streaming: bool) {
    if let Some(f) = SET_SESSION_STREAMING.get() {
        f(handle, session_id, streaming);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] set_session_streaming called before register for {}",
            session_id
        );
    }
}

pub fn replace_streaming_event(
    handle: &AppHandle,
    session_id: &str,
    placeholder_id: &str,
    event: SessionEvent,
) {
    if let Some(f) = REPLACE_STREAMING_EVENT.get() {
        f(handle, session_id, placeholder_id, event);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] replace_streaming_event called before register for {}",
            session_id
        );
    }
}

pub fn remove_events_by_ids(handle: &AppHandle, session_id: &str, ids: Vec<String>) {
    if let Some(f) = REMOVE_EVENTS_BY_IDS.get() {
        f(handle, session_id, ids);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] remove_events_by_ids called before register; dropping {} removals for {}",
            ids.len(),
            session_id
        );
    }
}

pub fn pin_session(handle: &AppHandle, session_id: &str) {
    if let Some(f) = PIN_SESSION.get() {
        f(handle, session_id);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] pin_session called before register for {}",
            session_id
        );
    }
}

pub fn unpin_session(handle: &AppHandle, session_id: &str) {
    if let Some(f) = UNPIN_SESSION.get() {
        f(handle, session_id);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] unpin_session called before register for {}",
            session_id
        );
    }
}

pub fn read_session_events(handle: &AppHandle, session_id: &str) -> Vec<SessionEvent> {
    match READ_SESSION_EVENTS.get() {
        Some(f) => f(handle, session_id),
        None => {
            tracing::warn!(
                "[event-pipeline-bridge] read_session_events called before register for {}",
                session_id
            );
            Vec::new()
        }
    }
}

pub fn finalize_plan_revision_events(handle: &AppHandle, session_id: &str, plan_revision_id: &str) {
    if let Some(f) = FINALIZE_PLAN_REVISION_EVENTS.get() {
        f(handle, session_id, plan_revision_id);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] finalize_plan_revision_events called before register for {}",
            session_id
        );
    }
}

pub fn persist_events(
    label: &'static str,
    session_id: &str,
    events: &[SessionEvent],
    max_retries: u32,
) {
    if let Some(f) = PERSIST_EVENTS.get() {
        f(label, session_id, events, max_retries);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] persist_events ({}) called before register for {}",
            label,
            session_id
        );
    }
}

pub fn persist_events_async(
    label: &'static str,
    session_id: String,
    events: Vec<SessionEvent>,
    max_retries: u32,
) {
    if let Some(f) = PERSIST_EVENTS_ASYNC.get() {
        f(label, session_id, events, max_retries);
    } else {
        tracing::warn!(
            "[event-pipeline-bridge] persist_events_async ({}) called before register for {}",
            label,
            session_id
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub fn persist_user_message_event(
    handle: &AppHandle,
    session_id: &str,
    message_id: &str,
    content: &str,
    display_text: Option<&str>,
    images: Option<&[String]>,
    source: PersistedUserMessageSource,
    turn_intent_id: &str,
) -> Result<(), String> {
    if let Some(f) = PERSIST_USER_MESSAGE_EVENT.get() {
        return f(
            handle,
            session_id,
            message_id,
            content,
            display_text,
            images,
            source,
            turn_intent_id,
        );
    }
    tracing::warn!(
        "[event-pipeline-bridge] persist_user_message_event called before register for {}",
        session_id
    );
    if source.is_agent_org_inbox_transcript() {
        Err(format!(
            "event pipeline is not registered; refusing to acknowledge Agent Org Inbox transcript for session {session_id}"
        ))
    } else {
        // Preserve the legacy non-fatal behavior for ordinary user input in
        // unit tests and minimal runtimes that intentionally omit the UI bus.
        Ok(())
    }
}
