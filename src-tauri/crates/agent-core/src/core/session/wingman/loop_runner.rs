//! `WingmanLoop` — the periodic screen-observation background task.
//!
//! Every [`OBSERVATION_INTERVAL_SECS`] the loop captures a screenshot, pulls
//! recent activity from `FlowStore`, and enqueues a synthetic "observe" turn
//! on the session's `DialogScheduler` (in `AgentExecMode::Wingman`).

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::foundation::bus::broadcast_event;
use crate::foundation::flow_awareness::FlowStore;
use crate::session::scheduler::ExecuteFn;
use crate::session::AgentExecMode;
use crate::session::ScheduledMessage;
use crate::state::AgentSession;

use super::observation::{build_observation_prompt, capture_screenshot};

#[cfg(all(target_os = "macos", feature = "wingman-bar-native"))]
use super::wingman_bar_native;

/// How often Wingman wakes up to observe (30 seconds).
const OBSERVATION_INTERVAL_SECS: u64 = 30;

/// How many recent FlowStore activities to include in the observation prompt.
const FLOW_CONTEXT_ACTIVITIES: usize = 15;

pub(super) struct WingmanLoop {
    pub(super) session_id: String,
    pub(super) mission: String,
    pub(super) session: Arc<AgentSession>,
    pub(super) app_handle: Option<tauri::AppHandle>,
}

impl WingmanLoop {
    pub(super) async fn run(self, cancel: CancellationToken) {
        info!(
            "[wingman] Loop running for session {} (interval={}s)",
            self.session_id, OBSERVATION_INTERVAL_SECS
        );

        let interval = Duration::from_secs(OBSERVATION_INTERVAL_SECS);
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;

        self.run_select_loop(cancel, &mut ticker).await;
    }

