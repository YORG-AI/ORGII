//! Dev-only "core" test endpoints — everything that didn't fit into a
//! dedicated theme module (SDE / gateway / MCP / learning / housekeeping
//! / workspace). This is the last split (8/8) of the old monolithic
//! `api/agent/mod.rs` test block.
//!
//! Covers:
//! - `test_send_message` (generic OS-agent message injector)
//! - `test_recovery_counters_*`
//! - `test_cancel_flag_*`
//! - `test_last_assistant_text`
//! - `test_finalize_agent_result`
//! - `test_tier1_escalation_check`
//! - `test_event_store_complete_last_running`
//! - `test_subagent_dispatch_check`
//! - `test_resolve_agent`
//! - `test_background_jobs`
//! - `test_events_recent` / `test_events_reset`
//!
//! Only compiled in dev builds; `create_routes` in `api/agent/mod.rs`
//! calls these via `test::core::*`.

#![cfg(debug_assertions)]

use axum::Json;
use core_types::providers::NativeHarnessType;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TestMessageRequest {
    content: String,
    session_id: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    native_harness_type: Option<String>,
}

pub async fn test_send_message(Json(request): Json<TestMessageRequest>) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized. Is the Tauri app running?"
            }));
        }
    };

    let os_state = handle.state::<agent_core::state::AgentAppState>();
    let session_id = request
        .session_id
        .unwrap_or_else(|| format!("test:e2e-{}", uuid::Uuid::new_v4().simple()));
    let native_harness_type = match request
        .native_harness_type
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => match NativeHarnessType::parse(value) {
            Some(parsed) => Some(parsed),
            None => {
                return Json(serde_json::json!({
                    "error": format!("Unknown native_harness_type: {value:?}")
                }));
            }
        },
        None => None,
    };

    // Regression fix: `ensure_channel_session` now requires the
    // session to be pre-registered in `AgentAppState` (because it pulls
    // `session.definition` to build the `ResolvedAgent`). In production the
    // session is registered upstream when the user creates it; in E2E we
    // have to do it here. We mirror what `test_sde_message` does below:
    // upsert a DB row so downstream lookups work, then register the session
    // with the `builtin:os` definition so the channel init path can resolve
    // capabilities correctly.
    {
        use agent_core::state::AgentSession;

        let now = chrono::Utc::now().to_rfc3339();
        let session_record = agent_core::session::persistence::UnifiedSessionRecord {
            session_id: session_id.clone(),
            name: "E2E OS test session".to_string(),
            status: agent_core::session::SessionStatus::Idle
                .as_str()
                .to_string(),
            model: request.model.clone(),
            account_id: request.account_id.clone(),
            workspace_path: None,
            user_input: Some(request.content.chars().take(100).collect()),
            total_tokens: 0,
            created_at: now.clone(),
            updated_at: now,
            session_type: agent_core::session::persistence::session_type::DESKTOP.to_string(),
            agent_definition_id: Some(agent_core::definitions::OS_AGENT_ID.to_string()),
            native_harness_type: native_harness_type
                .as_ref()
                .map(|harness_type| harness_type.as_str().to_string()),
            ..Default::default()
        };
        if let Err(err) = tokio::task::spawn_blocking({
            let record = session_record.clone();
            move || agent_core::session::persistence::upsert_session(&record)
        })
        .await
        .unwrap_or_else(|err| Err(rusqlite::Error::InvalidParameterName(err.to_string())))
        {
            return Json(
                serde_json::json!({ "error": format!("Failed to create OS test session: {}", err) }),
            );
        }

        if os_state.get_session(&session_id).await.is_none() {
            let store = agent_core::definitions::definitions_store();
            let definition = agent_core::definitions::resolve_definition_by_id(
                agent_core::definitions::OS_AGENT_ID,
                Some(&store),
            )
            .unwrap_or_else(|_| agent_core::definitions::os_agent());
            let agent_session = AgentSession::new(session_id.clone(), definition);
            os_state.register_session(agent_session).await;
        }
    }

    let launch_spec = match agent_core::init::launch_spec::AgentLaunchSpec::registered_session(
        &os_state,
        &session_id,
        app_paths::personal_workspace(),
        request.account_id.clone(),
        request.model.clone(),
        native_harness_type,
    )
    .await
    {
        Ok(spec) => spec,
        Err(err) => {
            return Json(serde_json::json!({ "error": err }));
        }
    };
    let runtime = match agent_core::init::init_session(&os_state, launch_spec).await {
        Ok(rt) => rt,
        Err(err) => {
            return Json(serde_json::json!({ "error": err }));
        }
    };
    let effective_model = runtime.model.clone();
    let runtime_snapshot = serde_json::json!({
        "nativeHarnessType": runtime.native_harness_type.as_ref().map(|value| value.as_str()),
        "providerName": runtime.provider.provider_name(),
    });
    let session_arc = match os_state.get_session(&session_id).await {
        Some(session) => session,
        None => {
            return Json(
                serde_json::json!({ "error": format!("Session {} not found", session_id) }),
            );
        }
    };

    // Production OS Agent sessions are always created from a gateway channel
    // (Telegram / Discord / etc.), so `TurnInput.channel` is `Some` in real
    // traffic. That `Some` is what flips `PromptCtx.is_channel_session` to
    // true, which in turn loads `~/.orgii/personal/rules/*.md` into the
    // system prompt (see `sections_v2.rs::Rules`). Passing `None` here
    // would silently route the request through the workspace branch, skip
    // the personal-rules loader, and make `os-personal-rules-inject` E2E
    // assert against an OS turn that never saw any rules.
    let input = agent_core::session::TurnInput {
        content: request.content.clone(),
        display_text: None,
        agent_mode: None,
        images: None,
        ide_context: None,
        is_resume: false,
        channel: Some("e2e".to_string()),
        chat_id: Some(session_id.clone()),
        turn_id: None,
        turn_intent_id: uuid::Uuid::new_v4().to_string(),
    };

    const CALLER_TIMEOUT_SECS: u64 = 180;
    let response = match tokio::time::timeout(
        std::time::Duration::from_secs(CALLER_TIMEOUT_SECS),
        agent_core::session::process_message(session_arc, input, os_state.app_handle.clone()),
    )
    .await
    {
        Ok(Ok(r)) => r.content,
        Ok(Err(err)) => {
            return Json(serde_json::json!({ "error": err }));
        }
        Err(_) => {
            return Json(
                serde_json::json!({ "error": format!("Request timed out after {}s", CALLER_TIMEOUT_SECS) }),
            );
        }
    };

    let sid = session_id.clone();
    let tool_calls = tokio::task::spawn_blocking(move || {
        // Silent fallback would make E2E tool-call assertions
        // trivially pass on a persistence failure. Warn so flaky
        // test environments are visible to the test runner.
        match agent_core::session::persistence::load_messages(&sid) {
            Ok(msgs) => msgs
                .into_iter()
                .filter(|m| m.role == "tool_call")
                .filter_map(|m| m.tool_name)
                .collect::<Vec<String>>(),
            Err(err) => {
                tracing::warn!(
                    session_id = %sid,
                    error = %err,
                    "test::core: load_messages failed; tool-call assertions will see empty list"
                );
                Vec::new()
            }
        }
    })
    .await
    .unwrap_or_else(|err| {
        tracing::warn!(
            error = %err,
            "test::core: tool-call collection task panicked; assertions will see empty list"
        );
        Vec::new()
    });

    Json(serde_json::json!({
        "content": response,
        "session_id": session_id,
        "model": effective_model,
        "tool_calls": tool_calls,
        "runtime_snapshot": runtime_snapshot,
    }))
}

