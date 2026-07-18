//! `/agent/test/agent-org/*` endpoints (debug-only).
//!
//! Inter-agent E2E observability probes for Agent Org runs. Most
//! endpoints in this module are **helper-isolation / symbol-pinning**
//! probes (driving an `AgentInboxStore` / `AgentOrgRunContext` helper
//! directly, no live session, no LLM). The caller-path exceptions are
//! `launch-coordinator`, which drives the canonical `session_launch_impl`,
//! and `session-return-to-work`, which drives the production wake scheduler
//! and inbox drain on a materialized member session. Each endpoint's
//! individual doc states which kind it is. Helper-isolation probes catch
//! contract drift cheaply; the deterministic fake-provider return-to-work
//! scenario catches regressions where the real turn processor stops draining
//! or persisting inbox input.
//!
//! Currently exposed:
//!
//! - `POST /test/agent-org/inbox/list-by-run` — list one bounded cursor page
//!   of persisted `agent_inbox` rows tagged with the given `org_run_id`,
//!   decoded into the typed `AgentMessage`. Used by inter-agent communication
//!   E2E to assert "coordinator's send actually landed in the worker's
//!   inbox queue with the right kind/payload".
//! - `POST /test/agent-org/send-message-direct` — drive
//!   `OrgSendMessageTool::execute_text` against a synthetic
//!   `AgentOrgRunContext` supplied in the request body. Pure
//!   helper-isolation probe: no live session, no LLM,
//!   no real run. Used by the deterministic E2E scenarios to pin the
//!   tool's recipient resolution + inbox persistence contract without
//!   the coordinator-launch latency. Returns a stable
//!   `{ok, tool_result | error_kind, error_message}` shape mirroring
//!   the desktop probes.
//! - `POST /test/agent-org/seed` — seed a minimal Agent Org definition
//!   (`coordinator + workers`) into the in-memory + on-disk org store
//!   so the `launch-coordinator` endpoint can reference it by id. The
//!   shape mirrors the production Workforce Manager output, just bypasses
//!   the UI. Idempotent on `id`.
//! - `POST /test/agent-org/launch-coordinator` — start an Agent Org run
//!   by calling the canonical `session_launch_impl` with `agent_org_id`
//!   set. Init parity is automatic because we drive the same path the
//!   production frontend uses; we never re-implement runtime assembly
//!   here.
//! - `POST /test/agent-org/session-return-to-work` — call the same
//!   `agent_org_session_return_to_work_impl` as the Tauri command. This is a
//!   narrow HTTP bridge, not a replacement drain helper: the production
//!   scheduler, turn processor, inbox persistence, and provider path all run.
//!
//! `payload_kind` and `payload_decoded` are returned alongside the raw
//! row so a corrupted serde tag (anti-pattern caught by
//! `kind_tag_matches_serde_tag` in unit tests) shows up here too —
//! E2E is the second line of defense for the same invariant.

#![cfg(debug_assertions)]

use std::sync::Arc;

use axum::Json;

use agent_core::coordination::agent_inbox::AgentInboxStore;
use agent_core::coordination::agent_org_runs::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunStore,
};
use agent_core::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS;
use agent_core::definitions::orgs::{orgs_store, AgentOrgsStore, OrgDefinition, OrgMember};
use agent_core::state::commands::session::org_tasks::agent_org_session_run_view_impl;
use agent_core::tools::error::ToolError;
use agent_core::tools::impls::orchestration::agent_org::tasks::{
    TaskCreateTool, TaskGraphCreateTool, TaskToolsContext, TaskUpdateTool,
};
use agent_core::tools::impls::orchestration::org_send_message::{
    NoopInboxWakeHook, OrgSendMessageTool,
};
use agent_core::tools::traits::Tool;

const E2E_RUN_FIXTURE_ORG_PREFIX: &str = "e2e-agent-org-fixture:";

/// `POST /test/agent-org/seed`
///
/// Body:
/// ```json
/// {
///   "id": "test-org-1",
///   "name": "Test Org",
///   "coordinator_agent_id": "builtin:general",
///   "members": [
///     { "id": "m1", "name": "searcher", "agent_id": "builtin:explore" }
///   ]
/// }
/// ```
///
/// `role` defaults to "coordinator"/"worker".
/// Idempotent on `id` — re-seeding overwrites the prior definition.
pub async fn test_agent_org_seed(Json(body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    use tauri::Manager;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let id = match obj.get("id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return Json(serde_json::json!({ "ok": false, "error": "id is required" })),
    };
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    let coordinator_agent_id = match obj.get("coordinator_agent_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(
                serde_json::json!({ "ok": false, "error": "coordinator_agent_id is required" }),
            )
        }
    };
    let members_value = obj
        .get("members")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let members_array = match members_value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(arr) => arr,
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "members must be an array if provided"
            }))
        }
    };
    let mut children: Vec<OrgMember> = Vec::with_capacity(members_array.len());
    for (idx, item) in members_array.into_iter().enumerate() {
        let Some(obj) = item.as_object() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}] must be an object")
            }));
        };
        let member_id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("m{idx}"));
        let member_name = match obj.get("name").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("members[{idx}].name is required")
                }))
            }
        };
        let agent_id = match obj.get("agent_id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("members[{idx}].agent_id is required")
                }))
            }
        };
        let role = obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "worker".to_string());
        children.push(OrgMember {
            id: member_id,
            name: member_name,
            role,
            agent_id,
            runtime_config: None,
            children: Vec::new(),
        });
    }

    let def = OrgDefinition {
        id: id.clone(),
        name: name.clone(),
        role: "coordinator".to_string(),
        agent_id: coordinator_agent_id.clone(),
        description: Some("E2E test org seeded via /test/agent-org/seed".to_string()),
        hierarchy_mode: Default::default(),
        plan_approval_policy: Default::default(),
        children,
    };

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let store = handle.state::<std::sync::Arc<AgentOrgsStore>>();

    match store.seed_for_test(def) {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "id": id,
            "name": name,
            "coordinator_agent_id": coordinator_agent_id,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "id": id,
            "error": err,
        })),
    }
}

