//! Slash command handling (`/help`, `/new`, `/status`, `/model`, `/compact`) for
//! channel-bound chats.

use crate::bus::{InboundMessage, OutboundMessage};
use crate::gateway::{GatewayCommand, SessionKey};
use crate::state::AgentAppState;
use tracing::info;

#[cfg(debug_assertions)]
use super::dispatch::push_debug_outbound;

/// Handle an explicit gateway command. All branches write an acknowledgment
/// message to the outbound bus (best-effort — if the bus publish fails the
/// user still observes the binding state change via `/status`).
pub(super) async fn handle_command(
    state: &AgentAppState,
    msg: &InboundMessage,
    session_key: &SessionKey,
    cmd: GatewayCommand,
) -> Result<Option<OutboundMessage>, String> {
    let reply_text = match cmd {
        GatewayCommand::NewSession => {
            state.gateway_bindings.clear(session_key).await;
            info!("[gateway] Cleared binding for {}", session_key.as_str());
            "Conversation reset. The next message starts a fresh session.".to_string()
        }
        GatewayCommand::Model(requested) => {
            handle_model_command(state, msg, session_key, requested.as_deref()).await
        }
        GatewayCommand::Status => {
            let binding = state.gateway_bindings.get(session_key).await;
            let running: Vec<String> = state.list_sessions().await;
            let binding_line = match binding {
                Some(b) => format!("• This chat → `{}`", b.target_session_id),
                None => "• No active session yet (the next message starts one).".to_string(),
            };
            let running_list = if running.is_empty() {
                "(none)".to_string()
            } else {
                running
                    .iter()
                    .map(|s| format!("  - `{}`", s))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!(
                "**Status**\n{}\n• Active sessions:\n{}",
                binding_line, running_list
            )
        }
        GatewayCommand::Compact => {
            use crate::session::compaction::manual::{
                run_manual_compact, ManualCompactResult, MIN_HISTORY_FOR_MANUAL_COMPACT,
            };

            // Resolve the bound session for this chat. If the chat has no
            // binding there's no session to compact yet.
            let target_sid = match state.gateway_bindings.get(session_key).await {
                Some(b) => b.target_session_id,
                None => {
                    let text = "No session is bound to this chat yet. Send a message first so one is created.".to_string();
                    let reply = OutboundMessage::new(&msg.channel, &msg.chat_id, &text);
                    {
                        let bus = state.bus.lock().await;
                        bus.publish_outbound(reply.clone());
                    }
                    #[cfg(debug_assertions)]
                    push_debug_outbound(state, &reply).await;
                    return Ok(None);
                }
            };

            let reset_policy = state
                .integrations
                .snapshot()
                .channels
                .gateway
                .reset_policy
                .clone();

            match run_manual_compact(state, &target_sid, &reset_policy).await {
                ManualCompactResult::Forked(s) => {
                    let suffix = if s.truncated {
                        "\n_(Note: compactor fell back to truncation — older context dropped without summary.)_"
                    } else {
                        ""
                    };
                    format!(
                        "🗜️ Context compacted.\nCompressed: {} → {} messages (~{} → ~{} tokens).\nContinuing in new session `{}` (previous: `{}`).{}",
                        s.messages_before,
                        s.messages_after,
                        s.tokens_before,
                        s.tokens_after,
                        s.new_session_id,
                        s.old_session_id,
                        suffix,
                    )
                }
                ManualCompactResult::AlreadyCompact { message_count, tokens } => format!(
                    "Nothing to compact — current transcript ({} messages, ~{} tokens) still fits the model budget. Send more messages first.",
                    message_count, tokens
                ),
                ManualCompactResult::TooShort { message_count } => format!(
                    "Not enough conversation to compact (have {}, need at least {}).",
                    message_count, MIN_HISTORY_FOR_MANUAL_COMPACT
                ),
                ManualCompactResult::NotChannelAttached => {
                    "This session is not channel-attached, so /compact has no fork target. App-side sessions compact automatically in place.".to_string()
                }
                ManualCompactResult::NoRuntime => {
                    "Session has no active runtime yet. Send a message first, then try /compact.".to_string()
                }
                ManualCompactResult::Failed(reason) => format!("Compact failed: {}", reason),
            }
        }
        GatewayCommand::Help => build_help_text(),
    };

    let reply = OutboundMessage::new(&msg.channel, &msg.chat_id, &reply_text);
    {
        let bus = state.bus.lock().await;
        bus.publish_outbound(reply.clone());
    }
    // E2E observability: slash replies previously lived only on the
    // outbound bus, which has no buffered subscribers in the dev
    // harness — so `outbound-snapshot` could not verify the reply
    // text. Mirror the `prepend_reset_notice` pattern and keep a
    // copy in the debug buffer.
    #[cfg(debug_assertions)]
    push_debug_outbound(state, &reply).await;
    Ok(None)
}


async fn handle_model_command(
    state: &AgentAppState,
    _msg: &InboundMessage,
    session_key: &SessionKey,
    requested: Option<&str>,
) -> String {
    let Some(binding) = state.gateway_bindings.get(session_key).await else {
        return "No session is bound to this chat yet. Send a message first, then use `/model <model>`."
            .to_string();
    };
    let Some(requested) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return format!(
            "Usage: `/model <model>`. Common aliases: gpt-5.5, gpt5.5, fable, sonnet, opus. Current session: `{}`",
            binding.target_session_id
        );
    };
    let account_id = state
        .current_account_id
        .lock()
        .await
        .clone()
        .or_else(|| state.integrations.snapshot().channels.gateway.account_id.clone());
    let Some((model, account_id)) = resolve_model_target(requested, account_id.as_deref()) else {
        return format!("Model `{}` was not found in the configured model list.", requested);
    };
    let sid = binding.target_session_id.clone();
    let model_for_db = model.clone();
    let account_for_db = account_id.clone();
    match tokio::task::spawn_blocking(move || {
        crate::session::persistence::update_model_and_account(
            &sid,
            model_for_db.as_str(),
            account_for_db.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(true)) => {
            state.invalidate_session(&binding.target_session_id).await;
            let note = format!("Model switched to {}", model);
            let sid_for_note = binding.target_session_id.clone();
            let note_for_db = note.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::session::persistence::save_compact_summary_msg(&sid_for_note, &note_for_db)
            })
            .await;
            note
        }
        Ok(Ok(false)) => format!("Model switch failed: session {} does not exist", binding.target_session_id),
        Ok(Err(err)) => format!("Model switch failed: {}", err),
        Err(err) => format!("Model switch failed: {}", err),
    }
}

