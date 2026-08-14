//! Dev-only SDE agent test endpoints (plus a few adjacent debug helpers
//! that share the same block in `api/agent/mod.rs`) extracted as part
//! of split 7/8.
//!
//! Covers:
//! - `test_sde_message` (direct SDE agent chat)
//! - `test_tool_schemas` (tool-schema introspection)
//! - `test_sde_mode_switch_*` / `test_sde_plan_approval_*`
//! - `test_sde_permission_*` / `test_sde_question_*`
//! - `test_sde_cleanup` / `test_em_state_get`
//! - `test_sde_todos_*` / `test_sde_seed_orphan` / `test_sde_transcript_get`
//!
//! Only compiled in dev builds; `create_routes` in `api/agent/mod.rs`
//! calls these via `test::sde::*`.

#![cfg(debug_assertions)]

use axum::{extract::Query, Json};
use core_types::providers::NativeHarnessType;
use serde::Deserialize;

// ============================================
// Dev-only: SDE Agent test endpoint (direct agent chat)
// ============================================

#[derive(Debug, Deserialize)]
pub struct SdeTestRequest {
    content: String,
    session_id: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    workspace_path: Option<String>,
    agent_definition_id: Option<String>,
    mode: Option<String>,
    no_cleanup: Option<bool>,
    native_harness_type: Option<String>,
    enable_extract_memories: Option<bool>,
    enable_auto_dream: Option<bool>,
    max_retries: Option<u32>,
    base_backoff_ms: Option<u64>,
    context_window: Option<u64>,
    compaction: Option<agent_core::model_context::compaction::CompactionConfig>,
    #[serde(default)]
    restrict_tools: Vec<String>,
    is_resume: Option<bool>,
    /// pre-seed multi-root additional workspace directories
    /// before `init_workspace_session` runs. Matches the
    /// launch-side persistence path — the data is written to
    /// `agent_sessions.workspace_additional_json` after
    /// `upsert_session` and before runtime hydration, so
    /// `build_session_runtime` picks the directories up via
    /// `load_workspace` and the live `SessionRuntime.workspace_state`
    /// reflects them from the very first turn (including the
    /// `## Environment` block in the system prompt).
    #[serde(default)]
    additional_directories: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CodeSearchToolTestRequest {
    default_repo: String,
    params: serde_json::Value,
}

pub async fn test_code_search_tool(
    Json(request): Json<CodeSearchToolTestRequest>,
) -> Json<serde_json::Value> {
    use agent_core::tools::impls::coding::code_search::SearchTool;
    use agent_core::tools::traits::Tool;
    use std::path::PathBuf;

    let tool = SearchTool::new(PathBuf::from(request.default_repo));
    match tool
        .execute_text(
            request.params,
            &agent_core::tools::call_context::CallContext::default(),
        )
        .await
    {
        Ok(output) => Json(serde_json::json!({ "ok": true, "output": output })),
        Err(err) => Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
    }
}

/// Stamp a debug-endpoint session `running` for the duration of a directly
/// dispatched turn, mirroring what the session scheduler does for production
/// turns. Best-effort: a failed stamp only degrades wake-coordinator
/// accuracy for this test session, so it is logged and swallowed.
async fn mark_test_session_running(session_id: &str) {
    let sid = session_id.to_string();
    let result = tokio::task::spawn_blocking(move || {
        agent_core::session::persistence::update_status(
            &sid,
            agent_core::session::SessionStatus::Running,
        )
    })
    .await;
    match result {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => {
            tracing::warn!(session_id, "test::sde: running-stamp found no session row")
        }
        Ok(Err(err)) => tracing::warn!(
            session_id,
            error = %err,
            "test::sde: failed to stamp session running before direct turn"
        ),
        Err(join_err) => tracing::warn!(
            session_id,
            error = %join_err,
            "test::sde: running-stamp task panicked"
        ),
    }
}

/// Closing bracket for [`mark_test_session_running`]: directly dispatched
/// turns bypass the scheduler's terminal write too, so without this the
/// session stays `running` forever and every job-completion wake claim is
/// released against the stale status (observed as a silent-wake e2e cell
/// timing out while the log shows repeated "owner still running; releasing
/// claim"). Best-effort for the same reason as the opening stamp.
async fn mark_test_session_terminal(session_id: &str) {
    let sid = session_id.to_string();
    let result = tokio::task::spawn_blocking(move || {
        agent_core::session::persistence::update_status(
            &sid,
            agent_core::session::SessionStatus::Completed,
        )
    })
    .await;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => tracing::warn!(
            session_id,
            error = %err,
            "test::sde: failed to stamp session terminal after direct turn"
        ),
        Err(join_err) => tracing::warn!(
            session_id,
            error = %join_err,
            "test::sde: terminal-stamp task panicked"
        ),
    }
}

