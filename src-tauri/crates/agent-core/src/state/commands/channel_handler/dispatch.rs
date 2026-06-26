//! Inbound dispatch: the `GatewayInboundHandler` trait impl and the
//! per-session re-injection plumbing it relies on.
//!
//! Split out of `channel_handler.rs` (Apr 2026) so the dispatch flow
//! reads top-to-bottom without scrolling past the slash-command and
//! lifecycle code that lives next door.

use std::sync::Arc;
use tracing::{info, warn};

use crate::bus::{InboundMessage, OutboundMessage};
use crate::definitions::{os_agent, OS_AGENT_ID};
use crate::definitions::prefix_lookup::SDE_SESSION_PREFIX;
use crate::gateway::{parse_command, InboundMessageHandler, InboundProcessorDeps, SessionKey};
use crate::interaction::permission::AgentPermissionManager;
use crate::interaction::question::QuestionManager;
use crate::session::session_id::{next_version_for, os_session_id_base, with_version};
use crate::state::{AgentAppState, AgentSession};
use crate::tools::impls::orchestration::channel::REINJECT_CHANNEL;

use super::idle_reset::{has_active_processes, perform_idle_reset};
use super::slash::handle_command;

/// Resolve the (account_id, model) pair for channel-launched sessions.
/// Priority: explicit `gateway.account_id`/`gateway.model` in the
/// integrations config, then the globally active `current_account_id` as a
/// fallback account hint (model never falls back — `None` here is what
/// callers check to short-circuit with a "not configured" reply).
async fn resolve_gateway_model_and_account(
    state: &AgentAppState,
) -> (Option<String>, Option<String>) {
    let gateway_cfg = state.integrations.snapshot().channels.gateway.clone();

    let fallback_account = state.current_account_id.lock().await.clone();
    let account_id = gateway_cfg.account_id.clone().or(fallback_account);
    let model = gateway_cfg.model.clone();
    (account_id, model)
}

/// Inbound handler: direct routing to the per-chat OS session.
///
/// ```text
///  inbound message
///     │
///     ├── re-injected (REINJECT_CHANNEL) ──► dispatch to override target
///     │
///     ├── slash command (/new /status …) ──► handle on OS session, ack reply
///     │
///     ├── binding hit ─────────────────────► re-inject to bound OS session
///     │
///     └── no binding ──────────────────────► create osagent-<ch>-<chat>,
///                                            write binding, re-inject
/// ```
///
/// No LLM routing. Every chat gets a dedicated OS session (singleton per
/// `(channel, chat_id)`); OS handles general conversation itself and
/// delegates coding work to `builtin:sde` via the subagent tool. The
/// binding store is now a pure `(channel, chat_id) → osagent-…` map with
/// idle-reset versioning (`-v{n}`) retained for transcript hygiene.
pub(super) struct GatewayInboundHandler {
    pub(super) app_handle: tauri::AppHandle,
    pub(super) question_manager: Arc<QuestionManager>,
    pub(super) permission_manager: Arc<AgentPermissionManager>,
}

