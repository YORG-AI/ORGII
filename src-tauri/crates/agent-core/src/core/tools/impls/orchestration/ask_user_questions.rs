//! Question tool — structured user input mid-conversation.
//!
//! Lets the agent ask the user multiple-choice questions, blocking
//! until the user responds via the frontend.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

use crate::interaction::finalize::{await_with_cancel, FinalizedStatus, InteractionOutcome};
use crate::interaction::question::QuestionManager;

/// Shared context so the question tool can access the session's QuestionManager.
pub struct QuestionToolContext {
    pub session_id: Mutex<Option<String>>,
    pub manager: Arc<QuestionManager>,
}

impl QuestionToolContext {
    pub fn new(manager: Arc<QuestionManager>) -> Self {
        Self {
            session_id: Mutex::new(None),
            manager,
        }
    }
}

pub struct QuestionTool {
    context: Arc<QuestionToolContext>,
}

impl QuestionTool {
    pub fn new(context: Arc<QuestionToolContext>) -> Self {
        Self { context }
    }
}

#[async_trait]
impl Tool for QuestionTool {
    fn name(&self) -> &str {
        tool_names::ASK_USER_QUESTIONS
    }

    fn description(&self) -> &str {
        "Ask the user structured questions during execution. Use to:\n\
         1. Gather user preferences or requirements\n\
         2. Clarify ambiguous instructions\n\
         3. Get decisions on implementation choices\n\
         4. Offer choices about what direction to take\n\n\
         Notes:\n\
         - A 'Type your own answer' option is added automatically; don't include 'Other'\n\
         - Each option must have a unique `id` (snake_case); answers are returned as arrays of option ids\n\
         - Each option should include a `description` explaining trade-offs or implications of that choice\n\
         - Set multiSelect=true for multi-select\n\
         - If you recommend a specific option, make it first and add '(Recommended)' to the label"
    }

