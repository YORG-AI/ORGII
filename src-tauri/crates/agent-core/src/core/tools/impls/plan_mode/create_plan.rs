//! `create_plan` tool — writes the session plan file and submits it through
//! the approval channel appropriate for the current runtime.
//!
//! Behavior:
//! - Only valid in Plan mode (enforced by the policy allow-list).
//! - Writes the plan markdown to disk via `plan_file_path` + `PlanSlotCache`.
//! - For top-level sessions and coordinators, calls
//!   `PlanApprovalManager::mark_ready`, which broadcasts
//!   `agent:plan_ready_for_approval` so the frontend can enable the user-facing
//!   Build button.
//! - For non-coordinator Agent Org members, delivers a typed
//!   `PlanApprovalRequest` to the coordinator inbox instead of involving the
//!   user-facing Build approval surface.
//! - Returns a tool-result string prefixed with `PLAN_SUBMITTED_END_TURN_PREFIX`
//!   so `turn_executor::tool_execution::single` early-exits the current turn.
//!   The LLM is instructed to stop after calling this tool; the prefix is the
//!   enforcement mechanism in case it tries to continue.
//!
//! Subagents cannot reach this tool: `create_plan` is in
//! `SUBAGENT_FORBIDDEN_TOOLS` (subagents cannot enter plan mode), so
//! the policy hard-deny layer rejects any subagent-originated call
//! before execute() is entered. See the
//! `subagent_reaching_execute_is_a_wiring_bug` assertion below.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::Mutex as TokioMutex;

use crate::coordination::agent_inbox::RequestId;
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanApprovalStore, AgentOrgPlanInboxDelivery, CreateAgentOrgPlanApprovalParams,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::{
    task_execution_mode, AgentOrgTaskStore, Task, TaskExecutionMode, TaskStatus,
};
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::definitions::orgs::PlanApprovalPolicy;
use crate::interaction::plan_approval::PlanApprovalManager;
use crate::session::plan_mode::{
    plan_file_path, random_hash, slugify_plan_title, PlanPathCtx, PlanSlot, PlanSlotCache,
};
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

/// Sentinel prefix on the tool-result text that tells
/// `turn_executor::tool_execution::single` to early-exit the current turn
/// after `create_plan` has marked a pending plan ready for approval. Mirrors
/// `SWITCH_ACCEPTED_PREFIX` used by `suggest_mode_switch` — without this the
/// LLM tends to narrate more text in the same turn even though the prompt
/// says to stop, which keeps `sessionRuntimeStatus` stuck at `running` after
/// the FE "Build" card has already rendered.
pub const PLAN_SUBMITTED_END_TURN_PREFIX: &str = "PLAN_SUBMITTED_END_TURN:";

/// Shared context for the `create_plan` tool.
///
/// `session_id` is stamped via `set_session_key()`. The plan-file slot cache
/// is injected at session init. `plan_approval_manager` is the
/// Build-button approval channel. It is kept as `Option` because
/// non-coding agents (e.g. a pure Q&A custom definition) may register the
/// tool without a manager; the tool errors out in that case rather than
/// silently writing a plan file that can never be submitted.
///
/// `agent_org_context` is set when the session participates in an
/// `AgentOrgRun`. When the calling session is an org *member* (not the
/// coordinator), `execute_text` routes the plan to the coordinator's
/// inbox as a typed `PlanApprovalRequest` instead of lighting up the
/// user's Build button — there is no human in the loop to click Build
/// inside an LLM-driven org run, so the coordinator is the only entity
/// that can actually approve. Coordinator and non-org sessions keep the
/// existing user-facing flow unchanged.
pub struct CreatePlanToolContext {
    pub session_id: TokioMutex<Option<String>>,
    pub plan_slot_cache: PlanSlotCache,
    pub plan_approval_manager: Option<Arc<PlanApprovalManager>>,
    pub agent_org_context: Option<AgentOrgRunContext>,
    pub agent_org_current_member_id: Option<String>,
    pub app_handle: Option<tauri::AppHandle>,
}

impl CreatePlanToolContext {
    pub fn new(
        plan_slot_cache: PlanSlotCache,
        plan_approval_manager: Option<Arc<PlanApprovalManager>>,
        agent_org_context: Option<AgentOrgRunContext>,
        agent_org_current_member_id: Option<String>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        Self {
            session_id: TokioMutex::new(None),
            plan_slot_cache,
            plan_approval_manager,
            agent_org_context,
            agent_org_current_member_id,
            app_handle,
        }
    }
}