/// `POST /test/agent-org/launch-coordinator`
///
/// Body:
/// ```json
/// {
///   "agent_org_id": "test-org-1",
///   "workspace_path": "/abs/path",
///   "content": "natural language user prompt",
///   "model": "...optional override...",
///   "account_id": "...optional override...",
///   "native_harness_type": "...optional override...",
///   "sync_turn": false
/// }
/// ```
///
/// Drives `session_launch_impl` directly so init parity with the
/// production frontend is automatic. Returns the new `session_id` and
/// `agent_org_run_id` so the E2E can poll completion + read the inbox.
pub async fn test_agent_org_launch_coordinator(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;
    use tracing::info;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let agent_org_id = match obj.get("agent_org_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return Json(serde_json::json!({ "ok": false, "error": "agent_org_id is required" })),
    };
    let workspace_path = match obj.get("workspace_path").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({ "ok": false, "error": "workspace_path is required" }))
        }
    };
    let content = obj
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let sync_turn = obj
        .get("sync_turn")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let account_id = obj
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let native_harness_type = obj
        .get("native_harness_type")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let name_hint = obj.get("name").and_then(|v| v.as_str()).map(str::to_string);
    let sync_workspace_path = std::path::PathBuf::from(&workspace_path);
    let sync_model = model.clone();
    let sync_account_id = account_id.clone();
    let sync_native_harness_type = native_harness_type.clone();

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();
    let org_store = handle.state::<std::sync::Arc<AgentOrgsStore>>();

    let launch_log = format!(
        "[agent-org-e2e] launch-coordinator start org_id={} sync_turn={} native_harness_type={:?} content_len={}",
        agent_org_id,
        sync_turn,
        native_harness_type,
        content.len()
    );
    println!("{launch_log}");
    info!("{launch_log}");

    let params = agent_core::state::commands::session::launch::SessionLaunchParams {
        category: agent_core::state::commands::session::launch::SESSION_CATEGORY_RUST_AGENT
            .to_string(),
        content: if sync_turn {
            String::new()
        } else {
            content.clone()
        },
        workspace_path: Some(workspace_path),
        key_source: None,
        account_id,
        model,
        native_harness_type,
        platform: None,
        branch: None,
        hosted_token: None,
        tier: None,
        name: name_hint,
        background: false,
        images: None,
        ide_context: None,
        agent_definition_id: None,
        agent_org_id: Some(agent_org_id),
        agent_org_member_overrides: std::collections::HashMap::new(),
        apply_agent_org_member_overrides_for_future: false,
        isolate: false,
        mode: None,
        org_id: None,
        project_id: None,
        project_name: None,
        work_item_id: None,
        agent_role: None,
        worktree_path: None,
        project_slug: None,
        parent_session_id: None,
        additional_directories: Vec::new(),
    };

    info!("[agent-org-e2e] launch-coordinator calling session_launch_impl");
    match agent_core::state::commands::session::launch::session_launch_impl(
        &state,
        Some(org_store.inner()),
        params,
    )
    .await
    {
        Ok(result) => {
            info!(
                "[agent-org-e2e] session_launch_impl ok session_id={} run_id={:?}",
                result.session_id, result.agent_org_run_id
            );
            let mut sync_response = None;
            let mut runtime_tool_names: Vec<String> = Vec::new();
            if sync_turn && !content.trim().is_empty() {
                let sync_native_harness_type = sync_native_harness_type
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|value| {
                        core_types::providers::NativeHarnessType::parse(value)
                            .ok_or_else(|| format!("Unknown native_harness_type: {value:?}"))
                    })
                    .transpose();
                let sync_native_harness_type = match sync_native_harness_type {
                    Ok(value) => value,
                    Err(err) => {
                        return Json(serde_json::json!({
                            "ok": false,
                            "session_id": result.session_id,
                            "agent_org_run_id": result.agent_org_run_id,
                            "error": err,
                        }));
                    }
                };
                info!(
                    "[agent-org-e2e] sync_turn building launch spec session_id={}",
                    result.session_id
                );
                let launch_spec =
                    match agent_core::init::launch_spec::AgentLaunchSpec::from_session_sources(
                        &state,
                        &result.session_id,
                        sync_workspace_path.clone(),
                        sync_account_id.clone(),
                        sync_model.clone(),
                        sync_native_harness_type,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(err) => {
                            return Json(serde_json::json!({
                                "ok": false,
                                "session_id": result.session_id,
                                "agent_org_run_id": result.agent_org_run_id,
                                "error": err,
                            }));
                        }
                    };
                info!(
                    "[agent-org-e2e] sync_turn init_session start session_id={}",
                    result.session_id
                );
                if let Err(err) = agent_core::init::init_session(&state, launch_spec).await {
                    return Json(serde_json::json!({
                        "ok": false,
                        "session_id": result.session_id,
                        "agent_org_run_id": result.agent_org_run_id,
                        "error": err,
                    }));
                }
                info!(
                    "[agent-org-e2e] sync_turn init_session ok session_id={}",
                    result.session_id
                );
                let Some(session_arc) = state.get_session(&result.session_id).await else {
                    return Json(serde_json::json!({
                        "ok": false,
                        "session_id": result.session_id,
                        "agent_org_run_id": result.agent_org_run_id,
                        "error": "Session not found after sync init",
                    }));
                };
                if let Some(runtime) = session_arc.runtime.read().await.clone() {
                    runtime_tool_names = runtime.tool_registry.tool_names();
                    runtime_tool_names.sort();
                }
                info!(
                    "[agent-org-e2e] sync_turn runtime tools session_id={} tools={:?}",
                    result.session_id, runtime_tool_names
                );
                let input = agent_core::session::TurnInput {
                    content: content.clone(),
                    ..Default::default()
                };
                const SYNC_TURN_TIMEOUT_SECS: u64 = 180;
                let process_start_log = format!(
                    "[agent-org-e2e] sync_turn process_message start session_id={} timeout_secs={}",
                    result.session_id, SYNC_TURN_TIMEOUT_SECS
                );
                println!("{process_start_log}");
                info!("{process_start_log}");
                let turn_result = tokio::time::timeout(
                    std::time::Duration::from_secs(SYNC_TURN_TIMEOUT_SECS),
                    agent_core::session::process_message(session_arc, input, Some(handle.clone())),
                )
                .await;
                match turn_result {
                    Ok(Ok(response)) => {
                        info!(
                            "[agent-org-e2e] sync_turn process_message ok session_id={} content_len={}",
                            result.session_id,
                            response.content.len()
                        );
                        let content_result = Ok(response.content.clone());
                        agent_core::lifecycle::finalize_session(
                            &result.session_id,
                            &content_result,
                            Some(&handle),
                            Some(sync_workspace_path.as_path()),
                            true,
                            Some(agent_core::lifecycle::TerminalTurnSignal {
                                turn_id: response.turn_id.clone(),
                                status: agent_core::lifecycle::TurnTerminalStatus::Completed,
                                completed_at: chrono::Utc::now()
                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                            }),
                        )
                        .await;
                        sync_response = Some(serde_json::json!({
                            "content": response.content,
                        }));
                    }
                    Ok(Err(err)) => {
                        info!(
                            "[agent-org-e2e] sync_turn process_message error session_id={} error={}",
                            result.session_id,
                            err
                        );
                        let content_result = Err(err.clone());
                        agent_core::lifecycle::finalize_session(
                            &result.session_id,
                            &content_result,
                            Some(&handle),
                            Some(sync_workspace_path.as_path()),
                            true,
                            None,
                        )
                        .await;
                        return Json(serde_json::json!({
                            "ok": false,
                            "session_id": result.session_id,
                            "agent_org_run_id": result.agent_org_run_id,
                            "error": err,
                        }));
                    }
                    Err(_) => {
                        let timeout_log = format!(
                            "[agent-org-e2e] sync_turn process_message timeout session_id={} timeout_secs={}",
                            result.session_id, SYNC_TURN_TIMEOUT_SECS
                        );
                        println!("{timeout_log}");
                        info!("{timeout_log}");
                        let error = format!("sync_turn timed out after {SYNC_TURN_TIMEOUT_SECS}s");
                        let content_result = Err(error.clone());
                        agent_core::lifecycle::finalize_session(
                            &result.session_id,
                            &content_result,
                            Some(&handle),
                            Some(sync_workspace_path.as_path()),
                            true,
                            None,
                        )
                        .await;
                        return Json(serde_json::json!({
                            "ok": false,
                            "session_id": result.session_id,
                            "agent_org_run_id": result.agent_org_run_id,
                            "error": error,
                        }));
                    }
                }
            }
            Json(serde_json::json!({
                "ok": true,
                "session_id": result.session_id,
                "agent_org_run_id": result.agent_org_run_id,
                "agent_org_id": result.agent_org_id,
                "workspace_path": result.workspace_path,
                "sync_response": sync_response,
                "runtime_tool_names": runtime_tool_names,
            }))
        }
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
    }
}

pub async fn test_agent_org_inbox_list_by_run(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_run_id = match obj.get("org_run_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };
    let after_id = match obj.get("after_id") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => match value.as_i64() {
            Some(value) if value >= 0 => Some(value),
            _ => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "after_id must be a non-negative integer when provided"
                }))
            }
        },
    };
    let limit = match obj.get("limit") {
        None | Some(serde_json::Value::Null) => 100usize,
        Some(value) => match value.as_u64().and_then(|value| usize::try_from(value).ok()) {
            Some(value) if value > 0 => value,
            _ => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "limit must be a positive integer when provided"
                }))
            }
        },
    };

    // Pull a bounded page synchronously on the blocking pool; rusqlite is
    // not async-friendly and debug history must not grow one response without
    // bound just because a Run has lived for a long time.
    let org_run_id_for_blocking = org_run_id.clone();
    let listed = tokio::task::spawn_blocking(move || {
        AgentInboxStore::list_page_by_run(&org_run_id_for_blocking, after_id, limit)
    })
    .await;

    match listed {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "org_run_id": org_run_id,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "org_run_id": org_run_id,
            "error": err,
        })),
        Ok(Ok(page)) => {
            let messages: Vec<serde_json::Value> = page
                .rows
                .into_iter()
                .map(|row| {
                    // Decode lazily per row so a single corrupted row
                    // does not poison the entire response — surface the
                    // decode error inline instead.
                    let decoded = match row.decode_payload() {
                        Ok(message) => serde_json::to_value(&message).unwrap_or_else(|err| {
                            serde_json::json!({
                                "decode_error": format!("re-serialize failed: {err}"),
                            })
                        }),
                        Err(err) => serde_json::json!({ "decode_error": err }),
                    };
                    serde_json::json!({
                        "id": row.id,
                        "recipient_agent_id": row.recipient_agent_id,
                        "recipient_member_id": row.recipient_member_id,
                        "sender_agent_id": row.sender_agent_id,
                        "sender_member_id": row.sender_member_id,
                        "org_run_id": row.org_run_id,
                        "payload_kind": row.payload_kind,
                        "request_id": row.request_id,
                        "created_at": row.created_at,
                        "read_at": row.read_at,
                        "payload_decoded": decoded,
                    })
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "org_run_id": org_run_id,
                "messages": messages,
                "has_more": page.has_more,
                "next_cursor": page.next_cursor,
            }))
        }
    }
}

/// `POST /test/agent-org/follow-up-message`
///
/// Drive a follow-up turn on an existing org session
/// (typically the coordinator launched via `/test/agent-org/launch-coordinator`).
/// Wraps `send_message_impl_for_test` so multi-turn LLM scenarios can
/// queue a second user message into a Rust-agent session without
/// having to spin up a fresh launch.
///
/// Body:
/// ```json
/// {
///   "session_id": "...",
///   "content":    "Check your inbox and approve the pending plan.",
///   "model":      "...optional override...",
///   "account_id": "...optional override..."
/// }
/// ```
///
/// Returns the standard `AgentResponse` JSON or `{ok: false, error}`.
pub async fn test_agent_org_follow_up_message(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };
    let content = obj
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let account_id = obj
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    match agent_core::state::commands::session::message::send_message_impl_for_test(
        &state,
        session_id.clone(),
        content,
        model,
        account_id,
    )
    .await
    {
        Ok(resp) => {
            let idle_result = wait_for_session_scheduler_idle(&state, &session_id).await;
            match idle_result {
                Ok(status) => Json(serde_json::json!({
                    "ok": true,
                    "response": serde_json::to_value(&resp).unwrap_or(serde_json::Value::Null),
                    "schedulerStatus": status,
                })),
                Err(err) => Json(serde_json::json!({
                    "ok": false,
                    "response": serde_json::to_value(&resp).unwrap_or(serde_json::Value::Null),
                    "error": err,
                })),
            }
        }
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
    }
}

