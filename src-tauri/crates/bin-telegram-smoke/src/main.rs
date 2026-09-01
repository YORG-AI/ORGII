//! Telegram channel smoke-test binary.
//!
//! Purpose: end-to-end verification that `TelegramChannel` can receive real
//! inbound messages from `api.telegram.org` via long-polling AND send real
//! outbound messages back — **without** booting the full Gateway/SDE/LLM
//! stack. This isolates the "HTTP in/out" layer so failures here point at
//! channel infrastructure, not at Gateway routing or LLM providers.
//!
//! Usage:
//! ```bash
//! ORGII_TELEGRAM_TOKEN=123456:AAE... \
//!   cargo run --bin telegram-smoke
//! ```
//!
//! Optional env:
//! - `ORGII_TELEGRAM_ALLOW_FROM` — comma-separated Telegram user IDs that are
//!   allowed to talk to the bot. Empty/unset = no allow-list.
//!
//! What the binary does once running:
//! 1. Registers one `TelegramChannel` named `telegram:smoke` with the given
//!    token under a freshly-constructed `ChannelManager`.
//! 2. Starts long-polling (the channel's own `start()` body owns the loop).
//! 3. Reads from the inbound mpsc: for every message, logs it and pushes an
//!    echo `OutboundMessage` back through the manager's
//!    `send_to_with_delivery` (the same path the gateway outbound dispatcher
//!    uses).
//! 4. Runs until Ctrl+C, then stops the channel cleanly.
//!
//! The token is **never** logged in full — only the bot-id prefix before
//! the `:` separator.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::signal;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use agent_core::bus::{InboundMessage, OutboundMessage};
use agent_core::channels::config::TelegramAccountConfig;
use agent_core::channels::telegram::TelegramChannel;
use agent_core::channels::ChannelManager;

const CHANNEL_ACCOUNT_ID: &str = "smoke";

fn token_preview(token: &str) -> String {
    match token.split_once(':') {
        Some((bot_id, _secret)) => format!("{}:***", bot_id),
        None => "***".to_string(),
    }
}

