//! Unified event handler for agent sessions.
//!
//! `UnifiedEventHandler` is the one `TurnEventHandler` implementation used
//! by every session type. Behavior is driven by capability flags on
//! [`EventHandlerConfig`] (workspace_path, lsp_manager, …) rather than
//! session-type checks.
//!
//! Responsibilities:
//! - Broadcast agent events over the per-session Tauri IPC channel
//!   (and tee to the debug WebSocket).
//! - Persist messages and tool-call rows.
//! - Take per-tool-call file_history snapshots so rewinds are safe under
//!   concurrent sessions against the same workspace_path.
//! - Fire `.orgii/hooks.json` user hooks for `Pre/PostToolUse`.
//! - Run LSP post-edit diagnostics for file-modifying tools.
//!
//! ## Submodule layout
//!
//! - [`event_factory`] — pure builders for `SessionEvent` rows
//! - [`snapshots`] — per-tool-call file_history capture
//! - [`wingman_tee`] — tee tool lifecycle to the Wingman bar overlay
//! - [`hooks_dispatch`] — `.orgii/hooks.json` dispatch + LSP
//! - [`helpers`] — `tool_status_preview_from_args`, `parse_hook_decision`

mod event_factory;
#[cfg(test)]
mod final_summary_event_tests;
mod helpers;
mod hooks_dispatch;
mod snapshots;
mod wingman_tee;

// Re-exported solely so `specialization::hooks::tests` can reach the helper
// at this stable path. Internal callers (`hooks_dispatch::dispatch_pre_tool`)
// use `super::helpers::parse_hook_decision` directly.
#[cfg(test)]
pub use helpers::parse_hook_decision;

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tracing::warn;

use crate::bus::broadcast_event;
use crate::bus::event_pipeline_bridge;
use crate::foundation::streaming::{StreamType, StreamingBuffer};
use crate::specialization::hooks::HookExecutor;
use crate::tools::names as tool_names;
use crate::turn_executor::{ContextUsageSnapshot, ToolHookIntervention, TurnEventHandler};
use core_types::session_event::SessionEvent;

use super::super::persistence as unified_persistence;

pub(crate) const AGENT_ORG_ASSISTANT_PERSISTENCE_ERROR_PREFIX: &str =
    "agent_org_assistant_persistence_failed:";

fn tool_result_is_error(result: &str) -> bool {
    if result.starts_with("Error") {
        return true;
    }

    let Ok(value) = serde_json::from_str::<Value>(result) else {
        return false;
    };

    match value {
        Value::String(text) => text.starts_with("Error"),
        Value::Object(object) => ["content", "observation", "error"]
            .iter()
            .filter_map(|field| object.get(*field).and_then(Value::as_str))
            .any(|text| text.starts_with("Error")),
        _ => false,
    }
}

fn should_push_assistant_event(
    has_tool_calls: bool,
    has_active_message_stream: bool,
    consumed_streamed_message: bool,
) -> bool {
    if has_active_message_stream {
        return false;
    }
    !has_tool_calls || !consumed_streamed_message
}

fn attach_turn_id(event: &mut SessionEvent, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else {
        return;
    };
    if let Some(args) = event.args.as_object_mut() {
        args.insert("turnId".to_string(), serde_json::json!(turn_id));
    }
}

/// Configuration for the unified event handler.
#[derive(Clone, Default)]
pub struct EventHandlerConfig {
    /// Workspace path for file operations.
    pub workspace_path: Option<PathBuf>,

    /// LSP manager for post-edit diagnostics.
    pub lsp_manager: Option<Arc<tokio::sync::Mutex<lsp::LspManager>>>,

    /// Tauri app handle for events.
    pub app_handle: Option<tauri::AppHandle>,

    /// Lifecycle hook executor (loaded from `.orgii/hooks.json`).
    pub hook_executor: Option<Arc<HookExecutor>>,

    /// Stable logical turn id for live stream broadcasts.
    pub turn_id: Option<String>,

    /// This Turn is a typed Coordinator GroupRoot Turn. Its events remain
    /// durable for Provider continuity and the bounded Group projection, but
    /// are never published through the ordinary Coordinator Session stream.
    pub group_projection_only: bool,

    /// Shared cancellation signal for the active turn. Live event emission must
    /// stop at the Rust boundary once this flag is set; frontend filtering is too late.
    pub cancel_flag: Option<Arc<AtomicBool>>,

    /// Synchronous active-turn generation mirror. Durable EventStore writes
    /// must match this generation when a turn id is bound.
    pub active_turn_generation: Option<Arc<parking_lot::RwLock<Option<String>>>>,

    /// Active IDE repository path for multi-root workspace tool rendering.
    pub active_repo_path: Option<String>,

    /// Agent Org worker identity used by the bounded task-lifecycle stop gate.
    /// Coordinators and non-org sessions leave this unset.
    pub agent_org_task_lifecycle: Option<AgentOrgTaskLifecycleContext>,

    /// Agent Org work-capable turns may not become terminal until their
    /// assistant EventStore rows are durably committed.
    pub require_durable_assistant_event: bool,

    /// Exact durable Agent Org Turn bound to assistant transcript writes.
    /// Ordinary Sessions leave this unset and pay no lifecycle query.
    pub agent_org_turn_intent_id: Option<String>,
}

/// Durable identity needed to verify that an Agent Org worker did not end a
/// build turn while its owned task was still `in_progress`.
#[derive(Clone, Debug)]
pub struct AgentOrgTaskLifecycleContext {
    pub run_id: String,
    pub member_id: String,
}

