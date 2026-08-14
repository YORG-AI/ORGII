//! Shared HTTP helpers for the E2E runner: health probe, OS/SDE test message clients,
//! mode-switch polling, session cleanup, and console reporting (`print_result` / `print_error`).
//!
//! Endpoints are defined on the Tauri side under `#[cfg(debug_assertions)]` test routes;
//! this module only performs `reqwest` calls and shapes assertions for scenario code in
//! `os`, `sde`, and `stress`.

use super::config::Config;

fn http_client(cfg: &Config) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .build()
        .expect("failed to build HTTP client")
}

async fn read_json_response(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|err| format!("HTTP response read error: {err}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|err| format!("JSON parse error: {err}; body={text}"))
}

/// Pre-flight connectivity check against the running Tauri app.
pub async fn check_connectivity(cfg: &Config) -> Result<(), String> {
    let url = format!("{}/agent/health", cfg.base_url);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| {
            format!(
                "Cannot reach {}. Is the Tauri app running? Error: {}",
                url, err
            )
        })?;

    if !resp.status().is_success() {
        return Err(format!("Health check returned status {}", resp.status()));
    }
    Ok(())
}

/// Response from an OS Agent test message.
pub struct OsMessageResponse {
    pub content: String,
}

#[derive(Debug, Default, Clone)]
pub struct OsMessageOpts<'a> {
    pub model_override: Option<&'a str>,
    pub account_id_override: Option<&'a str>,
    pub native_harness_type: Option<&'a str>,
}

/// Send a message to OS Agent via HTTP.
/// Returns content and the list of tool names invoked during the turn.
pub async fn send_os_message(
    cfg: &Config,
    content: &str,
    session_id: &str,
) -> Result<OsMessageResponse, String> {
    send_os_message_with_opts(cfg, content, session_id, &OsMessageOpts::default()).await
}

pub async fn send_os_message_with_opts(
    cfg: &Config,
    content: &str,
    session_id: &str,
    opts: &OsMessageOpts<'_>,
) -> Result<OsMessageResponse, String> {
    let url = format!("{}/agent/test/message", cfg.base_url);
    let model = opts.model_override.unwrap_or(cfg.model.as_str());
    let account_id = opts.account_id_override.unwrap_or(cfg.account_id.as_str());
    let mut body = serde_json::json!({
        "content": content,
        "session_id": session_id,
        "model": model,
        "account_id": account_id,
    });
    if let Some(native_harness_type) = opts.native_harness_type {
        body["native_harness_type"] = serde_json::Value::String(native_harness_type.to_string());
    }

    let resp = http_client(cfg)
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let content_str = json
        .get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Response missing 'content' field".to_string())?;

    Ok(OsMessageResponse {
        content: content_str,
    })
}

/// Response from an SDE Agent test message, including the tool call trace
/// and optional metadata exposed by the extended test endpoint.
pub struct SdeMessageResponse {
    pub content: String,
    pub tool_calls: Vec<String>,
    /// Tool calls paired with their `tool_call_id`, in emission order.
    /// Populated from `/agent/test/sde`'s `tool_calls_with_id` array. Use
    /// `last_tool_call_id(name)` to fetch the id for a specific tool —
    /// required by plan-approval scenarios that need to prove the
    /// pending snapshot is keyed on the same id the parent session
    /// emitted.
    pub tool_calls_with_id: Vec<(String, String)>,
    pub tool_calls_count: Option<u32>,
    pub total_tokens: Option<i64>,
}

impl SdeMessageResponse {
    /// Return the `tool_call_id` of the most recent call with this
    /// `tool_name`, or `None` if the turn never invoked it.
    pub fn last_tool_call_id(&self, tool_name: &str) -> Option<&str> {
        self.tool_calls_with_id
            .iter()
            .rev()
            .find(|(name, _)| name == tool_name)
            .map(|(_, id)| id.as_str())
    }
}