async fn wait_for_session_scheduler_idle(
    state: &agent_core::state::AgentAppState,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

    let started_at = std::time::Instant::now();
    loop {
        let session = state.get_session(session_id).await.ok_or_else(|| {
            format!("Session not found while waiting for scheduler: {session_id}")
        })?;
        let status = session.scheduler.status();
        if status.pending_count == 0 && !status.is_processing {
            return serde_json::to_value(status).map_err(|err| err.to_string());
        }
        if started_at.elapsed() >= TIMEOUT {
            return Err(format!(
                "Timed out waiting for scheduler idle for {session_id}: pending={} processing={}",
                status.pending_count, status.is_processing
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// `POST /test/agent-org/inbox/seed`
///
/// Insert one `agent_inbox` row directly via
/// [`AgentInboxStore::insert`], bypassing the `OrgSendMessageTool`
/// entirely. Needed for live-LLM scenarios that must seed a
/// `plan_approval_request` — that kind is intentionally not
/// LLM-callable through `org_send_message` (forgery guard, see the
/// `rejects_plan_approval_request_via_send_message` deterministic
/// scenario), so the only way to put one in an inbox for a coordinator
/// to react to is via the same `AgentInboxStore::insert` call that
/// `create_plan` itself uses.
///
/// Body (mirrors `AgentMessage` directly so callers can build any
/// variant):
///
/// ```json
/// {
///   "recipient_agent_id": "builtin:sde",
///   "sender_agent_id":    "builtin:explore",
///   "org_run_id":         "run-...",   // optional; null for global
///   "message": {
///     "kind": "plan_approval_request",
///     "request_id": "plan-req-1",
///     "plan_title": "Refactor",
///     "plan_path":  "/tmp/plan.md",
///     "plan_content": "..."
///   }
/// }
/// ```
///
/// Returns `{ok, id}` on success or `{ok: false, error}` on failure.
pub async fn test_agent_org_inbox_seed(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_inbox::{AgentMessage, InsertInboxParams};

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let recipient_agent_id = match obj.get("recipient_agent_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "recipient_agent_id is required (non-empty string)"
            }))
        }
    };
    let sender_agent_id = match obj.get("sender_agent_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "sender_agent_id is required (non-empty string)"
            }))
        }
    };
    let org_run_id = obj
        .get("org_run_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let recipient_member_id = obj
        .get("recipient_member_id")
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let sender_member_id = obj
        .get("sender_member_id")
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let message_value = match obj.get("message") {
        Some(value) if !value.is_null() => value.clone(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "message is required (AgentMessage object with `kind`)"
            }))
        }
    };
    let message: AgentMessage = match serde_json::from_value(message_value) {
        Ok(m) => m,
        Err(err) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("message did not deserialize as AgentMessage: {err}")
            }))
        }
    };

    let params = InsertInboxParams {
        recipient_agent_id,
        recipient_member_id,
        sender_agent_id,
        sender_member_id,
        org_run_id,
        message,
    };

    match tokio::task::spawn_blocking(move || AgentInboxStore::insert(params)).await {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
        Ok(Ok(id)) => Json(serde_json::json!({
            "ok": true,
            "id": id,
        })),
    }
}

/// `POST /test/agent-org/drain-inbox`
///
/// Helper-isolation probe for the coordinator-side
/// [`drain_and_render_deferred`] side effects (member-shutdown cancel
/// + `MemberTerminated` row insertion).
///
/// Same body shape as `send-message-direct` (the two probes share the
/// org-context builder) plus a top-level `recipient_agent_id` for who
/// is "draining now".
///
/// Operation:
/// 1. Builds an `AgentOrgRunContext` from the supplied org/coordinator/
///    members fields.
/// 2. Constructs a throwaway `AgentSession` (so the side-effect path
///    has the `&AgentSession` it needs for plan-mode cache clearing —
///    not exercised here, but required by the function signature).
/// 3. Calls `drain_and_render_deferred(&ctx, recipient_agent_id, ...)`
///    using the **process-wide installed** `MemberShutdownHook` (so
///    the helper exercises the production hook wiring, not a stub).
/// 4. Calls `commit()` on the returned guard so `mark_read` lands and
///    the next list-by-run reflects the post-drain state.
///
/// **What this probe does cover:** the process-wide
/// `MemberShutdownHook` resolution and the drain helper's render +
/// commit contract. **What it does NOT cover:** that the production
/// caller (`UnifiedMessageProcessor::process`) actually invokes
/// `drain_and_render_deferred` with the correct `org_context` and
/// `recipient_agent_id` at the start of every turn. The full
/// caller-path is exercised by
/// `agent_org::production_return_to_work_drains_inbox_into_member_transcript`,
/// which launches a real member session and uses the deterministic debug
/// provider while leaving the scheduler and turn processor unchanged.
///
/// Response shape: `{ ok: true, drained_count: usize, rendered: usize, messages: Value[] }`.
pub async fn test_agent_org_drain_inbox(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::core::session::turn::inbox_drain::drain_and_render_deferred;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };

    let pluck_string = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };

    let recipient_agent_id = match pluck_string("recipient_agent_id") {
        Some(value) => value,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "recipient_agent_id is required (non-empty string)"
            }))
        }
    };
    let recipient_member_id = pluck_string("recipient_member_id");

    let (org_run_id, org_id, org_name, coordinator_agent_id) = match (
        pluck_string("org_run_id"),
        pluck_string("org_id"),
        pluck_string("org_name"),
        pluck_string("coordinator_agent_id"),
    ) {
        (Some(run), Some(id), Some(name), Some(coord)) => (run, id, name, coord),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id, org_id, org_name and coordinator_agent_id are required"
            }))
        }
    };
    let org_role = pluck_string("org_role").unwrap_or_else(|| "coordinator".to_string());
    let coordinator_name =
        pluck_string("coordinator_name").unwrap_or_else(|| "Coordinator".to_string());
    let coordinator_role =
        pluck_string("coordinator_role").unwrap_or_else(|| "coordinator".to_string());

    let members_value = obj
        .get("members")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let members_array = match members_value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(arr) => arr,
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "members must be an array if provided"
            }))
        }
    };
    let mut members: Vec<AgentOrgContextMember> = Vec::with_capacity(members_array.len());
    for (idx, item) in members_array.into_iter().enumerate() {
        let Some(member_obj) = item.as_object() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}] must be an object")
            }));
        };
        let member_id = member_obj
            .get("member_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let name = member_obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let role = member_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "worker".into());
        let agent_id = member_obj
            .get("agent_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        if name.trim().is_empty() || agent_id.trim().is_empty() {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}].name and members[{idx}].agent_id are required")
            }));
        }
        members.push(AgentOrgContextMember {
            member_id,
            name,
            role,
            agent_id,
            parent_member_id: None,
        });
    }

    let context = AgentOrgRunContext {
        run_id: org_run_id,
        org_id,
        org_name,
        org_role,
        coordinator_agent_id,
        coordinator_name,
        coordinator_role,
        members,
        hierarchy_mode: Default::default(),
        plan_approval_policy: Default::default(),
        root_session_id: None,
    };

    // Construct a throwaway session for the side-effect path. Its plan
    // caches are unused on the shutdown path; we just need a borrowable
    // `&AgentSession`. Pick the SDE definition (matches the rest of
    // the agent-org test surface).
    let definition = agent_core::core::definitions::builtin::sde_agent();
    let identity = format!(
        "{}\0{}\0{}",
        context.run_id,
        recipient_member_id.as_deref().unwrap_or("unknown"),
        recipient_agent_id
    );
    use std::hash::{Hash, Hasher};
    let mut identity_hasher = std::collections::hash_map::DefaultHasher::new();
    identity.hash(&mut identity_hasher);
    let throwaway_session_id = format!("e2e-drain-{:016x}", identity_hasher.finish());
    let session = agent_core::state::AgentSession::new(throwaway_session_id, definition);

    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut guard = drain_and_render_deferred(
        &context,
        &recipient_agent_id,
        recipient_member_id.as_deref(),
        &mut messages,
        Some(&session),
    );
    let drained = guard.drained_count();
    if let Some(transcript) = guard.transcript_content().map(str::to_string) {
        let Some((message_id, intent_id)) = guard.transcript_identity(&session.id) else {
            return Json(serde_json::json!({
                "ok": false,
                "error": "drained Inbox transcript was missing a stable identity"
            }));
        };
        match agent_core::session::persistence::materialize_agent_org_inbox_transcript(
            &session.id,
            guard.new_materialization_ids(),
            &message_id,
            &intent_id,
            &transcript,
        ) {
            Ok((materialization, _)) => guard.remember_materialization(materialization),
            Err(error) => {
                return Json(serde_json::json!({ "ok": false, "error": error }));
            }
        }
    }
    guard.commit();

    Json(serde_json::json!({
        "ok": true,
        "drained_count": drained,
        "rendered": messages.len(),
        "messages": messages,
    }))
}

/// `POST /test/agent-org/session-return-to-work`
///
/// Debug HTTP bridge to the production return-to-work command implementation.
/// It deliberately does not drain or mark any inbox row itself. The invoked
/// implementation must resolve the persisted member session, enqueue the
/// idempotent Agent Org wake, run the real scheduler/turn processor/provider,
/// and observe the production drain's durable acknowledgement.
///
/// Body: `{ "session_id": "agent-..." }`.
/// Response: `{ "ok": true, "woke": true }` on a real wake, or a structured
/// error. E2E preconditions may use a seeded inbox row, but the behavior under
/// test starts at this bridge and cannot pass through `drain-inbox`.
pub async fn test_agent_org_session_return_to_work(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let session_id = match body.get("session_id").and_then(|value| value.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "AppHandle not initialized."
        }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    match agent_core::state::commands::session::org_tasks::agent_org_session_return_to_work_impl(
        &state,
        session_id.clone(),
    )
    .await
    {
        Ok(woke) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "woke": woke,
        })),
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": error,
        })),
    }
}

/// Render a `ToolError` into the stable `{error_kind, error_message}`
/// shape used by the inter-agent E2E scenarios. Mirrors the desktop
/// probes' [`tool_err_kind`] in `agent/test/desktop.rs` — keeping the
/// JSON contract aligned across helper-isolation probes is the
/// cheapest way to keep scenario assertions homogeneous.
fn tool_err_kind(err: &ToolError) -> &'static str {
    match err {
        ToolError::ExecutionFailed(_) => "execution_failed",
        ToolError::InvalidParams(_) => "invalid_params",
        ToolError::PermissionDenied(_) => "permission_denied",
        ToolError::Timeout(_) => "timeout",
    }
}