/// Unified event handler for agent turns.
/// Handles streaming, file tracking, and user hooks.
pub struct UnifiedEventHandler {
    config: EventHandlerConfig,
    tool_call_count: AtomicU32,
    /// Set to `true` the first time `manage_todo` is invoked during this turn.
    /// Read by the processor after `execute_turn` to decide whether to reset
    /// the nag-reminder counter.
    todo_called: AtomicBool,
    /// Set to `true` the first time the `agent` tool is invoked during this
    /// turn. Read by the processor to reset the subagent-reminder counter.
    agent_called: AtomicBool,
    /// Streaming buffer for message/thinking accumulation (Rust single source of truth).
    streaming_buffer: StreamingBuffer,
    flushed_message_sessions: Mutex<HashSet<String>>,
    /// EventStore ids of message/thinking segments flushed during the LLM
    /// response currently being received, keyed by session. When the stream
    /// errors mid-response the retry regenerates the WHOLE response, so
    /// these already-pushed segments must be retracted or they remain as
    /// duplicated orphan bubbles (`on_stream_retry`). Cleared when a
    /// response completes normally (`on_assistant_iteration_complete`) —
    /// from that point the segments are authoritative.
    retractable_stream_segments: Mutex<std::collections::HashMap<String, Vec<String>>>,
    /// Per-index accumulation of streamed `create_plan` tool args, keyed by
    /// the provider's tool-call block index. Powers the live drafting plan
    /// card: a skeleton tool_call event is pushed on block start, then
    /// `title` / partial `content` are patched in as deltas arrive. The
    /// authoritative `on_tool_call` event later overwrites the same
    /// `tool-call-{id}` row, so nothing here survives the final state.
    plan_draft_streams: Mutex<std::collections::HashMap<usize, PlanDraftStream>>,
    /// Latest context-usage token count observed via `on_context_usage`.
    /// Feeds the Stop hook's `ORGII_TOTAL_TOKENS` env var.
    last_context_tokens: std::sync::atomic::AtomicI64,
    /// The lifecycle gate may block completion at most once per logical turn.
    /// A second miss is reported durably to the coordinator by `MemberIdle`
    /// rather than looping the provider.
    agent_org_lifecycle_correction_emitted: AtomicBool,
    assistant_persistence_error: Mutex<Option<String>>,
}

/// Accumulated state for one streaming `create_plan` call.
struct PlanDraftStream {
    tool_call_id: String,
    args_buf: String,
    /// Length of `streamContent` at the last patch push — used to skip
    /// no-op patches when a delta only advanced JSON syntax.
    last_pushed_len: usize,
}

impl UnifiedEventHandler {
    fn is_cancelled(&self) -> bool {
        self.config
            .cancel_flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }

    fn is_current_turn_generation(&self) -> bool {
        let Some(bound_turn_id) = self.config.turn_id.as_deref() else {
            return true;
        };
        let Some(active_turn_generation) = self.config.active_turn_generation.as_ref() else {
            return true;
        };
        active_turn_generation
            .read()
            .as_deref()
            .is_some_and(|active_turn_id| active_turn_id == bound_turn_id)
    }

    /// Remember a flushed stream segment as retractable until the current
    /// LLM response completes successfully.
    fn track_retractable_segment(&self, session_id: &str, event_id: &str) {
        if let Ok(mut segments) = self.retractable_stream_segments.lock() {
            segments
                .entry(session_id.to_string())
                .or_default()
                .push(event_id.to_string());
        }
    }

    /// The in-flight LLM response completed successfully — its flushed
    /// segments are now authoritative and must survive any later retry.
    fn commit_retractable_segments(&self, session_id: &str) {
        if let Ok(mut segments) = self.retractable_stream_segments.lock() {
            segments.remove(session_id);
        }
    }

    /// Drain the retractable segment ids for a session (retry path).
    fn take_retractable_segments(&self, session_id: &str) -> Vec<String> {
        self.retractable_stream_segments
            .lock()
            .map(|mut segments| segments.remove(session_id).unwrap_or_default())
            .unwrap_or_default()
    }

    fn retract_streamed_segments(&self, session_id: &str) {
        let retracted = self.take_retractable_segments(session_id);
        if !retracted.is_empty() {
            if let Some(ref handle) = self.config.app_handle {
                event_pipeline_bridge::remove_events_by_ids(handle, session_id, retracted);
            }
        }
        if let Ok(mut sessions) = self.flushed_message_sessions.lock() {
            sessions.remove(session_id);
        }
    }

    /// Creates a new unified event handler.
    pub fn new(config: EventHandlerConfig) -> Self {
        Self {
            config,
            tool_call_count: AtomicU32::new(0),
            todo_called: AtomicBool::new(false),
            agent_called: AtomicBool::new(false),
            streaming_buffer: StreamingBuffer::with_default_timeout(),
            flushed_message_sessions: Mutex::new(HashSet::new()),
            retractable_stream_segments: Mutex::new(std::collections::HashMap::new()),
            plan_draft_streams: Mutex::new(std::collections::HashMap::new()),
            last_context_tokens: std::sync::atomic::AtomicI64::new(0),
            agent_org_lifecycle_correction_emitted: AtomicBool::new(false),
            assistant_persistence_error: Mutex::new(None),
        }
    }

    /// Broadcasts that drive the ordinary Session surface must never carry a
    /// GroupRoot Turn. The Group feed observes the run-scoped projection push
    /// instead, so suppressing these events does not remove product updates.
    fn broadcast_session_surface(&self, event: &'static str, payload: serde_json::Value) {
        if !self.config.group_projection_only {
            broadcast_event(event, payload);
        }
    }

