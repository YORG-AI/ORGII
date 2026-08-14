//! Unified Message Processor
//!
//! This module provides a unified interface for processing messages across
//! all session types. It wraps `agent_core::turn_executor::execute_turn`
//! with session-level handling.
//!
//! `process()` is the orchestrator; the heavy phases live in sibling
//! files:
//!
//! - [`prompt`] — `build_system_prompt` + `build_dynamic_sections`
//! - [`compaction`] — `run_pre_turn_compaction` (microcompact +
//!   aggregate budget + LLM context compaction + compact-fork)
//! - [`execute`] — `execute_turn_with_reactive_retry`
//!   (`turn_executor::execute_turn` + ContextTooLong recovery)
//!
//! # System Prompt Generation
//!
//! System prompts are built by `prompt::builder::build_unified_system_prompt`,
//! a free function. There used to be a `SystemPromptBuilder` trait + factory,
//! but only one impl ever existed, so the trait was retired.

mod compaction;
mod execute;
pub(super) mod inbox_drain;
pub(super) mod member_idle;
mod post_turn_dispatch;
pub(super) mod prefetch;
mod prompt;
mod receipt_fallback;

use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::core::session::prompt::cache::{RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY};
use crate::core::session::types::DialogTurnState;

use super::super::persistence as unified_persistence;
use super::super::types::{AgentExecMode, IdeContext, ProcessingContext, ProcessingResult};
use super::event_handler::EventHandlerConfig;
use crate::model_context::compaction::CompactionState;
use crate::model_context::microcompact::ReplacementState;
use crate::model_context::session_memory::{
    SessionMemoryCompactConfig, SessionMemoryConfig, SessionMemoryState,
};
use crate::providers::traits::{LLMProvider, SideQueryExecution};
use crate::tools::policy::ResolvedToolPolicy;
use crate::turn_executor::{ContextUsageSnapshot, TurnResult};

use crate::state::{AgentSession, SessionRuntime};

use compaction::CompactionPhaseOutcome;
use prefetch::TurnPrefetchHook;

fn scoped_system_message(text: String, scope: RenderedSystemBlockScope) -> Value {
    serde_json::json!({
        "role": "system",
        "content": [{
            "type": "text",
            "text": text,
            (ORGII_SYSTEM_CACHE_SCOPE_KEY): scope.as_str(),
        }],
    })
}

fn reconcile_inbox_transcript_replay(
    messages: &mut Vec<Value>,
    message_count_before_inbox: usize,
    transcript_inserted: bool,
) {
    if !transcript_inserted {
        messages.truncate(message_count_before_inbox);
    }
}

// ============================================
// Per-Turn Input
// ============================================

/// Per-turn input for message processing.
///
/// Carries the data that varies per dispatch / per turn. Session-level
/// data (model, provider, tools, policy, skills, etc.) is read from
/// `Arc<SessionRuntime>` held by the processor.
#[derive(Default)]
pub struct TurnInput {
    /// User message content (raw — skill/pill expansion happens inside
    /// `process_message`).
    pub content: String,
    /// Pill-format display text from the frontend composer (e.g.
    /// `"create-skill [skill:/create-skill]"`). When present this is
    /// stored as `display_text` on the persisted event so that editing
    /// a historical message re-populates the pill, not the expanded YAML.
    pub display_text: Option<String>,
    /// Agent mode (Build/Plan/Explore/Debug/Ask/Review).
    pub agent_mode: Option<AgentExecMode>,
    /// Attached images (base64 data URLs).
    pub images: Option<Vec<String>>,
    /// IDE context snapshot.
    pub ide_context: Option<IdeContext>,
    /// User-initiated "Resume" hint.
    pub is_resume: bool,
    /// Channel identifier (gateway/channel sessions).
    pub channel: Option<String>,
    /// Chat/conversation identifier within the channel.
    pub chat_id: Option<String>,
    /// Stable logical turn id assigned when AgentSession begins the turn.
    pub turn_id: Option<String>,
    /// Canonical user-intent id minted at the user-intent boundary.
    /// See `ProcessingContext::turn_intent_id` for the design rationale —
    /// the field is carried on `TurnInput` so the entry layer (which
    /// constructs `ProcessingContext`) can forward it without re-deriving.
    pub turn_intent_id: String,
}

// ============================================
// Unified Message Processor
// ============================================

/// Unified message processor that works for all session types.
///
/// Holds `Arc<SessionRuntime>` and `Arc<AgentSession>` as single sources
/// of truth — session-level data (model, provider, tools, policy, skills,
/// memory config, etc.) is read directly from the runtime, and per-session
/// mutable state (em_state, ad_state, cancel_flag, etc.) is read directly
/// from the session. No intermediate relay structs.
pub struct UnifiedMessageProcessor {
    // ── Session data (single source of truth) ──────────────────────────
    runtime: Arc<SessionRuntime>,
    session: Arc<AgentSession>,

    /// Per-dispatch tool policy. Usually `Arc::clone(&runtime.policy)`,
    /// but may be rebuilt with channel context for gateway sessions.
    policy: Arc<ResolvedToolPolicy>,

    // ── Per-turn / per-dispatch fields ─────────────────────────────────
    agent_id: String,
    channel: Option<String>,
    chat_id: Option<String>,
    agent_mode: Option<AgentExecMode>,
    ide_context: Option<IdeContext>,

    // ── Infrastructure ─────────────────────────────────────────────────
    app_handle: Option<tauri::AppHandle>,
    screenshot_store: Arc<shared_state::ScreenshotStore>,
    event_handler_config: EventHandlerConfig,

