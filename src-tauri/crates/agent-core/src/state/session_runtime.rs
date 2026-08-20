//! Per-session agent resources.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::definitions::AgentDefinition;
use crate::definitions::SessionMode;
use crate::interaction::mode_switch::ModeSwitchManager;
use crate::interaction::permission::AgentPermissionManager;
use crate::interaction::plan_approval::PlanApprovalManager;
use crate::interaction::question::QuestionManager;
use crate::interaction::secret_broker::SecretBroker;
use crate::memory::workspace_memory::auto_dream::AutoDreamState;
use crate::memory::workspace_memory::extract::ExtractMemoriesState;
use crate::memory::workspace_memory::surface_state::WorkspaceMemorySurfaceState;
use crate::model_context::compaction::CompactionState;
use crate::model_context::session_memory::SessionMemoryState;
use crate::providers::traits::LLMProvider;
use crate::session::plan_mode::{
    LastNonPlanModeCache, PlanSlotCache, PrePlanModeCache, RequestedExecModeCache,
};
use crate::session::prompt::cache::{
    LearningsPromptCache, PromptCacheBreakTracker, PromptCacheInvalidationReason,
    SessionPromptCache, SkillListingCache,
};
use crate::session::wingman::WingmanSessionState;
use crate::session::workspace::SessionWorkspace;
use crate::session::{DialogScheduler, DialogTurn, DialogTurnState, TurnStats};
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::state::control_flow::CancelReason;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

/// Runtime resources for a single agent session.
///
/// Each session gets its own provider, tool registry, and policy so that
/// multiple sessions can run concurrently with different models or projects.
pub struct SessionRuntime {
    /// LLM provider for this session.
    pub provider: Arc<dyn LLMProvider>,
    /// Tool registry for this session.
    pub tool_registry: Arc<ToolRegistry>,
    /// Resolved tool policy.
    pub policy: Arc<ResolvedToolPolicy>,
    /// Model identifier.
    pub model: String,
    /// Account ID used for this session.
    pub account_id: Option<String>,
    /// Provider override for subscription-bound native harness sessions.
    pub native_harness_type: Option<core_types::providers::NativeHarnessType>,
    /// Shared, mutable `SessionWorkspace` for this session.
    ///
    /// This is the live source of truth used by `/add-dir` / `/rm-dir`
    /// mutator commands and by file tools (`read_file`, `list_dir`,
    /// `edit_file`) for authorisation checks against
    /// `additional_directories`. The same `Arc` is shared with
    /// `ToolDeps.workspace` (so tools see mutator changes immediately
    /// without needing a tool-registry rebuild) and with the mutator
    /// handlers in `state/commands/session/workspace.rs`.
    pub workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    /// MCP tools that should skip permission prompts.
    pub mcp_auto_approved: Vec<String>,
    /// Immutable, resolved snapshot of the agent's runtime parameters
    /// (Agent resolve contract §11.3). Produced once per session by
    /// `ResolvedAgent::resolve(...)` and never mutated afterwards.
    /// All downstream code that previously read
    /// `SessionRuntime.config.{core,security,policy,...}` now reads
    /// `SessionRuntime.resolved.{selected_model_id,max_tokens,
    /// policy,tools,...}`.
    pub resolved: crate::definitions::resolved::ResolvedAgent,
    /// App-level integrations snapshot taken at session launch (plugins,
    /// nodes, web_search, databases, exec defaults).
    /// Read-only inside the session — live edits to `IntegrationsStore`
    /// only take effect at the next session launch.
    pub integrations_snapshot: crate::integrations::IntegrationsConfig,
    /// Per-session overrides that were in effect at launch (workspace,
    /// label, animate). Preserved here so runtime code can surface the
    /// caller-supplied label / animate flag without re-deriving them
    /// from the resolved snapshot.
    pub overrides: crate::session::overrides::SessionOverrides,
    /// Soul content from the custom AgentDefinition (None = default).
    pub agent_soul: Option<String>,
    /// When `true`, the prompt builder emits only the identity + minimal
    /// frame (see `AgentDefinition.sovereign_prompt`). Propagated from the
    /// resolved `AgentDefinition` at runtime-build time.
    pub sovereign_prompt: bool,
    /// Session-scoped conditional rule activator. Owns once-only activation state
    /// for markdown rule frontmatter `paths:` matches.
    pub policy_context_activator: Option<Arc<SessionScopedContextActivator>>,
    /// Agent Org execution context when this session is part of an Agent Org run.
    pub agent_org_context: Option<crate::coordination::agent_org_runs::AgentOrgRunContext>,
    /// Stable roster member id for materialized Agent Org workers.
    pub agent_org_current_member_id: Option<String>,
    /// Resolved agent definition ID (for learnings scoping).
    pub agent_definition_id: Option<String>,
}