/// E2E: read & reset in-memory counters that record which recovery
/// path executed (`filter_unresolved_tool_uses` vs `repair_interrupted_history`).
///
/// Both paths modify an in-memory `Vec<Value>` mid-turn and never write the
/// shape change back to the SQLite transcript (the transcript is append-only
/// JSONL). So `GET /test/sde/transcript/:id` cannot prove which path ran —
/// those counters can.
pub async fn test_recovery_counters_get() -> Json<serde_json::Value> {
    let (filters, removed, repairs) =
        agent_core::core::session::recovery::debug_counters::snapshot();
    Json(serde_json::json!({
        "ok": true,
        "filter_invocations": filters,
        "filter_messages_removed": removed,
        "repair_invocations": repairs,
    }))
}

pub async fn test_recovery_counters_reset() -> Json<serde_json::Value> {
    agent_core::core::session::recovery::debug_counters::reset();
    Json(serde_json::json!({ "ok": true }))
}

// ============================================
// Dev-only: cancel-interrupt marker E2E endpoints
// ============================================

/// Read the `last_turn_cancelled` flag for a session without consuming it.
///
/// Returns `{ "ok": true, "cancelled": true/false }`.
/// Used by E2E to confirm that `mark_turn_cancelled` was called after a
/// cancel event without running a full LLM turn.
pub async fn test_cancel_flag_get(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let sid = session_id.clone();
    let flag: bool = tokio::task::spawn_blocking(move || {
        let Ok(conn) = database::db::get_connection() else {
            return false;
        };
        let val: i64 = conn
            .query_row(
                "SELECT last_turn_cancelled FROM agent_sessions WHERE session_id = ?1",
                [&sid],
                |row| row.get(0),
            )
            .unwrap_or(0);
        val != 0
    })
    .await
    .unwrap_or(false);

    Json(serde_json::json!({ "ok": true, "cancelled": flag }))
}