fn resolve_model_target(
    requested: &str,
    account_id: Option<&str>,
) -> Option<(String, Option<String>)> {
    let needle = normalize_model_key(requested);
    let mut candidates: Vec<String> = Vec::new();
    if let Some(account_id) = account_id {
        if let Some(key) = key_vault::key_store::KEY_SERVICE.get_key_by_id(account_id) {
            candidates.extend(key.enabled_models.iter().cloned());
            candidates.extend(key.available_models.iter().cloned());
            candidates.extend(key.model_aliases.iter().map(|alias| alias.alias.clone()));
        }
    }
    candidates.extend(
        [
            "openai/gpt-5.5:openai",
            "gpt-5.5",
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-fable-5",
        ]
        .into_iter()
        .map(str::to_string),
    );
    candidates.sort();
    candidates.dedup();
    let aliases: &[(&str, &[&str])] = &[
        ("openai/gpt-5.5:openai", &["gpt-5.5", "gpt5.5", "gpt55"]),
        ("claude-fable-5", &["fable"]),
        ("claude-sonnet-4-6", &["sonnet"]),
        ("claude-opus-4-6", &["opus"]),
    ];
    for (target, names) in aliases {
        if names.iter().any(|name| normalize_model_key(name) == needle) {
            return Some((
                best_candidate_for_alias(&candidates, target).unwrap_or_else(|| (*target).to_string()),
                account_id.map(str::to_string),
            ));
        }
    }
    candidates
        .iter()
        .find(|m| normalize_model_key(m) == needle)
        .or_else(|| candidates.iter().find(|m| normalize_model_key(m).contains(&needle)))
        .cloned()
        .map(|model| (model, account_id.map(str::to_string)))
}

