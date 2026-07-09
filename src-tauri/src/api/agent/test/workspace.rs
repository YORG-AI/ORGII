//! `/agent/test/session/workspace/*` and `/agent/test/session/prompt/*`
//! endpoints (debug-only).
//!
//! Three workspace-mutator probes mirror the Tauri commands so E2E can
//! drive them without going through the frontend. Bodies use manual
//! `serde_json::Value` parsing for null-vs-missing — `path` is
//! always required (string), `source` is optional (missing or `null` →
//! server default of `"session"`, matching `DirectorySource::Default`).
//!
//! `session_launch_seed_only`, `workspace_list_from_db`, and
//! `session_prompt_environment_block` round out the suite (seed-only
//! launch, DB reread, prompt-environment block extraction).
//!
//! Wire-validation probe pairs (Wiring Checklist Rule 16):
//!
//! | helper-only probe                       | caller-path counterpart                       |
//! | --------------------------------------- | --------------------------------------------- |
//! | `/session/parse-exec-mode`              | `/session/resolve-exec-mode-from-wire`        |
//! | `/session/parse-status`                 | `/session/update-status-via-cmd`              |
//! | `/session/aggregate-list-filter`        | `/session/aggregate-list-via-cmd`             |
//!
//! The helper probes pin the parser / aggregator contract in isolation;
//! the caller-path probes drive the same code the production Tauri
//! command runs (`resolve_agent_mode` for `agent_send_message`, the
//! parse-then-`update_status` sequence for `agent_update_session_status`,
//! and the `spawn_blocking(list_all_sessions(...))` shape used by
//! `session_aggregate_list`). A regression where a future refactor stops
//! calling the helper from the production command would surface in the
//! caller-path probe even if the helper-only probe still passes.

#![cfg(debug_assertions)]

use axum::Json;

//
// Three endpoints expose the same logic the Tauri commands wrap, so
// E2E can drive them without going through the frontend. Request
// bodies use manual `serde_json::Value` parsing per null-vs-missing — `path`
// is always required (string), `source` is optional (missing or
// `null` → server default of `"session"`, matching
// `DirectorySource::Default`).

pub async fn test_session_workspace_add_directory(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };
    let path = match obj.get("path").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => std::path::PathBuf::from(s),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "path is required (non-empty string)"
            }))
        }
    };
    // Patch-semantics: `source` absent OR explicit `null` → server default.
    let source = match obj.get("source") {
        None => agent_core::session::workspace::DirectorySource::default(),
        Some(v) if v.is_null() => agent_core::session::workspace::DirectorySource::default(),
        Some(v) => match serde_json::from_value::<agent_core::session::workspace::DirectorySource>(
            v.clone(),
        ) {
            Ok(s) => s,
            Err(err) => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!(
                        "source must be one of \"session\"|\"ideWorkspace\"|\"localSettings\"|\"userSettings\"|\"cliArg\": {err}"
                    ),
                }));
            }
        },
    };

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();
    match agent_core::state::commands::session::workspace_add_directory(
        &state,
        &session_id,
        path,
        source,
    )
    .await
    {
        Ok(inserted) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "inserted": inserted,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": err,
        })),
    }
}

pub async fn test_session_workspace_remove_directory(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };
    let path = match obj.get("path").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => std::path::PathBuf::from(s),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "path is required (non-empty string)"
            }))
        }
    };

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();
    match agent_core::state::commands::session::workspace_remove_directory(
        &state,
        &session_id,
        path.as_path(),
    )
    .await
    {
        Ok(removed) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "removed": removed,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": err,
        })),
    }
}

pub async fn test_session_workspace_list(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
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
    match agent_core::state::commands::session::workspace_list(&state, &session_id).await {
        Ok(view) => Json(serde_json::json!({
            "ok": true,
            "workspace": view,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": err,
        })),
    }
}