    /// Drain pending message/thinking streams and broadcast the authoritative
    /// segments. The frontend `handleStreamingComplete` upserts them into
    /// the parent EventStore (retired in commit 5 in favour of a direct
    /// Rust push, as subagents already do).
    pub fn flush_streaming(&self, session_id: &str) {
        if self.is_cancelled() {
            return;
        }

        // Thinking must be flushed before the assistant message so that
        // `push_to_store` assigns a lower `history_sequence` to the thinking
        // event than to the message. SQLite orders by
        // `COALESCE(history_sequence, 0) ASC, created_at ASC`, so reversing
        // this order would render Thought *after* the answer on reload.
        if let Some(mut event) = self.streaming_buffer.complete_thinking(session_id) {
            attach_turn_id(&mut event, self.config.turn_id.as_deref());
            self.track_retractable_segment(session_id, &event.id);
            self.push_to_store(session_id, event.clone());
            self.broadcast_session_surface(
                "agent:streaming_complete",
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": self.config.turn_id.as_deref(),
                    "streamType": "thinking",
                    "event": event,
                }),
            );
        }
        if let Some(mut event) = self.streaming_buffer.complete_message(session_id) {
            attach_turn_id(&mut event, self.config.turn_id.as_deref());
            if !self.attach_final_summary_event_identity(session_id, &mut event) {
                return;
            }
            if !self.attach_agent_org_assistant_authority(session_id, &mut event) {
                return;
            }
            if let Ok(mut sessions) = self.flushed_message_sessions.lock() {
                sessions.insert(session_id.to_string());
            }
            self.track_retractable_segment(session_id, &event.id);
            self.push_to_store_durable_assistant(session_id, event.clone());
            self.broadcast_session_surface(
                "agent:streaming_complete",
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": self.config.turn_id.as_deref(),
                    "streamType": "message",
                    "event": event,
                }),
            );
        }
    }

    /// Returns the number of tool calls made during this handler's lifetime.
    pub fn tool_call_count(&self) -> u32 {
        self.tool_call_count.load(Ordering::Relaxed)
    }

    /// Returns `true` if `manage_todo` was called at least once during this
    /// turn. Used by the processor to reset the nag-reminder counter.
    pub fn todo_was_called(&self) -> bool {
        self.todo_called.load(Ordering::Relaxed)
    }

    /// Returns `true` if the `agent` tool was called at least once during
    /// this turn. Used by the processor to reset the subagent-reminder
    /// counter.
    pub fn agent_was_called(&self) -> bool {
        self.agent_called.load(Ordering::Relaxed)
    }

    pub fn take_assistant_persistence_error(&self) -> Option<String> {
        self.assistant_persistence_error
            .lock()
            .ok()
            .and_then(|mut error| error.take())
    }

    fn record_assistant_persistence_error(&self, error: String) {
        if let Ok(mut slot) = self.assistant_persistence_error.lock() {
            if slot.is_none() {
                *slot = Some(error);
            }
        }
    }

    fn push_to_store_durable_assistant(&self, session_id: &str, event: SessionEvent) {
        if self.is_cancelled() || !self.is_current_turn_generation() {
            return;
        }
        if self.config.require_durable_assistant_event {
            let summary_turn = if let Some(turn_intent_id) =
                self.config.agent_org_turn_intent_id.as_deref()
            {
                match crate::coordination::agent_org_final_summary::status_for_turn(
                    session_id,
                    turn_intent_id,
                ) {
                    Ok(Some(
                        crate::coordination::agent_org_final_summary::FinalSummaryStatus::Running
                        | crate::coordination::agent_org_final_summary::FinalSummaryStatus::Persisting,
                    )) => Some(turn_intent_id),
                    Ok(Some(_)) => {
                        self.record_assistant_persistence_error(
                            "final summary assistant event arrived outside its active receipt"
                                .to_string(),
                        );
                        return;
                    }
                    Ok(None) => None,
                    Err(error) => {
                        self.record_assistant_persistence_error(format!(
                            "final summary authority lookup failed: {error}"
                        ));
                        return;
                    }
                }
            } else {
                None
            };
            if let Some(turn_intent_id) = summary_turn {
                match crate::coordination::agent_org_final_summary::mark_persisting_for_turn(
                    session_id,
                    turn_intent_id,
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        self.record_assistant_persistence_error(
                            "final summary persisting transition was stale".to_string(),
                        );
                        return;
                    }
                    Err(error) => {
                        self.record_assistant_persistence_error(format!(
                            "final summary persisting transition failed: {error}"
                        ));
                        return;
                    }
                }
            }
            if let Err(error) = event_pipeline_bridge::persist_events(
                "agent-org-assistant-final",
                session_id,
                std::slice::from_ref(&event),
                5,
            ) {
                if let Some(turn_intent_id) = summary_turn {
                    let _ = crate::coordination::agent_org_final_summary::mark_failed_for_turn(
                        session_id,
                        turn_intent_id,
                        "event_store_error",
                    );
                }
                self.record_assistant_persistence_error(error);
                return;
            } else if let Some(turn_intent_id) = summary_turn {
                match crate::coordination::agent_org_final_summary::mark_persisted_for_turn(
                    session_id,
                    turn_intent_id,
                    &event.id,
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = crate::coordination::agent_org_final_summary::mark_failed_for_turn(
                            session_id,
                            turn_intent_id,
                            "event_store_binding_stale",
                        );
                        self.record_assistant_persistence_error(
                            "final summary EventStore binding was stale".to_string(),
                        );
                        return;
                    }
                    Err(error) => {
                        let _ = crate::coordination::agent_org_final_summary::mark_failed_for_turn(
                            session_id,
                            turn_intent_id,
                            "event_store_binding_error",
                        );
                        self.record_assistant_persistence_error(format!(
                            "final summary EventStore binding failed: {error}"
                        ));
                        return;
                    }
                }
            }
        }
        self.push_to_store(session_id, event);
    }

    pub fn verify_agent_org_completion_publication(&self, session_id: &str) {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return;
        };
        match crate::coordination::agent_org_final_summary::status_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(None) => {}
            Ok(Some(
                crate::coordination::agent_org_final_summary::FinalSummaryStatus::Persisted,
            )) => {}
            Ok(Some(crate::coordination::agent_org_final_summary::FinalSummaryStatus::Failed)) => {}
            Ok(Some(_)) => self.record_assistant_persistence_error(
                "active FinalSummaryReceipt has no persisted EventStore row".to_string(),
            ),
            Err(error) => self.record_assistant_persistence_error(format!(
                "FinalSummaryReceipt verification failed: {error}"
            )),
        }
    }

    /// Attach the exact DirectMember user fact to every durable assistant
    /// event, including streamed messages. Failure is closed: a UDW reply
    /// whose source cannot be proven is not persisted as an unowned branch.
    fn attach_agent_org_direct_reply(&self, session_id: &str, event: &mut SessionEvent) -> bool {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return true;
        };
        match crate::coordination::agent_org_turn_contexts::direct_source_event_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(Some(source_event_id)) => {
                if let Some(result) = event.result.as_object_mut() {
                    result.insert(
                        "reply_to_event_id".to_string(),
                        serde_json::Value::String(source_event_id),
                    );
                }
                true
            }
            Ok(None) => true,
            Err(error) => {
                self.record_assistant_persistence_error(format!(
                    "assistant direct-source lookup failed: {error}"
                ));
                false
            }
        }
    }

    /// Bind a Coordinator answer to the exact Group-origin Root user event.
    /// Ordinary Root answers have no marker and therefore never enter the
    /// Group projection.
    fn attach_agent_org_group_root_reply(
        &self,
        session_id: &str,
        event: &mut SessionEvent,
    ) -> bool {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return true;
        };
        match crate::coordination::agent_org_turn_contexts::group_root_source_event_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(Some(source_event_id)) => {
                let Some(result) = event.result.as_object_mut() else {
                    self.record_assistant_persistence_error(
                        "assistant GroupRoot causal reply target is not an object".to_string(),
                    );
                    return false;
                };
                result.insert(
                    "agent_org_group_root_reply".to_string(),
                    serde_json::json!({ "source_event_id": source_event_id }),
                );
                true
            }
            Ok(None) => true,
            Err(error) => {
                self.record_assistant_persistence_error(format!(
                    "assistant GroupRoot causal reply lookup failed: {error}"
                ));
                false
            }
        }
    }

    /// Bind every Direct/Group/Linked assistant event to the exact durable
    /// UDW receipt. The bounded Group projection can use this causal authority
    /// without guessing from timestamps, display names, or adjacent transcript rows.
    fn attach_agent_org_user_directed_reply(
        &self,
        session_id: &str,
        event: &mut SessionEvent,
    ) -> bool {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return true;
        };
        match crate::coordination::agent_org_user_directed_work::causal_reply_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(Some(authority)) => {
                let Some(result) = event.result.as_object_mut() else {
                    self.record_assistant_persistence_error(
                        "assistant UDW causal reply target is not an object".to_string(),
                    );
                    return false;
                };
                match serde_json::to_value(authority) {
                    Ok(authority) => {
                        result.insert("agent_org_user_directed_reply".to_string(), authority);
                        true
                    }
                    Err(error) => {
                        self.record_assistant_persistence_error(format!(
                            "assistant UDW causal reply serialization failed: {error}"
                        ));
                        false
                    }
                }
            }
            Ok(None) => true,
            Err(error) => {
                self.record_assistant_persistence_error(format!(
                    "assistant UDW causal reply lookup failed: {error}"
                ));
                false
            }
        }
    }

    /// Bind a backend-issued completion certificate to the exact final
    /// assistant event.  The model's prose is deliberately not authoritative:
    /// consumers can project Delivered only from this typed metadata.
    fn attach_agent_org_completion_certificate(
        &self,
        session_id: &str,
        event: &mut SessionEvent,
    ) -> bool {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return true;
        };
        match crate::coordination::agent_org_final_summary::certificate_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(Some(certificate)) => {
                let Some(result) = event.result.as_object_mut() else {
                    self.record_assistant_persistence_error(
                        "assistant completion certificate target is not an object".to_string(),
                    );
                    return false;
                };
                result.insert(
                    "agent_org_completion_certificate".to_string(),
                    serde_json::json!({
                        "id": certificate.id,
                        "orgRunId": certificate.org_run_id,
                        "activationGeneration": certificate.activation_generation,
                        "workRevision": certificate.work_revision,
                        "outcome": certificate.outcome,
                    }),
                );
                true
            }
            Ok(None) => true,
            Err(error) => {
                self.record_assistant_persistence_error(format!(
                    "assistant completion certificate lookup failed: {error}"
                ));
                false
            }
        }
    }

    /// Apply every persisted Agent Org authority marker to an assistant
    /// EventStore row. Both streamed and non-streamed final messages must use
    /// this one path; otherwise a streamed Delivered message could be bound to
    /// a certificate in the completion table while its own event payload still
    /// looked like untrusted model prose.
    fn attach_agent_org_assistant_authority(
        &self,
        session_id: &str,
        event: &mut SessionEvent,
    ) -> bool {
        self.attach_agent_org_group_root_reply(session_id, event)
            && self.attach_agent_org_direct_reply(session_id, event)
            && self.attach_agent_org_user_directed_reply(session_id, event)
            && self.attach_agent_org_completion_certificate(session_id, event)
    }

    fn attach_final_summary_event_identity(
        &self,
        session_id: &str,
        event: &mut SessionEvent,
    ) -> bool {
        let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() else {
            return true;
        };
        match crate::coordination::agent_org_final_summary::stable_event_id_for_turn(
            session_id,
            turn_intent_id,
        ) {
            Ok(Some(event_id)) => {
                event.id = event_id.clone();
                event.chunk_id = Some(event_id);
                true
            }
            Ok(None) => {
                let conn = match database::db::get_connection() {
                    Ok(conn) => conn,
                    Err(error) => {
                        self.record_assistant_persistence_error(format!(
                            "final summary receipt lookup failed: {error}"
                        ));
                        return false;
                    }
                };
                match crate::coordination::agent_org_final_summary::has_summary_receipt_for_turn_with_connection(
                    &conn,
                    session_id,
                    turn_intent_id,
                ) {
                    Ok(false) => true,
                    Ok(true) => {
                        self.record_assistant_persistence_error(
                            "final summary event identity is unavailable for a known receipt"
                                .to_string(),
                        );
                        false
                    }
                    Err(error) => {
                        self.record_assistant_persistence_error(format!(
                            "final summary receipt lookup failed: {error}"
                        ));
                        false
                    }
                }
            }
            Err(error) => {
                self.record_assistant_persistence_error(format!(
                    "final summary event identity lookup failed: {error}"
                ));
                false
            }
        }
    }

    /// Push a SessionEvent into the session's EventStore so frontend
    /// subscribers receive it via `es:changed`. Silently no-op when the
    /// handler was constructed without an app handle (tests / non-Tauri
    /// callers).
    fn push_to_store(&self, session_id: &str, mut event: SessionEvent) {
        if self.is_cancelled() || !self.is_current_turn_generation() {
            return;
        }

        let Some(ref handle) = self.config.app_handle else {
            return;
        };
        attach_turn_id(&mut event, self.config.turn_id.as_deref());
        if self.config.group_projection_only {
            // The final assistant event already crosses the synchronous
            // durability barrier above. Other GroupRoot events use the same
            // EventStore write-through without entering the ordinary live
            // Session store or waking its subscribers.
            event_pipeline_bridge::persist_events_async(
                "agent-org-group-projection-event",
                session_id.to_string(),
                vec![event],
                5,
            );
            return;
        }
        event_pipeline_bridge::push_events(handle, session_id, vec![event]);
    }

    fn broadcast_tool_call_delta(
        &self,
        session_id: &str,
        index: usize,
        tool_call_id: Option<&str>,
        tool_name: Option<&str>,
        arguments_delta: Option<&str>,
    ) {
        self.broadcast_session_surface(
            "agent:tool_call_delta",
            serde_json::json!({
                "sessionId": session_id,
                "turnId": self.config.turn_id.as_deref(),
                "index": index,
                "toolCallId": tool_call_id,
                "tool": tool_name,
                "argumentsDelta": arguments_delta,
            }),
        );
    }

    /// Flip `is_delta` to `false` on all TS-side streaming placeholders in
    /// the EventStore. Called right before pushing a `tool_call` event so
    /// the resulting `es:changed` snapshot already has `isDelta: false` on
    /// the assistant message — preventing the frontend from rendering a
    /// stale `StreamingCursor` during tool execution.
    fn finalize_streaming_in_store(&self, session_id: &str) {
        if self.is_cancelled() || !self.is_current_turn_generation() {
            return;
        }
        if self.config.group_projection_only {
            return;
        }

        let Some(ref handle) = self.config.app_handle else {
            return;
        };
        event_pipeline_bridge::finalize_streaming(handle, session_id);
    }
}