#[async_trait::async_trait]
impl InboundMessageHandler for GatewayInboundHandler {
    async fn handle_message(&self, msg: InboundMessage) -> Result<Option<OutboundMessage>, String> {
        use tauri::Manager;

        let state = self.app_handle.state::<AgentAppState>();
        let account_id = {
            let current = state.current_account_id.lock().await;
            current.clone()
        };

        let is_reinject = msg.channel == REINJECT_CHANNEL;
        let channels_cfg = state.integrations.snapshot().channels.clone();

        // ── Branch 1: re-inject short circuit ────────────────────────────
        if is_reinject {
            let Some(target_session_id) = msg.session_key_override.clone() else {
                return Err("re-inject message missing session_key_override — upstream \
                     caller must set it before publishing to REINJECT_CHANNEL"
                    .to_string());
            };
            // Re-injected messages (e.g. after media download) target an
            // already-derived OS session id. The original buffering path may
            // have minted a fresh -v{n} id without registering it yet, so the
            // subsequent `init_channel_session` lookup would fail with
            // "channel session '…' not registered". Mirror Branch 3 and ensure
            // OS sessions are registered before dispatch. (SDE sessions manage
            // their own lifecycle and are skipped.)
            if !target_session_id.starts_with(SDE_SESSION_PREFIX) {
                ensure_os_session_registered(&state, &target_session_id).await;
            }
            return dispatch_to_session(
                &state,
                account_id.as_deref(),
                &target_session_id,
                &msg,
                true,
                &channels_cfg,
                &self.question_manager,
                &self.permission_manager,
            )
            .await;
        }

        // ── Branch 2: explicit slash command ─────────────────────────────
        // Slash handling needs the bound OS session (if any) to run /new,
        // /status, /compact against — so we resolve the binding first and
        // pass it in.
        let session_key = SessionKey::from_inbound(&msg, &channels_cfg);
        if let Some(cmd) = parse_command(&msg.content) {
            return handle_command(&state, &msg, &session_key, cmd).await;
        }

        // ── Idle reset check (lazy trigger) ──────────────────────────────
        // Archives the old OS session and clears the binding so the next
        // message below takes the "create fresh session" path.
        let reset_policy = channels_cfg.gateway.reset_policy.clone();
        if reset_policy.is_active() {
            if let Some(existing) = state.gateway_bindings.get(&session_key).await {
                let now = chrono::Utc::now();
                let expired = match chrono::DateTime::parse_from_rfc3339(&existing.last_activity_at)
                {
                    Ok(ts) => {
                        (now - ts.with_timezone(&chrono::Utc))
                            > chrono::Duration::minutes(reset_policy.idle_minutes as i64)
                    }
                    Err(err) => {
                        // Binding row's last_activity_at is corrupt (not RFC3339).
                        // Conservatively skip idle-reset rather than treat as
                        // "definitely expired" so an in-flight conversation isn't
                        // reset out from under the user; surface via warn so the
                        // bad row is observable.
                        warn!(
                            "[gateway] binding for session {} has unparseable last_activity_at \
                             {:?}: {} — skipping idle-reset check",
                            existing.target_session_id, existing.last_activity_at, err
                        );
                        false
                    }
                };
                if expired && !has_active_processes(&state, &existing.target_session_id).await {
                    perform_idle_reset(
                        &state,
                        &session_key,
                        &existing.target_session_id,
                        &msg,
                        &reset_policy,
                    )
                    .await;
                } else if expired {
                    state.gateway_bindings.touch(&session_key).await;
                    info!(
                        "[gateway] Idle reset deferred: session {} has active processes",
                        existing.target_session_id
                    );
                }
            }
        }

        // ── Branch 3: resolve (or create) the chat's OS session ──────────
        let target_sid = if let Some(binding) = state.gateway_bindings.get(&session_key).await {
            state.gateway_bindings.touch(&session_key).await;
            binding.target_session_id
        } else {
            // First message for this chat (or post-reset): mint an
            // osagent-<channel>-<chat_id>[-v{n}] session and write the
            // binding. The actual runtime init happens inside
            // `dispatch_to_session` via `init_channel_session`.
            let sid = derive_os_session_id(&msg.channel, &msg.chat_id);
            ensure_os_session_registered(&state, &sid).await;
            state
                .gateway_bindings
                .set(session_key.clone(), sid.clone())
                .await;
            info!(
                "[gateway] New chat routed to OS session: {} → {}",
                session_key.as_str(),
                sid
            );
            sid
        };

        // Re-inject so the target session consumes the message via the
        // standard pipeline. Keeps the real sender_id so the channel
        // context header built downstream sees the user, not
        // "builtin:os" bookkeeping.
        let sender_placeholder = if msg.sender_id.is_empty() {
            OS_AGENT_ID
        } else {
            msg.sender_id.as_str()
        };
        let mut inbound = InboundMessage::new(
            REINJECT_CHANNEL,
            sender_placeholder,
            &target_sid,
            &msg.content,
        );
        inbound.session_key_override = Some(target_sid.clone());
        inbound.metadata.insert(
            "source_channel".to_string(),
            serde_json::Value::String(msg.channel.clone()),
        );
        inbound.metadata.insert(
            "source_chat_id".to_string(),
            serde_json::Value::String(msg.chat_id.clone()),
        );
        if let Some(message_id) = msg.metadata.get("message_id").and_then(|v| v.as_str()) {
            inbound.metadata.insert(
                "source_message_id".to_string(),
                serde_json::Value::String(message_id.to_string()),
            );
        }
        inbound.media = msg.media.clone();

        let sender = {
            let bus = state.bus.lock().await;
            bus.inbound_sender()
        };
        sender
            .send(inbound)
            .await
            .map_err(|err| format!("Failed to re-inject to OS session: {}", err))?;

        Ok(None)
    }
}