/// Launch-time seeding caller-path: drive `session_launch_impl` with
/// `additional_directories` populated and `content = ""` so the
/// persist-workspace step runs without the `send_message` path kicking
/// off an LLM turn. Verifies that the launch-time seeding path
/// correctly mirrors IDE multi-root folders into
/// `agent_sessions.workspace_additional_json`. The paired
/// `/test/session/workspace/list-from-db` endpoint is the reader.
///
/// Body: `{workspace_path: string, additional_directories: string[],
///         session_id_hint?: string, agent_definition_id?: string}`.
pub async fn test_session_launch_seed_only(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let workspace_path = match obj.get("workspace_path").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "workspace_path is required (non-empty string)"
            }))
        }
    };
    let additional_directories: Vec<String> = match obj.get("additional_directories") {
        None => Vec::new(),
        Some(v) if v.is_null() => Vec::new(),
        Some(v) => match v.as_array() {
            Some(arr) => arr
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            None => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "additional_directories must be an array of strings"
                }));
            }
        },
    };
    let name_hint = obj
        .get("session_id_hint")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let agent_definition_id = obj
        .get("agent_definition_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
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
    let mode = obj
        .get("agent_exec_mode")
        .or_else(|| obj.get("mode"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let initialize_runtime = obj
        .get("initialize_runtime")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let Some(handle) = crate::api::get_app_handle() else {
        return Json(serde_json::json!({ "ok": false, "error": "AppHandle not initialized." }));
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    let params = agent_core::state::commands::session::launch::SessionLaunchParams {
        category: agent_core::state::commands::session::launch::SESSION_CATEGORY_RUST_AGENT
            .to_string(),
        content: String::new(),
        workspace_path: Some(workspace_path.clone()),
        key_source: None,
        account_id: account_id.clone(),
        model: model.clone(),
        native_harness_type: native_harness_type.clone(),
        platform: None,
        branch: None,
        hosted_token: None,
        tier: None,
        name: name_hint,
        background: false,
        images: None,
        ide_context: None,
        agent_definition_id,
        agent_org_id: None,
        agent_org_member_overrides: std::collections::HashMap::new(),
        apply_agent_org_member_overrides_for_future: false,
        isolate: false,
        mode,
        org_id: None,
        project_id: None,
        project_name: None,
        work_item_id: None,
        agent_role: None,
        worktree_path: None,
        project_slug: None,
        parent_session_id: None,
        additional_directories,
    };

    match agent_core::state::commands::session::launch::session_launch_impl(&state, None, params)
        .await
    {
        Ok(result) => {
            if initialize_runtime {
                let native_harness_type = match native_harness_type.as_deref() {
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
                        &result.session_id,
                        std::path::PathBuf::from(&workspace_path),
                        account_id.clone(),
                        model.clone(),
                        native_harness_type,
                    )
                    .await
                    {
                        Ok(spec) => spec,
                        Err(err) => {
                            return Json(serde_json::json!({
                                "ok": false,
                                "error": format!("Failed to build launch spec: {}", err),
                            }));
                        }
                    };
                if let Err(err) = agent_core::init::init_session(&state, launch_spec).await {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("Failed to initialize runtime: {}", err),
                    }));
                }
            }
            Json(serde_json::json!({
                "ok": true,
                "session_id": result.session_id,
                "workspace_path": result.workspace_path,
                "runtime_initialized": initialize_runtime,
            }))
        }
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "error": err,
        })),
    }
}

/// Companion to `launch-seed-only`: reads the persisted
/// workspace snapshot directly from the SQLite row via
/// `load_workspace`, bypassing the `SessionRuntime` cache. This lets
/// the seed-only scenario assert on what actually hit disk without
/// first booting a runtime (which would require a real send_message
/// call and burn LLM credits).
pub async fn test_session_workspace_list_from_db(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "session_id is required (non-empty string)"
            }))
        }
    };

    let sid_for_blocking = session_id.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        agent_core::session::persistence::load_workspace(&sid_for_blocking)
            .map_err(|err| err.to_string())
    })
    .await;

    match loaded {
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": format!("spawn_blocking join error: {join_err}"),
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": err,
        })),
        Ok(Ok(None)) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "workspace": serde_json::Value::Null,
        })),
        Ok(Ok(Some(workspace))) => {
            let additional: Vec<serde_json::Value> = workspace
                .additional_directories
                .values()
                .map(|entry| {
                    serde_json::json!({
                        "path": entry.path.to_string_lossy(),
                        "source": entry.source,
                    })
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "session_id": session_id,
                "workspace": {
                    "workspaceRoot": workspace.workspace_root.to_string_lossy(),
                    "workingDir": workspace.working_dir.to_string_lossy(),
                    "additionalDirectories": additional,
                },
            }))
        }
    }
}