fn parse_direct_org_context(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<(Arc<AgentOrgRunContext>, String), serde_json::Value> {
    let pluck_string = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };

    let (org_run_id, org_id, org_name, coordinator_agent_id, sender_agent_id) = match (
        pluck_string("org_run_id"),
        pluck_string("org_id"),
        pluck_string("org_name"),
        pluck_string("coordinator_agent_id"),
        pluck_string("sender_agent_id"),
    ) {
        (Some(run), Some(id), Some(name), Some(coord), Some(sender)) => {
            (run, id, name, coord, sender)
        }
        _ => {
            return Err(serde_json::json!({
                "ok": false,
                "error": "org_run_id, org_id, org_name, coordinator_agent_id and sender_agent_id are all required"
            }))
        }
    };

    let org_role = pluck_string("org_role").unwrap_or_else(|| "coordinator".to_string());
    let coordinator_name =
        pluck_string("coordinator_name").unwrap_or_else(|| "Coordinator".to_string());
    let coordinator_role =
        pluck_string("coordinator_role").unwrap_or_else(|| "coordinator".to_string());

    let members_value = obj
        .get("members")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let members_array = match members_value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(arr) => arr,
        _ => {
            return Err(serde_json::json!({
                "ok": false,
                "error": "members must be an array if provided"
            }))
        }
    };
    let mut members: Vec<AgentOrgContextMember> = Vec::with_capacity(members_array.len());
    for (idx, item) in members_array.into_iter().enumerate() {
        let Some(member_obj) = item.as_object() else {
            return Err(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}] must be an object")
            }));
        };
        let member_id = member_obj
            .get("member_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("m{idx}"));
        let name = match member_obj.get("name").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return Err(serde_json::json!({
                    "ok": false,
                    "error": format!("members[{idx}].name is required")
                }))
            }
        };
        let role = member_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "worker".to_string());
        let agent_id = match member_obj.get("agent_id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return Err(serde_json::json!({
                    "ok": false,
                    "error": format!("members[{idx}].agent_id is required")
                }))
            }
        };
        members.push(AgentOrgContextMember {
            member_id,
            name,
            role,
            agent_id,
            parent_member_id: None,
        });
    }

    Ok((
        Arc::new(AgentOrgRunContext {
            run_id: org_run_id,
            org_id,
            org_name,
            org_role,
            coordinator_agent_id,
            coordinator_name,
            coordinator_role,
            members,
            hierarchy_mode: Default::default(),
            plan_approval_policy: Default::default(),
            root_session_id: None,
        }),
        sender_agent_id,
    ))
}

fn resolve_direct_sender_member_id(
    context: &AgentOrgRunContext,
    sender_agent_id: &str,
    explicit_sender_member_id: Option<&str>,
) -> Result<String, String> {
    if let Some(member_id) = explicit_sender_member_id {
        if context.participant_by_member_id(member_id).is_some() {
            return Ok(member_id.to_string());
        }
        return Err(format!(
            "sender_member_id '{member_id}' is not in this Agent Org run"
        ));
    }

    Err(format!(
        "sender_member_id is required for Agent Org test sends; sender_agent_id '{sender_agent_id}' is only backend metadata and cannot identify a participant"
    ))
}

/// `POST /test/agent-org/send-message-direct`
///
/// Helper-isolation probe for `OrgSendMessageTool`.
///
/// Body:
/// ```json
/// {
///   "org_run_id": "run-123",
///   "org_id": "test-org-1",
///   "org_name": "Test Org",
///   "org_role": "coordinator",
///   "coordinator_agent_id": "builtin:general",
///   "coordinator_name": "Coordinator",
///   "coordinator_role": "lead",
///   "members": [
///     {
///       "member_id": "m1",
///       "name": "Searcher",
///       "role": "worker",
///       "agent_id": "builtin:explore"
///     }
///   ],
///   "sender_agent_id": "builtin:general",
///   "params": {
///     "recipient_name": "Searcher",
///     "kind": "plain",
///     "summary": "hello",
///     "text": "please look up X"
///   }
/// }
/// ```
///
/// Response shape (success):
/// ```json
/// { "ok": true, "tool_result": "<plain text from execute_text>" }
/// ```
///
/// Response shape (error):
/// ```json
/// {
///   "ok": false,
///   "error_kind": "invalid_params" | "execution_failed" | "permission_denied" | "timeout",
///   "error_message": "..."
/// }
/// ```
///
/// **Why this exists.** Driving the tool through a real Agent Org run
/// burns ~30s of LLM time per scenario; the resolver/persistence path
/// we want to pin (`recipient_name` lookup, `recipient_broadcast` fanout,
/// inbox row tagging) is purely synchronous Rust code that lives in
/// `OrgSendMessageTool::execute_text`. This endpoint constructs the
/// `AgentOrgRunContext` from the body, builds a fresh tool instance,
/// and calls `execute_text` directly. Layer 9 init parity is preserved
/// because we use the **same** constructor (`OrgSendMessageTool::new`)
/// and the **same** params shape (`OrgSendMessageParams`) the
/// production call site (`tool_assembly::assemble_overlay`) does.
pub async fn test_agent_org_send_message_direct(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };

    let (context, sender_agent_id) = match parse_direct_org_context(obj) {
        Ok(parsed) => parsed,
        Err(err) => return Json(err),
    };

    let Some(params_value) = obj.get("params").cloned() else {
        return Json(serde_json::json!({ "ok": false, "error": "params is required" }));
    };

    let explicit_sender_member_id = obj
        .get("sender_member_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let sender_member_id = match resolve_direct_sender_member_id(
        &context,
        &sender_agent_id,
        explicit_sender_member_id,
    ) {
        Ok(member_id) => member_id,
        Err(error) => {
            return Json(serde_json::json!({
                "ok": false,
                "error_kind": "invalid_params",
                "error_message": error,
            }))
        }
    };

    let tool = OrgSendMessageTool::new(context, sender_member_id);

    match tool
        .execute_text(
            params_value,
            &agent_core::tools::call_context::CallContext::default(),
        )
        .await
    {
        Ok(text) => Json(serde_json::json!({ "ok": true, "tool_result": text })),
        Err(err) => {
            let kind = tool_err_kind(&err);
            let message = err.to_string();
            Json(serde_json::json!({
                "ok": false,
                "error_kind": kind,
                "error_message": message,
            }))
        }
    }
}

/// `POST /test/agent-org/task-tool-direct`
///
/// Helper-isolation probe for the production task tools. The endpoint
/// constructs the same [`TaskToolsContext`] and tool instances that the
/// runtime registry uses, then calls `execute_text` with the caller's
/// `params`. Deterministic E2E uses this to pin task-tool argument
/// validation (notably dependency-cycle typed errors) without an LLM
/// turn.
pub async fn test_agent_org_task_tool_direct(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let (context, sender_agent_id) = match parse_direct_org_context(obj) {
        Ok(parsed) => parsed,
        Err(err) => return Json(err),
    };
    let Some(params_value) = obj.get("params").cloned() else {
        return Json(serde_json::json!({ "ok": false, "error": "params is required" }));
    };
    let operation = match obj.get("operation").and_then(|value| value.as_str()) {
        Some("create") => "create",
        Some("graph_create") => "graph_create",
        Some("update") => "update",
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "operation must be 'create', 'graph_create', or 'update'"
            }))
        }
    };

    let explicit_sender_member_id = obj
        .get("sender_member_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let caller_member_id = match resolve_direct_sender_member_id(
        &context,
        &sender_agent_id,
        explicit_sender_member_id,
    ) {
        Ok(member_id) => member_id,
        Err(error) => {
            return Json(serde_json::json!({
                "ok": false,
                "error_kind": "invalid_params",
                "error_message": error,
            }))
        }
    };
    let ctx = Arc::new(TaskToolsContext {
        org_context: context,
        caller_agent_id: sender_agent_id,
        caller_member_id,
        wake_hook: Arc::new(NoopInboxWakeHook),
    });
    let result = match operation {
        "create" => {
            TaskCreateTool::new(Arc::clone(&ctx))
                .execute_text(
                    params_value,
                    &agent_core::tools::call_context::CallContext::default(),
                )
                .await
        }
        "graph_create" => {
            TaskGraphCreateTool::new(Arc::clone(&ctx))
                .execute_text(
                    params_value,
                    &agent_core::tools::call_context::CallContext::default(),
                )
                .await
        }
        "update" => {
            TaskUpdateTool::new(Arc::clone(&ctx))
                .execute_text(
                    params_value,
                    &agent_core::tools::call_context::CallContext::default(),
                )
                .await
        }
        _ => unreachable!(),
    };

    match result {
        Ok(text) => Json(serde_json::json!({ "ok": true, "tool_result": text })),
        Err(err) => {
            let kind = tool_err_kind(&err);
            let message = err.to_string();
            Json(serde_json::json!({
                "ok": false,
                "error_kind": kind,
                "error_message": message,
            }))
        }
    }
}