/// Mint (or return the existing) per-chat OS session id, versioned to
/// avoid colliding with archived successors from idle-reset.
///
/// `next_version_for` reads from `agent_sessions` to find the next free
/// version slot. A DB error here is rare (transient lock at most), but
/// silently falling back to `v=1` would collide with archived predecessors
/// from a prior idle-reset cycle — which is precisely what versioning is
/// supposed to prevent. Warn loudly so the operator can see the fallback
/// is masking a real DB issue, then keep the channel path alive with the
/// best guess we have.
fn derive_os_session_id(channel: &str, chat_id: &str) -> String {
    let base = os_session_id_base(channel, chat_id);
    let version = next_version_for(&base).unwrap_or_else(|err| {
        warn!(
            channel = %channel,
            chat_id = %chat_id,
            base = %base,
            error = %err,
            "[dispatch] next_version_for failed; falling back to v=1 — may collide with archived sessions",
        );
        1
    });
    with_version(&base, version)
}

/// Ensure the OS session is registered against `builtin:os` before
/// `init_channel_session` tries to look it up — without it the
/// channel init helper errors with `channel session '…' not registered`.
async fn ensure_os_session_registered(state: &AgentAppState, sid: &str) {
    let needs_register = match state.get_session(sid).await {
        None => true,
        Some(existing) => existing.definition.id != os_agent().id,
    };
    if needs_register {
        let definition = os_agent();
        let session = AgentSession::new(sid.to_string(), definition);
        state.invalidate_session(sid).await;
        state.register_session(session).await;
    }
}

/// Dispatch a message (usually re-injected) to a target session and
/// run one turn through `process_message`.
///
/// All channel-facing sessions are OS or SDE sessions per
/// `(channel, chat_id)`. We use `channels.gateway.model` as the default
/// model/account override because existing installs store their
/// channel-launch model there.
#[allow(clippy::too_many_arguments)]
async fn dispatch_to_session(
    state: &AgentAppState,
    account_id: Option<&str>,
    target_session_id: &str,
    msg: &InboundMessage,
    is_reinject: bool,
    channels_cfg: &crate::channels::config::ChannelsConfig,
    _question_manager: &Arc<QuestionManager>,
    _permission_manager: &Arc<AgentPermissionManager>,
) -> Result<Option<OutboundMessage>, String> {
    let (gw_account, gw_model) = resolve_gateway_model_and_account(state).await;
    let effective_account = account_id.or(gw_account.as_deref());

    // SDE sessions have a session-specific `workspace_path` that MUST NOT
    // be overwritten by the generic `channels.workspace_path()`. Route
    // SDE sessions through `init_workspace_session` using
    // the path recorded in DB. OS sessions (which live in the channel
    // workspace by design) keep the regular channel-init path.
    let runtime = if target_session_id.starts_with(SDE_SESSION_PREFIX) {
        let sid_owned = target_session_id.to_string();
        let persisted_workspace = tokio::task::spawn_blocking(move || {
            crate::persistence::session_snapshots::get_session_workspace_path(&sid_owned)
                .ok()
                .flatten()
        })
        .await
        .map_err(|err| format!("Failed to query SDE workspace_path: {err}"))?;

        match persisted_workspace {
            Some(path_str) if !path_str.is_empty() => {
                let workspace_path = std::path::PathBuf::from(&path_str);
                let model = gw_model
                    .as_deref()
                    .ok_or_else(|| "gateway.model not configured".to_string())?;
                crate::session::init_workspace_session(
                    state,
                    target_session_id,
                    model,
                    effective_account,
                    &workspace_path,
                )
                .await?
            }
            _ => {
                // First-ever inject for an SDE session: fall back to the
                // channel workspace. Once the SDE runtime persists a
                // workspace_path, subsequent injects hit the fast path above.
                super::lifecycle::init_channel_session(
                    state,
                    target_session_id,
                    effective_account,
                    gw_model.as_deref(),
                )
                .await?
            }
        }
    } else {
        super::lifecycle::init_channel_session(
            state,
            target_session_id,
            effective_account,
            gw_model.as_deref(),
        )
        .await?
    };

    let (origin_channel, origin_chat_id) = if is_reinject {
        let src_channel = msg
            .metadata
            .get("source_channel")
            .and_then(|v| v.as_str())
            .unwrap_or(&msg.channel)
            .to_string();
        let src_chat = msg
            .metadata
            .get("source_chat_id")
            .and_then(|v| v.as_str())
            .unwrap_or(&msg.chat_id)
            .to_string();
        (src_channel, src_chat)
    } else {
        (msg.channel.clone(), msg.chat_id.clone())
    };

    runtime
        .tool_registry
        .set_all_contexts(&origin_channel, &origin_chat_id, &msg.sender_id)
        .await;

    let enriched = if is_reinject {
        // Rewrite channel/chat_id back to the ORIGINAL values stored in
        // metadata. Without this, `message_pipeline::process_message`
        // builds its OutboundMessage from `msg.channel` (="gateway-reinject")
        // / `msg.chat_id` (="<target_session_id>"), which the outbound
        // dispatcher cannot deliver ("Channel not found: gateway-reinject").
        let mut m = msg.clone();
        m.channel = origin_channel.clone();
        m.chat_id = origin_chat_id.clone();
        m.session_key_override = Some(target_session_id.to_string());
        m
    } else {
        let pii_redact = channels_cfg.pii_redact_sender_id;
        let display_sender =
            crate::channels::delivery::redact_sender_id(&msg.sender_id, pii_redact);
        let context_header = crate::channels::delivery::build_channel_context_header(
            &msg.channel,
            &msg.chat_id,
            &display_sender,
        );
        let mut m = msg.clone();
        m.content = format!("{}\n{}", context_header, msg.content);
        m.session_key_override = Some(target_session_id.to_string());
        m
    };

    let session_arc = state
        .get_session(target_session_id)
        .await
        .ok_or_else(|| format!("Session {} not found after init", target_session_id))?;

    let outbound = crate::session::gateway_pipeline::process_gateway_message(
        enriched,
        session_arc,
        None,
        state.app_handle.clone(),
    )
    .await?;

    Ok(prepend_reset_notice(state, &origin_channel, &origin_chat_id, outbound).await)
}

