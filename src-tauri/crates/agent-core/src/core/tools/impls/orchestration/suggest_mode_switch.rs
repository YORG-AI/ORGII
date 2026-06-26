//! Mode switch suggestion tool.
//!
//! The agent calls `suggest_mode_switch` when it detects the user's intent
//! would be better served in a different mode (e.g. Build → Plan).
//!
//! The tool blocks until the user confirms or skips in the frontend.
//! - **Skip** → returns "continue in current mode" → LLM loop continues.
//! - **Switch** → returns "mode switched" → processor breaks the loop
//!   and the frontend re-sends with the new mode.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::interaction::finalize::{
    await_with_cancel, AutoTimeoutAction, AutoTimeoutPolicy, FinalizedStatus, InteractionOutcome,
};
use crate::interaction::mode_switch::{ModeSwitchChoice, ModeSwitchManager};
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

pub struct ModeSwitchToolContext {
    pub session_id: Mutex<Option<String>>,
    pub manager: Arc<ModeSwitchManager>,
    /// Current agent exec mode — set at session init, read by `llm_description()`.
    /// Uses `std::sync::Mutex` because `llm_description()` is sync.
    pub current_mode: std::sync::Mutex<Option<String>>,
}

impl ModeSwitchToolContext {
    pub fn new(manager: Arc<ModeSwitchManager>) -> Self {
        Self {
            session_id: Mutex::new(None),
            manager,
            current_mode: std::sync::Mutex::new(None),
        }
    }

    pub fn with_mode(self, mode: &str) -> Self {
        *self.current_mode.lock().unwrap_or_else(|e| e.into_inner()) = Some(mode.to_string());
        self
    }
}

pub struct SuggestModeSwitchTool {
    context: Arc<ModeSwitchToolContext>,
}

impl SuggestModeSwitchTool {
    pub fn new(context: Arc<ModeSwitchToolContext>) -> Self {
        Self { context }
    }
}

/// Sentinel prefix in the tool result that the processor checks
/// to decide whether to break the loop.
pub const SWITCH_ACCEPTED_PREFIX: &str = "MODE_SWITCH_ACCEPTED:";
const MODE_SWITCH_AUTO_SKIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[async_trait]
impl Tool for SuggestModeSwitchTool {
    fn name(&self) -> &str {
        tool_names::SUGGEST_MODE_SWITCH
    }

    fn description(&self) -> &str {
        concat!(
            "Switch to Plan mode. Call this tool in three situations: ",
            "(1) The user explicitly requests a mode switch — e.g. \"switch to plan\", ",
            "\"enter plan mode\", or any clear intent to change mode. ",
            "(2) The user asks you to PRODUCE a plan/roadmap/design document — e.g. ",
            "\"give me a plan\", \"write a plan\", \"make a refactor plan\", or \"help me plan this\". ",
            "You cannot produce a plan document in Build mode, so call this tool immediately ",
            "instead of exploring the codebase. ",
            "(3) The user's request is a large / risky / architectural task that benefits ",
            "from a written plan before implementation. ",
            "The user sees a confirmation card and chooses Switch (enter Plan mode) or Skip. ",
            "Do NOT call this for trivial tasks, for questions, or when the user explicitly ",
            "asked for direct implementation. ",
            "IMPORTANT: After calling this tool, STOP immediately — do not produce any more text or tool calls."
        )
    }

    fn llm_description(&self) -> Option<String> {
        let current = self
            .context
            .current_mode
            .lock()
            .ok()
            .and_then(|guard| guard.clone())?;
        Some(format!(
            "Switch to Plan mode. Current mode: {current}. Only `plan` is accepted as target_mode. \
             Call this tool when: \
             (1) the user explicitly requests switching to plan mode (any phrasing), OR \
             (2) the user asks you to PRODUCE a plan/roadmap — e.g. \"give me a plan\", \
             \"write a plan\", \"make a refactor plan\". You cannot write plan documents in Build mode, \
             so call this tool immediately without any codebase exploration, OR \
             (3) the task is large / risky / architectural and benefits from a written plan first. \
             Do NOT call this if the current mode is already `plan`, for trivial tasks, \
             or when the user asked for direct implementation. \
             IMPORTANT: After calling this tool, STOP immediately."
        ))
    }