fn parse_tool_calls_with_id(json: &serde_json::Value) -> Vec<(String, String)> {
    json.get("tool_calls_with_id")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let name = entry.get("name").and_then(|v| v.as_str())?.to_string();
                    let id = entry
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    Some((name, id))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_sde_message_response(json: serde_json::Value) -> Result<SdeMessageResponse, String> {
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let content_str = json
        .get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Response missing 'content' field".to_string())?;

    let tool_calls = json
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let tool_calls_count = json
        .get("tool_calls_count")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    let total_tokens = json.get("total_tokens").and_then(|v| v.as_i64());
    let tool_calls_with_id = parse_tool_calls_with_id(&json);
    Ok(SdeMessageResponse {
        content: content_str,
        tool_calls,
        tool_calls_with_id,
        tool_calls_count,
        total_tokens,
    })
}

/// Send a message to SDE Agent via HTTP.
/// Returns content and the list of tool names invoked during the turn.
pub async fn send_sde_message(
    cfg: &Config,
    content: &str,
    session_id: &str,
    mode: &str,
    workspace_path: &str,
    agent_definition_id: Option<&str>,
    no_cleanup: bool,
) -> Result<SdeMessageResponse, String> {
    let url = format!("{}/agent/test/sde", cfg.base_url);
    let mut body = serde_json::json!({
        "content": content,
        "session_id": session_id,
        "model": cfg.model,
        "account_id": cfg.account_id,
        "workspace_path": workspace_path,
        "mode": mode,
        "no_cleanup": no_cleanup,
    });
    if let Some(def_id) = agent_definition_id {
        body["agent_definition_id"] = serde_json::Value::String(def_id.to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Client build error: {}", err))?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json = read_json_response(resp).await?;

    parse_sde_message_response(json)
}

/// Check that a specific tool was used during an SDE turn.
pub fn assert_sde_tool_used(resp: &SdeMessageResponse, tool_name: &str) -> bool {
    resp.tool_calls.iter().any(|t| t == tool_name)
}

/// Optional flags for `send_sde_message_with_opts`.
///
/// Used by memory-layer scenarios (L2 extract_memories, auto_dream) that need
/// to opt into features disabled by default in the test endpoint.
#[derive(Debug, Default, Clone)]
pub struct SdeMessageOpts<'a> {
    pub agent_definition_id: Option<&'a str>,
    pub no_cleanup: bool,
    pub enable_extract_memories: bool,
    pub enable_auto_dream: bool,
    pub model_override: Option<&'a str>,
    pub account_id_override: Option<&'a str>,
    pub native_harness_type: Option<&'a str>,
    pub max_retries: Option<u32>,
    pub base_backoff_ms: Option<u64>,
    pub restrict_tools: Vec<&'a str>,
    /// pre-seed multi-root additional workspace directories
    /// via the SDE test endpoint. Persisted into
    /// `workspace_additional_json` before runtime hydration so the
    /// first turn sees the full workspace.
    pub additional_directories: Vec<String>,
}

/// Patch memory-search flags on a builtin agent definition via
/// `/agent/test/agent-config/set`. `agent_id` defaults to `builtin:sde`
/// server-side when omitted. Returns the post-patch resolved flags so
/// callers can verify the overlay took effect.
pub async fn set_agent_config(
    cfg: &Config,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/agent/test/agent-config/set", cfg.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {err}"))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {err}"))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(json)
}

/// Resolve an agent through the same debug probe used by memory/config E2E
/// scenarios. The response includes selected runtime fields and caller-path
/// turn config projections.
pub async fn resolve_agent(
    cfg: &Config,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/agent/test/resolve-agent", cfg.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {err}"))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {err}"))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(json)
}

/// Drop any builtin overlay for `agent_id`, reverting it to the
/// compiled-in definition. Best-effort — called from test teardowns
/// where the scenario has already finished, so we swallow errors.
pub async fn reset_agent_config(cfg: &Config, agent_id: &str) {
    let url = format!("{}/agent/test/agent-config/reset", cfg.base_url);
    let _ = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "agent_id": agent_id }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
}