pub async fn test_sde_message(Json(request): Json<SdeTestRequest>) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized. Is the Tauri app running?"
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();

    let model = match request.model.filter(|m| !m.is_empty()) {
        Some(m) => m,
        None => {
            return Json(serde_json::json!({
                "error": "model is required in request body"
            }));
        }
    };
    let account_id = request.account_id;
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

    let workspace_path = request.workspace_path.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
            .to_string_lossy()
            .to_string()
    });

    let session_prefix = core_types::session::SDE_SESSION_PREFIX;
    let session_id = request
        .session_id
        .unwrap_or_else(|| format!("{}test-{}", session_prefix, uuid::Uuid::new_v4()));

    let now = chrono::Utc::now().to_rfc3339();
    let session = agent_core::session::persistence::UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: "E2E test session".to_string(),
        status: agent_core::session::SessionStatus::Idle
            .as_str()
            .to_string(),
        model: Some(model.clone()),
        account_id: account_id.clone(),
        workspace_path: Some(workspace_path.clone()),
        user_input: Some(request.content.chars().take(100).collect()),
        total_tokens: 0,
        created_at: now.clone(),
        updated_at: now,
        session_type: agent_core::session::persistence::session_type::CODING.to_string(),
        agent_definition_id: request.agent_definition_id.clone(),
        native_harness_type: native_harness_type
            .map(|harness_type| harness_type.as_str().to_string()),
        ..Default::default()
    };

    if let Err(err) = tokio::task::spawn_blocking({
        let session = session.clone();
        move || agent_core::session::persistence::upsert_session(&session)
    })
    .await
    .unwrap_or_else(|err| Err(rusqlite::Error::InvalidParameterName(err.to_string())))
    {
        return Json(serde_json::json!({ "error": format!("Failed to create session: {}", err) }));
    }

    let effective_path = std::path::PathBuf::from(&workspace_path);

    // persist caller-supplied additional directories BEFORE
    // `init_workspace_session`, so the runtime's
    // `workspace_state` (hydrated inside `build_session_runtime` via
    // `load_workspace`) sees the full multi-root path set from the
    // very first turn — no warm-up message required.
    if !request.additional_directories.is_empty() {
        let sid_for_blocking = session_id.clone();
        let root_for_blocking = effective_path.clone();
        let extras = request.additional_directories.clone();
        let persist = tokio::task::spawn_blocking(move || {
            use agent_core::session::persistence as workspace_persistence;
            use agent_core::session::workspace::{
                AdditionalDirectory, DirectorySource, SessionWorkspace,
            };

            let mut workspace = SessionWorkspace::new(root_for_blocking);
            for extra in extras {
                let path = std::path::PathBuf::from(&extra);
                if path == workspace.workspace_root {
                    continue;
                }
                workspace.add_directory(AdditionalDirectory {
                    path,
                    source: DirectorySource::Session,
                });
            }
            workspace_persistence::save_workspace(&sid_for_blocking, &workspace)
                .map_err(|err| err.to_string())
        })
        .await;

        match persist {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                return Json(serde_json::json!({
                    "error": format!("Failed to persist additional_directories: {}", err)
                }));
            }
            Err(join_err) => {
                return Json(serde_json::json!({
                    "error": format!("spawn_blocking join error: {}", join_err)
                }));
            }
        }
    }

    let mut definition = if let Some(ref def_id) = request.agent_definition_id {
        let store = agent_core::definitions::definitions_store();
        match agent_core::definitions::resolve_definition_by_id(def_id, Some(&store)) {
            Ok(definition) => definition,
            Err(err) => {
                return Json(serde_json::json!({
                    "error": format!("Failed to resolve agent_definition_id '{}': {}", def_id, err)
                }));
            }
        }
    } else {
        let store = agent_core::definitions::definitions_store();
        agent_core::definitions::resolve_definition_by_id(
            agent_core::definitions::SDE_AGENT_ID,
            Some(&store),
        )
        .unwrap_or_else(|_| agent_core::definitions::sde_agent())
    };

    // Patch debug-only definition flags before registration so ResolvedAgent
    // picks them up during runtime init.
    {
        let learnings = definition.learnings.get_or_insert_with(Default::default);
        if request.enable_extract_memories.unwrap_or(false) {
            learnings.extract_memories_enabled = true;
        }
        if request.enable_auto_dream.unwrap_or(false) {
            learnings.auto_dream_enabled = true;
        }
        if request.max_retries.is_some() || request.base_backoff_ms.is_some() {
            let reliability = definition.reliability.get_or_insert_with(Default::default);
            if let Some(max_retries) = request.max_retries {
                reliability.max_retries = max_retries;
            }
            if let Some(base_backoff_ms) = request.base_backoff_ms {
                reliability.base_backoff_ms = base_backoff_ms;
            }
        }
        if let Some(context_window) = request.context_window.filter(|value| *value > 0) {
            definition.context_window = Some(context_window);
        }
        if let Some(compaction) = request.compaction.clone() {
            let session_model = definition
                .session_model
                .get_or_insert_with(agent_core::definitions::SessionModel::default);
            session_model.compaction = Some(compaction);
        }
        if !request.restrict_tools.is_empty() {
            definition.tools.system_restrict_to_tools = Some(request.restrict_tools.clone());
            definition.tools.user_allowed_tools.clear();
            definition.tools.excluded_tools.clear();
        }
    }

    let definition_for_runtime_snapshot = definition.clone();
    if state.get_session(&session_id).await.is_none() {
        use agent_core::state::AgentSession;
        let agent_session = AgentSession::new(session_id.clone(), definition);
        state.register_session(agent_session).await;
    }

    let launch_spec = match agent_core::init::launch_spec::AgentLaunchSpec::registered_session(
        &state,
        &session_id,
        effective_path.clone(),
        account_id.clone(),
        Some(model.clone()),
        native_harness_type,
    )
    .await
    {
        Ok(spec) => spec,
        Err(err) => {
            return Json(serde_json::json!({
                "error": format!("Failed to build launch spec: {}", err)
            }));
        }
    };

    let runtime = match agent_core::init::init_session(&state, launch_spec).await {
        Ok(rt) => rt,
        Err(err) => {
            return Json(
                serde_json::json!({ "error": format!("Failed to init runtime: {}", err) }),
            );
        }
    };

    let runtime_tool_names: Vec<String> = runtime
        .tool_registry
        .get_definitions()
        .into_iter()
        .filter_map(|tool| {
            tool.get("name")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    tool.get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(|value| value.as_str())
                })
                .map(String::from)
        })
        .collect();
    // Single source: resolved.skills carries enabled/include/disabled.
    let effective_skill_disabled: Vec<String> = {
        let set: std::collections::BTreeSet<String> =
            runtime.resolved.skills.disabled.iter().cloned().collect();
        set.into_iter().collect()
    };
    let resolved_skill_include = runtime.resolved.skills.include.clone();
    let effective_skill_include = if resolved_skill_include.is_empty() {
        None
    } else {
        Some(resolved_skill_include.as_slice())
    };
    let runtime_skills_listing = if runtime.resolved.skills.enabled {
        let workspace_root = runtime.workspace_state.read().workspace_root.clone();
        let skills_dir = workspace_root.join(".orgii");
        let loader = agent_core::skills::loader::SkillsLoader::new(&skills_dir)
            .with_builtin_dir(agent_core::skills::loader::global_skills_dir());
        loader.build_skill_listing_attachment(&effective_skill_disabled, effective_skill_include)
    } else {
        None
    };
    let runtime_snapshot = serde_json::json!({
        "agentId": definition_for_runtime_snapshot.id,
        "runtimeAgentSoul": runtime.agent_soul,
        "runtimeModel": runtime.model.clone(),
        "runtimeAccountId": runtime.account_id.clone(),
        "definitionSoulContent": definition_for_runtime_snapshot.soul_content,
        "definitionDisabledMcpServers": definition_for_runtime_snapshot.tools.disabled_mcp_servers,
        "resolvedDisabledMcpServers": runtime.resolved.tools.disabled_mcp_servers,
        "definitionSkillsExclude": definition_for_runtime_snapshot
            .skills_config
            .as_ref()
            .map(|cfg| cfg.exclude.clone())
            .unwrap_or_default(),
        "resolvedSkillsDisabled": runtime.resolved.skills.disabled.clone(),
        "effectivePerTurnDisabled": effective_skill_disabled,
        "effectiveSkillListing": runtime_skills_listing,
        "learningsEnabled": runtime.resolved.learnings.enabled,
        "extractMemoriesEnabled": runtime.resolved.learnings.extract_memories_enabled,
        "autoDreamEnabled": runtime.resolved.learnings.auto_dream_enabled,
        "registeredToolNames": runtime_tool_names,
        "nativeHarnessType": runtime.native_harness_type.map(|value| value.as_str()),
        "providerName": runtime.provider.provider_name(),
        "definitionReliability": definition_for_runtime_snapshot.reliability,
        "definitionRestrictTools": definition_for_runtime_snapshot.tools.system_restrict_to_tools,
    });

    let mode_str = request.mode.as_deref().unwrap_or("build");
    let mode = match agent_core::session::AgentExecMode::parse(mode_str) {
        Some(m) => m,
        None => {
            return Json(
                serde_json::json!({ "error": format!("Unknown agent exec mode: {mode_str:?}") }),
            );
        }
    };

    let session_arc = match state.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return Json(
                serde_json::json!({ "error": format!("Session {} not found after init", session_id) }),
            );
        }
    };

    let input = agent_core::session::TurnInput {
        content: request.content.clone(),
        agent_mode: Some(mode),
        is_resume: request.is_resume.unwrap_or(false),
        ..Default::default()
    };

    // Production turns go through the session scheduler, which stamps the
    // session row `running` for the duration of the turn. This endpoint
    // calls `process_message` directly, so without the same stamp the
    // job-completion wake coordinator reads a stale `idle` and dispatches a
    // resume turn CONCURRENTLY with the one still executing (observed in
    // e2e as interleaved iteration logs and a stolen mid-turn-note claim).
    // The terminal status is written by the turn's own finalize path; only
    // the running window needs covering here.
    mark_test_session_running(&session_id).await;

    let response = agent_core::session::process_message(
        session_arc,
        input,
        crate::api::get_app_handle().cloned(),
    )
    .await;

    mark_test_session_terminal(&session_id).await;

    // Extract tool_calls from session messages (like OS Agent endpoint).
    //
    // Two projections are returned so E2E scenarios can distinguish what the
    // model *tried* to call from what actually executed:
    //
    //   * `tool_calls`           — every `tool_call` row in message order.
    //     Includes hallucinated names the model made up (e.g. PascalCase
    //     wrappers of MCP wire names). Faithful record of what the LLM
    //     emitted, same shape as before.
    //
    //   * `tool_calls_succeeded` — subset of `tool_calls` whose matching
    //     `tool_result` row (join on `tool_call_id`) has content that does
    //     NOT start with "Error" (the wire format `single.rs` uses for
    //     failures). Use this for positive assertions like "the agent
    //     actually invoked `mcp__memory__read_graph`", so retries after a
    //     hallucinated-name failure don't pollute the signal.
    let session_id_for_tools = session_id.clone();
    let (tool_calls, tool_calls_succeeded, tool_calls_with_id_out) =
        tokio::task::spawn_blocking(move || {
            // Silent fallback to an empty Vec here would make E2E
            // assertions on tool calls trivially pass (no rows to
            // check). Surface persistence failures via `warn!` so
            // a flaky test environment is visible to the test runner.
            let msgs = match agent_core::session::persistence::load_messages(&session_id_for_tools)
            {
                Ok(m) => m,
                Err(err) => {
                    tracing::warn!(
                        session_id = %session_id_for_tools,
                        error = %err,
                        "test::sde: load_messages failed; tool-call assertions will see empty list"
                    );
                    Vec::new()
                }
            };

            let mut all: Vec<String> = Vec::new();
            let mut results_by_id: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut tool_calls_with_id: Vec<(String, Option<String>)> = Vec::new();

            for m in &msgs {
                match m.role.as_str() {
                    "tool_call" => {
                        if let Some(name) = m.tool_name.clone() {
                            all.push(name.clone());
                            tool_calls_with_id.push((name, m.tool_call_id.clone()));
                        }
                    }
                    "tool_result" => {
                        if let Some(id) = m.tool_call_id.clone() {
                            results_by_id.insert(id, m.content.clone());
                        }
                    }
                    _ => {}
                }
            }

            let succeeded: Vec<String> = tool_calls_with_id
                .iter()
                .filter_map(|(name, id)| {
                    let id = id.as_ref()?;
                    let result = results_by_id.get(id)?;
                    if result.starts_with("Error") {
                        None
                    } else {
                        Some(name.clone())
                    }
                })
                .collect();

            // plan E2E: scenarios need to pair a tool name with
            // its exact `tool_call_id` so they can assert that the
            // `PlanApprovalManager` pending snapshot is keyed on the same
            // id the parent session emitted. Emitting `id = ""` when the
            // persistence layer somehow dropped the id preserves row
            // alignment with `tool_calls`.
            let with_id: Vec<serde_json::Value> = tool_calls_with_id
                .into_iter()
                .map(|(name, id)| {
                    serde_json::json!({
                        "name": name,
                        "id": id.unwrap_or_default(),
                    })
                })
                .collect();

            (all, succeeded, with_id)
        })
        .await
        .unwrap_or_else(|err| {
            // A JoinError here means the spawn_blocking worker
            // panicked. Default-empty would make E2E assertions
            // silently pass.
            tracing::warn!(
                error = %err,
                "test::sde: tool-call collection task panicked; assertions will see empty lists"
            );
            (Vec::new(), Vec::new(), Vec::new())
        });

    let persisted_session = match tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || agent_core::session::persistence::get_session(&sid)
    })
    .await
    {
        Ok(Ok(record)) => record,
        Ok(Err(err)) => {
            return Json(serde_json::json!({
                "error": format!("Failed to load persisted session: {}", err)
            }));
        }
        Err(err) => {
            return Json(serde_json::json!({
                "error": format!("Persisted session lookup task failed: {}", err)
            }));
        }
    };
    let persisted_model = persisted_session
        .as_ref()
        .and_then(|record| record.model.clone());
    let persisted_account_id = persisted_session
        .as_ref()
        .and_then(|record| record.account_id.clone());

    let skip_cleanup = request.no_cleanup.unwrap_or(false);
    if !skip_cleanup {
        state.invalidate_session(&session_id).await;
    }

    match response {
        Ok(result) => Json(serde_json::json!({
            "content": result.content,
            "session_id": session_id,
            "model": model,
            "persisted_model": persisted_model,
            "persisted_account_id": persisted_account_id,
            "agent_definition_id": request.agent_definition_id,
            "tool_calls": tool_calls,
            "tool_calls_succeeded": tool_calls_succeeded,
            "tool_calls_with_id": tool_calls_with_id_out,
            "tool_calls_count": result.tool_calls_count,
            "total_tokens": result.total_tokens,
            "turn_summary": result.turn_summary,
            "runtime_snapshot": runtime_snapshot,
        })),
        Err(err) => Json(serde_json::json!({ "error": err })),
    }
}

