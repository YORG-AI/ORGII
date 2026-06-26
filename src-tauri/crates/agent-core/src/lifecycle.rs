//! Shared lifecycle helpers for agent sessions.
//!
//! Deduplicates the post-processing that command handlers and background-task
//! launchers perform after `process_message` completes.

use core_types::session_event::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use serde::Serialize;
use tauri::Emitter;

use crate::bus::{broadcast_event, event_pipeline_bridge};
use crate::coordination::agent_inbox::{MemberIdleReason, SYSTEM_SENDER_ID};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, AgentOrgRunStore};
use crate::coordination::agent_org_tasks::{self, AgentOrgTaskStore};
use crate::persistence::db_helpers::AgentSessionStatus;
use crate::session::persistence as session_persistence;
use crate::session::turn::streaming::classify_streaming_error_message;
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

fn e2e_background_llm_disabled() -> bool {
    std::env::var("ORGII_E2E_DISABLE_BACKGROUND_LLM")
        .ok()
        .as_deref()
        == Some("1")
}

/// Wire payload emitted as "session-status-changed" to all Tauri windows so
/// the frontend can update `sessionsAtom` without waiting for the next full
/// session-list poll.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusChangedPayload<'a> {
    session_id: &'a str,
    status: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRenamedPayload<'a> {
    session_id: &'a str,
    name: &'a str,
}

pub fn emit_session_renamed(app_handle: Option<&tauri::AppHandle>, session_id: &str, name: &str) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-renamed",
        SessionRenamedPayload { session_id, name },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-renamed for {}: {}",
            session_id,
            err
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnTerminalStatus {
    Completed,
    Cancelled,
    Failed,
}

impl TurnTerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalTurnSignal {
    pub turn_id: String,
    pub status: TurnTerminalStatus,
    pub completed_at: String,
}

fn emit_session_status_changed(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    status: AgentSessionStatus,
) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-status-changed",
        SessionStatusChangedPayload {
            session_id,
            status: status.as_ref(),
        },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-status-changed for {}: {}",
            session_id,
            err
        );
    }
}

/// Wire payload emitted as "session-account-switched" to all Tauri windows.
///
/// Single event chokepoint for EVERY path that changes a session's account
/// (session_patch, send_message_impl override sync, channel switch,
/// cli_agent_message). Cross-window UIs listen for this instead of relying
/// on the initiating window's optimistic update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionAccountSwitchedPayload<'a> {
    session_id: &'a str,
    from_account_id: Option<&'a str>,
    to_account_id: &'a str,
    model: Option<&'a str>,
}

pub fn emit_session_account_switched(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    from_account_id: Option<&str>,
    to_account_id: &str,
    model: Option<&str>,
) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-account-switched",
        SessionAccountSwitchedPayload {
            session_id,
            from_account_id,
            to_account_id,
            model,
        },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-account-switched for {}: {}",
            session_id,
            err
        );
    }
}

fn persist_and_emit_terminal_turn(
    session_id: &str,
    terminal_turn: &TerminalTurnSignal,
    final_status: AgentSessionStatus,
    app_handle: Option<&tauri::AppHandle>,
) {
    let session_status: crate::session::SessionStatus = final_status.into();
    match session_persistence::finalize_terminal_turn_status(
        session_id,
        &terminal_turn.turn_id,
        terminal_turn.status.as_str(),
        session_status,
        &terminal_turn.completed_at,
    ) {
        Ok(true) => {}
        Ok(false) => tracing::warn!(
            session_id = %session_id,
            turn_id = %terminal_turn.turn_id,
            "[lifecycle] terminal turn marker was not persisted because the session row was missing"
        ),
        Err(err) => tracing::warn!(
            session_id = %session_id,
            turn_id = %terminal_turn.turn_id,
            error = %err,
            "[lifecycle] failed to persist terminal turn marker"
        ),
    }

    emit_session_status_changed(app_handle, session_id, final_status);

    broadcast_event(
        "agent:turn_completed",
        serde_json::json!({
            "sessionId": session_id,
            "turnId": terminal_turn.turn_id,
            "turnStatus": terminal_turn.status.as_str(),
            "sessionStatus": final_status.as_ref(),
            "completedAt": terminal_turn.completed_at,
            "persisted": true,
        }),
    );
}