    // ── Per-turn mutable state (not on session) ────────────────────────
    compaction_state: tokio::sync::Mutex<CompactionState>,
    sm_state: Arc<tokio::sync::Mutex<SessionMemoryState>>,
    sm_config: SessionMemoryConfig,
    sm_compact_config: SessionMemoryCompactConfig,
    replacement_state: tokio::sync::Mutex<ReplacementState>,
    /// Turns since the last `manage_todo` call. `None` until first use —
    /// lazily rebuilt from the persisted transcript
    /// (`turns_since_last_tool_call`) so throttling survives app restarts
    /// instead of resetting to 0 and re-arming immediately.
    rounds_since_todo: tokio::sync::Mutex<Option<u32>>,
    /// Turns since the last `agent` tool call OR last subagent reminder.
    /// Drives the periodic delegation nudge in `build_dynamic_sections`.
    /// Same lazy-rebuild semantics as `rounds_since_todo`.
    rounds_since_subagent_reminder: tokio::sync::Mutex<Option<u32>>,
    turn_prefetch_hook: tokio::sync::Mutex<Option<Arc<TurnPrefetchHook>>>,
}

/// Constructor inputs for [`UnifiedMessageProcessor::new`].
///
/// Bundles the 10 fields the processor needs at construction time so callers
/// don't have to thread positional arguments through `entry::dispatch`. Field
/// ordering matches the struct field order on [`UnifiedMessageProcessor`].
pub struct ProcessorParams {
    pub runtime: Arc<SessionRuntime>,
    pub session: Arc<AgentSession>,
    pub policy: Arc<ResolvedToolPolicy>,
    pub channel: Option<String>,
    pub chat_id: Option<String>,
    pub agent_mode: Option<AgentExecMode>,
    pub ide_context: Option<IdeContext>,
    pub app_handle: Option<tauri::AppHandle>,
    pub screenshot_store: Arc<shared_state::ScreenshotStore>,
    pub event_handler_config: EventHandlerConfig,
}

impl UnifiedMessageProcessor {
    /// Creates a new unified message processor.
    ///
    /// Reads session-level configuration directly from `runtime` and
    /// per-session mutable state from `session`. No relay structs.
    pub fn new(params: ProcessorParams) -> Self {
        let ProcessorParams {
            runtime,
            session,
            policy,
            channel,
            chat_id,
            agent_mode,
            ide_context,
            app_handle,
            screenshot_store,
            event_handler_config,
        } = params;

        // `agent_id` is the routing key for everything that operates on
        // an `AgentDefinition` (policy lookups, agent_org inbox routing,
        // member_idle notifications, learnings scoping). When the runtime
        // was assembled without a definition (legacy bare `state.set_runtime`
        // path that no longer fires, or a misconfigured agent_org spawn),
        // we fall back to `session.id` so unrelated subsystems keep
        // working — but this also silently makes inbox_drain /
        // member_idle a no-op (they query rows by `recipient_agent_id =
        // <definition_id>`, which won't match a session_id). Warn so the
        // miss is diagnosable instead of presenting as "agent_org
        // session that never receives anything".
        let agent_id = runtime.agent_definition_id.clone().unwrap_or_else(|| {
            if runtime.agent_org_context.is_some() {
                warn!(
                    session_id = %session.id,
                    "[unified_processor] agent_org session has no agent_definition_id; \
                     falling back to session.id for agent_id — inbox_drain and member_idle \
                     will not match definition-keyed rows"
                );
            } else {
                debug!(
                    session_id = %session.id,
                    "[unified_processor] runtime has no agent_definition_id; \
                     falling back to session.id for agent_id"
                );
            }
            session.id.clone()
        });

        let sm_state = Arc::clone(&session.sm_state);

        Self {
            runtime,
            session,
            policy,
            agent_id,
            channel,
            chat_id,
            agent_mode,
            ide_context,
            app_handle,
            screenshot_store,
            event_handler_config,
            compaction_state: tokio::sync::Mutex::new(CompactionState::default()),
            sm_state,
            sm_config: SessionMemoryConfig::default(),
            sm_compact_config: SessionMemoryCompactConfig::default(),
            replacement_state: tokio::sync::Mutex::new(ReplacementState::new()),
            rounds_since_todo: tokio::sync::Mutex::new(None),
            rounds_since_subagent_reminder: tokio::sync::Mutex::new(None),
            turn_prefetch_hook: tokio::sync::Mutex::new(None),
        }
    }

    /// Tool policy actually used for this turn, including the exec-mode
    /// overlay. Product mode is not a tool overlay: `org2-pm` enforces
    /// it at the application boundary via the injected ORGII_MODE.
    fn effective_tool_policy(&self) -> Arc<ResolvedToolPolicy> {
        match self.agent_mode {
            Some(mode) => Arc::new(self.policy.with_exec_mode(mode)),
            None => Arc::clone(&self.policy),
        }
    }

    /// Iteration cap for this turn: takes the lower of the session-model cap
    /// and the exec-mode cap so that read-only modes cannot loop more than
    /// their mode-specific ceiling even if the agent definition sets a higher
    /// `max_iterations` on the session model.
    pub(super) fn effective_max_iterations(&self) -> Option<u32> {
        use crate::session::AgentExecMode;
        let session_cap = super::turn_max_iterations_from_session_model(
            self.runtime.resolved.session_model.max_iterations,
        );
        let mode_cap: Option<u32> = match self.agent_mode {
            Some(AgentExecMode::Plan) => Some(30),
            Some(AgentExecMode::Ask) => Some(30),
            Some(AgentExecMode::Review) => Some(30),
            _ => None,
        };
        match (session_cap, mode_cap) {
            (Some(sc), Some(mc)) => Some(sc.min(mc)),
            (sc, mc) => sc.or(mc),
        }
    }