pub struct CreatePlanTool {
    context: Arc<CreatePlanToolContext>,
}

impl CreatePlanTool {
    pub fn new(context: Arc<CreatePlanToolContext>) -> Self {
        Self { context }
    }
}

/// Record stored on success — serialized as the body of the tool-result
/// string (after the end-turn sentinel prefix, when applicable).
#[derive(serde::Serialize)]
struct CreatePlanResult {
    path: String,
    slug: String,
    hash: String,
    bytes_written: usize,
    new_plan: bool,
    /// `true` when the plan was submitted to either the solo-session or
    /// Agent Org approval workflow.
    submitted_for_review: bool,
}

#[async_trait]
impl Tool for CreatePlanTool {
    fn name(&self) -> &str {
        tool_names::CREATE_PLAN
    }

    fn description(&self) -> &str {
        concat!(
            "Write the current session's plan document and submit it to the user for review. ",
            "Only available in Plan mode. Supply a short descriptive `title` and the full ",
            "markdown `content`. Calling this tool IS the submission: the plan card becomes ",
            "clickable in the UI (Build button lights up) and the agent turn ends immediately ",
            "after the tool returns. Do NOT narrate \"ready for your review\" text — just call ",
            "the tool. If the user replies in chat with feedback for an existing pending ",
            "plan, treat that reply as feedback on the previous `create_plan` tool call in ",
            "the conversation history. Use the previous tool-call arguments/result as the ",
            "source for the current plan body; do not ask the user to resend the plan and ",
            "do not search the codebase just to recover it. Call `create_plan` again with ",
            "the revised full plan and keep `new_plan` false. That updates the same pending ",
            "approval slot and emits a new revision card. Only pass `new_plan: true` when the user explicitly asks ",
            "for a distinct new plan. ",
            "Do not use file tools to read or write plan files; this tool is the only submission/update path. ",
            "IMPORTANT: After calling this tool, STOP immediately — any text or tool calls ",
            "produced in the same turn will be discarded."
        )
    }

    fn llm_description(&self) -> Option<String> {
        if let (Some(org_context), Some(member_id)) = (
            self.context.agent_org_context.as_ref(),
            self.context.agent_org_current_member_id.as_deref(),
        ) {
            if member_id != COORDINATOR_MEMBER_ID {
                let approver = match org_context.plan_approval_policy {
                    PlanApprovalPolicy::Coordinator => "the Coordinator",
                    PlanApprovalPolicy::User => "the user in Group chat",
                    PlanApprovalPolicy::Automatic => "the automatic policy",
                };
                return Some(format!(
                    "Submit the complete markdown deliverable for your current Agent Org execution_mode=plan task to {approver}. This call binds the plan to the owned planning task, persists an approval revision, and ends your turn. It does not start a Build turn and you must not mark the planning task completed yourself; approval does that atomically and unlocks its dependent tasks. Supply title + full content. source_task_id is optional only when you own exactly one in_progress planning task. After revision feedback, call create_plan again with the full revised content and new_plan=false. After calling this tool, STOP immediately."
                ));
            }
        }
        let mut description = concat!(
            "Write the current session's plan document and submit it to the user for review. ",
            "Only available in Plan mode. Supply a short descriptive `title` and the full ",
            "markdown `content`. Calling this tool IS the submission: the plan card becomes ",
            "clickable in the UI (Build button lights up) and the agent turn ends immediately ",
            "after the tool returns. Do NOT narrate \"ready for your review\" text — just call ",
            "the tool. If the user replies in chat with feedback for an existing pending plan, ",
            "treat that reply as feedback on the previous `create_plan` tool call in the conversation history. ",
            "Use the previous tool-call arguments/result as the source for the current plan body; ",
            "do not ask the user to resend the plan and do not search the codebase just to recover it. ",
            "Call `create_plan` again with the revised full plan and keep `new_plan` false. ",
            "That updates the same pending approval slot and emits a new revision card. Only pass ",
            "`new_plan: true` when the user explicitly asks for a distinct new plan. ",
            "Do not use file tools to read or write plan files; this tool is the only submission/update path. ",
        )
        .to_string();

        if let Some(pending) = self
            .context
            .plan_approval_manager
            .as_ref()
            .and_then(|manager| manager.pending_snapshot_now())
        {
            description.push_str(&format!(
                "CURRENT PENDING PLAN: title=`{}`, revision_id=`{}`. The user's next Plan-mode feedback is about this pending approval unless they explicitly ask for a distinct new plan. Update this pending approval by calling `create_plan` with the revised full markdown body and `new_plan=false`; do not create an unrelated plan, do not use file tools to edit plan files, and do not answer with prose. ",
                pending.plan_title, pending.plan_revision_id
            ));
        }

        description.push_str(
            "IMPORTANT: After calling this tool, STOP immediately — any text or tool calls produced in the same turn will be discarded."
        );

        Some(description)
    }