/// Render the SDE/OS system prompt for a live
/// session and return only its `## Environment` block so E2E can
/// assert that `add_workspace_directory` mutations surface the
/// next time the prompt is built. caller-path coverage ( coverage):
/// we intentionally invoke the same `UnifiedPromptBuilder` that
/// the processor uses, reading the live
/// `SessionRuntime.workspace_state` handle just like
/// `build_system_prompt` does — isolating the helper alone
/// wouldn't prove the hot-read wiring is intact.
pub async fn test_session_prompt_environment_block(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let Some(obj) = body.as_object() else {
        return Json(serde_json::json!({ "ok": false, "error": "body must be an object" }));
    };
    let session_id = match obj.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
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

    let Some(session) = state.get_session(&session_id).await else {
        return Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "error": "session not found",
        }));
    };
    let runtime = match session.runtime.read().await.clone() {
        Some(r) => r,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "session_id": session_id,
                "error": "session runtime not initialized",
            }))
        }
    };

    // Read the live workspace snapshot — same path the processor
    // takes in `build_system_prompt`. We only care about the
    // `## Environment` block, so everything else is minimal.
    let live_workspace = Some(runtime.workspace_state.read().clone());
    let prompt_config = agent_core::core::session::SystemPromptConfig {
        model: runtime.model.clone(),
        agent_definition_id: runtime.agent_definition_id.clone(),
        agent_soul: runtime.agent_soul.clone(),
        workspace: live_workspace,
        sovereign_prompt: runtime.sovereign_prompt,
        ..agent_core::core::session::SystemPromptConfig::default()
    };

    let full_prompt = agent_core::core::session::prompt::builder::build_unified_system_prompt(
        &session_id,
        &[],
        &prompt_config,
    );

    // Slice out the `## Environment` block so E2E assertions stay
    // narrow — the rest of the prompt (rules, skills, learnings) is
    // noise for this test. Matches the header emitted by both
    // `build_project_environment` and `build_channel_environment`.
    let environment = extract_section(&full_prompt, "## Environment");

    Json(serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "environment": environment,
        "full_length": full_prompt.len(),
    }))
}

/// Extract a Markdown `## Header` section up to the next `## `
/// header (exclusive) or the end of the string. Used by
/// `test_session_prompt_environment_block` to keep E2E assertions
/// focused on the `## Environment` block.
fn extract_section(prompt: &str, header: &str) -> Option<String> {
    let start = prompt.find(header)?;
    let rest = &prompt[start..];
    let after_header = &rest[header.len()..];
    let end = after_header.find("\n## ");
    Some(match end {
        Some(offset) => rest[..header.len() + offset].to_string(),
        None => rest.to_string(),
    })
}

/// `POST /agent/test/session/aggregate-list-filter` — **symbol-pinning
/// probe** for the `list_all_sessions` filter validation. Body shape:
///
/// ```json
/// { "key_source": "hosted_key" }   // accepted, returns ok=true
/// { "key_source": "market" }       // typo, returns ok=false + reason
/// {}                               // no filter, returns ok=true
/// ```
///
/// We deliberately do not hit the wider Tauri command surface
/// (`session_aggregate_list`) because that runs `spawn_blocking` against
/// the live SQLite connection; the E2E runner just needs to confirm the
/// validation branch fires, so we call the synchronous aggregator
/// directly and propagate its `Err` payload verbatim.
pub async fn test_session_aggregate_list_filter(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let key_source = body
        .get("key_source")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let filter = crate::agent_sessions::unified_stats::types::SessionFilter {
        key_source: key_source.clone(),
        // Cap the result set so this probe never returns megabytes of
        // session rows from a developer's local DB.
        limit: Some(1),
        ..Default::default()
    };

    let result = tokio::task::spawn_blocking(move || {
        crate::agent_sessions::unified_stats::aggregation::list_all_sessions(Some(&filter))
    })
    .await;

    match result {
        Ok(Ok(_response)) => Json(serde_json::json!({
            "ok": true,
            "key_source_filter": key_source,
        })),
        Ok(Err(reason)) => Json(serde_json::json!({
            "ok": false,
            "key_source_filter": key_source,
            "reason": reason,
        })),
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "key_source_filter": key_source,
            "reason": format!("spawn_blocking join error: {join_err}"),
        })),
    }
}