    /// Workspace root path from the session workspace.
    fn workspace_root(&self) -> Option<std::path::PathBuf> {
        Some(
            self.runtime
                .workspace_state
                .read()
                .working_dir()
                .to_path_buf(),
        )
    }

    /// Records a pre-message anchor snapshot in the DB so the rewind logic
    /// has a stable handle for "this user message" even when no tools end up
    /// running. The snapshot manifest itself is empty (no captured files);
    /// `event_handler::take_snapshot` adds per-tool-call snapshots as edits
    /// happen during the turn, and `file_history::rewind_to_message` walks
    /// all DB rows whose `created_at` is at-or-after the target.
    async fn take_pre_message_snapshot(&self, session_id: &str) {
        if self.event_handler_config.workspace_path.is_none() {
            return;
        }

        match crate::tools::file_history::make_snapshot(session_id) {
            Ok(snapshot_id) => {
                info!(
                    "[unified_processor] Pre-message file_history snapshot: {}",
                    snapshot_id
                );
                if let Err(err) = super::super::persistence::save_snapshot(
                    session_id,
                    "__pre_message__",
                    &snapshot_id,
                ) {
                    warn!(
                        "[unified_processor] Failed to persist pre-message snapshot row: {}",
                        err
                    );
                }
            }
            Err(err) => {
                warn!(
                    "[unified_processor] Pre-message file_history snapshot failed: {}",
                    err
                );
            }
        }
    }

    /// Records token usage for a turn.
    fn record_token_usage(&self, session_id: &str, result: &TurnResult) {
        if result.total_tokens == 0 {
            return;
        }

        let context_usage_json = result
            .context_usage_snapshot
            .clone()
            .or_else(|| {
                (result.context_tokens > 0).then(|| {
                    let context_window =
                        crate::core::providers::model_capabilities::resolve_effective_context_window(
                        &self.runtime.model,
                        self.runtime.account_id.as_deref(),
                        self.runtime
                            .resolved
                            .context_window_configured
                            .then_some(self.runtime.resolved.context_window),
                    ) as i64;
                    ContextUsageSnapshot::from_payload(
                        &result.messages,
                        &[],
                        result.context_tokens,
                        result.cache_read_tokens,
                        result.cache_write_tokens,
                        Some(context_window),
                    )
                })
            })
            .as_ref()
            .and_then(|snapshot| serde_json::to_string(snapshot).ok());

        tokio::task::block_in_place(|| {
            use crate::foundation::session_bridge::{record_token_usage, TokenUsageRow};
            if let Err(err) = record_token_usage(TokenUsageRow {
                session_id,
                session_type: crate::session::persistence::session_type::GENERIC,
                model: Some(&self.runtime.model),
                // Attribute usage to the account the runtime was built with —
                // an account switch rebuilds the runtime, so the dying turn
                // still bills the account that actually served it.
                account_id: self.runtime.account_id.as_deref(),
                input_tokens: result.prompt_tokens,
                output_tokens: result.completion_tokens,
                cache_read_tokens: result.cache_read_tokens,
                cache_write_tokens: result.cache_write_tokens,
                total_tokens: result.total_tokens,
                context_tokens: result.context_tokens,
                context_usage_json,
            }) {
                warn!("[unified_processor] Failed to record token usage: {}", err);
            }
        });
    }

    fn record_usage_telemetry(&self, session_id: &str, turn_id: &str, result: &TurnResult) {
        if result.usage_telemetry.llm_spans.is_empty()
            && result.usage_telemetry.tool_attributions.is_empty()
        {
            return;
        }

        let related_tool_call_ids_json = result
            .usage_telemetry
            .llm_spans
            .iter()
            .map(|span| serde_json::to_string(&span.related_tool_call_ids).ok())
            .collect::<Vec<_>>();

        tokio::task::block_in_place(|| {
            use crate::foundation::session_bridge::{
                record_usage_telemetry_batch, LlmUsageSpanRow, ToolUsageAttributionRow,
                UsageTelemetryBatch,
            };

            let llm_spans = result
                .usage_telemetry
                .llm_spans
                .iter()
                .zip(related_tool_call_ids_json.iter())
                .map(|(span, related_ids_json)| LlmUsageSpanRow {
                    session_id,
                    turn_id,
                    iteration_index: span.iteration_index,
                    model: Some(&self.runtime.model),
                    account_id: self.runtime.account_id.as_deref(),
                    prompt_tokens: span.prompt_tokens,
                    completion_tokens: span.completion_tokens,
                    cache_read_tokens: span.cache_read_tokens,
                    cache_write_tokens: span.cache_write_tokens,
                    total_tokens: span.total_tokens,
                    context_tokens: span.context_tokens,
                    related_tool_call_ids_json: related_ids_json.clone(),
                    context_usage_json: span.context_usage_json.clone(),
                })
                .collect::<Vec<_>>();
            let tool_attributions = result
                .usage_telemetry
                .tool_attributions
                .iter()
                .map(|attribution| ToolUsageAttributionRow {
                    session_id,
                    turn_id,
                    event_id: &attribution.event_id,
                    tool_call_id: &attribution.tool_call_id,
                    tool_name: &attribution.tool_name,
                    iteration_index: attribution.iteration_index,
                    decision_completion_tokens: attribution.decision_completion_tokens,
                    result_context_tokens: attribution.result_context_tokens,
                    followup_completion_tokens: attribution.followup_completion_tokens,
                    input_bytes: attribution.input_bytes,
                    output_bytes: attribution.output_bytes,
                    attribution_method: attribution.attribution_method.as_str(),
                })
                .collect::<Vec<_>>();

            if let Err(err) = record_usage_telemetry_batch(UsageTelemetryBatch {
                llm_spans,
                tool_attributions,
            }) {
                warn!(
                    "[unified_processor] Failed to record usage telemetry batch: {}",
                    err
                );
            }
        });
    }
}