/// An active agent session — the single source of truth for all per-session state.
///
/// All sub-resources (runtime, managers, locks) live here. `AgentAppState`
/// exposes one `sessions` map; callers retrieve an `Arc<AgentSession>` and
/// access everything through it. There are no parallel HashMaps.
pub struct AgentSession {
    // ── Identity ──────────────────────────────────────────────────────────
    /// Session ID.
    pub id: String,
    /// The resolved agent definition (inheritance applied).
    pub definition: AgentDefinition,

    // ── Runtime Resources ─────────────────────────────────────────────────
    /// Runtime resources (provider, tools, policy). Set after initialization.
    ///
    /// `None` briefly while the session is being registered before
    /// `ensure_session_initialized` completes.
    pub runtime: tokio::sync::RwLock<Option<Arc<SessionRuntime>>>,

    // ── Execution Control ─────────────────────────────────────────────────
    /// Cancellation flag — set to `true` to abort the active turn.
    pub cancel_flag: Arc<AtomicBool>,
    /// Whether the previous cancellation marker should suppress crash-repair.
    pub suppress_next_crash_repair: Arc<AtomicBool>,
    /// Whether the currently observed cancel flag should persist a next-turn marker.
    pub persist_next_cancel_marker: Arc<AtomicBool>,
    /// Processing lock — held for the duration of each turn so that
    /// concurrent requests to the same session are serialized.
    pub processing_lock: Arc<tokio::sync::Mutex<()>>,
    /// Compaction state for context window management.
    pub compaction: tokio::sync::Mutex<CompactionState>,
    /// Real context-window fill (prompt + cache_read + cache_write tokens)
    /// reported by the provider on the most recent completed turn.
    ///
    /// Feeds the pre-turn compaction trigger as a correction to the local
    /// token estimate, which systematically undercounts (images count as 0,
    /// tokenizer mismatch, sampling). `0` = unknown; reset after compaction
    /// mutates the message list so a stale reading can't re-trigger.
    pub last_context_tokens: Arc<AtomicI64>,
    /// Wall-clock time of the last user interaction, used by the idle-cleanup task.
    pub last_active_at: tokio::sync::Mutex<Instant>,

    // ── Interaction Managers ───────────────────────────────────────────────
    /// Permission manager for tool approval flows.
    pub permission_manager: Arc<AgentPermissionManager>,
    /// Question manager for structured user input.
    pub question_manager: Arc<QuestionManager>,
    /// Secret broker — out-of-band capture of API keys / passwords / OAuth
    /// tokens. The plaintext never enters the LLM transcript; the agent
    /// receives only opaque `{{secret:<token>}}` placeholders, which the
    /// `write_env_file` tool resolves at write time. See
    /// [`crate::interaction::secret_broker`] for the threat model.
    pub secret_broker: Arc<SecretBroker>,
    /// Mode switch manager (for agents with coding capability).
    pub mode_switch_manager: Option<Arc<ModeSwitchManager>>,
    /// Plan-approval manager (for agents with coding capability — drives the
    /// `agent:plan_ready_for_approval` broadcast that lights up the Build
    /// button after `create_plan`). None for agents without coding capability.
    pub plan_approval_manager: Option<Arc<PlanApprovalManager>>,
    /// Plan-file slot cache used by `create_plan` to keep iterative calls
    /// targeting the same file. Scoped per session instance but implemented
    /// as a keyed map for cheap cloning into the tool context.
    pub plan_slot_cache: PlanSlotCache,
    /// Pre-Plan mode snapshot (used by `agent_plan_approval_response`, the
    /// Build-button click handler, to restore the previous mode on approval).
    pub pre_plan_mode_cache: PrePlanModeCache,
    /// Most recent non-Plan `AgentExecMode` observed per turn. Read once
    /// on Plan-mode entry to populate `pre_plan_mode_cache`.
    pub last_non_plan_mode_cache: LastNonPlanModeCache,
    /// Coordinator-requested `AgentExecMode` override.
    /// Set by the inbox-drain side-effect path on
    /// a historical `AgentMessage::ExecModeSetRequest` from an older build;
    /// new Agent Org tasks carry execution mode on `TaskAssigned`;
    /// consumed by the next `resolve_agent_mode` call so the next turn
    /// starts in the requested mode without the LLM having to echo it.
    pub requested_exec_mode_cache: RequestedExecModeCache,