/// `POST /agent/test/session/seed-compacted-history` — seed a session with an
/// old transcript, then compact it through the production append-only
/// compact-boundary helper. E2E uses this to prove restarts read the durable
/// compacted view instead of old full history.
pub async fn test_session_seed_compacted_history(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let session_id = body
        .get("session_id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.trim().is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "reason": "session_id is required",
        }));
    }
    let old_marker = body
        .get("old_marker")
        .and_then(|value| value.as_str())
        .unwrap_or("E2E_OLD_FULL_HISTORY_MARKER")
        .to_string();
    let summary = body
        .get("summary")
        .and_then(|value| value.as_str())
        .unwrap_or("E2E compacted old history")
        .to_string();
    let recent_user = body
        .get("recent_user")
        .and_then(|value| value.as_str())
        .unwrap_or("recent user")
        .to_string();
    let recent_assistant = body
        .get("recent_assistant")
        .and_then(|value| value.as_str())
        .unwrap_or("recent assistant")
        .to_string();

    let result = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || -> Result<(), String> {
            agent_core::session::persistence::save_user_msg(&sid, &old_marker, None)
                .map_err(|err| err.to_string())?;
            agent_core::session::persistence::save_assistant_msg(
                &sid,
                &format!("assistant saw {old_marker}"),
                "e2e",
            )
            .map_err(|err| err.to_string())?;
            agent_core::session::persistence::save_session_memory_state(&sid, "stale sm", Some(99))
                .map_err(|err| err.to_string())?;
            // Append the surviving tail, then a compact boundary pointing at
            // the tail's first row — the production append-only equivalent of
            // the old destructive replace.
            let recent_user_id =
                agent_core::session::persistence::save_user_msg(&sid, &recent_user, None)
                    .map_err(|err| err.to_string())?;
            agent_core::session::persistence::save_assistant_msg(&sid, &recent_assistant, "e2e")
                .map_err(|err| err.to_string())?;
            let anchor = agent_core::session::persistence::message_anchor(&sid, &recent_user_id)
                .map_err(|err| err.to_string())?
                .ok_or_else(|| format!("anchor row {recent_user_id} not found"))?;
            agent_core::session::persistence::append_compact_boundary(
                &sid,
                &format!("[Conversation summary — 2 earlier messages compacted]\n\n{summary}"),
                anchor.sequence,
                None,
                None,
            )
            .map_err(|err| err.to_string())?;
            agent_core::session::persistence::clear_session_memory_state(&sid)
                .map_err(|err| err.to_string())?;
            Ok(())
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({
            "ok": true,
            "sessionId": session_id,
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": err,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": format!("spawn_blocking join error: {err}"),
        })),
    }
}

/// `POST /agent/test/session/parse-exec-mode` — **symbol-pinning probe**
/// for `AgentExecMode::parse`. Body shape:
///
/// ```json
/// { "mode": "plan" }     // accepted → ok=true,  parsed="plan"
/// { "mode": "plann" }    // typo     → ok=false, reason=...
/// { "mode": "" }         // empty    → ok=false, reason=...
/// ```
///
/// The hardened `agent_send_message` command rejects the same typos via
/// the same parser, so this probe lets E2E confirm the wire-format
/// contract without spinning up a full session turn (which would also
/// hit the real LLM).
/// `POST /agent/test/session/llm-history` — debug-only projection of the
/// exact durable history returned by Rust agent `load_llm_history`.
pub async fn test_session_llm_history(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let session_id = body
        .get("session_id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.trim().is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "reason": "session_id is required",
        }));
    }

    let result = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || agent_core::session::persistence::load_llm_history(&sid)
    })
    .await;

    match result {
        Ok(Ok(messages)) => {
            let roles: Vec<_> = messages
                .iter()
                .map(|message| {
                    message
                        .get("role")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                })
                .collect();
            let compact_boundary_count = messages
                .iter()
                .filter(|message| {
                    let content = message
                        .get("content")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    message.get("role").and_then(|value| value.as_str()) == Some("system")
                        && (content.starts_with("[Conversation summary —")
                            || content.starts_with("[Session Memory —"))
                })
                .count();
            Json(serde_json::json!({
                "ok": true,
                "sessionId": session_id,
                "messageCount": messages.len(),
                "roles": roles,
                "compactBoundaryCount": compact_boundary_count,
                "messages": messages,
            }))
        }
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": err.to_string(),
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": format!("spawn_blocking join error: {err}"),
        })),
    }
}