impl UnifiedMessageProcessor {
    async fn side_query_provider(
        &self,
        session_id: &str,
        label: &str,
    ) -> Result<Arc<dyn LLMProvider>, String> {
        match self.runtime.provider.side_query_execution() {
            SideQueryExecution::SharedSession => {
                self.runtime.provider.set_session_context(session_id);
                Ok(self.runtime.provider.clone())
            }
            SideQueryExecution::IsolatedSession => {
                let workspace = self.runtime.workspace_state.read().clone();
                let provider =
                    crate::providers::factory::create_provider_with_native_harness_preflight(
                        &self.runtime.model,
                        self.runtime.account_id.as_deref(),
                        &self.runtime.resolved.reliability,
                        self.runtime.native_harness_type,
                        Some(workspace),
                    )
                    .await
                    .map_err(|err| {
                        format!("Failed to create isolated side-query provider: {err}")
                    })?;
                let provider: Arc<dyn LLMProvider> = Arc::from(provider);
                provider.set_session_context(&format!("{session_id}:{label}"));
                Ok(provider)
            }
        }
    }

    pub async fn process(
        &self,
        session_id: &str,
        content: &str,
        context: ProcessingContext,
    ) -> Result<ProcessingResult, String> {
        // 0. Use the AgentSession turn id when available so active_turn,
        // live stream broadcasts, and terminal markers describe the same turn.
        let turn_id = context
            .turn_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // Anchor for the receipt-fallback audit window: CLI writes during
        // this turn carry occurred_at >= this instant.
        let turn_started_at_ms = chrono::Utc::now().timestamp_millis();

        // Any newly accepted turn means the session is active again. Cancel
        // coordinator generations left by the prior turn (especially the
        // quiescence-debounced reflection/observation jobs) before they can
        // race the new transcript.
        crate::memory::background::cancel_memory_jobs_for_session(session_id);

        // 0b. Restore persisted SM state on first turn (lazy init)
        if self.sm_config.enabled {
            let mut sm_state = self.sm_state.lock().await;
            if !sm_state.initialized && sm_state.content.is_none() {
                let sid = session_id.to_string();
                let restored = tokio::task::block_in_place(|| {
                    unified_persistence::load_session_memory_state(&sid)
                });
                if let Ok(persisted) = restored {
                    if persisted.content.is_some() {
                        info!(
                            "[unified_processor] Restored SM state from disk for session {} ({} chars)",
                            session_id,
                            persisted.content.as_ref().map(|c| c.len()).unwrap_or(0),
                        );
                        sm_state.content = persisted.content;
                        sm_state.last_summarized_seq = persisted.last_seq;
                        sm_state.initialized = true;
                    }
                }
            }
        }

        // 1a. Take pre-message snapshot (if enabled)
        self.take_pre_message_snapshot(session_id).await;

        // 1. Persist user message
        //
        // For a Resume turn the frontend sends content="" so no new user message
        // is visible — the original user prompt that caused the error is still the
        // last user row in the DB and serves as the turn anchor.  Persisting an
        // empty string here would insert {"role":"user","content":""} into the
        // LLM history, which causes Anthropic/Kimi to return HTTP 400
        // ("text content is empty") on the very next request.
        let should_save_user_msg = !(context.is_resume && content.is_empty());
        if should_save_user_msg {
            let message_id = tokio::task::block_in_place(|| {
                unified_persistence::save_user_msg(session_id, content, context.images.as_deref())
            })
            .map_err(|err| format!("Failed to save user message: {}", err))?;

            if let Some(handle) = self.app_handle.as_ref() {
                if let Err(err) = tokio::task::block_in_place(|| {
                    crate::bus::event_pipeline_bridge::persist_user_message_event(
                        handle,
                        session_id,
                        &message_id,
                        content,
                        context.display_text.as_deref(),
                        context.images.as_deref(),
                        crate::bus::event_pipeline_bridge::PersistedUserMessageSource::User,
                        context.turn_intent_id.as_str(),
                    )
                }) {
                    tracing::warn!(
                        session_id,
                        error = %err,
                        "[unified_processor] failed to persist user-message UI event"
                    );
                }
            }
        }

        // 2. Load history once, after the user message is persisted. The provider request
        // must see the same DB snapshot; load failures must fail the turn instead of
        // silently becoming an empty transcript.
        let history =
            tokio::task::block_in_place(|| unified_persistence::load_llm_history(session_id))
                .map_err(|err| format!("Failed to load LLM history: {}", err))?;

        // 2b. Skill + memory relevance prefetch.
        //
        // Start side queries here, but do not await them on the hot path.
        // `TurnPrefetchHook` performs a
        // zero-wait collect before each LLM iteration; if a side query is still
        // pending, the first token/tool call is not delayed.
        {
            let mut hook_slot = self.turn_prefetch_hook.lock().await;
            if let Some(previous_hook) = hook_slot.take() {
                previous_hook.abort_pending();
            }
            *hook_slot = self
                .start_turn_prefetch(session_id, content, &history)
                .await;
        }

        // 3. Build system prompt, split into the stable cacheable prefix and
        // the volatile per-turn body (environment/IDE/presence/mode suffix).
        let (system_prompt, volatile_prompt) = self.build_system_prompt(session_id).await;

        // 4. Build provider messages from the already-loaded history.
        let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 3);