    fn category(&self) -> &str {
        crate::tools::categories::AGENT
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "required": ["target_mode", "reason"],
            "properties": {
                "target_mode": {
                    "type": "string",
                    "enum": ["plan"],
                    "description": "Must be \"plan\". This tool only suggests switching into Plan mode."
                },
                "reason": {
                    "type": "string",
                    "description": "Brief explanation of why Plan mode is better for the user's request"
                }
            }
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let target_mode = params
            .get("target_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("plan");
        if target_mode != "plan" {
            return Err(ToolError::InvalidParams(format!(
                "suggest_mode_switch only accepts target_mode=\"plan\", got {target_mode:?}"
            )));
        }
        let reason = params.get("reason").and_then(|v| v.as_str()).unwrap_or("");

        let session_id = self
            .context
            .session_id
            .lock()
            .await
            .clone()
            .unwrap_or_default();

        // Per-call tool_call_id flows through `CallContext` (constructed
        // by `tool_execution` dispatch sites) so the finalized event
        // targets the right chat block. Empty when a direct in-process
        // caller forgot to populate ctx — that path predates this tool.
        let tool_call_id = if ctx.call_id.is_empty() {
            None
        } else {
            Some(ctx.call_id.clone())
        };

        let receiver = self
            .context
            .manager
            .ask(&session_id, target_mode, reason, tool_call_id.as_deref())
            .await;

        let cancel_flag = self.context.manager.cancel_flag();
        let outcome = await_with_cancel(
            receiver,
            cancel_flag,
            Some(AutoTimeoutPolicy {
                timeout: MODE_SWITCH_AUTO_SKIP_TIMEOUT,
                on_expire: Box::new(|| AutoTimeoutAction::Respond(ModeSwitchChoice::Skip)),
            }),
        )
        .await;

        let choice = match outcome {
            InteractionOutcome::Responded(c) => c,
            InteractionOutcome::AutoResponded(c) => {
                self.context.manager.auto_skip_after_timeout().await;
                c
            }
            InteractionOutcome::Cancelled => {
                self.context
                    .manager
                    .cancel_pending(FinalizedStatus::Cancelled)
                    .await;
                return Err(ToolError::ExecutionFailed(
                    "Mode switch cancelled by user (stop)".into(),
                ));
            }
            InteractionOutcome::TimedOut => {
                self.context.manager.auto_skip_after_timeout().await;
                ModeSwitchChoice::Skip
            }
            InteractionOutcome::Dropped => {
                return Err(ToolError::ExecutionFailed(
                    "Mode switch request was cancelled".into(),
                ));
            }
        };

        match choice {
            ModeSwitchChoice::Switch(mode) => {
                // The `SWITCH_ACCEPTED_PREFIX` is the only load-bearing part for
                // the CURRENT (Build) turn: `single.rs` matches the prefix and
                // ends the turn immediately with an empty continuation, so this
                // turn's LLM never reads the prose below.
                //
                // The prose IS read by the NEXT turn — the frontend resumes the
                // session in the new mode (content="", is_resume=true), and that
                // resume turn's LLM sees this tool_result at the tail of history.
                // It must therefore instruct the agent to CARRY ON with the
                // original request under the new mode, not to stop. A prior
                // "Stop now." wording stranded the resume turn: the agent read it
                // and halted after merely acknowledging the switch (GH #168).
                Ok(format!(
                    "{}{}. You are now in {} mode. Continue with the user's \
                     original request under the new mode now — do not stop to \
                     ask for confirmation.",
                    SWITCH_ACCEPTED_PREFIX, mode, mode
                ))
            }
            ModeSwitchChoice::Skip => {
                Ok(
                    "User chose to stay in the current mode. \
                     Continue working on the original request without suggesting a mode switch again."
                        .to_string(),
                )
            }
        }
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.context.session_id.lock().await = Some(session_key.to_string());
    }
}