/// `POST /agent/test/session/seed-raw-history` — seed un-compacted
/// user/assistant rows so E2E can trigger auto-compaction through the real turn.
pub async fn test_session_seed_raw_history(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let session_id = body
        .get("session_id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.trim().is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "reason": "session_id is required",
        }));
    }

    let marker = body
        .get("marker")
        .and_then(|value| value.as_str())
        .unwrap_or("E2E_RAW_HISTORY_MARKER")
        .to_string();
    let message_count = body
        .get("message_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(12)
        .clamp(2, 200) as usize;
    let chars_per_message = body
        .get("chars_per_message")
        .and_then(|value| value.as_u64())
        .unwrap_or(2_000)
        .clamp(16, 20_000) as usize;
    let marker_message_count = body
        .get("marker_message_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(message_count as u64)
        .min(message_count as u64) as usize;
    let filler = "x".repeat(chars_per_message);

    let result = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || -> Result<(), String> {
            for index in 0..message_count {
                let prefix = if index < marker_message_count {
                    format!("{marker} ")
                } else {
                    String::new()
                };
                if index % 2 == 0 {
                    agent_core::session::persistence::save_user_msg(
                        &sid,
                        &format!("{prefix}user {index}: {filler}"),
                        None,
                    )
                    .map_err(|err| err.to_string())?;
                } else {
                    agent_core::session::persistence::save_assistant_msg(
                        &sid,
                        &format!("{prefix}assistant {index}: {filler}"),
                        "e2e",
                    )
                    .map_err(|err| err.to_string())?;
                }
            }
            Ok(())
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({
            "ok": true,
            "sessionId": session_id,
            "messageCount": message_count,
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": err,
        })),
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "sessionId": session_id,
            "reason": format!("spawn_blocking join error: {err}"),
        })),
    }
}

/// `POST /agent/test/session/provider-request-capture` — debug-only capture
/// of the final provider-bound request payload built by `turn_executor`.
pub async fn test_session_provider_request_capture(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let action = body
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or("drain");

    match action {
        "arm" => {
            let clear = body
                .get("clear")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            agent_core::turn_executor::provider_request_capture::arm(clear);
            Json(serde_json::json!({
                "ok": true,
                "armed": agent_core::turn_executor::provider_request_capture::is_armed(),
                "captures": [],
            }))
        }
        "disarm" => {
            agent_core::turn_executor::provider_request_capture::disarm();
            Json(serde_json::json!({
                "ok": true,
                "armed": false,
                "captures": [],
            }))
        }
        "clear" => {
            agent_core::turn_executor::provider_request_capture::clear();
            Json(serde_json::json!({
                "ok": true,
                "armed": agent_core::turn_executor::provider_request_capture::is_armed(),
                "captures": [],
            }))
        }
        "drain" => {
            let clear = body
                .get("clear")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            let disarm = body
                .get("disarm")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let captures = agent_core::turn_executor::provider_request_capture::drain(clear);
            if disarm {
                agent_core::turn_executor::provider_request_capture::disarm();
            }
            Json(serde_json::json!({
                "ok": true,
                "armed": agent_core::turn_executor::provider_request_capture::is_armed(),
                "captures": captures,
            }))
        }
        other => Json(serde_json::json!({
            "ok": false,
            "reason": format!("unknown provider-request-capture action: {other}"),
            "captures": [],
        })),
    }
}