#[async_trait]
impl TurnEventHandler for UnifiedEventHandler {
    fn on_message_delta(&self, session_id: &str, content: &str) {
        if self.is_cancelled() {
            return;
        }

        if !self.config.group_projection_only {
            self.broadcast_session_surface(
                "agent:message_delta",
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": self.config.turn_id.as_deref(),
                    "content": content,
                }),
            );
        }
        self.streaming_buffer
            .append_message_delta(session_id, content);
    }

    fn on_thinking_delta(&self, session_id: &str, thinking: &str) {
        if self.is_cancelled() {
            return;
        }

        if !self.config.group_projection_only {
            self.broadcast_session_surface(
                "agent:thinking_delta",
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": self.config.turn_id.as_deref(),
                    "content": thinking,
                }),
            );
        }
        self.streaming_buffer
            .append_thinking_delta(session_id, thinking);
    }

    fn on_tool_call_delta(
        &self,
        session_id: &str,
        index: usize,
        tool_call_id: Option<&str>,
        tool_name: Option<&str>,
        arguments_delta: Option<&str>,
    ) {
        if self.is_cancelled() {
            return;
        }

        // A tool block starts when the provider emits id+name (Anthropic
        // `content_block_start` for a `tool_use`, OpenAI first delta of a
        // new tool_call). The arguments_delta-only deltas that follow are
        // mid-block and must not re-flush.
        //
        // Flushing here turns any pending text/thinking accumulation into
        // its own `streaming_complete` segment, so an
        // `[Text_A, Tool, Text_B]` response renders as three distinct
        // events instead of a single `Text_A+Text_B` glued blob.
        let is_block_start = tool_call_id.is_some() || tool_name.is_some();
        if is_block_start {
            self.flush_streaming(session_id);
            self.finalize_streaming_in_store(session_id);
        }

        // Live drafting plan card: when a `create_plan` block starts, push
        // a skeleton tool_call event (Running) immediately so the card
        // appears on the first frame; as argument deltas accumulate, patch
        // partial `title` / `streamContent` into the same row. The
        // authoritative `on_tool_call` later overwrites the row with final
        // args. Failure to parse partials just means the skeleton stays
        // title-less — never blocks the stream.
        if is_block_start && tool_name == Some(tool_names::CREATE_PLAN) {
            if let Some(call_id) = tool_call_id {
                if let Ok(mut streams) = self.plan_draft_streams.lock() {
                    streams.insert(
                        index,
                        PlanDraftStream {
                            tool_call_id: call_id.to_string(),
                            args_buf: String::new(),
                            last_pushed_len: 0,
                        },
                    );
                }
                let event = event_factory::build_tool_call_event(
                    session_id,
                    call_id,
                    tool_names::CREATE_PLAN,
                    "create_plan",
                    &serde_json::json!({ "streamContent": "" }),
                    self.config.active_repo_path.as_deref(),
                );
                self.push_to_store(session_id, event);
            }
        } else if let Some(delta) = arguments_delta {
            let patch = {
                let Ok(mut streams) = self.plan_draft_streams.lock() else {
                    return;
                };
                let Some(stream) = streams.get_mut(&index) else {
                    drop(streams);
                    self.broadcast_tool_call_delta(
                        session_id,
                        index,
                        tool_call_id,
                        tool_name,
                        arguments_delta,
                    );
                    return;
                };
                stream.args_buf.push_str(delta);
                let (title, content) = helpers::parse_partial_plan_args(&stream.args_buf);
                let content_len = content.as_deref().map(str::len).unwrap_or(0);
                if content_len > stream.last_pushed_len || title.is_some() {
                    stream.last_pushed_len = content_len;
                    Some((stream.tool_call_id.clone(), title, content))
                } else {
                    None
                }
            };

            if let Some((call_id, title, content)) = patch {
                if let Some(ref handle) = self.config.app_handle {
                    let mut merge_args = serde_json::Map::new();
                    if let Some(title) = title {
                        merge_args.insert("title".into(), serde_json::json!(title));
                    }
                    if let Some(content) = content {
                        merge_args.insert("streamContent".into(), serde_json::json!(content));
                    }
                    if !merge_args.is_empty() {
                        event_pipeline_bridge::update_tool_args_by_call_id(
                            handle,
                            session_id,
                            &call_id,
                            Value::Object(merge_args),
                        );
                    }
                }
            }
        }

        self.broadcast_tool_call_delta(session_id, index, tool_call_id, tool_name, arguments_delta);
    }

    fn on_context_usage(&self, session_id: &str, usage: &ContextUsageSnapshot) {
        self.last_context_tokens
            .store(usage.used_tokens, Ordering::Relaxed);
        if self.is_cancelled() {
            return;
        }

        self.broadcast_session_surface(
            "agent:context_usage",
            serde_json::json!({
                "sessionId": session_id,
                "turnId": self.config.turn_id.as_deref(),
                "contextTokens": usage.used_tokens,
                "contextUsage": usage,
                "warningLevel": usage.warning_level(),
            }),
        );
    }

    fn on_tool_call(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        display_name: &str,
        args: &Value,
    ) {
        if self.is_cancelled() {
            return;
        }

        self.tool_call_count.fetch_add(1, Ordering::Relaxed);
        if tool_name == tool_names::MANAGE_TODO {
            self.todo_called.store(true, Ordering::Relaxed);
        }
        if tool_name == tool_names::AGENT {
            self.agent_called.store(true, Ordering::Relaxed);
        }
        if tool_name == tool_names::CREATE_PLAN {
            // The authoritative event replaces the streaming skeleton row.
            if let Ok(mut streams) = self.plan_draft_streams.lock() {
                streams.retain(|_, stream| stream.tool_call_id != tool_call_id);
            }
        }

        // Flush pending streaming before tool call so message/thinking
        // streams complete before tool execution.
        self.flush_streaming(session_id);

        let args_str = args.to_string();
        if let Err(err) =
            unified_persistence::save_tool_call_msg(session_id, tool_call_id, tool_name, &args_str)
        {
            warn!("[unified_handler] Failed to persist tool call: {}", err);
        }

        // Subagent pre-start phase: inject action="assign" so the frontend
        // renders TitleOnly until AgentTool::execute patches it to "delegate"
        // with the child session id.
        let stored_args = if tool_name == tool_names::AGENT {
            let mut patched = args.clone();
            if let Some(obj) = patched.as_object_mut() {
                obj.entry("action")
                    .or_insert_with(|| serde_json::json!("assign"));
            }
            patched
        } else {
            args.clone()
        };

        // Finalize streaming placeholders (isDelta → false) so the next
        // push_to_store snapshot already carries the final state; otherwise
        // the StreamingCursor lingers until the frontend async replaceAndRemove
        // completes.
        self.finalize_streaming_in_store(session_id);

        let event = event_factory::build_tool_call_event(
            session_id,
            tool_call_id,
            tool_name,
            display_name,
            &stored_args,
            self.config.active_repo_path.as_deref(),
        );
        self.push_to_store(session_id, event);

        self.broadcast_session_surface(
            "agent:tool_call",
            serde_json::json!({
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "tool": tool_name,
                "args": stored_args,
            }),
        );

        wingman_tee::tee_tool_call(session_id, tool_name, args);
    }

    fn on_file_change(&self, session_id: &str, tool_name: &str, file_paths: &[String]) {
        if self.is_cancelled() {
            return;
        }

        let workspace_path = self
            .config
            .workspace_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        self.broadcast_session_surface(
            "agent:file_change",
            serde_json::json!({
                "sessionId": session_id,
                "tool": tool_name,
                "files": file_paths,
                "workspacePath": workspace_path,
            }),
        );
    }

    fn on_tool_result(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        display_name: &str,
        result: &str,
    ) {
        self.on_tool_result_with_metadata(
            session_id,
            tool_call_id,
            tool_name,
            display_name,
            result,
            None,
        );
    }

    fn on_tool_result_with_metadata(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        display_name: &str,
        result: &str,
        ui_metadata: Option<&crate::tools::traits::ToolUIMetadata>,
    ) {
        if let Err(err) =
            unified_persistence::save_tool_result_msg(session_id, tool_call_id, tool_name, result)
        {
            warn!("[unified_handler] Failed to persist tool result: {}", err);
        }

        if super::streaming::is_file_modifying_tool(tool_name) && tool_result_is_error(result) {
            match crate::tools::file_history::discard_tool_call_snapshots(session_id, tool_call_id)
            {
                Ok(stats) if stats.db_rows_removed > 0 || stats.manifests_removed > 0 => warn!(
                    "[unified_handler] discarded failed tool snapshot session={} tool_call_id={} tool={} db_rows={} manifests={}",
                    session_id,
                    tool_call_id,
                    tool_name,
                    stats.db_rows_removed,
                    stats.manifests_removed
                ),
                Ok(_) => {}
                Err(err) => warn!(
                    "[unified_handler] failed to discard failed tool snapshot session={} tool_call_id={} tool={}: {}",
                    session_id, tool_call_id, tool_name, err
                ),
            }
        }

        // Push into parent session's EventStore — EventStore::merge_events
        // folds this into the matching tool_call via call_id.
        let event = event_factory::build_tool_result_event(
            session_id,
            tool_call_id,
            tool_name,
            display_name,
            result,
            ui_metadata,
        );
        self.push_to_store(session_id, event);

        let preview: String = crate::utils::safe_truncate_chars_to_string(&result, 4000);
        self.broadcast_session_surface(
            "agent:tool_result",
            serde_json::json!({
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "tool": tool_name,
                "result": preview,
            }),
        );

        wingman_tee::tee_tool_result(session_id, tool_name, result);
    }

    fn on_assistant_iteration_complete(
        &self,
        session_id: &str,
        content: Option<&str>,
        has_tool_calls: bool,
        model: &str,
    ) {
        if self.is_cancelled() {
            return;
        }

        // Persist one `assistant` row per LLM iteration that produced text.
        //
        // Iterations with only tool_calls (no text) are skipped here: the
        // tool_call rows written by `on_tool_call` already carry enough
        // structure for `load_llm_history::flush_pending` to synthesize an
        // assistant-with-tool_calls envelope during replay, so an empty
        // assistant row would be redundant.
        //
        // This matches the pre-existing `processor.rs` guard shape
        // (`!response_text.is_empty()`), just moved one layer down so every
        // iteration gets a chance — previously only the final iteration did.
        let Some(text) = content else {
            self.commit_retractable_segments(session_id);
            return;
        };
        if text.is_empty() {
            self.commit_retractable_segments(session_id);
            return;
        }

        let persistence_result =
            if let Some(turn_intent_id) = self.config.agent_org_turn_intent_id.as_deref() {
                unified_persistence::save_agent_org_assistant_msg_for_turn(
                    session_id,
                    turn_intent_id,
                    text,
                    model,
                )
            } else {
                unified_persistence::save_assistant_msg(session_id, text, model)
                    .map_err(|error| error.to_string())
            };
        if let Err(err) = persistence_result {
            warn!(
                "[unified_handler] Failed to persist assistant iteration: {}",
                err
            );
            if self.config.require_durable_assistant_event {
                self.record_assistant_persistence_error(format!(
                    "assistant transcript persistence failed: {err}"
                ));
                self.retract_streamed_segments(session_id);
            }
            if self.config.agent_org_turn_intent_id.is_some() {
                return;
            }
        }

        // Only committed assistant transcript authority makes previously
        // flushed Agent Org segments final. On persistence failure the branch
        // above retracts them, so the UI cannot display an unowned success.
        self.commit_retractable_segments(session_id);

        let has_active_message_stream = self
            .streaming_buffer
            .has_stream(StreamType::Message, session_id);
        let consumed_streamed_message = self
            .flushed_message_sessions
            .lock()
            .map(|mut sessions| sessions.remove(session_id))
            .unwrap_or(false);

        if should_push_assistant_event(
            has_tool_calls,
            has_active_message_stream,
            consumed_streamed_message,
        ) {
            let mut event = event_factory::build_assistant_message_event(session_id, text);
            if !self.attach_final_summary_event_identity(session_id, &mut event) {
                return;
            }
            attach_turn_id(&mut event, self.config.turn_id.as_deref());
            if !self.attach_agent_org_assistant_authority(session_id, &mut event) {
                return;
            }
            self.push_to_store_durable_assistant(session_id, event);
        }
    }

    fn on_tool_execute_start(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        args: &Value,
    ) {
        if self.is_cancelled() {
            return;
        }

        snapshots::take_snapshot(
            self.config.workspace_path.as_deref(),
            session_id,
            tool_call_id,
            tool_name,
            args,
        );
    }

    async fn before_tool_execute(
        &self,
        session_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> Option<ToolHookIntervention> {
        hooks_dispatch::dispatch_pre_tool(
            self.config.hook_executor.as_ref(),
            session_id,
            tool_name,
            args,
        )
        .await
    }

    async fn on_turn_stop_check(&self, session_id: &str) -> Option<String> {
        if !self
            .agent_org_lifecycle_correction_emitted
            .load(Ordering::SeqCst)
        {
            if let Some(context) = self.config.agent_org_task_lifecycle.clone() {
                let feedback = tokio::task::spawn_blocking(move || {
                    super::processor::member_idle::task_lifecycle_stop_feedback(
                        &context.run_id,
                        &context.member_id,
                    )
                })
                .await
                .ok()
                .and_then(|result| match result {
                    Ok(feedback) => feedback,
                    Err(error) => {
                        tracing::warn!(
                            session_id = %session_id,
                            error = %error,
                            "failed to inspect Agent Org task lifecycle at turn stop"
                        );
                        None
                    }
                });
                if feedback.is_some()
                    && self
                        .agent_org_lifecycle_correction_emitted
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    return feedback;
                }
            }
        }
        hooks_dispatch::dispatch_stop_check(
            self.config.hook_executor.as_ref(),
            session_id,
            self.config.turn_id.as_deref(),
            self.tool_call_count.load(Ordering::Relaxed),
            self.last_context_tokens.load(Ordering::Relaxed),
        )
        .await
    }

    fn on_steering_consumed(
        &self,
        session_id: &str,
        injection: &crate::turn_executor::SteeringInjection,
    ) {
        // Consumption is the durable start of this steering intent. The
        // turn-intent state machine intentionally rejects Queued -> terminal,
        // so enter Running before either transcript outcome below.
        crate::foundation::session_bridge::update_turn_intent_status(
            session_id,
            &injection.turn_intent_id,
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Running,
        );
        // Persist the user message so the durable transcript (and the next
        // turn's reloaded history) contains it as a plain user row — the
        // in-memory <system-reminder> wrapper is a per-turn presentation.
        let message_id = match crate::session::persistence::save_user_msg(
            session_id,
            &injection.content,
            None,
        ) {
            Ok(id) => id,
            Err(err) => {
                tracing::warn!(
                    "[unified_handler] Failed to persist steering message for session {}: {}",
                    session_id,
                    err
                );
                // The injection has already been removed from the in-memory
                // steering queue and is about to be presented to the model.
                // Never leave its durable intent queued merely because the
                // transcript write failed: that would block Agent Org
                // Quiescence forever. Failed is terminal and truthfully records
                // that durable persistence did not complete.
                crate::foundation::session_bridge::update_turn_intent_status(
                    session_id,
                    &injection.turn_intent_id,
                    crate::foundation::session_bridge::TurnIntentBridgeStatus::Failed,
                );
                return;
            }
        };
        if let Some(handle) = self.config.app_handle.as_ref() {
            if let Err(err) = crate::bus::event_pipeline_bridge::persist_user_message_event(
                handle,
                session_id,
                &message_id,
                &injection.content,
                None,
                None,
                crate::bus::event_pipeline_bridge::PersistedUserMessageSource::User,
                &injection.turn_intent_id,
            ) {
                tracing::warn!(
                    session_id,
                    error = %err,
                    "[unified_handler] failed to persist steering user-message event"
                );
            }
        }
        crate::foundation::session_bridge::update_turn_intent_status(
            session_id,
            &injection.turn_intent_id,
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Completed,
        );
    }

    async fn after_tool_execute(
        &self,
        session_id: &str,
        _tool_call_id: &str,
        tool_name: &str,
        _args: &Value,
        result: &str,
        error: Option<&str>,
        duration_ms: u64,
    ) {
        hooks_dispatch::dispatch_post_tool(
            self.config.hook_executor.as_ref(),
            session_id,
            tool_name,
            result,
            error,
            duration_ms,
        )
        .await
    }

    async fn post_tool_hook(&self, tool_name: &str, args: &Value, result: &str) -> Option<String> {
        hooks_dispatch::lsp_post_edit_diagnostics(
            self.config.lsp_manager.as_ref(),
            self.config.app_handle.as_ref(),
            self.config.workspace_path.as_ref(),
            tool_name,
            args,
            result,
        )
        .await
    }

    fn on_stream_retry(
        &self,
        session_id: &str,
        kind: &str,
        attempt: u32,
        max_attempts: u32,
        backoff_ms: u64,
    ) {
        // The interrupted response will be regenerated from scratch, so
        // everything already surfaced from it must be withdrawn:
        //
        // 1. Retract flushed segments (EventStore + SQLite write-through).
        //    A response like `[Text, ToolBlock…interrupted]` has already
        //    pushed `Text` as an authoritative segment at the tool-block
        //    flush; without retraction the retry produces a near-identical
        //    second bubble (the "duplicated 'Writing 300 lines…'" bug).
        // 2. Drop any partial in-buffer accumulation so it can't prefix the
        //    regenerated text.
        // 3. Un-mark the session's flushed-message flag: the flushed segment
        //    is gone, so the retry's final text must not be suppressed by
        //    `consumed_streamed_message` in `on_assistant_iteration_complete`.
        self.retract_streamed_segments(session_id);
        self.streaming_buffer.discard_streams(session_id);

        // Low-key observability. The frontend uses this to render a footer
        // indicator ("Reconnecting… attempt N/M"). NEVER broadcast this as
        // `agent:message_delta` — that would poison the chat bubble with
        // retry internals.
        self.broadcast_session_surface(
            "agent:stream_retry",
            serde_json::json!({
                "sessionId": session_id,
                "kind": kind,
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "backoffMs": backoff_ms,
            }),
        );
    }

    fn on_stream_error_exhausted(
        &self,
        session_id: &str,
        kind: &str,
        attempts: u32,
        user_message: &str,
    ) {
        // Terminal failure. Clear the retry footer and surface a dedicated
        // error event so the frontend can render a persistent "Connection
        // failed" banner. The accompanying `final_content` injected by
        // turn_executor handles the in-chat assistant message; this event
        // is only for the footer, so the two responsibilities never
        // overlap.
        self.broadcast_session_surface(
            "agent:stream_error_exhausted",
            serde_json::json!({
                "sessionId": session_id,
                "kind": kind,
                "attempts": attempts,
                "message": user_message,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        should_push_assistant_event, AgentOrgTaskLifecycleContext, EventHandlerConfig,
        UnifiedEventHandler,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};
    use crate::turn_executor::TurnEventHandler;
    use test_helpers::test_env;

    #[tokio::test]
    async fn agent_org_lifecycle_stop_gate_corrects_at_most_once_per_turn() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("db");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
        let run = crate::coordination::agent_org_runs::AgentOrgRunStore::create(
            crate::coordination::agent_org_runs::CreateAgentOrgRunParams {
                org_id: "org-stop-gate".to_string(),
                coordinator_agent_id: "coordinator".to_string(),
                root_session_id: None,
                org_snapshot: (&crate::definitions::orgs::OrgDefinition {
                    id: "org-stop-gate".to_string(),
                    name: "Stop Gate Test Org".to_string(),
                    role: "coordinator".to_string(),
                    agent_id: "coordinator".to_string(),
                    description: None,
                    plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
                    members: vec![crate::definitions::orgs::FlatOrgMember {
                        member_id: "member-worker".to_string(),
                        name: "Worker".to_string(),
                        role: "builder".to_string(),
                        agent_id: "worker-agent".to_string(),
                        runtime_config: None,
                    }],
                    additional_task_graph_writer_member_ids: Vec::new(),
                    member_communication_links: Vec::new(),
                })
                    .into(),
                entry_mode:
                    crate::coordination::agent_org_runs::AgentOrgRunEntryMode::StandaloneSession,
                status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Running,
                work_item_id: None,
                project_slug: None,
                routine_fire_id: None,
            },
        )
        .expect("seed canonical run");
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "unfinished-build".to_string(),
            org_run_id: run.id.clone(),
            subject: "unfinished build".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-worker".to_string()),
            status: TaskStatus::InProgress,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
        })
        .expect("seed task");
        let handler = UnifiedEventHandler::new(EventHandlerConfig {
            agent_org_task_lifecycle: Some(AgentOrgTaskLifecycleContext {
                run_id: run.id,
                member_id: "member-worker".to_string(),
            }),
            ..Default::default()
        });

        let first = handler.on_turn_stop_check("member-session").await;
        assert!(first
            .as_deref()
            .is_some_and(|feedback| feedback.contains("unfinished-build")));
        assert_eq!(handler.on_turn_stop_check("member-session").await, None);
    }

    #[test]
    fn current_turn_generation_rejects_stale_bound_turn() {
        let active_turn_generation =
            Arc::new(parking_lot::RwLock::new(Some("turn-new".to_string())));
        let handler = UnifiedEventHandler::new(EventHandlerConfig {
            turn_id: Some("turn-old".to_string()),
            active_turn_generation: Some(active_turn_generation),
            ..Default::default()
        });

        assert!(!handler.is_current_turn_generation());
    }

    #[test]
    fn current_turn_generation_accepts_matching_bound_turn() {
        let active_turn_generation = Arc::new(parking_lot::RwLock::new(Some("turn-1".to_string())));
        let handler = UnifiedEventHandler::new(EventHandlerConfig {
            turn_id: Some("turn-1".to_string()),
            active_turn_generation: Some(active_turn_generation),
            ..Default::default()
        });

        assert!(handler.is_current_turn_generation());
    }

    #[test]
    fn assistant_event_pushes_for_non_streaming_text_with_tool_calls() {
        assert!(should_push_assistant_event(true, false, false));
    }

    #[test]
    fn assistant_event_skips_when_active_stream_will_flush() {
        assert!(!should_push_assistant_event(false, true, false));
    }

    #[test]
    fn assistant_event_skips_streamed_text_tool_call_duplicate() {
        assert!(!should_push_assistant_event(true, false, true));
    }

    #[test]
    fn assistant_event_pushes_terminal_text_after_prior_streamed_segment() {
        assert!(should_push_assistant_event(false, false, true));
    }

    #[test]
    fn agent_org_assistant_persistence_failure_is_retained_for_turn_owner() {
        let handler = UnifiedEventHandler::new(EventHandlerConfig {
            require_durable_assistant_event: true,
            ..Default::default()
        });
        let event = super::event_factory::build_assistant_message_event(
            "agent-org-session",
            "durable final answer",
        );

        handler.push_to_store_durable_assistant("agent-org-session", event);

        let error = handler
            .take_assistant_persistence_error()
            .expect("unregistered durable EventStore bridge must fail closed");
        assert!(error.contains("event pipeline persistence is not registered"));
        assert!(handler.take_assistant_persistence_error().is_none());
    }

    #[test]
    fn generic_assistant_event_does_not_require_synchronous_eventstore_commit() {
        let handler = UnifiedEventHandler::new(EventHandlerConfig::default());
        let event = super::event_factory::build_assistant_message_event(
            "generic-session",
            "ordinary answer",
        );

        handler.push_to_store_durable_assistant("generic-session", event);

        assert!(handler.take_assistant_persistence_error().is_none());
    }

    #[test]
    fn retractable_segments_drained_once_on_retry() {
        let handler = UnifiedEventHandler::new(EventHandlerConfig::default());
        handler.track_retractable_segment("s1", "stream-msg-s1-1");
        handler.track_retractable_segment("s1", "stream-think-s1-1");
        handler.track_retractable_segment("s2", "stream-msg-s2-1");

        let drained = handler.take_retractable_segments("s1");
        assert_eq!(drained, vec!["stream-msg-s1-1", "stream-think-s1-1"]);
        // Second drain is empty — a retry must not retract the same ids twice.
        assert!(handler.take_retractable_segments("s1").is_empty());
        // Other sessions are untouched.
        assert_eq!(
            handler.take_retractable_segments("s2"),
            vec!["stream-msg-s2-1"]
        );
    }

    #[test]
    fn committed_segments_survive_later_retry() {
        let handler = UnifiedEventHandler::new(EventHandlerConfig::default());
        handler.track_retractable_segment("s1", "stream-msg-s1-1");
        // Response completed successfully — segment becomes authoritative.
        handler.commit_retractable_segments("s1");
        // A retry in a LATER response must not retract the committed segment.
        assert!(handler.take_retractable_segments("s1").is_empty());
    }
}