// ============================================
// Dev-only: tool schemas introspection endpoint
// ============================================

pub async fn test_tool_schemas(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized"
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let runtime = match state.get_session(&session_id).await.and_then(|s| {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async { s.get_runtime().await })
        })
    }) {
        Some(rt) => rt,
        None => {
            return Json(serde_json::json!({
                "error": format!("No runtime found for session '{}'", session_id)
            }));
        }
    };

    let registered_tool_names = runtime.tool_registry.tool_names();
    let ready_tool_names = runtime.tool_registry.ready_tool_names();
    let deferred_tool_names = runtime.tool_registry.deferred_tool_names();
    let definitions = runtime.tool_registry.get_definitions();

    Json(serde_json::json!({
        "session_id": session_id,
        "registered_tool_count": registered_tool_names.len(),
        "registered_tool_names": registered_tool_names,
        "ready_tool_count": ready_tool_names.len(),
        "ready_tool_names": ready_tool_names,
        "deferred_tool_count": deferred_tool_names.len(),
        "deferred_tool_names": deferred_tool_names,
        "tool_count": definitions.len(),
        "tools": definitions,
    }))
}

#[derive(Debug, Deserialize)]
pub struct EffectiveToolsQuery {
    mode: Option<String>,
}

pub async fn test_effective_tools(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Query(query): Query<EffectiveToolsQuery>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized"
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let request = agent_core::state::commands::tools::EffectiveToolsRequest {
        session_id,
        agent_exec_mode: query.mode,
    };

    match agent_core::state::commands::tools::list_effective_tools_for_session(&state, request)
        .await
    {
        Ok(response) => Json(serde_json::to_value(response).unwrap_or_else(|err| {
            serde_json::json!({ "error": format!("failed to serialize effective tools: {err}") })
        })),
        Err(err) => Json(serde_json::json!({ "error": err })),
    }
}