    // ── Dialog State ───────────────────────────────────────────────────────
    /// The currently executing dialog turn, if any.
    ///
    /// `Some` while a turn is running; `None` when idle.
    /// Protected by a `Mutex` so callers can replace it atomically at
    /// turn boundaries without holding the global sessions lock.
    pub active_turn: tokio::sync::Mutex<Option<DialogTurn>>,
    /// Synchronous mirror of `active_turn.turn_id` for non-async event-store
    /// write guards on hot paths.
    pub active_turn_generation: Arc<parking_lot::RwLock<Option<String>>>,
    /// Per-session FIFO message queue.
    ///
    /// All incoming messages are enqueued here and processed one at a time
    /// by the scheduler's background worker. The Tauri command returns
    /// immediately with an `EnqueueResult` — results arrive via
    /// `agent:complete` / `agent:error` broadcast events.
    pub scheduler: DialogScheduler,
    /// Mid-turn steering buffer.
    ///
    /// User messages sent while a turn is running are diverted here by
    /// `send_message_impl` and drained by the turn loop before the next LLM
    /// iteration (injected as `<system-reminder>` user messages) instead of
    /// waiting for their own turn. Cleared by Stop (same discard semantics
    /// as the scheduler queue).
    pub steering_queue: crate::turn_executor::SteeringQueue,

    // ── Background Subsystems ──────────────────────────────────────────────
    /// Wingman mode state — holds the active background observation loop.
    /// `None` handle inside means Wingman is not currently running.
    pub wingman: WingmanSessionState,
    /// L1 session-memory state. This must share the AgentSession lifetime:
    /// the processor is reconstructed per turn, while extraction is
    /// coordinator-owned and may finish after that processor is dropped.
    pub sm_state: Arc<tokio::sync::Mutex<SessionMemoryState>>,
    /// Per-session state for the background auto-dream (consolidation) hook.
    ///
    /// Carries the `last_scan_at` scan-throttle timestamp across turns.
    /// Held on the session (not inside `UnifiedMessageProcessor`) because
    /// the processor is rebuilt per turn — putting state there would reset
    /// the throttle every turn. Read by the processor via `self.session.ad_state`.
    pub ad_state: Arc<tokio::sync::Mutex<AutoDreamState>>,
    /// Per-session state for the background extract-memories hook.
    ///
    /// Carries the message cursor (`last_processed_seq`), the in-progress
    /// overlap guard, and the turns-since-last-extraction throttle counter.
    /// Pending work is lightweight and coordinator-owned; this state never
    /// retains transcript copies across turns.
    pub em_state: Arc<tokio::sync::Mutex<ExtractMemoriesState>>,
    /// Rendered stable system-prompt sections for this live session.
    ///
    /// The processor is rebuilt per turn, so prompt section caching must live
    /// on the session. The cache is intentionally not persisted beyond the
    /// session lifetime.
    pub prompt_cache: Arc<tokio::sync::Mutex<SessionPromptCache>>,
    /// Rendered learnings section keyed by the live learning-set revision.
    pub learnings_prompt_cache: Arc<tokio::sync::Mutex<LearningsPromptCache>>,
    /// Rendered skill listing attachment keyed by session-stable skills config.
    ///
    /// The listing is currently injected as dynamic context, but its inputs are
    /// captured at session launch. Caching it removes repeated filesystem scans
    /// from the per-turn hot path after the first prompt build.
    pub skill_listing_cache: Arc<tokio::sync::Mutex<SkillListingCache>>,
    /// Bounded per-session prompt-cache effectiveness tracker.
    pub prompt_cache_break_tracker: Arc<tokio::sync::Mutex<PromptCacheBreakTracker>>,
    /// Workspace-memory paths already injected into prompts for this session.
    ///
    /// This is prompt-injection bookkeeping, not runtime configuration: it
    /// lives on the session so it survives per-turn processor rebuilds, and it
    /// is intentionally not persisted beyond the session lifetime.
    pub workspace_memory_surface_state: Arc<tokio::sync::Mutex<WorkspaceMemorySurfaceState>>,
}