/// `POST /test/agent-org/run-view`
///
/// Read-only HTTP bridge to the production Agent Org Run View projection.
/// It is used for runtime/read-model assertions only; opening this view must
/// not reconcile or otherwise mutate the run.
pub async fn test_agent_org_run_view(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    match agent_org_session_run_view_impl(&state, &session_id).await {
        Ok(Some(view)) => Json(serde_json::json!({
            "ok": true,
            "found": true,
            "view": view,
        })),
        Ok(None) => Json(serde_json::json!({
            "ok": true,
            "found": false,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
    }
}

pub async fn test_agent_org_durable_invariants(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use rusqlite::{params, OptionalExtension};

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_run_id = match obj.get("org_run_id").and_then(|value| value.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };

    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        let run_row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT status, root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((run_status, root_session_id)) = run_row else {
            return Ok(serde_json::json!({ "ok": true, "found": false }));
        };

        let open_task_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_tasks
                 WHERE org_run_id = ?1 AND status IN ('pending', 'in_progress')",
                params![org_run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        let ownerless_in_progress_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_tasks
                 WHERE org_run_id = ?1
                   AND status = 'in_progress'
                   AND (owner IS NULL OR TRIM(owner) = '')",
                params![org_run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        let unread_inbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_inbox
                 WHERE org_run_id = ?1 AND read_at IS NULL",
                params![org_run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;

        let live_worker_count = match root_session_id {
            Some(root_session_id) => {
                let rust_live: i64 = conn
                    .query_row(
                        "WITH RECURSIVE descendants(session_id) AS (
                             SELECT session_id FROM agent_sessions WHERE parent_session_id = ?1
                             UNION ALL
                             SELECT s.session_id
                             FROM agent_sessions s
                             JOIN descendants d ON s.parent_session_id = d.session_id
                         )
                         SELECT COUNT(*)
                         FROM agent_sessions s
                         JOIN descendants d USING (session_id)
                         WHERE s.status NOT IN ('completed', 'failed', 'cancelled', 'abandoned')",
                        params![root_session_id],
                        |row| row.get(0),
                    )
                    .map_err(|err| err.to_string())?;
                let cli_live: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM code_sessions
                         WHERE parent_session_id = ?1
                           AND org_member_id IS NOT NULL
                           AND status NOT IN ('completed', 'failed', 'cancelled')",
                        params![root_session_id],
                        |row| row.get(0),
                    )
                    .map_err(|err| err.to_string())?;
                rust_live + cli_live
            }
            None => 0,
        };

        let running_open_work_without_live_worker =
            run_status == "running" && live_worker_count == 0 && open_task_count > 0;
        Ok(serde_json::json!({
            "ok": true,
            "found": true,
            "runStatus": run_status,
            "liveWorkerCount": live_worker_count,
            "openTaskCount": open_task_count,
            "ownerlessInProgressCount": ownerless_in_progress_count,
            "unreadInboxCount": unread_inbox_count,
            "runningOpenWorkWithoutLiveWorker": running_open_work_without_live_worker,
        }))
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Err(err) => Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
    }
}

pub async fn test_agent_org_seed_stale_worker_run(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, CreateAgentOrgRunParams, COORDINATOR_MEMBER_ID,
    };
    use agent_core::core::definitions::orgs::{OrgDefinition, OrgMember};
    use agent_core::core::session::persistence::{
        session_type, upsert_session, UnifiedSessionRecord,
    };
    use agent_core::core::session::SessionStatus;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_id = obj
        .get("org_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("test-org-stale-workers")
        .to_string();
    let coordinator_agent_id = obj
        .get("coordinator_agent_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("coord")
        .to_string();
    let root_session_id = obj
        .get("root_session_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("agent-org-stale-root-{}", uuid::Uuid::new_v4()));
    let workers = match obj.get("workers").and_then(|value| value.as_array()) {
        Some(value) if !value.is_empty() => value.clone(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "workers must be a non-empty array"
            }))
        }
    };

    let result = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        agent_core::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::core::session::persistence::init(&conn).map_err(|err| err.to_string())?;
        agent_core::coordination::agent_org_runs::init_schema(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::coordination::agent_member_interventions::init_schema(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::coordination::agent_org_tasks::init_schema(&conn)
            .map_err(|err| err.to_string())?;

        let now = chrono::Utc::now().to_rfc3339();
        upsert_session(&UnifiedSessionRecord {
            session_id: root_session_id.clone(),
            name: "stale-worker-root".to_string(),
            status: SessionStatus::Running.as_str().to_string(),
            session_type: session_type::GENERIC.to_string(),
            agent_definition_id: Some(coordinator_agent_id.clone()),
            org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            created_at: now.clone(),
            updated_at: now.clone(),
            ..Default::default()
        })
        .map_err(|err| err.to_string())?;

        let org_snapshot_children = workers
            .iter()
            .enumerate()
            .map(|(index, worker)| {
                let worker_obj = worker
                    .as_object()
                    .ok_or_else(|| "each worker must be an object".to_string())?;
                let agent_definition_id = worker_obj
                    .get("agent_definition_id")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "worker.agent_definition_id is required".to_string())?
                    .to_string();
                let member_id = worker_obj
                    .get("member_id")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("worker-{index}"));
                Ok(OrgMember {
                    id: member_id.clone(),
                    name: member_id,
                    role: "worker".to_string(),
                    agent_id: agent_definition_id,
                    runtime_config: None,
                    children: Vec::new(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let org_snapshot = OrgDefinition {
            id: org_id.clone(),
            name: org_id.clone(),
            role: "coordinator".to_string(),
            agent_id: coordinator_agent_id.clone(),
            description: None,
            hierarchy_mode: Default::default(),
            plan_approval_policy: Default::default(),
            children: org_snapshot_children,
        };

        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id,
            coordinator_agent_id,
            root_session_id: Some(root_session_id.clone()),
            org_snapshot,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })?;

        let mut worker_sessions = Vec::new();
        for worker in workers {
            let Some(worker_obj) = worker.as_object() else {
                return Err("each worker must be an object".to_string());
            };
            let agent_definition_id = worker_obj
                .get("agent_definition_id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "worker.agent_definition_id is required".to_string())?
                .to_string();
            let member_id = worker_obj
                .get("member_id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string);
            let session_id = worker_obj
                .get("session_id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("agent-org-stale-worker-{}", uuid::Uuid::new_v4()));
            let updated_at = worker_obj
                .get("updated_at")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| now.clone());
            let status = match worker_obj.get("status").and_then(|value| value.as_str()) {
                Some(value) => match SessionStatus::parse(value) {
                    Some(parsed) => parsed,
                    None => return Err(format!("unknown worker.status value: {value}")),
                },
                None => SessionStatus::Running,
            };

            upsert_session(&UnifiedSessionRecord {
                session_id: session_id.clone(),
                name: format!("stale-worker-{agent_definition_id}"),
                status: status.as_str().to_string(),
                session_type: session_type::ORG_MEMBER.to_string(),
                parent_session_id: Some(root_session_id.clone()),
                agent_definition_id: Some(agent_definition_id.clone()),
                org_member_id: member_id,
                created_at: updated_at.clone(),
                updated_at: updated_at.clone(),
                ..Default::default()
            })
            .map_err(|err| err.to_string())?;
            worker_sessions.push(serde_json::json!({
                "session_id": session_id,
                "agent_definition_id": agent_definition_id,
                "updated_at": updated_at,
                "status": status.as_str(),
            }));
        }

        Ok::<serde_json::Value, String>(serde_json::json!({
            "ok": true,
            "org_run_id": run.id,
            "root_session_id": root_session_id,
            "worker_sessions": worker_sessions,
        }))
    })
    .await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(value)) => Json(value),
    }
}

/// `POST /test/agent-org/find-worker-session`
///
/// Read-only bridge around
/// [`AgentOrgRunStore::find_worker_session_by_member_id`]. Runtime scenarios
/// use it to poll production background member materialization and to obtain
/// the real session id needed for a subsequent caller-path action. A status
/// value alone is not accepted as proof of inbox delivery; the production
/// return-to-work scenario also checks `read_at` and persisted transcript
/// input.
pub async fn test_agent_org_find_worker_session(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_run_id = match obj.get("org_run_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };
    let member_id = match obj.get("member_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "member_id is required (non-empty string)"
            }))
        }
    };

    let lookup = tokio::task::spawn_blocking({
        let run = org_run_id.clone();
        let member = member_id.clone();
        move || AgentOrgRunStore::find_worker_session_by_member_id(&run, &member)
    })
    .await;

    match lookup {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
        Ok(Ok(None)) => Json(serde_json::json!({
            "ok": true,
            "found": false,
        })),
        Ok(Ok(Some(info))) => Json(serde_json::json!({
            "ok": true,
            "found": true,
            "session_id": info.session_id,
            "status": info.status.as_str(),
        })),
    }
}

/// `POST /test/agent-org/check-member-spawn-gate`
///
/// **Symbol-pinning probe** for the org-member spawn gate.
/// Wraps the production [`org_roster_spawn_rejection`] helper from
/// `agent_core::tools::impls::orchestration::agent`, so this
/// endpoint exercises the **exact same symbol** `AgentTool::execute`
/// calls. If a future refactor swaps the production caller to a stub
/// or re-implementation, this probe stops matching the real behavior
/// and the diff is observable from E2E.
///
/// This is **not** a caller-path probe: it does not drive
/// `AgentTool::execute(_text)?` end-to-end. Caller-path claims for the agent
/// tool must therefore come from session-scoped tool-policy/runtime tests or
/// rendered E2E, not from this endpoint. Caveat: if
/// `AgentTool::execute` ever stops calling
/// `org_roster_spawn_rejection` (e.g. someone inlines the check or
/// short-circuits earlier), this probe still passes.
///
/// Body:
/// ```json
/// {
///   "is_shadow": false,
///   "is_org_member": true,
///   "org_context": {
///     "run_id": "...",
///     "org_id": "...",
///     "org_name": "...",
///     "org_role": "lead",
///     "coordinator_agent_id": "alice",
///     "coordinator_name": "Alice",
///     "coordinator_role": "lead",
///     "members": [
///       { "member_id": "m1", "name": "Bob", "role": "worker", "agent_id": "bob" }
///     ]
///   },
///   "target_agent_id": "bob",
///   "is_background": false
/// }
/// ```
///
/// Response (rejection):
/// ```json
/// { "ok": true, "rejected": true, "error_kind": "execution_failed", "error_message": "Org members ..." }
/// ```
///
/// Response (allowed):
/// ```json
/// { "ok": true, "rejected": false }
/// ```
pub async fn test_agent_org_check_member_spawn_gate(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::tools::impls::orchestration::agent::org_roster_spawn_rejection;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };

    let is_shadow = obj
        .get("is_shadow")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_org_member = obj
        .get("is_org_member")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_background = obj
        .get("is_background")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let target_agent_id = match obj.get("target_agent_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "target_agent_id is required (non-empty string)"
            }))
        }
    };

    // Optional org context. None ⇒ exercise the "non-org session"
    // branch of the helper. We build the typed struct manually because
    // `AgentOrgRunContext` is intentionally Serialize-only in the
    // production module (consumers construct it via
    // `load_agent_org_context`, not by deserializing untrusted input).
    let org_context: Option<AgentOrgRunContext> = match obj.get("org_context") {
        Some(value) if !value.is_null() => {
            let Some(ctx_obj) = value.as_object() else {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "org_context must be an object",
                }));
            };
            let pluck_str = |key: &str| -> String {
                ctx_obj
                    .get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let coordinator_agent_id = ctx_obj
                .get("coordinator_agent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if coordinator_agent_id.is_empty() {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "org_context.coordinator_agent_id is required (non-empty string)",
                }));
            }
            let members_value = ctx_obj
                .get("members")
                .cloned()
                .unwrap_or(serde_json::Value::Array(vec![]));
            let Some(members_array) = members_value.as_array() else {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "org_context.members must be an array",
                }));
            };
            let mut members = Vec::with_capacity(members_array.len());
            for entry in members_array {
                let Some(member_obj) = entry.as_object() else {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": "each member must be an object",
                    }));
                };
                let agent_id = member_obj
                    .get("agent_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if agent_id.is_empty() {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": "each member must have a non-empty agent_id",
                    }));
                }
                members.push(AgentOrgContextMember {
                    member_id: member_obj
                        .get("member_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: member_obj
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    role: member_obj
                        .get("role")
                        .and_then(|v| v.as_str())
                        .unwrap_or("worker")
                        .to_string(),
                    agent_id,
                    parent_member_id: None,
                });
            }
            Some(AgentOrgRunContext {
                run_id: pluck_str("run_id"),
                org_id: pluck_str("org_id"),
                org_name: pluck_str("org_name"),
                org_role: pluck_str("org_role"),
                coordinator_agent_id,
                coordinator_name: pluck_str("coordinator_name"),
                coordinator_role: pluck_str("coordinator_role"),
                members,
                hierarchy_mode: Default::default(),
                plan_approval_policy: Default::default(),
                root_session_id: None,
            })
        }
        _ => None,
    };

    let outcome = org_roster_spawn_rejection(
        is_shadow,
        is_org_member,
        org_context.as_ref(),
        &target_agent_id,
        is_background,
    );

    match outcome {
        None => Json(serde_json::json!({
            "ok": true,
            "rejected": false,
        })),
        Some(err) => {
            let kind = tool_err_kind(&err);
            let message = err.to_string();
            Json(serde_json::json!({
                "ok": true,
                "rejected": true,
                "error_kind": kind,
                "error_message": message,
            }))
        }
    }
}