pub fn build_session_error_event(session_id: &str, message: &str) -> SessionEvent {
    let now = chrono::Utc::now().to_rfc3339();
    let event_id = format!(
        "session-error-{session_id}-{}",
        uuid::Uuid::new_v4().simple()
    );
    let error_code = classify_streaming_error_message(message);
    let mut event = SessionEvent {
        id: event_id.clone(),
        chunk_id: Some(event_id),
        session_id: session_id.to_string(),
        created_at: now,
        function_name: "system".to_string(),
        ui_canonical: "".to_string(),
        action_type: "assistant".to_string(),
        args: serde_json::json!({
            "errorCode": error_code.wire_value(),
            "isRetryable": error_code.is_retryable(),
        }),
        result: serde_json::json!({
            "observation": format!("Error: {message}"),
        }),
        source: EventSource::Assistant,
        display_text: format!("Error: {message}"),
        display_status: EventDisplayStatus::Failed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

pub fn persist_session_error_event(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    message: &str,
) {
    let Some(handle) = app_handle else {
        return;
    };
    event_pipeline_bridge::push_events(
        handle,
        session_id,
        vec![build_session_error_event(session_id, message)],
    );
}

#[derive(Debug)]
struct AgentOrgMemberLifecycleSnapshot {
    context: AgentOrgRunContext,
    member_id: String,
    member_agent_id: String,
    requeued_count: usize,
    agent_exec_mode: Option<crate::session::AgentExecMode>,
}

fn parse_agent_exec_mode(value: Option<&str>) -> Option<crate::session::AgentExecMode> {
    value.and_then(crate::session::AgentExecMode::parse)
}

fn requeue_agent_org_member_in_progress_work(
    session_id: &str,
    enqueue_member_wake: bool,
) -> Result<Option<AgentOrgMemberLifecycleSnapshot>, String> {
    let Some(record) =
        session_persistence::get_session(session_id).map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };
    let Some(member_id) = record.org_member_id else {
        return Ok(None);
    };
    let store = crate::definitions::orgs::orgs_store();
    let Some(context) = AgentOrgRunStore::context_for_session_with_parent_walk(session_id, &store)?
    else {
        return Ok(None);
    };
    let member_agent_id = context
        .require_participant_agent_id(&member_id)?
        .to_string();
    let requeued = AgentOrgTaskStore::requeue_in_progress_for_owner(&context.run_id, &member_id)?;
    if enqueue_member_wake {
        for task in &requeued {
            agent_org_tasks::enqueue_task_assigned_to(
                task,
                &member_agent_id,
                &member_id,
                SYSTEM_SENDER_ID,
                None,
                "system",
            )?;
        }
    }
    Ok(Some(AgentOrgMemberLifecycleSnapshot {
        context,
        member_id,
        member_agent_id,
        requeued_count: requeued.len(),
        agent_exec_mode: parse_agent_exec_mode(record.agent_exec_mode.as_deref()),
    }))
}

pub fn finalize_agent_org_member_turn(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    response: &Result<String, String>,
) {
    let outcome = tokio::task::block_in_place(|| {
        requeue_agent_org_member_in_progress_work(session_id, response.is_ok())
    });

    match outcome {
        Ok(Some(snapshot)) => {
            if snapshot.requeued_count > 0 {
                tracing::info!(
                    session_id = %session_id,
                    run_id = %snapshot.context.run_id,
                    member_id = %snapshot.member_id,
                    requeued_count = snapshot.requeued_count,
                    enqueue_member_wake = response.is_ok(),
                    "[lifecycle] requeued unfinished Agent Org member work after turn finalize"
                );
                if response.is_ok() {
                    if let Some(handle) = app_handle {
                        AppHandleInboxWakeHook::new(handle.clone())
                            .wake_member(&snapshot.member_id, &snapshot.context.run_id);
                    }
                }
            }

            if response.is_ok() {
                // Race-condition guard: a peer may have written an inbox row
                // while this session was Running (which caused the
                // `should_dispatch_wake` gate to skip the wake). Now that the
                // session is transitioning to Idle, check for unread rows and
                // self-wake if any exist. This also runs after task requeue:
                // user group-chat rows must not be stranded behind a requeued
                // TaskAssigned row when a turn is interrupted.
                if let Some(handle) = app_handle {
                    let member_id = snapshot.member_id.clone();
                    let run_id = snapshot.context.run_id.clone();
                    let handle_clone = handle.clone();
                    tokio::spawn(async move {
                        let should_rewake = tokio::task::spawn_blocking({
                            let mid = member_id.clone();
                            let rid = run_id.clone();
                            move || {
                                if matches!(
                                    crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(&rid),
                                    Ok(Some(crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused))
                                ) {
                                    return false;
                                }
                                crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
                                    &mid, &rid,
                                )
                                .map(|rows| !rows.is_empty())
                                .unwrap_or(false)
                            }
                        })
                        .await
                        .unwrap_or(false);

                        if should_rewake {
                            tracing::info!(
                                member_id = %member_id,
                                run_id = %run_id,
                                "[lifecycle] inbox has unread rows after turn end (race-guard); \
                                 re-waking member"
                            );
                            AppHandleInboxWakeHook::new(handle_clone)
                                .wake_member(&member_id, &run_id);
                        }
                    });
                }
            }

            if let Err(err) = response {
                crate::session::turn::member_idle::maybe_emit_member_idle_with_details(
                    Some(&snapshot.context),
                    Some(&snapshot.member_id),
                    MemberIdleReason::Failed,
                    snapshot.agent_exec_mode,
                    None,
                    Some(err.clone()),
                );
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %snapshot.context.run_id,
                    member_id = %snapshot.member_id,
                    member_agent_id = %snapshot.member_agent_id,
                    error = %err,
                    "[lifecycle] Agent Org member turn failed; coordinator was notified and unfinished work was released for review"
                );
            }
        }
        Ok(None) => {}
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[lifecycle] failed to finalize Agent Org member turn work"
            );
        }
    }
}