// ============================================
// Dev-only: SDE mode-switch test endpoints
// ============================================

pub async fn test_sde_mode_switch_pending(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized",
                "pending": false,
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let pending = if let Some(session) = state.get_session(&session_id).await {
        if let Some(ref mgr) = session.mode_switch_manager {
            mgr.is_pending().await
        } else {
            false
        }
    } else {
        false
    };

    Json(serde_json::json!({ "pending": pending }))
}

#[derive(Debug, Deserialize)]
pub struct ModeSwitchSeedRequest {
    target_mode: Option<String>,
    reason: Option<String>,
    tool_call_id: Option<String>,
    workspace_path: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    native_harness_type: Option<String>,
}

pub async fn test_sde_mode_switch_seed(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<ModeSwitchSeedRequest>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "AppHandle not initialized",
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    if state.get_session(&session_id).await.is_none() {
        if let Err(err) =
            agent_core::init::register_session_with_rehydrate(&state, &session_id).await
        {
            return Json(serde_json::json!({
                "ok": false,
                "error": err
            }));
        }
    }
    let Some(session) = state.get_session(&session_id).await else {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("No session found: {}", session_id),
        }));
    };
    if session.runtime.read().await.is_none() {
        let workspace_path = request
            .workspace_path
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let native_harness_type = match request.native_harness_type.as_deref() {
            Some(value) if !value.is_empty() => {
                match core_types::providers::NativeHarnessType::parse(value) {
                    Some(parsed) => Some(parsed),
                    None => {
                        return Json(serde_json::json!({
                            "ok": false,
                            "error": format!("Unknown native_harness_type: {}", value),
                        }));
                    }
                }
            }
            _ => None,
        };
        let launch_spec =
            match agent_core::init::launch_spec::AgentLaunchSpec::from_session_sources(
                &state,
                &session_id,
                workspace_path,
                request.account_id.clone(),
                request.model.clone(),
                native_harness_type,
            )
            .await
            {
                Ok(spec) => spec,
                Err(err) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("Failed to resolve launch spec: {}", err),
                    }));
                }
            };
        if let Err(err) = agent_core::init::init_session(&state, launch_spec).await {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Failed to initialize session runtime: {}", err),
            }));
        }
    }
    let Some(manager) = session.mode_switch_manager.as_ref() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("No mode-switch manager for session {}", session_id),
        }));
    };

    let target_mode = request.target_mode.as_deref().unwrap_or("plan");
    let reason = request
        .reason
        .as_deref()
        .unwrap_or("This task should be planned before implementation.");
    let tool_call_id = request.tool_call_id.as_deref();
    let receiver = manager
        .ask(&session_id, target_mode, reason, tool_call_id)
        .await;
    tokio::spawn(async move {
        let _ = receiver.await;
    });

    Json(serde_json::json!({
        "ok": true,
        "pending": true,
        "target_mode": target_mode,
        "reason": reason,
        "tool_call_id": tool_call_id,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ModeSwitchTestRequest {
    choice: String,
    target_mode: Option<String>,
}

pub async fn test_sde_mode_switch_respond(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<ModeSwitchTestRequest>,
) -> Json<serde_json::Value> {
    use agent_core::interaction::mode_switch::ModeSwitchChoice;
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let manager = match state
        .get_session(&session_id)
        .await
        .and_then(|s| s.mode_switch_manager.clone())
    {
        Some(m) => m,
        None => {
            return Json(serde_json::json!({
                "error": format!("No mode-switch manager for session {}", session_id),
            }));
        }
    };

    let decision = match request.choice.as_str() {
        "switch" => ModeSwitchChoice::Switch(match request.target_mode {
            Some(mode) if !mode.is_empty() => mode,
            _ => {
                return Json(serde_json::json!({
                    "error": "target_mode is required when choice is 'switch'"
                }));
            }
        }),
        "skip" => ModeSwitchChoice::Skip,
        other => {
            return Json(serde_json::json!({
                "error": format!("Invalid choice: {}", other),
            }));
        }
    };

    manager.respond(decision).await;
    Json(serde_json::json!({ "ok": true }))
}

// ============================================
// Dev-only: SDE plan-approval test endpoints
// ============================================
//
// The production flow is non-blocking: `create_plan` broadcasts
// `agent:plan_ready_for_approval` and returns immediately
// (the turn hard-terminates after the tool returns), the frontend
// renders a plan card with an inline Build button, and the
// `agent_plan_approval_response` Tauri command consumes the pending
// snapshot when Build is clicked. These HTTP endpoints give E2E
// tests a symmetric pair — `GET` to read the pending snapshot left
// by `create_plan`, `POST` to act as the Build click. Both paths
// hit the same `PlanApprovalManager`.

pub async fn test_sde_plan_approval_pending(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "error": "AppHandle not initialized",
                "pending": false,
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let Some(session) = state.get_session(&session_id).await else {
        return Json(serde_json::json!({ "pending": false }));
    };
    let Some(ref manager) = session.plan_approval_manager else {
        return Json(serde_json::json!({ "pending": false }));
    };

    match manager.pending_snapshot().await {
        None => Json(serde_json::json!({ "pending": false })),
        Some(snap) => Json(serde_json::json!({
            "pending": true,
            "session_id": snap.session_id,
            "tool_call_id": snap.tool_call_id,
            "plan_path": snap.plan_path,
            "plan_title": snap.plan_title,
            "plan_content": snap.plan_content,
            "created_at_ms": snap.created_at_ms,
        })),
    }
}

#[derive(Debug, Deserialize)]
pub struct PlanApprovalSeedRequest {
    title: Option<String>,
    content: String,
    plan_path: String,
    tool_call_id: Option<String>,
}

pub async fn test_sde_plan_approval_seed(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<PlanApprovalSeedRequest>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "AppHandle not initialized",
            }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    if state.get_session(&session_id).await.is_none() {
        if let Err(err) =
            agent_core::init::register_session_with_rehydrate(&state, &session_id).await
        {
            return Json(serde_json::json!({
                "ok": false,
                "error": err
            }));
        }
    }
    let Some(session) = state.get_session(&session_id).await else {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("No session found: {}", session_id),
        }));
    };
    let Some(manager) = session.plan_approval_manager.as_ref() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("No plan-approval manager for session {}", session_id),
        }));
    };

    if let Err(err) = std::fs::write(&request.plan_path, request.content.as_bytes()) {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("Failed to write seeded plan: {}", err),
        }));
    }

    manager
        .mark_ready(
            &session_id,
            &request.plan_path,
            request.title.as_deref().unwrap_or("E2E Plan"),
            &request.content,
            request.tool_call_id.as_deref(),
        )
        .await;

    match manager.pending_snapshot().await {
        Some(snapshot) => Json(serde_json::json!({
            "ok": true,
            "snapshot": {
                "session_id": snapshot.session_id,
                "tool_call_id": snapshot.tool_call_id,
                "plan_id": snapshot.plan_id,
                "plan_revision_id": snapshot.plan_revision_id,
                "origin_tool_call_id": snapshot.origin_tool_call_id,
                "plan_path": snapshot.plan_path,
                "plan_title": snapshot.plan_title,
                "plan_content": snapshot.plan_content,
                "created_at_ms": snapshot.created_at_ms,
            },
        })),
        None => Json(serde_json::json!({
            "ok": false,
            "error": "Seeded plan did not become pending",
        })),
    }
}