impl AgentSession {
    /// Create a new agent session with no runtime yet attached.
    pub fn new(id: String, definition: AgentDefinition) -> Self {
        // (mode_switch_manager is constructed after cancel_flag so it can
        // observe the Stop button — see below.)
        let has_mode_switch = definition
            .capabilities
            .as_ref()
            .and_then(|c| c.coding.as_ref())
            .map(|c| c.mode_switch)
            .unwrap_or(false);

        let session_id_for_scheduler = id.clone();

        // Shared cancel flag: session + any manager that needs cancel-aware
        // waits (see *Manager::with_cancel_flag). Must be built before the
        // managers that observe it.
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let permission_manager = Arc::new(AgentPermissionManager::for_agent_with_cancel_flag(
            &definition.id,
            Arc::clone(&cancel_flag),
        ));

        let mode_switch_manager = if has_mode_switch {
            Some(Arc::new(ModeSwitchManager::with_cancel_flag(Arc::clone(
                &cancel_flag,
            ))))
        } else {
            None
        };

        // Plan-approval manager: same gating as mode_switch (coding-only).
        // The Plan-mode tool (`create_plan`) and any non-coding agent that
        // somehow reached Plan would simply be unable to light up the Build
        // button (the manager is absent, so `create_plan` reports
        // `submitted_for_review: false` and the file is just written to
        // disk). Single capability switch.
        //
        // Under the non-blocking flow the manager does not own a cancel_flag —
        // `cancel_active_turn()` clears any pending snapshot
        // directly via `clear_silently()`.
        let plan_approval_manager = if has_mode_switch {
            Some(Arc::new(PlanApprovalManager::new()))
        } else {
            None
        };

        Self {
            id,
            definition,
            runtime: tokio::sync::RwLock::new(None),
            compaction: tokio::sync::Mutex::new(CompactionState::default()),
            last_context_tokens: Arc::new(AtomicI64::new(0)),
            permission_manager,
            question_manager: Arc::new(QuestionManager::with_cancel_flag(Arc::clone(&cancel_flag))),
            secret_broker: Arc::new(SecretBroker::with_cancel_flag(Arc::clone(&cancel_flag))),
            mode_switch_manager,
            plan_approval_manager,
            plan_slot_cache: PlanSlotCache::new(),
            pre_plan_mode_cache: PrePlanModeCache::new(),
            last_non_plan_mode_cache: LastNonPlanModeCache::new(),
            requested_exec_mode_cache: RequestedExecModeCache::new(),
            cancel_flag,
            suppress_next_crash_repair: Arc::new(AtomicBool::new(false)),
            persist_next_cancel_marker: Arc::new(AtomicBool::new(false)),
            processing_lock: Arc::new(tokio::sync::Mutex::new(())),
            last_active_at: tokio::sync::Mutex::new(Instant::now()),
            active_turn: tokio::sync::Mutex::new(None),
            active_turn_generation: Arc::new(parking_lot::RwLock::new(None)),
            scheduler: DialogScheduler::new(session_id_for_scheduler, 32),
            steering_queue: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            sm_state: Arc::new(tokio::sync::Mutex::new(SessionMemoryState::default())),
            em_state: Arc::new(tokio::sync::Mutex::new(ExtractMemoriesState::default())),
            ad_state: Arc::new(tokio::sync::Mutex::new(AutoDreamState::default())),
            prompt_cache: Arc::new(tokio::sync::Mutex::new(SessionPromptCache::default())),
            learnings_prompt_cache: Arc::new(tokio::sync::Mutex::new(
                LearningsPromptCache::default(),
            )),
            skill_listing_cache: Arc::new(tokio::sync::Mutex::new(SkillListingCache::default())),
            prompt_cache_break_tracker: Arc::new(tokio::sync::Mutex::new(
                PromptCacheBreakTracker::default(),
            )),
            workspace_memory_surface_state: Arc::new(tokio::sync::Mutex::new(
                WorkspaceMemorySurfaceState::default(),
            )),
            wingman: WingmanSessionState::default(),
        }
    }

    /// Attach (or replace) the runtime after initialization completes.
    pub async fn set_runtime(&self, runtime: Arc<SessionRuntime>) {
        *self.runtime.write().await = Some(runtime);
    }

    /// Return the current runtime, if initialized.
    pub async fn get_runtime(&self) -> Option<Arc<SessionRuntime>> {
        self.runtime.read().await.clone()
    }