        // Stable system prefix (cacheable across turns).
        messages.push(scoped_system_message(
            system_prompt,
            RenderedSystemBlockScope::Session,
        ));
        messages.extend(history);

        // 4b. Interrupt/crash repair.
        //
        // A user-initiated Stop is already represented by the persisted
        // `last_turn_cancelled` bit. Consume that bit here so crash-recovery
        // heuristics do not treat the prior partial turn as an unclean crash,
        // but do not inject a synthetic user message into the next normal turn:
        // providers may over-prioritize that sentinel and answer it instead of
        // the fresh user message.
        let previous_turn_cancelled = unified_persistence::take_turn_cancelled(session_id);
        let suppress_crash_repair = self
            .session
            .suppress_next_crash_repair
            .swap(false, Ordering::SeqCst);
        if previous_turn_cancelled {
            let removed = super::super::recovery::filter_unresolved_tool_uses(&mut messages);
            info!(
                "[unified_processor] Previous turn was cancelled — consumed marker and filtered {} orphan tool_use message(s) without injecting interrupt sentinel (session={})",
                removed, session_id
            );
        }

        if context.is_resume {
            self.session
                .invalidate_prompt_cache(
                    crate::session::prompt::cache::PromptCacheInvalidationReason::Resume,
                )
                .await;
            let removed = super::super::recovery::filter_unresolved_tool_uses(&mut messages);
            if removed > 0 {
                info!(
                    "[unified_processor] Resume: filtered {} orphan tool_use message(s) for session {}",
                    removed, session_id
                );
            }
        } else if !previous_turn_cancelled
            && !suppress_crash_repair
            // With a fresh user prompt at the tail, pairing is restored by
            // `ensure_tool_result_pairing` below, and the "continue from
            // where you left off" nudge would land AFTER the fresh prompt —
            // misdirecting the model to resume stale work instead of
            // answering the user. Only run crash repair when the history
            // actually ends mid-turn.
            && messages
                .last()
                .map(crate::turn_executor::msg_role)
                != Some("user")
            && super::super::recovery::repair_interrupted_history(&mut messages)
        {
            info!(
                "[unified_processor] Repaired interrupted turn for session {}",
                session_id
            );
        }

        if super::super::recovery::ensure_tool_result_pairing(&mut messages) {
            info!(
                "[unified_processor] Normalized tool_result pairing before pre-turn context work for session {}",
                session_id
            );
        }

        // 4c. Agent-org inbox drain.
        //
        // For sessions running inside an `AgentOrgRun`, fetch every
        // unread `agent_inbox` row addressed to this agent within this
        // run, render them as a typed user attachment, and append a
        // single trailing user message — keeping the turn-boundary
        // invariant (no insertion between an open `tool_use` and its
        // `tool_result`). Sessions that don't belong to an org run
        // skip this entirely.
        //
        // Done after 4c so the skill-prefetch prefix still binds to
        // the original user input, not to the inbox attachment — the
        // attachment is its own message and stands alone.
        // The drain has two outputs:
        // 1. XML attachment appended to the in-memory provider `messages`.
        // 2. Human-readable transcript persisted as this turn's visible input.
        //
        // Persist the transcript before executing the LLM so chat history keeps
        // the same order as Claude Code team mode: incoming teammate/mailbox
        // messages are part of the turn input, not a post-response artifact.
        // Once that durable write succeeds, the inbox rows can be marked read;
        // if the LLM call fails, the next turn still sees the message through
        // normal history rather than silently losing it.
        if context.is_resume && content.trim().is_empty() {
            if let Some(org_context) = self.runtime.agent_org_context.as_ref() {
                let running = matches!(
                    crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(
                        &org_context.run_id
                    ),
                    Ok(Some(
                        crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
                    ))
                );
                if !running {
                    // Fail closed before inbox drain/provider invocation. The
                    // unread rows stay durable for a later explicit resume.
                    info!(run_id = %org_context.run_id, session_id = %session_id, "[unified_processor] queued Agent Org wake cancelled because run is no longer running");
                    return Ok(ProcessingResult {
                        turn_id,
                        ..ProcessingResult::default()
                    });
                }
            }
        }