/// Atomically read-and-clear the `last_turn_cancelled` flag (consume it).
///
/// Mirrors the exact logic that `processor.rs` step 4b executes so E2E can
/// drive the "next-turn interrupt injection" path deterministically without
/// running a full LLM turn.
///
/// Returns `{ "ok": true, "was_cancelled": true/false }`.
pub async fn test_cancel_flag_take(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let sid = session_id.clone();
    let was_cancelled = tokio::task::spawn_blocking(move || {
        agent_core::core::session::persistence::take_turn_cancelled(&sid)
    })
    .await
    .unwrap_or(false);

    Json(serde_json::json!({ "ok": true, "was_cancelled": was_cancelled }))
}

/// Seed `last_turn_cancelled = 1` for a session without running a turn.
///
/// Used by E2E to deterministically exercise the cancel-interrupt flag path.
/// Mirrors what `turn_executor` does at every cancel exit point.
///
/// Returns `{ "ok": true }`.
pub async fn test_cancel_flag_seed(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let sid = session_id.clone();
    tokio::task::spawn_blocking(move || {
        agent_core::core::session::persistence::mark_turn_cancelled(&sid);
    })
    .await
    .ok();

    Json(serde_json::json!({ "ok": true }))
}

// ============================================
// Dev-only: last_assistant_text helper E2E endpoint
// ============================================

/// Direct E2E probe for the `last_assistant_text` fallback helper.
///
/// Accepts a `{ "messages": [...] }` body in OpenAI-compat format and returns
/// the result of the helper — identical to what `turn_executor` would use when
/// the terminal LLM iteration produces no text content.
///
/// This endpoint is **stateless and deterministic**: every call with the same
/// payload returns the same result, making it ideal for positive-half /
/// negative assertions without relying on LLM non-determinism.
pub async fn test_last_assistant_text(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let messages = match body.get("messages").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "body must contain a 'messages' array"
            }));
        }
    };
    let result = agent_core::core::turn_executor::helpers::last_assistant_text(&messages);
    Json(serde_json::json!({
        "ok": true,
        "result": result,
    }))
}

// ============================================
// Dev-only: finalize_agent_result E2E endpoint
// ============================================

/// Direct E2E probe for the `agent.rs` finalize path.
///
/// Accepts:
///   `{ "content": <string|null>, "messages": [...] }`
///
/// Mirrors exactly what `agent.rs` does after `execute_turn` returns:
///   content.or_else(|| last_assistant_text(&messages))
///
/// Returns:
///   `{ "ok": true, "result": <string|null>, "source": "content"|"messages"|"none" }`
///
/// This endpoint is **stateless and deterministic**, making it ideal for
/// positive + negative assertions without LLM non-determinism.
pub async fn test_finalize_agent_result(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let messages: Vec<serde_json::Value> = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(ref text) = content {
        return Json(serde_json::json!({
            "ok": true,
            "result": text,
            "source": "content",
        }));
    }

    match agent_core::core::turn_executor::helpers::last_assistant_text(&messages) {
        Some(recovered) => Json(serde_json::json!({
            "ok": true,
            "result": recovered,
            "source": "messages",
        })),
        None => Json(serde_json::json!({
            "ok": true,
            "result": serde_json::Value::Null,
            "source": "none",
        })),
    }
}

// ============================================
// Dev-only: Tier-1 escalation probe
// ============================================