    fn category(&self) -> &str {
        crate::tools::categories::AGENT
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "required": ["questions"],
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "Questions to ask the user",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "required": ["question", "header", "options"],
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "Complete question text"
                            },
                            "header": {
                                "type": "string",
                                "description": "Very short label (max 30 chars)"
                            },
                            "options": {
                                "type": "array",
                                "description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
                                "minItems": 2,
                                "maxItems": 4,
                                "items": {
                                    "type": "object",
                                    "required": ["label", "description"],
                                    "properties": {
                                        "id": {
                                            "type": "string",
                                            "description": "Unique identifier for this option (snake_case, e.g. 'use_redis'). Used as the submitted answer value."
                                        },
                                        "label": {
                                            "type": "string",
                                            "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."
                                        }
                                    }
                                }
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive. Default: false."
                            }
                        }
                    }
                }
            }
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let session_id = self
            .context
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed("No session context set".into()))?;

        let questions = params
            .get("questions")
            .ok_or_else(|| ToolError::InvalidParams("Missing 'questions' array".into()))?;

        let questions_arr = match questions.as_array() {
            Some(arr) => arr,
            None => {
                // Log the actual deserialized shape — the JSON Schema says
                // "questions" must be an array, but a provider or model may
                // have mangled it (string, object, extra wrapper, etc.).
                let preview = crate::utils::safe_truncate_chars_to_string(
                    &serde_json::to_string(&params).unwrap_or_else(|_| "(unserializable)".into()),
                    400,
                );
                tracing::warn!(
                    "[question] execute_text received non-array 'questions' \
                     (type={:?}, session={}, call_id={}, params_preview={})",
                    questions,
                    session_id,
                    ctx.call_id,
                    preview,
                );
                // Build an error the LLM can use to self-correct. Show what
                // it actually sent and a concrete example of the right shape.
                let actual_preview = questions.to_string();
                let actual_short =
                    crate::utils::safe_truncate_chars_to_string(&actual_preview, 120);
                return Err(ToolError::InvalidParams(format!(
                    "`questions` must be a JSON array, but got {}: {}. \
                     Correct format example: \
                     {{\"questions\":[{{\"question\":\"...\",\"header\":\"...\",\"options\":\
                     [{{\"id\":\"opt_a\",\"label\":\"Choice A\",\"description\":\"What A means\"}}]}}]}}",
                    match questions {
                        serde_json::Value::String(_) => "a string",
                        serde_json::Value::Number(_) => "a number",
                        serde_json::Value::Object(_) => "an object",
                        serde_json::Value::Bool(_) => "a boolean",
                        serde_json::Value::Null => "null",
                        _ => "an unexpected type",
                    },
                    actual_short,
                )));
            }
        };

        if questions_arr.is_empty() {
            return Err(ToolError::InvalidParams(
                "Provide at least one question".into(),
            ));
        }

        let request_id = format!("question-{}", uuid::Uuid::new_v4());

        // Per-call tool_call_id flows through `CallContext` (constructed
        // by `tool_execution` dispatch sites). A missing call_id means
        // `finalize_interaction_event` will silently skip the broadcast,
        // leaving the tool_call event stuck at `awaiting_user` forever.
        // Fail fast so the LLM sees the error instead of hanging.
        if ctx.call_id.is_empty() {
            tracing::error!(
                "[question] execute_text called with empty call_id (session={}, request={}) — \
                 refusing to proceed. The dispatch path must populate `CallContext.call_id`.",
                session_id,
                request_id
            );
            return Err(ToolError::ExecutionFailed(
                "Cannot ask questions: tool dispatch context missing call_id".into(),
            ));
        }

        let tool_call_id = Some(ctx.call_id.clone());

        // Send question to frontend and return a receiver.
        let receiver = self
            .context
            .manager
            .ask(&session_id, &request_id, questions, tool_call_id.as_deref())
            .await;

        // Cancel-aware wait (Stop button) with NO tool-side timeout.
        //
        // The authoritative auto-resolve deadline lives entirely in
        // `QuestionManager::spawn_auto_resolve_watcher` (driven by the
        // presence policy): Online → wait indefinitely; Away/Invisible →
        // resolve after the policy window and deliver `AutoSkipped` over
        // this same `receiver`. A tool-side timeout here would be a second,
        // conflicting deadline that preempts the watcher and reports a hard
        // `Timeout` error instead of the graceful auto-skip. So we pass
        // `None` and rely solely on the receiver (answer / auto-skip) and
        // the cancel flag (Stop).
        let cancel_flag = self.context.manager.cancel_flag();
        let outcome = await_with_cancel(receiver, cancel_flag, None).await;

        let resolution = match outcome {
            InteractionOutcome::Responded(r) | InteractionOutcome::AutoResponded(r) => r,
            InteractionOutcome::Cancelled => {
                self.context
                    .manager
                    .cancel_pending(&request_id, FinalizedStatus::Cancelled)
                    .await;
                return Err(ToolError::ExecutionFailed(
                    "Question cancelled by user (stop)".into(),
                ));
            }
            InteractionOutcome::TimedOut => {
                // With `policy: None` this is effectively unreachable (the
                // backstop sleep is one year). It can only fire if the
                // manager's auto-resolve watcher failed to arm. Treat it as a
                // graceful auto-skip — tell the LLM to proceed on its own best
                // judgment — rather than a hard error that aborts the turn.
                self.context
                    .manager
                    .cancel_pending(&request_id, FinalizedStatus::TimedOut)
                    .await;
                return Ok(crate::interaction::question::auto_skip_content_for_llm(
                    "timeout",
                ));
            }
            InteractionOutcome::Dropped => {
                return Err(ToolError::ExecutionFailed(
                    "Question request was cancelled".into(),
                ));
            }
        };

        let answers = match resolution {
            crate::interaction::question::QuestionResolution::Answered(answers) => answers,
            crate::interaction::question::QuestionResolution::AutoSkipped { mode_label } => {
                // Presence-policy auto-skip: tell the LLM to proceed on its
                // own best judgment. Same content as the finalized event.
                return Ok(crate::interaction::question::auto_skip_content_for_llm(
                    &mode_label,
                ));
            }
        };

        // Empty answers = user dismissed
        if answers.is_empty() {
            return Err(ToolError::ExecutionFailed(
                "The user dismissed the question".into(),
            ));
        }

        // Format answers for the LLM — resolve ids back to labels for readability.
        // This must stay in lock-step with `question::format_answers_for_llm` so
        // the UI's finalized content matches what the LLM sees next turn.
        let formatted: Vec<String> = questions_arr
            .iter()
            .zip(answers.iter())
            .map(|(q, a)| {
                let question_text = q.get("question").and_then(|v| v.as_str()).unwrap_or("?");
                let answer_text = if a.is_empty() {
                    "Unanswered".to_string()
                } else {
                    let options = q.get("options").and_then(|v| v.as_array());
                    a.iter()
                        .map(|selected_id| {
                            options
                                .and_then(|opts| {
                                    opts.iter().find(|opt| {
                                        opt.get("id").and_then(|v| v.as_str()) == Some(selected_id)
                                    })
                                })
                                .and_then(|opt| opt.get("label").and_then(|v| v.as_str()))
                                .map(|label| format!("{} ({})", label, selected_id))
                                .unwrap_or_else(|| selected_id.clone())
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                format!("\"{}\" = \"{}\"", question_text, answer_text)
            })
            .collect();

        Ok(format!(
            "User has answered your questions: {}. You can now continue with the user's answers in mind.",
            formatted.join(", ")
        ))
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.context.session_id.lock().await = Some(session_key.to_string());
    }
}