    pub async fn invalidate_prompt_cache(&self, reason: PromptCacheInvalidationReason) {
        match reason {
            PromptCacheInvalidationReason::SessionReset
            | PromptCacheInvalidationReason::AgentDefinitionChanged
            | PromptCacheInvalidationReason::WorkspaceSnapshotChanged => {
                self.prompt_cache.lock().await.clear();
                self.learnings_prompt_cache.lock().await.clear();
                self.skill_listing_cache.lock().await.clear_all();
                self.prompt_cache_break_tracker.lock().await.clear();
            }
            PromptCacheInvalidationReason::SkillCatalogChanged => {
                self.skill_listing_cache.lock().await.clear_catalog();
            }
            PromptCacheInvalidationReason::LearningsChanged => {
                self.learnings_prompt_cache.lock().await.clear();
            }
            PromptCacheInvalidationReason::Compaction => {
                self.prompt_cache_break_tracker.lock().await.clear();
            }
            PromptCacheInvalidationReason::Resume => {
                self.skill_listing_cache
                    .lock()
                    .await
                    .suppress_next_listing();
            }
        }
        tracing::debug!(
            session_id = %self.id,
            reason = reason.as_str(),
            "invalidated prompt cache state"
        );
    }

    /// Record that the session was just used (resets idle timer).
    pub async fn refresh_last_active(&self) {
        *self.last_active_at.lock().await = Instant::now();
    }

    /// Elapsed time since last interaction.
    pub async fn idle_duration(&self) -> std::time::Duration {
        self.last_active_at.lock().await.elapsed()
    }

    /// Check if this session uses singleton mode (single global session).
    pub fn is_singleton(&self) -> bool {
        self.definition
            .session_model
            .as_ref()
            .map(|sm| sm.mode == SessionMode::Singleton)
            .unwrap_or(false)
    }

    // ── DialogTurn helpers ──────────────────────────────────────────────────

    /// Start a new dialog turn for this session.
    ///
    /// Returns the stable `turn_id` so the caller can embed it in events
    /// without holding the `active_turn` lock for the duration of processing.
    pub async fn begin_turn(&self, user_input: String) -> String {
        let turn = DialogTurn::new(user_input, Arc::clone(&self.cancel_flag));
        let turn_id = turn.turn_id.clone();
        *self.active_turn_generation.write() = Some(turn_id.clone());
        *self.active_turn.lock().await = Some(turn);
        turn_id
    }

    /// Finalize the active turn with a state and statistics.
    ///
    /// Clears `active_turn` so the session returns to idle.
    pub async fn end_turn(&self, turn_state: DialogTurnState, stats: TurnStats) {
        let mut guard: tokio::sync::MutexGuard<'_, Option<DialogTurn>> =
            self.active_turn.lock().await;
        if let Some(ref mut turn) = *guard {
            turn.finalize(turn_state, stats);
        }
        *guard = None;
        *self.active_turn_generation.write() = None;
    }

    /// Return the `turn_id` of the currently executing turn, if any.
    pub async fn active_turn_id(&self) -> Option<String> {
        self.active_turn
            .lock()
            .await
            .as_ref()
            .map(|t| t.turn_id.clone())
    }

    /// Cancel the active turn (if one is running).
    ///
    /// This is a lightweight signal: it sets the shared `cancel_flag`
    /// and lets the processor observe it on the next iteration.
    ///
    /// Depending on the reason's `boundary_effect`, this also:
    /// - discards messages already enqueued on the `DialogScheduler`
    ///   (UserStop must not let a queued Send-Now message start the
    ///   moment the cancelled turn ends);
    /// - fans out cancellation to background Delegate/Shadow workers via
    ///   their per-job flags (a worker must not keep burning tokens after
    ///   the user pressed Stop, and must not miss the parent flag's pulse).
    pub async fn cancel_active_turn(&self, reason: CancelReason) {
        let effect = reason.boundary_effect();
        self.suppress_next_crash_repair
            .store(!effect.allow_crash_repair_on_next_turn, Ordering::SeqCst);
        self.persist_next_cancel_marker
            .store(effect.persist_cancel_marker, Ordering::SeqCst);

        if effect.discard_queued_messages {
            self.scheduler.invalidate_pending();
            // Steering messages are queued user intent too — same discard
            // semantics as the scheduler queue.
            if let Ok(mut steering) = self.steering_queue.try_lock() {
                steering.clear();
            }
        }

        if effect.cancel_background_workers {
            crate::tools::impls::coding::exec::registry::cancel_subagents_for_session(&self.id);
        }

        let guard: tokio::sync::MutexGuard<'_, Option<DialogTurn>> = self.active_turn.lock().await;
        if let Some(ref turn) = *guard {
            turn.cancel();
        } else if effect.keep_pre_turn_cancel_when_idle {
            self.cancel_flag.store(true, Ordering::SeqCst);
        }
        drop(guard);

        if effect.clear_pending_approvals {
            if let Some(ref plan_approval_manager) = self.plan_approval_manager {
                plan_approval_manager.clear_silently().await;
            }
        }
    }
}