/// Expose the Tier-1 escalation decision table so E2E tests can assert it
/// deterministically without triggering a real max_tokens truncation.
///
/// Input:
///   { "effective_max_tokens": u32, "tier1_escalated": bool }
///
/// Output:
///   { "ok": true,
///     "would_escalate": bool,        // true → silent escalation branch
///     "new_max_tokens": u32,         // ESCALATED_MAX_TOKENS when escalating
///     "escalated_threshold": u32 }   // the threshold constant
///
/// Mirrors the branch condition in turn_executor/mod.rs:
///   `!tier1_escalated && effective_max_tokens < ESCALATED_MAX_TOKENS`
pub async fn test_tier1_escalation_check(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    const ESCALATED_MAX_TOKENS: u32 = 64_000;

    let effective = body
        .get("effective_max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(4096) as u32;
    let already_escalated = body
        .get("tier1_escalated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let would_escalate = !already_escalated && effective < ESCALATED_MAX_TOKENS;

    Json(serde_json::json!({
        "ok": true,
        "would_escalate": would_escalate,
        "new_max_tokens": if would_escalate { ESCALATED_MAX_TOKENS } else { effective },
        "escalated_threshold": ESCALATED_MAX_TOKENS,
    }))
}

// ============================================
// Dev-only: EventStore interactive-tool lifecycle probe
// ============================================

/// Exercise `EventStore::complete_last_running()` against a caller-supplied
/// event sequence. The production bug was: `agent:complete` unconditionally
/// called `complete_last_running()`, which flipped an in-flight
/// `ask_user_questions` tool call from `AwaitingUser` to `Completed`, causing
/// the input-area card to disappear before the user answered.
///
/// The fix is that `complete_last_running()` only targets `Running` events.
/// This endpoint lets an E2E scenario assert that invariant deterministically
/// without spinning up an LLM turn.
///
/// Input:
/// ```json
/// { "events": [
///     { "id": "tool-call-a", "display_status": "awaiting_user" },
///     { "id": "tool-call-b", "display_status": "running" }
/// ] }
/// ```
///
/// Output:
/// ```json
/// { "ok": true,
///   "completed_id": "tool-call-b" | null,
///   "events": [
///     { "id": "tool-call-a", "display_status": "awaiting_user" },
///     { "id": "tool-call-b", "display_status": "completed" }
///   ]
/// }
/// ```
///
/// Accepted `display_status` strings: `running | awaiting_user | completed | failed | pending`.
pub async fn test_event_store_complete_last_running(
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    use crate::agent_sessions::event_pipeline::store::EventStore;
    use crate::agent_sessions::event_pipeline::types::{
        ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
    };

    let specs = body.get("events").and_then(|v| v.as_array()).ok_or((
        axum::http::StatusCode::BAD_REQUEST,
        "body.events must be an array".into(),
    ))?;

    let parse_status = |s: &str| -> Result<EventDisplayStatus, (axum::http::StatusCode, String)> {
        match s {
            "running" => Ok(EventDisplayStatus::Running),
            "awaiting_user" => Ok(EventDisplayStatus::AwaitingUser),
            "completed" => Ok(EventDisplayStatus::Completed),
            "failed" => Ok(EventDisplayStatus::Failed),
            "pending" => Ok(EventDisplayStatus::Pending),
            other => Err((
                axum::http::StatusCode::BAD_REQUEST,
                format!("unknown display_status: {}", other),
            )),
        }
    };

    let status_to_wire = |s: &EventDisplayStatus| -> &'static str {
        match s {
            EventDisplayStatus::Running => "running",
            EventDisplayStatus::AwaitingUser => "awaiting_user",
            EventDisplayStatus::Completed => "completed",
            EventDisplayStatus::Failed => "failed",
            EventDisplayStatus::Pending => "pending",
        }
    };

    let mut events: Vec<SessionEvent> = Vec::with_capacity(specs.len());
    for (idx, spec) in specs.iter().enumerate() {
        let id = spec
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("evt-{}", idx));
        let status_str = spec.get("display_status").and_then(|v| v.as_str()).ok_or((
            axum::http::StatusCode::BAD_REQUEST,
            format!("events[{}].display_status is required", idx),
        ))?;
        let status = parse_status(status_str)?;

        events.push(SessionEvent {
            id,
            chunk_id: None,
            session_id: "e2e-probe".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            function_name: spec
                .get("function_name")
                .and_then(|v| v.as_str())
                .unwrap_or("probe_tool")
                .to_string(),
            ui_canonical: String::new(),
            action_type: "tool_call".to_string(),
            args: serde_json::json!({}),
            result: serde_json::Value::Null,
            source: EventSource::Assistant,
            display_text: String::new(),
            display_status: status,
            display_variant: EventDisplayVariant::ToolCall,
            activity_status: ActivityStatus::Processed,
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
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        });
    }

    let mut store = EventStore::new();
    store.set(events);
    let completed_id = store.complete_last_running();

    let out_events: Vec<serde_json::Value> = store
        .events()
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id,
                "display_status": status_to_wire(&e.display_status),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "ok": true,
        "completed_id": completed_id,
        "events": out_events,
    })))
}

// ============================================
// Subagent dispatch parameter validation (debug)
// ============================================