/// Send an SDE message with extended options (memory flags, etc.).
pub async fn send_sde_message_with_opts(
    cfg: &Config,
    content: &str,
    session_id: &str,
    mode: &str,
    workspace_path: &str,
    opts: &SdeMessageOpts<'_>,
) -> Result<SdeMessageResponse, String> {
    let url = format!("{}/agent/test/sde", cfg.base_url);
    let model = opts.model_override.unwrap_or(cfg.model.as_str());
    let account_id = opts.account_id_override.unwrap_or(cfg.account_id.as_str());
    let mut body = serde_json::json!({
        "content": content,
        "session_id": session_id,
        "model": model,
        "account_id": account_id,
        "workspace_path": workspace_path,
        "mode": mode,
        "no_cleanup": opts.no_cleanup,
        "enable_extract_memories": opts.enable_extract_memories,
        "enable_auto_dream": opts.enable_auto_dream,
    });
    if let Some(def_id) = opts.agent_definition_id {
        body["agent_definition_id"] = serde_json::Value::String(def_id.to_string());
    }
    if let Some(native_harness_type) = opts.native_harness_type {
        body["native_harness_type"] = serde_json::Value::String(native_harness_type.to_string());
    }
    if let Some(max_retries) = opts.max_retries {
        body["max_retries"] = serde_json::json!(max_retries);
    }
    if let Some(base_backoff_ms) = opts.base_backoff_ms {
        body["base_backoff_ms"] = serde_json::json!(base_backoff_ms);
    }
    if !opts.restrict_tools.is_empty() {
        body["restrict_tools"] = serde_json::json!(opts.restrict_tools);
    }
    if !opts.additional_directories.is_empty() {
        body["additional_directories"] = serde_json::json!(opts.additional_directories);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Client build error: {}", err))?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json = read_json_response(resp).await?;

    parse_sde_message_response(json)
}

/// Check if a mode switch is pending for a session.
pub async fn check_mode_switch_pending(cfg: &Config, session_id: &str) -> Result<bool, String> {
    let url = format!("{}/agent/test/sde/mode-switch/{}", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    Ok(json
        .get("pending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// Respond to a pending mode switch.
pub async fn send_mode_switch_response(
    cfg: &Config,
    session_id: &str,
    choice: &str,
    target_mode: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/agent/test/sde/mode-switch/{}", cfg.base_url, session_id);
    let mut body = serde_json::json!({ "choice": choice });
    if let Some(mode) = target_mode {
        body["target_mode"] = serde_json::Value::String(mode.to_string());
    }

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

/// Clean up an SDE session on the running app.
pub async fn cleanup_sde_session(cfg: &Config, session_id: &str) -> Result<(), String> {
    let url = format!("{}/agent/test/sde/cleanup/{}", cfg.base_url, session_id);

    let _ = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    Ok(())
}

/// Print scenario result with pass/fail checks. Returns overall pass.
pub fn print_result(name: &str, content: &str, checks: &[(&str, bool)]) -> bool {
    println!();
    println!("{}", "=".repeat(70));
    println!("  Scenario: {name}");
    println!("{}", "=".repeat(70));

    let preview: String = content
        .chars()
        .take(300)
        .collect::<String>()
        .replace('\n', " ");
    println!("  Response: {preview}...");

    let mut all_pass = true;
    for (check_name, passed) in checks {
        let status = if *passed { "PASS" } else { "FAIL" };
        println!("  [{status}] {check_name}");
        if !passed {
            all_pass = false;
        }
    }

    let overall = if all_pass { "PASS" } else { "FAIL" };
    println!("  OVERALL: {overall}");
    all_pass
}

/// Response from the tool-schemas debug endpoint.
pub struct ToolSchemasResponse {
    pub tool_count: usize,
    pub tools: Vec<serde_json::Value>,
}

/// Fetch tool schemas for an active session via `/agent/test/tool-schemas/:session_id`.
pub async fn fetch_tool_schemas(
    cfg: &Config,
    session_id: &str,
) -> Result<ToolSchemasResponse, String> {
    let url = format!("{}/agent/test/tool-schemas/{}", cfg.base_url, session_id);

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let tool_count = json.get("tool_count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

    let tools = json
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(ToolSchemasResponse { tool_count, tools })
}

pub struct EffectiveToolsResponse {
    pub agent_exec_mode: String,
    pub registered_tool_names: Vec<String>,
    pub prompt_tool_names: Vec<String>,
    pub prompt_tools: Vec<serde_json::Value>,
}

pub async fn fetch_effective_tools(
    cfg: &Config,
    session_id: &str,
    mode: &str,
) -> Result<EffectiveToolsResponse, String> {
    let url = format!(
        "{}/agent/test/effective-tools/{}?mode={}",
        cfg.base_url, session_id, mode
    );

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let string_vec = |key: &str| {
        json.get(key)
            .and_then(|v| v.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    Ok(EffectiveToolsResponse {
        agent_exec_mode: json
            .get("agentExecMode")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        registered_tool_names: string_vec("registeredToolNames"),
        prompt_tool_names: string_vec("promptToolNames"),
        prompt_tools: json
            .get("promptTools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
    })
}

/// One todo row as returned by `/agent/test/sde/todos/:session_id`.
///
/// Only the fields currently asserted on in scenarios are exposed. Extend
/// when a new scenario needs `content` / `priority` — keeping the struct
/// minimal avoids `dead_code` warnings (no-dead-code check).
pub struct TodoSnapshot {
    pub active_form: Option<String>,
    pub status: String,
    /// Blocker indices parsed from the `blockedBy` JSON array in the response.
    /// Empty vec = no dependencies (or field absent in older rows).
    pub blocked_by: Vec<usize>,
}

/// Response from the todo snapshot debug endpoint.
pub struct TodoSnapshotResponse {
    pub todos: Vec<TodoSnapshot>,
}

/// Response from the `list_ready` debug endpoint
/// (`GET /agent/test/sde/todos/:session_id/ready`).
pub struct ReadyTodosResponse {
    pub ready_count: usize,
    pub total_count: usize,
    /// Indices (0-based) of the ready tasks.
    pub ready_indices: Vec<usize>,
}

/// Fetch the persisted todo list for a session.
///
/// Reads the `agent_todos` SQLite rows directly via the debug endpoint, so we
/// can assert on `manage_todo` persistence outcomes (content + `activeForm`)
/// without relying on the LLM echoing the full list back in chat.
pub async fn fetch_todos(cfg: &Config, session_id: &str) -> Result<TodoSnapshotResponse, String> {
    let url = format!("{}/agent/test/sde/todos/{}", cfg.base_url, session_id);

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let items = json
        .get("todos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let todos = items
        .into_iter()
        .map(|item| {
            let blocked_by = item
                .get("blockedBy")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            TodoSnapshot {
                active_form: item
                    .get("activeForm")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                status: item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                blocked_by,
            }
        })
        .collect();

    Ok(TodoSnapshotResponse { todos })
}

/// Fetch the ready (pending + all blockers completed) todo items for a session.
///
/// Calls `GET /agent/test/sde/todos/:session_id/ready` which applies the same
/// `is_ready()` predicate as the `manage_todo list_ready` action. Used by
/// deterministic DAG E2E scenarios to verify the filter without driving an LLM.
pub async fn fetch_ready_todos(
    cfg: &Config,
    session_id: &str,
) -> Result<ReadyTodosResponse, String> {
    let url = format!("{}/agent/test/sde/todos/{}/ready", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let ready_count = json
        .get("ready_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let total_count = json
        .get("total_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let ready_indices = json
        .get("ready")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.get("index")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as usize)
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(ReadyTodosResponse {
        ready_count,
        total_count,
        ready_indices,
    })
}

/// Snapshot of the per-session `ExtractMemoriesState` returned by
/// `GET /agent/test/em-state/:session_id`.
///
/// This exists to prove cross-turn persistence of the cursor / throttle /
/// overlap guard fields. Before the em_state fix, every turn rebuilt
/// `UnifiedMessageProcessor` with a fresh `Default` state and these fields
/// reset to zero / None every turn; now they live on `AgentSession` and
/// survive across turns.
#[derive(Debug, Clone)]
pub struct EmStateSnapshot {
    pub last_processed_seq: Option<i64>,
    pub in_progress: bool,
    pub turns_since_extraction: u32,
}

/// Fetch the per-session `ExtractMemoriesState` snapshot.
///
/// Returns `Err` if the session is not registered in `AgentAppState`
/// (e.g., the SDE test endpoint with `no_cleanup=false` already tore it
/// down) — callers that care about cross-turn state should use
/// `no_cleanup=true` on all but the last turn.
pub async fn fetch_em_state(cfg: &Config, session_id: &str) -> Result<EmStateSnapshot, String> {
    let url = format!("{}/agent/test/em-state/{}", cfg.base_url, session_id);

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let em = json
        .get("em_state")
        .ok_or_else(|| "response missing em_state field".to_string())?;

    let last_processed_seq = em.get("last_processed_seq").and_then(|v| v.as_i64());
    let in_progress = em
        .get("in_progress")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let turns_since_extraction = em
        .get("turns_since_extraction")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    Ok(EmStateSnapshot {
        last_processed_seq,
        in_progress,
        turns_since_extraction,
    })
}

/// Fetch the last turn summary stored on the session.
///
/// Returns `Ok(Some(text))` if a summary was generated, `Ok(None)` if not
/// yet available, and `Err` if the session does not exist.
pub async fn fetch_turn_summary(cfg: &Config, session_id: &str) -> Result<Option<String>, String> {
    let url = format!("{}/agent/test/turn-summary/{}", cfg.base_url, session_id);

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    Ok(json
        .get("summary")
        .and_then(|v| v.as_str())
        .map(String::from))
}

/// Response from the permission-pending endpoint.
pub struct PermissionPendingResponse {
    pub pending: bool,
    pub request_ids: Vec<String>,
}

/// Poll for pending permission requests on a session.
///
/// Takes `base_url` directly (instead of `&Config`) so it can be called from
/// spawned tasks without needing the full config.
pub async fn check_permission_pending(
    base_url: &str,
    session_id: &str,
) -> Result<PermissionPendingResponse, String> {
    let url = format!("{}/agent/test/sde/permission/{}", base_url, session_id);

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    let pending = json
        .get("pending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let request_ids = json
        .get("request_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(PermissionPendingResponse {
        pending,
        request_ids,
    })
}

/// Respond to a pending permission request.
///
/// Takes `base_url` directly (instead of `&Config`) so it can be called from
/// spawned tasks without needing the full config.
pub async fn send_permission_response(
    base_url: &str,
    session_id: &str,
    request_id: &str,
    response: &str,
    tool_name: Option<&str>,
    tool_args: Option<serde_json::Value>,
) -> Result<bool, String> {
    let url = format!("{}/agent/test/sde/permission/{}", base_url, session_id);

    let mut body = serde_json::json!({
        "request_id": request_id,
        "response": response,
    });
    if let Some(name) = tool_name {
        body["tool_name"] = serde_json::Value::String(name.to_string());
    }
    if let Some(args) = tool_args {
        body["tool_args"] = args;
    }

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
}

/// Snapshot of a pending plan-approval request.
pub struct PlanApprovalPending {
    pub pending: bool,
    pub plan_path: Option<String>,
    pub plan_title: Option<String>,
    pub plan_content: Option<String>,
    pub tool_call_id: Option<String>,
}

/// Poll `/agent/test/sde/plan-approval/:session_id` until a pending
/// approval snapshot is visible, or the deadline elapses. Under the
/// non-blocking flow the snapshot is populated by
/// `PlanApprovalManager::mark_ready(...)` inside `create_plan` — the
/// tool writes the plan file, marks the snapshot ready, and ends the
/// turn early, so callers typically wait for the turn to finish first
/// and *then* call this (a single GET is usually enough, but the poll
/// loop keeps things race-free). Returns a "not pending" snapshot when
/// the deadline fires. Errors only propagate when the HTTP call itself
/// fails.
///
/// Takes `base_url` directly so it can run from a spawned task.
pub async fn wait_for_plan_approval(
    base_url: &str,
    session_id: &str,
    max_wait_secs: u64,
) -> Result<PlanApprovalPending, String> {
    let url = format!("{}/agent/test/sde/plan-approval/{}", base_url, session_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(max_wait_secs);

    loop {
        let resp = reqwest::Client::new()
            .get(&url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|err| format!("HTTP error: {}", err))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|err| format!("JSON parse error: {}", err))?;

        let pending = json
            .get("pending")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if pending {
            return Ok(PlanApprovalPending {
                pending: true,
                plan_path: json
                    .get("plan_path")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                plan_title: json
                    .get("plan_title")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                plan_content: json
                    .get("plan_content")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                tool_call_id: json
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            });
        }

        if std::time::Instant::now() >= deadline {
            return Ok(PlanApprovalPending {
                pending: false,
                plan_path: None,
                plan_title: None,
                plan_content: None,
                tool_call_id: None,
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Respond to a pending plan-approval request. Non-blocking flow: this
/// maps to a user clicking the inline Build button on the plan card.
/// `choice` must be `"approve"` or `"approve_with_edits"`. There is no
/// reject path — the user iterates by sending a new turn instead.
pub async fn send_plan_approval_response(
    base_url: &str,
    session_id: &str,
    choice: &str,
    edited_content: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/agent/test/sde/plan-approval/{}", base_url, session_id);
    let mut body = serde_json::json!({ "choice": choice });
    if let Some(ec) = edited_content {
        body["edited_content"] = serde_json::Value::String(ec.to_string());
    }

    // Long timeout: the endpoint now synchronously runs the follow-up
    // Build turn (LLM call + tool execution). 5 minutes matches what
    // `send_sde_message` gives a normal turn.
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("HTTP client build error: {}", err))?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    Ok(())
}

/// Response from the `/test/background-jobs/:session_id` debug endpoint.
pub struct BackgroundJobsResponse {
    pub count: usize,
    pub jobs: Vec<serde_json::Value>,
    pub reminder_text: String,
}

/// Query the background-jobs debug endpoint for a session.
pub async fn get_background_jobs(
    cfg: &Config,
    session_id: &str,
) -> Result<BackgroundJobsResponse, String> {
    let url = format!("{}/agent/test/background-jobs/{}", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    Ok(BackgroundJobsResponse {
        count: json.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        jobs: json
            .get("jobs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        reminder_text: json
            .get("reminder_text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

// ============================================
// Resume / orphan helpers
// ============================================

/// Send an SDE message with the user-initiated `is_resume` hint.
/// Equivalent to the frontend "Resume" button: triggers the
/// deletion-based `filter_unresolved_tool_uses` cleanup path instead of
/// the injection-based `repair_interrupted_history` crash-recovery path.
pub async fn send_sde_message_resume(
    cfg: &Config,
    content: &str,
    session_id: &str,
    mode: &str,
    workspace_path: &str,
    no_cleanup: bool,
) -> Result<SdeMessageResponse, String> {
    let opts = SdeMessageOpts {
        no_cleanup,
        ..Default::default()
    };
    send_sde_message_resume_with_opts(cfg, content, session_id, mode, workspace_path, &opts).await
}

pub async fn send_sde_message_resume_with_opts(
    cfg: &Config,
    content: &str,
    session_id: &str,
    mode: &str,
    workspace_path: &str,
    opts: &SdeMessageOpts<'_>,
) -> Result<SdeMessageResponse, String> {
    let url = format!("{}/agent/test/sde", cfg.base_url);
    let model = opts.model_override.unwrap_or(cfg.model.as_str());
    let account_id = opts.account_id_override.unwrap_or(cfg.account_id.as_str());
    let mut body = serde_json::json!({
        "content": content,
        "session_id": session_id,
        "model": model,
        "account_id": account_id,
        "workspace_path": workspace_path,
        "mode": mode,
        "no_cleanup": opts.no_cleanup,
        "enable_extract_memories": opts.enable_extract_memories,
        "enable_auto_dream": opts.enable_auto_dream,
        "is_resume": true,
    });
    if let Some(def_id) = opts.agent_definition_id {
        body["agent_definition_id"] = serde_json::Value::String(def_id.to_string());
    }
    if let Some(native_harness_type) = opts.native_harness_type {
        body["native_harness_type"] = serde_json::Value::String(native_harness_type.to_string());
    }
    if !opts.additional_directories.is_empty() {
        body["additional_directories"] = serde_json::json!(opts.additional_directories);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Client build error: {}", err))?;

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json = read_json_response(resp).await?;

    parse_sde_message_response(json)
}

/// Seed an orphan `tool_use` tail onto an existing SDE session via
/// `POST /agent/test/sde/seed-orphan`. The caller must have already created
/// the session (e.g. via a prior `send_sde_message` turn).
pub async fn seed_orphan(
    cfg: &Config,
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    user_text: Option<&str>,
    assistant_text: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/agent/test/sde/seed-orphan", cfg.base_url);
    let mut body = serde_json::json!({
        "session_id": session_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
    });
    if let Some(u) = user_text {
        body["user_text"] = serde_json::Value::String(u.to_string());
    }
    if let Some(a) = assistant_text {
        body["assistant_text"] = serde_json::Value::String(a.to_string());
    }

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

/// Response from `GET /agent/test/sde/transcript/:session_id`.
///
/// Only fields actually read by resume/orphan scenarios are exposed. In
/// particular, the per-turn deletion-based cleanup
/// (`filter_unresolved_tool_uses`) is intentionally in-memory-only and
/// never writes back to the DB, so `tool_call_ids` / `tool_result_ids` on
/// the persisted transcript cannot distinguish "orphan was filtered" from
/// "orphan was never there" after a resume. The recovery-path counters
/// (`RecoveryCounters`) are the correct assertion for that contract; the
/// transcript is only used here to verify that the user's fresh prompt got
/// appended and that no synthetic "interrupted" text was mis-injected.
pub struct TranscriptSnapshot {
    pub orphan_tool_call_ids: Vec<String>,
    pub messages: Vec<serde_json::Value>,
}

/// Fetch the persisted LLM-formatted transcript for a session.
pub async fn fetch_transcript(
    cfg: &Config,
    session_id: &str,
) -> Result<TranscriptSnapshot, String> {
    let url = format!("{}/agent/test/sde/transcript/{}", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let orphan_tool_call_ids = json
        .get("orphan_tool_call_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Ok(TranscriptSnapshot {
        orphan_tool_call_ids,
        messages: json
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
    })
}

/// Snapshot of the debug-only recovery-path counters exposed by
/// `GET /agent/test/recovery/counters`. Used by resume/orphan scenarios
/// to assert which in-memory cleanup ran (`filter_unresolved_tool_uses`
/// vs `repair_interrupted_history`) without having to scrape the
/// persisted transcript (neither path writes back to the DB by design).
#[derive(Debug, Clone)]
pub struct RecoveryCounters {
    pub filter_invocations: u64,
    pub filter_messages_removed: u64,
    pub repair_invocations: u64,
}

pub async fn reset_recovery_counters(cfg: &Config) -> Result<(), String> {
    let url = format!("{}/agent/test/recovery/counters-reset", cfg.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!("reset returned status {}", resp.status()));
    }
    Ok(())
}

pub async fn fetch_recovery_counters(cfg: &Config) -> Result<RecoveryCounters, String> {
    let url = format!("{}/agent/test/recovery/counters", cfg.base_url);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(RecoveryCounters {
        filter_invocations: json
            .get("filter_invocations")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        filter_messages_removed: json
            .get("filter_messages_removed")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        repair_invocations: json
            .get("repair_invocations")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

/// Call the `POST /agent/test/last-assistant-text` debug endpoint with a
/// synthetic messages array and return the helper's result.
///
/// Returns `Ok(Some(text))` when the helper recovered text, `Ok(None)` when
/// the helper found no non-empty assistant content, and `Err(...)` on network
/// or server errors.
pub async fn probe_last_assistant_text(
    cfg: &Config,
    messages: &serde_json::Value,
) -> Result<Option<String>, String> {
    let url = format!("{}/agent/test/last-assistant-text", cfg.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({ "messages": messages }))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if !body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(format!(
            "endpoint returned error: {}",
            body.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        ));
    }
    Ok(body
        .get("result")
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

/// Response from the `finalize_agent_result` debug endpoint.
pub struct FinalizeAgentResult {
    pub result: Option<String>,
    pub source: String,
}

/// Direct E2E probe for the `agent.rs` finalize path.
///
/// Mirrors the exact logic in `agent.rs` after `execute_turn` returns:
///   content.or_else(|| last_assistant_text(&messages))
///
/// `content` maps to `TurnResult.content`; `messages` maps to `TurnResult.messages`.
pub async fn probe_finalize_agent_result(
    cfg: &Config,
    content: Option<&str>,
    messages: &serde_json::Value,
) -> Result<FinalizeAgentResult, String> {
    let url = format!("{}/agent/test/finalize-agent-result", cfg.base_url);
    let body = serde_json::json!({
        "content": content,
        "messages": messages,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if !json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(format!(
            "endpoint returned error: {}",
            json.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        ));
    }
    Ok(FinalizeAgentResult {
        result: json
            .get("result")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        source: json
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
    })
}

pub struct Tier1EscalationResult {
    pub would_escalate: bool,
    pub new_max_tokens: u32,
    pub escalated_threshold: u32,
}

pub async fn probe_tier1_escalation(
    cfg: &Config,
    effective_max_tokens: u32,
    tier1_escalated: bool,
) -> Result<Tier1EscalationResult, String> {
    let url = format!("{}/agent/test/tier1-escalation-check", cfg.base_url);
    let body = serde_json::json!({
        "effective_max_tokens": effective_max_tokens,
        "tier1_escalated": tier1_escalated,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(Tier1EscalationResult {
        would_escalate: json
            .get("would_escalate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        new_max_tokens: json
            .get("new_max_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        escalated_threshold: json
            .get("escalated_threshold")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    })
}

pub struct PlanLifecycleEvent {
    pub id: String,
    pub created_at: String,
    pub status: String,
    pub plan_revision_id: String,
}

pub struct PlanLifecycleOrderResult {
    pub first_created_at_ms: i64,
    pub second_created_at_ms: i64,
    pub plan_events: Vec<PlanLifecycleEvent>,
}

pub struct CompleteLastRunningResult {
    pub completed_id: Option<String>,
    pub events: Vec<(String, String)>,
}

pub async fn probe_plan_approval_lifecycle_order(
    cfg: &Config,
) -> Result<PlanLifecycleOrderResult, String> {
    let url = format!(
        "{}/agent/test/sde/plan-approval-lifecycle-order",
        cfg.base_url
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {err}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "endpoint returned status {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {err}"))?;
    if !json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(format!(
            "endpoint returned error: {}",
            json.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        ));
    }

    let first_created_at_ms = json
        .get("first_created_at_ms")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "response missing first_created_at_ms".to_string())?;
    let second_created_at_ms = json
        .get("second_created_at_ms")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "response missing second_created_at_ms".to_string())?;
    let plan_events = json
        .get("plan_events")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "response missing plan_events".to_string())?
        .iter()
        .map(|event| {
            Ok(PlanLifecycleEvent {
                id: event
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                created_at: event
                    .get("created_at")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                status: event
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                plan_revision_id: event
                    .get("plan_revision_id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(PlanLifecycleOrderResult {
        first_created_at_ms,
        second_created_at_ms,
        plan_events,
    })
}

impl CompleteLastRunningResult {
    pub fn status_of(&self, id: &str) -> Option<&str> {
        self.events
            .iter()
            .find(|(ev_id, _)| ev_id == id)
            .map(|(_, status)| status.as_str())
    }
}

pub async fn probe_event_store_complete_last_running(
    cfg: &Config,
    events: &[(&str, &str)],
) -> Result<CompleteLastRunningResult, String> {
    let url = format!(
        "{}/agent/test/event-store/complete-last-running",
        cfg.base_url
    );
    let body = serde_json::json!({
        "events": events
            .iter()
            .map(|(id, status)| serde_json::json!({
                "id": id,
                "display_status": status,
            }))
            .collect::<Vec<_>>(),
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!(
            "endpoint returned status {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if !json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(format!(
            "endpoint returned error: {}",
            json.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        ));
    }
    let completed_id = json
        .get("completed_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let events_out = json
        .get("events")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "response missing events".to_string())?
        .iter()
        .filter_map(|e| {
            let id = e.get("id").and_then(|v| v.as_str())?.to_string();
            let status = e
                .get("display_status")
                .and_then(|v| v.as_str())?
                .to_string();
            Some((id, status))
        })
        .collect();
    Ok(CompleteLastRunningResult {
        completed_id,
        events: events_out,
    })
}

/// Seed `last_turn_cancelled = 1` for a session without running a turn.
///
/// Mirrors what `turn_executor` does at every cancel exit point, enabling
/// deterministic testing of the cancel-interrupt flag lifecycle.
pub async fn seed_cancel_flag(cfg: &Config, session_id: &str) -> Result<(), String> {
    let url = format!(
        "{}/agent/test/cancel-flag/{}/seed",
        cfg.base_url, session_id
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!("seed returned status {}", resp.status()));
    }
    Ok(())
}

/// Read `last_turn_cancelled` for `session_id` without consuming it.
///
/// Returns `Ok(true)` if the marker is set (previous turn was cancelled),
/// `Ok(false)` if it is clear (no cancel), or `Err(...)` on network error.
pub async fn fetch_cancel_flag(cfg: &Config, session_id: &str) -> Result<bool, String> {
    let url = format!("{}/agent/test/cancel-flag/{}", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(json
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// Atomically read-and-clear `last_turn_cancelled` for `session_id`.
///
/// Mirrors the exact logic executed by `processor.rs` step 4b:
/// `take_turn_cancelled` returns `true` and clears the flag.
/// Used by E2E to exercise the cancel-interrupt injection path
/// deterministically without running a full LLM turn.
pub async fn take_cancel_flag(cfg: &Config, session_id: &str) -> Result<bool, String> {
    let url = format!("{}/agent/test/cancel-flag/{}", cfg.base_url, session_id);
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(json
        .get("was_cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

pub fn print_error(name: &str, error: &str) -> bool {
    println!();
    println!("{}", "=".repeat(70));
    println!("  Scenario: {name}");
    println!("{}", "=".repeat(70));
    println!("  STATUS: ERROR");
    println!("  Error: {}", &error[..error.len().min(300)]);
    false
}

// ───────────────────────────────────────────────────────────────────
// Session-workspace mutator probes
// ───────────────────────────────────────────────────────────────────
//
// Thin wrappers around the `/agent/test/session/workspace/*` debug
// endpoints. Each returns the decoded response JSON so scenarios can
// assert on both the `ok` flag and the numeric / structural fields
// without having to re-parse `serde_json::Value` at every call site.

/// Response from `POST /agent/test/session/workspace/add-directory`.
#[derive(Debug, Clone)]
pub struct WorkspaceAddResponse {
    pub ok: bool,
    pub inserted: bool,
    pub error: Option<String>,
}

pub async fn workspace_add_directory(
    cfg: &Config,
    session_id: &str,
    path: &str,
    source: Option<&str>,
) -> Result<WorkspaceAddResponse, String> {
    let url = format!(
        "{}/agent/test/session/workspace/add-directory",
        cfg.base_url
    );
    let mut body = serde_json::json!({
        "session_id": session_id,
        "path": path,
    });
    if let Some(s) = source {
        body["source"] = serde_json::Value::String(s.to_string());
    }
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(WorkspaceAddResponse {
        ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        inserted: json
            .get("inserted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        error: json
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Response from `POST /agent/test/session/workspace/remove-directory`.
#[derive(Debug, Clone)]
pub struct WorkspaceRemoveResponse {
    pub ok: bool,
    pub removed: bool,
    pub error: Option<String>,
}

pub async fn workspace_remove_directory(
    cfg: &Config,
    session_id: &str,
    path: &str,
) -> Result<WorkspaceRemoveResponse, String> {
    let url = format!(
        "{}/agent/test/session/workspace/remove-directory",
        cfg.base_url
    );
    let body = serde_json::json!({
        "session_id": session_id,
        "path": path,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(WorkspaceRemoveResponse {
        ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        removed: json
            .get("removed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        error: json
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Response from `POST /agent/test/session/workspace/list`. Only the
/// fields needed by current scenarios are exposed; expand as new
/// scenarios need new fields.
#[derive(Debug, Clone)]
pub struct WorkspaceListResponse {
    pub ok: bool,
    pub additional_paths: Vec<String>,
    pub additional_sources: Vec<String>,
    pub error: Option<String>,
}

pub async fn workspace_list(
    cfg: &Config,
    session_id: &str,
) -> Result<WorkspaceListResponse, String> {
    let url = format!("{}/agent/test/session/workspace/list", cfg.base_url);
    let body = serde_json::json!({ "session_id": session_id });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    let ok = json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let additional = json
        .get("workspace")
        .and_then(|ws| ws.get("additionalDirectories"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let additional_paths = additional
        .iter()
        .filter_map(|d| {
            d.get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    let additional_sources = additional
        .iter()
        .filter_map(|d| {
            d.get("source")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    let error = json
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(WorkspaceListResponse {
        ok,
        additional_paths,
        additional_sources,
        error,
    })
}

/// Response from `POST /agent/test/session/prompt/environment-block`.
/// Caller-path probe: asserts that the live
/// `workspace_state` handle flows through `build_system_prompt` into
/// the rendered `## Environment` section.
#[derive(Debug, Clone)]
pub struct PromptEnvironmentResponse {
    pub ok: bool,
    pub environment: Option<String>,
    pub error: Option<String>,
}

pub async fn prompt_environment_block(
    cfg: &Config,
    session_id: &str,
) -> Result<PromptEnvironmentResponse, String> {
    let url = format!(
        "{}/agent/test/session/prompt/environment-block",
        cfg.base_url
    );
    let body = serde_json::json!({ "session_id": session_id });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(PromptEnvironmentResponse {
        ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        environment: json
            .get("environment")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        error: json
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Seed-only launch probe response.
#[derive(Debug)]
pub struct LaunchSeedOnlyResponse {
    pub ok: bool,
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct LaunchSeedOnlyOpts<'a> {
    pub session_id_hint: Option<&'a str>,
    pub agent_definition_id: Option<&'a str>,
    pub agent_exec_mode: Option<&'a str>,
    pub initialize_runtime: bool,
}

/// Drive `POST /agent/test/session/launch-seed-only` — runs the
/// The workspace-seeding code path in `session_launch_impl`
/// against a real session record but with `content=""` so the LLM
/// turn is skipped. Returns the newly-minted session id so the
/// caller can read it back via `workspace_list_from_db`.
pub async fn launch_seed_only(
    cfg: &Config,
    workspace_path: &str,
    additional_directories: &[String],
    session_id_hint: Option<&str>,
) -> Result<LaunchSeedOnlyResponse, String> {
    launch_seed_only_with_opts(
        cfg,
        workspace_path,
        additional_directories,
        &LaunchSeedOnlyOpts {
            session_id_hint,
            ..Default::default()
        },
    )
    .await
}

pub async fn launch_seed_only_with_opts(
    cfg: &Config,
    workspace_path: &str,
    additional_directories: &[String],
    opts: &LaunchSeedOnlyOpts<'_>,
) -> Result<LaunchSeedOnlyResponse, String> {
    let url = format!("{}/agent/test/session/launch-seed-only", cfg.base_url);
    let mut body = serde_json::json!({
        "workspace_path": workspace_path,
        "additional_directories": additional_directories,
        "model": cfg.model,
        "account_id": cfg.account_id,
        "initialize_runtime": opts.initialize_runtime,
    });
    if let Some(hint) = opts.session_id_hint {
        body["session_id_hint"] = serde_json::Value::String(hint.to_string());
    }
    if let Some(agent_definition_id) = opts.agent_definition_id {
        body["agent_definition_id"] = serde_json::Value::String(agent_definition_id.to_string());
    }
    if let Some(agent_exec_mode) = opts.agent_exec_mode {
        body["agent_exec_mode"] = serde_json::Value::String(agent_exec_mode.to_string());
    }
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    Ok(LaunchSeedOnlyResponse {
        ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        session_id: json
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        workspace_path: json
            .get("workspace_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        error: json
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Flat view of the DB-persisted workspace snapshot read by
/// `POST /agent/test/session/workspace/list-from-db`.
#[derive(Debug)]
pub struct WorkspaceListFromDbResponse {
    pub ok: bool,
    pub has_workspace: bool,
    pub workspace_root: Option<String>,
    pub working_dir: Option<String>,
    pub additional_paths: Vec<String>,
    pub additional_sources: Vec<String>,
    pub error: Option<String>,
}

/// Read `agent_sessions.workspace_additional_json` for a session
/// directly from SQLite without requiring a live `SessionRuntime`.
/// Paired with `launch_seed_only` to prove the launch-time seeding
/// path persists what the frontend passed in.
pub async fn workspace_list_from_db(
    cfg: &Config,
    session_id: &str,
) -> Result<WorkspaceListFromDbResponse, String> {
    let url = format!("{}/agent/test/session/workspace/list-from-db", cfg.base_url);
    let body = serde_json::json!({ "session_id": session_id });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;

    let ok = json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let ws = json
        .get("workspace")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let has_workspace = !ws.is_null();
    let workspace_root = ws
        .get("workspaceRoot")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let working_dir = ws
        .get("workingDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut additional_paths = Vec::new();
    let mut additional_sources = Vec::new();
    if let Some(arr) = ws.get("additionalDirectories").and_then(|v| v.as_array()) {
        for entry in arr {
            if let Some(p) = entry.get("path").and_then(|v| v.as_str()) {
                additional_paths.push(p.to_string());
            }
            if let Some(s) = entry.get("source").and_then(|v| v.as_str()) {
                additional_sources.push(s.to_string());
            }
        }
    }
    Ok(WorkspaceListFromDbResponse {
        ok,
        has_workspace,
        workspace_root,
        working_dir,
        additional_paths,
        additional_sources,
        error: json
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}