async fn prepend_reset_notice(
    state: &AgentAppState,
    channel: &str,
    chat_id: &str,
    outbound: Option<OutboundMessage>,
) -> Option<OutboundMessage> {
    let key = format!("{}:{}", channel, chat_id);
    let notice = {
        let mut pending = state.pending_reset_notifies.lock().await;
        pending.remove(&key)
    };
    let result = match (notice, outbound) {
        (Some(text), Some(mut reply)) => {
            reply.content = format!("{}\n\n{}", text, reply.content);
            Some(reply)
        }
        (Some(text), None) => {
            let standalone = OutboundMessage::new(channel, chat_id, &text);
            let bus = state.bus.lock().await;
            bus.publish_outbound(standalone.clone());
            // E2E observability: the bus has no buffered subscribers in
            // tests, so the published message would otherwise be dropped
            // and `outbound-snapshot` could not see it. Capture an
            // explicit copy in the debug buffer.
            #[cfg(debug_assertions)]
            push_debug_outbound(state, &standalone).await;
            None
        }
        (None, reply) => reply,
    };

    #[cfg(debug_assertions)]
    if let Some(ref msg) = result {
        push_debug_outbound(state, msg).await;
    }
    result
}

/// Mirror an outbound into the `debug_outbound_capture` ring buffer so
/// E2E `outbound-snapshot` polls can verify replies that the dev bus
/// would otherwise drop (no buffered subscribers in test harness).
#[cfg(debug_assertions)]
pub(super) async fn push_debug_outbound(state: &AgentAppState, msg: &OutboundMessage) {
    const MAX_CAPTURE: usize = 128;
    let mut buf = state.debug_outbound_capture.lock().await;
    if buf.len() >= MAX_CAPTURE {
        buf.remove(0);
    }
    buf.push((
        msg.channel.clone(),
        msg.chat_id.clone(),
        msg.content.clone(),
    ));
}

/// Build the `InboundProcessorDeps` carrying a fresh
/// `GatewayInboundHandler` instance. Lives next to the handler so the
/// constructor stays private to this submodule.
pub(super) fn build_inbound_deps(state: &AgentAppState) -> Result<InboundProcessorDeps, String> {
    let app_handle = state
        .app_handle
        .clone()
        .ok_or_else(|| "AppHandle not available for gateway".to_string())?;

    let handler = GatewayInboundHandler {
        app_handle,
        question_manager: Arc::new(QuestionManager::new()),
        permission_manager: Arc::new(AgentPermissionManager::for_agent(OS_AGENT_ID)),
    };
    Ok(InboundProcessorDeps {
        handler: Arc::new(handler),
    })
}