        let message_count_before_inbox = messages.len();
        let mut inbox_had_real_input = false;
        let mut inbox_guard = self.runtime.agent_org_context.as_ref().map(|org_context| {
            inbox_drain::drain_and_render_deferred(
                org_context,
                &self.agent_id,
                self.runtime.agent_org_current_member_id.as_deref(),
                &mut messages,
                Some(self.session.as_ref()),
            )
        });
        if let Some(guard) = inbox_guard.as_mut() {
            inbox_had_real_input = guard.has_pending_input();
            if let Some(transcript_content) = guard.transcript_content() {
                if !transcript_content.trim().is_empty() {
                    let (stable_message_id, stable_intent_id) = guard
                        .transcript_identity(session_id)
                        .expect("a non-empty drained transcript has stable source row ids");
                    let (materialization, inserted) = tokio::task::block_in_place(|| {
                        unified_persistence::materialize_agent_org_inbox_transcript(
                            session_id,
                            guard.new_materialization_ids(),
                            &stable_message_id,
                            &stable_intent_id,
                            transcript_content,
                        )
                    })
                    .map_err(|err| {
                        format!("Failed to materialize Agent Org inbox transcript: {err}")
                    })?;

                    if !inserted {
                        // The stable transcript row is already part of the
                        // history loaded at the beginning of this turn. Drain
                        // appended the same attachment once more in memory;
                        // remove only that newly-rendered tail so the provider
                        // sees one copy, while leaving the source inbox rows
                        // unread until this replayed turn succeeds.
                        reconcile_inbox_transcript_replay(
                            &mut messages,
                            message_count_before_inbox,
                            inserted,
                        );
                    }
                    guard.remember_materialization(materialization);
                }
            }

            if let Some(handle) = self.app_handle.as_ref() {
                // Ensure every durable transcript has its matching stable UI
                // event on both first delivery and replay. Persistence happens
                // before the in-memory merge; failure leaves source rows unread
                // and aborts the provider call so the next Wake can repair it.
                for materialization in guard.materializations() {
                    tokio::task::block_in_place(|| {
                        crate::bus::event_pipeline_bridge::persist_user_message_event(
                            handle,
                            session_id,
                            &materialization.message_id,
                            &materialization.content,
                            None,
                            None,
                            crate::bus::event_pipeline_bridge::PersistedUserMessageSource::AgentOrgInboxTranscript,
                            &materialization.intent_id,
                        )
                    })
                    .map_err(|err| {
                        format!("Failed to persist Agent Org inbox transcript event: {err}")
                    })?;
                }
            }
        }

        // An Agent Org wake is only a doorbell. If another worker consumed the
        // work before this turn started, do not manufacture an empty user
        // nudge and spend a provider call. A later unread inbox row or
        // explicit TaskAssigned delivery will trigger a fresh wake.
        if context.is_resume
            && content.trim().is_empty()
            && self.runtime.agent_org_context.is_some()
            && !inbox_had_real_input
            && messages.len() == message_count_before_inbox
        {
            info!(session_id = %session_id, "[unified_processor] Agent Org wake had no durable work; returning WakeNoop");
            return Ok(ProcessingResult {
                turn_id,
                ..ProcessingResult::default()
            });
        }

        // 4d. Subagent-wake prefill safety net.
        //
        // A background-job completion (subagent or backgrounded shell)
        // resumes the owner with empty content (no persisted user row → same
        // round, no new bubble). But a plain SDE session has no inbox_drain
        // to append a trailing user message, so the conversation can still
        // end on the owner's last assistant turn ("已在后台启动。").
        // Providers (Anthropic, OpenAI) reject that with HTTP 400
        // "conversation must end with a user message". When a resume leaves
        // an assistant-tailed message list, append a single TRANSIENT user
        // nudge — in-memory only, never persisted, so it neither creates a
        // round nor a visible bubble. Mirrors inbox_drain's transient
        // injection, generalized to the SDE path.
        if context.is_resume {
            Self::inject_job_wake_nudge_if_needed(&mut messages, session_id);
        }

        // 5/5b/6. Pre-turn message-list compaction (microcompact +
        // aggregate budget + LLM context compaction + compact-fork).
        if let CompactionPhaseOutcome::ForkRedirect(redirect) = self
            .run_pre_turn_compaction(session_id, &mut messages)
            .await
        {
            if let Some(prefetch_hook) = self.turn_prefetch_hook.lock().await.take() {
                prefetch_hook.abort_pending();
            }
            return Ok(redirect);
        }

        // Optional MiniCPM sidecar overlay. The canonical transcript and the
        // existing automatic/manual compaction state remain untouched: this
        // replaces a validated old prefix only in the provider request view.
        // Apply it after the normal compaction pipeline so that pipeline keeps
        // its original trigger, persistence, and compact-fork semantics.
        match tokio::task::block_in_place(|| {
            crate::session::housekeeper_compaction::apply_overlay(
                session_id,
                &mut messages,
            )
        }) {
            Ok(crate::session::housekeeper_compaction::OverlayOutcome::Applied {
                covered_messages,
            }) => info!(
                "[unified_processor] Applied MiniCPM context overlay for session {} ({} canonical messages covered)",
                session_id, covered_messages
            ),
            Ok(_) => {}
            Err(err) => warn!(
                "[unified_processor] MiniCPM context overlay skipped for session {}: {}",
                session_id, err
            ),
        }

        // Build dynamic context only after every no-provider early return
        // (terminal/paused wake, WakeNoop, compact-fork redirect). For a
        // coordinator this stages the exact work revision rendered into the
        // live task-board snapshot. A later successful provider turn may
        // observe that revision; an empty wake must never consume it.
        let (dynamic_sections, coordinator_presented_work_revision) = self
            .build_dynamic_sections(session_id, None, Some(content))
            .await;

        if super::super::recovery::ensure_tool_result_pairing(&mut messages) {
            info!(
                "[unified_processor] Normalized tool_result pairing before provider request for session {}",
                session_id
            );
        }

        // 6c. Volatile context reminder — the per-turn system-prompt body
        // (environment/IDE/presence/mode suffix) plus the dynamic sections,
        // appended AFTER the history as a `<system-reminder>` user message
        // (or folded into a trailing tool result — see
        // `attach_volatile_context_reminder` for the shape guard).
        // Anything placed before the history would change every turn and
        // invalidate the provider prompt-cache prefix for the whole
        // conversation; at the tail it sits after the sliding cache
        // breakpoint instead. Never persisted — rebuilt fresh each turn.
        {
            let mut volatile_parts: Vec<String> = Vec::new();
            if !volatile_prompt.is_empty() {
                volatile_parts.push(volatile_prompt);
            }
            volatile_parts.extend(dynamic_sections);
            if !volatile_parts.is_empty() {
                crate::session::prompt::cache::attach_volatile_context_reminder(
                    &mut messages,
                    &volatile_parts.join("\n\n"),
                );
            }
        }

