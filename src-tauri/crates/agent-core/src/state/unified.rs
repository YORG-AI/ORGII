//! Agent application state — single Tauri managed state for all agents.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::bus::AgentMessageBus;
use crate::gateway::{BindingStore, GatewayService};
use shared_state::{AgentBrowserController, ScreenshotStore};

use super::integrations_store::IntegrationsStore;
use super::session_runtime::AgentSession;
use crate::session::prompt::cache::PromptCacheInvalidationReason;

/// How long a session may sit idle in memory before the cleanup task evicts it.
const SESSION_IDLE_EVICTION_TIMEOUT: Duration = Duration::from_secs(60 * 60); // 1 hour

/// How often the cleanup task scans for idle sessions.
const SESSION_CLEANUP_INTERVAL: Duration = Duration::from_secs(60); // 1 minute

/// Agent application state — the single source of truth for all agent state.
///
/// Per-session sub-resources (runtime, managers, locks) now live inside
/// `AgentSession` itself.  There are no parallel HashMaps duplicating that
/// information; callers retrieve `Arc<AgentSession>` from `sessions` and
/// access everything through the session object.
#[derive(Clone)]
pub struct AgentAppState {
    // ═══════════════════════════════════════════════════════════════
    // Shared Resources (used by all agents)
    // ═══════════════════════════════════════════════════════════════
    /// Gateway service for external channel routing.
    pub gateway: Arc<GatewayService>,

    /// Gateway session binding cache. Pins
    /// `(channel, chat_id[, sender_id])` to a specific OS agent session so
    /// follow-up messages route directly to the bound session.
    pub gateway_bindings: Arc<BindingStore>,

    /// Pending user-facing reset/fork notices keyed by `{channel}:{chat_id}`.
    ///
    /// Written by `perform_idle_reset` and `compact_fork`
    ///; drained on the next outbound message to the same
    /// chat so the user learns their session was replaced. Hermes
    /// parallel: `gateway/run.py:3519-3551` posts the notification
    /// eagerly — we defer until the next outbound because our reset
    /// fires from the inbound path (before any LLM turn), so there is
    /// no reply channel at that moment.
    pub pending_reset_notifies: Arc<Mutex<HashMap<String, String>>>,

    /// Bounded E2E-only outbound capture buffer (debug builds only).
    /// Populated by `bus.publish_outbound` wrappers in debug code paths
    /// so `/test/gateway/outbound-snapshot` can assert on the reset-notice
    /// / compact-fork content without racing the actual channel delivery.
    /// Stores `(channel, chat_id, content)` tuples; capped at 128 entries.
    #[cfg(debug_assertions)]
    pub debug_outbound_capture: Arc<Mutex<Vec<(String, String, String)>>>,

    /// Agent browser automation controller.
    pub agent_browser: Arc<Mutex<AgentBrowserController>>,

    /// Screenshot store (shared across browser tools).
    pub screenshot_store: Arc<ScreenshotStore>,

    /// IDE action bridge for frontend ActionSystem integration.
    pub action_bridge: Arc<crate::tools::impls::web::control_orgii::ActionBridge>,

    /// Shared PTY sessions (for terminal tools).
    pub pty_sessions: Option<
        Arc<
            tauri::async_runtime::Mutex<HashMap<String, ::terminal::pty_commands::pty::PtySession>>,
        >,
    >,

    /// Tauri app handle.
    pub app_handle: Option<tauri::AppHandle>,

    // ═══════════════════════════════════════════════════════════════
    // Channel / Gateway Infrastructure (message bus, config, automation)
    // ═══════════════════════════════════════════════════════════════
    /// Agent message bus for channel/gateway routing.
    pub bus: Arc<Mutex<AgentMessageBus>>,

    /// App-level integrations store (the integrations-store contract (§11.7)). Single source of
    /// truth for `~/.orgii/integrations.json` — channels, exec, web
    /// search, default workspace, etc.
    pub integrations: Arc<IntegrationsStore>,
    // ═══════════════════════════════════════════════════════════════
    // Per-Session Registry
    // ═══════════════════════════════════════════════════════════════
    /// Active agent sessions. Key = session_id.
    ///
    /// Each `AgentSession` owns all its sub-resources (runtime, cancel_flag,
    /// permission_manager, question_manager, mode_switch_manager,
    /// processing_lock, compaction).  Do NOT add parallel maps here.
    pub sessions: Arc<Mutex<HashMap<String, Arc<AgentSession>>>>,