    /// Native-bar build: runs the observation ticker plus a 1-second
    /// elapsed-counter ticker that drives the macOS NSPanel's elapsed
    /// time display via `wingman_bar_native::set_elapsed`.
    #[cfg(all(target_os = "macos", feature = "wingman-bar-native"))]
    async fn run_select_loop(&self, cancel: CancellationToken, ticker: &mut tokio::time::Interval) {
        let mut elapsed_ticker = tokio::time::interval(Duration::from_secs(1));
        elapsed_ticker.tick().await;
        let mut elapsed_secs: i32 = 0;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("[wingman] Cancelled for session {}", self.session_id);
                    break;
                }
                _ = ticker.tick() => {
                    self.observe().await;
                }
                _ = elapsed_ticker.tick() => {
                    elapsed_secs += 1;
                    wingman_bar_native::set_elapsed(elapsed_secs);
                    // Keep the session row elapsed time in sync (phase=running)
                    wingman_bar_native::upsert_session(
                        &self.session_id,
                        &self.mission,
                        &wingman_bar_native::last_status(),
                        1,
                        elapsed_secs,
                    );
                }
            }
        }
    }

    /// Default build: no native bar, so the elapsed-counter ticker is
    /// dropped entirely — there is no consumer for the value.
    #[cfg(not(all(target_os = "macos", feature = "wingman-bar-native")))]
    async fn run_select_loop(&self, cancel: CancellationToken, ticker: &mut tokio::time::Interval) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("[wingman] Cancelled for session {}", self.session_id);
                    break;
                }
                _ = ticker.tick() => {
                    self.observe().await;
                }
            }
        }
    }

    async fn observe(&self) {
        // 1. Capture screenshot.
        let screenshot_b64 = match capture_screenshot().await {
            Ok(b64) => Some(b64),
            Err(err) => {
                warn!("[wingman] Screenshot failed: {}", err);
                None
            }
        };

        // 2. Build flow context.
        let flow_context =
            FlowStore::global().format_context(Some(&self.session_id), FLOW_CONTEXT_ACTIVITIES);

        // 3. Compose observation prompt.
        let prompt =
            build_observation_prompt(&self.mission, &flow_context, screenshot_b64.is_some());

        // 4. Enqueue as a synthetic Wingman turn.
        if let Err(err) = self.enqueue_observation(prompt, screenshot_b64).await {
            warn!(
                "[wingman] Failed to enqueue observation for session {}: {}",
                self.session_id, err
            );
        }
    }

    /// Enqueue a synthetic observation turn on the session's `DialogScheduler`.
    async fn enqueue_observation(
        &self,
        content: String,
        screenshot_b64: Option<String>,
    ) -> Result<(), String> {
        let session = &self.session;

        let sid = self.session_id.clone();
        let cancel_flag: Arc<std::sync::atomic::AtomicBool> = Arc::clone(&session.cancel_flag);
        let app_handle = self.app_handle.clone();
        let session_arc_for_closure: Arc<AgentSession> = Arc::clone(session);
        let session_id_for_event = sid.clone();
        // Mint the canonical user-intent id once per observation so the
        // ScheduledMessage and the TurnInput carry the same value.
        let turn_intent_id = uuid::Uuid::new_v4().to_string();
        let turn_intent_id_for_closure = turn_intent_id.clone();

        let execute: ExecuteFn = Box::new(move || {
            let _sid = sid;
            let content = content;
            let turn_intent_id = turn_intent_id_for_closure;

            Box::pin(async move {
                cancel_flag.store(false, std::sync::atomic::Ordering::SeqCst);

                let turn_id = session_arc_for_closure.begin_turn(content.clone()).await;

                let images =
                    screenshot_b64.map(|b64| vec![format!("data:image/jpeg;base64,{}", b64)]);

                let input = crate::session::TurnInput {
                    content: content.clone(),
                    display_text: None,
                    agent_mode: Some(AgentExecMode::Wingman),
                    images,
                    ide_context: None,
                    is_resume: false,
                    channel: None,
                    chat_id: None,
                    turn_id: Some(turn_id.clone()),
                    turn_intent_id,
                };

                let response = crate::session::process_message(
                    Arc::clone(&session_arc_for_closure),
                    input,
                    app_handle.clone(),
                )
                .await;

                let final_turn_state = if response.is_ok() {
                    crate::session::DialogTurnState::Completed
                } else {
                    crate::session::DialogTurnState::Failed
                };

                {
                    let stats = response
                        .as_ref()
                        .ok()
                        .map(|r| crate::session::TurnStats {
                            prompt_tokens: r.prompt_tokens,
                            completion_tokens: r.completion_tokens,
                            total_tokens: r.total_tokens,
                            context_tokens: 0,
                            tool_calls_count: r.tool_calls_count,
                            duration: None,
                        })
                        .unwrap_or_default();
                    session_arc_for_closure
                        .end_turn(final_turn_state, stats)
                        .await;
                }

                // Broadcast Wingman-specific observation event so the
                // frontend overlay can pick it up without attaching to the
                // main chat stream.
                if let Ok(ref result) = response {
                    let observation_text = result.content.trim().to_string();
                    if !observation_text.is_empty()
                        && !observation_text.eq_ignore_ascii_case("[no change]")
                    {
                        broadcast_event(
                            "wingman:observation",
                            serde_json::json!({
                                "sessionId": session_id_for_event,
                                "text": observation_text,
                            }),
                        );
                    }
                }

                cancel_flag.store(false, std::sync::atomic::Ordering::SeqCst);

                response.map(|r| r.content).map_err(|e| e.to_string())
            })
        });

        let msg = ScheduledMessage {
            // A wingman observation runs the full turn pipeline and emits
            // turn terminals, so it is a turn to the scheduler and the UI.
            kind: crate::session::ScheduledKind::Turn,
            message_id: uuid::Uuid::new_v4().to_string(),
            generation: 0,
            client_message_id: None,
            // Same id used for the TurnInput above — keeps the wire
            // boundary and the turn execution observing a single intent.
            turn_intent_id,
            content: "[wingman:observe]".to_string(),
            execute,
        };

        // Lifecycle: record the wingman observation as `queued` so the
        // scheduler worker's running/terminal transitions find an existing
        // row instead of logging NotFound rejections.
        crate::foundation::session_bridge::upsert_turn_intent(
            &self.session_id,
            &msg.turn_intent_id,
            None,
            crate::foundation::session_bridge::TurnIntentBridgeSource::Wingman,
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Queued,
        );

        session
            .scheduler
            .enqueue(msg)
            .await
            .map(|_| ())
            .map_err(|e| format!("Scheduler enqueue failed: {}", e))
    }
}