pub async fn test_parse_exec_mode(Json(body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match agent_core::session::AgentExecMode::parse(&mode) {
        Some(parsed) => Json(serde_json::json!({
            "ok": true,
            "input": mode,
            "parsed": parsed.as_str(),
        })),
        None => Json(serde_json::json!({
            "ok": false,
            "input": mode,
            "reason": format!("Unknown agent exec mode: {mode:?}"),
        })),
    }
}

/// `POST /agent/test/session/parse-status` — **symbol-pinning probe**
/// for `SessionStatus::parse`. Same fail-closed contract as the
/// exec-mode probe above, but covers the second hardened parser:
/// `agent_update_session_status` now rejects unknown wire status
/// strings instead of silently downgrading them to `Idle`. Pins
/// helper behavior, not the production caller path; for the caller
/// path see `test_session_update_status_via_cmd`.
pub async fn test_parse_session_status(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match agent_core::session::SessionStatus::parse(&status) {
        Some(parsed) => Json(serde_json::json!({
            "ok": true,
            "input": status,
            "parsed": parsed.as_str(),
        })),
        None => Json(serde_json::json!({
            "ok": false,
            "input": status,
            "reason": format!("Unknown session status: {status:?}"),
        })),
    }
}

// ═══════════════════════════════════════════════════════════════
// Caller-path probes — paired with the helper-only probes above.
//
// Each probe drives the same code the production Tauri command runs,
// so a refactor that stops calling the helper from the command would
// surface here even if the helper-only probe still passes (Wiring
// Checklist Rule 16).
// ═══════════════════════════════════════════════════════════════

/// `POST /agent/test/session/resolve-exec-mode-from-wire` — **caller-path
/// probe** for the exec-mode wire contract used by `agent_send_message`.
///
/// Drives `state::commands::session::message::resolve_agent_mode`, the
/// helper that `send_message_impl` calls before dispatching the turn.
/// This covers two contract bits the helper-only `parse-exec-mode`
/// probe cannot:
///
/// 1. The `None` / empty-string arm resolves to `Build` (the wake-flow
///    invariant pinned by `resolve_agent_mode_tests::wake_defaults_to_build`).
/// 2. The error message shape passed back to the frontend on a typo
///    (`Unknown agent exec mode: …`) — a refactor that swallowed the
///    error or re-mapped it to `Build` would silently break Plan-mode
///    enforcement.
///
/// Body shape:
///
/// ```json
/// { "mode": "plan" }   // ok=true, parsed="plan"
/// { "mode": null }     // ok=true, parsed="build"  (wake-flow default)
/// { "mode": "" }       // ok=true, parsed="build"  (whitespace-only too)
/// { "mode": "plann" }  // ok=false, reason="Unknown agent exec mode: …"
/// {}                   // ok=true, parsed="build"  (field omitted)
/// ```
pub async fn test_resolve_exec_mode_from_wire(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    // Distinguish "field absent" from "field present but JSON null /
    // empty string". The production wire serde maps both to
    // `mode: Option<String> = None`, so we mirror that here.
    let mode_opt: Option<String> = match body.get("mode") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(other) => {
            return Json(serde_json::json!({
                "ok": false,
                "reason": format!("`mode` must be string or null, got: {other}"),
            }));
        }
    };

    match agent_core::state::commands::session::message::resolve_agent_mode(mode_opt.as_deref()) {
        Ok(parsed) => Json(serde_json::json!({
            "ok": true,
            "input": mode_opt,
            "parsed": parsed.as_str(),
        })),
        Err(reason) => Json(serde_json::json!({
            "ok": false,
            "input": mode_opt,
            "reason": reason,
        })),
    }
}

