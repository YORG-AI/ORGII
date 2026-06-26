//! Background workers for the gateway service.
//!
//! These helpers are extracted from `GatewayService::start` so the service
//! entry point stays focused on wiring rather than per-task logic.

use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::automation;
use crate::bus::{AgentMessageBus as MessageBus, InboundMessage, OutboundMessage};
use crate::channels::delivery::{extract_media_refs, inject_inbound_media};
use crate::channels::ChannelManager;

use super::message_merge::MergeBuffer;
use super::service::InboundMessageHandler;

const MESSAGE_TTL_SECS: i64 = 120;

/// Spawn the inbound message processor.
///
/// Listens on `bus.recv_inbound`, filters stale/non-routable messages,
/// applies a 500 ms message-merge window (see [`MergeBuffer`]), and fans
/// out to the provided handler. Maintains the channel's typing indicator
/// for the duration of each message's processing.
pub(super) fn spawn_inbound_processor(
    bus: Arc<Mutex<MessageBus>>,
    gateway_running: Arc<AtomicBool>,
    handler: Arc<dyn InboundMessageHandler>,
    channel_manager: Arc<Mutex<Option<ChannelManager>>>,
) -> tokio::task::JoinHandle<()> {
    let merge_buffer = MergeBuffer::new();

    // Drain loop: polls the merge buffer every 50 ms for ready batches.
    let drain_buf = merge_buffer.clone();
    let drain_handler = Arc::clone(&handler);
    let drain_bus = bus.clone();
    let drain_cm = channel_manager.clone();
    let drain_running = gateway_running.clone();
    tokio::spawn(async move {
        while drain_running.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let ready = drain_buf.drain_ready().await;
            for merged_msg in ready {
                let handler = Arc::clone(&drain_handler);
                let bus_clone = drain_bus.clone();
                let cm_clone = drain_cm.clone();
                tokio::spawn(handle_ready_message(
                    merged_msg, handler, bus_clone, cm_clone,
                ));
            }
        }
    });

    // Receive loop: pushes new messages into the merge buffer.
    tokio::spawn(async move {
        info!("[gateway] Inbound processor started");

        while gateway_running.load(Ordering::Relaxed) {
            let msg = {
                let mut bus_lock = bus.lock().await;
                bus_lock
                    .recv_inbound_timeout(std::time::Duration::from_secs(1))
                    .await
            };

            let Some(msg) = msg else {
                continue;
            };

            let age_secs = (chrono::Utc::now() - msg.timestamp).num_seconds();
            if age_secs > MESSAGE_TTL_SECS {
                warn!(
                    "[gateway] Dropping stale message (age={}s, channel={}, session={})",
                    age_secs,
                    msg.channel,
                    msg.session_key()
                );
                continue;
            }

            automation::bridge::send_channel_message(msg.clone());

            if msg.channel == "tauri" {
                continue;
            }

            info!(
                "[gateway] Buffering inbound from {}: {}...",
                msg.channel,
                crate::utils::safe_truncate_chars_to_string(&msg.content, 60)
            );

            // Inject any inbound media paths into the message content so the
            // OS agent can reference them.
            let msg = if !msg.media.is_empty() {
                let mut enriched = msg;
                enriched.content = inject_inbound_media(&enriched.content, &enriched.media);
                enriched
            } else {
                msg
            };

            merge_buffer.push(msg).await;
        }

        info!("[gateway] Inbound processor stopped");
    })
}