/// Pure check of `AgentTool::execute()`'s pre-launch parameter resolution.
///
/// Does NOT spawn a subagent or touch any session state — the endpoint
/// exists so e2e can pin the runtime contract:
///
/// - `agent_id` fallback (delegate/shadow) from Error 1 fix.
/// - `resume_session_id` shape pre-check from Error 2 fix.
///
/// Body echoes the `agent` tool params shape (plus arbitrary extra keys,
/// which are ignored). Response:
///
/// ```json
/// {
///   "ok": true,
///   "resolved_agent_id": "builtin:general",
///   "agent_id_fallback": true,
///   "resume_shape_valid": true | false | null
/// }
/// ```
///
/// `resume_shape_valid` is `null` when the caller did not pass
/// `resume_session_id`; otherwise it is the boolean result of the
/// shape check that `execute()` uses to reject hallucinated handles.
pub async fn test_subagent_dispatch_check(
    Json(params): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use agent_core::tools::impls::orchestration::agent::{
        background_launch_message, looks_like_valid_subagent_session_id,
        resolve_agent_id_for_execute, subagent_of_subagent_rejection,
    };

    let resolved = resolve_agent_id_for_execute(&params);
    let resume_shape_valid = params
        .get("resume_session_id")
        .and_then(|v| v.as_str())
        .map(looks_like_valid_subagent_session_id);

    // Exercise the subagent-of-subagent guard. Callers pass
    // `delegation_chain: ["parent_id", ...]` to simulate running inside
    // a subagent; an empty array (or missing field) represents the root
    // session. The guard must reject the non-empty case with a
    // structured error so the e2e runner can assert the exact wording.
    let delegation_chain: Vec<String> = params
        .get("delegation_chain")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let guard_result = subagent_of_subagent_rejection(&delegation_chain);
    let guard_rejected = guard_result.is_some();
    let guard_message = guard_result.map(|err| err.to_string());

    // Background-launch message contract (pinned by subagent-launch-msg-no-poll).
    // Built from a stable synthetic session id so the e2e runner can assert
    // the message carries the session id + DB query and does NOT push the
    // parent toward await_output polling.
    let launch_session_id = params
        .get("launch_session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("agent-builtin:general-launchmsg-fixture");
    let launch_agent_name = params
        .get("launch_agent_name")
        .and_then(|v| v.as_str())
        .unwrap_or("Explore");
    let launch_message = background_launch_message(launch_agent_name, launch_session_id);

    Json(serde_json::json!({
        "ok": true,
        "resolved_agent_id": resolved.agent_id,
        "agent_id_fallback": resolved.fallback,
        "resume_shape_valid": resume_shape_valid,
        "subagent_recursion_rejected": guard_rejected,
        "subagent_recursion_message": guard_message,
        "launch_message": launch_message,
        "launch_session_id": launch_session_id,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PrefetchZeroWaitRequest {
    delay_ms: Option<u64>,
}

pub async fn test_prefetch_zero_wait(
    Json(request): Json<PrefetchZeroWaitRequest>,
) -> Json<serde_json::Value> {
    let delay_ms = request.delay_ms.unwrap_or(150);
    Json(agent_core::debug::debug_prefetch_zero_wait_probe(delay_ms).await)
}

#[derive(Debug, Deserialize)]
pub struct PromptCacheBenchmarkRequest {
    session_id: Option<String>,
    workspace_path: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
}

pub async fn test_prompt_cache_benchmark(
    Json(request): Json<PromptCacheBenchmarkRequest>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(handle) => handle,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized. Is the Tauri app running?"
            }));
        }
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    let workspace_path = request.workspace_path.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
            .to_string_lossy()
            .to_string()
    });
    let session_id = request.session_id.unwrap_or_else(|| {
        format!(
            "{}prompt-cache-{}",
            core_types::session::SDE_SESSION_PREFIX,
            uuid::Uuid::new_v4()
        )
    });
    let model = request.model.unwrap_or_else(|| "composer-2".to_string());

    let now = chrono::Utc::now().to_rfc3339();
    let record = agent_core::session::persistence::UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: "E2E prompt cache benchmark session".to_string(),
        status: agent_core::session::SessionStatus::Idle
            .as_str()
            .to_string(),
        model: Some(model.clone()),
        account_id: request.account_id.clone(),
        workspace_path: Some(workspace_path.clone()),
        user_input: Some("prompt cache benchmark".to_string()),
        total_tokens: 0,
        created_at: now.clone(),
        updated_at: now,
        session_type: agent_core::session::persistence::session_type::CODING.to_string(),
        agent_definition_id: Some(agent_core::definitions::SDE_AGENT_ID.to_string()),
        ..Default::default()
    };

    if let Err(err) = tokio::task::spawn_blocking({
        let record = record.clone();
        move || agent_core::session::persistence::upsert_session(&record)
    })
    .await
    .unwrap_or_else(|err| Err(rusqlite::Error::InvalidParameterName(err.to_string())))
    {
        return Json(serde_json::json!({ "error": format!("Failed to create session: {}", err) }));
    }

    let definition = {
        let store = agent_core::definitions::definitions_store();
        agent_core::definitions::resolve_definition_by_id(
            agent_core::definitions::SDE_AGENT_ID,
            Some(&store),
        )
        .unwrap_or_else(|_| agent_core::definitions::sde_agent())
    };
    state
        .register_session(agent_core::state::AgentSession::new(
            session_id.clone(),
            definition,
        ))
        .await;

    let launch_spec = match agent_core::init::launch_spec::AgentLaunchSpec::registered_session(
        &state,
        &session_id,
        std::path::PathBuf::from(&workspace_path),
        request.account_id,
        Some(model),
        None,
    )
    .await
    {
        Ok(spec) => spec,
        Err(err) => return Json(serde_json::json!({ "error": err })),
    };
    if let Err(err) = agent_core::init::init_session(&state, launch_spec).await {
        return Json(serde_json::json!({ "error": err }));
    }

    let Some(session) = state.get_session(&session_id).await else {
        return Json(serde_json::json!({
            "error": format!("Session {} not found after init", session_id)
        }));
    };

    let benchmark = agent_core::debug::debug_prompt_cache_benchmark(session).await;
    Json(serde_json::json!({
        "sessionId": session_id,
        "workspacePath": workspace_path,
        "benchmark": benchmark,
    }))
}