/// `POST /test/agent-org/post-member-idle`
///
/// Helper-isolation probe for the worker-side member-idle emit.
/// Drives [`maybe_emit_member_idle`] **directly** against a
/// synthetic `AgentOrgRunContext` and member identity. The
/// process-wide [`MemberIdleHook`] is resolved through the same
/// `OnceLock` the production turn-end uses (no test override is
/// installed, so the real `InboxStoreMemberIdleHook` lands the row in
/// `agent_inbox`).
///
/// **What this probe does cover:** the production hook's persistence
/// contract (sender == `SYSTEM_SENDER_ID`, recipient == coordinator,
/// payload kind/reason), and the helper's coordinator-skip /
/// member-not-in-roster short-circuits. Combined with
/// `inbox/list-by-run`, the E2E suite asserts the producer → store
/// contract:
///
/// 1. The correct recipient (coordinator agent_id) gets the row.
/// 2. The correct sender (`SYSTEM_SENDER_ID`) is stamped, so the LLM
///    cannot forge it.
/// 3. The decoded payload kind is `member_idle` with the requested
///    reason.
///
/// **What this probe does NOT cover:** that
/// [`agent_core::core::session::turn::processor::UnifiedMessageProcessor::process`]
/// actually invokes `maybe_emit_member_idle` at turn end with the
/// right `idle_reason` (Cancelled → Interrupted, Completed →
/// Available). The completed/Available caller path is exercised incidentally
/// by the production return-to-work scenario, which runs a real member turn;
/// Interrupted and Failed lifecycle classification remain pinned by focused
/// lifecycle/unit coverage rather than this helper endpoint.
///
/// Body shape mirrors the other agent-org probes (`org_run_id`,
/// `coordinator_agent_id`, `members`, plus a top-level
/// `member_agent_id` and `reason`):
/// ```json
/// {
///   "org_run_id": "run-1",
///   "org_id": "test-org-1",
///   "org_name": "Test Org",
///   "coordinator_agent_id": "coord",
///   "coordinator_name": "Coordinator",
///   "members": [
///     { "member_id": "m1", "name": "Alice", "role": "worker", "agent_id": "alice-1" }
///   ],
///   "member_agent_id": "alice-1",
///   "reason": "available"
/// }
/// ```
///
/// `reason` accepts `"available"`, `"interrupted"`, or `"failed"`
/// (snake_case). When `reason == "failed"`, a non-empty
/// `failure_reason` string is required to satisfy
/// `AgentMessage::MemberIdle::validate`.
///
/// Response shape: `{ ok: true, emitted: bool, recipient_agent_id?, member_agent_id? }`
/// — `emitted = false` when the requested member_agent_id is the
/// coordinator itself or is not in the member roster (production
/// no-op).
pub async fn test_agent_org_post_member_idle(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_inbox::MemberIdleReason;
    use agent_core::core::session::turn::member_idle::maybe_emit_member_idle_with_details;
    use agent_core::session::AgentExecMode;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };

    let pluck_string = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };

    let member_agent_id = match pluck_string("member_agent_id") {
        Some(value) => value,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "member_agent_id is required (non-empty string)"
            }))
        }
    };

    let reason = match pluck_string("reason").as_deref() {
        Some("available") | None => MemberIdleReason::Available,
        Some("interrupted") => MemberIdleReason::Interrupted,
        Some("failed") => MemberIdleReason::Failed,
        Some(other) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!(
                    "reason must be one of available|interrupted|failed (got {other:?})"
                ),
            }))
        }
    };

    let current_mode = match pluck_string("current_mode") {
        Some(value) => match AgentExecMode::parse(&value) {
            Some(mode) => Some(mode),
            None => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("current_mode must be a known AgentExecMode (got {value:?})")
                }))
            }
        },
        None => None,
    };
    let failure_reason = pluck_string("failure_reason");
    if reason == MemberIdleReason::Failed && failure_reason.is_none() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "failure_reason is required when reason is failed"
        }));
    }

    let (org_run_id, org_id, org_name, coordinator_agent_id) = match (
        pluck_string("org_run_id"),
        pluck_string("org_id"),
        pluck_string("org_name"),
        pluck_string("coordinator_agent_id"),
    ) {
        (Some(run), Some(id), Some(name), Some(coord)) => (run, id, name, coord),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id, org_id, org_name and coordinator_agent_id are required"
            }))
        }
    };
    let org_role = pluck_string("org_role").unwrap_or_else(|| "coordinator".to_string());
    let coordinator_name =
        pluck_string("coordinator_name").unwrap_or_else(|| "Coordinator".to_string());
    let coordinator_role =
        pluck_string("coordinator_role").unwrap_or_else(|| "coordinator".to_string());

    let members_value = obj
        .get("members")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let members_array = match members_value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(arr) => arr,
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "members must be an array if provided"
            }))
        }
    };
    let mut members: Vec<AgentOrgContextMember> = Vec::with_capacity(members_array.len());
    for (idx, item) in members_array.into_iter().enumerate() {
        let Some(member_obj) = item.as_object() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}] must be an object")
            }));
        };
        let member_id = member_obj
            .get("member_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let name = member_obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let role = member_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "worker".into());
        let agent_id = member_obj
            .get("agent_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        if name.trim().is_empty() || agent_id.trim().is_empty() {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{idx}].name and members[{idx}].agent_id are required")
            }));
        }
        members.push(AgentOrgContextMember {
            member_id,
            name,
            role,
            agent_id,
            parent_member_id: None,
        });
    }

    let context = AgentOrgRunContext {
        run_id: org_run_id.clone(),
        org_id,
        org_name,
        org_role,
        coordinator_agent_id: coordinator_agent_id.clone(),
        coordinator_name,
        coordinator_role,
        members,
        hierarchy_mode: Default::default(),
        plan_approval_policy: Default::default(),
        root_session_id: None,
    };

    // Snapshot the row count before emit so we can attribute the new
    // row to this call instead of relying on a global "0 → 1"
    // invariant (the test DB may have unrelated rows).
    let before_count = AgentInboxStore::count_by_run(&org_run_id).unwrap_or(0);

    let member_id = obj
        .get("member_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            let mut matching_members = context
                .members
                .iter()
                .filter(|member| member.agent_id == member_agent_id);
            let member = matching_members.next()?;
            if matching_members.next().is_some() {
                return None;
            }
            Some(member.member_id.clone())
        });

    maybe_emit_member_idle_with_details(
        Some(&context),
        member_id.as_deref(),
        reason,
        current_mode,
        None,
        failure_reason,
        Vec::new(),
    );

    let after_count = AgentInboxStore::count_by_run(&org_run_id).unwrap_or(before_count);
    let emitted = after_count > before_count;

    Json(serde_json::json!({
        "ok": true,
        "emitted": emitted,
        "recipient_agent_id": coordinator_agent_id,
        "member_agent_id": member_agent_id,
        "before_count": before_count,
        "after_count": after_count,
    }))
}

// ────────────────────────────────────────────────────────────────────────
// Agent Org task store probes
// ────────────────────────────────────────────────────────────────────────