        // 7. Execute turn (with reactive ContextTooLong recovery).
        // Reasoning trigger words are detected on the CURRENT user input
        // only (never history) so escalation stays per-turn.
        let reasoning_trigger = crate::providers::thinking_mode::detect_reasoning_trigger(content);
        let projected_inbox_ids = inbox_guard
            .as_ref()
            .map(|guard| guard.pending_ids().to_vec())
            .unwrap_or_default();
        let turn_result = self
            .execute_turn_with_reactive_retry(
                session_id,
                &turn_id,
                &mut messages,
                reasoning_trigger,
                &context.turn_intent_id,
                projected_inbox_ids,
            )
            .await;
        if let Some(prefetch_hook) = self.turn_prefetch_hook.lock().await.take() {
            prefetch_hook.abort_pending();
        }
        let (result, handler) = turn_result?;

        let response_text = result.content.clone().unwrap_or_default();
        let tool_calls_count = handler.tool_call_count();

        // Flush any pending streaming content before completing the turn.
        handler.flush_streaming(session_id);

        // Update nag-reminder counter based on whether manage_todo was called
        // during this turn. Reset to 0 on any todo call; increment otherwise.
        // (An uninitialized counter stays None — the read path lazily rebuilds
        // it from the transcript, which already includes this turn's rows.)
        {
            let mut rounds = self.rounds_since_todo.lock().await;
            if handler.todo_was_called() {
                *rounds = Some(0);
            } else if let Some(r) = rounds.as_mut() {
                *r = r.saturating_add(1);
            }
        }

        // Same cadence tracking for the subagent-delegation reminder: an
        // `agent` call proves the model remembers delegation, so reset.
        {
            let mut rounds = self.rounds_since_subagent_reminder.lock().await;
            if handler.agent_was_called() {
                *rounds = Some(0);
            } else if let Some(r) = rounds.as_mut() {
                *r = r.saturating_add(1);
            }
        }

        // Assistant-message persistence is driven per-iteration from
        // `turn_executor::execute_turn` via `TurnEventHandler::on_assistant_iteration_complete`,
        // so the full say-then-tool-then-say transcript is preserved.

        // 8. Record token usage
        self.record_token_usage(session_id, &result);
        self.record_usage_telemetry(session_id, &turn_id, &result);