pub async fn test_sde_plan_approval_lifecycle_order() -> Json<serde_json::Value> {
    use crate::agent_sessions::event_pipeline::commands::EventStoreState;
    use agent_core::interaction::plan_approval::persistence::PlanApprovalStore;
    use agent_core::interaction::plan_approval::PlanApprovalManager;
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "AppHandle not initialized",
            }));
        }
    };

    let session_id = format!("e2e-plan-lifecycle-{}", uuid::Uuid::new_v4());
    let plan_a = std::env::temp_dir().join(format!("{session_id}-a.plan.md"));
    let plan_b = std::env::temp_dir().join(format!("{session_id}-b.plan.md"));
    if let Err(err) = std::fs::write(&plan_a, "# First plan") {
        return Json(serde_json::json!({ "ok": false, "error": err.to_string() }));
    }
    if let Err(err) = std::fs::write(&plan_b, "# Second plan") {
        let _ = std::fs::remove_file(&plan_a);
        return Json(serde_json::json!({ "ok": false, "error": err.to_string() }));
    }

    let manager = PlanApprovalManager::new();
    manager.set_app_handle(Some(handle.clone()));
    manager
        .mark_ready(
            &session_id,
            plan_a.to_str().unwrap_or_default(),
            "First plan",
            "# First plan",
            Some("call_first"),
        )
        .await;
    let first_snapshot = match manager.pending_snapshot().await {
        Some(snapshot) => snapshot,
        None => {
            let _ = std::fs::remove_file(&plan_a);
            let _ = std::fs::remove_file(&plan_b);
            return Json(serde_json::json!({
                "ok": false,
                "error": "first plan snapshot was not recorded",
            }));
        }
    };
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    manager
        .mark_ready(
            &session_id,
            plan_b.to_str().unwrap_or_default(),
            "Second plan",
            "# Second plan",
            Some("call_second"),
        )
        .await;
    let second_snapshot = match manager.pending_snapshot().await {
        Some(snapshot) => snapshot,
        None => {
            let _ = std::fs::remove_file(&plan_a);
            let _ = std::fs::remove_file(&plan_b);
            return Json(serde_json::json!({
                "ok": false,
                "error": "second plan snapshot was not recorded",
            }));
        }
    };

    let event_store = handle.state::<EventStoreState>();
    let events = event_store
        .with_store_opt(&session_id, |store| store.events().to_vec())
        .unwrap_or_default();
    let plan_events: Vec<serde_json::Value> = events
        .iter()
        .filter(|event| event.function_name == core_types::tool_names::PLAN_APPROVAL)
        .map(|event| {
            serde_json::json!({
                "id": event.id,
                "created_at": event.created_at,
                "status": event.result.get("status").and_then(|value| value.as_str()),
                "plan_revision_id": event.result.get("planRevisionId").and_then(|value| value.as_str()),
            })
        })
        .collect();

    let _ = tokio::task::spawn_blocking({
        let cleanup_session_id = session_id.clone();
        move || PlanApprovalStore::delete_by_session(&cleanup_session_id)
    })
    .await;
    let _ = std::fs::remove_file(&plan_a);
    let _ = std::fs::remove_file(&plan_b);

    Json(serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "first_created_at_ms": first_snapshot.created_at_ms,
        "second_created_at_ms": second_snapshot.created_at_ms,
        "plan_events": plan_events,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PlanApprovalTestRequest {
    /// One of: "approve", "approve_with_edits".
    /// (No reject — the user iterates by sending a new turn.)
    choice: String,
    /// Required when `choice == "approve_with_edits"`.
    edited_content: Option<String>,
}

pub async fn test_sde_plan_approval_respond(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<PlanApprovalTestRequest>,
) -> Json<serde_json::Value> {
    use agent_core::session::AgentExecMode;
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let session = match state.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "error": format!("No session found: {}", session_id),
            }));
        }
    };
    let manager = match session.plan_approval_manager.as_ref() {
        Some(m) => m.clone(),
        None => {
            return Json(serde_json::json!({
                "error": format!("No plan-approval manager for session {}", session_id),
            }));
        }
    };

    let edited = match request.choice.as_str() {
        "approve" => None,
        "approve_with_edits" => {
            let Some(content) = request.edited_content else {
                return Json(serde_json::json!({
                    "error": "`edited_content` is required when choice is 'approve_with_edits'",
                }));
            };
            if content.is_empty() {
                return Json(serde_json::json!({
                    "error": "`edited_content` must be non-empty",
                }));
            }
            Some(content)
        }
        other => {
            return Json(serde_json::json!({
                "error": format!("Invalid choice: {}", other),
            }));
        }
    };

    let snapshot = match manager.take_pending().await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "error": format!("No pending plan approval for session {}", session_id),
            }));
        }
    };

    if let Some(ref new_content) = edited {
        if let Err(err) = std::fs::write(&snapshot.plan_path, new_content.as_bytes()) {
            return Json(serde_json::json!({
                "error": format!("Failed to persist edited plan: {}", err),
            }));
        }
    }

    let restore_mode = session
        .pre_plan_mode_cache
        .take(&session_id)
        .unwrap_or(AgentExecMode::Plan);
    let build_turn_mode = AgentExecMode::Build;

    session.plan_slot_cache.clear(&session_id);

    if let Err(err) =
        agent_core::session::persistence::update_agent_exec_mode(&session_id, restore_mode.as_str())
    {
        return Json(serde_json::json!({
            "error": format!("Failed to persist restored agent exec mode: {}", err),
        }));
    }

    let plan_body = std::fs::read_to_string(&snapshot.plan_path)
        .unwrap_or_else(|_| String::from("(plan file unavailable)"));

    agent_core::bus::broadcast_event(
        "agent:exit_plan_mode",
        serde_json::json!({
            "sessionId": session_id,
            "planPath": snapshot.plan_path,
            "planTitle": snapshot.plan_title,
            "toolCallId": snapshot.tool_call_id,
            "restoreMode": restore_mode.as_str(),
            "edited": edited.is_some(),
        }),
    );

    // Kick off a fresh Build-mode turn with a synthetic user-visible
    // instruction to start implementing the approved plan.
    // The real tauri command (`agent_plan_approval_response`) delegates to
    // `send_message_impl`, which routes through the session scheduler. The
    // HTTP test endpoint here is a debug harness that skips the scheduler
    // and goes straight to `process_message` — mirroring the pattern used
    // by `test_sde_message` above — so E2E scenarios can block on the
    // rebuild turn and assert against its tool_calls without threading in
    // queue/websocket plumbing.
    let _workspace_path = match agent_core::session::persistence::get_session(&session_id) {
        Ok(Some(s)) => match s.workspace_path {
            Some(p) => std::path::PathBuf::from(p),
            None => {
                return Json(serde_json::json!({
                    "error": "session has no workspace_path — plan-mode requires a workspace",
                }));
            }
        },
        Ok(None) => {
            return Json(serde_json::json!({
                "error": "session not found",
            }));
        }
        Err(err) => {
            // Silent `.ok().flatten()` would have collapsed a DB
            // error into the "no workspace_path" branch — making the
            // E2E runner think the test setup was wrong instead of
            // surfacing a persistence failure.
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "test::sde plan-mode: get_session DB error"
            );
            return Json(serde_json::json!({
                "error": format!("get_session DB error: {}", err),
            }));
        }
    };

    if session.get_runtime().await.is_none() {
        return Json(serde_json::json!({
            "error": "session runtime missing — cannot rebuild after approval",
        }));
    }

    let rebuild_content = format!(
        "[Plan approved{edited_marker}] Start implementing the approved plan now.\n\n\
         Begin by calling `manage_todo` with the concrete tasks from the plan, \
         then execute them one by one.\n\n\
         ## Approved plan\n\n{plan_body}",
        edited_marker = if edited.is_some() { " (edited)" } else { "" },
    );

    let rebuild_input = agent_core::session::TurnInput {
        content: rebuild_content,
        agent_mode: Some(build_turn_mode),
        ..Default::default()
    };

    // Same running-window stamp as `test_sde_message` — see the comment
    // there for why a direct `process_message` call needs it.
    mark_test_session_running(&session_id).await;

    let rebuild_response = agent_core::session::process_message(
        session,
        rebuild_input,
        crate::api::get_app_handle().cloned(),
    )
    .await;

    mark_test_session_terminal(&session_id).await;

    // Collect the full tool_call history for the session so E2E scenarios
    // can assert on what the rebuild turn did (notably `manage_todo`). We
    // intentionally return the whole history — the Plan turn contributes
    // `create_plan` (which is now both the write and the submission
    // signal) and anything Build-specific (`manage_todo`, edits, reads,
    // etc.) can only come from the rebuild turn kicked off above. Tests
    // filter by name.
    let session_id_for_tools = session_id.clone();
    let rebuild_tool_calls: Vec<String> = tokio::task::spawn_blocking(move || {
        // Silent fallback would make rebuild-turn assertions
        // trivially pass on a persistence failure. Warn to surface
        // flaky test environments.
        match agent_core::session::persistence::load_messages(&session_id_for_tools) {
            Ok(msgs) => msgs
                .into_iter()
                .filter(|m| m.role == "tool_call")
                .filter_map(|m| m.tool_name)
                .collect(),
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id_for_tools,
                    error = %err,
                    "test::sde rebuild: load_messages failed; tool-call assertions will see empty list"
                );
                Vec::new()
            }
        }
    })
    .await
    .unwrap_or_else(|err| {
        tracing::warn!(
            error = %err,
            "test::sde rebuild: tool-call collection task panicked; assertions will see empty list"
        );
        Vec::new()
    });

    let (rebuild_content_out, rebuild_error) = match rebuild_response {
        Ok(ref r) => (r.content.clone(), None),
        Err(ref e) => (String::new(), Some(e.to_string())),
    };

    Json(serde_json::json!({
        "ok": true,
        "restore_mode": restore_mode.as_str(),
        "rebuild_content": rebuild_content_out,
        "rebuild_tool_calls": rebuild_tool_calls,
        "rebuild_error": rebuild_error,
    }))
}