fn best_candidate_for_alias(candidates: &[String], canonical_target: &str) -> Option<String> {
    let target_norm = normalize_model_key(canonical_target);
    candidates
        .iter()
        .find(|m| normalize_model_key(m) == target_norm)
        .or_else(|| {
            candidates.iter().find(|m| {
                let norm = normalize_model_key(m);
                norm.contains(&target_norm) || target_norm.contains(&norm)
            })
        })
        .cloned()
}

fn normalize_model_key(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Static cheat-sheet for the `/help` slash command.
///
/// Hermes parallel: `gateway/run.py:_handle_help_command` →
/// `hermes_cli.commands.gateway_help_lines()`. Hermes builds the list
/// dynamically from a `COMMAND_REGISTRY`; we keep the cheat-sheet
/// hand-maintained in MVP because the surface is small (six commands)
/// and the source of truth is the `GatewayCommand` enum next door —
/// the unit test below pins the alignment.
///
/// Keep the body short: Telegram's per-message budget is ~4096 chars
/// and we don't want the LLM to be tempted to repeat this list back to
/// the user.
fn build_help_text() -> String {
    [
        "**Commands**",
        "`/help` — show this list (alias: `/commands`).",
        "`/new` — reset this chat; the next message starts a fresh session.",
        "`/status` — show the current session and anything else running.",
        "`/model <model>` — switch the bound channel session model.",
        "`/compact` — compress the current session and continue in a versioned successor.",
    ]
    .join("\n")
}

#[cfg(test)]
mod help_text_tests {
    use super::{best_candidate_for_alias, build_help_text, normalize_model_key};

    #[test]
    fn lists_every_supported_slash_command() {
        let text = build_help_text();
        for cmd in ["/help", "/new", "/status", "/model", "/compact"] {
            assert!(text.contains(cmd), "help cheat-sheet missing {cmd}: {text}");
        }
    }

    /// `/switch` and `/agent` were removed after dogfooding surfaced
    /// that end-users never use them (they'd have to copy/paste an
    /// opaque `sdeagent-...` session id). The `/help` cheat-sheet must
    /// not advertise them to avoid discovery + confusion.
    #[test]
    fn does_not_advertise_removed_commands() {
        let text = build_help_text();
        assert!(
            !text.contains("/switch"),
            "help still mentions /switch: {text}"
        );
        assert!(
            !text.contains("/agent"),
            "help still mentions /agent: {text}"
        );
    }

    #[test]
    fn resolves_model_alias_to_best_configured_candidate() {
        let candidates = vec![
            "openai/gpt-5.5:openai".to_string(),
            "anthropic/claude-fable-5:anthropic".to_string(),
        ];
        assert_eq!(
            best_candidate_for_alias(&candidates, "openai/gpt-5.5:openai"),
            Some("openai/gpt-5.5:openai".to_string())
        );
        assert_eq!(
            best_candidate_for_alias(&candidates, "claude-fable-5"),
            Some("anthropic/claude-fable-5:anthropic".to_string())
        );
    }

    #[test]
    fn normalize_model_key_ignores_provider_punctuation() {
        assert_eq!(normalize_model_key("openai/gpt-5.5:openai"), "openaigpt55openai");
        assert_eq!(normalize_model_key("GPT-5.5"), "gpt55");
    }

    #[test]
    fn fits_telegram_message_budget() {
        // Hermes caps at 4096 (Telegram limit). 1KB is plenty of head-room
        // for a static list and forces us to revisit if we balloon.
        assert!(build_help_text().len() < 1024);
    }
}