    /// Current account ID (for provider reinitialization detection).
    pub current_account_id: Arc<Mutex<Option<String>>>,

    /// Whether the global agent (OS/Gateway) is initialized and running.
    pub running: Arc<AtomicBool>,
}

impl AgentAppState {
    /// Create a new agent application state.
    pub fn new() -> Self {
        Self::with_browser(
            Arc::new(Mutex::new(AgentBrowserController::new())),
            Arc::new(ScreenshotStore::new()),
        )
    }

    /// Create with an existing agent browser controller and screenshot store.
    pub fn with_browser(
        agent_browser: Arc<Mutex<AgentBrowserController>>,
        screenshot_store: Arc<ScreenshotStore>,
    ) -> Self {
        // Clean up stale session registry files from a previous crash
        crate::session::file_registry::cleanup_stale_sessions(&[]);

        // First repair rows whose latest turn already wrote a durable terminal
        // marker but whose session-level status is still in-flight. This is a
        // stronger signal than startup crash cleanup: the backend observed a
        // terminal turn, so don't downgrade it to `abandoned` below.
        match crate::session::persistence::reconcile_sessions_with_terminal_turn_markers() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Reconciled {} session(s) from terminal turn markers on startup",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to reconcile terminal turn markers on startup: {}",
                err
            ),
        }

        // Mark any remaining DB sessions stuck in "running" (from a prior crash) as abandoned
        // so the frontend doesn't show phantom active sessions on reload.
        match crate::session::persistence::mark_stale_running_sessions_abandoned() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Marked {} stale running session(s) as abandoned on startup",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to clean stale sessions on startup: {}",
                err
            ),
        }

        match crate::coordination::agent_org_runs::AgentOrgRunStore::requeue_abandoned_member_tasks_on_startup() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Applied failure disposition to {} abandoned Agent Org task(s) on startup",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to recover abandoned Agent Org tasks on startup: {}",
                err
            ),
        }

        // Interventions cannot survive a process restart: their in-memory
        // sessions were abandoned above. Clear them before finality checks so
        // a fully-resolved run is not needlessly paused by an expired control
        // lease from the previous process.
        match crate::coordination::agent_member_interventions::AgentMemberInterventionStore::clear_all_active_on_startup() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Cleared {} stale member intervention(s) on startup",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to clear stale member interventions on startup: {}",
                err
            ),
        }

        // Runs whose tasks were already resolved may have been kept open only
        // by an orphaned queued intent. Close them through the normal atomic
        // finality path before pausing genuinely unfinished work.
        match crate::coordination::agent_org_runs::AgentOrgRunStore::reconcile_resolved_running_runs_on_startup() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Completed {} fully-resolved Agent Org run(s) during startup recovery",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to reconcile resolved Agent Org runs on startup: {}",
                err
            ),
        }

        // Transition any Agent Org runs that were `running` when the previous
        // process exited to `paused`. Their member sessions are now `abandoned`
        // (see above), so `reconcile_run_finality` would auto-terminate the run
        // if it remained `running`. By moving to `paused` instead, the run stays
        // visible (non-terminal) and can be resumed from the UI.
        match crate::coordination::agent_org_runs::AgentOrgRunStore::mark_all_running_as_paused_on_startup() {
            Ok(0) => {}
            Ok(n) => info!(
                "[agent-state] Paused {} Agent Org run(s) interrupted by app exit",
                n
            ),
            Err(err) => warn!(
                "[agent-state] Failed to pause interrupted Agent Org runs on startup: {}",
                err
            ),
        }

        let bus = Arc::new(Mutex::new(AgentMessageBus::new()));
        let sessions: Arc<Mutex<HashMap<String, Arc<AgentSession>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let state = Self {
            gateway: Arc::new(GatewayService::new(Arc::clone(&bus))),
            gateway_bindings: Arc::new(BindingStore::new()),
            pending_reset_notifies: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(debug_assertions)]
            debug_outbound_capture: Arc::new(Mutex::new(Vec::new())),
            agent_browser,
            screenshot_store,
            action_bridge: Arc::new(crate::tools::impls::web::control_orgii::ActionBridge::new()),
            pty_sessions: None,
            app_handle: None,
            bus,
            integrations: crate::state::integrations_store::integrations_store(),
            sessions: Arc::clone(&sessions),
            current_account_id: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
        };

        state.spawn_cleanup_task(sessions);
        state
    }

    /// Spawn a background task that evicts sessions idle longer than
    /// `SESSION_IDLE_EVICTION_TIMEOUT`.  Singleton (OS) sessions are never
    /// evicted — they must be explicitly removed.
    fn spawn_cleanup_task(&self, sessions: Arc<Mutex<HashMap<String, Arc<AgentSession>>>>) {
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(SESSION_CLEANUP_INTERVAL);
            loop {
                ticker.tick().await;

                let mut expired_ids = Vec::new();
                {
                    let guard = sessions.lock().await;
                    for (id, session) in guard.iter() {
                        if session.is_singleton() {
                            continue;
                        }
                        // A session with an executing or queued turn is NOT idle,
                        // even if the user hasn't sent a message in over an hour
                        // (refresh_last_active only fires on send_message). Evicting
                        // it mid-turn broadcasts session_evicted, which makes the
                        // frontend downgrade a genuinely-working session to idle.
                        if session.scheduler.is_processing()
                            || session.scheduler.pending_count() > 0
                        {
                            continue;
                        }
                        let idle = session.idle_duration().await;
                        if idle >= SESSION_IDLE_EVICTION_TIMEOUT {
                            expired_ids.push(id.clone());
                        }
                    }
                }

                if !expired_ids.is_empty() {
                    let mut guard = sessions.lock().await;
                    for id in &expired_ids {
                        guard.remove(id);
                        debug!("[agent-state] Evicted idle session: {}", id);
                        // Notify the frontend so it can clear any stale
                        // "running" status for this session.
                        crate::bus::broadcast_event(
                            "agent:session_evicted",
                            serde_json::json!({ "sessionId": id }),
                        );
                    }
                    info!(
                        "[agent-state] Cleanup task evicted {} idle session(s)",
                        expired_ids.len()
                    );
                }
            }
        });
    }

    /// Set the shared PTY sessions (called during Tauri setup).
    pub fn set_pty_sessions(
        &mut self,
        sessions: Arc<
            tauri::async_runtime::Mutex<HashMap<String, ::terminal::pty_commands::pty::PtySession>>,
        >,
    ) {
        self.pty_sessions = Some(sessions);
    }

    /// Set the Tauri app handle (called during Tauri setup).
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    // ═══════════════════════════════════════════════════════════════
    // Session registry
    // ═══════════════════════════════════════════════════════════════

    /// Retrieve an active session by ID.
    pub async fn get_session(&self, session_id: &str) -> Option<Arc<AgentSession>> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).cloned()
    }

    /// Register a new session and return the shared `Arc`.
    pub async fn register_session(&self, session: AgentSession) -> Arc<AgentSession> {
        let session_arc = Arc::new(session);
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_arc.id.clone(), Arc::clone(&session_arc));
        session_arc
    }

    /// Remove a session from the registry (full teardown).
    pub async fn remove_session(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id);
        info!("[agent-state] Removed session: {}", session_id);
    }

    /// Invalidate the runtime attached to a session, forcing re-initialization
    /// on the next request.
    pub async fn invalidate_session(&self, session_id: &str) {
        if let Some(session) = self.get_session(session_id).await {
            *session.runtime.write().await = None;
            info!("[agent-state] Invalidated session runtime: {}", session_id);
        }
    }

    /// Invalidate prompt-cache state for every active session.
    pub async fn invalidate_prompt_caches(&self, reason: PromptCacheInvalidationReason) {
        let sessions = {
            let sessions = self.sessions.lock().await;
            sessions.values().cloned().collect::<Vec<_>>()
        };
        for session in &sessions {
            session.invalidate_prompt_cache(reason).await;
        }
        if !sessions.is_empty() {
            info!(
                "[agent-state] Invalidated prompt cache state for {} active session(s): {}",
                sessions.len(),
                reason.as_str()
            );
        }
    }

    /// Invalidate prompt-cache state for active sessions backed by a specific agent definition.
    pub async fn invalidate_prompt_caches_for_agent_definition(
        &self,
        definition_id: &str,
        reason: PromptCacheInvalidationReason,
    ) {
        let sessions = {
            let sessions = self.sessions.lock().await;
            sessions.values().cloned().collect::<Vec<_>>()
        };
        let mut count = 0usize;
        for session in &sessions {
            let applies_to_session_definition = session.definition.id == definition_id;
            let applies_to_runtime_definition = session
                .runtime
                .read()
                .await
                .as_ref()
                .and_then(|runtime| runtime.agent_definition_id.as_deref())
                == Some(definition_id);
            if applies_to_session_definition || applies_to_runtime_definition {
                session.invalidate_prompt_cache(reason).await;
                count += 1;
            }
        }
        if count > 0 {
            info!(
                "[agent-state] Invalidated prompt cache state for {} active session(s) using {}: {}",
                count,
                definition_id,
                reason.as_str()
            );
        }
    }

    /// Invalidate runtimes for all sessions whose IDs start with any of the
    /// given prefixes.
    pub async fn invalidate_sessions_by_prefixes(&self, prefixes: &[&str]) {
        let sessions = self.sessions.lock().await;
        let mut count = 0usize;
        for (id, session) in sessions.iter() {
            if prefixes.iter().any(|p| id.starts_with(p)) {
                *session.runtime.write().await = None;
                count += 1;
            }
        }
        if count > 0 {
            info!(
                "[agent-state] Invalidated {} session runtime(s) (prefixes: {:?})",
                count, prefixes
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Cancel / lifecycle helpers
    // ═══════════════════════════════════════════════════════════════

    /// Signal cancellation for a session.
    ///
    /// Delegates to `AgentSession::cancel_active_turn` which cancels the
    /// in-flight `DialogTurn` (if any) via the shared `cancel_flag`.
    ///
    /// Subagent sessions are never registered in the live session map —
    /// their turn loop runs inside the parent's `agent` tool call and is
    /// tracked by the background job registry instead (keyed by the
    /// subagent session id). Fall back to `kill_subagent` so the chat
    /// card's Stop button (which cancels by subagent session id) actually
    /// reaches the worker.
    pub async fn cancel_session(
        &self,
        session_id: &str,
        reason: crate::state::control_flow::CancelReason,
    ) -> bool {
        if let Some(session) = self.get_session(session_id).await {
            session.cancel_active_turn(reason).await;
            info!(
                "[agent-state] Cancelled active turn for session: {} (reason={})",
                session_id,
                reason.as_str()
            );
            true
        } else if crate::tools::impls::coding::exec::registry::kill_subagent(session_id).is_ok() {
            info!(
                "[agent-state] Cancelled subagent worker via job registry: {} (reason={})",
                session_id,
                reason.as_str()
            );
            true
        } else if !reason.repairs_missing_session_as_failed() {
            // Agent Org pause walks the durable roster, which includes lazy
            // members that have no in-memory runtime yet. Their absence is
            // expected and must not be rewritten to Failed merely because
            // the user paused the group chat.
            info!(
                "[agent-state] Session not live during cancel; preserving durable status: {} (reason={})",
                session_id,
                reason.as_str()
            );
            false
        } else {
            // Neither the live session map nor the job registry knows about
            // this session. It may be an orphan DB row from a failed spawn
            // (e.g. worktree creation error after upsert). Mark it as failed
            // so the frontend stops showing it as running.
            let _ = crate::session::persistence::update_status(
                session_id,
                crate::session::SessionStatus::Failed,
            );
            warn!(
                "[agent-state] Session not found for cancel, marked as failed: {}",
                session_id
            );
            false
        }
    }

    /// List all active session IDs.
    pub async fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.lock().await;
        sessions.keys().cloned().collect()
    }

    // ═══════════════════════════════════════════════════════════════
    // Global flags
    // ═══════════════════════════════════════════════════════════════

    /// Check if the global agent (OS/Gateway) is running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Check if the gateway is running (delegates to GatewayService).
    pub fn is_gateway_running(&self) -> bool {
        self.gateway.is_running()
    }
}

impl Default for AgentAppState {
    fn default() -> Self {
        Self::new()
    }
}