// ============================================
// Dev-only: Permission poll/respond endpoints
// ============================================

pub async fn test_sde_permission_pending(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(
                serde_json::json!({ "error": "AppHandle not initialized", "pending": false }),
            );
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let (has_pending, request_ids) = if let Some(session) = state.get_session(&session_id).await {
        let pending = session.permission_manager.has_pending().await;
        let ids = session.permission_manager.pending_ids().await;
        (pending, ids)
    } else {
        (false, vec![])
    };

    Json(serde_json::json!({
        "pending": has_pending,
        "request_ids": request_ids,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PermissionTestRequest {
    request_id: String,
    response: String,
    tool_name: Option<String>,
    tool_args: Option<serde_json::Value>,
}

pub async fn test_sde_permission_respond(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<PermissionTestRequest>,
) -> Json<serde_json::Value> {
    use agent_core::interaction::permission::PermissionResponse;
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let pm = match state.get_session(&session_id).await {
        Some(s) => s.permission_manager.clone(),
        None => {
            return Json(serde_json::json!({
                "error": format!("No session found: {}", session_id),
            }));
        }
    };

    let perm_response = match PermissionResponse::from_wire(&request.response) {
        Some(r) => r,
        None => {
            return Json(serde_json::json!({
                "error": format!("Invalid response: {}", request.response),
            }));
        }
    };

    let found = pm
        .respond(
            &request.request_id,
            perm_response,
            request.tool_name.as_deref(),
            request.tool_args.as_ref(),
        )
        .await;

    Json(serde_json::json!({ "ok": found }))
}

// ============================================
// Dev-only: SDE ask_user_questions test endpoints
// ============================================
//
// Mirrors the permission endpoint pattern: GET returns pending requests with
// their metadata (including the full `questions` array), POST submits answers
// and unblocks the blocking tool call, completing the LLM turn.
//
// `answers` is Vec<Vec<String>> — outer vec is per question, inner vec is the
// selected option label(s). For single-select, inner vec has exactly one item.

pub async fn test_sde_question_pending(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(
                serde_json::json!({ "error": "AppHandle not initialized", "pending": false }),
            );
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let (has_pending, pending_meta) = if let Some(session) = state.get_session(&session_id).await {
        let meta = session.question_manager.get_pending_metadata().await;
        let pending = !meta.is_empty();
        (pending, meta)
    } else {
        (false, vec![])
    };

    // Extract just the request_ids for convenience
    let request_ids: Vec<String> = pending_meta
        .iter()
        .filter_map(|m| {
            m.get("requestId")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .collect();

    Json(serde_json::json!({
        "pending": has_pending,
        "request_ids": request_ids,
        "questions_meta": pending_meta,
    }))
}

#[derive(Debug, Deserialize)]
pub struct QuestionTestRequest {
    request_id: String,
    /// Vec<Vec<String>>: outer = per question, inner = selected option label(s).
    /// Single-select: inner has 1 item. Multi-select: inner has 1+ items.
    answers: Vec<Vec<String>>,
}

pub async fn test_sde_question_respond(
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Json(request): Json<QuestionTestRequest>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    let qm = match state.get_session(&session_id).await {
        Some(s) => s.question_manager.clone(),
        None => {
            return Json(serde_json::json!({
                "error": format!("No session found: {}", session_id),
            }));
        }
    };

    let _ = qm.respond(&request.request_id, request.answers).await;
    Json(serde_json::json!({ "ok": true }))
}

// ============================================
// Dev-only: SDE session cleanup endpoint
// ============================================

pub async fn test_sde_cleanup(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };

    let state = handle.state::<agent_core::state::AgentAppState>();
    state.invalidate_session(&session_id).await;
    Json(serde_json::json!({ "ok": true }))
}

pub async fn test_em_state_get(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(serde_json::json!({ "error": "AppHandle not initialized" }));
        }
    };
    let state = handle.state::<agent_core::state::AgentAppState>();
    let session = match state.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "error": "session not found",
                "session_id": session_id,
            }));
        }
    };

    let em_snap = session.em_state.lock().await.snapshot();

    Json(serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "em_state": {
            "last_processed_seq": em_snap.last_processed_seq,
            "in_progress": em_snap.in_progress,
            "turns_since_extraction": em_snap.turns_since_extraction,
        },
    }))
}

