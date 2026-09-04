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
mod message_shaping;
mod orchestrator;
mod post_turn_dispatch;
mod post_turn_gate;
pub(super) mod prefetch;
mod prompt;
mod receipt_fallback;
mod setup;
mod side_query;
mod usage_recording;

pub(crate) use post_turn_gate::should_run_post_turn_work;

use std::sync::Arc;

use super::super::persistence as unified_persistence;
use super::super::types::{AgentExecMode, IdeContext};
use super::event_handler::EventHandlerConfig;
use crate::model_context::compaction::CompactionState;
use crate::model_context::microcompact::ReplacementState;
use crate::model_context::session_memory::{
    SessionMemoryCompactConfig, SessionMemoryConfig, SessionMemoryState,
};
use crate::tools::policy::ResolvedToolPolicy;

use crate::state::{AgentSession, SessionRuntime};

use prefetch::TurnPrefetchHook;

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