    fn category(&self) -> &str {
        crate::tools::categories::PLAN_MODE
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "required": ["title", "content"],
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short descriptive plan title, e.g. \"Refactor auth layer\". Used for the plan card identity."
                },
                "content": {
                    "type": "string",
                    "description": "Full markdown body of the plan. Must include the required sections described in the Plan mode system prompt."
                },
                "new_plan": {
                    "type": "boolean",
                    "description": "Start a distinct new plan approval instead of updating the current pending approval. Defaults to false.",
                    "default": false
                },
                "source_task_id": {
                    "type": "string",
                    "description": "Agent Org only: exact owned in-progress plan task id. Optional when exactly one eligible planning task exists."
                }
            }
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let canonical_params = params.clone();
        // Per-call tool_call_id flows through `CallContext` (constructed
        // by `tool_execution` dispatch sites). Empty when a direct
        // in-process caller forgot to populate ctx.
        let tool_call_id = if ctx.call_id.is_empty() {
            None
        } else {
            Some(ctx.call_id.clone())
        };

        let title = params
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidParams("create_plan requires a non-empty `title`".into())
            })?
            .to_string();
        crate::coordination::agent_org_payload_limits::validate_required_text(
            "create_plan title",
            &title,
            crate::coordination::agent_org_payload_limits::PLAN_TITLE_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::PLAN_TITLE_MAX_BYTES,
        )
        .map_err(ToolError::InvalidParams)?;

        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("create_plan requires `content`".into()))?
            .to_string();
        crate::coordination::agent_org_payload_limits::validate_required_text(
            "create_plan content",
            &content,
            crate::coordination::agent_org_payload_limits::PLAN_CONTENT_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::PLAN_CONTENT_MAX_BYTES,
        )
        .map_err(ToolError::InvalidParams)?;

        let new_plan = params
            .get("new_plan")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let requested_source_task_id = params
            .get("source_task_id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        // Per-call session attribution comes from `CallContext` —
        // race-free even when concurrent background subagents share the
        // parent's ToolRegistry. (The legacy stored `set_session_key`
        // value was shared mutable state: a concurrent subagent could
        // re-stamp it at turn start, last-writer-wins, causing the
        // parent's create_plan to load the subagent's session row and
        // trip the wiring-bug assertion.) Fall back to the stored value
        // only for direct in-process callers / tests that didn't
        // populate ctx.
        let session_id = if !ctx.session_id.is_empty() {
            ctx.session_id.clone()
        } else {
            self.context
                .session_id
                .lock()
                .await
                .clone()
                .ok_or_else(|| {
                    ToolError::ExecutionFailed(
                        "create_plan invoked before session_id was set — this is a wiring bug"
                            .into(),
                    )
                })?
        };

        let pending_plan = if new_plan {
            None
        } else {
            match self.context.plan_approval_manager.as_ref() {
                Some(manager) => manager.pending_snapshot().await,
                None => None,
            }
        };

        // Resolve session-derived fields via the DB record. Any failure here is
        // an execution error (not an "invalid params" — the LLM can't fix it).
        let record_session_id = session_id.clone();
        let record = tokio::task::spawn_blocking(move || {
            crate::session::persistence::get_session(&record_session_id)
                .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("create_plan: session lookup worker failed: {err}"))
        })?
        .map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "create_plan: failed to load session {session_id}: {err}"
            ))
        })?
        .ok_or_else(|| {
            ToolError::ExecutionFailed(format!("create_plan: session {session_id} not found"))
        })?;

        let workspace_path = record.workspace_path.clone();
        // Hard invariant: subagents cannot reach `create_plan` because it
        // is in `SUBAGENT_FORBIDDEN_TOOLS`. If the policy layer ever lets
        // one through, that is a wiring bug and we must fail loudly —
        // silently writing a sibling plan file is what produced the
        // "Build button permanently disabled after regenerate in a
        // subagent-delegated plan turn" regression (2026-04-21).
        if record.parent_session_id.is_some() && record.org_member_id.is_none() {
            return Err(ToolError::ExecutionFailed(format!(
                "create_plan invoked from subagent session {session_id} \
                 (parent={}) — subagent policy layer must hard-deny this \
                 tool (SUBAGENT_FORBIDDEN_TOOLS); this is a wiring bug",
                record.parent_session_id.as_deref().unwrap_or("?"),
            )));
        }
        let agent_id = record.agent_definition_id.as_deref().unwrap_or("default");
        // Decide whether to update the current pending approval slot or rotate it.
        let slot = if let Some(pending) = pending_plan.as_ref() {
            let slot = PlanSlot {
                title: title.clone(),
                slug: slugify_plan_title(&title),
                hash: "pending".to_string(),
                resolved_path: PathBuf::from(&pending.plan_path),
            };
            self.context.plan_slot_cache.set(&session_id, slot.clone());
            slot
        } else {
            match (new_plan, self.context.plan_slot_cache.get(&session_id)) {
                (false, Some(existing)) if existing.title == title => existing,
                _ => {
                    let hash = random_hash();
                    let slug = slugify_plan_title(&title);
                    let ctx = PlanPathCtx {
                        workspace_path: workspace_path.as_deref(),
                        agent_id,
                        // `sub_agent_id` was used to namespace subagent plan
                        // files; subagents can no longer reach this tool, so
                        // every call is top-level and the slot is always the
                        // parent's.
                        sub_agent_id: None,
                        title: &title,
                        hash: &hash,
                    };
                    let resolved_path: PathBuf = plan_file_path(&ctx).ok_or_else(|| {
                        ToolError::ExecutionFailed(
                            "create_plan: could not resolve plan directory — no workspace_path and $HOME missing".into(),
                        )
                    })?;
                    let new_slot = PlanSlot {
                        title: title.clone(),
                        slug,
                        hash,
                        resolved_path,
                    };
                    self.context
                        .plan_slot_cache
                        .set(&session_id, new_slot.clone());
                    new_slot
                }
            }
        };

        let is_agent_org_worker = matches!(
            (
                self.context.agent_org_context.as_ref(),
                self.context.agent_org_current_member_id.as_deref(),
            ),
            (Some(_), Some(member_id)) if member_id != COORDINATOR_MEMBER_ID
        );
        if !is_agent_org_worker {
            // Solo/coordinator plans keep the existing PlanApprovalManager
            // path. Agent Org worker plans are deliberately not written here:
            // their durable approval transaction stages the file, commits the
            // canonical SQLite revision, and only then installs the artifact.
            // This avoids leaving an untracked new plan file if the approval
            // transaction fails or the process exits between these steps.
            let write_path = slot.resolved_path.clone();
            let write_content = content.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                if let Some(parent) = write_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|err| {
                        format!("create_plan: failed to create {}: {err}", parent.display())
                    })?;
                }
                std::fs::write(&write_path, write_content.as_bytes()).map_err(|err| {
                    format!(
                        "create_plan: failed to write {}: {err}",
                        write_path.display()
                    )
                })
            })
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("create_plan: file worker failed: {err}"))
            })?
            .map_err(ToolError::ExecutionFailed)?;
        }

        // Two submission paths:
        //   * Org member (not coordinator) → persist a task-bound approval.
        //     The run snapshot selects coordinator, user, or automatic
        //     approval. Approval completes the planning task; it never
        //     starts an unrelated Build turn in the Planner session.
        //   * Top-level session, coordinator, or solo plan-mode session →
        //     keep the existing user-facing flow (broadcast via
        //     `PlanApprovalManager::mark_ready` so the FE Build button
        //     lights up).
        if let Some(org_ctx) = self.context.agent_org_context.as_ref() {
            if let Some(sender_member_id) = self
                .context
                .agent_org_current_member_id
                .as_deref()
                .filter(|member_id| *member_id != COORDINATOR_MEMBER_ID)
            {
                let sender_agent_id = org_ctx
                    .members
                    .iter()
                    .find(|member| member.member_id == sender_member_id)
                    .map(|member| member.agent_id.clone())
                    .ok_or_else(|| {
                        ToolError::ExecutionFailed(format!(
                            "create_plan: runtime member_id '{sender_member_id}' is not in Agent Org roster"
                        ))
                    })?;
                let root_session_id = org_ctx.root_session_id.clone().ok_or_else(|| {
                    ToolError::ExecutionFailed(
                        "create_plan: Agent Org run has no root session".to_string(),
                    )
                })?;
                let policy = org_ctx.plan_approval_policy;
                let coordinator_agent_id = org_ctx.coordinator_agent_id.clone();
                let sender_member_id = sender_member_id.to_string();
                let run_id = org_ctx.run_id.clone();
                let receipt_key = AgentOrgToolReceiptKey::from_call_context(run_id.clone(), ctx)?;
                let source_session_id = session_id.clone();
                let source_turn_intent_id = ctx.turn_intent_id.clone();
                let plan_title = slot.title.clone();
                let plan_path = slot.resolved_path.to_string_lossy().into_owned();
                let plan_content = content.clone();
                let result = CreatePlanResult {
                    path: plan_path.clone(),
                    slug: slot.slug.clone(),
                    hash: slot.hash.clone(),
                    bytes_written: content.len(),
                    new_plan,
                    submitted_for_review: true,
                };
                let body = serde_json::to_string(&result).map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "create_plan: failed to serialize success payload: {err}"
                    ))
                })?;
                let result_text = format!("{PLAN_SUBMITTED_END_TURN_PREFIX}{body}");
                let (receipt, wake_member_ids) = tokio::task::spawn_blocking(move || {
                    let _artifact_guard = crate::coordination::agent_org_plan_approvals::artifact::plan_artifact_install_lock().lock();
                    let mut wake_member_ids = Vec::new();
                    let receipt = AgentOrgToolReceiptStore::execute(
                        receipt_key,
                        tool_names::CREATE_PLAN,
                        "agent_org_submit",
                        &canonical_params,
                        |tx| {
                            let source_task = match resolve_source_plan_task_with_connection(
                                tx,
                                &run_id,
                                &sender_member_id,
                                requested_source_task_id.as_deref(),
                            ) {
                                Ok(task) => task,
                                Err(error) => {
                                    return Ok(Err(ToolError::InvalidParams(error)));
                                }
                            };
                            let approval_params = CreateAgentOrgPlanApprovalParams {
                                request_id: RequestId::new().as_str().to_string(),
                                org_run_id: run_id.clone(),
                                source_task_id: source_task.id,
                                source_member_id: sender_member_id.clone(),
                                source_session_id: source_session_id.clone(),
                                source_turn_intent_id: source_turn_intent_id.clone(),
                                root_session_id: root_session_id.clone(),
                                policy,
                                plan_title: plan_title.clone(),
                                plan_path: plan_path.clone(),
                                plan_content: plan_content.clone(),
                            };
                            let delivery = (policy == PlanApprovalPolicy::Coordinator).then(|| {
                                AgentOrgPlanInboxDelivery {
                                    recipient_agent_id: coordinator_agent_id.clone(),
                                    sender_agent_id: sender_agent_id.clone(),
                                    sender_member_id: Some(sender_member_id.clone()),
                                }
                            });
                            match AgentOrgPlanApprovalStore::submit_agent_org_plan_in_tx(
                                tx,
                                approval_params,
                                delivery,
                            ) {
                                Ok(wakes) => wake_member_ids = wakes,
                                Err(error) => {
                                    return match crate::tools::impls::orchestration::agent_org::tasks::classify_task_receipt_error(error) {
                                        Ok(error) => Ok(Err(error)),
                                        Err(abort) => Err(abort),
                                    };
                                }
                            }
                            Ok(Ok(result_text.clone()))
                        },
                    )?;
                    if receipt.is_fresh() && receipt.result.is_ok() {
                        match database::db::get_connection()
                            .map_err(|error| error.to_string())
                            .and_then(|conn| {
                                crate::coordination::agent_org_plan_approvals::artifact::stage_plan_artifact_with_connection(
                                    &conn,
                                    &source_session_id,
                                    &plan_path,
                                    &plan_content,
                                )
                            })
                            .and_then(|staged| {
                                crate::coordination::agent_org_plan_approvals::artifact::install_staged_plan_artifact(Some(&staged))
                            })
                        {
                            Ok(()) => {}
                            Err(error) => tracing::warn!(
                                org_run_id = %run_id,
                                plan_path,
                                error = %error,
                                "Agent Org plan receipt committed but its derived artifact needs repair"
                            ),
                        }
                    }
                    Ok::<_, ToolError>((receipt, wake_member_ids))
                })
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "create_plan: approval worker failed: {err}"
                    ))
                })??;
                if receipt.is_fresh() {
                    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                        &org_ctx.run_id,
                    );
                }
                if receipt.is_fresh() {
                    if let Some(app_handle) = self.context.app_handle.clone() {
                        let wake_hook = AppHandleInboxWakeHook::new(app_handle);
                        for member_id in wake_member_ids {
                            wake_hook.wake_member(&member_id, &org_ctx.run_id);
                        }
                    }
                }
                return receipt.result;
            }
        }

        // User-facing approval path. We already asserted this is a
        // top-level session above; the only remaining contingency is a
        // non-coding agent that registered the tool without a manager,
        // which is a wiring bug (there is no way to submit a plan without
        // the manager — silently writing the file is strictly worse than
        // failing loudly).
        let manager = self.context.plan_approval_manager.as_ref().ok_or_else(|| {
            ToolError::ExecutionFailed(
                "create_plan registered without a PlanApprovalManager — \
                 the Build button approval channel is missing; this is a \
                 wiring bug (only coding-capable top-level sessions \
                 should register this tool)"
                    .into(),
            )
        })?;
        manager
            .mark_ready(
                &session_id,
                &slot.resolved_path.to_string_lossy(),
                &slot.title,
                &content,
                tool_call_id.as_deref(),
            )
            .await;

        let result = CreatePlanResult {
            path: slot.resolved_path.to_string_lossy().into_owned(),
            slug: slot.slug.clone(),
            hash: slot.hash.clone(),
            bytes_written: content.len(),
            new_plan,
            submitted_for_review: true,
        };
        let body = serde_json::to_string(&result).map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "create_plan: failed to serialize success payload: {err}"
            ))
        })?;

        Ok(format!("{PLAN_SUBMITTED_END_TURN_PREFIX}{body}"))
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.context.session_id.lock().await = Some(session_key.to_string());
    }
}