pub async fn test_sde_todos_get(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let sid = session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        agent_core::persistence::db_helpers::todos::get_todos(&sid)
    })
    .await;

    match result {
        Err(join) => Json(serde_json::json!({
            "error": format!("Join error: {}", join),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "error": format!("DB error: {}", err),
        })),
        Ok(Ok(records)) => {
            let items: Vec<serde_json::Value> = records
                .into_iter()
                .enumerate()
                .map(|(idx, todo)| {
                    let mut obj = serde_json::json!({
                        "index": idx,
                        "content": todo.content,
                        "activeForm": todo.active_form,
                        "status": todo.status,
                        "priority": todo.priority,
                    });
                    if !todo.blocked_by.is_empty() {
                        obj["blockedBy"] = serde_json::json!(todo.blocked_by);
                    }
                    obj
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "session_id": session_id,
                "count": items.len(),
                "todos": items,
            }))
        }
    }
}

/// `GET /agent/test/sde/todos/:session_id/ready`
///
/// Returns only the tasks that are **pending AND ready** (all `blocked_by`
/// positions have status `completed` or `cancelled`). Mirrors the
/// `manage_todo` `list_ready` action at the DB level so E2E tests can assert
/// the filter logic deterministically without driving an LLM turn.
pub async fn test_sde_todos_list_ready(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use agent_core::persistence::db_helpers::todos::get_todos;

    let sid = session_id.clone();
    let result = tokio::task::spawn_blocking(move || get_todos(&sid)).await;

    match result {
        Err(join) => Json(serde_json::json!({ "error": format!("Join error: {}", join) })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": format!("DB error: {}", err) })),
        Ok(Ok(all)) => {
            // Apply the same is_ready() predicate as the tool itself.
            let ready: Vec<serde_json::Value> = all
                .iter()
                .enumerate()
                .filter(|(_, r)| {
                    r.status == "pending"
                        && r.blocked_by.iter().all(|&idx| {
                            all.get(idx)
                                .map(|b| b.status == "completed" || b.status == "cancelled")
                                .unwrap_or(true)
                        })
                })
                .map(|(idx, todo)| {
                    let mut obj = serde_json::json!({
                        "index": idx,
                        "content": todo.content,
                        "status": todo.status,
                    });
                    if !todo.blocked_by.is_empty() {
                        obj["blockedBy"] = serde_json::json!(todo.blocked_by);
                    }
                    obj
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "session_id": session_id,
                "ready_count": ready.len(),
                "total_count": all.len(),
                "ready": ready,
            }))
        }
    }
}