/// Debug probe for the agent-config resolver. Runs the same
/// `ResolvedAgent::resolve` path the session pipeline uses, then returns
/// the memory-related flags the E2E caller asserts on.
#[derive(Debug, Deserialize)]
pub struct ResolveAgentRequest {
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

pub async fn test_resolve_agent(
    Json(request): Json<ResolveAgentRequest>,
) -> Json<serde_json::Value> {
    use agent_core::core::definitions::ResolvedAgent;
    use agent_core::core::session::overrides::SessionOverrides;

    let agent_id = request
        .agent_id
        .clone()
        .unwrap_or_else(|| agent_core::definitions::builtin::SDE_AGENT_ID.to_string());

    let result = tokio::task::spawn_blocking(move || {
        let definitions = agent_core::definitions::definitions_store();
        let Some(mut def) = definitions.get(&agent_id) else {
            return serde_json::json!({
                "error": format!("agent definition not found: {}", agent_id),
            });
        };
        if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
            def.selected_model_id = Some(model.to_string());
        }
        let mut overrides = SessionOverrides::default();
        if let Some(path) = request.workspace_path.as_deref().filter(|p| !p.is_empty()) {
            overrides.workspace = Some(std::path::PathBuf::from(path));
        }
        match ResolvedAgent::resolve(&def, Some(&definitions), &overrides) {
            Ok(resolved) => {
                let turn_config_max_iterations =
                    agent_core::core::session::turn::turn_max_iterations_from_session_model(
                        resolved.session_model.max_iterations,
                    );

                serde_json::json!({
                    "ok": true,
                    "agent_id": agent_id,
                    "learnings": {
                        "enabled": resolved.learnings.enabled,
                        "extract_memories_enabled": resolved.learnings.extract_memories_enabled,
                        "auto_dream_enabled": resolved.learnings.auto_dream_enabled,
                    },
                    "session_model": {
                        "max_iterations": resolved.session_model.max_iterations,
                    },
                    "turn_config": {
                        "max_iterations": turn_config_max_iterations,
                    },
                })
            }
            Err(err) => serde_json::json!({ "error": format!("resolve failed: {}", err) }),
        }
    })
    .await;
    match result {
        Ok(json) => Json(json),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct TestWorkItemProjectSeedRequest {
    slug: String,
    name: String,
}

pub async fn test_work_item_project_seed(
    Json(request): Json<TestWorkItemProjectSeedRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        use project_management::projects::io::{delete_project, write_project};
        use project_management::projects::types::ProjectMeta;

        let now = chrono::Utc::now().to_rfc3339();
        let _ = delete_project(&request.slug);
        let meta = ProjectMeta {
            id: request.slug.clone(),
            name: request.name.clone(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: Vec::new(),
            labels: Vec::new(),
            linked_repos: Vec::new(),
            start_date: None,
            target_date: None,
            created_at: now.clone(),
            updated_at: now,
            next_work_item_id: 1,
            work_item_prefix: "E2E".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        };
        write_project(
            &request.slug,
            &meta,
            "E2E scheduled work item project fixture",
            false,
        )?;
        Ok(serde_json::json!({
            "ok": true,
            "storySlug": request.slug,
        }))
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct TestWorkItemProjectDeleteRequest {
    slug: String,
}

pub async fn test_work_item_project_delete(
    Json(request): Json<TestWorkItemProjectDeleteRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        project_management::projects::io::delete_project(&request.slug)?;
        Ok(serde_json::json!({
            "ok": true,
            "storySlug": request.slug,
        }))
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct TestWorkItemScheduleLookupRequest {
    project_name: String,
    title: String,
}

pub async fn test_work_item_schedule_lookup(
    Json(request): Json<TestWorkItemScheduleLookupRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let projects = project_management::projects::io::read_all_projects()?;
        let project = projects
            .into_iter()
            .find(|project| {
                project.meta.name == request.project_name || project.slug == request.project_name
            })
            .ok_or_else(|| format!("Project not found: {}", request.project_name))?;
        let items = project_management::projects::io::read_all_work_items(&project.slug)?;
        let matches: Vec<serde_json::Value> = items
            .into_iter()
            .filter(|item| item.frontmatter.title == request.title)
            .map(|item| {
                serde_json::json!({
                    "storySlug": project.slug,
                    "shortId": item.frontmatter.short_id,
                    "title": item.frontmatter.title,
                    "status": item.frontmatter.status,
                    "schedule": item.frontmatter.schedule,
                    "routineSource": item.frontmatter.routine_source,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "ok": true,
            "storySlug": project.slug,
            "matches": matches,
        }))
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct TestWorkItemRuntimeLaunchRequest {
    account_id: String,
    model: String,
    repo_path: String,
    sub_agent_ids: Vec<String>,
}

pub async fn test_work_item_runtime_launch(
    Json(request): Json<TestWorkItemRuntimeLaunchRequest>,
) -> Json<serde_json::Value> {
    let handle = match crate::api::get_app_handle() {
        Some(handle) => handle,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "AppHandle not initialized. Is the Tauri app running?"
            }));
        }
    };

    Json(debug_work_item_runtime_launch_impl(handle.clone(), request).await)
}

#[tauri::command]
pub async fn debug_work_item_runtime_launch(
    request: TestWorkItemRuntimeLaunchRequest,
) -> Result<serde_json::Value, String> {
    let handle = crate::api::get_app_handle()
        .ok_or_else(|| "AppHandle not initialized. Is the Tauri app running?".to_string())?;
    let result = debug_work_item_runtime_launch_impl(handle.clone(), request).await;
    if result.get("ok").and_then(|value| value.as_bool()) == Some(true) {
        Ok(result)
    } else {
        Err(result
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("work item runtime launch failed")
            .to_string())
    }
}

async fn debug_work_item_runtime_launch_impl(
    handle: tauri::AppHandle,
    request: TestWorkItemRuntimeLaunchRequest,
) -> serde_json::Value {
    let repo_path = std::path::PathBuf::from(&request.repo_path);
    if !repo_path.is_dir() {
        return serde_json::json!({
            "ok": false,
            "error": format!("repo_path is not a directory: {}", request.repo_path)
        });
    }

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let project_slug = format!("e2e-workitem-runtime-{}", &suffix[..8]);
    let short_id = "E2E-001".to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let seed_result = tokio::task::spawn_blocking({
        let project_slug = project_slug.clone();
        let short_id = short_id.clone();
        let repo_path = request.repo_path.clone();
        let account_id = request.account_id.clone();
        let model = request.model.clone();
        let sub_agent_ids = request.sub_agent_ids.clone();
        let now = now.clone();
        move || -> Result<(), String> {
            use project_management::projects::io::{
                delete_project, write_project, write_work_item,
            };
            use project_management::projects::types::{
                OrchestratorConfig, ProjectMeta, WorkItemFrontmatter,
            };

            let _ = delete_project(&project_slug);
            let meta = ProjectMeta {
                id: project_slug.clone(),
                name: format!("E2E Work Item Runtime {}", project_slug),
                org_id: "personal-org".to_string(),
                status: "active".to_string(),
                priority: "none".to_string(),
                health: "no_updates".to_string(),
                lead: None,
                members: Vec::new(),
                labels: Vec::new(),
                linked_repos: vec![repo_path.clone()],
                start_date: None,
                target_date: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                next_work_item_id: 2,
                work_item_prefix: "E2E".to_string(),
                work_item_prefix_custom: true,
                agent_defaults: None,
            };
            write_project(
                &project_slug,
                &meta,
                "E2E Work Item runtime launch probe",
                false,
            )?;

            let frontmatter = WorkItemFrontmatter {
                id: format!("{}-{}", project_slug, short_id),
                short_id: short_id.clone(),
                title: "E2E Work Item runtime sub-agent propagation".to_string(),
                project: Some(project_slug.clone()),
                status: "backlog".to_string(),
                priority: "none".to_string(),
                assignee: Some(agent_core::definitions::SDE_AGENT_ID.to_string()),
                assignee_type: Some("agent".to_string()),
                labels: Vec::new(),
                milestone: None,
                parent: None,
                stage: None,
                start_date: None,
                target_date: None,
                created_by: Some("e2e".to_string()),
                origin_session: None,
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
                starred: false,
                todos: Vec::new(),
                comments: Vec::new(),
                history: Vec::new(),
                delegations: Vec::new(),
                linked_sessions: Vec::new(),
                handoff: None,
                proof_of_work: None,
                orchestrator_config: Some(OrchestratorConfig {
                    selected_account_id: Some(account_id),
                    selected_model_id: Some(model),
                    sub_agent_ids,
                    agent_definition_id: Some(agent_core::definitions::SDE_AGENT_ID.to_string()),
                    worktree_path: Some(repo_path),
                    ..Default::default()
                }),
                orchestrator_state: None,
                follow_up_items: Vec::new(),
                schedule: None,
                routine_source: None,
                execution_lock: None,
                close_out: None,
                work_products: Vec::new(),
            };
            write_work_item(
                &project_slug,
                &short_id,
                &frontmatter,
                "E2E probe body: runtime must see orchestrator_config.sub_agent_ids.",
            )
        }
    })
    .await
    .map_err(|err| err.to_string())
    .and_then(|inner| inner);

    if let Err(err) = seed_result {
        return serde_json::json!({ "ok": false, "error": err });
    }

    let summary = match agent_core::tool_infra::start_work_item(
        &project_slug,
        &short_id,
        &handle,
        Some(&request.account_id),
        Some(&request.model),
    )
    .await
    {
        Ok(summary) => summary,
        Err(err) => return serde_json::json!({ "ok": false, "error": err }),
    };

    let session_id = summary
        .lines()
        .find_map(|line| line.trim().strip_prefix("Session: ").map(str::to_string));

    match session_id {
        Some(session_id) => serde_json::json!({
            "ok": true,
            "sessionId": session_id,
            "storySlug": project_slug,
            "shortId": short_id,
            "summary": summary,
        }),
        None => serde_json::json!({
            "ok": false,
            "error": "start_work_item did not return a session id",
            "summary": summary,
        }),
    }
}

pub async fn test_work_item_scheduler_run_once() -> Json<serde_json::Value> {
    match debug_work_item_scheduler_run_once().await {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[tauri::command]
pub async fn debug_work_item_scheduler_run_once() -> Result<serde_json::Value, String> {
    let handle = crate::api::get_app_handle()
        .ok_or_else(|| "AppHandle not initialized. Is the Tauri app running?".to_string())?;
    agent_core::coordination::work_item_scheduler::debug_run_once(handle).await?;
    Ok(serde_json::json!({ "ran": true }))
}

#[tauri::command]
pub async fn debug_routine_scheduler_run_once() -> Result<serde_json::Value, String> {
    let handle = crate::api::get_app_handle()
        .ok_or_else(|| "AppHandle not initialized. Is the Tauri app running?".to_string())?;
    agent_core::coordination::routine_scheduler::debug_run_once(handle).await?;
    Ok(serde_json::json!({ "ran": true }))
}

pub async fn test_work_item_launch_parse(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let kind = body
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let content = body
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    match agent_core::tool_infra::debug_parse_work_item_launch_sources(kind, content) {
        Ok(count) => Json(serde_json::json!({
            "ok": true,
            "kind": kind,
            "count": count,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "kind": kind,
            "error": err,
        })),
    }
}

pub async fn test_background_jobs(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use agent_core::core::tools::impls::coding::exec::registry;

    let jobs = registry::list_jobs_for_reminder(&session_id);
    let items: Vec<serde_json::Value> = jobs
        .iter()
        .map(|snap| {
            let status_str = match &snap.status {
                registry::JobStatus::Running => "running".to_string(),
                registry::JobStatus::Exited(code) => format!("exited:{code}"),
                registry::JobStatus::Killed => "killed".to_string(),
                registry::JobStatus::Completed => "completed".to_string(),
                registry::JobStatus::Failed => "failed".to_string(),
            };
            serde_json::json!({
                "handle": snap.handle,
                "label": snap.label,
                "kind": snap.kind_label,
                "status": status_str,
                "age_ms": snap.age_ms,
                "has_unread_output": snap.has_unread_output,
            })
        })
        .collect();

    let reminder_text = if !jobs.is_empty() {
        agent_core::core::session::turn::background_reminder::build_background_jobs_reminder(&jobs)
    } else {
        String::new()
    };

    Json(serde_json::json!({
        "session_id": session_id,
        "count": items.len(),
        "jobs": items,
        "reminder_text": reminder_text,
    }))
}

/// GET `/agent/test/events/recent`: return a snapshot of the debug-only
/// recent-events ring buffer populated by `websocket_handler::broadcast`.
/// Entries are the exact JSON strings that would have been pushed to
/// IPC channels / the debug WS, in insertion order (oldest first).
///
/// Used by the `agent:mcp_progress` broadcast E2E scenarios to assert
/// that the event actually reaches the frontend fanout layer — caller-
/// path coverage (counters alone don't prove the
/// broadcast call was made with the right payload).
pub async fn test_events_recent() -> Json<serde_json::Value> {
    let events = crate::api::websocket_handler::recent_events::snapshot();
    Json(serde_json::json!({
        "ok": true,
        "events": events,
    }))
}

/// POST `/agent/test/events/reset`: clear the debug-only recent-events
/// ring buffer. Required baseline for scenarios that assert "exactly N
/// events of type X were broadcast since reset".
pub async fn test_events_reset() -> Json<serde_json::Value> {
    crate::api::websocket_handler::recent_events::clear();
    Json(serde_json::json!({ "ok": true }))
}
