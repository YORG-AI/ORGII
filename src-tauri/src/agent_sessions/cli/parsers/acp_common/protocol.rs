//! The ACP protocol lifecycle: initialize → session → prompt → stream.

use serde_json::Value;
use tokio::io::BufReader;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use core_types::activity::ActivityChunk;

use super::approval::{
    await_acp_approval, broadcast_acp_permission_request, extract_permission_request_info,
    register_acp_approval, select_acp_option_id, ACP_APPROVAL_TIMEOUT,
};
use super::rpc::{acp_read, acp_respond, acp_send};
use super::{AcpAgentAdapter, AcpNotificationParser, AcpSessionResult};

/// ACP major protocol version.
const ACP_PROTOCOL_VERSION: u32 = 1;

// ============================================
// ACP Protocol Flow
// ============================================

/// Run the full ACP protocol lifecycle with an agent-specific adapter.
#[allow(clippy::too_many_arguments)]
pub async fn run_acp_protocol<A: AcpAgentAdapter>(
    adapter: A,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    session_id: &str,
    task: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    chunk_tx: mpsc::Sender<ActivityChunk>,
    image_paths: Vec<String>,
) -> Result<AcpSessionResult, String> {
    let mut reader = BufReader::new(stdout);
    let mut parser = AcpNotificationParser::new_with_task(adapter, session_id, task);
    let mut line_buf = String::new();
    let mut request_id: u64 = 0;

    // ── Step 1: Initialize ──
    request_id += 1;
    let init_id = request_id;
    acp_send(
        &mut stdin,
        init_id,
        "initialize",
        serde_json::json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": { "terminal": true },
        }),
    )
    .await?;

    let mut supports_load_session = false;
    let mut supports_resume_session = false;
    // `None` = the agent said nothing, so keep the historical behavior of
    // sending images. Only an explicit `false` suppresses them.
    let mut supports_image_prompts: Option<bool> = None;
    loop {
        let msg = match acp_read(&mut reader, &mut line_buf).await {
            Ok(msg) => msg,
            Err(err) => {
                tracing::error!("[ACP] Read error during initialize: {}", err);
                return Err(err);
            }
        };
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        tracing::info!(
            "[ACP] init-loop msg id={:?} keys={:?}",
            msg_id,
            msg.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        if msg_id == Some(init_id) {
            if let Some(err) = msg.get("error") {
                tracing::warn!("[ACP] Initialize error (continuing): {}", err);
            }
            if let Some(result) = msg.get("result") {
                tracing::info!(
                    "[ACP] Initialize response: {}",
                    serde_json::to_string(result)
                        .expect("acp_common: serde_json::Value must serialize")
                );
                let capabilities = result.get("agentCapabilities");
                supports_load_session = capabilities
                    .and_then(|c| c.get("loadSession"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // DeepSeek Harness resumes through `session/resume` and
                // answers `session/load` with "Method not found", so the
                // resume path is selected by the capability it advertises.
                supports_resume_session = capabilities
                    .and_then(|c| c.get("sessionCapabilities"))
                    .and_then(|c| c.get("resume"))
                    .is_some_and(|v| !v.is_null());
                supports_image_prompts = capabilities
                    .and_then(|c| c.get("promptCapabilities"))
                    .and_then(|c| c.get("image"))
                    .and_then(|v| v.as_bool());
            }
            tracing::info!(
                "[ACP] Agent capabilities — loadSession: {}, resumeSession: {}, imagePrompts: {:?}",
                supports_load_session,
                supports_resume_session,
                supports_image_prompts
            );
            break;
        }
    }

    // ── Step 2: Create or resume session ──
    request_id += 1;
    let session_req_id = request_id;
    let resume_method = if supports_load_session {
        Some("session/load")
    } else if supports_resume_session {
        Some("session/resume")
    } else {
        None
    };
    let use_load = resume_session_id.is_some() && resume_method.is_some();

    if let (Some(method), Some(resume_id)) = (
        resume_method.filter(|_| resume_session_id.is_some()),
        resume_session_id,
    ) {
        tracing::info!("[ACP] Resuming session via {} (id={})", method, resume_id);
        acp_send(
            &mut stdin,
            session_req_id,
            method,
            serde_json::json!({
                "sessionId": resume_id, "cwd": working_dir, "mcpServers": [],
            }),
        )
        .await?;
    } else {
        if resume_session_id.is_some() {
            tracing::info!("[ACP] Agent supports no session resume — calling session/new");
        }
        acp_send(
            &mut stdin,
            session_req_id,
            "session/new",
            serde_json::json!({
                "cwd": working_dir, "mcpServers": [],
            }),
        )
        .await?;
    }

    let mut acp_session_id = resume_session_id.unwrap_or("").to_string();
    // The `configOptions` the agent published for this session. `session/resume`
    // returns them without a `sessionId`, so they are read from the result
    // itself rather than from the session-id branch below.
    let advertised_config: Value;
    // Tracks the request currently being awaited: a failed resume retries as
    // `session/new` under a fresh id.
    let mut session_req_id = session_req_id;
    let mut awaiting_resume = use_load;
    loop {
        let msg = match acp_read(&mut reader, &mut line_buf).await {
            Ok(msg) => msg,
            Err(err) => {
                tracing::error!("[ACP] Read error during session/new: {}", err);
                return Err(err);
            }
        };
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        tracing::info!(
            "[ACP] session-loop msg id={:?} keys={:?}",
            msg_id,
            msg.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        if msg_id == Some(session_req_id) {
            if let Some(err) = msg.get("error") {
                // A resume can legitimately fail — the agent pruned the
                // session, another process still holds it, or the workspace
                // moved. Starting fresh loses history but still answers the
                // user's turn, which beats failing the whole run.
                if awaiting_resume {
                    tracing::warn!(
                        "[ACP] Session resume failed ({}) — falling back to session/new",
                        err
                    );
                    awaiting_resume = false;
                    acp_session_id = String::new();
                    request_id += 1;
                    session_req_id = request_id;
                    acp_send(
                        &mut stdin,
                        session_req_id,
                        "session/new",
                        serde_json::json!({
                            "cwd": working_dir, "mcpServers": [],
                        }),
                    )
                    .await?;
                    continue;
                }
                return Err(format!("ACP session error: {}", err));
            }
            advertised_config = msg
                .get("result")
                .and_then(|r| r.get("configOptions"))
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(sid) = msg
                .get("result")
                .and_then(|r| r.get("sessionId"))
                .and_then(|v| v.as_str())
            {
                acp_session_id = sid.to_string();
                // Bind the ACP session id NOW rather than at protocol end:
                // native-transcript replay, imported-twin dedup, and
                // live-status attribution all key on it, and a failed or
                // interrupted run must not orphan the CLI-store transcript.
                // Retries re-bind each attempt; the append-only ledger keeps
                // every fork recognized. Fire-and-forget: a locked DB must
                // not stall the protocol handshake.
                {
                    let managed_session_id = session_id.to_string();
                    let native_id = acp_session_id.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(err) =
                            crate::agent_sessions::cli::persistence::update_cli_session_id(
                                &managed_session_id,
                                &native_id,
                            )
                        {
                            tracing::warn!("[ACP] Early cli_session_id bind failed: {}", err);
                        }
                    });
                }
                let current_model = advertised_config
                    .as_array()
                    .and_then(|arr| {
                        arr.iter()
                            .find(|o| o.get("id").and_then(|v| v.as_str()) == Some("model"))
                    })
                    .and_then(|o| o.get("currentValue"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                tracing::info!(
                    "[ACP] session/new succeeded, acp_session_id={}, model={}",
                    acp_session_id,
                    current_model
                );
            }
            break;
        }
        // Skip notifications during a resume — kiro replays conversation
        // history as notifications which we don't want to emit as new chunks.
        if !awaiting_resume {
            process_notification(&msg, &mut parser, &mut stdin, &chunk_tx, session_id).await;
        }
    }

    // ── Step 2b: Apply session configuration the adapter selected ──
    // A rejected option must not sink the turn: the session still runs, just
    // on the agent's own default route.
    let config_updates = parser.adapter.session_config_updates(&advertised_config);
    for (config_id, value) in config_updates {
        request_id += 1;
        let config_req_id = request_id;
        acp_send(
            &mut stdin,
            config_req_id,
            "session/set_config_option",
            serde_json::json!({
                "sessionId": acp_session_id,
                "configId": config_id,
                "value": value,
            }),
        )
        .await?;
        loop {
            let msg = acp_read(&mut reader, &mut line_buf).await?;
            if msg.get("id").and_then(|v| v.as_u64()) == Some(config_req_id) {
                if let Some(err) = msg.get("error") {
                    tracing::warn!(
                        "[ACP] session/set_config_option {}={} rejected: {}",
                        config_id,
                        value,
                        err
                    );
                } else {
                    tracing::info!("[ACP] session config {} set to {}", config_id, value);
                }
                break;
            }
            process_notification(&msg, &mut parser, &mut stdin, &chunk_tx, session_id).await;
        }
    }

    // Emit session_start
    let mut start_chunk = ActivityChunk::new(session_id, "session_start", "session_start");
    start_chunk.result = serde_json::json!({"success": true});
    let _ = chunk_tx.send(start_chunk).await;

    // ── Step 3: Send prompt (with optional image blocks) ──
    request_id += 1;
    let prompt_id = request_id;
    let mut prompt_blocks: Vec<serde_json::Value> =
        vec![serde_json::json!({"type": "text", "text": task})];
    // An agent that declares `promptCapabilities.image: false` rejects the
    // whole prompt when an image block is present, so the text must go
    // through on its own rather than failing the turn.
    if supports_image_prompts == Some(false) && !image_paths.is_empty() {
        tracing::warn!(
            "[ACP] Agent does not accept image prompts — dropping {} image(s)",
            image_paths.len()
        );
    }
    for path in image_paths
        .iter()
        .filter(|_| supports_image_prompts != Some(false))
    {
        if let Ok(bytes) = std::fs::read(path) {
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let mime = if path.ends_with(".png") {
                "image/png"
            } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                "image/jpeg"
            } else if path.ends_with(".gif") {
                "image/gif"
            } else if path.ends_with(".webp") {
                "image/webp"
            } else {
                "image/png"
            };
            prompt_blocks.push(serde_json::json!({
                "type": "image",
                "mimeType": mime,
                "data": b64,
            }));
        }
    }
    tracing::info!(
        "[ACP] Sending session/prompt to acp_session_id={}",
        acp_session_id
    );
    acp_send(
        &mut stdin,
        prompt_id,
        "session/prompt",
        serde_json::json!({
            "sessionId": acp_session_id,
            "prompt": prompt_blocks,
        }),
    )
    .await?;

    // ── Step 4: Stream notifications until prompt response ──
    let stop_reason;
    loop {
        let msg = acp_read(&mut reader, &mut line_buf).await?;
        let msg_id = msg.get("id").and_then(|v| v.as_u64());
        if msg_id == Some(prompt_id) {
            if let Some(err) = msg.get("error") {
                return Err(format!("ACP prompt error: {}", err));
            }
            stop_reason = msg
                .get("result")
                .and_then(|r| r.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            break;
        }
        process_notification(&msg, &mut parser, &mut stdin, &chunk_tx, session_id).await;
    }

    for chunk in parser.flush_thought_buffer() {
        let _ = chunk_tx.send(chunk).await;
    }

    // Emit session_end
    let mut end_chunk = ActivityChunk::new(session_id, "session_end", "session_end");
    end_chunk.result = serde_json::json!({
        "success": stop_reason == "end_turn",
        "stop_reason": &stop_reason,
    });
    let _ = chunk_tx.send(end_chunk).await;

    Ok(AcpSessionResult {
        acp_session_id,
        stop_reason,
    })
}

/// Process a single NDJSON message that might be a notification.
async fn process_notification<A: AcpAgentAdapter>(
    msg: &Value,
    parser: &mut AcpNotificationParser<A>,
    stdin: &mut ChildStdin,
    chunk_tx: &mpsc::Sender<ActivityChunk>,
    session_id: &str,
) {
    let method = match msg.get("method").and_then(|v| v.as_str()) {
        Some(m) => m,
        None => return,
    };

    match method {
        "session/update" => {
            if let Some(update) = msg.get("params").and_then(|p| p.get("update")) {
                for chunk in parser.parse_update(update) {
                    let _ = chunk_tx.send(chunk).await;
                }
            }
        }
        "session/request_permission" => {
            if let Some(req_id) = msg.get("id") {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let info = extract_permission_request_info(&parser.adapter, &params);
                let tool_name = info.tool_name;

                // Register the oneshot BEFORE broadcasting so a fast
                // frontend response always finds the entry.
                let (request_id, rx) = register_acp_approval(session_id).await;

                // Emit an ask_user_permissions chunk (transcript record)
                let mut chunk =
                    ActivityChunk::new(session_id, "ask_user_permissions", "ask_user_permissions");
                chunk.args = serde_json::json!({
                    "tool_name": tool_name,
                    "description": info.description,
                    "request_id": request_id,
                });
                chunk.result = serde_json::json!({
                    "pending": true,
                });
                let _ = chunk_tx.send(chunk).await;

                // Broadcast the interactive permission:request wire event
                // (rendered by PermissionCard, answered via
                // cli_agent_approval_response with this request_id).
                broadcast_acp_permission_request(
                    session_id,
                    &request_id,
                    &tool_name,
                    &info.tool_args,
                    info.tool_call_id.as_deref(),
                );
                tracing::info!(
                    session_id = %session_id,
                    request_id = %request_id,
                    tool = %tool_name,
                    "[ACP] Waiting for user permission decision"
                );

                // 5-minute timeout for user response; auto-approve on timeout
                let response = await_acp_approval(&request_id, rx, ACP_APPROVAL_TIMEOUT).await;

                let option_id =
                    select_acp_option_id(&params, response.approved, response.always_allow);

                acp_respond(
                    stdin,
                    req_id,
                    serde_json::json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
                )
                .await;

                // Emit the response as an approval_response chunk
                let mut resp_chunk =
                    ActivityChunk::new(session_id, "approval_response", "approval_response");
                resp_chunk.result = serde_json::json!({
                    "approved": response.approved,
                    "always_allow": response.always_allow,
                    "tool_name": tool_name,
                });
                let _ = chunk_tx.send(resp_chunk).await;
            }
        }
        _ => {
            // Delegate to agent-specific handler
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let chunks = parser.adapter.handle_custom_notification(method, &params);
            if chunks.is_empty() {
                tracing::debug!("[ACP] Ignoring notification: {}", method);
            }
            for chunk in chunks {
                let _ = chunk_tx.send(chunk).await;
            }
        }
    }
}