        let final_turn_state = if self
            .session
            .cancel_flag
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            DialogTurnState::Cancelled
        } else {
            DialogTurnState::Completed
        };

        // A successful provider response is not enough when the user pressed
        // Stop concurrently. Only a genuinely Completed turn acknowledges
        // Inbox input. On Cancelled, dropping the guard preserves unread rows;
        // the durable transcript receipt makes the later retry idempotent.
        if matches!(final_turn_state, DialogTurnState::Completed) {
            if let Some(guard) = inbox_guard.take() {
                guard.commit();
            }
        }

        if matches!(final_turn_state, DialogTurnState::Completed) {
            if let (Some(org_context), Some(presented_work_revision)) = (
                self.runtime.agent_org_context.as_ref(),
                coordinator_presented_work_revision,
            ) {
                if self.runtime.agent_org_current_member_id.as_deref()
                    == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID)
                {
                    let run_id = org_context.run_id.clone();
                    match tokio::task::spawn_blocking(move || {
                        crate::coordination::agent_org_runs::AgentOrgRunStore::mark_coordinator_observed_work_revision(
                            &run_id,
                            presented_work_revision,
                        )
                    })
                    .await
                    {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => warn!(
                            run_id = %org_context.run_id,
                            presented_work_revision,
                            error = %error,
                            "[unified_processor] failed to record Agent Org work revision observed by coordinator provider turn"
                        ),
                        Err(error) => warn!(
                            run_id = %org_context.run_id,
                            presented_work_revision,
                            error = %error,
                            "[unified_processor] coordinator work-revision observation task failed"
                        ),
                    }
                }
            }
        }

        info!(
            "[unified_processor] Turn {}: session={}, state={:?}, tokens={}, tool_calls={}",
            turn_id, session_id, final_turn_state, result.total_tokens, tool_calls_count
        );

        // 9–10. Post-turn dispatch (broadcast, Stop hook, CU lock,
        // session-memory / extract-memories / auto-dream / digest spawns).
        // The SM gate inputs are computed here because the dispatcher no
        // longer sees the in-memory transcript: provider-reported prompt
        // tokens when available, a local count only as fallback.
        let sm_current_tokens = if result.prompt_tokens > 0 {
            result.prompt_tokens as usize
        } else {
            crate::model_context::tokenizer::count_messages_tokens(&messages)
        };
        let sm_last_turn_has_tool_calls =
            crate::model_context::session_memory::last_turn_has_tool_calls(&messages);
        self.dispatch_post_turn_work(post_turn_dispatch::PostTurnInputs {
            session_id,
            turn_id: &turn_id,
            response_text: &response_text,
            result: &result,
            tool_calls_count,
            final_turn_state,
            turn_started_at_ms,
            sm_current_tokens,
            sm_last_turn_has_tool_calls,
        })
        .await;

        // 11. Agent-org member-idle notification.
        //
        // If this session is a worker in an agent-org run, post a
        // `MemberIdle` envelope to the coordinator's inbox so the
        // coordinator's next turn-boundary drain renders a
        // `<member_idle .../>` line and the leader's LLM is told the
        // worker is now available again. No-op for the coordinator
        // itself and for non-org sessions; see
        // `member_idle::maybe_emit_member_idle` for the gating.
        //
        // Covers success and interrupted transitions. Failed member turns
        // are emitted from lifecycle finalization after `process` returns
        // an error, so model/provider failures still notify the coordinator.
        let idle_reason = match final_turn_state {
            DialogTurnState::Cancelled => {
                crate::coordination::agent_inbox::MemberIdleReason::Interrupted
            }
            _ => crate::coordination::agent_inbox::MemberIdleReason::Available,
        };
        let unfinished_task_ids = match self
            .runtime
            .agent_org_context
            .as_ref()
            .zip(self.runtime.agent_org_current_member_id.as_deref())
        {
            Some((org_context, member_id)) => {
                match member_idle::unfinished_build_task_ids_for_member(
                    &org_context.run_id,
                    member_id,
                ) {
                    Ok(task_ids) => task_ids,
                    Err(error) => {
                        warn!(
                            run_id = %org_context.run_id,
                            member_id = %member_id,
                            error = %error,
                            "failed to inspect unfinished Agent Org tasks before MemberIdle"
                        );
                        Vec::new()
                    }
                }
            }
            None => Vec::new(),
        };
        member_idle::maybe_emit_member_idle_with_details(
            self.runtime.agent_org_context.as_ref(),
            self.runtime.agent_org_current_member_id.as_deref(),
            idle_reason,
            self.agent_mode,
            None,
            None,
            unfinished_task_ids,
        );

        Ok(ProcessingResult {
            turn_id,
            content: response_text,
            total_tokens: result.total_tokens,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            tool_calls_count,
            truncated: false,
            turn_summary: None,
            fork_redirect: None,
        })
    }

    /// Append a transient, in-memory-only trailing user message when a resumed
    /// turn's assembled message list still ends on an assistant turn.
    ///
    /// Background-job wakes (subagent or backgrounded shell completions)
    /// resume the owner with empty content (so no user row is persisted and
    /// no new round is created), but a plain SDE session has no inbox_drain
    /// to supply the trailing user message that providers require
    /// ("conversation must end with a user message"). This closes that gap
    /// without persisting anything: the nudge lives only in the provider
    /// request, never in the DB or the UI, so the owner continues in the
    /// SAME round with no synthetic bubble.
    ///
    /// No-op unless the last non-system message is an assistant message —
    /// normal resumes (e.g. mode-switch) that already end on a user or tool
    /// message are left untouched.
    fn inject_job_wake_nudge_if_needed(messages: &mut Vec<Value>, session_id: &str) {
        let last_non_system_role = messages
            .iter()
            .rev()
            .find_map(|m| m.get("role").and_then(|v| v.as_str()))
            .filter(|role| *role != "system");

        if last_non_system_role != Some("assistant") {
            return;
        }

        const WAKE_NUDGE: &str = "<system-reminder>A background job you launched (shell \
            process or subagent) has finished or needs attention. Its status and output are \
            in the Background Jobs list above. Act on it and continue the task you were \
            doing — do not re-launch finished jobs.</system-reminder>";

        messages.push(serde_json::json!({
            "role": "user",
            "content": WAKE_NUDGE,
        }));

        info!(
            "[unified_processor] Injected transient job-wake nudge to satisfy prefill (session={})",
            session_id
        );
    }
}

/// Pure helper: should post-turn background work (session memory extraction,
/// extract-memories, auto-dream) run for this turn?
///
/// These tasks are skipped whenever the turn was cancelled by the user — they
/// consume LLM tokens summarizing a turn the user explicitly stopped, and
/// racing with lifecycle teardown can surface as unhandled promise rejections
/// on the frontend. No synthetic/background work should outlive an
/// explicit cancel.
#[inline]
pub(crate) fn should_run_post_turn_work(
    feature_enabled: bool,
    final_turn_state: DialogTurnState,
) -> bool {
    feature_enabled && final_turn_state != DialogTurnState::Cancelled
}

#[cfg(test)]
mod post_turn_work_tests {
    use super::*;

    #[test]
    fn runs_when_enabled_and_completed() {
        assert!(should_run_post_turn_work(true, DialogTurnState::Completed));
    }

    #[test]
    fn skips_when_cancelled_even_if_enabled() {
        assert!(!should_run_post_turn_work(true, DialogTurnState::Cancelled));
    }

    #[test]
    fn skips_when_feature_disabled() {
        assert!(!should_run_post_turn_work(
            false,
            DialogTurnState::Completed
        ));
        assert!(!should_run_post_turn_work(
            false,
            DialogTurnState::Cancelled
        ));
    }

    #[test]
    fn persisted_unread_inbox_replay_keeps_one_prompt_copy() {
        let durable_transcript = serde_json::json!({
            "role": "user",
            "content": "<agent-org-inbox>durable transcript</agent-org-inbox>",
        });
        let mut messages = vec![durable_transcript.clone()];
        let before_inbox = messages.len();

        // `drain_and_render_deferred` re-renders the still-unread source row,
        // but the stable transcript insert reports that this exact delivery
        // was already persisted during the crashed attempt.
        messages.push(durable_transcript.clone());
        reconcile_inbox_transcript_replay(&mut messages, before_inbox, false);

        assert_eq!(messages, vec![durable_transcript]);
    }
}