/// `POST /test/agent-org/run/seed`
///
/// Create a real `Running` run row for deterministic HTTP E2E fixtures.
/// Production task mutation requires this row, so real-binary tests establish
/// the same invariant explicitly instead of depending on a unit-test bypass.
pub async fn test_agent_org_run_seed(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, CreateAgentOrgRunParams,
    };

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_id = obj
        .get("org_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("agent-org-e2e-{}", uuid::Uuid::new_v4()));
    let org_name = obj
        .get("org_name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Agent Org E2E")
        .to_string();
    let org_role = obj
        .get("org_role")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("coordinator")
        .to_string();
    let coordinator_agent_id = obj
        .get("coordinator_agent_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("coord")
        .to_string();
    let Some(members) = obj.get("members").and_then(|value| value.as_array()) else {
        return Json(serde_json::json!({ "ok": false, "error": "members must be an array" }));
    };
    let mut children = Vec::with_capacity(members.len());
    for (index, member) in members.iter().enumerate() {
        let Some(member) = member.as_object() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{index}] must be an object")
            }));
        };
        let member_id = member
            .get("member_id")
            .or_else(|| member.get("id"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("m{index}"));
        let Some(agent_id) = member
            .get("agent_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
        else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("members[{index}].agent_id is required")
            }));
        };
        children.push(OrgMember {
            id: member_id.clone(),
            name: member
                .get("name")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&member_id)
                .to_string(),
            role: member
                .get("role")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("worker")
                .to_string(),
            agent_id: agent_id.to_string(),
            runtime_config: None,
            children: Vec::new(),
        });
    }

    let result = tokio::task::spawn_blocking(move || {
        AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: org_id.clone(),
            coordinator_agent_id: coordinator_agent_id.clone(),
            root_session_id: None,
            org_snapshot: OrgDefinition {
                id: org_id,
                name: org_name,
                role: org_role,
                agent_id: coordinator_agent_id,
                description: Some("Deterministic real-binary E2E fixture".to_string()),
                hierarchy_mode: Default::default(),
                plan_approval_policy: Default::default(),
                children,
            },
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
    })
    .await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}")
        })),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Ok(Ok(run)) => Json(serde_json::json!({
            "ok": true,
            "org_run_id": run.id,
            "run_status": run.status.as_str()
        })),
    }
}

/// `POST /test/agent-org/run/cleanup`
///
/// Delete runs created by the deterministic `run/seed` and stale-worker
/// fixtures. With `org_run_id`, cleanup is scoped to that one run; without it,
/// every run carrying the reserved E2E fixture org prefix is removed. The
/// prefix guard prevents this debug-only endpoint from deleting a real run.
pub async fn test_agent_org_run_cleanup(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let requested_run_id = body
        .get("org_run_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let result = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let run_ids = {
            let conn = database::db::get_connection().map_err(|err| err.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id
                     FROM agent_org_runs
                     WHERE org_id LIKE ?1
                       AND (?2 IS NULL OR id = ?2)",
                )
                .map_err(|err| err.to_string())?;
            let prefix_pattern = format!("{E2E_RUN_FIXTURE_ORG_PREFIX}%");
            let rows = stmt
                .query_map(rusqlite::params![prefix_pattern, requested_run_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };

        for run_id in &run_ids {
            AgentOrgRunStore::delete_by_id(run_id)?;
        }
        Ok(run_ids)
    })
    .await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}")
        })),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Ok(Ok(run_ids)) => Json(serde_json::json!({
            "ok": true,
            "deleted_count": run_ids.len(),
            "deleted_run_ids": run_ids,
        })),
    }
}

/// `POST /test/agent-org/tasks/seed`
///
/// Insert one row directly via [`AgentOrgTaskStore::create`]. This
/// bypasses the LLM-callable
/// `task_create` tool so a deterministic E2E can plant a task in any
/// initial state (e.g. unowned, owned-and-in-progress, completed) and
/// then exercise the read paths (`drain-inbox`, explicit assignment,
/// shutdown-driven unassign, etc.).
///
/// Body:
/// ```json
/// {
///   "id": "task-1",
///   "org_run_id": "run-...",
///   "subject": "Refactor auth",
///   "description": "...",
///   "active_form": "Refactoring auth",
///   "owner": "alice-agent",
///   "status": "in_progress",
///   "blocks": [],
///   "blocked_by": []
/// }
/// ```
///
/// `description`/`active_form` default to empty/null. `status` defaults
/// to `"pending"`. `owner` defaults to null (awaiting assignment). Returns
/// `{ok, id}` on success.
pub async fn test_agent_org_tasks_seed(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_org_plan_approvals::{
        AgentOrgPlanApprovalStore, CreateAgentOrgPlanApprovalParams,
    };
    use agent_core::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    use agent_core::coordination::agent_org_tasks::{
        AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_EXECUTION_MODE,
    };
    use agent_core::core::session::persistence::{
        session_type, upsert_session, UnifiedSessionRecord,
    };
    use agent_core::core::session::SessionStatus;
    use agent_core::definitions::orgs::PlanApprovalPolicy;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let id = match obj.get("id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return Json(serde_json::json!({ "ok": false, "error": "id is required" })),
    };
    let org_run_id = match obj.get("org_run_id").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return Json(serde_json::json!({ "ok": false, "error": "org_run_id is required" })),
    };
    let subject = match obj.get("subject").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return Json(serde_json::json!({ "ok": false, "error": "subject is required" })),
    };
    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let active_form = obj
        .get("active_form")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let owner = obj
        .get("owner")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let status_str = obj
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending");
    let status = match status_str {
        "pending" => TaskStatus::Pending,
        "in_progress" => TaskStatus::InProgress,
        "completed" => TaskStatus::Completed,
        other => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("unknown status '{other}' — expected pending|in_progress|completed"),
            }))
        }
    };
    let blocks = obj
        .get("blocks")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let blocked_by = obj
        .get("blocked_by")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let requested_eligible_member_ids = obj
        .get("eligible_member_ids")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        });
    let execution_mode = match obj.get("execution_mode").and_then(|value| value.as_str()) {
        None => None,
        Some("build") => Some("build".to_string()),
        Some("plan") => Some("plan".to_string()),
        Some(other) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("unknown execution_mode '{other}' — expected build|plan"),
            }))
        }
    };
    let pending_plan_approval = obj.get("pending_plan_approval").cloned();

    let mut params = CreateTaskParams {
        id: id.clone(),
        org_run_id,
        subject,
        description,
        active_form,
        owner,
        status,
        blocks,
        blocked_by,
        metadata: None,
    };

    match tokio::task::spawn_blocking(move || {
        let eligible_member_ids = match requested_eligible_member_ids {
            Some(member_ids) => Some(member_ids),
            None if params.owner.is_none() && params.status == TaskStatus::Pending => Some(
                AgentOrgRunStore::context_for_run(&params.org_run_id, &orgs_store())?
                    .map(|context| {
                        context
                            .members
                            .into_iter()
                            .map(|member| member.member_id)
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
            None => None,
        };
        let mut metadata = serde_json::Map::new();
        if let Some(eligible_member_ids) = eligible_member_ids {
            metadata.insert(
                TASK_METADATA_ELIGIBLE_MEMBER_IDS.to_string(),
                serde_json::json!(eligible_member_ids),
            );
        }
        if let Some(execution_mode) = execution_mode {
            metadata.insert(
                TASK_METADATA_EXECUTION_MODE.to_string(),
                serde_json::Value::String(execution_mode),
            );
        }
        if !metadata.is_empty() {
            params.metadata = Some(serde_json::Value::Object(metadata));
        }

        let task = AgentOrgTaskStore::create(params)?;
        let approval = if let Some(pending) = pending_plan_approval {
            let pending = pending
                .as_object()
                .ok_or_else(|| "pending_plan_approval must be an object".to_string())?;
            let request_id = pending
                .get("request_id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "pending_plan_approval.request_id is required".to_string())?
                .to_string();
            let source_member_id = pending
                .get("source_member_id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "pending_plan_approval.source_member_id is required".to_string())?
                .to_string();

            let fixture_id = uuid::Uuid::new_v4();
            let root_session_id = format!("agent-org-plan-root-{fixture_id}");
            let source_session_id = format!("agent-org-plan-source-{fixture_id}");
            let workspace_path =
                std::env::temp_dir().join(format!("orgii-agent-org-plan-e2e-{fixture_id}"));
            std::fs::create_dir_all(&workspace_path).map_err(|err| err.to_string())?;
            let workspace_path = workspace_path.to_string_lossy().into_owned();
            let now = chrono::Utc::now().to_rfc3339();

            upsert_session(&UnifiedSessionRecord {
                session_id: root_session_id.clone(),
                name: "Agent Org plan E2E root".to_string(),
                status: SessionStatus::Idle.as_str().to_string(),
                session_type: session_type::GENERIC.to_string(),
                workspace_path: Some(workspace_path.clone()),
                agent_definition_id: Some("coord".to_string()),
                org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..Default::default()
            })
            .map_err(|err| err.to_string())?;
            upsert_session(&UnifiedSessionRecord {
                session_id: source_session_id.clone(),
                name: "Agent Org plan E2E source".to_string(),
                status: SessionStatus::Idle.as_str().to_string(),
                session_type: session_type::ORG_MEMBER.to_string(),
                workspace_path: Some(workspace_path),
                agent_definition_id: Some("alice-agent".to_string()),
                org_member_id: Some(source_member_id.clone()),
                parent_session_id: Some(root_session_id.clone()),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
            .map_err(|err| err.to_string())?;

            let plan_path = AgentOrgPlanApprovalStore::managed_plan_path_for_session(
                &source_session_id,
                &format!("{fixture_id}.plan.md"),
            )?
            .to_string_lossy()
            .into_owned();
            Some(AgentOrgPlanApprovalStore::create_pending(
                CreateAgentOrgPlanApprovalParams {
                    request_id,
                    org_run_id: task.org_run_id.clone(),
                    source_task_id: task.id.clone(),
                    source_member_id,
                    source_session_id,
                    root_session_id,
                    policy: PlanApprovalPolicy::Coordinator,
                    plan_title: "Typed message E2E plan".to_string(),
                    plan_path,
                    plan_content: "# Typed message E2E plan\n\nRevise this plan.".to_string(),
                },
            )?)
        } else {
            None
        };
        Ok::<_, String>((task, approval))
    })
    .await
    {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok((_, approval))) => Json(serde_json::json!({
            "ok": true,
            "id": id,
            "plan_approval_id": approval.map(|value| value.approval_id),
        })),
    }
}

/// `POST /test/agent-org/tasks/list`
///
/// Body: `{ "org_run_id": "run-..." }`
///
/// Returns every task row keyed to the given run, decoded into a
/// stable shape that mirrors the on-disk schema. Used by deterministic
/// E2Es to assert side effects (worker drains leave ownerless state
/// untouched; shutdown unassign clears owner; task_update sets owner).
pub async fn test_agent_org_tasks_list(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_org_tasks::AgentOrgTaskStore;

    let org_run_id = match body
        .get("org_run_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        Some(s) => s.to_string(),
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };

    match tokio::task::spawn_blocking(move || AgentOrgTaskStore::list(&org_run_id)).await {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(tasks)) => {
            let rows: Vec<serde_json::Value> = tasks
                .into_iter()
                .map(|task| {
                    serde_json::json!({
                        "id": task.id,
                        "org_run_id": task.org_run_id,
                        "subject": task.subject,
                        "description": task.description,
                        "active_form": task.active_form,
                        "owner": task.owner,
                        "status": task.status.as_wire(),
                        "blocks": task.blocks,
                        "blocked_by": task.blocked_by,
                        "created_at": task.created_at,
                        "updated_at": task.updated_at,
                    })
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "tasks": rows,
            }))
        }
    }
}

/// `POST /test/agent-org/stale-workers/seed-cli-member`
///
/// Seeds a minimal Agent Org run with a CLI member session at a specified
/// status in `code_sessions`. Used by deterministic E2E scenarios that
/// verify `reconcile_run_finality` does not prematurely end a run when a
/// CLI member session is `idle` (non-terminal, between turns).
///
/// Body:
/// ```json
/// {
///   "cli_agent_type": "claude_code",
///   "member_id": "m-cli",
///   "status": "idle"
/// }
/// ```
///
/// Response:
/// ```json
/// {
///   "ok": true,
///   "org_run_id": "...",
///   "root_session_id": "...",
///   "cli_session_id": "..."
/// }
/// ```
pub async fn test_agent_org_seed_cli_member_run(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
        COORDINATOR_MEMBER_ID,
    };
    use agent_core::core::definitions::orgs::{OrgDefinition, OrgMember};
    use agent_core::core::session::persistence::{
        session_type, upsert_session, UnifiedSessionRecord,
    };
    use agent_core::core::session::SessionStatus;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };

    let cli_agent_type = obj
        .get("cli_agent_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("claude_code")
        .to_string();
    let member_id = obj
        .get("member_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("m-cli")
        .to_string();
    let status_str = obj
        .get("status")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("idle")
        .to_string();

    let result = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        agent_core::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::core::session::persistence::init(&conn).map_err(|err| err.to_string())?;
        agent_core::coordination::agent_org_runs::init_schema(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::coordination::agent_member_interventions::init_schema(&conn)
            .map_err(|err| err.to_string())?;
        agent_core::coordination::agent_org_tasks::init_schema(&conn)
            .map_err(|err| err.to_string())?;
        crate::agent_sessions::cli::init_cli_agent_tables(&conn).map_err(|err| err.to_string())?;

        let now = chrono::Utc::now().to_rfc3339();
        let root_session_id = format!("agent-org-cli-root-{}", uuid::Uuid::new_v4());
        let cli_session_id = format!("code-session-cli-member-{}", uuid::Uuid::new_v4());
        let org_id = format!(
            "{E2E_RUN_FIXTURE_ORG_PREFIX}cli-member-idle-org-{}",
            uuid::Uuid::new_v4()
        );
        let coordinator_agent_id = "builtin:sde".to_string();

        upsert_session(&UnifiedSessionRecord {
            session_id: root_session_id.clone(),
            name: "cli-member-idle-root".to_string(),
            status: SessionStatus::Running.as_str().to_string(),
            session_type: session_type::GENERIC.to_string(),
            agent_definition_id: Some(coordinator_agent_id.clone()),
            org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            created_at: now.clone(),
            updated_at: now.clone(),
            ..Default::default()
        })
        .map_err(|err| err.to_string())?;

        let org_snapshot = OrgDefinition {
            id: org_id.clone(),
            name: org_id.clone(),
            role: "coordinator".to_string(),
            agent_id: coordinator_agent_id.clone(),
            description: None,
            hierarchy_mode: Default::default(),
            plan_approval_policy: Default::default(),
            children: vec![OrgMember {
                id: member_id.clone(),
                name: member_id.clone(),
                role: "worker".to_string(),
                agent_id: format!("cli:{cli_agent_type}"),
                runtime_config: None,
                children: Vec::new(),
            }],
        };

        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id,
            coordinator_agent_id,
            root_session_id: Some(root_session_id.clone()),
            org_snapshot,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })?;

        conn.execute(
            "INSERT INTO code_sessions (
                session_id, cli_agent_type, status, parent_session_id, org_member_id,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(session_id) DO UPDATE SET
                cli_agent_type = excluded.cli_agent_type,
                status = excluded.status,
                parent_session_id = excluded.parent_session_id,
                org_member_id = excluded.org_member_id,
                updated_at = excluded.updated_at",
            rusqlite::params![
                cli_session_id,
                cli_agent_type,
                status_str,
                root_session_id,
                member_id,
                now
            ],
        )
        .map_err(|err| err.to_string())?;

        Ok::<serde_json::Value, String>(serde_json::json!({
            "ok": true,
            "org_run_id": run.id,
            "root_session_id": root_session_id,
            "cli_session_id": cli_session_id,
        }))
    })
    .await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(value)) => Json(value),
    }
}