// ============================================
// Dev-only: SDE resume/orphan seeding endpoints
// ============================================

/// Seed an SDE session history with an orphan `tool_use` tail so the
/// `filter_unresolved_tool_uses` path on the next user-initiated resume has
/// something real to strip. The caller is expected to have already created
/// the session (e.g. via a prior `test_sde_message` call with
/// `no_cleanup=true`). We only append messages here; we do not touch the
/// `agent_sessions` row.
///
/// Body:
/// ```json
/// {
///   "session_id": "test:e2e-orphan-123",
///   "user_text": "do something",
///   "assistant_text": "sure",
///   "tool_call_id": "tc_orphan_001",
///   "tool_name": "read_file",
///   "tool_args": "{\"path\": \"/tmp/x\"}"
/// }
/// ```
///
/// `user_text`, `assistant_text`, `tool_args` are optional; all other fields
/// are required. The orphan is a single assistant row with a `tool_call` but
/// **no** matching `tool_result` — which is exactly the shape
/// `filter_unresolved_tool_uses` hunts for.
pub async fn test_sde_seed_orphan(Json(body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let obj = match body.as_object() {
        Some(o) => o,
        None => {
            return Json(serde_json::json!({
                "error": "body must be an object",
            }));
        }
    };

    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "error": "session_id is required and must be a non-empty string",
            }));
        }
    };

    let tool_call_id = match obj.get("tool_call_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "error": "tool_call_id is required and must be a non-empty string",
            }));
        }
    };

    let tool_name = match obj.get("tool_name").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "error": "tool_name is required and must be a non-empty string",
            }));
        }
    };

    let user_text = obj
        .get("user_text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let assistant_text = obj
        .get("assistant_text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_args = obj
        .get("tool_args")
        .and_then(|v| v.as_str())
        .unwrap_or("{}")
        .to_string();

    let sid_for_blocking = session_id.clone();
    let tcid_for_blocking = tool_call_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        use agent_core::core::session::persistence as persist;

        if let Some(user) = user_text {
            persist::save_user_msg(&sid_for_blocking, &user, None)
                .map_err(|e| format!("save_user_msg: {}", e))?;
        }
        persist::save_assistant_msg(&sid_for_blocking, &assistant_text, "")
            .map_err(|e| format!("save_assistant_msg: {}", e))?;
        persist::save_tool_call_msg(
            &sid_for_blocking,
            &tcid_for_blocking,
            &tool_name,
            &tool_args,
        )
        .map_err(|e| format!("save_tool_call_msg: {}", e))?;
        Ok(())
    })
    .await;

    match result {
        Err(join) => Json(serde_json::json!({
            "error": format!("join error: {}", join),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Ok(Ok(())) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "tool_call_id": tool_call_id,
        })),
    }
}

/// Read the persisted LLM-formatted transcript for a session — exactly the
/// shape `filter_unresolved_tool_uses` operates on (OpenAI-compat: assistant
/// messages carry `tool_calls`, tool results are separate `role: "tool"`
/// rows). Used by the resume-* E2E scenarios to assert orphans were removed
/// (or preserved, in the negative cases).
pub async fn test_sde_transcript_get(
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let sid = session_id.clone();
    let history = tokio::task::spawn_blocking(move || {
        agent_core::core::session::persistence::load_llm_history(&sid)
    })
    .await;

    match history {
        Err(join) => Json(serde_json::json!({
            "ok": false,
            "error": format!("join error: {}", join),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "error": format!("load_llm_history failed: {}", err),
        })),
        Ok(Ok(entries)) => {
            let tool_call_ids: Vec<String> = entries
                .iter()
                .filter_map(|m| m.get("tool_calls").and_then(|v| v.as_array()))
                .flatten()
                .filter_map(|tc| tc.get("id").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect();

            let tool_result_ids: Vec<String> = entries
                .iter()
                .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
                .filter_map(|m| m.get("tool_call_id").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect();

            let orphan_tool_call_ids: Vec<&String> = tool_call_ids
                .iter()
                .filter(|id| !tool_result_ids.contains(id))
                .collect();

            Json(serde_json::json!({
                "ok": true,
                "session_id": session_id,
                "count": entries.len(),
                "messages": entries,
                "tool_call_ids": tool_call_ids,
                "tool_result_ids": tool_result_ids,
                "orphan_tool_call_ids": orphan_tool_call_ids,
            }))
        }
    }
}
