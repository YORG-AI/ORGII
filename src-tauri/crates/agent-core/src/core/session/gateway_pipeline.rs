//! Message processing pipeline for gateway/channel sessions.
//!
//! Handles gateway-specific pre-processing (session metadata) then delegates
//! to `integration::process_message`.

use std::sync::Arc;
use tracing::{info, warn};

use crate::bus::{InboundMessage, OutboundMessage};
use crate::foundation::persistence::images::load_image_as_data_url;

use crate::session::persistence as unified_persistence;
use crate::session::IdeContext;
use crate::state::{AgentAppState, AgentSession};
use core_types::key_source::KeySource;

/// Process a single inbound gateway message.
///
/// Handles gateway-specific pre-processing (session metadata), then builds a
/// `TurnInput` and delegates to `integration::process_message`.
pub async fn process_gateway_message(
    msg: InboundMessage,
    session: Arc<AgentSession>,
    ide_context: Option<&IdeContext>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<Option<OutboundMessage>, String> {
    let preview: String = crate::utils::safe_truncate_chars_to_string(&msg.content, 80);
    info!(
        "Processing message from {}:{}: {}...",
        msg.channel, msg.sender_id, preview
    );

    let session_key = msg.session_key();

    let runtime = session
        .runtime
        .read()
        .await
        .as_ref()
        .ok_or_else(|| format!("Session {} runtime not initialized", session.id))?
        .clone();

    let effective_model = runtime.model.clone();

    // Ensure a session record exists in the unified `agent_sessions` table.
    {
        let sk = session_key.clone();
        let channel = msg.channel.clone();
        let chat_id = msg.chat_id.clone();
        let user_input_preview: String =
            crate::utils::safe_truncate_chars_to_string(&msg.content, 200);
        let model = effective_model.clone();
        if let Err(err) =
            tokio::task::spawn_blocking(move || match unified_persistence::get_session(&sk) {
                Ok(Some(_)) => Ok(()),
                Ok(None) => {
                    let session_type = unified_persistence::session_type::DESKTOP;
                    let now = chrono::Utc::now().to_rfc3339();
                    let record = unified_persistence::UnifiedSessionRecord {
                        session_id: sk,
                        name: format!("Channel: {}", channel),
                        status: super::SessionStatus::Running.as_str().to_string(),
                        model: Some(model),
                        session_type: session_type.to_string(),
                        channel: Some(channel),
                        chat_id: Some(chat_id),
                        user_input: Some(user_input_preview),
                        created_at: now.clone(),
                        updated_at: now,
                        // Channel-driven auto-create: the gateway pulls
                        // model + account from `state.integrations.snapshot()
                        // .channels.gateway`, which is global app config —
                        // it has no key_source field because gateway
                        // routing is BYOK by construction (the user's own
                        // configured account). If a future gateway config
                        // ever gains a market-key option, this `OwnKey`
                        // must be replaced by a value derived from that
                        // config; until then, written explicitly so the
                        // posture is auditable.
                        key_source: KeySource::OwnKey,
                        ..Default::default()
                    };
                    unified_persistence::upsert_session(&record)
                }
                Err(err) => Err(err),
            })
            .await
            .map_err(|err| err.to_string())?
        {
            warn!(
                "[agent-loop] Failed to auto-create session metadata: {}",
                err
            );
        }
    }

    // Mark session as running while processing
    {
        let sk = session_key.clone();
        if let Err(err) = tokio::task::spawn_blocking(move || {
            unified_persistence::update_status(&sk, crate::session::SessionStatus::Running)
        })
        .await
        .map_err(|err| err.to_string())?
        {
            warn!(
                "[agent-loop] Failed to set session status to running: {}",
                err
            );
        }
    }

    let images = if msg.media.is_empty() {
        None
    } else {
        let data_urls: Vec<String> = msg
            .media
            .iter()
            .filter_map(|m| {
                if m.starts_with("data:") {
                    Some(m.clone())
                } else {
                    load_image_as_data_url(m).or_else(|| {
                        warn!("[agent-loop] media is not loadable as image data URL: {}", m);
                        None
                    })
                }
            })
            .collect();
        if data_urls.is_empty() {
            None
        } else {
            Some(data_urls)
        }
    };

    let input = super::turn::TurnInput {
        content: msg.content.clone(),
        display_text: None,
        agent_mode: None,
        images,
        ide_context: ide_context.cloned(),
        is_resume: false,
        channel: Some(msg.channel.clone()),
        chat_id: Some(msg.chat_id.clone()),
        turn_id: None,
        // Gateway-driven turns (Slack/Discord/etc.) are their own user
        // intent — mint a dedicated id so the turn indexer treats each
        // gateway message as a distinct round even if multiple share
        // the same channel/chat.
        turn_intent_id: uuid::Uuid::new_v4().to_string(),
    };

    let result =
        crate::session::process_message(Arc::clone(&session), input, app_handle.clone()).await;

    // Compact-fork redirect.
    if let Ok(ref pr) = result {
        if let Some(ref new_sid) = pr.fork_redirect {
            let already_redirected = msg
                .metadata
                .get("compact_fork_redirected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if already_redirected {
                warn!(
                    "[agent-loop] Compact-fork redirect requested for already-redirected \
                     message {} → {} — refusing to recurse",
                    session_key, new_sid
                );
                return Ok(None);
            }
            info!(
                "[agent-loop] Compact-fork redirect: {} → {} (re-dispatching)",
                session_key, new_sid
            );
            let mut redirected = msg.clone();
            redirected.session_key_override = Some(new_sid.clone());
            redirected.metadata.insert(
                "compact_fork_redirected".to_string(),
                serde_json::Value::Bool(true),
            );

            let state_handle = app_handle.as_ref().map(|h| {
                use tauri::Manager;
                h.state::<AgentAppState>()
            });
            if let Some(ref state) = state_handle {
                if let Some(new_session) = state.get_session(new_sid).await {
                    let inner = Box::pin(process_gateway_message(
                        redirected,
                        new_session,
                        ide_context,
                        app_handle.clone(),
                    ))
                    .await;
                    return inner;
                }
            }
            warn!(
                "[agent-loop] Compact-fork redirect: new session {} not found",
                new_sid
            );
        }
    }

    // ── Post-processing (shared lifecycle) ──
    let terminal_turn = result
        .as_ref()
        .ok()
        .map(|r| crate::lifecycle::TerminalTurnSignal {
            turn_id: r.turn_id.clone(),
            status: crate::lifecycle::TurnTerminalStatus::Completed,
            completed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
    let response = result
        .as_ref()
        .map(|r| r.content.clone())
        .map_err(|e| e.clone());
    crate::lifecycle::finalize_session(&session_key, &response, None, None, true, terminal_turn)
        .await;

    match result {
        Ok(processing_result) => {
            let content = crate::session::status_bar::append_status_bar_for_channel(
                &msg.channel,
                processing_result.content.clone(),
                &session,
                processing_result.total_tokens,
                processing_result.context_tokens,
            )
            .await;
            let out_preview: String = crate::utils::safe_truncate_chars_to_string(&content, 80);
            info!(
                "[agent-loop] Response for {}:{}: {}...",
                msg.channel, msg.chat_id, out_preview
            );
            Ok(Some(OutboundMessage::new(
                &msg.channel,
                &msg.chat_id,
                &content,
            )))
        }
        Err(err) => {
            warn!("[agent-loop] Error: {}", err);
            Ok(Some(OutboundMessage::new(
                &msg.channel,
                &msg.chat_id,
                &format!("Sorry, I encountered an error: {}", err),
            )))
        }
    }
}