fn load_allow_from() -> Vec<String> {
    std::env::var("ORGII_TELEGRAM_ALLOW_FROM")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(|segment| segment.trim().to_string())
                .filter(|segment| !segment.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(true)
        .init();

    let token = std::env::var("ORGII_TELEGRAM_TOKEN").map_err(|_| {
        "ORGII_TELEGRAM_TOKEN is required (format: 123456:AA...). Get one from @BotFather."
    })?;
    if token.trim().is_empty() {
        return Err("ORGII_TELEGRAM_TOKEN is empty".into());
    }

    let allow_from = load_allow_from();

    info!(
        token = %token_preview(&token),
        allow_from_count = allow_from.len(),
        account_id = CHANNEL_ACCOUNT_ID,
        "Starting telegram-smoke"
    );

    let account = TelegramAccountConfig {
        enabled: true,
        token,
        allow_from,
        proxy: None,
    };
    let channel = TelegramChannel::new(CHANNEL_ACCOUNT_ID.to_string(), account);

    let (inbound_tx, mut inbound_rx) = mpsc::channel::<InboundMessage>(64);

    let manager = Arc::new(Mutex::new(ChannelManager::new(inbound_tx.clone())));

    {
        let mut manager_guard = manager.lock().await;
        manager_guard.register(Box::new(channel));
        let results = manager_guard.start_all().await;
        for (name, outcome) in &results {
            match outcome {
                Ok(()) => info!(channel = %name, "Channel started"),
                Err(err) => {
                    error!(channel = %name, error = %err, "Failed to start channel");
                    return Err(format!("failed to start channel {}: {}", name, err).into());
                }
            }
        }
    }

    info!("Telegram bot is live. Send /start then any text to the bot.");
    info!("Press Ctrl+C to stop.");

    let processor_manager = Arc::clone(&manager);
    let processor = tokio::spawn(async move {
        while let Some(msg) = inbound_rx.recv().await {
            let preview: String = msg.content.chars().take(120).collect();
            info!(
                channel = %msg.channel,
                chat_id = %msg.chat_id,
                sender_id = %msg.sender_id,
                content = %preview,
                "Inbound message"
            );

            let reply = build_echo_reply(&msg);
            let out = OutboundMessage {
                channel: msg.channel.clone(),
                chat_id: msg.chat_id.clone(),
                content: reply,
                reply_to: None,
                media: Vec::new(),
                metadata: HashMap::new(),
            };

            let manager_guard = processor_manager.lock().await;
            match manager_guard.send_to_with_delivery(&out).await {
                Ok(()) => info!(
                    chat_id = %out.chat_id,
                    "Echo reply delivered"
                ),
                Err(err) => warn!(
                    chat_id = %out.chat_id,
                    error = %err,
                    "Echo reply failed"
                ),
            }
        }
    });

    signal::ctrl_c().await?;
    info!("Ctrl+C received, stopping channel…");

    {
        let mut manager_guard = manager.lock().await;
        manager_guard.stop_all().await;
    }

    drop(inbound_tx);
    let _ = processor.await;

    info!("telegram-smoke exited cleanly");
    Ok(())
}

fn build_echo_reply(msg: &InboundMessage) -> String {
    if msg.content.starts_with("/start") {
        return "ORGII Telegram smoke-test is alive. Send any message and I'll echo it back."
            .to_string();
    }
    format!("echo ({}): {}", msg.channel, msg.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- token redaction ----------

    #[test]
    fn token_preview_keeps_the_bot_id_and_drops_the_secret() {
        // The preview is logged at startup, so the secret half must never
        // survive into a log file or a pasted terminal transcript.
        let preview = token_preview("123456789:AAHrandom-secret-material");

        assert_eq!(preview, "123456789:***");
        assert!(!preview.contains("AAHrandom-secret-material"));
    }

    #[test]
    fn token_preview_redacts_everything_when_the_shape_is_unfamiliar() {
        // A token that is not `<bot_id>:<secret>` might be entirely secret,
        // so nothing is echoed rather than guessing which half is safe.
        assert_eq!(token_preview("AAHrandom-secret-material"), "***");
        assert_eq!(token_preview(""), "***");
    }

    #[test]
    fn token_preview_splits_on_the_first_colon_only() {
        // `split_once` keeps later colons inside the redacted half.
        assert_eq!(token_preview("123:secret:with:colons"), "123:***");
    }

    // ---------- allow-list parsing ----------

    #[test]
    fn allow_from_is_empty_when_unset_and_trims_and_drops_blank_entries() {
        // One test because the env var is process-wide.
        std::env::remove_var("ORGII_TELEGRAM_ALLOW_FROM");
        assert!(load_allow_from().is_empty(), "unset means no restriction");

        std::env::set_var("ORGII_TELEGRAM_ALLOW_FROM", " 111 , 222,,333 ,");
        assert_eq!(load_allow_from(), vec!["111", "222", "333"]);

        // A value of only separators must not produce an allow-list of one
        // empty string, which would match nobody and look like a lockout.
        std::env::set_var("ORGII_TELEGRAM_ALLOW_FROM", " , , ");
        assert!(load_allow_from().is_empty());

        std::env::remove_var("ORGII_TELEGRAM_ALLOW_FROM");
    }

    // ---------- echo replies ----------

    #[test]
    fn start_command_gets_the_liveness_banner() {
        let msg = InboundMessage::new("telegram", "42", "chat-1", "/start");

        let reply = build_echo_reply(&msg);
        assert!(reply.contains("smoke-test is alive"));
        assert!(!reply.starts_with("echo ("));
    }

    #[test]
    fn start_command_matches_by_prefix_so_arguments_are_accepted() {
        // Telegram appends a payload to deep links (`/start ref=abc`).
        let msg = InboundMessage::new("telegram", "42", "chat-1", "/start ref=abc");

        assert!(build_echo_reply(&msg).contains("smoke-test is alive"));
    }

    #[test]
    fn any_other_message_is_echoed_with_its_channel() {
        let msg = InboundMessage::new("telegram", "42", "chat-1", "hello there");

        assert_eq!(build_echo_reply(&msg), "echo (telegram): hello there");
    }

    #[test]
    fn a_message_merely_mentioning_start_is_still_echoed() {
        // The check is a prefix test, not a substring test.
        let msg = InboundMessage::new("telegram", "42", "chat-1", "please /start it");

        assert_eq!(build_echo_reply(&msg), "echo (telegram): please /start it");
    }
}