/// Process a single (possibly merged) inbound message.
///
/// Manages the typing indicator loop for the duration of the handler call.
async fn handle_ready_message(
    msg: InboundMessage,
    handler: Arc<dyn InboundMessageHandler>,
    bus: Arc<Mutex<MessageBus>>,
    channel_manager: Arc<Mutex<Option<ChannelManager>>>,
) {
    let typing_interval = {
        let cm_lock = channel_manager.lock().await;
        cm_lock
            .as_ref()
            .and_then(|mgr| mgr.typing_refresh_interval_for(&msg.channel))
    };

    let message_id = msg
        .metadata
        .get("message_id")
        .or_else(|| msg.metadata.get("source_message_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let reaction_channel = msg
        .metadata
        .get("source_channel")
        .and_then(|v| v.as_str())
        .unwrap_or(&msg.channel)
        .to_string();
    let reaction_chat_id = msg
        .metadata
        .get("source_chat_id")
        .and_then(|v| v.as_str())
        .unwrap_or(&msg.chat_id)
        .to_string();

    if !message_id.is_empty() {
        info!(
            channel = %reaction_channel,
            chat_id = %reaction_chat_id,
            message_id = %message_id,
            "[gateway] processing reaction start"
        );
        let cm_lock = channel_manager.lock().await;
        if let Some(ref mgr) = *cm_lock {
            mgr.notify_processing_start(&reaction_channel, &reaction_chat_id, &message_id)
                .await;
        }
    }

    let typing_task: Option<tokio::task::JoinHandle<()>> = typing_interval.map(|interval| {
        let cm = channel_manager.clone();
        let channel_name = reaction_channel.clone();
        let chat_id = reaction_chat_id.clone();
        let message_id = message_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if message_id.is_empty() {
                    continue;
                }
                {
                    let cm_lock = cm.lock().await;
                    if let Some(ref mgr) = *cm_lock {
                        mgr.notify_processing_start(&channel_name, &chat_id, &message_id)
                            .await;
                    }
                }
            }
        })
    });

    let mut remove_processing_on_handler_done = true;

    match handler.handle_message(msg.clone()).await {
        Ok(Some(mut response)) => {
            if !message_id.is_empty() {
                response.metadata.insert(
                    "processing_reaction_chat_id".to_string(),
                    Value::String(reaction_chat_id.clone()),
                );
                response.metadata.insert(
                    "processing_reaction_message_id".to_string(),
                    Value::String(message_id.clone()),
                );
                remove_processing_on_handler_done = false;
            }
            let bus_lock = bus.lock().await;
            bus_lock.publish_outbound(response);
        }
        Ok(None) => {
            if !message_id.is_empty() && msg.metadata.contains_key("source_message_id") {
                remove_processing_on_handler_done = false;
            }
        }
        Err(err_msg) => {
            error!("[gateway] Error processing message: {}", err_msg);
            let mut response = OutboundMessage::new(
                &msg.channel,
                &msg.chat_id,
                &format!("Sorry, I encountered an error: {}", err_msg),
            );
            if !message_id.is_empty() {
                response.metadata.insert(
                    "processing_reaction_chat_id".to_string(),
                    Value::String(reaction_chat_id.clone()),
                );
                response.metadata.insert(
                    "processing_reaction_message_id".to_string(),
                    Value::String(message_id.clone()),
                );
                remove_processing_on_handler_done = false;
            }
            let bus_lock = bus.lock().await;
            bus_lock.publish_outbound(response);
        }
    }

    if let Some(task) = typing_task {
        task.abort();
    }

    if remove_processing_on_handler_done && !message_id.is_empty() {
        let cm_lock = channel_manager.lock().await;
        if let Some(ref mgr) = *cm_lock {
            info!(
                channel = %reaction_channel,
                chat_id = %reaction_chat_id,
                message_id = %message_id,
                "[gateway] processing reaction end after handler"
            );
            mgr.notify_processing_end(&reaction_channel, &reaction_chat_id, &message_id)
                .await;
        }
    }
}

/// Spawn the outbound dispatcher.
///
/// Subscribes to the outbound broadcast and forwards messages to the matching
/// channel via `ChannelManager`. Returns the task join handle.
pub(super) async fn spawn_outbound_dispatcher(
    bus: Arc<Mutex<MessageBus>>,
    channel_manager: Arc<Mutex<Option<ChannelManager>>>,
    gateway_running: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let mut outbound_rx = {
        let bus_lock = bus.lock().await;
        bus_lock.subscribe_outbound()
    };

    tokio::spawn(async move {
        info!("[gateway] Outbound dispatcher started");

        while gateway_running.load(Ordering::Relaxed) {
            match outbound_rx.recv().await {
                Ok(outbound_msg) => {
                    if outbound_msg.channel == "tauri" || outbound_msg.channel == "automation" {
                        continue;
                    }

                    // Extract MEDIA:/path references from the agent's response
                    // and move them into the media field for the channel to handle.
                    let (clean_content, media_paths) = extract_media_refs(&outbound_msg.content);
                    let outbound_msg = if media_paths.is_empty() {
                        outbound_msg
                    } else {
                        let mut msg = outbound_msg;
                        msg.content = clean_content;
                        msg.media.extend(media_paths);
                        msg
                    };

                    info!(
                        "[gateway] Routing outbound to {}: {}...",
                        outbound_msg.channel,
                        crate::utils::safe_truncate_chars_to_string(&outbound_msg.content, 60)
                    );

                    let processing_reaction = outbound_msg
                        .metadata
                        .get("processing_reaction_message_id")
                        .and_then(|v| v.as_str())
                        .map(|message_id| {
                            let chat_id = outbound_msg
                                .metadata
                                .get("processing_reaction_chat_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&outbound_msg.chat_id)
                                .to_string();
                            (chat_id, message_id.to_string())
                        });

                    let cm_lock = channel_manager.lock().await;
                    if let Some(ref manager) = *cm_lock {
                        if let Err(err) = manager.send_to_with_delivery(&outbound_msg).await {
                            error!(
                                "[gateway] Failed to deliver to channel {}: {}",
                                outbound_msg.channel, err
                            );
                        }
                        if let Some((chat_id, message_id)) = processing_reaction {
                            info!(
                                channel = %outbound_msg.channel,
                                chat_id = %chat_id,
                                message_id = %message_id,
                                "[gateway] processing reaction end after delivery"
                            );
                            manager
                                .notify_processing_end(&outbound_msg.channel, &chat_id, &message_id)
                                .await;
                        }
                    }
                    drop(cm_lock);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    warn!(
                        "[gateway] Outbound dispatcher lagged, missed {} messages",
                        count
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    info!("[gateway] Outbound broadcast channel closed");
                    break;
                }
            }
        }

        info!("[gateway] Outbound dispatcher stopped");
    })
}