/// `POST /test/agent-org/run/pause`
///
/// Transitions the named run `running → paused`. Seed-only path for E2E
/// tests that verify pause/resume semantics without a live coordinator.
/// Body: `{ "org_run_id": "<id>" }`
pub async fn test_agent_org_pause_run(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_run_id = match obj.get("org_run_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };

    let result =
        tokio::task::spawn_blocking(move || AgentOrgRunStore::mark_paused(&org_run_id)).await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(transitioned)) => {
            Json(serde_json::json!({ "ok": true, "transitioned": transitioned }))
        }
    }
}

/// `POST /test/agent-org/simulate-app-restart`
///
/// Simulates the startup cleanup sequence that runs every time the app
/// initialises after an unexpected exit or normal quit:
///
/// 1. `reconcile_in_flight_after_restart` — closes turn intents whose
///    in-memory scheduler disappeared with the previous process.
/// 2. `reconcile_sessions_with_terminal_turn_markers` — preserves sessions
///    whose latest turn already durably reached a terminal state.
/// 3. `mark_stale_running_sessions_abandoned` — flips all remaining sessions
///    with an in-flight status (`running`, `waiting_for_user`,
///    `waiting_for_funds`) to `abandoned`.
/// 4. `requeue_abandoned_member_tasks_on_startup` — applies the same failed
///    member task disposition as production startup.
/// 5. `clear_all_active_on_startup` — clears interventions whose in-memory
///    sessions no longer exist.
/// 6. `reconcile_resolved_running_runs_on_startup` — completes runs whose
///    tasks were already fully resolved.
/// 7. `mark_all_running_as_paused_on_startup` — transitions
///    every `running` org run to `paused` so `reconcile_run_finality` cannot
///    auto-terminate the run when it sees all sessions abandoned.
///
/// Caller-path probe: drives the same sequence that `AgentAppState::
/// with_browser` calls, so this endpoint stays in sync if any of those
/// functions change their signature or semantics. No body required (`{}`).
pub async fn test_agent_org_simulate_app_restart() -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || {
        use agent_core::coordination::agent_member_interventions::AgentMemberInterventionStore;
        use agent_core::coordination::agent_org_runs::AgentOrgRunStore;
        use agent_core::session::persistence::{
            mark_stale_running_sessions_abandoned, reconcile_sessions_with_terminal_turn_markers,
        };

        let conn = database::db::get_connection()
            .map_err(|err| format!("open sessions DB for intent reconciliation failed: {err}"))?;
        let intents_reconciled =
            session_persistence::turn_intents::reconcile_in_flight_after_restart(&conn)
                .map_err(|err| format!("reconcile_in_flight_after_restart failed: {err}"))?;
        let terminal_sessions_reconciled = reconcile_sessions_with_terminal_turn_markers()
            .map_err(|err| {
                format!("reconcile_sessions_with_terminal_turn_markers failed: {err}")
            })?;
        let sessions_abandoned = mark_stale_running_sessions_abandoned()
            .map_err(|err| format!("mark_stale_running_sessions_abandoned failed: {err}"))?;
        let tasks_requeued = AgentOrgRunStore::requeue_abandoned_member_tasks_on_startup()
            .map_err(|err| format!("requeue_abandoned_member_tasks_on_startup failed: {err}"))?;
        let interventions_cleared = AgentMemberInterventionStore::clear_all_active_on_startup()
            .map_err(|err| format!("clear_all_active_on_startup failed: {err}"))?;
        let runs_completed = AgentOrgRunStore::reconcile_resolved_running_runs_on_startup()
            .map_err(|err| format!("reconcile_resolved_running_runs_on_startup failed: {err}"))?;
        let runs_paused = AgentOrgRunStore::mark_all_running_as_paused_on_startup()
            .map_err(|err| format!("mark_all_running_as_paused_on_startup failed: {err}"))?;
        Ok::<serde_json::Value, String>(serde_json::json!({
            "ok": true,
            "intents_reconciled": intents_reconciled,
            "terminal_sessions_reconciled": terminal_sessions_reconciled,
            "sessions_abandoned": sessions_abandoned,
            "tasks_requeued": tasks_requeued,
            "runs_completed": runs_completed,
            "runs_paused": runs_paused,
            "interventions_cleared": interventions_cleared,
        }))
    })
    .await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(value)) => Json(value),
    }
}

/// `POST /test/agent-org/run/resume`
///
/// Transitions the named run `paused → running`. Seed-only path for E2E
/// tests that verify pause/resume semantics without a live coordinator.
/// Body: `{ "org_run_id": "<id>" }`
pub async fn test_agent_org_resume_run(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let org_run_id = match obj.get("org_run_id").and_then(|v| v.as_str()) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "org_run_id is required (non-empty string)"
            }))
        }
    };

    let result =
        tokio::task::spawn_blocking(move || AgentOrgRunStore::mark_resumed(&org_run_id)).await;

    match result {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "ok": false, "error": err })),
        Ok(Ok(transitioned)) => {
            Json(serde_json::json!({ "ok": true, "transitioned": transitioned }))
        }
    }
}