fn resolve_source_plan_task_with_connection(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    member_id: &str,
    requested_task_id: Option<&str>,
) -> Result<Task, String> {
    let tasks = AgentOrgTaskStore::list_with_connection(conn, org_run_id)?;
    let mut candidates = tasks
        .into_iter()
        .filter(|task| {
            task.owner.as_deref() == Some(member_id)
                && task.status == TaskStatus::InProgress
                && task_execution_mode(task) == TaskExecutionMode::Plan
        })
        .collect::<Vec<_>>();
    if let Some(task_id) = requested_task_id {
        return candidates
            .into_iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| {
                format!(
                    "source_task_id '{task_id}' must identify an in_progress plan task owned by member '{member_id}'"
                )
            });
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(format!(
            "create_plan requires an in_progress execution_mode=plan task owned by member '{member_id}'"
        )),
        _ => Err(format!(
            "create_plan found multiple in_progress plan tasks owned by member '{member_id}'; retry with source_task_id"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_without_manager() -> CreatePlanTool {
        CreatePlanTool::new(Arc::new(CreatePlanToolContext::new(
            PlanSlotCache::new(),
            None,
            None,
            None,
            None,
        )))
    }

    #[tokio::test]
    async fn rejects_missing_title() {
        let tool = tool_without_manager();
        tool.set_session_key("s1").await;
        let err = tool
            .execute(
                serde_json::json!({ "content": "body" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("missing title must fail");
        assert!(matches!(err, ToolError::InvalidParams(_)));
    }

    #[tokio::test]
    async fn rejects_blank_title() {
        let tool = tool_without_manager();
        tool.set_session_key("s1").await;
        let err = tool
            .execute(
                serde_json::json!({ "title": "   ", "content": "body" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("blank title must fail");
        assert!(matches!(err, ToolError::InvalidParams(_)));
    }

    #[tokio::test]
    async fn rejects_missing_content() {
        let tool = tool_without_manager();
        tool.set_session_key("s1").await;
        let err = tool
            .execute(
                serde_json::json!({ "title": "Plan A" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("missing content must fail");
        assert!(matches!(err, ToolError::InvalidParams(_)));
    }

    #[tokio::test]
    async fn rejects_blank_content() {
        let tool = tool_without_manager();
        tool.set_session_key("s1").await;
        let err = tool
            .execute(
                serde_json::json!({"title": "A plan", "content": "  \n  "}),
                &crate::tools::traits::CallContext::trusted_sde(),
            )
            .await
            .expect_err("blank plan content must be rejected");
        assert!(err
            .to_string()
            .contains("create_plan content must not be empty"));
    }

    #[tokio::test]
    async fn rejects_when_session_key_unset() {
        let tool = tool_without_manager();
        let err = tool
            .execute(
                serde_json::json!({ "title": "Plan A", "content": "x" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect_err("unset session key must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(_)));
    }

    /// The tool-result sentinel prefix is always emitted on a successful
    /// execute — every call is now top-level and hits `mark_ready`. The
    /// end-to-end stamp + mark flow needs a live DB record for
    /// `get_session`, so it lives in the integration test suite
    /// (`crates/e2e-test/src/sde/exec_modes.rs`), not here.
    #[tokio::test]
    async fn llm_description_includes_live_pending_plan_snapshot() {
        let manager = Arc::new(PlanApprovalManager::new());
        manager
            .mark_ready(
                "session-1",
                "/tmp/current.plan.md",
                "Current approval plan",
                "# Current approval plan\n\nBuild steps.",
                Some("call-current"),
            )
            .await;
        let tool = CreatePlanTool::new(Arc::new(CreatePlanToolContext::new(
            PlanSlotCache::new(),
            Some(manager),
            None,
            None,
            None,
        )));

        let description = tool.llm_description().expect("description");
        assert!(description.contains("CURRENT PENDING PLAN"));
        assert!(description.contains("Current approval plan"));
        assert!(description.contains("call-current"));
        assert!(description.contains("new_plan=false"));
        assert!(description.contains("do not use file tools to edit plan files"));
        assert!(description.contains("do not answer with prose"));
        assert!(!description.contains("/tmp/current.plan.md"));
    }

    #[test]
    fn sentinel_prefix_is_stable() {
        assert_eq!(PLAN_SUBMITTED_END_TURN_PREFIX, "PLAN_SUBMITTED_END_TURN:");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn agent_org_plan_submission_replays_without_duplicate_approval_or_artifact() {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().expect("test sqlite");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::session::persistence::init(&conn).expect("session schema");
        conn.execute_batch(
            "CREATE TABLE code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT NOT NULL,
                status TEXT NOT NULL,
                parent_session_id TEXT,
                org_member_id TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE session_turn_intents (
                session_id TEXT NOT NULL,
                turn_intent_id TEXT NOT NULL,
                client_message_id TEXT,
                org_run_id TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(session_id,turn_intent_id)
            );",
        )
        .expect("base Turn schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = crate::definitions::orgs::AgentOrgLaunchSnapshot {
            schema_version: 1,
            org_id: "plan-org".into(),
            org_name: "Plan Org".into(),
            coordinator_role: "lead".into(),
            coordinator_agent_id: "plan-coordinator-agent".into(),
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            members: vec![crate::definitions::orgs::FlatOrgMember {
                member_id: "planner".into(),
                name: "Planner".into(),
                role: "planner".into(),
                agent_id: "planner-agent".into(),
                runtime_config: None,
            }],
            additional_task_graph_writer_member_ids: Vec::new(),
            member_communication_links: Vec::new(),
        };
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
                 id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
                 entry_mode,status,activation_generation,created_at,updated_at
             ) VALUES ('plan-run','plan-org','plan-coordinator-agent','plan-root',?1,
                       'standalone_session','running',1,?2,?2)",
            rusqlite::params![serde_json::to_string(&snapshot).unwrap(), &now],
        )
        .unwrap();
        let workspace = sandbox.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        for (session_id, member_id, agent_id, parent_session_id) in [
            (
                "plan-root",
                COORDINATOR_MEMBER_ID,
                "plan-coordinator-agent",
                None,
            ),
            (
                "planner-session",
                "planner",
                "planner-agent",
                Some("plan-root"),
            ),
        ] {
            crate::session::persistence::upsert_session(
                &crate::session::persistence::UnifiedSessionRecord {
                    session_id: session_id.into(),
                    name: member_id.into(),
                    status: "running".into(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    session_type: "sde".into(),
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    org_member_id: Some(member_id.into()),
                    agent_definition_id: Some(agent_id.into()),
                    parent_session_id: parent_session_id.map(str::to_string),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO agent_org_runtime_member_materializations (
                 org_run_id,member_id,agent_id,generation,session_id,
                 authority_class,status,created_at,updated_at
             ) VALUES ('plan-run','planner','planner-agent',1,'planner-session',
                       'formal','succeeded',?1,?1)",
            [&now],
        )
        .expect("canonical Planner materialization");
        let task_id = crate::coordination::agent_org_tasks::new_task_id();
        crate::coordination::agent_org_tasks::AgentOrgTaskStore::create(
            crate::coordination::agent_org_tasks::CreateTaskParams {
                id: task_id.clone(),
                org_run_id: "plan-run".into(),
                subject: "Write the implementation plan".into(),
                description: String::new(),
                active_form: None,
                owner: Some("planner".into()),
                status: TaskStatus::InProgress,
                blocks: Vec::new(),
                blocked_by: Vec::new(),
                metadata: Some(serde_json::json!({
                    crate::coordination::agent_org_tasks::TASK_METADATA_EXECUTION_MODE: "plan",
                    crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["planner"]
                })),
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_turn_intents (
                 session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
             ) VALUES ('planner-session','planner-turn','plan-run','agent_org','running',?1,?1)",
            [&now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts (
                 session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
                 task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
                 source_kind,source_id,activation_generation,created_at
             ) VALUES ('planner-session','planner-turn','plan-run','planner','task_execution',
                       ?1,'planner','planner',1,'task',?1,1,?2)",
            rusqlite::params![&task_id, &now],
        )
        .unwrap();
        let org_context = AgentOrgRunContext {
            run_id: "plan-run".into(),
            org_id: "plan-org".into(),
            org_name: "Plan Org".into(),
            org_role: "lead".into(),
            coordinator_agent_id: "plan-coordinator-agent".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "lead".into(),
            members: vec![crate::coordination::agent_org_runs::AgentOrgContextMember {
                member_id: "planner".into(),
                name: "Planner".into(),
                role: "planner".into(),
                agent_id: "planner-agent".into(),
            }],
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            capability_index: crate::definitions::orgs::AgentOrgCapabilityIndex::from_snapshot(
                &snapshot,
            ),
            root_session_id: Some("plan-root".into()),
        };
        let tool = CreatePlanTool::new(Arc::new(CreatePlanToolContext::new(
            PlanSlotCache::new(),
            None,
            Some(org_context),
            Some("planner".into()),
            None,
        )));
        let call = crate::tools::traits::CallContext::for_turn(
            "create-plan-call",
            "planner-session",
            "planner-turn",
            Vec::new(),
        )
        .with_authority(
            crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
                crate::tools::call_context::AgentOrgTurnToolProfile::TaskExecution,
            ),
        );
        let request = serde_json::json!({
            "title": "Small implementation plan",
            "content": "# Plan\n\n1. Implement.\n2. Verify.",
            "source_task_id": task_id
        });
        let first = tool
            .execute_text(request.clone(), &call)
            .await
            .expect("Agent Org plan submission");
        let replay = tool
            .execute_text(request, &call)
            .await
            .expect("same create_plan call replays");
        assert_eq!(replay, first);
        let approvals = AgentOrgPlanApprovalStore::list_pending_by_run("plan-run").unwrap();
        assert_eq!(approvals.len(), 1);
        assert_eq!(
            std::fs::read_to_string(&approvals[0].plan_path).unwrap(),
            "# Plan\n\n1. Implement.\n2. Verify."
        );
        let receipt_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_tool_call_receipts
                 WHERE org_run_id='plan-run' AND tool_name='create_plan'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipt_count, 1);
    }
}