/// Post-process after `process_message` completes: determine final status,
/// persist it, notify the orchestrator, and broadcast any error event.
///
/// Returns the final `AgentSessionStatus` so callers can act on it.
pub async fn finalize_session(
    session_id: &str,
    response: &Result<String, String>,
    app_handle: Option<&tauri::AppHandle>,
    workspace_path: Option<&std::path::Path>,
    load_workspace_resources: bool,
    terminal_turn: Option<TerminalTurnSignal>,
) -> AgentSessionStatus {
    let is_agent_org_member_session = {
        let sid = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            session_persistence::get_session(&sid)
                .ok()
                .flatten()
                .map(|record| {
                    record.session_type == crate::session::persistence::session_type::ORG_MEMBER
                        || record.org_member_id.is_some()
                })
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    };

    let final_status = if response.is_ok() {
        if is_agent_org_member_session {
            AgentSessionStatus::Idle
        } else {
            AgentSessionStatus::Completed
        }
    } else {
        AgentSessionStatus::Failed
    };

    if let Some(ref terminal_turn) = terminal_turn {
        persist_and_emit_terminal_turn(session_id, terminal_turn, final_status, app_handle);
    } else {
        let sid = session_id.to_string();
        if let Err(err) = tokio::task::spawn_blocking(move || {
            let status: crate::session::SessionStatus = final_status.into();
            if let Err(err) = session_persistence::update_status(&sid, status) {
                tracing::warn!("[lifecycle] Failed to update terminal status for {sid}: {err}");
            }
        })
        .await
        {
            tracing::warn!("[lifecycle] spawn_blocking panicked during status update: {err}");
        }

        emit_session_status_changed(app_handle, session_id, final_status);
    }

    if is_agent_org_member_session {
        finalize_agent_org_member_turn(app_handle, session_id, response);
    }

    if final_status.is_terminal() {
        let sid = session_id.to_string();
        let app_handle_clone = app_handle.cloned();
        if let Err(err) = crate::orchestrator_notify::notify_orchestrator_session_terminal(
            &sid,
            final_status,
            app_handle_clone.as_ref(),
        )
        .await
        {
            tracing::warn!(
                "[lifecycle] Orchestrator notification failed for {}: {}",
                sid,
                err
            );
        }

        crate::orchestrator_notify::notify_routine_fire_session_terminal(
            &sid,
            final_status,
            app_handle_clone.as_ref(),
        )
        .await;
    }

    if let Err(message) = response {
        persist_session_error_event(app_handle, session_id, message);
    }

    // NOTE: Error broadcasting is handled by the scheduler. Do NOT broadcast here
    // to avoid duplicate transient error notifications; this path only persists
    // the authoritative EventStore row for UI history/replay.

    if final_status.is_terminal() {
        crate::session::file_registry::unregister_session(session_id);

        // Fire HookEvent::SessionStop — session lifecycle ended.
        if let Some(root) = workspace_path {
            let executor = crate::specialization::hooks::HookExecutor::load_with_workspace_scope(
                root,
                load_workspace_resources,
            );
            if executor.has_hooks_for(crate::specialization::hooks::HookEvent::SessionStop) {
                let ctx =
                    crate::specialization::hooks::events::HookContext::for_session(session_id)
                        .with_var("ORGII_SESSION_STATUS", final_status.as_ref());
                let sid = session_id.to_string();
                tokio::spawn(async move {
                    executor
                        .run(crate::specialization::hooks::HookEvent::SessionStop, &ctx)
                        .await;
                    tracing::info!("[lifecycle] SessionStop hooks fired for {}", sid);
                });
            }
        }
    }

    // Post-session reflection: fire-and-forget.
    // Gating (per-agent `learnings.enabled`) lives inside
    // `maybe_reflect_on_session` — see reflection.rs. This keeps the decision
    // close to the `AgentDefinition` resolver and out of the lifecycle path.
    if final_status == AgentSessionStatus::Completed && !e2e_background_llm_disabled() {
        let sid = session_id.to_string();
        tokio::spawn(async move {
            match crate::memory::reflection::maybe_reflect_on_session(&sid).await {
                Ok(count) => {
                    tracing::info!(
                        "[lifecycle] Post-session reflection stored {} learnings for {}",
                        count,
                        sid
                    );
                }
                Err(err) => {
                    tracing::info!(
                        "[lifecycle] Post-session reflection skipped for {}: {}",
                        sid,
                        err
                    );
                }
            }
        });

        // Active observation: sibling L3 write path for tool-failure →
        // user-intervention patterns. Same gating semantics as reflection
        // (agent scope, `learningsEnabled`, `reflection_blacklist`); spawn
        // independently so reflection + observation can run in parallel
        // and neither blocks the session-end code path. See
        // `active_learning::maybe_observe_tool_failures`.
        let sid = session_id.to_string();
        tokio::spawn(async move {
            match crate::memory::reflection::active_learning::maybe_observe_tool_failures(&sid)
                .await
            {
                Ok(count) => {
                    tracing::info!(
                        "[lifecycle] Post-session active observation stored {} learnings for {}",
                        count,
                        sid
                    );
                }
                Err(err) => {
                    tracing::info!(
                        "[lifecycle] Post-session active observation skipped for {}: {}",
                        sid,
                        err
                    );
                }
            }
        });
    }

    final_status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::{AgentMessage, MemberIdleReason};
    use crate::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember};
    use crate::session::persistence::{session_type, UnifiedSessionRecord};
    use crate::session::turn::member_idle::{MemberIdleHook, MemberIdleHookGuard};
    use std::sync::{Arc, Mutex};

    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    fn test_serial_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[derive(Debug, Clone)]
    struct IdleCall {
        org_run_id: String,
        coordinator_agent_id: String,
        member_id: String,
        member_agent_id: String,
        member_name: String,
        reason: MemberIdleReason,
        current_mode: Option<crate::session::AgentExecMode>,
        failure_reason: Option<String>,
    }

    #[derive(Default)]
    struct RecordingMemberIdleHook {
        calls: Mutex<Vec<IdleCall>>,
    }

    impl RecordingMemberIdleHook {
        fn snapshot(&self) -> Vec<IdleCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl MemberIdleHook for RecordingMemberIdleHook {
        #[allow(clippy::too_many_arguments)]
        fn post_member_idle(
            &self,
            org_run_id: &str,
            coordinator_agent_id: &str,
            member_id: &str,
            member_agent_id: &str,
            member_name: &str,
            reason: MemberIdleReason,
            current_mode: Option<crate::session::AgentExecMode>,
            _summary: Option<String>,
            failure_reason: Option<String>,
        ) {
            self.calls.lock().unwrap().push(IdleCall {
                org_run_id: org_run_id.to_string(),
                coordinator_agent_id: coordinator_agent_id.to_string(),
                member_id: member_id.to_string(),
                member_agent_id: member_agent_id.to_string(),
                member_name: member_name.to_string(),
                reason,
                current_mode,
                failure_reason,
            });
        }
    }

    fn ensure_runtime_schemas() {
        let conn = database::db::get_connection().expect("test sqlite connection");
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agent_sessions (
                session_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                model TEXT,
                account_id TEXT,
                user_input TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                session_type TEXT NOT NULL DEFAULT 'agent',
                channel TEXT,
                chat_id TEXT,
                workspace_path TEXT,
                work_item_id TEXT,
                agent_role TEXT,
                worktree_path TEXT,
                worktree_branch TEXT,
                base_branch TEXT,
                merge_status TEXT,
                project_slug TEXT,
                agent_definition_id TEXT,
                org_member_id TEXT,
                parent_session_id TEXT,
                parent_event_id TEXT,
                workspace_additional_json TEXT NOT NULL DEFAULT '{}',
                key_source TEXT NOT NULL DEFAULT 'own_key',
                agent_exec_mode TEXT,
                native_harness_type TEXT,
                draft_text TEXT,
                reply_target_event_id TEXT,
                pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS session_token_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                session_type TEXT NOT NULL DEFAULT 'sde',
                model TEXT,
                account_id TEXT,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                context_tokens INTEGER NOT NULL DEFAULT 0,
                context_usage_json TEXT,
                created_at TEXT NOT NULL DEFAULT ''
            );
            "#,
        )
        .expect("agent sessions schema");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("agent org runs schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org tasks schema");
        crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
    }

    fn org_definition(member_agent_id: &str) -> OrgDefinition {
        OrgDefinition {
            id: "org-lifecycle".to_string(),
            name: "Lifecycle Org".to_string(),
            role: "coordinator".to_string(),
            agent_id: "builtin:coord".to_string(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            children: vec![OrgMember {
                id: "member-worker".to_string(),
                name: "Worker".to_string(),
                role: "builder".to_string(),
                agent_id: member_agent_id.to_string(),
                runtime_config: None,
                children: Vec::new(),
            }],
        }
    }

    fn seed_run(member_agent_id: &str) -> String {
        ensure_runtime_schemas();
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(&UnifiedSessionRecord {
            session_id: "root-session".to_string(),
            name: "root".to_string(),
            status: crate::session::SessionStatus::Running.as_str().to_string(),
            session_type: session_type::GENERIC.to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            agent_definition_id: Some("builtin:coord".to_string()),
            ..Default::default()
        })
        .expect("upsert root session");
        crate::session::persistence::upsert_session(&UnifiedSessionRecord {
            session_id: "member-session".to_string(),
            name: "member".to_string(),
            status: crate::session::SessionStatus::Running.as_str().to_string(),
            session_type: session_type::ORG_MEMBER.to_string(),
            created_at: now.clone(),
            updated_at: now,
            agent_definition_id: None,
            org_member_id: Some("member-worker".to_string()),
            parent_session_id: Some("root-session".to_string()),
            agent_exec_mode: Some(crate::session::AgentExecMode::Ask.as_str().to_string()),
            ..Default::default()
        })
        .expect("upsert member session");
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: "org-lifecycle".to_string(),
            coordinator_agent_id: "builtin:coord".to_string(),
            root_session_id: Some("root-session".to_string()),
            org_snapshot: org_definition(member_agent_id),
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        run.id
    }

    fn seed_in_progress_task(run_id: &str, task_id: &str) {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.to_string(),
            org_run_id: run_id.to_string(),
            subject: task_id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-worker".to_string()),
            status: TaskStatus::InProgress,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
        })
        .expect("create in-progress task");
    }

    #[test]
    fn requeue_member_work_uses_context_agent_reference_for_cli_members() {
        let _serial = test_serial_guard();
        let _sandbox = test_helpers::test_env::sandbox();
        let run_id = seed_run("claude_code");
        seed_in_progress_task(&run_id, "cli-task");

        let snapshot = requeue_agent_org_member_in_progress_work("member-session", true)
            .expect("requeue succeeds")
            .expect("member snapshot");

        assert_eq!(snapshot.member_agent_id, "claude_code");
        assert_eq!(snapshot.requeued_count, 1);
        let task = AgentOrgTaskStore::get(&run_id, "cli-task")
            .unwrap()
            .expect("task exists");
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.owner.as_deref(), Some("member-worker"));
        let inbox = crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
            "member-worker",
            &run_id,
        )
        .expect("list member inbox");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].recipient_agent_id, "claude_code");
        match inbox[0].decode_payload().expect("decode task assigned") {
            AgentMessage::TaskAssigned { task_id, .. } => assert_eq!(task_id, "cli-task"),
            other => panic!("unexpected payload: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_member_finalize_requeues_work_without_waking_member_and_notifies_coordinator() {
        let _serial = test_serial_guard();
        let _sandbox = test_helpers::test_env::sandbox();
        let hook = Arc::new(RecordingMemberIdleHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        let run_id = seed_run("builtin:sde");
        seed_in_progress_task(&run_id, "failed-task");

        let error = Err("HTTP 429: rate limit exceeded".to_string());
        finalize_agent_org_member_turn(None, "member-session", &error);

        let task = AgentOrgTaskStore::get(&run_id, "failed-task")
            .unwrap()
            .expect("task exists");
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.owner.as_deref(), Some("member-worker"));
        let member_inbox =
            crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
                "member-worker",
                &run_id,
            )
            .expect("list member inbox");
        assert!(
            member_inbox.is_empty(),
            "failed finalize must not auto-retry the failed member"
        );

        let calls = hook.snapshot();
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.org_run_id, run_id);
        assert_eq!(call.coordinator_agent_id, "builtin:coord");
        assert_eq!(call.member_id, "member-worker");
        assert_eq!(call.member_agent_id, "builtin:sde");
        assert_eq!(call.member_name, "Worker");
        assert_eq!(call.reason, MemberIdleReason::Failed);
        assert_eq!(call.current_mode, Some(crate::session::AgentExecMode::Ask));
        assert_eq!(
            call.failure_reason.as_deref(),
            Some("HTTP 429: rate limit exceeded")
        );
    }
}