/// `POST /agent/test/session/update-status-via-cmd` — **caller-path
/// probe** for the wire contract enforced by
/// `agent_update_session_status`.
///
/// Mirrors the command body verbatim (`SessionStatus::parse` →
/// `update_status`), so a refactor that drops the parse step (or
/// silently maps unknown status strings to `Idle`) is observable from
/// E2E even when the helper-only `parse-status` probe still passes.
///
/// Body shape:
///
/// ```json
/// { "session_id": "sde-abc", "status": "running" }   // ok=true, updated=<bool>
/// { "session_id": "sde-abc", "status": "fooblort" }  // ok=false, reason=...
/// ```
///
/// `updated` mirrors the `bool` returned by the command (true if the
/// row existed and was updated, false otherwise). The probe never
/// inserts a session row itself — passing a non-existent `session_id`
/// is an accepted way for E2E to assert the command's reject-typo
/// branch without polluting the sessions table.
pub async fn test_session_update_status_via_cmd(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let session_id = match body.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "reason": "session_id is required (non-empty string)",
            }))
        }
    };
    let status_input = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let parsed = match agent_core::session::SessionStatus::parse(&status_input) {
        Some(p) => p,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "input": status_input,
                "reason": format!("Unknown session status: {status_input:?}"),
            }));
        }
    };

    let session_id_for_blocking = session_id.clone();
    let join = tokio::task::spawn_blocking(move || {
        agent_core::session::persistence::update_status(&session_id_for_blocking, parsed)
    })
    .await;

    match join {
        Ok(Ok(updated)) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "input": status_input,
            "parsed": parsed.as_str(),
            "updated": updated,
        })),
        Ok(Err(err)) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "input": status_input,
            "reason": format!("update_status failed: {err}"),
        })),
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "session_id": session_id,
            "input": status_input,
            "reason": format!("spawn_blocking join error: {join_err}"),
        })),
    }
}

/// `POST /agent/test/session/aggregate-list-via-cmd` — **caller-path
/// probe** for `session_aggregate_list`.
///
/// Mirrors the command body (`spawn_blocking(list_all_sessions(filter))`)
/// rather than calling the aggregator inline. This catches a regression
/// where the command's `spawn_blocking` wrapper drops the filter, panics
/// on the join, or otherwise breaks the wire-format contract — none of
/// which the helper-only `aggregate-list-filter` probe would notice.
///
/// Body shape mirrors `SessionFilter` deserialization (all fields
/// optional). Response wraps the bool the command returns: `ok=true`
/// when the command path succeeds (regardless of how many sessions
/// matched), `ok=false` with `reason` when the filter validation rejects
/// or the join task panics.
pub async fn test_session_aggregate_list_via_cmd(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    use crate::agent_sessions::unified_stats::types::SessionFilter;

    // The production command takes `Option<SessionFilter>` deserialized
    // from a JSON object; an empty `{}` body should resolve to `None`
    // so the e2e harness can probe both shapes from one endpoint.
    let target_session_id = body
        .get("session_id")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let mut filter_body = body.clone();
    if let Some(object) = filter_body.as_object_mut() {
        object.remove("session_id");
    }

    let filter: Option<SessionFilter> = if filter_body
        .as_object()
        .map(|o| o.is_empty())
        .unwrap_or(true)
    {
        None
    } else {
        match serde_json::from_value::<SessionFilter>(filter_body.clone()) {
            Ok(mut f) => {
                // Cap the result set so this probe never returns megabytes
                // of session rows from a developer's local DB.
                if f.limit.is_none() {
                    f.limit = Some(1);
                }
                Some(f)
            }
            Err(err) => {
                return Json(serde_json::json!({
                    "ok": false,
                    "reason": format!("filter deserialization failed: {err}"),
                }));
            }
        }
    };

    let join = tokio::task::spawn_blocking(move || {
        crate::agent_sessions::unified_stats::aggregation::list_all_sessions(filter.as_ref())
    })
    .await;

    match join {
        Ok(Ok(response)) => {
            let target_session = target_session_id.as_deref().and_then(|session_id| {
                response
                    .sessions
                    .iter()
                    .find(|session| session.session_id == session_id)
                    .cloned()
            });
            Json(serde_json::json!({
                "ok": true,
                "session_count": response.sessions.len(),
                "target_session": target_session,
                "sessions": if target_session_id.is_some() {
                    Vec::<crate::agent_sessions::unified_stats::types::SessionAggregateRecord>::new()
                } else {
                    response.sessions
                },
            }))
        }
        Ok(Err(reason)) => Json(serde_json::json!({
            "ok": false,
            "reason": reason,
        })),
        Err(join_err) => Json(serde_json::json!({
            "ok": false,
            "reason": format!("spawn_blocking join error: {join_err}"),
        })),
    }
}
